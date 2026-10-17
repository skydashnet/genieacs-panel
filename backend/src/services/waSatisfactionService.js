import WaOptOut from '../models/WaOptOut.js';
import WaBotConfigService from './waBotConfigService.js';
import WaSendService from './waSendService.js';
import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

/** Os períodos que a tela oferece. Qualquer outro valor vira 30. */
export const SATISFACTION_PERIODS = Object.freeze([7, 30, 90]);

/**
 * Quanto tempo a pergunta (e depois o pedido de comentário) espera resposta.
 * Um "5" que chega dois dias depois é mais provável que seja outra conversa
 * começando do que a nota de ontem.
 */
const JANELA_MS = 24 * 60 * 60 * 1000;

/** Até esta nota o cliente é convidado a dizer o que faltou. */
const NOTA_PEDE_COMENTARIO = 3;
const COMENTARIO_MAX = 1000;
const COMENTARIOS_NO_RELATORIO = 20;

/**
 * A nota numa resposta: "4", "4 estrelas", "nota 4", "⭐⭐⭐⭐", "4!". Qualquer
 * outra coisa não é nota — é o cliente puxando outro assunto, e então a
 * pesquisa sai do caminho.
 */
export function lerNota(texto) {
  const limpo = String(texto ?? '').trim().toLowerCase();
  if (!limpo) return null;
  const estrelas = [...limpo.matchAll(/⭐|★/gu)].length;
  if (estrelas >= 1 && estrelas <= 5 && limpo.replace(/⭐|★|\s/gu, '') === '') return estrelas;
  const m = limpo.match(/^(?:nota\s*)?([1-5])(?:\s*(?:estrelas?|pontos?|de 5|\/5))?\s*[.!]*$/u);
  return m ? Number(m[1]) : null;
}

/**
 * A pesquisa de satisfação do WhatsApp.
 *
 * Quando um atendente encerra uma conversa em que ele (ou outro humano)
 * escreveu, o cliente recebe "de 1 a 5, como foi o atendimento?". A resposta
 * é lida por `captureReply`, antes do bot e antes de reabrir a conversa: uma
 * nota não pode reabrir o fio que acabou de ser encerrado nem cair no menu.
 *
 * Nada aqui lança para quem chama. Encerrar a conversa e receber mensagem
 * são o caminho principal; a pesquisa é acessória.
 */
class WaSatisfactionService {
  /**
   * Chamado depois de uma conversa ser encerrada por um atendente.
   * @returns {Promise<{asked: boolean, reason?: string}>}
   */
  static async onClosed(conversation, { userId = null, now = new Date() } = {}) {
    try {
      const { satisfaction } = await WaBotConfigService.getConfig();
      if (!satisfaction?.enabled) return { asked: false, reason: 'disabled' };

      const ultima = await tdb('wa_satisfaction')
        .where({ conversation_id: conversation.id })
        .orderBy('id', 'desc')
        .first();
      // Uma pergunta ainda esperando resposta não ganha irmã.
      if (ultima && ['pending', 'comment'].includes(ultima.status)
        && now.getTime() - timestampMs(ultima.asked_at) < JANELA_MS) {
        return { asked: false, reason: 'pending' };
      }

      // Só se houve gente: uma conversa que o bot resolveu sozinho, ou um
      // aviso de cobrança arquivado, não teve atendimento para avaliar. E só
      // o que veio depois da última pesquisa — senão encerrar duas vezes o
      // mesmo atendimento pergunta duas vezes.
      const humano = await tdb('wa_messages')
        .where({ conversation_id: conversation.id, direction: 'out', source: 'operator', is_note: false })
        .modify((q) => { if (ultima) q.where('created_at', '>', ultima.asked_at); })
        .orderBy('id', 'desc')
        .first('sent_by');
      if (!humano) return { asked: false, reason: 'no_agent' };

      if (conversation.wa_phone_e164) {
        const fora = await WaOptOut.activePhones([conversation.wa_phone_e164], 'survey');
        if (fora.size) return { asked: false, reason: 'opted_out' };
      }

      await WaSendService.enqueue({
        conversationId: conversation.id,
        body: await WaBotConfigService.message('surveyQuestion'),
        source: 'bot'
      });
      await tinsertReturningId('wa_satisfaction', {
        conversation_id: conversation.id,
        agent_user_id: humano.sent_by || userId || null,
        status: 'pending',
        asked_at: now
      });
      return { asked: true };
    } catch (error) {
      console.warn(`WhatsApp satisfaction survey not sent: ${error.message}`);
      return { asked: false, reason: 'error' };
    }
  }

  /**
   * Uma mensagem do cliente numa conversa encerrada: é a resposta da pesquisa?
   *
   * `consumed` diz que a mensagem era da pesquisa e o bot não deve
   * respondê-la; `reopen` diz se ainda assim a conversa volta para a caixa —
   * o comentário de quem deu nota baixa é algo que uma pessoa precisa ler.
   *
   * @returns {Promise<{consumed: boolean, reopen: boolean}>}
   */
  static async captureReply({ conversation, text, now = new Date() }) {
    const nada = { consumed: false, reopen: true };
    try {
      const linha = await tdb('wa_satisfaction')
        .where({ conversation_id: conversation.id })
        .whereIn('status', ['pending', 'comment'])
        .orderBy('id', 'desc')
        .first();
      if (!linha) return nada;
      const desde = timestampMs(linha.status === 'comment' ? linha.answered_at : linha.asked_at);
      if (!Number.isFinite(desde) || now.getTime() - desde > JANELA_MS) return nada;

      if (linha.status === 'comment') {
        const comentario = String(text ?? '').trim().slice(0, COMENTARIO_MAX);
        if (!comentario) return nada;
        await tdb('wa_satisfaction').where({ id: linha.id }).update({ status: 'answered', comment: comentario });
        await this.reply(conversation, 'surveyThanks');
        return { consumed: true, reopen: true };
      }

      const nota = lerNota(text);
      if (nota === null) {
        // Outro assunto: a pesquisa sai do caminho e a mensagem segue o fluxo
        // de sempre (reabre, bot, atendente).
        await tdb('wa_satisfaction').where({ id: linha.id }).update({ status: 'skipped' });
        return nada;
      }
      const pedeComentario = nota <= NOTA_PEDE_COMENTARIO;
      await tdb('wa_satisfaction').where({ id: linha.id }).update({
        status: pedeComentario ? 'comment' : 'answered',
        score: nota,
        answered_at: now
      });
      await this.reply(conversation, pedeComentario ? 'surveyAskComment' : 'surveyThanks');
      return { consumed: true, reopen: false };
    } catch (error) {
      console.warn(`WhatsApp satisfaction reply not handled: ${error.message}`);
      return nada;
    }
  }

  static async reply(conversation, key) {
    try {
      await WaSendService.enqueue({
        conversationId: conversation.id,
        body: await WaBotConfigService.message(key),
        source: 'bot'
      });
    } catch (error) {
      console.warn(`WhatsApp satisfaction answer not sent: ${error.message}`);
    }
  }

  /** O relatório: nota média, distribuição, por atendente e os comentários das notas baixas. */
  static async report({ days = 30, now = new Date() } = {}) {
    const periodo = SATISFACTION_PERIODS.includes(Number(days)) ? Number(days) : 30;
    const desde = new Date(now.getTime() - periodo * 24 * 60 * 60 * 1000);
    const linhas = await tdb('wa_satisfaction')
      .where('asked_at', '>=', desde)
      .orderBy('asked_at', 'desc')
      .select('id', 'conversation_id', 'agent_user_id', 'status', 'score', 'comment', 'asked_at', 'answered_at');

    const respondidas = linhas.filter((l) => Number.isInteger(Number(l.score)) && l.score !== null);
    const distribution = [0, 0, 0, 0, 0];
    for (const l of respondidas) distribution[Number(l.score) - 1] += 1;
    const soma = respondidas.reduce((total, l) => total + Number(l.score), 0);
    const media = (lista) => (lista.length ? Math.round((lista.reduce((t, l) => t + Number(l.score), 0) / lista.length) * 10) / 10 : null);

    const agentIds = [...new Set(linhas.map((l) => l.agent_user_id).filter(Boolean))];
    const nomes = new Map(agentIds.length
      ? (await getDb()('users').whereIn('id', agentIds).select('id', 'username')).map((u) => [Number(u.id), u.username])
      : []);

    const porAgente = new Map();
    for (const l of linhas) {
      const chave = l.agent_user_id ? Number(l.agent_user_id) : 0;
      const item = porAgente.get(chave) || { asked: 0, respondidas: [] };
      item.asked += 1;
      if (l.score !== null && l.score !== undefined) item.respondidas.push(l);
      porAgente.set(chave, item);
    }
    const byAgent = [...porAgente.entries()]
      .map(([userId, item]) => ({
        userId: userId || null,
        name: userId ? nomes.get(userId) ?? null : null,
        asked: item.asked,
        answered: item.respondidas.length,
        average: media(item.respondidas)
      }))
      .sort((a, b) => b.answered - a.answered || (b.average ?? 0) - (a.average ?? 0));

    const baixas = respondidas.filter((l) => Number(l.score) <= NOTA_PEDE_COMENTARIO).slice(0, COMENTARIOS_NO_RELATORIO);
    const conversaIds = [...new Set(baixas.map((l) => l.conversation_id))];
    const conversas = new Map(conversaIds.length
      ? (await tdb('wa_conversations').whereIn('id', conversaIds).select('id', 'push_name', 'wa_phone_e164', 'contract'))
        .map((c) => [Number(c.id), c])
      : []);

    return {
      days: periodo,
      asked: linhas.length,
      answered: respondidas.length,
      responseRate: linhas.length ? respondidas.length / linhas.length : null,
      average: respondidas.length ? Math.round((soma / respondidas.length) * 10) / 10 : null,
      satisfiedRate: respondidas.length ? respondidas.filter((l) => Number(l.score) >= 4).length / respondidas.length : null,
      distribution,
      byAgent,
      lowScores: baixas.map((l) => {
        const c = conversas.get(Number(l.conversation_id));
        return {
          conversationId: Number(l.conversation_id),
          contact: c?.push_name || (c?.wa_phone_e164 ? `+${c.wa_phone_e164}` : null),
          contract: c?.contract || null,
          score: Number(l.score),
          comment: l.comment || null,
          answeredAt: l.answered_at ? new Date(timestampMs(l.answered_at)).toISOString() : null,
          agent: l.agent_user_id ? nomes.get(Number(l.agent_user_id)) ?? null : null
        };
      })
    };
  }
}

export default WaSatisfactionService;
