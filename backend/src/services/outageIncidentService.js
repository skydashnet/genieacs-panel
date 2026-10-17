import WaMetaTemplateService from './waMetaTemplateService.js';
import SgpLink from '../models/SgpLink.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import AuditLog from '../models/AuditLog.js';
import WaSendService from './waSendService.js';
import { WaError } from './whatsappConfigService.js';
import { tdb, tinsert, tinsertReturningId } from '../config/database.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

const t = (chave, vars) => translate(DEFAULT_LOCALE, chave, vars);

/** Quanto tempo um incidente resolvido continua na tela. */
const RECENTES_MS = 24 * 60 * 60 * 1000;
/** Os períodos que o quadro oferece, em dias. */
const PERIODOS_DIAS = [1, 7, 30, 90];
/** Teto da lista: 90 dias de uma rede ruim não podem virar milhares de cartões. */
const LIST_LIMIT = 200;

/** O número que fala com o assinante: o do atendimento, e na falta o padrão. */
async function contaDeEnvio() {
  return WhatsAppAccount.getForPurpose('support');
}

/**
 * Enfileira uma mensagem para um número, pela conta dada. Sequencial de
 * propósito, como os alertas: `WaConversation.ensure` é um get-or-create sem
 * transação, e dois para o mesmo número em paralelo abririam duas conversas.
 */
async function enfileirar(account, phone, body) {
  const conversation = await WaConversation.ensure({
    accountId: account.id,
    externalThreadId: `${phone}@s.whatsapp.net`,
    waPhone: phone,
    waLid: null,
    pushName: null
  });
  // Número oficial fora da janela: o aviso sai pelo modelo da Meta ligado a
  // ele, com o texto inteiro no parâmetro.
  const metaTemplate = await WaMetaTemplateService.noticePayload('outage', body);
  await WaSendService.enqueue({ conversationId: conversation.id, body, userId: null, source: 'alert', metaTemplate });
}

/**
 * Os incidentes de queda em massa: o que o alerta `mass_outage` viu, virado em
 * algo que o operador confere e com que avisa os CLIENTES.
 *
 * O alerta continua sendo quem detecta — um nó do mapa com ONTs demais offline
 * — e continua avisando só a equipe. Aqui a mesma condição abre um incidente
 * com a lista dos aparelhos; o aviso ao assinante é um clique do operador, e o
 * "serviço normalizado" sai sozinho, no fim, só para quem foi avisado.
 */
class OutageIncidentService {
  /**
   * Chamado pela varredura dos alertas, com o que está disparando agora.
   * Nunca lança para o chamador: um incidente que não abre não pode impedir o
   * alerta da equipe.
   */
  static async syncFromScan({ firing, unknown }) {
    const ativos = new Map();
    for (const condition of firing.values()) {
      if (condition.rule !== 'mass_outage' || !Array.isArray(condition.devices)) continue;
      ativos.set(String(condition.subject), condition);
    }
    const abertos = await tdb('outage_incidents').where({ status: 'open' });
    const abertoPorNo = new Map(abertos.map((row) => [String(row.node_id), row]));

    for (const [nodeId, condition] of ativos) {
      let incidente = abertoPorNo.get(nodeId);
      if (!incidente) {
        const id = await tinsertReturningId('outage_incidents', {
          node_id: nodeId,
          node_name: condition.vars?.node ?? nodeId,
          status: 'open',
          started_at: new Date(),
          created_at: new Date(),
          updated_at: new Date()
        });
        incidente = { id };
      }
      await this.acrescentarAparelhos(incidente.id, condition.devices);
    }

    for (const [nodeId, row] of abertoPorNo) {
      if (ativos.has(nodeId) || unknown?.has(`mass_outage:${nodeId}`)) continue;
      await this.resolver(row.id);
    }
  }

  /** Os aparelhos que caíram depois da abertura entram no mesmo incidente. */
  static async acrescentarAparelhos(incidentId, deviceIds) {
    const ja = new Set(await tdb('outage_incident_devices').where({ incident_id: incidentId }).pluck('device_id'));
    const novos = deviceIds.map(String).filter((id) => id && !ja.has(id));
    if (novos.length === 0) return;
    const links = await SgpLink.getByDeviceIds(novos);
    const linkPor = new Map(links.map((link) => [String(link.device_id), link]));
    for (const deviceId of novos) {
      const link = linkPor.get(deviceId);
      // eslint-disable-next-line no-await-in-loop -- poucos por varredura, e o índice único segura repetição
      await tinsert('outage_incident_devices', {
        incident_id: incidentId,
        device_id: deviceId,
        contract: link?.contract ?? null,
        client_name: link?.client_name ?? null,
        phone_e164: normalizarTelefoneBr(link?.phone_manual) || normalizarTelefoneBr(link?.phone_e164) || null,
        created_at: new Date()
      });
    }
    await tdb('outage_incidents').where({ id: incidentId }).update({ updated_at: new Date() });
  }

  /**
   * Fecha o incidente e, se o aviso saiu, manda o "normalizado" a quem o
   * recebeu — uma vez por telefone. Sem aviso enviado, fecha em silêncio: o
   * cliente que não ouviu falar da queda não precisa ouvir que ela acabou.
   */
  static async resolver(incidentId) {
    const incidente = await tdb('outage_incidents').where({ id: incidentId }).first();
    if (!incidente || incidente.status !== 'open') return incidente;
    const agora = new Date();
    await tdb('outage_incidents').where({ id: incidentId })
      .update({ status: 'resolved', resolved_at: agora, updated_at: agora });

    const avisados = await tdb('outage_incident_devices')
      .where({ incident_id: incidentId })
      .whereNotNull('notified_at')
      .whereNotNull('phone_e164');
    if (avisados.length > 0) {
      const account = await contaDeEnvio();
      const telefones = [...new Set(avisados.map((row) => row.phone_e164))];
      const optOut = await WaOptOut.activePhones(telefones, 'service');
      if (account) {
        for (const phone of telefones) {
          if (optOut.has(phone)) continue;
          try {
            // eslint-disable-next-line no-await-in-loop -- ver `enfileirar`
            await enfileirar(account, phone, t('whatsapp.outage.recovered'));
          } catch (error) {
            console.warn(`outage recovered ${incidentId}:`, error?.message || error);
          }
        }
        await tdb('outage_incidents').where({ id: incidentId }).update({ recovery_sent_at: agora });
      }
      await tdb('outage_incident_devices').where({ incident_id: incidentId }).update({ recovered_at: agora });
    }
    return tdb('outage_incidents').where({ id: incidentId }).first();
  }

  /** O texto padrão do aviso, com a previsão quando houver. */
  static textoPadrao(incidente, eta) {
    const linhas = [t('whatsapp.outage.notice', { node: incidente.node_name || incidente.node_id })];
    if (eta) linhas.push(t('whatsapp.outage.eta', { eta }));
    return linhas.join('\n');
  }

  /**
   * Avisa os clientes afetados que ainda não foram avisados: um por telefone,
   * pulando quem pediu para não receber mensagens.
   */
  static async notify(incidentId, { eta, body, userId, username, req } = {}) {
    const incidente = await tdb('outage_incidents').where({ id: incidentId }).first();
    if (!incidente) throw new WaError('whatsapp.error.outageNotFound', { code: 'not_found', status: 404 });
    if (incidente.status !== 'open') {
      throw new WaError('whatsapp.error.outageClosed', { code: 'outage_closed', status: 409 });
    }
    const account = await contaDeEnvio();
    if (!account) throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });

    const previsao = eta === undefined ? incidente.eta_text : String(eta ?? '').trim().slice(0, 255) || null;
    const texto = String(body ?? '').trim().slice(0, 1000) || this.textoPadrao(incidente, previsao);

    const pendentes = await tdb('outage_incident_devices')
      .where({ incident_id: incidentId })
      .whereNull('notified_at')
      .whereNotNull('phone_e164');
    const telefones = [...new Set(pendentes.map((row) => row.phone_e164))];
    const optOut = await WaOptOut.activePhones(telefones, 'service');
    const agora = new Date();
    let enviados = 0;
    let pulados = 0;
    for (const phone of telefones) {
      if (optOut.has(phone)) {
        pulados += 1;
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- ver `enfileirar`
        await enfileirar(account, phone, texto);
        enviados += 1;
        // eslint-disable-next-line no-await-in-loop
        await tdb('outage_incident_devices')
          .where({ incident_id: incidentId, phone_e164: phone })
          .update({ notified_at: agora });
      } catch (error) {
        console.warn(`outage notify ${incidentId}:`, error?.message || error);
      }
    }

    await tdb('outage_incidents').where({ id: incidentId }).update({
      eta_text: previsao,
      notice_body: texto,
      notice_sent_at: agora,
      notice_sent_by: userId ?? null,
      updated_at: agora
    });
    const auditoria = {
      action: AuditLog.ACTIONS.OUTAGE_NOTIFIED,
      subjectType: 'outage',
      subjectId: incidentId,
      detail: { node: incidente.node_name || incidente.node_id, sent: enviados, skippedOptOut: pulados }
    };
    if (req) await AuditLog.fromRequest(req, auditoria);
    else await AuditLog.record({ ...auditoria, actorUserId: userId ?? null, actorUsername: username ?? null });
    return { sent: enviados, skippedOptOut: pulados };
  }

  /** O bot pergunta: este aparelho está numa queda em andamento? */
  static async openForDevice(deviceId) {
    if (!deviceId) return null;
    // Duas consultas e não um join: cada tabela passa pelo `tdb`, que é quem
    // põe o filtro do provedor — num join a segunda ficaria sem ele.
    const abertos = await tdb('outage_incidents').where({ status: 'open' }).pluck('id');
    if (abertos.length === 0) return null;
    const afetado = await tdb('outage_incident_devices')
      .whereIn('incident_id', abertos)
      .where({ device_id: String(deviceId) })
      .first();
    if (!afetado) return null;
    const incidente = await tdb('outage_incidents').where({ id: afetado.incident_id }).first();
    return incidente ? { ...incidente, affected_id: afetado.id } : null;
  }

  /** Quem perguntou ao bot já sabe da queda: recebe o "normalizado" no fim. */
  static async markAsked(affectedId, phone) {
    const linha = await tdb('outage_incident_devices').where({ id: affectedId }).first();
    if (!linha) return;
    // Sem telefone no cadastro (identificado por CPF, por exemplo), o
    // "normalizado" vai para o número que perguntou.
    const patch = {};
    if (!linha.notified_at) patch.notified_at = new Date();
    const telefone = normalizarTelefoneBr(phone);
    if (!linha.phone_e164 && telefone) patch.phone_e164 = telefone;
    if (Object.keys(patch).length) await tdb('outage_incident_devices').where({ id: affectedId }).update(patch);
  }

  static async setEta(incidentId, eta) {
    const row = await tdb('outage_incidents').where({ id: incidentId }).first();
    if (!row) throw new WaError('whatsapp.error.outageNotFound', { code: 'not_found', status: 404 });
    await tdb('outage_incidents').where({ id: incidentId })
      .update({ eta_text: String(eta ?? '').trim().slice(0, 255) || null, updated_at: new Date() });
    return this.get(incidentId);
  }

  /**
   * Os incidentes, com as contagens. Sem filtro: os abertos e os resolvidos
   * nas últimas 24 h — o que o quadro sempre mostrou.
   *
   * - `days` (1, 7, 30 ou 90): até onde olhar para trás. Um incidente aberto
   *   aparece seja qual for o período — ele está acontecendo agora.
   * - `status`: `open` ou `resolved`.
   * - `search`: parte do nome (ou do id) do ponto do mapa.
   * - `notified`: `pending` (ainda ninguém avisado) ou `sent`.
   */
  static async list({ days, status, search, notified } = {}) {
    const dias = PERIODOS_DIAS.includes(Number(days)) ? Number(days) : 1;
    const desde = new Date(Date.now() - dias * RECENTES_MS);
    const query = tdb('outage_incidents');
    if (status === 'open') query.where({ status: 'open' });
    else if (status === 'resolved') query.whereNot({ status: 'open' }).where('resolved_at', '>=', desde);
    else query.where((q) => q.where({ status: 'open' }).orWhere('resolved_at', '>=', desde));

    // Como a busca da caixa de entrada: os curingas do LIKE saem do termo,
    // e um termo que só tinha curingas não acha nada.
    if (String(search ?? '').trim()) {
      const termo = WaConversation.likeTerm(search).slice(0, 100);
      query.where((q) => {
        if (!termo) {
          q.whereRaw('1 = 0');
          return;
        }
        q.whereRaw("lower(coalesce(node_name, '')) like ?", [`%${termo}%`])
          .orWhereRaw('lower(node_id) like ?', [`%${termo}%`]);
      });
    }
    if (notified === 'pending') query.whereNull('notice_sent_at');
    else if (notified === 'sent') query.whereNotNull('notice_sent_at');

    const rows = await query.orderBy('started_at', 'desc').limit(LIST_LIMIT);
    return Promise.all(rows.map((row) => this.present(row)));
  }

  static async get(incidentId) {
    const row = await tdb('outage_incidents').where({ id: incidentId }).first();
    if (!row) throw new WaError('whatsapp.error.outageNotFound', { code: 'not_found', status: 404 });
    const afetados = await tdb('outage_incident_devices').where({ incident_id: incidentId }).orderBy('id');
    return {
      ...(await this.present(row)),
      devices: afetados.map((d) => ({
        deviceId: d.device_id,
        contract: d.contract,
        clientName: d.client_name,
        hasPhone: Boolean(d.phone_e164),
        notifiedAt: d.notified_at
      }))
    };
  }

  static async present(row) {
    const afetados = await tdb('outage_incident_devices').where({ incident_id: row.id })
      .select('phone_e164', 'notified_at');
    return {
      id: row.id,
      nodeId: row.node_id,
      nodeName: row.node_name || row.node_id,
      status: row.status,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      eta: row.eta_text,
      noticeBody: row.notice_body,
      noticeSentAt: row.notice_sent_at,
      recoverySentAt: row.recovery_sent_at,
      defaultNotice: this.textoPadrao(row, row.eta_text),
      affected: afetados.length,
      withPhone: new Set(afetados.filter((d) => d.phone_e164).map((d) => d.phone_e164)).size,
      notified: new Set(afetados.filter((d) => d.notified_at && d.phone_e164).map((d) => d.phone_e164)).size
    };
  }
}

export default OutageIncidentService;
