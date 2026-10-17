import Tenant from '../models/Tenant.js';
import Setting from '../models/Setting.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import GenieAcsAuthService, { AUTH_TYPES } from '../services/genieacsAuthService.js';
import { suggestGenieAcsUrl } from '../services/genieacsSuggestion.js';
import { runInTenant } from '../config/tenantContext.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { probeGenieAcs } from './settingsController.js';
import { VIRTUAL_PARAMETER_KEYS } from '../config/platformManaged.js';
import { getDb } from '../config/database.js';
import GenieAcsConnection, { CONNECTION_MODES, GENIEACS_OWNERSHIPS } from '../models/GenieAcsConnection.js';
import { DEVICE_SCOPE_KEY, DEVICE_SCOPE_TAG_PATTERN, forgetSharedAcs } from '../services/genieacs/direct.js';
import { afterModeChange, agentStatus, issueAgentToken } from '../services/genieacs/agent.js';
import { TAG_PREFIX } from '../services/deviceTagService.js';
import FirmwareStore, { readOriginalName } from '../services/firmwareStore.js';
import { isAgentOffline } from '../services/genieacs/agent.js';
import { translateError } from '../i18n/index.js';
import DeviceScopeTagger, {
  AUTO_PREFIXES_KEY, AUTO_PREFIXES_MAX, AUTO_PREFIX_MAX_LENGTH, parsePrefixes, prefixesOverlap
} from '../services/deviceScopeTagger.js';

/**
 * O GenieACS de um provedor, configurado do console.
 *
 * Na SaaS quem hospeda o ACS é a plataforma, então é ela quem diz para onde o
 * painel de cada provedor fala e com que credencial — o provedor vê o status
 * e testa a conexão, mas não grava (ver `config/platformManaged.js`). Os dados
 * continuam onde sempre estiveram, POR PROVEDOR: `settings.genieAcsUrl` e o
 * `app_state` da credencial daquele tenant. O console só escreve lá de fora,
 * dentro do `runInTenant` do alvo, que é o mesmo caminho das outras ações do
 * plano de controle sobre um provedor.
 *
 * A exceção é o provedor com servidor próprio (`ownership = 'own'`, escolhido
 * aqui): aí ele mesmo grava endereço, credencial e parâmetros TR-069 na tela
 * dele. O console continua podendo editar tudo, para o suporte.
 *
 * Mensagens em inglês e sem tradução, como o resto do console.
 */

/**
 * A recusa de um gesto de firmware: as do serviço (nome, tamanho, existe, sem
 * tag) com o código delas; o agente fora do ar como 503; o resto, 502 — é o
 * GenieACS do provedor que falhou.
 */
function respostaDeFirmware(req, res, error, fallback) {
  if (isAgentOffline(error)) {
    return res.status(503).json(createErrorResponse('The GenieACS agent of this provider is offline', null, error.code));
  }
  if (error?.translationKey) {
    return res.status(error.status || 400).json(createErrorResponse(translateError(req.t, error), null, error.code || null));
  }
  console.error('Platform GenieACS firmware error:', error);
  return res.status(502).json(createErrorResponse(fallback, error.message));
}

async function loadTarget(req, res) {
  const id = Number(req.params?.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(createErrorResponse('Invalid provider id'));
    return null;
  }
  const tenant = await Tenant.findById(id);
  if (!tenant || tenant.kind === 'platform') {
    res.status(404).json(createErrorResponse('Provider not found'));
    return null;
  }
  return tenant;
}

/** `''` apaga; qualquer outra coisa tem que ser um endereço HTTP(S) sem credencial. */
function urlProblem(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.length > 2048) return 'URL is too long';
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'URL is not valid';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'URL must be http or https';
  if (url.username || url.password) return 'URL must not carry credentials';
  return null;
}

/**
 * `{ vpRxPower: 'VirtualParameters.X', … }` lido do corpo, ou o erro. Só as
 * chaves conhecidas; vazio é permitido (os dois campos opcionais da tela).
 */
function readVirtualParameters(raw) {
  if (raw === undefined) return { value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'virtualParameters must be an object' };
  }
  const value = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!VIRTUAL_PARAMETER_KEYS.includes(key)) return { error: `Unknown virtual parameter: ${key}` };
    const text = String(v ?? '').trim();
    if (text.length > 255) return { error: `${key} is too long` };
    value[key] = text;
  }
  return { value };
}

/**
 * `''` apaga; senão, letras, números, `-` e `_`. Não pode começar com um
 * prefixo que o painel gerencia (`contrato_`, `loja_`...): esses o painel
 * reescreve sozinho, e a tag do provedor sumiria na primeira passada.
 */
function scopeTagProblem(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (!DEVICE_SCOPE_TAG_PATTERN.test(text)) return 'Device tag must be 1-64 letters, digits or "_"';
  if (Object.values(TAG_PREFIX).some((prefix) => text.toLowerCase().startsWith(prefix))) {
    return 'Device tag must not start with a prefix the panel manages';
  }
  return null;
}

/**
 * Outros provedores apontando para o MESMO GenieACS, e se algum deles (ou
 * este) está sem tag. Sem tag num ACS compartilhado, cada um vê a frota de
 * todos — é o aviso que o console tem que dar.
 */
async function sharedAcs(tenant, url) {
  const origem = (() => { try { return url ? new URL(url).origin : null; } catch { return null; } })();
  if (!origem) return { providers: [], missingTag: false };
  // tenant-scope-exempt: o console comparando o ACS de todos os provedores —
  // atravessar provedores é o trabalho desta leitura.
  const rows = await getDb()('settings')
    .whereIn('key', ['genieAcsUrl', DEVICE_SCOPE_KEY, AUTO_PREFIXES_KEY])
    .whereIn('tenant_id', getDb()('tenants').select('id'))
    .select('tenant_id', 'key', 'value');
  const porProvedor = new Map();
  for (const row of rows) {
    const atual = porProvedor.get(row.tenant_id) || {};
    atual[row.key] = String(row.value ?? '').trim();
    porProvedor.set(row.tenant_id, atual);
  }
  const mesmos = [...porProvedor.entries()].filter(([, v]) => {
    try { return v.genieAcsUrl && new URL(v.genieAcsUrl).origin === origem; } catch { return false; }
  });
  if (mesmos.length < 2) return { providers: [], missingTag: false };
  const ids = mesmos.map(([id]) => id);
  const nomes = new Map((await getDb()('tenants').whereIn('id', ids).select('id', 'name', 'kind'))
    .map((t) => [t.id, t]));
  const providers = mesmos
    .filter(([id]) => nomes.get(id)?.kind !== 'platform')
    .map(([id, v]) => ({
      id,
      name: nomes.get(id)?.name || String(id),
      deviceTag: v[DEVICE_SCOPE_KEY] || '',
      autoTagPrefixes: parsePrefixes(v[AUTO_PREFIXES_KEY])
    }));
  return {
    providers: providers.filter((p) => p.id !== tenant.id),
    missingTag: providers.length > 1 && providers.some((p) => !p.deviceTag)
  };
}

async function snapshot(tenant) {
  const base = await runInTenant(tenant.id, async () => ({
    virtualParameters: Object.fromEntries(await Promise.all(
      VIRTUAL_PARAMETER_KEYS.map(async (key) => [key, (await Setting.getByKey(key)) ?? ''])
    )),
    url: (await Setting.getByKey('genieAcsUrl')) || '',
    deviceTag: (await Setting.getByKey(DEVICE_SCOPE_KEY)) || '',
    autoTagPrefixes: await DeviceScopeTagger.autoPrefixes(),
    lastAutoTag: await DeviceScopeTagger.lastAuto(),
    auth: await GenieAcsAuthService.getPublicConfig(),
    mode: await GenieAcsConnection.mode(),
    ownership: await GenieAcsConnection.ownership(),
    agent: await agentStatus(),
    suggestion: suggestGenieAcsUrl(tenant)
  }));
  return { ...base, sharedAcs: await sharedAcs(tenant, base.url) };
}

class PlatformGenieAcsController {
  /** `GET /api/platform/tenants/:id/genieacs` — endereço, credencial sem segredo, sugestão. */
  static async get(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      return res.json(createResponse('GenieACS configuration retrieved', await snapshot(tenant)));
    } catch (error) {
      console.error('Platform GenieACS read error:', error);
      return res.status(500).json(createErrorResponse('Internal server error', error.message));
    }
  }

  /**
   * `PUT /api/platform/tenants/:id/genieacs` — `{ url?, mode?, ownership?, authType?, username?, secret?, virtualParameters?, deviceTag?, autoTagPrefixes? }`.
   *
   * `mode` é como o painel chega ao ACS: `direct`, `tunnel` (rede privada
   * de cliente liberada para este provedor) ou `agent` (o programa na rede do
   * provedor, por WebSocket de saída). Na SaaS só a plataforma escolhe. Sair
   * de `agent` derruba a conexão do agente (fechamento `4003`).
   *
   * `ownership` é quem administra o ACS: `platform` ou `own` (o servidor é do
   * provedor, e endereço, credencial e parâmetros TR-069 passam a ser dele).
   * Voltar para `platform` mantém o que ele gravou.
   *
   * Campo ausente mantém o que está lá, e `secret` segue a regra da tela do
   * provedor: `undefined` mantém, `''` apaga.
   */
  static async update(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;

      const corpo = req.body ?? {};
      const mandouUrl = corpo.url !== undefined;
      if (mandouUrl) {
        const problem = urlProblem(corpo.url);
        if (problem) return res.status(400).json(createErrorResponse(problem));
      }
      if (corpo.mode !== undefined && !CONNECTION_MODES.includes(corpo.mode)) {
        return res.status(400).json(createErrorResponse(`mode must be one of ${CONNECTION_MODES.join(', ')}`));
      }
      if (corpo.ownership !== undefined && !GENIEACS_OWNERSHIPS.includes(corpo.ownership)) {
        return res.status(400).json(createErrorResponse(`ownership must be one of ${GENIEACS_OWNERSHIPS.join(', ')}`));
      }
      if (corpo.authType !== undefined && !AUTH_TYPES.includes(corpo.authType)) {
        return res.status(400).json(createErrorResponse(`authType must be one of ${AUTH_TYPES.join(', ')}`));
      }
      const mandouAuth = ['authType', 'username', 'secret'].some((k) => corpo[k] !== undefined);
      const vps = readVirtualParameters(corpo.virtualParameters);
      if (vps.error) return res.status(400).json(createErrorResponse(vps.error));
      const mandouTag = corpo.deviceTag !== undefined;
      if (mandouTag) {
        const problem = scopeTagProblem(corpo.deviceTag);
        if (problem) return res.status(400).json(createErrorResponse(problem));
        const tagNova = String(corpo.deviceTag).trim();
        // tenant-scope-exempt: dois provedores com a mesma tag enxergariam um a
        // frota do outro — a conferência olha os outros provedores de propósito.
        if (tagNova) {
          const dono = await getDb()('settings')
            .where({ key: DEVICE_SCOPE_KEY, value: tagNova })
            .whereNot({ tenant_id: tenant.id })
            .first();
          if (dono) return res.status(409).json(createErrorResponse('Another provider already uses this device tag'));
        }
      }

      const antes = await snapshot(tenant);
      const mandouPrefixos = corpo.autoTagPrefixes !== undefined;
      const prefixosNovos = mandouPrefixos ? parsePrefixes(corpo.autoTagPrefixes) : antes.autoTagPrefixes;
      if (mandouPrefixos) {
        if (prefixosNovos.length > AUTO_PREFIXES_MAX) {
          return res.status(400).json(createErrorResponse(`At most ${AUTO_PREFIXES_MAX} auto-tag prefixes`));
        }
        if (prefixosNovos.some((p) => p.length > AUTO_PREFIX_MAX_LENGTH)) {
          return res.status(400).json(createErrorResponse('Auto-tag prefix is too long'));
        }
        const tagFinal = mandouTag ? String(corpo.deviceTag).trim() : antes.deviceTag;
        if (prefixosNovos.length > 0 && !tagFinal) {
          return res.status(400).json(createErrorResponse('Set the provider device tag before auto-tag prefixes'));
        }
        // Dois provedores no mesmo ACS com prefixos que se cobrem disputariam
        // as mesmas ONTs — o primeiro a passar ficaria com elas.
        const urlFinal = mandouUrl ? String(corpo.url).trim() : antes.url;
        const vizinhos = (await sharedAcs(tenant, urlFinal)).providers;
        const disputa = vizinhos.find((v) => v.autoTagPrefixes
          .some((dele) => prefixosNovos.some((meu) => prefixesOverlap(meu, dele))));
        if (disputa) {
          return res.status(409).json(createErrorResponse(`Auto-tag prefixes overlap with provider ${disputa.name}`));
        }
      }
      const mudouPrefixos = mandouPrefixos && prefixosNovos.join(',') !== antes.autoTagPrefixes.join(',');
      const tipoFinal = corpo.authType ?? antes.auth.authType;
      const usuarioFinal = corpo.username === undefined ? antes.auth.username : String(corpo.username).trim();
      if (mandouAuth && tipoFinal === 'basic' && !usuarioFinal) {
        return res.status(400).json(createErrorResponse('Basic authentication needs a username'));
      }

      const urlNova = mandouUrl ? String(corpo.url).trim() : antes.url;
      const mudouUrl = mandouUrl && urlNova !== antes.url;
      const tagNova = mandouTag ? String(corpo.deviceTag).trim() : antes.deviceTag;
      const mudouTag = mandouTag && tagNova !== antes.deviceTag;
      const mudouModo = corpo.mode !== undefined && corpo.mode !== antes.mode;
      const mudouDono = corpo.ownership !== undefined && corpo.ownership !== antes.ownership;
      const vpsMudados = vps.value
        ? Object.entries(vps.value).filter(([key, v]) => v !== antes.virtualParameters[key])
        : [];

      await runInTenant(tenant.id, async () => {
        if (mudouUrl) await Setting.upsert('genieAcsUrl', urlNova);
        if (mudouModo) {
          await GenieAcsConnection.setMode(corpo.mode);
          afterModeChange(antes.mode, corpo.mode);
        }
        if (mudouDono) await GenieAcsConnection.setOwnership(corpo.ownership);
        if (mudouTag) await Setting.upsert(DEVICE_SCOPE_KEY, tagNova);
        if (mudouPrefixos) await Setting.upsert(AUTO_PREFIXES_KEY, prefixosNovos.join(','));
        for (const [key, v] of vpsMudados) await Setting.upsert(key, v);
        if (mandouAuth) {
          await GenieAcsAuthService.saveConfig({
            authType: corpo.authType,
            username: corpo.username,
            secret: corpo.secret
          });
        }
      });
      // Endereço ou tag mudaram: quem divide o ACS com quem muda junto, e o
      // escopo de cada painel tem que ser recalculado já, não em 30 s.
      // O modo também: quem está em `agent` deixa de contar como vizinho no
      // mesmo endereço (ver `sharesAcs`).
      if (mudouUrl || mudouTag || mudouModo) forgetSharedAcs();
      const depois = await snapshot(tenant);

      if (!mudouUrl && !mudouModo && !mudouDono && !mudouTag && !mudouPrefixos && !mandouAuth && vpsMudados.length === 0) {
        return res.json(createResponse('GenieACS configuration unchanged', depois));
      }

      // O segredo não entra em trilha nenhuma — o que entra é que a credencial
      // mudou, para qual tipo e se passou a existir uma, a mesma regra da tela
      // do provedor.
      const detail = {};
      if (mudouUrl) detail.url = { from: antes.url || null, to: urlNova || null };
      if (mudouModo) detail.mode = { from: antes.mode, to: corpo.mode };
      if (mudouDono) detail.ownership = { from: antes.ownership, to: corpo.ownership };
      if (mudouTag) detail.deviceTag = { from: antes.deviceTag || null, to: tagNova || null };
      if (mudouPrefixos) detail.autoTagPrefixes = { from: antes.autoTagPrefixes, to: prefixosNovos };
      if (vpsMudados.length) {
        detail.virtualParameters = Object.fromEntries(
          vpsMudados.map(([key, v]) => [key, { from: antes.virtualParameters[key] || null, to: v || null }])
        );
      }
      if (mandouAuth) {
        detail.auth = {
          authType: depois.auth.authType,
          username: depois.auth.username,
          secretConfigured: depois.auth.secretConfigured
        };
      }
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_GENIEACS_CHANGED,
        tenant,
        detail
      });
      // E na trilha DELE: quem vai perguntar "por que o painel parou de achar
      // as ONTs" é o provedor, e ele não lê a nossa.
      if (mudouUrl) {
        await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_URL_CHANGED,
          actorKind: 'platform',
          subjectType: 'settings',
          subjectId: 'genieAcsUrl',
          detail: { url: urlNova }
        }));
      }
      if (mudouModo) {
        await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_CONNECTION_CHANGED,
          actorKind: 'platform',
          subjectType: 'settings',
          subjectId: 'genieacs-connection',
          detail: detail.mode
        }));
      }
      if (mudouDono) {
        await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_OWNERSHIP_CHANGED,
          actorKind: 'platform',
          subjectType: 'settings',
          subjectId: 'genieacs-ownership',
          detail: detail.ownership
        }));
      }
      if (mandouAuth) {
        await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.GENIEACS_AUTH_CHANGED,
          actorKind: 'platform',
          subjectType: 'settings',
          subjectId: 'genieacs-auth',
          detail: detail.auth
        }));
      }

      return res.json(createResponse('GenieACS configuration updated', depois));
    } catch (error) {
      console.error('Platform GenieACS update error:', error);
      return res.status(500).json(createErrorResponse('Internal server error', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/genieacs/tag-devices` —
   * `{ pppoePrefix?, serials?, apply? }`.
   *
   * Marca com a tag do provedor os equipamentos do ACS que casam com um prefixo
   * de login PPPoE ou com uma lista de seriais. Sem `apply`, só conta: o console
   * mostra quantos seriam marcados antes de marcar.
   *
   * Roda SEM o escopo do provedor, porque o que se procura é justamente o que
   * ainda não tem tag. Equipamento que já carrega a tag de OUTRO provedor não é
   * tocado — ele volta como conflito, para a plataforma decidir à mão.
   */
  static async tagDevices(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const corpo = req.body ?? {};
      const prefixo = String(corpo.pppoePrefix ?? '').trim().toLowerCase();
      const listaCrua = Array.isArray(corpo.serials) ? corpo.serials.join(' ') : String(corpo.serials ?? '');
      const seriais = new Set(listaCrua.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
      if (!prefixo && seriais.size === 0) {
        return res.status(400).json(createErrorResponse('Give a PPPoE prefix or a list of serial numbers'));
      }
      if (prefixo.length > 64 || seriais.size > 5000) {
        return res.status(400).json(createErrorResponse('Filter is too large'));
      }
      const aplicar = corpo.apply === true;

      const resultado = await runInTenant(tenant.id, () => DeviceScopeTagger.run({
        prefixes: prefixo ? [prefixo] : [],
        serials: seriais,
        apply: aplicar
      }));
      if (resultado.error) return res.status(400).json(createErrorResponse(resultado.error));

      if (aplicar && resultado.tagged > 0) {
        await PlatformAudit.fromRequest(req, {
          action: PlatformAudit.ACTIONS.TENANT_GENIEACS_CHANGED,
          tenant,
          detail: { taggedDevices: resultado.tagged, tag: resultado.tag, pppoePrefix: prefixo || null, serials: seriais.size || null }
        });
      }
      return res.json(createResponse(aplicar ? 'Devices tagged' : 'Devices that would be tagged', resultado));
    } catch (error) {
      console.error('Platform GenieACS tag-devices error:', error);
      return res.status(502).json(createErrorResponse('Could not tag devices', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/genieacs/agent-token` — gera a chave do
   * agente do provedor. 201 `{ token, agent }`; a chave aparece só aqui.
   *
   * Em qualquer modo: a plataforma pode deixar a chave pronta antes de passar
   * o provedor para `agent`, e o agente só entra quando o modo for `agent`
   * (ver `agentHub.autenticar`). Gerar outra derruba a conexão atual (4001).
   *
   * As duas trilhas recebem a DICA da chave (os 4 últimos caracteres), nunca
   * a chave.
   */
  static async agentToken(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const { token, agent } = await runInTenant(tenant.id, () => issueAgentToken());
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_GENIEACS_CHANGED,
        tenant,
        detail: { agentToken: { tokenHint: agent.tokenHint } }
      });
      await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.GENIEACS_AGENT_TOKEN_GENERATED,
        actorKind: 'platform',
        subjectType: 'settings',
        subjectId: 'genieacs-connection',
        detail: { tokenHint: agent.tokenHint }
      }));
      return res.status(201).json(createResponse('GenieACS agent key generated', { token, agent }));
    } catch (error) {
      console.error('Platform GenieACS agent-token error:', error?.message || error);
      return res.status(500).json(createErrorResponse('Internal server error'));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/genieacs/test` — `{ url? }`, o gravado quando ausente.
   *
   * O mesmo teste da tela do provedor, rodando no escopo dele: a credencial
   * guardada só acompanha quando o endereço testado é a origem já salva.
   */
  /**
   * `GET /api/platform/tenants/:id/genieacs/firmware/unowned` —
   * `{ tag, shared, files }`: os firmwares SEM prefixo de dono do GenieACS do
   * provedor, quando esse ACS é compartilhado. ACS só dele: `shared: false` e
   * lista vazia (lá o arquivo sem prefixo é dele). Consulta fora do escopo do
   * provedor — o que se procura é justamente o que o escopo esconde.
   */
  static async listUnownedFirmware(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const data = await runInTenant(tenant.id, () => FirmwareStore.listUnowned());
      return res.json(createResponse(null, data));
    } catch (error) {
      return respostaDeFirmware(req, res, error, 'Could not list the firmware files');
    }
  }

  /**
   * `POST /api/platform/tenants/:id/genieacs/firmware/reassign` — o arquivo
   * cru no corpo, `X-File-Name` = o nome do arquivo SEM dono. Grava
   * `<tag>--<nome>` com os metadados do antigo, se o tamanho bate; 201 com o
   * arquivo novo. O antigo fica: apagá-lo é o gesto seguinte.
   */
  static async reassignFirmware(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const nome = readOriginalName(req);
      const { tag, file } = await runInTenant(tenant.id, () => FirmwareStore.reassign(nome, req.body));
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_FIRMWARE_REASSIGNED,
        tenant,
        detail: { from: nome.slice(0, 200), to: file.id.slice(0, 200), tag }
      });
      // O provedor também vê, na trilha dele, quem pôs o arquivo lá.
      await runInTenant(tenant.id, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.DEVICE_FIRMWARE_UPLOAD,
        actorKind: 'platform',
        subjectType: 'firmware',
        subjectId: file.id.slice(0, 128),
        detail: { size: file.size, productClass: file.productClass, version: file.version, reassignedFrom: nome.slice(0, 128) }
      }));
      return res.status(201).json(createResponse('Firmware reassigned', file));
    } catch (error) {
      return respostaDeFirmware(req, res, error, 'Could not reassign the firmware file');
    }
  }

  /** `DELETE /api/platform/tenants/:id/genieacs/firmware/unowned/:name` — apaga um firmware sem dono. */
  static async deleteUnownedFirmware(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const nome = String(req.params?.name ?? '');
      const file = await runInTenant(tenant.id, () => FirmwareStore.removeUnowned(nome));
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_FIRMWARE_DELETED,
        tenant,
        detail: { file: file.id.slice(0, 200) }
      });
      return res.json(createResponse('Firmware deleted', { id: file.id }));
    } catch (error) {
      return respostaDeFirmware(req, res, error, 'Could not delete the firmware file');
    }
  }

  static async test(req, res) {
    try {
      const tenant = await loadTarget(req, res);
      if (!tenant) return undefined;
      const { status, body } = await runInTenant(tenant.id, async () => {
        const url = req.body?.url ?? (await Setting.getByKey('genieAcsUrl'));
        return probeGenieAcs(req.t, url);
      });
      return res.status(status).json(body);
    } catch (error) {
      console.error('Platform GenieACS test error:', error);
      return res.status(500).json(createErrorResponse('Internal server error', error.message));
    }
  }
}

export default PlatformGenieAcsController;
