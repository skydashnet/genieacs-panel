import WaBotConfigService from './waBotConfigService.js';
import WaAssignmentService from './waAssignmentService.js';
import { tdb } from '../config/database.js';

/** Os períodos que a tela oferece. Qualquer outro valor vira 7. */
export const RESPONSE_TIME_PERIODS = Object.freeze([7, 30, 90]);

/** As intenções do bot que querem dizer "passe para uma pessoa". */
const PEDIDOS_DE_ATENDENTE = new Set(['atendente', 'handoff', 'tooManyAttempts']);

/** Os cortes da tela: respondidas em até 5, 15 e 60 minutos. */
const CORTES_S = Object.freeze([5 * 60, 15 * 60, 60 * 60]);

const LOTE = 500;

const ms = (valor) => (valor instanceof Date ? valor.getTime() : new Date(valor).getTime());

/** A mediana (e o p90) de uma lista já ordenada, em segundos inteiros. */
function quantil(ordenada, q) {
  if (!ordenada.length) return null;
  const pos = (ordenada.length - 1) * q;
  const baixo = Math.floor(pos);
  const alto = Math.ceil(pos);
  return Math.round(ordenada[baixo] + (ordenada[alto] - ordenada[baixo]) * (pos - baixo));
}

function resumo(esperas) {
  const ordenada = [...esperas].sort((a, b) => a - b);
  return {
    answered: ordenada.length,
    medianSeconds: quantil(ordenada, 0.5),
    p90Seconds: quantil(ordenada, 0.9),
    averageSeconds: ordenada.length ? Math.round(ordenada.reduce((t, s) => t + s, 0) / ordenada.length) : null,
    within: CORTES_S.map((corte) => ({
      seconds: corte,
      rate: ordenada.length ? ordenada.filter((s) => s <= corte).length / ordenada.length : null
    }))
  };
}

/** A hora (0–23) de um instante no fuso do provedor. */
function horaNoFuso(instante, timezone) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(instante);
  return Number(h) % 24;
}

/**
 * A linha do tempo de cada conversa de um lote, desde `desde`: mensagens do
 * cliente, do bot e de gente, e os pedidos de atendente — em ordem. E quais
 * dessas conversas estão abertas.
 */
async function linhasDoTempo(lote, desde) {
  const [mensagens, pedidos, conversas] = await Promise.all([
    tdb('wa_messages')
      .whereIn('conversation_id', lote)
      .where('created_at', '>=', desde)
      .where('is_note', false)
      .where((q) => q.where({ direction: 'in' }).orWhereIn('source', ['operator', 'bot']))
      .orderBy([{ column: 'conversation_id' }, { column: 'created_at' }, { column: 'id' }])
      .select('conversation_id', 'direction', 'source', 'sent_by', 'external_id', 'created_at'),
    tdb('wa_bot_events')
      .whereIn('conversation_id', lote)
      .where('created_at', '>=', desde)
      .whereIn('intent', [...PEDIDOS_DE_ATENDENTE])
      .select('conversation_id', 'created_at'),
    tdb('wa_conversations').whereIn('id', lote).whereNull('closed_at').select('id')
  ]);
  const linhas = new Map();
  const empurrar = (id, evento) => {
    const lista = linhas.get(id) || [];
    lista.push(evento);
    linhas.set(id, lista);
  };
  for (const m of mensagens) {
    let tipo;
    if (m.direction === 'in') tipo = 'cliente';
    else if (m.source === 'bot') tipo = 'bot';
    else if (m.sent_by || m.external_id) tipo = 'gente';
    else continue; // a resposta do operador ainda na fila, sem envio: não respondeu ninguém
    empurrar(Number(m.conversation_id), { t: ms(m.created_at), tipo, agente: m.sent_by ? Number(m.sent_by) : null });
  }
  // O pedido é gravado logo depois da resposta do bot; empatado com ela,
  // vem depois, para reabrir a espera que a resposta fechou.
  for (const p of pedidos) empurrar(Number(p.conversation_id), { t: ms(p.created_at), tipo: 'pedido', ordem: 1 });
  for (const eventos of linhas.values()) eventos.sort((a, b) => a.t - b.t || (a.ordem ?? 0) - (b.ordem ?? 0));
  return { linhas, abertas: new Set(conversas.map((c) => Number(c.id))) };
}

/** O começo da espera ainda sem resposta de gente ao fim da linha do tempo, ou null. */
export function esperaAberta(eventos) {
  let inicio = null;
  for (const e of eventos) {
    if (e.tipo === 'cliente') {
      if (inicio === null) inicio = e.t;
    } else if (e.tipo === 'bot' || e.tipo === 'gente') {
      inicio = null;
    } else if (e.tipo === 'pedido') {
      inicio = e.t;
    }
  }
  return inicio;
}

/**
 * Quanto o cliente espera por uma pessoa no WhatsApp.
 *
 * A unidade é a ESPERA: começa na primeira mensagem do cliente que ninguém
 * respondeu — ou no momento em que o bot passou a conversa para atendente — e
 * termina na primeira resposta de gente (alguém no painel, ou o eco do celular
 * do provedor). O que o bot respondeu sozinho não é espera: a resposta do bot
 * fecha a espera sem contá-la, e só um pedido de atendente a reabre.
 *
 * Com horário de atendimento configurado, o número principal conta só as
 * esperas que começaram dentro dele; as de fora aparecem à parte, porque uma
 * mensagem das 23h respondida às 8h não diz nada sobre a equipe.
 */
class WaResponseTimeService {
  static async report({ days = 7, now = new Date() } = {}) {
    const periodo = RESPONSE_TIME_PERIODS.includes(Number(days)) ? Number(days) : 7;
    const desde = new Date(now.getTime() - periodo * 24 * 60 * 60 * 1000);
    const { hours } = await WaBotConfigService.getConfig();
    const timezone = hours.timezone || 'America/Sao_Paulo';

    // As conversas com mensagem do cliente no período: é delas que se mede.
    const conversaIds = await tdb('wa_messages')
      .where({ direction: 'in' })
      .where('created_at', '>=', desde)
      .distinct('conversation_id')
      .pluck('conversation_id');

    const dentro = [];
    const fora = [];
    const porAgente = new Map();
    const porHora = Array.from({ length: 24 }, () => []);
    const esperandoAgora = [];

    const abertas = new Set();
    for (let i = 0; i < conversaIds.length; i += LOTE) {
      const lote = conversaIds.slice(i, i + LOTE);
      // eslint-disable-next-line no-await-in-loop -- lotes para não estourar o IN
      const { linhas, abertas: abertasDoLote } = await linhasDoTempo(lote, desde);
      for (const id of abertasDoLote) abertas.add(id);

      for (const [conversa, eventos] of linhas) {
        let inicio = null;
        for (const e of eventos) {
          if (e.tipo === 'cliente') {
            if (inicio === null) inicio = e.t;
          } else if (e.tipo === 'bot') {
            inicio = null;
          } else if (e.tipo === 'pedido') {
            inicio = e.t;
          } else if (e.tipo === 'gente' && inicio !== null) {
            const espera = Math.max(0, Math.round((e.t - inicio) / 1000));
            const comeco = new Date(inicio);
            // eslint-disable-next-line no-await-in-loop -- a configuração vem do cache
            const noHorario = await WaBotConfigService.withinHours(comeco);
            if (noHorario) {
              dentro.push(espera);
              porHora[horaNoFuso(comeco, timezone)].push(espera);
              const chave = e.agente ?? 0;
              const lista = porAgente.get(chave) || [];
              lista.push(espera);
              porAgente.set(chave, lista);
            } else {
              fora.push(espera);
            }
            inicio = null;
          }
        }
        if (inicio !== null && abertas.has(conversa)) esperandoAgora.push(inicio);
      }
    }

    const nomes = await WaAssignmentService.names([...porAgente.keys()].filter(Boolean));
    const principal = resumo(dentro);
    return {
      days: periodo,
      timezone,
      hoursEnabled: Boolean(hours.enabled),
      ...principal,
      outsideHours: { answered: fora.length, medianSeconds: quantil([...fora].sort((a, b) => a - b), 0.5) },
      byAgent: [...porAgente.entries()]
        .map(([userId, esperas]) => {
          const r = resumo(esperas);
          return {
            userId: userId || null,
            name: userId ? nomes.get(userId) ?? null : null,
            answered: r.answered,
            medianSeconds: r.medianSeconds
          };
        })
        .sort((a, b) => b.answered - a.answered),
      byHour: porHora.map((esperas) => {
        const ordenada = [...esperas].sort((a, b) => a - b);
        return { answered: ordenada.length, medianSeconds: quantil(ordenada, 0.5) };
      }),
      waitingNow: {
        count: esperandoAgora.length,
        oldestSince: esperandoAgora.length ? new Date(Math.min(...esperandoAgora)).toISOString() : null
      }
    };
  }

  /**
   * Quem está esperando gente agora, há pelo menos `minMinutes`: conversas
   * abertas com mensagem do cliente nos últimos 7 dias, a espera mais antiga
   * primeiro.
   */
  static async waitingNow({ now = new Date(), minMinutes = 0 } = {}) {
    const desde = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const candidatas = await tdb('wa_conversations')
      .whereNull('closed_at')
      .where('last_inbound_at', '>=', desde)
      .select('id', 'push_name', 'wa_phone_e164', 'contract', 'assigned_user_id');
    const porId = new Map(candidatas.map((c) => [Number(c.id), c]));
    const itens = [];
    const ids = [...porId.keys()];
    for (let i = 0; i < ids.length; i += LOTE) {
      // eslint-disable-next-line no-await-in-loop -- lotes para não estourar o IN
      const { linhas } = await linhasDoTempo(ids.slice(i, i + LOTE), desde);
      for (const [id, eventos] of linhas) {
        const inicio = esperaAberta(eventos);
        if (inicio === null) continue;
        const minutos = Math.floor((now.getTime() - inicio) / 60_000);
        if (minutos < minMinutes) continue;
        const c = porId.get(id);
        itens.push({
          conversationId: id,
          since: new Date(inicio).toISOString(),
          minutes: minutos,
          assignedUserId: c?.assigned_user_id ? Number(c.assigned_user_id) : null,
          contact: c?.push_name || (c?.wa_phone_e164 ? `+${c.wa_phone_e164}` : null) || c?.contract || null
        });
      }
    }
    const nomes = await WaAssignmentService.names(itens.map((x) => x.assignedUserId));
    return itens
      .map((x) => ({ ...x, assignedTo: x.assignedUserId ? nomes.get(x.assignedUserId) ?? null : null }))
      .sort((a, b) => b.minutes - a.minutes);
  }
}

export default WaResponseTimeService;
