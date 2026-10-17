import AuditLog from '../models/AuditLog.js';
import WaBotConfigService from './waBotConfigService.js';
import { tdb } from '../config/database.js';

/** Os períodos que a tela oferece. Qualquer outro valor vira 7. */
export const REPORT_PERIODS = Object.freeze([7, 30, 90]);

/** Quanto tempo depois da primeira resposta do bot um humano ainda "entrou" na conversa. */
const JANELA_HUMANO_MS = 24 * 60 * 60 * 1000;

/** Intenções que contam como "o cliente foi passado para uma pessoa". */
const PEDIDOS_DE_ATENDENTE = new Set(['atendente', 'handoff', 'tooManyAttempts']);
const FALHAS_DE_DOCUMENTO = new Set(['invalidDocument', 'documentNotFound', 'tooManyAttempts']);

const LOTE = 500;

/** `YYYY-MM-DD` e a hora (0–23) de um instante, no fuso dado. */
function partesNoFuso(instante, timezone) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instante);
  const v = (tipo) => partes.find((p) => p.type === tipo)?.value;
  return { dia: `${v('year')}-${v('month')}-${v('day')}`, hora: Number(v('hour')) };
}

/**
 * O relatório do chatbot: quanto o atendimento automático do WhatsApp
 * resolveu, e quando ele precisou de gente.
 *
 * Tudo sai de `wa_bot_events` (uma linha por resposta, com a intenção), de
 * `wa_messages` (para saber se um humano entrou depois) e da trilha (para as
 * liberações). Nada lê a frota nem o SGP.
 */
class WaBotReportService {
  static async report({ days = 7, now = new Date() } = {}) {
    const periodo = REPORT_PERIODS.includes(Number(days)) ? Number(days) : 7;
    const desde = new Date(now.getTime() - periodo * 24 * 60 * 60 * 1000);
    const { hours } = await WaBotConfigService.getConfig();
    const timezone = hours.timezone || 'America/Sao_Paulo';

    const eventos = await tdb('wa_bot_events')
      .where('created_at', '>=', desde)
      .orderBy('created_at', 'asc')
      .select('conversation_id', 'intent', 'created_at');

    const intents = {};
    const primeiraResposta = new Map();
    const porHora = Array.from({ length: 24 }, () => 0);
    const conversasPorDia = new Map();
    for (const evento of eventos) {
      intents[evento.intent] = (intents[evento.intent] || 0) + 1;
      const quando = new Date(evento.created_at);
      const conversa = evento.conversation_id;
      if (conversa !== null && conversa !== undefined && !primeiraResposta.has(conversa)) {
        primeiraResposta.set(conversa, quando.getTime());
      }
      const { dia, hora } = partesNoFuso(quando, timezone);
      if (PEDIDOS_DE_ATENDENTE.has(evento.intent)) porHora[hora] += 1;
      if (conversa !== null && conversa !== undefined) {
        const doDia = conversasPorDia.get(dia) || new Set();
        doDia.add(conversa);
        conversasPorDia.set(dia, doDia);
      }
    }

    // Um humano entrou na conversa até 24 h depois da primeira resposta do bot?
    // Os dois jeitos de ser humano são os mesmos do bot: alguém logado no
    // painel, ou o eco do telefone do próprio provedor.
    const ids = [...primeiraResposta.keys()];
    const comHumano = new Set();
    for (let i = 0; i < ids.length; i += LOTE) {
      const lote = ids.slice(i, i + LOTE);
      // eslint-disable-next-line no-await-in-loop -- lotes para não estourar o IN
      const humanas = await tdb('wa_messages')
        .whereIn('conversation_id', lote)
        .where('created_at', '>=', desde)
        .where((quem) => {
          quem.whereNotNull('sent_by')
            .orWhere((eco) => eco.where({ direction: 'out', source: 'operator' }).whereNotNull('external_id'));
        })
        .select('conversation_id', 'created_at');
      for (const msg of humanas) {
        const inicio = primeiraResposta.get(msg.conversation_id);
        const quando = new Date(msg.created_at).getTime();
        if (inicio !== undefined && quando >= inicio && quando - inicio <= JANELA_HUMANO_MS) {
          comHumano.add(msg.conversation_id);
        }
      }
    }

    const liberacoes = await tdb('audit_log')
      .where({ action: AuditLog.ACTIONS.WHATSAPP_BOT_TRUST_UNLOCK })
      .where('created_at', '>=', desde)
      .pluck('id');

    const conversas = ids.length;
    const resolvidas = conversas - comHumano.size;
    const soma = (lista) => lista.reduce((total, chave) => total + (intents[chave] || 0), 0);

    const serie = [];
    for (let d = periodo - 1; d >= 0; d -= 1) {
      const { dia } = partesNoFuso(new Date(now.getTime() - d * 24 * 60 * 60 * 1000), timezone);
      serie.push({ day: dia, conversations: conversasPorDia.get(dia)?.size || 0 });
    }

    return {
      days: periodo,
      timezone,
      replies: eventos.length,
      conversations: conversas,
      resolvedWithoutHuman: resolvidas,
      resolvedRate: conversas ? resolvidas / conversas : null,
      invoicesSent: intents.fatura || 0,
      noOpenInvoice: intents.noOpenInvoice || 0,
      signalChecks: intents.sinal || 0,
      outagesInformed: intents.outage || 0,
      unlocks: liberacoes.length,
      identified: intents.identified || 0,
      documentFailures: soma([...FALHAS_DE_DOCUMENTO]),
      humanRequests: soma([...PEDIDOS_DE_ATENDENTE]),
      humanRequestsByHour: porHora,
      daily: serie,
      intents
    };
  }
}

export default WaBotReportService;
