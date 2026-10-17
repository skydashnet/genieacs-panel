import AppState from '../models/AppState.js';
import WaMessage from '../models/WaMessage.js';
import WaSendService from './waSendService.js';
import WaDunningService from './waDunningService.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import { isPermanentFailure } from './waSendFailure.js';
import { forEachTenant } from '../config/tenantJobs.js';
import { currentTenantId } from '../config/tenantContext.js';
import { isUniqueViolation } from '../config/database.js';
import { esperaMaximaMs, proximaVez } from '../utils/wa/waCadencia.js';

/** How often a pass runs. Short, because a reply typed by a human is waiting. */
const TICK_INTERVAL_MS = 5_000;

/** Most messages one pass will look at, whatever the rate limit allows. */
const BATCH_LIMIT = 20;

/** The rolling window the per-minute ceiling is measured over. */
const WINDOW_MS = 60_000;

/**
 * Attempts a message gets before the outbox gives up on it.
 *
 * `WaMessage.claim()` increments the counter, so the value read after a claim
 * is the number of the attempt now under way.
 *
 * Seven, not the three this started with. Three only made sense while the
 * attempts were instantaneous: a failed row went straight back to 'queued', the
 * loop woke five seconds later, and the whole allowance burned in fifteen
 * seconds — so an Evolution restart taking twenty failed every message in the
 * queue for good. What matters is not the count but the window the count buys
 * with the backoff below, and that window has to outlast a restart.
 */
export const MAX_ATTEMPTS = 7;

/**
 * The wait after the first failed attempt, doubling from there.
 *
 * Half a minute rather than five, because a queued message may be an operator's
 * reply with a human on the other end: the first retry has to cover a server
 * that blinked without making a conversation wait for it.
 */
const BACKOFF_BASE_MS = 30_000;

/**
 * The longest single wait. Doubling with nothing to stop it reaches a day by
 * the tenth attempt, which is not a retry any more — it is a message the panel
 * quietly held onto.
 */
const BACKOFF_CAP_MS = 30 * 60_000;

/** `wa_messages.delivery_error` is 500 characters wide. */
const ERROR_LIMIT = 500;

/**
 * How long to wait before the attempt after this one.
 *
 * Exponential with a ceiling, and no jitter: the thundering herd a campaign
 * would otherwise produce is already broken up by the per-minute ceiling below,
 * which lets a fixed number of messages leave per minute no matter how many
 * came due at once. Adding randomness on top would only make the schedule
 * harder to reason about in a `delivery_error` read three days later.
 *
 * @param {number} attempts the attempt that just failed, counting from one
 */
export function retryDelayMs(attempts) {
  const step = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** (step - 1), BACKOFF_CAP_MS);
}

/**
 * Every wait a message will sit through before the outbox gives up, in order.
 *
 * Exported because the window is the decision — 30 s, 1, 2, 4, 8 and 16 minutes
 * is a little over half an hour of Evolution being down, survived — and a
 * decision measured in minutes cannot be tested by waiting for it.
 */
export function retryScheduleMs(maxAttempts = MAX_ATTEMPTS) {
  const waits = [];
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) waits.push(retryDelayMs(attempt));
  return waits;
}

/**
 * The outbox worker.
 *
 * `wa_messages` IS the queue — there is no side table — so a pass is: ask for
 * the sendable ids, take one with the conditional UPDATE in `WaMessage.claim()`,
 * send it, and write the outcome back. The claim is what makes the loop safe to
 * run twice at once, which is why nothing here serialises the ticks: a second
 * pass overlapping the first is a normal event (a slow Evolution server is all
 * it takes), and the loser of a claim must simply do nothing.
 *
 * It is started from `server.js` only, never as an import side effect, so the
 * test suite never has a timer running behind it. The enabled flag is read
 * inside the tick rather than used to start and stop the timer — the same
 * choice `schedulerService.js` makes, so a Settings toggle takes effect within
 * one tick without a lifecycle to keep in sync.
 */
class WaOutboxWorker {
  static timer = null;

  /**
   * Os instantes dos envios tentados no último minuto, POR PROVEDOR.
   *
   * Era um array só, compartilhado pelo processo inteiro, enquanto o teto vem
   * de configuração POR PROVEDOR (`whatsappConfigService`). E o laço de
   * `forEachTenant` visita os provedores em série por id crescente: o de menor
   * id gastava a janela inteira e os seguintes levavam `rate_limited` sem ter
   * enviado uma única mensagem. Isolamento que o painel vende.
   *
   * É a mesma classe de defeito que `config/tenantCache.js` documenta como já
   * corrigida em outros serviços, e o `waBillingService` já a consertou do lado
   * dele — o comentário de lá cita ESTE teto pelo nome, como o que "ficou de
   * fora daquela passagem". Ficou até aqui.
   */
  static windows = new Map();

  /**
   * Quais provedores já tiveram a janela lida do banco NESTE processo.
   *
   * A leitura é uma por provedor por processo, e não uma por passagem: esta
   * função roda a cada cinco segundos, vezes o número de provedores, e uma
   * consulta a mais por passagem é uma consulta por provedor que ninguém pediu
   * — a mesma conta que o painel já pagou caro de aprender. Depois da primeira
   * leitura quem manda é a memória, porque é este processo que escreve cada
   * reserva.
   */
  static hydrated = new Set();

  /** Onde a janela do provedor fica entre um processo e o seguinte. */
  static WINDOW_KEY = 'wa_outbox_window';

  /**
   * O ritmo das mensagens automáticas, POR PROVEDOR: `{ proximaEm, sequencia }`.
   *
   * O teto por minuto diz quantas saem; ele não diz quando. Sem isto a passada
   * mandava as vinte do minuto coladas uma na outra — a rajada que o WhatsApp
   * lê como disparo em massa e bloqueia. Só `source='campaign'` espera por ele
   * (régua, cobrança avulsa e campanhas): resposta de atendente, do bot e
   * alerta têm alguém do outro lado e saem na hora.
   *
   * Gravado a cada avanço e lido de volta em `hydrate()`, pelo mesmo motivo da
   * janela: um deploy no meio de uma campanha não pode zerar o intervalo.
   */
  static paces = new Map();

  static PACE_KEY = 'wa_outbox_bulk_pace';

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp outbox tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Só a cópia em memória. O minuto gasto continua gravado, e a primeira
    // passagem depois de subir o lê de volta — que é a diferença entre o teto
    // valer e o teto ser um enfeite que todo deploy zera.
    this.windows.clear();
    this.paces.clear();
    this.hydrated.clear();
  }

  /**
   * One pass per active provider, each draining only its own queue.
   *
   * This was a single pass under `forSoleTenant` while `listSendable()` read
   * the whole deployment — a loop then would have sent each message once per
   * provider rather than splitting them. Now that the queue carries a provider,
   * the loop divides the work, which is what it was always meant to do.
   *
   * O teto de envio por minuto é por provedor, e agora sobrevive ao processo:
   * a janela é lida do banco na primeira passagem de cada provedor e gravada a
   * cada reserva. Antes disso ela vivia só em memória, e um deploy no meio de
   * uma campanha devolvia o minuto cheio — o teto que o painel promete seguir
   * é o que o WhatsApp impõe, e ele não reinicia junto com o nosso processo.
   *
   * Só visita quem tem mensagem vencida. A fila vazia é o estado normal de um
   * painel, e a visita a cada provedor para ouvir "nada" custava uma consulta
   * por provedor a cada cinco segundos, mais a da lista de provedores. Agora a
   * passagem ociosa é UMA consulta, com um provedor ou com cem.
   *
   * O efeito colateral é de propósito: o provedor sem nada na fila não tem
   * `skipped` a relatar, porque não foi visitado. `disabled` e `rate_limited`
   * continuam aparecendo onde importam — para quem tem mensagem esperando.
   *
   * @returns {Promise<{ sent: number, failed: number, skipped: string|null }>}
   */
  static async tick() {
    const pendentes = await WaMessage.providersWithSendable();
    const summaries = await forEachTenant(() => this.tickForTenant(), { only: pendentes });
    return summaries.reduce(
      (total, one) => ({
        sent: total.sent + one.sent,
        failed: total.failed + one.failed,
        // The first reason given, so a caller still learns why a pass did
        // nothing rather than seeing a bare pair of zeros.
        skipped: total.skipped ?? one.skipped
      }),
      { sent: 0, failed: 0, skipped: null }
    );
  }

  /**
   * One pass for the provider in scope. It NEVER throws: a single unsendable
   * message must not be able to stop the loop for every other one — nor, now,
   * for every other provider.
   */
  static async tickForTenant() {
    const summary = { sent: 0, failed: 0, skipped: null };
    try {
      const config = await WhatsAppConfigService.getConfig();
      if (!WhatsAppConfigService.isReady(config)) {
        summary.skipped = 'disabled';
        return summary;
      }

      await this.hydrate();

      const budget = this.budget(config.rateLimitPerMin);
      if (budget <= 0) {
        summary.skipped = 'rate_limited';
        return summary;
      }

      // Primeiro o que tem gente esperando: uma campanha de mil nunca fica na
      // frente da resposta de um atendente.
      const ids = await WaMessage.listSendable(Math.min(budget, BATCH_LIMIT), { bulk: false });
      for (const id of ids) {
        // Reserved before the claim rather than after it. A slot burnt on a
        // message another pass had already taken is a rounding error; a slot
        // taken after the send would let two overlapping passes both decide
        // they were under the ceiling.
        // eslint-disable-next-line no-await-in-loop -- a reserva é gravada antes do envio, e é isso que a faz valer depois de um restart
        if (!await this.reserve(config.rateLimitPerMin)) {
          summary.skipped = 'rate_limited';
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- the ceiling is per minute; a burst is the thing being prevented
        const outcome = await this.deliver(id);
        if (outcome === 'sent') summary.sent += 1;
        else if (outcome !== 'claimed_elsewhere') summary.failed += 1;
      }
      // Depois, no máximo UMA automática, e só se o ritmo já deixa. A passada
      // roda a cada cinco segundos, então o intervalo real fica entre o
      // sorteado e o sorteado mais cinco — folga a favor do número.
      if (summary.skipped !== 'rate_limited' && this.budget(config.rateLimitPerMin) > 0) {
        await this.deliverBulk(config, summary);
      }
      // Reported whether the pass ran out of budget mid-loop or was cut to the
      // budget when it asked for work: either way the minute is spent, and the
      // rest of the queue is waiting on the clock rather than on a failure.
      if (this.budget(config.rateLimitPerMin) <= 0) summary.skipped = 'rate_limited';
      return summary;
    } catch (error) {
      console.warn(`WhatsApp outbox tick failed: ${error.message}`);
      summary.skipped = 'error';
      return summary;
    }
  }

  /**
   * Uma mensagem automática, se o ritmo do provedor já deixa sair.
   *
   * O ritmo avança ANTES do envio e na mesma volta síncrona que o confere, como
   * a vaga do minuto em `reserve`: duas passadas sobrepostas não podem ambas
   * achar que a vez é delas. Se a outra passada levou a linha, a vez se perde —
   * um intervalo a mais, que é o erro para o lado seguro.
   */
  static async deliverBulk(config, summary) {
    const tenantId = currentTenantId();
    const ritmo = this.paces.get(tenantId) || { proximaEm: 0, sequencia: 0 };
    if (Date.now() < ritmo.proximaEm) return;

    const [id] = await WaMessage.listSendable(1, { bulk: true });
    if (!id) return;

    // A régua decidiu horas antes: o cliente pode ter mandado o comprovante,
    // ou o SGP dado a baixa. Retirada, a vez não se gasta — a próxima
    // passada pega a seguinte.
    if (!await WaDunningService.stillDue(id)) return;

    const atual = this.paces.get(tenantId) || { proximaEm: 0, sequencia: 0 };
    const agora = Date.now();
    if (agora < atual.proximaEm) return;
    const proximo = proximaVez({ agora, sequencia: atual.sequencia, cfg: config });
    this.paces.set(tenantId, proximo);
    try {
      await AppState.upsert(this.PACE_KEY, JSON.stringify(proximo));
    } catch (error) {
      console.warn(`WhatsApp outbox pace not stored: ${error.message}`);
    }

    if (!await this.reserve(config.rateLimitPerMin)) {
      summary.skipped = 'rate_limited';
      return;
    }
    const outcome = await this.deliver(id);
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome !== 'claimed_elsewhere') summary.failed += 1;
  }

  /**
   * Claims one message and sends it.
   *
   * @returns {Promise<'sent'|'failed'|'retry'|'claimed_elsewhere'>}
   */
  static async deliver(id) {
    const message = await WaMessage.claim(id);
    // A null claim means another pass already owns this row. That is the
    // conditional UPDATE working, not a failure: the loser does nothing and
    // says nothing.
    if (!message) return 'claimed_elsewhere';

    try {
      const { externalId, sentAs = null } = await WaSendService.dispatch(message);

      // ── Ponto de não-retorno ────────────────────────────────────────────
      // A linha acima já entregou ao Evolution: o destinatário VAI receber.
      // Daqui em diante nenhuma falha pode voltar para `recordFailure`, que
      // devolve a linha para 'queued' e faz o próximo laço mandar de novo.
      //
      // E há uma falha real esperando aqui. O painel assina `MESSAGES_UPSERT`,
      // e o Evolution ecoa a mensagem que ACABOU de sair como evento de
      // entrada; `gravarMensagem` a grava como linha 'out' com este mesmo
      // `external_id`. Entre o `dispatch` retornar e a escrita abaixo commitar
      // existe uma janela em que o eco chega primeiro e insere. Aí esta escrita
      // viola o índice único `(tenant_id, external_id)` — e, antes desta
      // guarda, o `catch` de fora lia isso como "não enviou" e reenviava.
      //
      // Violação de unicidade aqui significa exatamente o contrário de falha:
      // significa que a outra ponta já registrou o que nós mandamos.
      try {
        await WaMessage.update(message.id, {
          external_id: externalId,
          delivery_status: 'sent',
          delivery_error: null,
          sent_as: sentAs
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Rede de segurança, e não mais o caminho comum: desde que o eco ADOTA
        // esta linha em vez de inserir outra (`WaMessage.adoptEcho`), o caso
        // normal é a adoção já ter gravado ESTE mesmo `external_id` nesta mesma
        // linha — e aí a escrita acima é idempotente e nem chega aqui.
        //
        // Chega aqui o que a adoção não alcança: um eco que casou outra linha
        // (dois textos iguais em sequência), ou um `external_id` que já existe
        // por outro motivo. O `external_id` fica com quem o registrou primeiro,
        // e esta linha sai da fila pelo estado. O que NÃO pode acontecer é ela
        // continuar 'queued': `listSendable` a pegaria e o cliente receberia
        // duas vezes.
        await WaMessage.update(message.id, {
          delivery_status: 'sent',
          delivery_error: null,
          sent_as: sentAs
        });
        console.warn(
          `[wa] mensagem ${message.id}: o eco de entrada gravou ${externalId} antes `
          + 'da confirmação de saída; a linha sai da fila sem reenvio'
        );
      }
      // 'sent' is as far as the sender can see. The webhook upgrades the row to
      // delivered and read when the receipts arrive.
      return 'sent';
    } catch (error) {
      return this.recordFailure(message, error);
    }
  }

  /**
   * Writes a failed attempt back, and decides whether there will be another.
   *
   * @returns {Promise<'failed'|'retry'>}
   */
  static async recordFailure(message, error) {
    const attempts = Number(message.attempts || 0);
    // A number that is not on WhatsApp fails the same way on the seventh
    // attempt as on the first, and spending half an hour of queue on it hides
    // the verdict from the operator for half an hour. Everything the classifier
    // cannot name stays a retry — see `waSendFailure.js` for which way the
    // doubt falls, and why.
    const permanent = isPermanentFailure(error);
    const terminal = permanent || attempts >= MAX_ATTEMPTS;
    await WaMessage.update(message.id, {
      // Under the cap the row goes back to 'queued'. `listSendable` — the
      // outbox's only query — looks for 'queued' and for a stale 'sending';
      // leaving a retryable row 'failed' would put it out of the worker's reach
      // and make the whole allowance mean one attempt.
      delivery_status: terminal ? 'failed' : 'queued',
      delivery_error: failureText(error),
      // The due time is what keeps the row out of the next pass five seconds
      // from now; without it 'queued' means "immediately" and the backoff is
      // not a backoff. A terminal row goes back to NULL so that `requeue`, which
      // means "the reason is over", finds nothing left to wait for.
      next_attempt_at: terminal ? null : new Date(Date.now() + retryDelayMs(attempts))
    });
    console.warn(
      `WhatsApp message ${message.id} attempt ${attempts}/${MAX_ATTEMPTS} `
      + `failed${permanent ? ' permanently' : ''}: ${failureText(error)}`
    );
    return terminal ? 'failed' : 'retry';
  }

  // ── The per-minute ceiling ─────────────────────────────────────────
  //
  // Uma janela por PROVEDOR, e não por número conectado: o que o WhatsApp
  // reage é ao tráfego do provedor, e um limite por número multiplicaria pelo
  // tanto de números que por acaso estivessem pareados. Por provedor porque o
  // teto é configurado por provedor e porque a cota de um não é do outro.

  /** A janela do provedor em escopo, já podada. */
  static janela() {
    const tenantId = currentTenantId();
    const cutoff = Date.now() - WINDOW_MS;
    const janela = (this.windows.get(tenantId) || []).filter((at) => at > cutoff);
    // A janela podada volta para o mapa mesmo quando nada é reservado: sem
    // isso, um provedor parado manteria instantes velhos vivos para sempre.
    this.windows.set(tenantId, janela);
    return janela;
  }

  static prune() {
    this.janela();
  }

  static budget(rateLimitPerMin) {
    return Math.max(0, Number(rateLimitPerMin || 0) - this.janela().length);
  }

  /**
   * Toma uma vaga, ou diz que o minuto acabou — e GRAVA a vaga tomada.
   *
   * A gravação é por reserva, e não uma por passagem no fim do laço, porque o
   * que se perde num processo morto no meio da passagem é vaga que o WhatsApp
   * já viu. Custa um upsert de uma linha ao lado de uma chamada HTTP e de dois
   * `UPDATE`s que o envio já faz, e o teto é de 120 por minuto: o piso desse
   * custo é conhecido e pequeno.
   *
   * Falha de gravação não impede o envio. Perder a durabilidade de uma vaga é
   * o estado de ontem; recusar a mensagem por causa disso seria uma conversa
   * parada por causa da contabilidade dela.
   */
  static async reserve(rateLimitPerMin) {
    const janela = this.janela();
    if (Number(rateLimitPerMin || 0) - janela.length <= 0) return false;
    janela.push(Date.now());
    this.windows.set(currentTenantId(), janela);
    try {
      await AppState.upsert(this.WINDOW_KEY, JSON.stringify(janela));
    } catch (error) {
      console.warn(`WhatsApp outbox window not stored: ${error.message}`);
    }
    return true;
  }

  /**
   * Traz do banco o minuto que o processo anterior gastou.
   *
   * Uma vez por provedor por processo. A idade quem corta é `janela()`, que é
   * onde a janela rolante é definida — repetir o corte aqui seria a mesma regra
   * escrita em dois lugares, e é assim que duas regras iguais viram duas regras
   * diferentes. O que ESTA função corta é o que `janela()` não veria: instante
   * no FUTURO, de um relógio que andou para trás, que ficaria segurando vaga
   * até o relógio alcançá-lo.
   *
   * O que vem do banco SUBSTITUI o que estiver em memória, e não se soma a ele:
   * toda reserva é gravada, então o gravado é superconjunto do lembrado, e
   * somar contaria a mesma vaga duas vezes.
   *
   * Nunca lança. Uma janela ilegível vira janela vazia, que é exatamente o
   * comportamento de antes desta onda — o pior que ela causa é o minuto cheio
   * que o restart dava de qualquer jeito.
   */
  static async hydrate() {
    const tenantId = currentTenantId();
    if (this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);

    const agora = Date.now();
    let instantes = [];
    try {
      const bruto = await AppState.get(this.WINDOW_KEY);
      const lido = bruto ? JSON.parse(bruto) : null;
      if (Array.isArray(lido)) {
        instantes = lido
          .map((at) => Number(at))
          .filter((at) => Number.isFinite(at) && at <= agora);
      }
    } catch (error) {
      console.warn(`WhatsApp outbox window unreadable: ${error.message}`);
    }
    this.windows.set(tenantId, instantes);

    // O ritmo: um `proximaEm` além da espera mais longa possível só pode vir
    // de um relógio que andou para trás, e seguraria a fila até ele alcançar.
    let ritmo = { proximaEm: 0, sequencia: 0 };
    try {
      const bruto = await AppState.get(this.PACE_KEY);
      const lido = bruto ? JSON.parse(bruto) : null;
      const proximaEm = Number(lido?.proximaEm);
      const sequencia = Number(lido?.sequencia);
      const config = await WhatsAppConfigService.getConfig();
      if (Number.isFinite(proximaEm) && proximaEm <= agora + esperaMaximaMs(config)) {
        ritmo = { proximaEm, sequencia: Number.isFinite(sequencia) && sequencia > 0 ? sequencia : 0 };
      }
    } catch (error) {
      console.warn(`WhatsApp outbox pace unreadable: ${error.message}`);
    }
    this.paces.set(tenantId, ritmo);
  }
}

/**
 * What the operator will read in `delivery_error`.
 *
 * A `WaError`'s message is a translation key, so the machine code goes in front
 * of it and the variables after: 'http_error' plus the server's own words is
 * what tells someone whether to look at the number or at the server.
 */
function failureText(error) {
  const parts = [];
  if (error?.code) parts.push(String(error.code));
  if (error?.message) parts.push(String(error.message));
  const vars = error?.translationVars;
  if (vars && typeof vars === 'object') {
    parts.push(Object.entries(vars).map(([key, value]) => `${key}=${value}`).join(' '));
  }
  return parts.filter(Boolean).join(' | ').slice(0, ERROR_LIMIT);
}

export default WaOutboxWorker;
