import WaBroadcast, { MAX_ATTEMPTS } from '../models/WaBroadcast.js';
import { retryDelayMs } from './waOutboxWorker.js';
import { isPermanentFailure } from './waSendFailure.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { forEachTenant } from '../config/tenantJobs.js';
import WaSendService from './waSendService.js';
import WaBillingService from './waBillingService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { chaveDaFatura } from '../utils/wa/waCobranca.js';
import { tdb } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

/**
 * One pass a minute, because the campaign's budget is written per minute.
 *
 * The outbox worker ticks every five seconds — an operator's reply is waiting
 * on it. Nobody is waiting on a campaign, and pacing it by the clock is the
 * point rather than a compromise.
 */
const TICK_INTERVAL_MS = 60_000;

/**
 * How many billing recipients one flush may check against the SGP.
 *
 * Each one is an SGP round trip before the send, and the SGP is the provider's
 * production billing system. The outbox paces the sends anyway (one automatic
 * message every 20–45 s), so a smaller slice per minute costs nothing.
 */
const BILLING_CHECKS_PER_FLUSH = 10;

/** `wa_broadcast_recipients.error_msg` is 500 characters wide. */
const ERROR_LIMIT = 500;

/**
 * The states an operator may ask for, and what each one may be asked from.
 *
 * `draft` cannot jump to `paused`: pausing something that never started is not
 * a state, and allowing it would leave a campaign that looks arrested when it
 * was only ever a draft. The three terminal states accept nothing — a finished
 * or cancelled campaign is history, and restarting one would re-send to the
 * people it already reached.
 */
const TRANSITIONS = Object.freeze({
  draft: ['running', 'canceled'],
  queued: ['running', 'paused', 'canceled'],
  paused: ['running', 'canceled'],
  running: ['paused', 'canceled'],
  done: [],
  canceled: [],
  failed: []
});

/** O `meta_template` gravado no destinatário, ou null. */
function lerModeloMeta(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Running a campaign: the state machine an operator drives, and the loop that
 * feeds the outbox.
 *
 * The loop deliberately does NOT talk to the Evolution server. It renders
 * nothing and sends nothing — it hands each recipient to `WaSendService.enqueue`
 * as an ordinary outbound message, and the outbox worker despatches it under
 * the same per-minute ceiling and the same three-attempt rule as everything
 * else the panel sends. A campaign with its own transport would be a second
 * place for a message to get stuck.
 */
class WaBroadcastService {
  static timer = null;

  /** Uma passagem por vez. Ver `start()` para o motivo. */
  static ticking = false;

  static async list() {
    const rows = await WaBroadcast.list();
    return rows.map((row) => this.publicBroadcast(row));
  }

  /**
   * Start, pause or cancel.
   *
   * Starting is the only moment a connected number is required: a draft is a
   * plan, and refusing to build one because nobody had paired a phone yet would
   * throw away the operator's work for a condition they can fix in a minute.
   */
  static async setStatus(id, status) {
    const broadcast = await this.require(id);
    const target = String(status ?? '').trim();
    if (!['running', 'paused', 'canceled'].includes(target)
      || !(TRANSITIONS[broadcast.status] || []).includes(target)) {
      throw new WaError('whatsapp.error.invalidStatus', { code: 'invalid_status', status: 409 });
    }
    if (target === 'running') {
      const config = await WhatsAppConfigService.getConfig();
      if (!WhatsAppConfigService.isReady(config)) {
        throw new WaError('whatsapp.error.notConfigured', { code: 'not_configured', status: 409 });
      }
      if (!await WhatsAppAccount.getForPurpose('billing')) {
        throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
      }
    }
    return this.publicBroadcast(await WaBroadcast.update(broadcast.id, {
      status: target,
      // Stamped once, on the first start: a pause and a resume are the same
      // campaign, and moving this would lose when it actually began.
      ...(target === 'running' && !broadcast.start_at ? { start_at: new Date() } : {})
    }));
  }

  static async require(id) {
    const numeric = Number(id);
    const row = Number.isInteger(numeric) ? await WaBroadcast.getById(numeric) : null;
    if (!row) {
      throw new WaError('whatsapp.broadcast.notFound', { code: 'broadcast_not_found', status: 404 });
    }
    return row;
  }

  // ── Detail ─────────────────────────────────────────────────────────

  /**
   * Who a campaign reached, and what each person did with it.
   *
   * A campaign is at most `MAX_CAMPAIGN_RECIPIENTS` rows, so the whole of it is
   * read once and enriched in memory: the summary needs every row anyway, and
   * each join is a scoped `whereIn` in blocks rather than an aliased join
   * across two scoped tables.
   *
   * - delivered/read: the outbox's `delivery_status` on the queued message;
   * - replied: the subscriber wrote in the same thread AFTER the send;
   * - optedOut: they asked to stop AFTER the send.
   */
  static async recipients(id, { status, limit, offset } = {}) {
    const broadcast = await this.require(id);
    const rows = await tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcast.id })
      .orderBy('id')
      .select('id', 'contract', 'client_name', 'phone_e164', 'status', 'error_msg', 'message_id', 'sent_at');

    const messages = new Map();
    for (const part of blocks(rows.map((r) => r.message_id).filter(Boolean))) {
      // eslint-disable-next-line no-await-in-loop -- a few blocks at most
      const found = await tdb('wa_messages').whereIn('id', part).select('id', 'delivery_status', 'conversation_id');
      for (const m of found) messages.set(Number(m.id), m);
    }

    const lastInbound = new Map();
    const conversations = [...new Set([...messages.values()].map((m) => m.conversation_id).filter(Boolean))];
    for (const part of blocks(conversations)) {
      // eslint-disable-next-line no-await-in-loop -- idem
      const found = await tdb('wa_messages')
        .whereIn('conversation_id', part)
        .where({ direction: 'in' })
        .select('conversation_id')
        .max({ last: 'created_at' })
        .groupBy('conversation_id');
      for (const m of found) lastInbound.set(Number(m.conversation_id), timestampMs(m.last));
    }

    const lastOptOut = new Map();
    for (const part of blocks([...new Set(rows.map((r) => r.phone_e164).filter(Boolean))])) {
      // eslint-disable-next-line no-await-in-loop -- idem
      const found = await tdb('wa_opt_outs')
        .whereIn('wa_phone_e164', part)
        .select('wa_phone_e164')
        .max({ last: 'created_at' })
        .groupBy('wa_phone_e164');
      for (const o of found) lastOptOut.set(o.wa_phone_e164, timestampMs(o.last));
    }

    const items = rows.map((row) => {
      const message = row.message_id ? messages.get(Number(row.message_id)) : null;
      const sentAt = timestampMs(row.sent_at);
      const after = (when) => Number.isFinite(sentAt) && Number.isFinite(when) && when >= sentAt;
      return {
        id: row.id,
        contract: row.contract || null,
        clientName: row.client_name || null,
        phone: row.phone_e164,
        status: row.status,
        error: row.error_msg || null,
        deliveryStatus: message?.delivery_status || null,
        replied: Boolean(message) && after(lastInbound.get(Number(message.conversation_id))),
        optedOut: row.status === 'sent' && after(lastOptOut.get(row.phone_e164)),
        sentAt: this.asIso(row.sent_at)
      };
    });

    const summary = {
      total: items.length,
      pending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      replied: 0,
      optedOut: 0,
      failed: 0,
      skipped: 0,
      paid: 0
    };
    for (const item of items) {
      if (item.status === 'pending' || item.status === 'sending') summary.pending += 1;
      else if (item.status in summary) summary[item.status] += 1;
      if (item.error === 'paid') summary.paid += 1;
      if (item.deliveryStatus === 'delivered' || item.deliveryStatus === 'read') summary.delivered += 1;
      if (item.deliveryStatus === 'read') summary.read += 1;
      if (item.replied) summary.replied += 1;
      if (item.optedOut) summary.optedOut += 1;
    }

    const filtro = String(status ?? '').trim();
    const filtered = !filtro ? items
      : filtro === 'replied' ? items.filter((i) => i.replied)
        : filtro === 'pending' ? items.filter((i) => i.status === 'pending' || i.status === 'sending')
          : items.filter((i) => i.status === filtro);
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const skip = Math.max(Number(offset) || 0, 0);
    return {
      broadcast: this.publicBroadcast(broadcast),
      summary,
      items: filtered.slice(skip, skip + cap),
      total: filtered.length,
      hasMore: skip + cap < filtered.length
    };
  }

  // ── The flush loop ─────────────────────────────────────────────────

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // Uma passagem por vez, como `SchedulerService`, `WaMediaSweeper` e
      // `WaMessageSweeper` já faziam e só esta não fazia.
      //
      // Um tick percorre os provedores em série e, por campanha, até 120
      // destinatários, cada um custando várias idas ao banco. Passar de
      // sessenta segundos não é hipótese remota — bastam alguns provedores com
      // campanha aberta, ou um SQLite com um escritor só. Sem esta guarda, o
      // tick seguinte começava em cima do anterior, e dois ticks disputando o
      // mesmo destinatário é exatamente a corrida que a garra por `claimed_at`
      // passou a barrar. As duas defesas são independentes de propósito: esta
      // evita a disputa, a outra a decide quando ela acontecer mesmo assim.
      if (this.ticking) return;
      this.ticking = true;
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick()
        .catch((error) => {
          console.warn(`WhatsApp broadcast tick failed: ${error.message}`);
        })
        .finally(() => {
          this.ticking = false;
        });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A bandeira acompanha o timer: parar e recomeçar com ela presa deixaria o
    // laço mudo para sempre.
    this.ticking = false;
  }

  /**
   * One pass over every running campaign. It NEVER throws.
   *
   * A single unsendable recipient — or a single broken campaign — must not be
   * able to stop the loop for all the others.
   *
   * @returns {Promise<{ enqueued: number, skipped: number, failed: number }>}
   */
  static async tick() {
    // A pass per provider, now that `listByStatus` only returns that
    // provider's campaigns. Under `forSoleTenant` this had to be a single
    // pass: looping over a deployment-wide campaign list would have flushed
    // each campaign once per provider.
    const summaries = await forEachTenant(() => this.tickForTenant());
    return summaries.reduce(
      (total, one) => ({
        enqueued: total.enqueued + one.enqueued,
        skipped: total.skipped + one.skipped,
        failed: total.failed + one.failed
      }),
      { enqueued: 0, skipped: 0, failed: 0 }
    );
  }

  /** One pass for the provider in scope. It NEVER throws, for the same reason. */
  static async tickForTenant() {
    const summary = { enqueued: 0, skipped: 0, failed: 0 };
    try {
      const config = await WhatsAppConfigService.getConfig();
      // Read inside the tick rather than used to start and stop the timer, the
      // same choice the outbox worker makes: a Settings toggle then takes
      // effect within one pass, with no lifecycle to keep in sync.
      if (!WhatsAppConfigService.isReady(config)) return summary;

      // As agendadas cuja hora chegou começam aqui, na mesma passada: a
      // campanha marcada para as 9h vira 'running' e já entra no laço abaixo.
      await this.startScheduled();

      const running = await WaBroadcast.listByStatus('running');
      for (const broadcast of running) {
        // eslint-disable-next-line no-await-in-loop -- campaigns share the outbox's minute; running them at once would burst it
        await this.flushOne(broadcast, config, summary);
      }
      return summary;
    } catch (error) {
      console.warn(`WhatsApp broadcast tick failed: ${error.message}`);
      return summary;
    }
  }

  /**
   * Inicia as campanhas agendadas (`queued` com `scheduled_at` vencido).
   *
   * Sem número conectado, a campanha fica onde está e a próxima passada tenta
   * de novo: começar sem ter por onde enviar só gastaria as tentativas de cada
   * destinatário. Nunca lança — é chamada de dentro do tick.
   */
  static async startScheduled(now = new Date()) {
    let started = 0;
    try {
      const due = (await WaBroadcast.listByStatus('queued'))
        .filter((row) => row.scheduled_at && new Date(row.scheduled_at).getTime() <= now.getTime());
      if (due.length === 0) return 0;
      if (!await WhatsAppAccount.getForPurpose('billing')) return 0;
      for (const row of due) {
        // eslint-disable-next-line no-await-in-loop -- poucas por passada
        await WaBroadcast.update(row.id, { status: 'running', start_at: row.start_at || now });
        started += 1;
      }
    } catch (error) {
      console.warn(`WhatsApp scheduled campaigns not started: ${error.message}`);
    }
    return started;
  }

  /** One campaign's share of this minute. Never throws. */
  static async flushOne(broadcast, config, summary) {
    try {
      // Uma campanha de aviso sai pelo número escolhido ao criá-la; se ele
      // não está conectado agora, espera como qualquer outra sem número.
      const chosen = broadcast.kind === 'general' && broadcast.account_id
        ? await WhatsAppAccount.getById(broadcast.account_id)
        : null;
      const account = chosen
        ? (chosen.status === 'connected' ? chosen : null)
        : await WhatsAppAccount.getForPurpose('billing');
      // No connected number: leave the campaign in `running` and try again next
      // minute. Failing the recipients instead would burn a campaign's three
      // attempts over a number that was merely re-pairing.
      if (!account) return;

      const budget = Math.min(
        Math.max(Number(broadcast.rate_limit_per_min) || Number(config.rateLimitPerMin) || 1, 1),
        broadcast.kind === 'general' ? 120 : BILLING_CHECKS_PER_FLUSH
      );
      let vez = budget;
      // Ritmo próprio da campanha (só desacelera): quantas já deveriam ter saído
      // desde o início, menos as que saíram. Sem catch-up em rajada: no máximo
      // o que cabe num minuto naquele ritmo, e ao menos uma.
      const porHora = Number(broadcast.pace_per_hour) || 0;
      if (broadcast.kind === 'general' && porHora > 0) {
        const inicio = broadcast.start_at ? new Date(broadcast.start_at).getTime() : Date.now();
        const horas = Math.max(0, Date.now() - inicio) / 3_600_000;
        const { sent, failed } = await WaBroadcast.tally(broadcast.id);
        const devidas = Math.floor(porHora * horas) + 1 - (sent + failed);
        vez = Math.min(budget, Math.max(0, devidas), Math.max(1, Math.ceil(porHora / 60)));
      }
      const ids = vez > 0 ? await WaBroadcast.listPendingIds(broadcast.id, vez) : [];
      // Shared across this flush so only the SECOND SGP call onwards waits.
      const ritmo = { sgpCalls: 0 };
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- one at a time is what a rate limit means
        const outcome = await this.deliver(id, account, broadcast, ritmo);
        if (outcome === 'sent') summary.enqueued += 1;
        else if (outcome === 'skipped') summary.skipped += 1;
        else if (outcome === 'failed') summary.failed += 1;
      }

      const tally = await WaBroadcast.tally(broadcast.id);
      const remaining = await WaBroadcast.countUnfinished(broadcast.id);
      await WaBroadcast.update(broadcast.id, {
        sent_count: tally.sent,
        failed_count: tally.failed,
        // Every recipient reached a terminal state, so the campaign is over.
        // This is why the opt-out check lives inside `deliver` and not in the
        // pending query: a recipient filtered out of that query would never
        // leave 'pending', `remaining` would never reach zero, and the campaign
        // would sit in 'running' forever with nothing left to do.
        ...(remaining === 0 ? { status: 'done' } : {})
      });
    } catch (error) {
      console.warn(`WhatsApp broadcast ${broadcast.id} flush failed: ${error.message}`);
    }
  }

  /**
   * Claims one recipient and hands it to the outbox.
   *
   * The guards run in this order and no other: opt-out first, because a person
   * who asked not to be contacted must not have their number examined for
   * anything else; then, for a billing campaign, whether the invoice was paid
   * after the campaign was built; then whether the number is addressable at
   * all; then the send.
   *
   * @returns {Promise<'sent'|'skipped'|'failed'|'retry'|'claimed_elsewhere'>}
   */
  static async deliver(id, account, broadcast = null, ritmo = { sgpCalls: 0 }) {
    const recipient = await WaBroadcast.claimRecipient(id);
    // A null claim means another tick already owns this row. That is the
    // conditional UPDATE working, not a failure.
    if (!recipient) return 'claimed_elsewhere';

    // 1. Opt-out. Campaigns are INITIATED contact, so unlike the reply box this
    // path does enforce the list.
    // O tipo vem da campanha: cobrança é `billing`, aviso geral é `marketing`.
    // Quem bloqueou só promoção ainda recebe a fatura.
    if (await WaOptOut.isActive({ waPhone: recipient.phone_e164, category: broadcast?.kind === 'general' ? 'marketing' : 'billing' })) {
      await WaBroadcast.updateRecipient(recipient.id, {
        status: 'skipped',
        error_msg: 'opt_out'
      });
      return 'skipped';
    }

    // 1b. Paid since the build. A draft can sit for days, and charging someone
    // who has already paid is the complaint that makes a provider switch the
    // whole thing off.
    if (broadcast?.kind !== 'general' && recipient.invoice_key
      && await this.invoicePaid(recipient, ritmo)) {
      await WaBroadcast.updateRecipient(recipient.id, {
        status: 'skipped',
        error_msg: 'paid'
      });
      return 'skipped';
    }

    // 2. An address. A number that will not normalise can never be sent to, so
    // it is terminal on the first attempt rather than after three.
    const number = normalizarTelefoneBr(recipient.phone_e164);
    if (!number) {
      await WaBroadcast.updateRecipient(recipient.id, {
        status: 'failed',
        error_msg: 'no_destination'
      });
      return 'failed';
    }

    // 3. The send — which is an enqueue. The outbox owns the transport.
    try {
      const conversation = await WaConversation.ensure({
        accountId: account.id,
        // The same canonical form the inbound handler builds, so a campaign to
        // someone who has written in before lands in the thread that already
        // exists instead of opening a second one beside it.
        externalThreadId: `${number}@s.whatsapp.net`,
        waPhone: number,
        pushName: recipient.client_name || null
      });
      // Only filled when the thread does not know yet: a conversation already
      // tied to a contract by the inbound path must not be re-pointed by a
      // campaign that happens to carry a different one.
      if (recipient.contract && !conversation.contract) {
        await WaConversation.update(conversation.id, { contract: recipient.contract });
      }
      const message = await WaSendService.enqueue({
        conversationId: conversation.id,
        body: recipient.rendered_body,
        // A foto do modelo da Meta tirada na montagem; o envio decide pela
        // janela se ela é usada.
        metaTemplate: lerModeloMeta(recipient.meta_template),
        // O anexo da campanha (um só arquivo para todos). O caminho passa de
        // novo pelo confinamento de `normalizeAttachment` dentro do enqueue.
        attachment: broadcast?.attachment_path
          ? { path: broadcast.attachment_path, name: broadcast.attachment_name }
          : undefined,
        // Into the subscriber's OWN thread, which is where this mattered: with
        // no origin on the row the bot read a dunning message as one of its own
        // three replies and went quiet on the person it had just charged.
        source: 'campaign'
      });

      // ── Ponto de não-retorno ────────────────────────────────────────────
      // A linha acima já pôs a mensagem na fila; daqui em diante o assinante
      // VAI receber. Por isso a escrita de bookkeeping tem o seu próprio
      // `try`: enquanto ela dividia o `catch` de baixo, um banco que soluçasse
      // — lock timeout, `SQLITE_BUSY` — devolvia o destinatário a 'pending', o
      // tick seguinte o reenfileirava, e a mensagem já enfileirada saía do
      // mesmo jeito. O assinante recebia a mesma cobrança até sete vezes por
      // causa de uma falha que não tinha nada a ver com o envio.
      //
      // Falhar aqui não é motivo para reenviar. É motivo para registrar e
      // seguir: a linha fica em 'sending', e a retomada por `claimed_at`
      // cuidará dela daqui a cinco minutos se de fato ninguém a concluiu.
      try {
        await WaBroadcast.updateRecipient(recipient.id, {
          status: 'sent',
          message_id: message.id,
          error_msg: null,
          sent_at: new Date()
        });
      } catch (error) {
        console.error(
          `[wa] campanha: mensagem ${message.id} enfileirada e bookkeeping falhou `
          + `para o destinatário ${recipient.id}: ${error.message}`
        );
      }
      return 'sent';
    } catch (error) {
      // `claimRecipient` incremented the counter, so this is the number of the
      // attempt just made. Below the cap the row goes back to 'pending', which
      // is what `listPendingIds` looks for — leaving it 'failed' would put it
      // out of the loop's reach and make "three attempts" mean one.
      // Same two questions the outbox asks, and deliberately the same answers,
      // through the same classifier and the same curve rather than a second
      // copy of either.
      //
      // Worth being exact about what lands here, because it is NOT a send that
      // failed: this method only enqueues, and the outbox owns the transport.
      // A server that is down never reaches this catch. What does is
      // `no_account` — no number connected — or a database that hiccupped:
      // conditions an operator fixes in minutes, which is exactly why giving up
      // on them inside two was wrong.
      const permanent = isPermanentFailure(error);
      const attempts = Number(recipient.attempts || 0);
      const terminal = permanent || attempts >= MAX_ATTEMPTS;
      await WaBroadcast.updateRecipient(recipient.id, {
        status: terminal ? 'failed' : 'pending',
        error_msg: failureText(error),
        // NULL on a terminal row: there is nothing left to wait for, and a
        // leftover due time would outlive the reason it was written.
        next_attempt_at: terminal ? null : new Date(Date.now() + retryDelayMs(attempts))
      });
      return terminal ? 'failed' : 'retry';
    }
  }

  /**
   * Whether the invoice this recipient's message cites is no longer open.
   *
   * Asked the same way the build asked (open invoices only), so "gone from
   * the list" means paid or cancelled — either way, nothing to charge. An SGP
   * that does not answer lets the message go: the build already saw the
   * invoice open, and an ERP outage must not freeze every campaign.
   */
  static async invoicePaid(recipient, ritmo) {
    try {
      const invoices = await WaBillingService.pacedInvoices(recipient.contract, ritmo.sgpCalls++ > 0);
      if (invoices === null) return false;
      return !invoices.some((fatura) => chaveDaFatura(fatura) === recipient.invoice_key);
    } catch (error) {
      console.warn(`[wa] campanha: conferência de pagamento do contrato ${recipient.contract}: ${error.message}`);
      return false;
    }
  }

  /**
   * The shape the browser may see.
   *
   * Built field by field like `publicAccount`, and for the same reason: a
   * column added later must not reach the browser by default.
   */
  /**
   * A timestamp the browser can read, whatever the driver handed back.
   *
   * The same column arrives three ways: a string from SQLite, a `Date` from
   * MySQL and Postgres, and — on the row a build has just written — whatever
   * the insert put there, which came out as epoch millis. All three are typed
   * `string | null` on the other side, so two of them are a lie the screen only
   * survives because its formatter is forgiving.
   */
  static asIso(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'number') return new Date(value).toISOString();
    return String(value);
  }

  static publicBroadcast(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      totalCount: Number(row.total_count || 0),
      sentCount: Number(row.sent_count || 0),
      failedCount: Number(row.failed_count || 0),
      rateLimitPerMin: row.rate_limit_per_min ?? null,
      pacePerHour: row.pace_per_hour ?? null,
      accountId: row.account_id ?? null,
      templateId: row.template_id ?? null,
      kind: row.kind === 'general' ? 'general' : 'billing',
      scheduledAt: this.asIso(row.scheduled_at),
      attachment: row.attachment_path
        ? { name: row.attachment_name || null, type: row.attachment_type || null }
        : null,
      audience: readAudience(row.audience_json),
      startAt: this.asIso(row.start_at),
      createdAt: this.asIso(row.created_at),
      updatedAt: this.asIso(row.updated_at)
    };
  }
}

/** `whereIn` in blocks of 500: every driver's parameter limit is above that. */
function blocks(list, size = 500) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Os filtros com que a campanha foi montada, para o cartão mostrar. */
function readAudience(raw) {
  if (!raw) return null;
  try {
    const lido = JSON.parse(raw);
    return lido && typeof lido === 'object' ? lido : null;
  } catch {
    return null;
  }
}

/** What the operator will read in `error_msg`; a `WaError`'s message is a key. */
function failureText(error) {
  return [error?.code, error?.message]
    .filter(Boolean)
    .map(String)
    .join(' | ')
    .slice(0, ERROR_LIMIT);
}

export default WaBroadcastService;
