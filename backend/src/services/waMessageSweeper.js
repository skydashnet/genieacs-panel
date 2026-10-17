import { tdb } from '../config/database.js';
import { forEveryTenant } from '../config/tenantJobs.js';
import { MAX_RETENTION_DAYS } from '../config/retention.js';
import WhatsAppConfigService from './whatsappConfigService.js';

/**
 * The second thing in this integration that deletes, and the heavier of the two.
 *
 * `wa_messages` never lost a row. On an installation that fires a campaign at
 * thousands of contracts that table only grows, and it is already the largest
 * one the panel has — so the disk the media sweep is trying to reclaim fills
 * again from the other side, in rows instead of files.
 *
 * What the media sweep deletes is a file, and the message survives it with its
 * words intact. What this deletes is the words. That difference is why every
 * limit below leans the same way:
 *
 * - It NEVER deletes a `queued` or `sending` row. That is a message still on
 *   its way out; deleting it makes an operator's reply vanish between being
 *   typed and being sent, and nothing anywhere would say why. Age is not the
 *   question here, exactly as in the media sweep — whether it has gone out is.
 * - It NEVER deletes a row that still has `attachment_path` set.
 * - It NEVER deletes a `wa_conversations` row. That row holds the phone↔contact
 *   binding, so deleting it loses whose conversation this was — and it saves no
 *   disk at all, because there is one of them per THREAD and the rows that
 *   actually accumulate are the ones below it.
 *
 * That second rule is what ties the two retentions together without either
 * module reaching into the other's data. `WaMediaSweeper` is the only thing
 * that unlinks a file, and it nulls `attachment_path` when it does; only then
 * does the row become eligible here. So with attachment retention OFF, a
 * message carrying an attachment stays forever — which is not an oversight,
 * it is precisely what "keep the attachments forever" means. A row whose file
 * is still on disk cannot be deleted without orphaning those bytes, and the
 * only thing that knows they are gone is the module that removed them.
 *
 * With `messageRetentionDays` at 0 it deletes nothing and says so. Zero is the
 * default, for the same reason it is the media sweep's: the setting arrives at
 * installations that already have years of history, and dropping a provider's
 * conversations because they upgraded the panel would be the panel destroying
 * evidence nobody asked it to touch.
 */

/**
 * How often the loop wakes: four times a day, the same clock as the media
 * sweep and for the same three reasons. The window is measured in DAYS, so a
 * pass six hours late is still exact to well inside a percent of the shortest
 * useful retention. Nothing is waiting on it. And it destroys data, so a rare
 * pass bounds how much a bug in it can take before somebody notices.
 */
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ten years, the same ceiling `whatsappConfigService` clamps the setting to. */

/** A row with one of these still has a send in front of it. */
const PENDING_STATUSES = ['queued', 'sending'];

/**
 * Rows per statement.
 *
 * One `DELETE ... WHERE created_at < ?` would be simpler and is the wrong
 * shape: on the installation this job exists for it matches six figures of
 * rows, and it would hold a write lock across all of them. SQLite has exactly
 * one writer, so that lock is the outbox worker not sending for the duration.
 * Bounded batches give the queue a gap between statements.
 *
 * Selected by id and then deleted by id, rather than `DELETE ... LIMIT`, which
 * MySQL has and Postgres does not.
 */
const BATCH_SIZE = 500;

/**
 * Days of retention, or zero for forever.
 *
 * Read defensively rather than trusted, like the media sweep's: an absent key,
 * a string, a negative all read as zero, and zero deletes nothing. For a number
 * this destructive the safe direction is always the one that keeps rows.
 */
export function retentionDays(config) {
  const days = Math.trunc(Number(config?.messageRetentionDays));
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(days, MAX_RETENTION_DAYS);
}

class WaMessageSweeper {
  static timer = null;

  /**
   * Guards against two passes at once.
   *
   * Unlike the media sweep there is no button behind this one, so the race it
   * prevents is a pass that outran its own six-hour tick on a table big enough
   * to take that long. Two passes would each select the same batch of ids and
   * the second would delete nothing, which is harmless — but they would also
   * both report having removed it, and a count that double-counts is how a
   * retention window gets blamed for rows it never touched.
   */
  static running = false;

  /**
   * Started from `server.js` only, never as an import side effect, so the test
   * suite never has a timer running behind it. The setting is read INSIDE the
   * tick rather than used to start and stop the timer: turning retention on in
   * Settings takes effect on its own, with no lifecycle to keep in sync.
   *
   * There is no pass at boot, on purpose, and here that matters more than it
   * does for files: a bug in a sweep that runs on every restart is a bug that
   * gets a second chance at the history every time an operator restarts the
   * panel to see whether that fixes it.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp history sweep failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One wake-up, once per provider, each inside its own scope.
   *
   * `forEveryTenant` and not `forSoleTenant`, which is the whole difference
   * between this job and the media sweep next to it. That one walks a
   * filesystem no provider owns a corner of, so a second pass would see the
   * first provider's files as orphans and delete every one of them. This one
   * reads `wa_messages`, which IS in `SCOPED_TABLES`: every query below is
   * filtered to the provider in scope, so a per-provider loop genuinely divides
   * the work — and each provider's own retention window, which is its own
   * setting, is the one applied to its own rows.
   *
   * One provider failing does not stop the others; that is `forEveryTenant`'s
   * contract and it is the right one here, because a broken configuration at
   * one ISP must not quietly stop the history sweep for every other ISP on the
   * deployment.
   *
   * @returns {Promise<Array<{ messages: number, skipped?: string }>>} one entry
   *   per provider, in id order. No provider at all is an empty array —
   *   there is no sole-tenant precondition to refuse, so this job has no
   *   `no_provider` or `unscoped` answer of its own.
   */
  static async tick() {
    try {
      // `forEveryTenant`, e não `forEachTenant`: a pergunta aqui é "de quem eu
      // ainda guardo conversa?", não "quem está trabalhando?". Um provedor
      // suspenso não deve receber envio nem alerta, e continua sendo o titular
      // do histórico de mensagens dos assinantes dele — que sem visita ficava
      // sem prazo nenhum, para sempre.
      return await forEveryTenant(() => this.sweep(), {
        onError: (error, tenant) => {
          console.warn(`WhatsApp history sweep failed for provider ${tenant.slug}: ${error.message}`);
        }
      });
    } catch (error) {
      // Only the read of the provider list itself can land here — `sweep` never
      // throws and `forEveryTenant` catches each provider separately.
      console.warn(`WhatsApp history sweep failed: ${error.message}`);
      return [];
    }
  }

  /**
   * One pass, inside a provider scope the caller has already opened.
   *
   * It NEVER throws, the same discipline the media sweep keeps and for the same
   * reason: this runs on a timer with nobody watching, and a pass that raises
   * is a pass that stopped before the rows that would have freed the table. Why
   * a pass did nothing comes back in `skipped` instead, so "retention is off"
   * and "nothing was old enough" are told apart rather than both arriving as a
   * silent zero.
   *
   * @returns {Promise<{ messages: number, skipped?: string }>}
   */
  static async sweep() {
    if (this.running) return { skipped: 'busy', messages: 0 };
    this.running = true;
    try {
      const config = await WhatsAppConfigService.getConfig().catch(() => null);
      const days = retentionDays(config);
      // Zero is forever, and forever is the default. The pass stops here,
      // BEFORE any query: with retention off there is nothing to look for.
      if (days === 0) return { skipped: 'disabled', messages: 0 };

      const cutoff = new Date(Date.now() - days * DAY_MS);
      let messages = 0;
      for (;;) {
        const ids = await this.eligibleIds(cutoff);
        if (!ids.length) break;
        // The one row that points at a message from outside is a campaign
        // recipient, and that foreign key is `ON DELETE SET NULL`: the report
        // of who a campaign reached keeps its line, its rendered text and its
        // status, and loses only the link to a message that is gone. So the
        // history window can be shorter than a campaign's audit trail without
        // the two contradicting each other.
        const removed = await tdb('wa_messages').whereIn('id', ids).del();
        // A batch that matched ids and then deleted none would loop forever on
        // the same rows. Nothing known produces that, which is exactly why it
        // is worth not betting the process on.
        if (!removed) break;
        messages += removed;
        if (ids.length < BATCH_SIZE) break;
      }

      return { messages };
    } catch (error) {
      console.warn(`WhatsApp history sweep failed: ${error.message}`);
      return { skipped: 'failed', messages: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * The next batch of ids this provider may lose, oldest first.
   *
   * The three exclusions are the module's whole policy, and two of them are
   * easy to write wrongly:
   *
   * `delivery_status` is NULL on every INBOUND message — it describes a send,
   * and nothing was sent. A plain `whereNotIn(...)` would compare against NULL,
   * evaluate to NULL rather than true, and quietly protect the customer's half
   * of every conversation forever. The explicit `whereNull` branch is what lets
   * an inbound message age out at all.
   *
   * `whereNull('attachment_path')` is the join between the two retentions: the
   * row becomes eligible only once `WaMediaSweeper` has removed the file and
   * cleared the column. It is checked here rather than assumed from the file's
   * absence because this module never touches the disk and must not start.
   *
   * Ordered oldest-first so a pass interrupted halfway — a restart, a failed
   * batch — has removed the rows furthest past the window rather than an
   * arbitrary slice of them.
   */
  static async eligibleIds(cutoff) {
    return tdb('wa_messages')
      .where('created_at', '<', cutoff)
      .whereNull('attachment_path')
      .where((q) => {
        q.whereNull('delivery_status').orWhereNotIn('delivery_status', PENDING_STATUSES);
      })
      .orderBy('created_at', 'asc')
      .limit(BATCH_SIZE)
      .pluck('id');
  }
}

export default WaMessageSweeper;
