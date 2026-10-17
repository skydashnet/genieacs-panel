import WaMetaTemplateService from './waMetaTemplateService.js';
import MappingEdge from '../models/MappingEdge.js';
import MappingNode from '../models/MappingNode.js';
import SgpLink from '../models/SgpLink.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import AuditLog from '../models/AuditLog.js';
import DeviceService from './deviceService.js';
import WaBotConfigService from './waBotConfigService.js';
import WaSendService from './waSendService.js';
import { WaError } from './whatsappConfigService.js';
import { MAINTENANCE_TYPES, clientsBeneath } from './outageDetector.js';
import { tdb, tinsert, tinsertReturningId } from '../config/database.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

const t = (chave, vars) => translate(DEFAULT_LOCALE, chave, vars);

const HORA_MS = 60 * 60 * 1000;
/** A janela mais longa que se agenda: mais que isso é obra, não manutenção. */
export const MAX_DURATION_MS = 24 * HORA_MS;
/** Antecedência do aviso, em horas. */
export const LEAD_HOURS = Object.freeze({ min: 1, max: 72, default: 24 });
/** Quanto tempo uma manutenção encerrada continua na lista. */
const RECENTES_MS = 72 * HORA_MS;
/** Folga para o relógio do navegador: um início "agora" não é recusado. */
const FOLGA_MS = 5 * 60 * 1000;

/** O número que fala com o assinante: o do atendimento, e na falta o padrão. */
async function contaDeEnvio() {
  return WhatsAppAccount.getForPurpose('support');
}

/** Sequencial de propósito — ver `enfileirar` em `outageIncidentService.js`. */
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
  const metaTemplate = await WaMetaTemplateService.noticePayload('maintenance', body);
  await WaSendService.enqueue({ conversationId: conversation.id, body, userId: null, source: 'alert', metaTemplate });
}

function erro(chave, status = 400, code = 'maintenance_invalid') {
  return new WaError(chave, { code, status });
}

/** ISO de qualquer coisa que o banco devolva como data (o SQLite devolve número). */
function iso(valor) {
  if (valor === null || valor === undefined) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function data(valor) {
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Manutenção programada: uma janela em que o provedor para um nó do mapa de
 * propósito, e tudo o que isso muda para o cliente.
 *
 * - O aviso sai sozinho `lead_minutes` antes do início (ou pelo "Avisar agora").
 * - Durante a janela, o alerta de queda e o histórico de rompimentos não
 *   contam as ONTs embaixo do nó, e o bot responde "manutenção" a quem
 *   pergunta por que está sem internet.
 * - No fim (ou no "Concluir"), quem foi avisado recebe o "concluída"; num
 *   cancelamento depois do aviso, recebe o "cancelada".
 *
 * Tudo que é automático passa por `processDue`, chamado pelo agendador a cada
 * minuto, e é idempotente pelos marcadores gravados na própria janela.
 */
class MaintenanceService {
  /** Data e hora no fuso do horário de atendimento, que é o do provedor. */
  static async formatador() {
    let timezone = 'America/Sao_Paulo';
    try {
      const { hours } = await WaBotConfigService.getConfig();
      if (hours?.timezone) timezone = hours.timezone;
    } catch {
      // Sem configuração do bot, vale o fuso padrão.
    }
    const dia = new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone: timezone, day: '2-digit', month: '2-digit' });
    const hora = new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return {
      quando: (d) => t('whatsapp.maintenance.at', { day: dia.format(d), time: hora.format(d) }),
      hora: (d) => hora.format(d),
      mesmoDia: (a, b) => dia.format(a) === dia.format(b)
    };
  }

  /** Os textos que vão ao cliente, prontos para uma janela. */
  static async textos(janela) {
    const f = await this.formatador();
    const inicio = new Date(janela.starts_at);
    const fim = new Date(janela.ends_at);
    const node = janela.node_name || janela.node_id;
    const start = f.quando(inicio);
    const end = f.mesmoDia(inicio, fim) ? f.hora(fim) : f.quando(fim);
    return {
      notice: t('whatsapp.maintenance.notice', { node, start, end }),
      done: t('whatsapp.maintenance.done'),
      cancelled: t('whatsapp.maintenance.cancelled', { start }),
      bot: t('whatsapp.bot.maintenance', { node, end: f.quando(fim) })
    };
  }

  /** O nó do mapa, conferido: tem de existir e ser de um tipo que agrupa clientes. */
  static async no(nodeId) {
    const nodes = await MappingNode.getAll();
    const node = nodes.find((n) => String(n.node_id) === String(nodeId ?? ''));
    if (!node || !MAINTENANCE_TYPES.includes(node.type)) throw erro('whatsapp.error.maintenanceBadNode');
    return { node, nodes };
  }

  /**
   * Os aparelhos embaixo do nó: as ONTs do mapa pela árvore, e delas os
   * aparelhos pelo PPPoE. O ACS é a fonte principal; o vínculo do SGP (que
   * tem o login) cobre um ACS fora do ar e é de onde vem o telefone.
   */
  static async aparelhosDoNo(nodeId, { nodes = null } = {}) {
    const todos = nodes ?? await MappingNode.getAll();
    const edges = await MappingEdge.getAll();
    const logins = new Set(clientsBeneath(nodeId, todos, edges)
      .map((n) => String(n.pppoe ?? '').trim().toLowerCase())
      .filter(Boolean));
    if (logins.size === 0) return [];
    const ids = new Set();
    try {
      for (const item of await DeviceService.getCustomerIdentityDevices()) {
        const login = String(item?.pppoe ?? '').trim().toLowerCase();
        if (item?._id && logins.has(login)) ids.add(String(item._id));
      }
    } catch (error) {
      console.warn(`maintenance: ACS indisponível, só pelo SGP: ${error?.message || error}`);
    }
    const vinculos = await tdb('sgp_links').whereNotNull('login').select('device_id', 'login');
    for (const v of vinculos) {
      if (v.device_id && logins.has(String(v.login).trim().toLowerCase())) ids.add(String(v.device_id));
    }
    return [...ids];
  }

  /** Grava os aparelhos que ainda não estão na janela, com o telefone de agora. */
  static async acrescentar(windowId, deviceIds) {
    const ja = new Set(await tdb('maintenance_window_devices').where({ window_id: windowId }).pluck('device_id'));
    const novos = deviceIds.map(String).filter((id) => id && !ja.has(id));
    if (novos.length === 0) return 0;
    const links = await SgpLink.getByDeviceIds(novos);
    const linkPor = new Map(links.map((link) => [String(link.device_id), link]));
    for (const deviceId of novos) {
      const link = linkPor.get(deviceId);
      // eslint-disable-next-line no-await-in-loop -- o índice único segura repetição
      await tinsert('maintenance_window_devices', {
        window_id: windowId,
        device_id: deviceId,
        contract: link?.contract ?? null,
        client_name: link?.client_name ?? null,
        phone_e164: normalizarTelefoneBr(link?.phone_manual) || normalizarTelefoneBr(link?.phone_e164) || null,
        created_at: new Date()
      });
    }
    return novos.length;
  }

  /**
   * Os nós que podem entrar em manutenção, para o formulário. Aqui e não pela
   * rota do mapa: quem agenda precisa de `whatsapp.send`, não de `map.read`.
   */
  static async nodes() {
    return (await MappingNode.getAll())
      .filter((n) => MAINTENANCE_TYPES.includes(n.type))
      .map((n) => ({ nodeId: n.node_id, name: n.name || n.node_id, type: n.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Quantos serão atingidos, para o formulário mostrar antes de agendar. */
  static async preview(nodeId, { startsAt = null, endsAt = null } = {}) {
    const { node, nodes } = await this.no(nodeId);
    const ids = await this.aparelhosDoNo(node.node_id, { nodes });
    const links = ids.length ? await SgpLink.getByDeviceIds(ids) : [];
    const telefones = new Set(links
      .map((l) => normalizarTelefoneBr(l.phone_manual) || normalizarTelefoneBr(l.phone_e164))
      .filter(Boolean));
    // O exemplo usa o horário do formulário quando vem; senão, amanhã.
    const inicio = data(startsAt) ?? new Date(Date.now() + 24 * HORA_MS);
    const fim = data(endsAt) ?? new Date(inicio.getTime() + 2 * HORA_MS);
    const exemplo = await this.textos({ node_id: node.node_id, node_name: node.name, starts_at: inicio, ends_at: fim });
    return { nodeId: node.node_id, nodeName: node.name || node.node_id, nodeType: node.type, affected: ids.length, withPhone: telefones.size, sampleNotice: exemplo.notice };
  }

  /** Confere horário e antecedência; devolve os valores normalizados. */
  static validarJanela({ startsAt, endsAt, leadHours }, { now = Date.now(), exigirFuturo = true } = {}) {
    const inicio = data(startsAt);
    const fim = data(endsAt);
    if (!inicio || !fim || fim <= inicio) throw erro('whatsapp.error.maintenanceBadWindow');
    if (fim - inicio > MAX_DURATION_MS) throw erro('whatsapp.error.maintenanceTooLong');
    if (exigirFuturo && inicio.getTime() < now - FOLGA_MS) throw erro('whatsapp.error.maintenanceInPast');
    const horas = leadHours === undefined || leadHours === null || leadHours === ''
      ? LEAD_HOURS.default
      : Number(leadHours);
    if (!Number.isFinite(horas) || horas < LEAD_HOURS.min || horas > LEAD_HOURS.max) {
      throw erro('whatsapp.error.maintenanceBadLead');
    }
    return { inicio, fim, leadMinutes: Math.round(horas * 60) };
  }

  static async create({ nodeId, startsAt, endsAt, leadHours, message }, { userId = null, req = null } = {}) {
    const { node, nodes } = await this.no(nodeId);
    const { inicio, fim, leadMinutes } = this.validarJanela({ startsAt, endsAt, leadHours });
    const agora = new Date();
    const id = await tinsertReturningId('maintenance_windows', {
      node_id: node.node_id,
      node_name: node.name || node.node_id,
      node_type: node.type,
      starts_at: inicio,
      ends_at: fim,
      lead_minutes: leadMinutes,
      message: String(message ?? '').trim().slice(0, 1000) || null,
      status: 'scheduled',
      created_by: userId,
      created_at: agora,
      updated_at: agora
    });
    await this.acrescentar(id, await this.aparelhosDoNo(node.node_id, { nodes }));
    await this.auditar(req, userId, AuditLog.ACTIONS.MAINTENANCE_SCHEDULED, id, {
      node: node.name || node.node_id,
      startsAt: inicio.toISOString(),
      endsAt: fim.toISOString()
    });
    // Um agendamento em cima da hora já está dentro da antecedência: avisa agora.
    await this.processDue({ now: agora.getTime(), only: id });
    return this.get(id);
  }

  /** Muda horário, antecedência ou texto — só antes do aviso sair. */
  static async update(id, { startsAt, endsAt, leadHours, message }) {
    const janela = await this.carregar(id);
    if (janela.status !== 'scheduled' || janela.notice_sent_at) {
      throw erro('whatsapp.error.maintenanceLocked', 409, 'maintenance_locked');
    }
    const { inicio, fim, leadMinutes } = this.validarJanela({
      startsAt: startsAt ?? janela.starts_at,
      endsAt: endsAt ?? janela.ends_at,
      leadHours: leadHours ?? janela.lead_minutes / 60
    });
    await tdb('maintenance_windows').where({ id }).update({
      starts_at: inicio,
      ends_at: fim,
      lead_minutes: leadMinutes,
      message: message === undefined ? janela.message : (String(message ?? '').trim().slice(0, 1000) || null),
      updated_at: new Date()
    });
    await this.processDue({ now: Date.now(), only: id });
    return this.get(id);
  }

  static async carregar(id) {
    const janela = await tdb('maintenance_windows').where({ id }).first();
    if (!janela) throw erro('whatsapp.error.maintenanceNotFound', 404, 'not_found');
    return janela;
  }

  /**
   * Manda `texto` uma vez por telefone às linhas dadas, pulando opt-out.
   * Devolve os telefones que receberam.
   */
  static async enviar(linhas, texto, rotulo) {
    const account = await contaDeEnvio();
    if (!account) return { enviados: [], pulados: 0, semConta: true };
    const telefones = [...new Set(linhas.map((row) => row.phone_e164).filter(Boolean))];
    const optOut = await WaOptOut.activePhones(telefones, 'service');
    const enviados = [];
    let pulados = 0;
    for (const phone of telefones) {
      if (optOut.has(phone)) {
        pulados += 1;
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- ver `enfileirar`
        await enfileirar(account, phone, texto);
        enviados.push(phone);
      } catch (error) {
        console.warn(`maintenance ${rotulo}:`, error?.message || error);
      }
    }
    return { enviados, pulados, semConta: false };
  }

  /**
   * O aviso aos clientes: o automático e o "Avisar agora". Antes de mandar,
   * relê a árvore — quem entrou no nó depois do agendamento também é avisado.
   */
  static async notify(id, { userId = null, req = null, automatico = false } = {}) {
    const janela = await this.carregar(id);
    if (!['scheduled', 'active'].includes(janela.status)) {
      throw erro('whatsapp.error.maintenanceClosed', 409, 'maintenance_closed');
    }
    if (!(await contaDeEnvio())) throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
    try {
      await this.acrescentar(id, await this.aparelhosDoNo(janela.node_id));
    } catch (error) {
      // O mapa mudou (nó apagado): avisa quem já estava na lista.
      console.warn(`maintenance ${id} refresh:`, error?.message || error);
    }
    const pendentes = await tdb('maintenance_window_devices')
      .where({ window_id: id })
      .whereNull('notified_at')
      .whereNotNull('phone_e164');
    const texto = janela.message || (await this.textos(janela)).notice;
    const { enviados, pulados } = await this.enviar(pendentes, texto, `notify ${id}`);
    const agora = new Date();
    if (enviados.length) {
      await tdb('maintenance_window_devices')
        .where({ window_id: id })
        .whereIn('phone_e164', enviados)
        .update({ notified_at: agora });
    }
    await tdb('maintenance_windows').where({ id }).update({ notice_sent_at: janela.notice_sent_at ?? agora, updated_at: agora });
    await this.auditar(req, userId, AuditLog.ACTIONS.MAINTENANCE_NOTIFIED, id, {
      node: janela.node_name || janela.node_id,
      sent: enviados.length,
      skippedOptOut: pulados,
      automatic: automatico
    });
    return { sent: enviados.length, skippedOptOut: pulados };
  }

  /** Mensagem de fechamento a quem foi avisado, uma vez por janela. */
  static async fechar(janela, status, textoChave) {
    const agora = new Date();
    const atualizou = await tdb('maintenance_windows')
      .where({ id: janela.id })
      .whereIn('status', ['scheduled', 'active'])
      .update({ status, finished_at: agora, updated_at: agora });
    // Outra passada (ou outro clique) já fechou: não manda de novo.
    if (!atualizou) return;
    if (!janela.notice_sent_at) return;
    const avisados = await tdb('maintenance_window_devices')
      .where({ window_id: janela.id })
      .whereNotNull('notified_at')
      .whereNotNull('phone_e164');
    if (avisados.length === 0) return;
    const textos = await this.textos(janela);
    const { semConta } = await this.enviar(avisados, textos[textoChave], `${status} ${janela.id}`);
    if (!semConta) await tdb('maintenance_windows').where({ id: janela.id }).update({ closing_sent_at: new Date() });
  }

  static async cancel(id, { userId = null, req = null } = {}) {
    const janela = await this.carregar(id);
    if (!['scheduled', 'active'].includes(janela.status)) {
      throw erro('whatsapp.error.maintenanceClosed', 409, 'maintenance_closed');
    }
    await this.fechar(janela, 'cancelled', 'cancelled');
    await this.auditar(req, userId, AuditLog.ACTIONS.MAINTENANCE_CANCELLED, id, { node: janela.node_name || janela.node_id });
    return this.get(id);
  }

  /** Terminou antes do previsto: fecha agora, com o "concluída". */
  static async conclude(id) {
    const janela = await this.carregar(id);
    if (!['scheduled', 'active'].includes(janela.status)) {
      throw erro('whatsapp.error.maintenanceClosed', 409, 'maintenance_closed');
    }
    if (new Date(janela.starts_at).getTime() > Date.now()) {
      throw erro('whatsapp.error.maintenanceNotStarted', 409, 'maintenance_not_started');
    }
    await this.fechar(janela, 'done', 'done');
    return this.get(id);
  }

  /**
   * A passada do agendador. Idempotente: cada passo tem o seu marcador.
   * `only` restringe a uma janela (usado logo depois de agendar ou editar).
   */
  static async processDue({ now = Date.now(), only = null } = {}) {
    const q = tdb('maintenance_windows').whereIn('status', ['scheduled', 'active']);
    if (only) q.where({ id: only });
    const janelas = await q.orderBy('starts_at');
    for (const janela of janelas) {
      const inicio = new Date(janela.starts_at).getTime();
      const fim = new Date(janela.ends_at).getTime();
      try {
        if (now >= fim) {
          // eslint-disable-next-line no-await-in-loop -- poucas janelas por provedor
          await this.fechar(janela, 'done', 'done');
          continue;
        }
        if (!janela.notice_sent_at && now >= inicio - janela.lead_minutes * 60_000) {
          // eslint-disable-next-line no-await-in-loop
          if (await contaDeEnvio()) await this.notify(janela.id, { automatico: true });
        }
        if (janela.status === 'scheduled' && now >= inicio) {
          // eslint-disable-next-line no-await-in-loop
          await tdb('maintenance_windows').where({ id: janela.id, status: 'scheduled' })
            .update({ status: 'active', updated_at: new Date(now) });
        }
      } catch (error) {
        console.warn(`maintenance ${janela.id} due:`, error?.message || error);
      }
    }
  }

  /**
   * As janelas em andamento agora, pelo relógio e não pelo status: o
   * agendador pode estar um minuto atrás, e o alerta não pode disparar nesse
   * minuto.
   */
  static async emAndamento(now = Date.now()) {
    const agora = new Date(now);
    return tdb('maintenance_windows')
      .whereIn('status', ['scheduled', 'active'])
      .where('starts_at', '<=', agora)
      .where('ends_at', '>', agora);
  }

  /**
   * O que está em manutenção agora, para o alerta e para o mapa:
   * `deviceIds` (os aparelhos gravados nas janelas), `ontNodeIds` (as ONTs
   * do mapa embaixo dos nós) e `nodeIds` (os nós agregadores em manutenção,
   * incluindo as caixas abaixo deles).
   */
  static async activeScope({ now = Date.now() } = {}) {
    const vazio = { deviceIds: new Set(), ontNodeIds: new Set(), nodeIds: new Set() };
    const janelas = await this.emAndamento(now);
    if (janelas.length === 0) return vazio;
    const ids = janelas.map((j) => j.id);
    const deviceIds = new Set((await tdb('maintenance_window_devices').whereIn('window_id', ids).pluck('device_id')).map(String));
    const nodes = await MappingNode.getAll();
    const edges = await MappingEdge.getAll();
    const ontNodeIds = new Set();
    const nodeIds = new Set();
    const nodeById = new Map(nodes.map((n) => [n.node_id, n]));
    for (const janela of janelas) {
      nodeIds.add(janela.node_id);
      for (const ont of clientsBeneath(janela.node_id, nodes, edges)) ontNodeIds.add(ont.node_id);
    }
    // As caixas abaixo do nó também ficam quietas: uma janela na ODC agrupa
    // as quedas pelas ODPs, e é pela ODP que o alerta dispararia.
    for (const edge of edges) {
      for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        if (ontNodeIds.has(a) && nodeById.get(b) && MAINTENANCE_TYPES.includes(nodeById.get(b).type)) nodeIds.add(b);
      }
    }
    return { deviceIds, ontNodeIds, nodeIds };
  }

  /** O bot pergunta: este aparelho está numa manutenção em andamento? */
  static async activeForDevice(deviceId) {
    if (!deviceId) return null;
    const janelas = await this.emAndamento();
    if (janelas.length === 0) return null;
    const afetado = await tdb('maintenance_window_devices')
      .whereIn('window_id', janelas.map((j) => j.id))
      .where({ device_id: String(deviceId) })
      .first();
    if (!afetado) return null;
    const janela = janelas.find((j) => j.id === afetado.window_id);
    return janela ? { ...janela, affected_id: afetado.id } : null;
  }

  /** Quem perguntou ao bot já sabe: recebe o "concluída" no fim. */
  static async markAsked(affectedId, phone) {
    const linha = await tdb('maintenance_window_devices').where({ id: affectedId }).first();
    if (!linha) return;
    const patch = {};
    if (!linha.notified_at) patch.notified_at = new Date();
    const telefone = normalizarTelefoneBr(phone);
    if (!linha.phone_e164 && telefone) patch.phone_e164 = telefone;
    if (Object.keys(patch).length) await tdb('maintenance_window_devices').where({ id: affectedId }).update(patch);
    // Sem aviso em massa, a janela passa a ter quem ouvir o "concluída".
    await tdb('maintenance_windows').where({ id: linha.window_id }).whereNull('notice_sent_at')
      .update({ notice_sent_at: new Date() });
  }

  /** Agendadas, em andamento e as encerradas nos últimos 3 dias. */
  static async list({ now = Date.now() } = {}) {
    const desde = new Date(now - RECENTES_MS);
    const rows = await tdb('maintenance_windows')
      .where((q) => q.whereIn('status', ['scheduled', 'active']).orWhere('finished_at', '>=', desde))
      .orderBy('starts_at', 'asc');
    return Promise.all(rows.map((row) => this.present(row)));
  }

  static async get(id) {
    const row = await this.carregar(id);
    const afetados = await tdb('maintenance_window_devices').where({ window_id: id }).orderBy('id');
    return {
      ...(await this.present(row)),
      devices: afetados.map((d) => ({
        deviceId: d.device_id,
        contract: d.contract,
        clientName: d.client_name,
        hasPhone: Boolean(d.phone_e164),
        notifiedAt: iso(d.notified_at)
      }))
    };
  }

  static async present(row) {
    const afetados = await tdb('maintenance_window_devices').where({ window_id: row.id })
      .select('phone_e164', 'notified_at');
    const agora = Date.now();
    const andamento = ['scheduled', 'active'].includes(row.status)
      && new Date(row.starts_at).getTime() <= agora && new Date(row.ends_at).getTime() > agora;
    return {
      id: row.id,
      nodeId: row.node_id,
      nodeName: row.node_name || row.node_id,
      nodeType: row.node_type,
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      leadHours: row.lead_minutes / 60,
      noticeAt: new Date(new Date(row.starts_at).getTime() - row.lead_minutes * 60_000).toISOString(),
      message: row.message,
      // `active` pelo relógio: a tela não espera o agendador virar o status.
      status: andamento ? 'active' : row.status,
      noticeSentAt: iso(row.notice_sent_at),
      closingSentAt: iso(row.closing_sent_at),
      finishedAt: iso(row.finished_at),
      defaultNotice: (await this.textos(row)).notice,
      affected: afetados.length,
      withPhone: new Set(afetados.filter((d) => d.phone_e164).map((d) => d.phone_e164)).size,
      notified: new Set(afetados.filter((d) => d.notified_at && d.phone_e164).map((d) => d.phone_e164)).size
    };
  }

  static async auditar(req, userId, action, id, detail) {
    const entrada = { action, subjectType: 'maintenance', subjectId: id, detail };
    if (req) await AuditLog.fromRequest(req, entrada);
    else await AuditLog.record({ ...entrada, actorUserId: userId ?? null, actorUsername: null });
  }
}

export default MaintenanceService;
