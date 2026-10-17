import SubscriptionService from './subscriptionService.js';
import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import CustomerPortalPasswordService from './customerPortalPasswordService.js';
import DeviceSwapService from './deviceSwapService.js';
import DeviceService from './deviceService.js';
import DeviceProfile from '../models/DeviceProfile.js';
import Setting from '../models/Setting.js';
import AuditLog from '../models/AuditLog.js';
import { currentActor } from '../config/tenantContext.js';
import { TranslatableError } from '../i18n/index.js';

const CUSTOMER_ID_PATTERN = /^[A-Z]{2,4}-[A-Z0-9]{7}-[A-Z0-9]{6}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_GENERATION_SETTINGS = Object.freeze({
  prefixMode: 'default',
  companyPrefix: 'CSG',
  suffixMode: 'random'
});

/** Um `_lastInform` do GenieACS em milissegundos; `NaN` quando não há. */
function informMs(value) {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function randomString(alphabet, length) {
  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(length - result.length);
    for (const byte of bytes) {
      const limit = 256 - (256 % alphabet.length);
      if (byte < limit) result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}

function normalizeIdentityValue(value) {
  return String(value ?? '').trim();
}

/**
 * The calendar day of a Date, read off its local fields.
 *
 * MySQL and Postgres hand a DATE column back as a Date at local midnight,
 * while SQLite returns the string that was stored — so an installation date
 * read from the database is one or the other depending on the engine. Read as
 * an ISO string a local-midnight Date west of UTC is the day before, and
 * `String(date)` is not a date at all, so on those two engines the suffix would
 * simply never be minted.
 */
function calendarDay(date) {
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}


/** Colisão de chave única nos três bancos (SQLite, MySQL, Postgres). */
function isUniqueViolation(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || error?.code === 'ER_DUP_ENTRY'
    || error?.code === '23505'
    || /unique/i.test(String(error?.message || ''));
}

class CustomerService {
  static isEnabledValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  static async isAutoGenerationEnabled() {
    return this.isEnabledValue(await Setting.getByKey('autoGenerateCustomerId'));
  }

  static identityHash(softwareId, pppoeUsername) {
    return crypto
      .createHash('sha256')
      .update(`${normalizeIdentityValue(softwareId)}\0${normalizeIdentityValue(pppoeUsername)}`)
      .digest('hex');
  }

  static normalizeInstallationDate(value) {
    const normalized = value instanceof Date ? calendarDay(value) : String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
    const parsed = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
      return null;
    }
    return normalized;
  }

  static installationDateSuffix(value) {
    const date = this.normalizeInstallationDate(value);
    return date ? `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}` : null;
  }

  static normalizeGenerationSettings(settings = {}) {
    const prefixMode = settings.prefixMode === 'company' ? 'company' : 'default';
    const companyPrefix = String(settings.companyPrefix || 'CSG').trim().toUpperCase();
    const suffixMode = settings.suffixMode === 'installation_date' ? 'installation_date' : 'random';
    return {
      prefixMode,
      companyPrefix: /^[A-Z]{2,4}$/.test(companyPrefix) ? companyPrefix : 'CSG',
      suffixMode
    };
  }

  static async getGenerationSettings() {
    const [prefixMode, companyPrefix, suffixMode] = await Promise.all([
      Setting.getByKey('customerIdPrefixMode'),
      Setting.getByKey('customerIdCompanyPrefix'),
      Setting.getByKey('customerIdSuffixMode')
    ]);
    return this.normalizeGenerationSettings({ prefixMode, companyPrefix, suffixMode });
  }

  static generateCustomerId(settings = DEFAULT_GENERATION_SETTINGS, installationDate = null) {
    const config = this.normalizeGenerationSettings(settings);
    const prefix = config.prefixMode === 'company' ? config.companyPrefix : 'CSG';
    const suffix = config.suffixMode === 'installation_date'
      ? this.installationDateSuffix(installationDate)
      : randomString(ID_ALPHABET, 6);
    if (!suffix) return null;
    return `${prefix}-${randomString(ID_ALPHABET, 7)}-${suffix}`;
  }

  static normalizeCustomerId(value) {
    const customerId = String(value ?? '').trim().toUpperCase();
    return CUSTOMER_ID_PATTERN.test(customerId) ? customerId : null;
  }

  /**
   * The PPPoE login is what identifies a subscriber. The software version is
   * not: a firmware upgrade must never look like a change of customer.
   */
  static isSameSubscriber(account, pppoeUsername) {
    const stored = String(account?.pppoe_username ?? '').trim().toLowerCase();
    const incoming = String(pppoeUsername ?? '').trim().toLowerCase();
    return Boolean(stored) && stored === incoming;
  }

  /**
   * Closes the account of the previous subscriber of an ONT and drops anything
   * bound to that device, so the incoming subscriber starts from a clean slate
   * instead of inheriting a Customer ID, a portal password, saved WiFi
   * credentials and an SGP contract that belong to someone else.
   */
  static async retireAccount(account, incomingPppoe) {
    const previousDeviceId = account.device_id;
    // Retiring is destructive: the subscriber gets a new Customer ID and a new
    // portal password. Log it so a misreported PPPoE login is visible rather
    // than silently re-issuing credentials for a live customer.
    console.warn(
      `Device ${previousDeviceId} now reports PPPoE "${incomingPppoe}" instead of `
      + `"${account.pppoe_username}"; retiring customer account ${account.customer_id}.`
    );

    // A linha da trilha vem ANTES da escrita, como na exclusão de provedor: uma
    // aposentadoria sem registro é a que ninguém consegue explicar depois.
    //
    // E ela faltava. Isto apaga o Customer ID de um assinante, a senha do
    // portal dele e o vínculo com o ERP, e por muito tempo produziu só um
    // `console.warn` — que não é trilha, é log do processo, e some. O ISP que
    // perguntasse "por que o meu assinante perdeu o acesso" não tinha onde
    // olhar.
    const autor = currentActor();
    await AuditLog.record({
      action: AuditLog.ACTIONS.SUBSCRIBER_ACCOUNT_RETIRED,
      actorUserId: autor?.userId ?? null,
      actorUsername: autor?.username ?? null,
      // Trabalho de fundo — a fila, o varredor — chega aqui sem autor, e
      // `system` é a resposta honesta para isso. Inventar um operador seria
      // pior que não ter nenhum.
      actorKind: autor ? 'operator' : 'system',
      subjectType: 'customer_account',
      subjectId: String(account.customer_id),
      detail: {
        deviceId: previousDeviceId,
        // `from`/`to` em inglês como o resto do backend: a tela da trilha
        // imprime a CHAVE crua ao lado do valor, de propósito, para nunca
        // despejar JSON numa célula — então `pppoeAnterior` aparecia em
        // português ao lado de `deviceId`, na mesma linha. O par antes/depois
        // já tem precedente em `usersController` (`{ username, from, to }`).
        pppoeFrom: account.pppoe_username,
        pppoeTo: incomingPppoe
      }
    });

    await CustomerAccount.retire(account.id);
    try {
      await SgpLink.deleteByDeviceId(previousDeviceId);
    } catch (error) {
      console.warn(`Unable to drop the SGP link of a retired account: ${error.message}`);
    }
    return account;
  }

  /**
   * A conta de portal de um aparelho, criando-a quando ainda não existe.
   *
   * ESTE é o ponto por onde toda criação passa, e por isso é aqui que o teto de
   * assinantes do plano é conferido. Ele já era conferido em `syncDevices`, que
   * orça a página inteira de uma vez — mas `syncDevices` não é o único
   * chamador: `deviceController` chama daqui de duas rotas e o provisionamento
   * de uma terceira, e nenhuma das três perguntava pelo teto. Um provedor no
   * limite continuava criando conta indefinidamente; bastava abrir a tela de um
   * aparelho que ainda não tivesse uma, ou provisionar uma ONT.
   *
   * É o mesmo desenho que o limite de OPERADORES já usa e que sempre funcionou:
   * a pergunta mora no ponto de criação, não em cada chamador.
   *
   * O orçamento de `syncDevices` continua onde está, e não é redundante: ele
   * evita N contagens numa página de frota. Esta é a que decide.
   */
  static async ensureAccount(device, { informs = null } = {}) {
    const deviceId = normalizeIdentityValue(device?._id);
    const softwareId = normalizeIdentityValue(device?.softwareId);
    const pppoeUsername = normalizeIdentityValue(device?.pppoe);
    if (!deviceId || !softwareId || !pppoeUsername) return null;

    const identityHash = this.identityHash(softwareId, pppoeUsername);

    const existingByDevice = await CustomerAccount.getByDeviceId(deviceId);
    if (existingByDevice) {
      if (this.isSameSubscriber(existingByDevice, pppoeUsername)) {
        // Same subscriber; refresh the stored identity so a firmware upgrade
        // does not leave the account describing an old software version.
        return this.touchIdentity(existingByDevice, deviceId, softwareId, identityHash);
      }
      // The ONT was re-provisioned for someone else.
      await this.retireAccount(existingByDevice, pppoeUsername);
    }

    const existingByIdentity = await CustomerAccount.getByIdentityHash(identityHash);
    if (existingByIdentity) {
      // A replacement ONT of the same model on the same firmware hashes to the
      // same identity, so this branch — not the PPPoE one below — is where the
      // ordinary swap lands.
      if (!await this.shouldTakeAccount(existingByIdentity, device, deviceId, informs)) return null;
      let moved;
      try {
        moved = await CustomerAccount.touch(existingByIdentity.id, deviceId);
      } catch (error) {
        // Outra linha ainda segura este device_id: não é motivo para derrubar
        // a sincronização da frota inteira. Fica para a próxima passada.
        if (!isUniqueViolation(error)) throw error;
        console.warn(`Customer ID sync: device ${deviceId} still held by another account; skipped`);
        return null;
      }
      await this.noteSwap(existingByIdentity, deviceId, 'identity_hash');
      return moved;
    }

    // The same subscriber on a replacement ONT: the device ID and the software
    // version both changed, so only the PPPoE login still matches.
    const existingByPppoe = await CustomerAccount.getActiveByPppoe(pppoeUsername);
    if (existingByPppoe) {
      if (!await this.shouldTakeAccount(existingByPppoe, device, deviceId, informs)) return null;
      const moved = await this.touchIdentity(existingByPppoe, deviceId, softwareId, identityHash);
      await this.noteSwap(existingByPppoe, deviceId, 'pppoe');
      return moved;
    }

    // Daqui para baixo é conta NOVA — os três ramos acima devolveram uma que já
    // existia. Sem vaga, nada é criado, e a chamada devolve `null` como já faz
    // quando o aparelho não tem identidade suficiente: quem chama trata a
    // ausência de conta, e derrubar a requisição por causa do plano seria
    // transformar um teto comercial em erro de operação.
    //
    // A troca de assinante passa por aqui e NÃO é barrada, sem precisar de
    // caso especial: `retireAccount`, alguns ramos acima, desativa a conta
    // antiga, e `subscriberCount` conta só as vivas — a vaga já está livre
    // quando esta pergunta é feita. Uma bandeira "aposentou" chegou a ser
    // escrita aqui e foi removida: nenhum teste conseguia distingui-la, porque
    // ela não decidia nada.
    const remaining = await SubscriptionService.remainingSubscribers();
    if (remaining !== null && remaining <= 0) {
      console.warn(
        `Plan limit: no subscriber slot left; device ${deviceId} stays without an account`
      );
      return null;
    }

    const generationSettings = await this.getGenerationSettings();
    const profile = generationSettings.suffixMode === 'installation_date'
      ? await DeviceProfile.getByDeviceId(deviceId)
      : null;
    const customerId = this.generateCustomerId(generationSettings, profile?.installation_date);
    if (!customerId) return null;

    // Every account gets its own portal password. The Customer ID identifies
    // the account; it must never be usable as the credential for it.
    const { record: passwordRecord } = await CustomerPortalPasswordService.createRecord();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await CustomerAccount.create({
          customer_id: attempt === 0
            ? customerId
            : this.generateCustomerId(generationSettings, profile?.installation_date),
          device_id: deviceId,
          identity_hash: identityHash,
          software_id: softwareId,
          pppoe_username: pppoeUsername,
          active: true,
          ...passwordRecord,
          last_seen_at: new Date()
        });
      } catch (error) {
        const duplicate =
          error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          error.code === 'ER_DUP_ENTRY' ||
          /unique/i.test(error.message);
        if (!duplicate) throw error;

        const concurrent = await CustomerAccount.getByDeviceId(deviceId)
          || await CustomerAccount.getByIdentityHash(identityHash);
        if (concurrent) return concurrent;
      }
    }
    throw new TranslatableError('settings.customerIdAllocationFailed');
  }

  /**
   * Se `device` pode tomar a conta que hoje está em outro ONT.
   *
   * Só quando ele falou com o GenieACS DEPOIS do ONT que a detém. O ONT
   * antigo continua no GenieACS depois da troca — desligado na gaveta, ou
   * ainda ligado na bancada —, informando o mesmo login PPPoE. A varredura de
   * Customer ID e a lista de aparelhos passam pelos DOIS, e o que ficou sem
   * conta a tomava de volta: A→B numa passada, B→A na seguinte, para sempre.
   * Era isso o "par instável · 97×" do painel, e o vínculo do SGP indo e
   * voltando junto. A conta segue o ONT que está em serviço, e o que está em
   * serviço é o que informou por último.
   *
   * Sem a data de um dos dois — o chamador não a trouxe, o ONT antigo sumiu
   * do GenieACS, o GenieACS não respondeu —, a conta se move como sempre se
   * moveu: é o caso da troca de verdade, e travá-la seria pior.
   */
  static async shouldTakeAccount(account, device, deviceId, informs = null) {
    const holderId = normalizeIdentityValue(account?.device_id);
    if (!holderId || holderId === deviceId) return true;
    const incoming = informMs(device?._lastInform ?? device?.lastInform);
    if (!Number.isFinite(incoming)) return true;
    let holder = informs?.has(holderId) ? informMs(informs.get(holderId)) : Number.NaN;
    if (!Number.isFinite(holder) && !informs?.has(holderId)) {
      try {
        const [row] = await DeviceService.fetchDeviceListPage(
          JSON.stringify({ _id: holderId }),
          ['_id', '_lastInform']
        );
        holder = informMs(row?._lastInform);
      } catch (error) {
        console.warn(`Unable to read the last inform of ${holderId}: ${error.message}`);
      }
    }
    if (!Number.isFinite(holder)) return true;
    return incoming > holder;
  }

  /**
   * Files the replacement of one ONT by another, once the account has already
   * moved onto the new one.
   *
   * After the move, not before: the record is of something that happened, and
   * writing it first would leave a swap on file that the sync then failed to
   * carry out. It also never fails the sync — a device whose account moved but
   * whose swap could not be filed is a missing line in a list, and refusing the
   * whole sync over it would take the panel's device page down with it.
   */
  static async noteSwap(account, deviceId, matchedBy) {
    const previousDeviceId = normalizeIdentityValue(account?.device_id);
    if (!previousDeviceId || previousDeviceId === deviceId) return null;
    try {
      return await DeviceSwapService.record(account, previousDeviceId, deviceId, matchedBy);
    } catch (error) {
      console.warn(`Unable to record a CPE swap for ${previousDeviceId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Moves an account onto a device and refreshes its identity columns. The
   * identity hash is unique, so a collision with another row leaves the stored
   * hash alone rather than failing the sync.
   */
  static async touchIdentity(account, deviceId, softwareId, identityHash) {
    try {
      return await CustomerAccount.touch(account.id, deviceId, {
        software_id: softwareId,
        identity_hash: identityHash
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return CustomerAccount.touch(account.id, deviceId);
    }
  }

  static async syncDevices(devices, { enabled } = {}) {
    // ── A personificação não reconcilia ────────────────────────────────────
    //
    // Esta função é chamada de `GET /api/devices`, e ela ESCREVE: cria conta de
    // portal, cunha senha, e no ramo do assinante trocado aposenta a conta
    // anterior e apaga o vínculo do ERP. O muro da personificação é por MÉTODO
    // (`auth.js`), e GET passa; o papel `viewer` imposto na hidratação tem
    // `devices.list`. Então quem do plantão da plataforma abria o painel de um
    // cliente e clicava na lista de aparelhos podia fazer um assinante daquele
    // cliente perder o Customer ID, a senha do portal e o vínculo com o ERP.
    //
    // É exatamente o que o docstring de `impersonationRefusal` promete que não
    // acontece: "uma escrita feita numa personificação aparece no painel do
    // cliente como coisa que o cliente fez. Um atendimento não pode produzir
    // isso."
    //
    // O conserto reusa o caminho que já existe e já é testado: com
    // `shouldGenerate` falso esta função só LÊ o que está guardado e devolve o
    // mapa. O plantão vê a frota como ela está, e não mexe em nada. A
    // reconciliação acontece na próxima visita de um operador do próprio
    // provedor, que é de quem ela sempre foi.
    //
    // Note que isto NÃO adia a aposentadoria para ninguém mais: para o operador
    // do provedor ela continua acontecendo na hora, que é o que impede a conta
    // do assinante ANTERIOR de continuar apontando para o aparelho do novo.
    if (currentActor()?.impersonation) {
      const rows = await CustomerAccount.getIdsByDeviceIds(
        devices.map((device) => String(device?._id || '')).filter(Boolean)
      );
      return new Map(rows.map((row) => [row.device_id, row.customer_id]));
    }

    const shouldGenerate = enabled ?? await this.isAutoGenerationEnabled();
    const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
    let rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);

    if (shouldGenerate) {
      const storedByDeviceId = new Map(rows.map((row) => [row.device_id, row]));
      // A device with no account needs one; a device whose account still names
      // the previous subscriber's PPPoE login needs that account retired before
      // the new subscriber inherits it.
      const pending = devices.filter((device) => {
        if (!device?._id) return false;
        const stored = storedByDeviceId.get(String(device._id));
        if (!stored) return true;
        // A blank or implausibly short login is a reporting gap, not a new
        // subscriber, and must never cost a live customer their credentials.
        const reported = normalizeIdentityValue(device.pppoe);
        if (reported.length < 3) return false;
        return !this.isSameSubscriber(stored, reported);
      });
      // O limite de assinantes do plano vale para contas NOVAS. Um aparelho que
      // já tem conta e trocou de assinante (aposenta uma, cria outra) não
      // aumenta o total, então não é contado contra o teto — contar seria
      // recusar uma troca de ONT por causa do plano. O que não coube fica para
      // a próxima passada, que pergunta de novo; nada aqui lança, porque a
      // sincronização inteira não pode cair por causa da conta que não coube.
      const remaining = await SubscriptionService.remainingSubscribers();
      let allowed = pending;
      if (remaining !== null) {
        let budget = remaining;
        allowed = pending.filter((device) => {
          if (storedByDeviceId.has(String(device._id))) return true;
          if (budget <= 0) return false;
          budget -= 1;
          return true;
        });
        if (allowed.length < pending.length) {
          console.warn(
            `Plan limit: ${pending.length - allowed.length} device(s) left without a subscriber account`
          );
        }
      }
      // O último inform de cada ONT desta passada, para `shouldTakeAccount`
      // decidir entre o antigo e o novo sem uma consulta ao GenieACS por troca.
      const informs = new Map(devices
        .filter((device) => device?._id)
        .map((device) => [String(device._id), device._lastInform ?? device.lastInform ?? null]));
      // Keep database pressure bounded while avoiding a slow one-by-one sync
      // for larger GenieACS fleets.
      for (let offset = 0; offset < allowed.length; offset += 10) {
        await Promise.all(
          allowed.slice(offset, offset + 10).map((device) => this.ensureAccount(device, { informs }))
        );
      }
      if (allowed.length > 0) {
        rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);
      }
    }

    return new Map(rows.map((row) => [row.device_id, row.customer_id]));
  }

  static async decorateDevices(devices) {
    const customerIds = await this.syncDevices(devices);
    return devices.map((device) => ({
      ...device,
      customerId: customerIds.get(String(device._id)) || null
    }));
  }
}

export default CustomerService;
