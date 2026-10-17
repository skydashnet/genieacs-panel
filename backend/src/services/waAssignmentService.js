import TenantUser from '../models/TenantUser.js';
import WaBotConfigService from './waBotConfigService.js';
import { WaError } from './whatsappConfigService.js';
import { roleHas } from '../config/permissions.js';
import { currentTenantId } from '../config/tenantContext.js';
import { tdb, tinsert } from '../config/database.js';

/**
 * Quanto tempo depois do último pulso da tela alguém ainda conta como online.
 * A tela manda um a cada minuto; três cobrem uma aba em segundo plano que o
 * navegador atrasou, sem deixar "disponível" quem fechou o notebook e foi
 * embora.
 */
export const ONLINE_MS = 3 * 60 * 1000;

/** As intenções do bot que querem dizer "passe para uma pessoa". */
const PEDIDOS_DE_ATENDENTE = new Set(['atendente', 'handoff', 'tooManyAttempts']);

/** Respostas do bot que não pedem gente: ele não falou porque não devia. */
const NAO_PRECISA = new Set(['opt_out_request', 'not_inbound', 'no_conversation', 'already_answered']);

const LOTE_DA_FILA = 50;

/**
 * A distribuição das conversas do WhatsApp entre os atendentes.
 *
 * Uma conversa tem no máximo um dono (`assigned_user_id`). Com a distribuição
 * automática ligada, a conversa que precisa de gente — o bot passou adiante,
 * ou não respondeu — vai para quem está disponível com MENOS conversas
 * abertas; no empate, para quem recebeu a última há mais tempo (rodízio).
 * Sem ninguém disponível, ela entra na fila (`waiting_since`) e é entregue
 * quando alguém ficar disponível.
 *
 * Assumir, transferir e responder sem dono funcionam sempre, com a automática
 * ligada ou não: são decisões de gente, e a tela é delas.
 */
class WaAssignmentService {
  /** Quem pode atender: os membros do provedor com `whatsapp.send`. */
  static async staff() {
    const membros = await TenantUser.listForTenant(currentTenantId());
    return membros.filter((m) => roleHas(m.role, 'whatsapp.send'));
  }

  /** Quantas conversas abertas cada um tem agora. */
  static async openLoad() {
    const linhas = await tdb('wa_conversations')
      .whereNull('closed_at')
      .whereNotNull('assigned_user_id')
      .groupBy('assigned_user_id')
      .select('assigned_user_id')
      .count({ n: '*' });
    return new Map(linhas.map((l) => [Number(l.assigned_user_id), Number(l.n)]));
  }

  /**
   * A equipe com disponibilidade e carga — o que a tela mostra no seletor de
   * transferência e no interruptor "Disponível".
   */
  static async listAgents({ now = Date.now() } = {}) {
    const [equipe, estados, carga] = await Promise.all([
      this.staff(),
      tdb('wa_agents').select('user_id', 'available', 'last_seen_at'),
      this.openLoad()
    ]);
    const porUsuario = new Map(estados.map((e) => [Number(e.user_id), e]));
    return equipe.map((m) => {
      const estado = porUsuario.get(Number(m.id));
      const visto = estado?.last_seen_at ? new Date(estado.last_seen_at).getTime() : 0;
      return {
        userId: Number(m.id),
        name: m.username,
        available: Boolean(estado?.available),
        online: Boolean(estado?.available) && now - visto < ONLINE_MS,
        openConversations: carga.get(Number(m.id)) ?? 0
      };
    });
  }

  /**
   * O interruptor e o pulso da tela, numa chamada só. Ficar disponível (ou
   * continuar) também esvazia a fila: quem chega pega o que esperava.
   */
  static async setAvailability(userId, available, { now = new Date() } = {}) {
    const atual = await tdb('wa_agents').where({ user_id: userId }).first();
    const patch = { available: available === true, last_seen_at: now, updated_at: now };
    if (atual) await tdb('wa_agents').where({ id: atual.id }).update(patch);
    else await tinsert('wa_agents', { ...patch, user_id: userId });
    if (patch.available) await this.drainQueue({ now });
    return this.agentStatus(userId, { now: now.getTime() });
  }

  static async agentStatus(userId, { now = Date.now() } = {}) {
    const agentes = await this.listAgents({ now });
    return agentes.find((a) => a.userId === Number(userId))
      ?? { userId: Number(userId), name: null, available: false, online: false, openConversations: 0 };
  }

  /** Quem recebe a próxima: online, menos conversas abertas, rodízio no empate. */
  static async pickAgent({ now = Date.now(), prefer = null } = {}) {
    const agentes = (await this.listAgents({ now })).filter((a) => a.online);
    if (!agentes.length) return null;
    // Quem já atendia este cliente continua, se estiver aí: o cliente não
    // precisa se apresentar de novo para outra pessoa.
    if (prefer && agentes.some((a) => a.userId === Number(prefer))) return Number(prefer);
    const ultimos = new Map((await tdb('wa_agents').select('user_id', 'last_assigned_at'))
      .map((e) => [Number(e.user_id), e.last_assigned_at ? new Date(e.last_assigned_at).getTime() : 0]));
    agentes.sort((a, b) => a.openConversations - b.openConversations
      || (ultimos.get(a.userId) ?? 0) - (ultimos.get(b.userId) ?? 0)
      || a.userId - b.userId);
    return agentes[0].userId;
  }

  /** Grava o dono. `userId` nulo devolve a conversa para "sem atendente". */
  static async assign(conversationId, userId, { now = new Date() } = {}) {
    const patch = userId
      ? { assigned_user_id: userId, assigned_at: now, waiting_since: null, updated_at: now }
      : { assigned_user_id: null, assigned_at: null, updated_at: now };
    await tdb('wa_conversations').where({ id: conversationId }).update(patch);
    if (userId) {
      await tdb('wa_agents').where({ user_id: userId }).update({ last_assigned_at: now });
    }
  }

  /**
   * Assumir ou transferir, pela tela. O destino tem que ser alguém do provedor
   * que pode responder no WhatsApp — transferir para quem não vê a caixa de
   * entrada é esconder a conversa.
   */
  static async transfer(conversation, userId) {
    if (userId === null || userId === undefined || userId === '') {
      await this.assign(conversation.id, null);
      return;
    }
    const alvo = Number(userId);
    const equipe = await this.staff();
    if (!Number.isInteger(alvo) || !equipe.some((m) => Number(m.id) === alvo)) {
      throw new WaError('whatsapp.error.invalidAssignee', { code: 'invalid_assignee', status: 400 });
    }
    await this.assign(conversation.id, alvo);
  }

  /**
   * Depois de uma mensagem do cliente e da passagem do bot: precisa de gente?
   * Nunca lança — receber a mensagem é o caminho principal.
   */
  static async afterInbound({ conversation, botResult, now = new Date() }) {
    try {
      const { distribution } = await WaBotConfigService.getConfig();
      if (!distribution?.enabled) return { assigned: null, reason: 'disabled' };
      const atual = await tdb('wa_conversations').where({ id: conversation.id }).first();
      if (!atual || atual.closed_at) return { assigned: null, reason: 'closed' };
      if (atual.assigned_user_id) return { assigned: Number(atual.assigned_user_id), reason: 'already' };

      const passou = PEDIDOS_DE_ATENDENTE.has(botResult?.intent);
      const botResolveu = botResult?.replied === true && !passou;
      if (botResolveu) return { assigned: null, reason: 'bot' };
      if (!passou && NAO_PRECISA.has(botResult?.reason)) return { assigned: null, reason: botResult.reason };

      const agente = await this.pickAgent({ now: now.getTime() });
      if (agente) {
        await this.assign(conversation.id, agente, { now });
        return { assigned: agente, reason: 'assigned' };
      }
      if (!atual.waiting_since) {
        await tdb('wa_conversations').where({ id: conversation.id }).update({ waiting_since: now });
      }
      return { assigned: null, reason: 'queued' };
    } catch (error) {
      console.warn(`WhatsApp assignment failed: ${error.message}`);
      return { assigned: null, reason: 'error' };
    }
  }

  /** A fila, da conversa que espera há mais tempo para a mais nova. */
  static async drainQueue({ now = new Date() } = {}) {
    const { distribution } = await WaBotConfigService.getConfig();
    if (!distribution?.enabled) return 0;
    const fila = await tdb('wa_conversations')
      .whereNull('closed_at')
      .whereNull('assigned_user_id')
      .whereNotNull('waiting_since')
      .orderBy('waiting_since', 'asc')
      .limit(LOTE_DA_FILA)
      .select('id');
    let entregues = 0;
    for (const { id } of fila) {
      // eslint-disable-next-line no-await-in-loop
      const agente = await this.pickAgent({ now: now.getTime() });
      if (!agente) break;
      // eslint-disable-next-line no-await-in-loop
      await this.assign(id, agente, { now });
      entregues += 1;
    }
    return entregues;
  }

  /** Quem responde uma conversa sem dono passa a ser o dono dela. */
  static async claimOnReply(conversation, userId, { now = new Date() } = {}) {
    if (!userId || conversation.assigned_user_id) return;
    try {
      await tdb('wa_conversations')
        .where({ id: conversation.id })
        .whereNull('assigned_user_id')
        .update({ assigned_user_id: userId, assigned_at: now, waiting_since: null });
    } catch (error) {
      console.warn(`WhatsApp claim on reply failed: ${error.message}`);
    }
  }

  /** Os nomes de quem atende, para a lista e o cabeçalho da conversa. */
  static async names(userIds) {
    const ids = [...new Set(userIds.filter(Boolean).map(Number))];
    if (!ids.length) return new Map();
    const equipe = await TenantUser.listForTenant(currentTenantId());
    return new Map(equipe.filter((m) => ids.includes(Number(m.id))).map((m) => [Number(m.id), m.username]));
  }
}

export default WaAssignmentService;
