import fsp from 'node:fs/promises';
import path from 'node:path';
import { tdb } from '../config/database.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';
import { DATA_DIR } from '../config/paths.js';
import { MEDIA_DIR, tenantIdFromDir, tenantMediaDir } from './waMediaService.js';
import { WEBHOOK_VERDICTS } from '../utils/wa/evolutionApi.js';
import WhatsAppConfigService from './whatsappConfigService.js';

/**
 * One read that answers "is this working?".
 *
 * Everything else on this surface answers a question about ONE thing — this
 * conversation, this campaign, this number. That is exactly why the integration
 * can be dead for two days without anybody noticing: a failed message is
 * visible only inside its own thread, and a queue that stopped moving is
 * visible nowhere at all. The operator finds out when a customer complains.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO NUMBERS CARRY THE MEANING, AND BOTH ARE ABOUT TIME
 *
 * `outbox.oldestQueuedAt` and `lastInboundAt`. Volume cannot say what either
 * of them says:
 *
 *   - Forty messages queued is a busy afternoon if the oldest is a minute old,
 *     and the panel gone silent if the oldest is from yesterday. The COUNT is
 *     the same number in both worlds; only the timestamp separates them.
 *   - An empty queue with nothing arriving for two days is not calm. It is a
 *     dead webhook — and the queue, being empty, looks perfect.
 *
 * So both are read even though both cost an extra query, and the strip is
 * built to say them out loud rather than render them as another counter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CHEAP ON PURPOSE
 *
 * This is a screen that polls. `wa_messages` is the biggest table in the panel,
 * and a health read that scans it becomes the reason the panel is slow — which
 * would make this module the thing it exists to detect.
 *
 * So every query here is an EQUALITY on the leading column of an index that
 * already exists, and nothing pulls rows to count them:
 *
 *   - `wa_messages.index(['delivery_status', 'created_at'])` — the outbox
 *     worker's own index — serves `queued`, `sending`, `oldestQueuedAt` and
 *     `failed24h`. The first three touch only the queue, which is small by
 *     definition (a large one is the alarm). `failed24h` adds a range on
 *     `created_at`, the index's second column, so the 24 h window is a seek
 *     rather than a scan of every failure the panel ever had.
 *   - The inbox figures and `lastInboundAt` come from `wa_conversations`,
 *     which is smaller than `wa_messages` by however many messages a thread
 *     holds, and which already maintains `last_inbound_at` on every inbound
 *     (`waInboundService`). Deriving it from `wa_messages` instead would mean
 *     ordering by a column with no index on the table we must not scan.
 *
 * `lastOutboundAt` is the one figure with no column of its own, and it is read
 * as three indexed lookups rather than one `whereIn` — see `lastOutboundAt()`.
 */

/**
 * Counts, and the disagreement `waBotService` chose to avoid.
 *
 * That module has a comment about this: the three engines disagree about
 * whether `COUNT(*)` comes back a number or a string — SQLite and Postgres and
 * MySQL do not answer alike, and Postgres returns a bigint that the driver
 * hands over as a STRING so it cannot silently lose precision. The bot could
 * dodge it by pulling the handful of ids it needed; a health read cannot,
 * because the whole point is not to pull rows.
 *
 * So it is handled here, explicitly and in one place. Without this, `queued`
 * arrives at the strip as `"40"`, `queued > 0` is still true, and everything
 * looks fine — until `"40" + 0` renders as "400", or a comparison against a
 * threshold sorts lexically and decides 9 is larger than 40.
 */
function asCount(row, key = 'total') {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * A timestamp as the contract types it: `string | null`, ISO.
 *
 * The same three engines hand back three different things for one column —
 * a `Date` from Postgres and MySQL, and on SQLite whatever the insert put
 * there, which for `new Date()` is epoch millis. All three are typed
 * `string | null` on the other side. `waBroadcastService.asIso` has the same
 * job; this one additionally re-parses a string, because `"2026-09-08
 * 23:14:02"` reaching `formatRelativeTime` as-is is an Invalid Date in Safari
 * and the strip would print nothing where its loudest sentence should be.
 */
function asIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    const fromMillis = new Date(value);
    return Number.isNaN(fromMillis.getTime()) ? null : fromMillis.toISOString();
  }
  const parsed = new Date(String(value).includes('T') ? String(value) : `${String(value)}Z`);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** The newest of a set of timestamps, ISO, or null when none of them is one. */
function newestIso(values) {
  let bestMs = -Infinity;
  let best = null;
  for (const value of values) {
    const iso = asIso(value);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = iso;
  }
  return best;
}

/** The window `failed24h` means, and the only reason this module knows a clock. */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Outbound statuses that mean the message actually left.
 *
 * `sent` is the provider accepting it; `delivered` and `read` are receipts that
 * promote the same row afterwards. All three are "it went out", and which one a
 * given row stopped at depends on the recipient's phone rather than on us.
 */
const GONE_OUT = ['sent', 'delivered', 'read'];

/**
 * How long a media reading is served before it is recomputed.
 *
 * Longer than the strip's own poll, deliberately — see `mediaUsage()`.
 */
const MEDIA_TTL_MS = 5 * 60 * 1000;

/**
 * SQLite's bound-parameter ceiling was 999 for years and is 32766 in current
 * builds; MySQL's is a packet size. One conversation directory is one bound
 * parameter, so the ownership filter is chunked well under the smaller number
 * rather than betting on which build is deployed.
 */
const ID_CHUNK = 400;

/** `{ [tenantId]: { at, value, refreshing } }` — see `mediaUsage()`. */
const mediaCache = new Map();

class WaHealthService {
  /**
   * The numbers, for the provider in scope.
   *
   * Read one after another rather than in a `Promise.all`: SQLite serialises
   * anyway, and the pool this shares with the rest of the panel has better uses
   * for its connections than seven parallel counts on a screen that polls.
   */
  static async read() {
    const accounts = await this.accounts();
    const outbox = await this.outbox();
    const inbox = await this.inbox();
    const lastInboundAt = await this.lastInboundAt();
    const lastOutboundAt = await this.lastOutboundAt();
    const media = await this.mediaUsage();
    const webhook = await this.webhook();
    const retention = await this.retention();
    return { accounts, outbox, inbox, lastInboundAt, lastOutboundAt, media, retention, webhook };
  }

  /**
   * Os dois prazos de guarda, ao lado da contagem do que já está guardado.
   *
   * Aqui porque é aqui que a contagem está. `media.bytes` diz quanto ocupa e
   * não dizia por quanto tempo — e as duas metades dessa frase só significam
   * alguma coisa juntas: "9,4 KB" é irrelevante e "9,4 KB para sempre" é uma
   * decisão. Todo o resto do sistema nasce com prazo (telemetria 14/90, eventos
   * do ERP 90, provisionamento 90, trilha 365); estes dois são os únicos que
   * nascem em zero, que quer dizer nunca apagar — e é onde ficam o texto das
   * conversas, as fotos e os documentos que o assinante mandou.
   *
   * Da configuração em cache do provedor, então não custa consulta: a tira roda
   * a cada minuto e este número muda quando alguém salva a aba.
   */
  static async retention() {
    const config = await WhatsAppConfigService.getConfig();
    return {
      mediaDays: Number(config.mediaRetentionDays) || 0,
      messageDays: Number(config.messageRetentionDays) || 0
    };
  }

  /**
   * The numbers paired to WhatsApp.
   *
   * `whatsapp_accounts` holds one row per number an ISP has — single digits —
   * so this is the one place a `GROUP BY` is cheaper than the equality reads
   * everything else uses. `'connected'` is the literal `waSendService` and
   * `WhatsAppAccount.getForPurpose` both test against: anything else is a
   * number that cannot carry traffic, whether it is pairing, logged out, or
   * broken, and the strip only needs to know that it will not send.
   */
  static async accounts() {
    const rows = await tdb('whatsapp_accounts')
      .select('status')
      .count({ total: '*' })
      .groupBy('status');

    let total = 0;
    let connected = 0;
    for (const row of rows) {
      const many = asCount(row);
      total += many;
      if (row.status === 'connected') connected += many;
    }
    return { total, connected, disconnected: total - connected };
  }

  /**
   * O estado do webhook, que é a metade que faltava de "nunca chegou nada".
   *
   * Sem isto a tira sabe dizer que nada chegou e não sabe dizer por quê, e as
   * três causas — webhook ausente no servidor, webhook apontando para outro
   * lugar, webhook certo que o Evolution não está chamando — aparecem como a
   * mesma frase. Com elas separadas, cada uma leva a um conserto diferente.
   *
   * `unreachable` conta os números cuja VOLTA falhou — o endereço público não
   * chega aqui —, e ele tem precedência sobre `broken` porque um webhook que
   * não é entregável torna irrelevante o que está gravado no servidor.
   *
   * `broken` conta apenas o que uma conferência JÁ VIU quebrado. Uma conta
   * nunca conferida não entra: dizer "quebrado" sobre o que não se olhou é
   * pior do que não dizer nada, porque manda o operador consertar às cegas.
   * `unchecked` é o que a tela usa para oferecer a conferência.
   *
   * `unverifiable` é o meio-termo que faltava, e ele nasceu de um painel em
   * produção com "Nunca chegou nada" ao lado de um webhook que a tela declarava
   * saudável: a URL e o token conferem, e a lista de eventos veio vazia — o que
   * pode ser um v2 antigo que não devolve o campo, ou um webhook que não assina
   * nada. Contá-lo como `broken` acusaria um servidor possivelmente são; contá-lo
   * como `ok`, que era o que acontecia, calava sobre a única coisa que restava
   * para olhar. É aviso, e o conserto dos dois casos é o mesmo: reaplicar.
   */
  static async webhook() {
    const rows = await tdb('whatsapp_accounts')
      .select('webhook_verdict', 'webhook_probe_verdict', 'webhook_refused_at');

    let broken = 0;
    let unchecked = 0;
    let unverifiable = 0;
    let unreachable = 0;
    let refusedAt = null;
    for (const row of rows) {
      // A volta primeiro, e ela decide sozinha quando fala. É a leitura mais
      // forte que o painel tem: o veredito de configuração compara o servidor
      // com o que o painel ESPERA, e as duas pontas dessa comparação saem do
      // mesmo `webhookBaseUrl` — com um endereço errado ela responde `ok`. A
      // volta é a única que sabe que aquele endereço não chega aqui.
      const p = row.webhook_probe_verdict || null;
      if (p && p !== 'reached') {
        unreachable += 1;
        continue;
      }
      const v = row.webhook_verdict || null;
      if (!v || v === WEBHOOK_VERDICTS.UNREACHABLE) unchecked += 1;
      else if (v === WEBHOOK_VERDICTS.EVENTS_UNKNOWN) unverifiable += 1;
      else if (v !== WEBHOOK_VERDICTS.OK) broken += 1;
      // A recusa mais recente de qualquer número: uma só basta para mudar a
      // pergunta de "o Evolution está chamando?" para "por que ele leva 401?".
      const quando = asIso(row.webhook_refused_at);
      if (quando && (!refusedAt || quando > refusedAt)) refusedAt = quando;
    }
    return { broken, unchecked, unverifiable, unreachable, refusedAt };
  }

  /**
   * The send queue.
   *
   * Four reads on `index(['delivery_status', 'created_at'])`, none of which
   * touches a row outside the status it asks for.
   *
   * `oldestQueuedAt` is an ordered LIMIT 1 rather than `MIN(created_at)`, for
   * two reasons that point the same way: it walks the index to the first
   * matching row and stops, and it comes back as a plain column value, so it
   * goes through `asIso` like every other timestamp instead of through whatever
   * each engine decides an aggregate over a timestamp should be typed as.
   */
  static async outbox() {
    const now = new Date();

    const [queuedRow] = await tdb('wa_messages')
      .where({ delivery_status: 'queued' })
      .count({ total: '*' });

    // Since the outbox learned to back off, a message that bounced goes back to
    // 'queued' with a due time in the future. It is still waiting to go out, so
    // it belongs in `queued` — but it is NOT the queue standing still, and the
    // two have to be told apart or an operator reads a healthy retry as a stuck
    // panel. `retrying` is that slice, and `oldestQueuedAt` below excludes it.
    const [retryingRow] = await tdb('wa_messages')
      .where({ delivery_status: 'queued' })
      .where('next_attempt_at', '>', now)
      .count({ total: '*' });

    const [sendingRow] = await tdb('wa_messages')
      .where({ delivery_status: 'sending' })
      .count({ total: '*' });

    const [failedRow] = await tdb('wa_messages')
      .where({ delivery_status: 'failed' })
      .where('created_at', '>=', new Date(now.getTime() - FAILURE_WINDOW_MS))
      .count({ total: '*' });

    // Only rows that are actually DUE. A NULL due time means due now, which is
    // every row written before the column existed and every first attempt, so
    // the NULL branch is not an edge case here — it is the common one.
    const oldest = await tdb('wa_messages')
      .where({ delivery_status: 'queued' })
      .where((q) => q.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))
      .orderBy('created_at', 'asc')
      .select('created_at')
      .first();

    return {
      queued: asCount(queuedRow),
      retrying: asCount(retryingRow),
      sending: asCount(sendingRow),
      failed24h: asCount(failedRow),
      oldestQueuedAt: asIso(oldest?.created_at)
    };
  }

  /**
   * What is waiting for a human.
   *
   * `unread` is the number of THREADS carrying unread messages, not the sum of
   * their counters: the strip is a pointer at work to do, and one customer who
   * sent thirty messages is one conversation to open, not thirty.
   */
  static async inbox() {
    const [unreadRow] = await tdb('wa_conversations')
      .where('unread_count', '>', 0)
      .whereNull('closed_at')
      .count({ total: '*' });

    const [openRow] = await tdb('wa_conversations')
      .whereNull('closed_at')
      .count({ total: '*' });

    return { unread: asCount(unreadRow), openConversations: asCount(openRow) };
  }

  /**
   * When anything last came IN — the number that catches a dead webhook.
   *
   * Read off `wa_conversations.last_inbound_at`, which `waInboundService`
   * writes on every inbound message, rather than off `wa_messages`: the same
   * answer from a table with one row per THREAD instead of one per message, and
   * `wa_messages` has no index on `direction` to order by anyway.
   *
   * Null means nothing has ever arrived — a panel paired this morning, or one
   * whose webhook has never once worked. The strip says those differently
   * (`neverAny` against `silent`), because "nothing since Tuesday" and "nothing,
   * ever" send an operator to two different places.
   */
  static async lastInboundAt() {
    const row = await tdb('wa_conversations')
      .whereNotNull('last_inbound_at')
      .orderBy('last_inbound_at', 'desc')
      .select('last_inbound_at')
      .first();
    return asIso(row?.last_inbound_at);
  }

  /**
   * When anything last went OUT.
   *
   * The one figure with no column of its own, and the reason it is three
   * queries instead of one: `whereIn('delivery_status', GONE_OUT)` with an
   * `ORDER BY created_at DESC` spans three disjoint ranges of the composite
   * index, so an engine either sorts their union or gives up on the index — and
   * the union of `sent`, `delivered` and `read` is most of the biggest table in
   * the panel.
   *
   * Asked one status at a time it is three seeks to the end of three index
   * ranges, each `O(log n)`, and the newest of the three answers is picked here
   * where it costs nothing.
   */
  static async lastOutboundAt() {
    const newest = [];
    for (const status of GONE_OUT) {
      const row = await tdb('wa_messages')
        .where({ delivery_status: status })
        .orderBy('created_at', 'desc')
        .select('created_at')
        .first();
      if (row?.created_at) newest.push(row.created_at);
    }
    return newestIso(newest);
  }

  /**
   * What the attachments occupy on disk.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THIS IS THE EXPENSIVE ONE, AND IT IS CACHED FOR THAT REASON
   *
   * `files` and `oldestAt` could come from the database, but `bytes` cannot:
   * `wa_messages` stores `attachment_path`, `attachment_type` and
   * `attachment_name` and NOT a size, so the only place the byte count exists
   * is the filesystem. Counting it means a `stat` per file, and a panel that
   * has been running a year has as many attachment files as its subscribers
   * sent photos. Doing that on every poll of a screen left open in a background
   * tab is precisely the "health strip becomes the reason the panel is slow"
   * failure — so it is NOT done on every poll:
   *
   *   - A reading is kept per provider for `MEDIA_TTL_MS`, which is longer than
   *     the strip's own poll interval. Between refreshes the poll costs nothing
   *     at all.
   *   - When it goes stale the PREVIOUS reading is returned immediately and the
   *     walk runs behind the response. Only the very first read after boot
   *     waits for the disk, because that one has nothing to serve instead.
   *   - A refresh already in flight is never started twice.
   *
   * The staleness is honest: this is a disk-usage figure whose consumer is a
   * line of text, and it is five minutes old at worst. Nothing decides anything
   * on it. Deleting the old files belongs to the media sweeper — this only
   * counts.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * PROVIDER SCOPING, WHICH THE DISK DOES NOT DO FOR US
   *
   * There are two shapes on disk and they are scoped by different means.
   *
   * Everything written since wave 8 lives under `wa-media/t<id>/`, and there
   * the path itself is the provider: the subtree is walked whole, with no
   * lookup, because nothing else can have put a file in it.
   *
   * Everything written before it lives at `wa-media/<conversationId>/<file>`,
   * where the path carries no provider at all. Two providers on one panel share
   * that area, so walking it wholesale would report the neighbour's photos as
   * this one's — not a leak of content, but a wrong number on the one screen
   * whose whole job is to be believed. Those directory names ARE conversation
   * ids, so they are filtered through `wa_conversations` — a primary-key lookup
   * `tdb` has already scoped — and only the surviving ones are walked. Chunked,
   * because the id list is as long as the panel has threads with attachments.
   *
   * The legacy area is read here even on a panel with several providers, which
   * is the opposite of what the sweep does with it, and for a reason that only
   * looks contradictory: this read counts and the sweep deletes. The ownership
   * lookup is exact for a file that has a row, so counting is safe; a file with
   * no row is counted by nobody here, while deleting it would need an answer to
   * "whose was it?" that the path cannot give.
   */
  static async mediaUsage() {
    const tenantId = currentTenantId();
    const entry = mediaCache.get(tenantId);
    const fresh = entry && Date.now() - entry.at < MEDIA_TTL_MS;

    if (entry && fresh) return entry.value;

    if (entry && !entry.refreshing) {
      // Stale but serviceable: answer now, walk behind the response. The
      // context is captured explicitly because this outlives the request that
      // started it, and `tdb` would otherwise throw for want of a provider.
      entry.refreshing = true;
      void runInTenant(tenantId, () => this.scanMedia())
        .then((value) => mediaCache.set(tenantId, { at: Date.now(), value, refreshing: false }))
        .catch(() => { entry.refreshing = false; });
      return entry.value;
    }

    if (entry) return entry.value;

    const value = await this.scanMedia();
    mediaCache.set(tenantId, { at: Date.now(), value, refreshing: false });
    return value;
  }

  /** Drops the cached media reading. For tests, and for the sweeper afterwards. */
  static forgetMedia(tenantId = null) {
    if (tenantId === null) mediaCache.clear();
    else mediaCache.delete(tenantId);
  }

  /**
   * The walk itself. Never throws: a missing or unreadable media directory is a
   * panel with no attachments yet, which is the truth on a fresh install, and
   * the rest of the health read must not be lost to it.
   */
  static async scanMedia() {
    const root = path.join(DATA_DIR, MEDIA_DIR);
    const tally = { files: 0, bytes: 0, oldestMs: Infinity };

    // Ours by construction, so it is walked to the bottom: the outbound folder
    // under it holds files the operator uploaded, which are as much of this
    // provider's disk as the ones the customer sent.
    await this.countTree(path.join(DATA_DIR, tenantMediaDir()), tally);

    let dirs;
    try {
      dirs = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && tenantIdFromDir(entry.name) === null)
        .map((entry) => entry.name);
    } catch {
      dirs = [];
    }

    // A directory name that is not a conversation id belongs to nobody, and is
    // counted by nobody.
    const ids = dirs
      .map((name) => Number(name))
      .filter((id) => Number.isInteger(id) && id > 0);

    const mine = new Set();
    for (let at = 0; at < ids.length; at += ID_CHUNK) {
      const owned = await tdb('wa_conversations')
        .whereIn('id', ids.slice(at, at + ID_CHUNK))
        .pluck('id');
      for (const id of owned) mine.add(Number(id));
    }

    for (const id of mine) await this.countTree(path.join(root, String(id)), tally);

    return {
      files: tally.files,
      bytes: tally.bytes,
      oldestAt: Number.isFinite(tally.oldestMs)
        ? new Date(tally.oldestMs).toISOString()
        : null
    };
  }

  /**
   * Adds every regular file under `dir` to `tally`.
   *
   * Symlinks are skipped for the sweeper's reason, one step weaker: this only
   * counts, so following one would not delete anything outside the tree — it
   * would just charge a provider for bytes that are not theirs, or loop.
   */
  static async countTree(dir, tally) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // No media directory yet: a fresh install has none, and the rest of the
      // health read must not be lost to that.
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.countTree(full, tally);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = await fsp.stat(full);
        tally.files += 1;
        tally.bytes += stats.size;
        // `mtime`, not `birthtime`: several filesystems do not record a
        // creation time and hand back the epoch for it, which would report
        // every attachment as older than the panel.
        if (stats.mtimeMs < tally.oldestMs) tally.oldestMs = stats.mtimeMs;
      } catch {
        // Swept between the readdir and the stat. Not ours to mourn.
      }
    }
  }
}

export { asCount, asIso, MEDIA_TTL_MS };
export default WaHealthService;
