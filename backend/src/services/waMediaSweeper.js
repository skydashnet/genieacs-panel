import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDb, tdb } from '../config/database.js';
import { DATA_DIR } from '../config/paths.js';
import { MAX_RETENTION_DAYS } from '../config/retention.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';
import { MEDIA_DIR, tenantIdFromDir, tenantMediaDir } from './waMediaService.js';
import WhatsAppConfigService from './whatsappConfigService.js';
import WaHealthService from './waHealthService.js';

/**
 * The only thing in this integration that deletes.
 *
 * Nothing else ever does: every attachment that arrives and every one the
 * operator sends is written under `DATA_DIR/wa-media/` and stays there, with no
 * quota and no count. On a provider with movement that grows on its own, and
 * the disk it fills is the same one SQLite writes to — so the panel does not
 * get slow, it stops.
 *
 * What the sweep may touch is deliberately narrow, and each limit is a rule
 * somebody would otherwise learn the hard way:
 *
 * - It deletes the FILE and clears that row's `attachment_*` columns. The
 *   message stays in the thread with its text intact and the bubble says the
 *   attachment is no longer on disk, which is true and already has a screen.
 * - It NEVER deletes a message row. Conversation history is what a provider
 *   needs when a customer disputes a charge; disk is what they need when it
 *   fills. Only one of those is this module's problem.
 * - It NEVER deletes a file a `queued` or `sending` message still has to send.
 *   The row's age is irrelevant: what matters is whether it has gone out.
 *   Deleting there turns a pending send into a permanent failure, and the
 *   operator who attached the file never finds out why.
 * - A file with no row pointing at it is an abandoned upload — the operator
 *   who attached a photo and closed the tab — and goes by the same age rule.
 * - It only ever looks inside the subtree of the provider whose pass is
 *   running. What "orphan" means depends entirely on which rows were read, and
 *   the rows are one provider's; a file outside that subtree has no row here
 *   because it was never this provider's to have one.
 *
 * With `mediaRetentionDays` at 0 it deletes nothing and says so. Zero is the
 * default, and that default is not laziness: the setting arrives at
 * installations that already have files, and deleting a provider's history
 * because they updated the panel would be the panel destroying data nobody
 * asked it to touch.
 */

/**
 * How often the loop wakes: four times a day.
 *
 * Nothing like the outbox's five seconds, and for the opposite reasons. The
 * window this job enforces is measured in DAYS, so a pass that runs six hours
 * "late" is still exact to well inside a percent of the shortest useful
 * retention — there is no reply waiting on it. A pass also walks the whole
 * media tree and stats every file on it, which is disk work competing for the
 * same spindle SQLite is using; doing that every minute would spend more of the
 * disk than the files it reclaims. And it is the one job here that destroys
 * data: a rare pass bounds how much a bug in it can take before anyone notices.
 */
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ten years, the same ceiling `whatsappConfigService` clamps the setting to. */

/** A row with one of these still has a send in front of it. */
const PENDING_STATUSES = ['queued', 'sending'];

/** Every stored attachment lives under here, and the walk never leaves it. */
const ROOT = path.resolve(DATA_DIR);

/** The ceiling. Nothing outside this is ever walked, whichever provider runs. */
const MEDIA_ROOT = path.resolve(ROOT, MEDIA_DIR);

/** Whether `candidate` is `root` itself or something inside it. */
function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * The subtree one pass may delete from: `wa-media/t<id>`.
 *
 * Confined against `MEDIA_ROOT` even though the only input is a provider id the
 * scope handed us. One more subtree is not one more permission, and a check
 * that can only fail on a bug is exactly the check worth keeping — the failure
 * it would otherwise catch is a `rm` somewhere else on the volume.
 */
function tenantRoot() {
  const absolute = path.resolve(ROOT, tenantMediaDir());
  if (!inside(MEDIA_ROOT, absolute)) {
    throw new Error(`media subtree ${absolute} falls outside ${MEDIA_ROOT}`);
  }
  return absolute;
}

/** Megabytes with two decimals — the unit the operator's message speaks. */
export function toMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/**
 * Days of retention, or zero for forever.
 *
 * Read defensively rather than trusted: anything unreadable — an absent key, a
 * string, a negative — reads as zero, and zero deletes nothing. The safe
 * direction for a number this destructive is always the one that keeps files.
 */
export function retentionDays(config) {
  const days = Math.trunc(Number(config?.mediaRetentionDays));
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(days, MAX_RETENTION_DAYS);
}

/**
 * The absolute path a stored `attachment_path` names, or null.
 *
 * The same confinement `waMediaFile.resolveStoredAttachment` performs before it
 * opens anything, for the same reason and in the same order: `path.resolve`
 * collapses `..` BEFORE the prefix is checked, which is the only order that
 * works. A stored path landing outside `DATA_DIR` is not a file we have — it
 * protects nothing here and it matches nothing, exactly as it serves nothing
 * there.
 *
 * It resolves lexically and never calls `realpath`, unlike that module, and it
 * has to: these strings are compared against the ones the walk below produces,
 * and the walk is lexical too. One file reached two ways has to come out as one
 * string, or a protected file could fail to match itself.
 */
function absoluteFor(relative) {
  const stored = String(relative || '').trim();
  if (!stored) return null;
  const absolute = path.resolve(ROOT, stored);
  return inside(ROOT, absolute) ? absolute : null;
}

/**
 * Every regular file under `dir`, as absolute paths.
 *
 * Only ever called with a directory inside `wa-media`, never with `DATA_DIR`,
 * which is the whole difference between a media sweep and a panel that deletes
 * its own database: `panel.sqlite` and `db-config.json` live one directory up.
 *
 * Symlinks are skipped, files and directories alike — nothing in here was
 * written by this panel, and following one is how a sweep confined to a subtree
 * deletes something outside it. Anything that is not a regular file is left
 * alone for the same reason.
 */
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // No media directory yet, or one that cannot be read. Either way there is
    // nothing here to delete, and a sweep is not the place to raise it.
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Whether this installation has exactly one provider, counting every status.
 *
 * The one question the legacy area's ownership turns on. Suspended, disabled or
 * whatever else a provider's row says, it still owns the files it wrote, so a
 * count filtered by status is the wrong count to ask here.
 */
async function soleProvider() {
  // `kind: 'provider'`: a linha da plataforma é dona da caixa com que atendemos
  // os ISPs, não um segundo ISP. Contá-la faria uma instalação de um provedor
  // só parar de reconhecer os arquivos legados como dele, e eles ficariam sem
  // dono para sempre — que é o oposto do que esta pergunta existe para decidir.
  const [{ total } = {}] = await getDb()('tenants').where({ kind: 'provider' }).count({ total: '*' });
  return Number(total) === 1;
}

/**
 * The legacy area: everything under `wa-media` that is not inside a `t<id>/`.
 *
 * These are the files written before this wave, when the path carried no
 * provider at all — `wa-media/<conversa>/` and `wa-media/out/`. They were not
 * moved and will not be: rewriting a volume's worth of bytes during an upgrade
 * is the kind of migration that fails halfway and leaves every attachment
 * unreachable. The rows still point where the files actually are.
 *
 * Whether this area may be swept is not this function's decision — see `tick`.
 * All it does is refuse to descend into anybody's `t<id>/`, so the legacy area
 * and a provider's own subtree can never be confused for one another.
 */
async function walkLegacy(out = []) {
  let entries;
  try {
    entries = await fsp.readdir(MEDIA_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(MEDIA_ROOT, entry.name);
    if (entry.isDirectory()) {
      if (tenantIdFromDir(entry.name) !== null) continue;
      await walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

class WaMediaSweeper {
  static timer = null;

  /**
   * Guards against two runs at once, held across the whole per-provider loop
   * rather than around one provider's pass.
   *
   * A run is slow by nature, and the manual button exists precisely for the
   * moment the disk is full — which is the moment an operator presses it twice.
   * Two runs would race on the same unlink and double-count the megabytes they
   * each claim to have freed. Guarding one pass would not stop that: the second
   * run would simply overtake the first onto the next provider.
   */
  static running = false;

  /**
   * Started from `server.js` only, never as an import side effect, so the test
   * suite never has a timer running behind it. Like the outbox and the alert
   * scan, the setting is read INSIDE the tick rather than used to start and
   * stop the timer: turning retention on in Settings takes effect on its own,
   * with no lifecycle to keep in sync.
   *
   * There is no pass at boot, on purpose. The one thing worse than a sweep with
   * a bug in it is a sweep with a bug in it that runs on every restart — and an
   * operator who needs disk right now has a button that does not wait.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp media sweep failed: ${error.message}`);
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
   * One wake-up: a pass per active provider, each inside its own scope and its
   * own subtree.
   *
   * Now that a stored file's path carries the provider that wrote it, a
   * per-provider loop genuinely divides the work instead of repeating it. Each
   * pass walks `wa-media/t<id>` and reads its own rows, so a file outside that
   * subtree is never even looked at, let alone judged an orphan — which is what
   * made the old single-provider refusal necessary and is no longer true.
   *
   * THE LEGACY AREA IS THE ONE ASYMMETRY, AND IT IS DELIBERATE
   *
   * `wa-media/` outside any `t<id>/` holds the files written before the subtree
   * existed, and those paths say nothing about who owns them. On an install
   * with a single provider that is not ambiguous — every one of those files is
   * theirs — so it is swept in their pass, exactly as before, and an install
   * that upgrades keeps reclaiming its disk. The moment a second provider
   * exists the ownership becomes unknowable from the path, and an orphan of
   * unknown origin is left alone: deleting it would be guessing with somebody
   * else's customer photos.
   *
   * Todos os provedores recebem passada, inclusive o suspenso — e este
   * parágrafo dizia o contrário até agora. Ele afirmava que um suspenso não é
   * visitado e que seus arquivos "são mantidos, que é a resposta certa para um
   * provedor que pode voltar". Era uma decisão de produto defensável, e foi
   * revista: sem prazo de suspensão, sem `suspended_at` e sem exclusão
   * automática, "mantidos" nunca quis dizer guardados até a volta — quis dizer
   * guardados para sempre, foto e documento de assinante incluídos. A retenção
   * que o provedor configurou passa a valer sempre. Suspender muda quem
   * trabalha, não o que guardamos dele.
   *
   * O que NÃO mudou é o que mantinha a correção anterior de pé: cada passada só
   * toca `wa-media/t<id>/` do provedor em escopo, confinado contra a raiz.
   *
   * `includeLegacy` continua contado à parte, e por um motivo que sobrevive à
   * mudança. Decidi-lo pela contagem de ATIVOS fazia com que suspender um
   * provedor tornasse o vizinho "sole", e a passada do vizinho aplicava a
   * retenção DELE aos arquivos legados do suspenso — arquivos sem linha própria,
   * logo julgados órfãos e apagados só pela idade. Um provedor é menos capaz de
   * notar isso exatamente no momento em que é suspenso.
   *
   * A pergunta que `includeLegacy` faz é se alguém ALÉM de mim poderia ser dono
   * destes bytes, que é sobre existência e não sobre atividade. Por isso conta
   * todo provedor, qualquer que seja o status — o que agora coincide com quem
   * recebe passada, e continua sendo outra pergunta.
   */
  static async tick() {
    if (this.running) return { skipped: 'busy', files: 0, bytes: 0, mb: 0 };
    this.running = true;
    try {
      const tenants = await getDb()('tenants')
        .orderBy('id', 'asc')
        .select('id', 'slug');

      if (tenants.length === 0) return { skipped: 'no_provider', files: 0, bytes: 0, mb: 0 };
      // `soleProvider()` e não `tenants.length`: agora as duas contagens
      // coincidem, e continuam sendo perguntas diferentes — uma é quem recebe
      // passada, a outra é quem PODERIA ser dono dos arquivos legados. Derivar
      // a segunda da primeira foi o defeito que este arquivo já consertou uma
      // vez, e ele voltaria no dia em que as duas divergissem de novo.
      // who could own the legacy files. A suspended neighbour still owns its.
      const sole = await soleProvider();

      let files = 0;
      let bytes = 0;
      const skips = [];

      for (const tenant of tenants) {
        // One provider's failure does not end the loop: a broken pass at one
        // ISP must not be why every other ISP on the deployment stops
        // reclaiming disk. `sweep` swallows its own errors, so this catch is
        // for a scope that cannot be opened at all.
        try {
          const pass = await runInTenant(tenant.id, () => this.sweep({ includeLegacy: sole }));
          files += pass.files;
          bytes += pass.bytes;
          if (pass.skipped) skips.push(pass.skipped);
        } catch (error) {
          console.warn(`WhatsApp media sweep failed for provider ${tenant.slug}: ${error.message}`);
          skips.push('failed');
        }
      }

      // A reason is reported only when EVERY pass skipped for the same one:
      // that is the case the operator's button has to be able to explain
      // ("retention is off"), and it is the only case where one word is true of
      // the whole run.
      const reasons = new Set(skips);
      const skipped = skips.length === tenants.length && reasons.size === 1
        ? [...reasons][0]
        : null;

      return { files, bytes, mb: toMb(bytes), ...(skipped ? { skipped } : {}) };
    } catch (error) {
      console.warn(`WhatsApp media sweep failed: ${error.message}`);
      return { skipped: 'failed', files: 0, bytes: 0, mb: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * The manual button's entry point: one pass, for the provider making the
   * request and nobody else.
   *
   * `tick` sweeps every provider because it is the deployment's own timer and
   * nobody's request. This is the opposite: the request arrived inside one
   * provider's scope, opened by `resolveTenant`, and an admin at one ISP has no
   * business reclaiming another ISP's disk — nor being handed another ISP's
   * megabytes as the answer. Routing the button through `tick` would do both,
   * and would have looked correct for exactly as long as there was one
   * provider.
   *
   * It takes the same guard as the loop, and must: the guard lives on the run,
   * so a manual pass that skipped it could race the timer onto the same unlink.
   *
   * `includeLegacy` is decided here rather than by the caller for the same
   * reason `tick` decides it — a pass cannot see how many providers exist, and
   * the pass that assumed would be the one deleting the neighbour's files.
   *
   * @returns {Promise<{ files: number, bytes: number, mb: number, skipped?: string }>}
   */
  static async sweepCurrentTenant() {
    if (this.running) return { skipped: 'busy', files: 0, bytes: 0, mb: 0 };
    this.running = true;
    try {
      return await this.sweep({ includeLegacy: await soleProvider() });
    } catch (error) {
      // Only the provider count can land here; `sweep` never throws.
      console.warn(`WhatsApp media sweep failed: ${error.message}`);
      return { skipped: 'failed', files: 0, bytes: 0, mb: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass, inside a provider scope the caller has already opened.
   *
   * It NEVER throws. A file another process removed between the walk and the
   * unlink, a directory the panel cannot read, a row whose path escapes
   * `DATA_DIR` — none of those may stop the pass, because the file after them
   * is the one that would have freed the disk. Why a pass did nothing comes
   * back in `skipped` instead, so the caller — the loop, or the admin who just
   * pressed the button — can tell "retention is off" from "nothing was old".
   *
   * `includeLegacy` is `tick`'s answer to "is this install unambiguous?", never
   * this pass's own guess: a pass cannot see how many providers exist, and a
   * pass that assumed would be the one deleting the neighbour's files.
   *
   * @param {{ includeLegacy?: boolean }} options
   * @returns {Promise<{ files: number, bytes: number, mb: number, skipped?: string }>}
   */
  static async sweep({ includeLegacy = false } = {}) {
    try {
      const config = await WhatsAppConfigService.getConfig().catch(() => null);
      const days = retentionDays(config);
      // Zero is forever, and forever is the default. The pass stops here,
      // BEFORE the walk: with retention off there is nothing to look at, and
      // an operator pressing the button gets told that instead of a silent
      // "0 files" they would reasonably read as a bug.
      if (days === 0) return { skipped: 'disabled', files: 0, bytes: 0, mb: 0 };

      const cutoff = Date.now() - days * DAY_MS;
      const { protect, rowsByPath } = await this.indexRows();
      const files = await walk(tenantRoot());
      if (includeLegacy) await walkLegacy(files);

      let deleted = 0;
      let bytes = 0;
      const clearable = [];

      for (const file of files) {
        // A file some `queued` or `sending` row still has to send is kept
        // whatever its age. This is the check the whole module is built
        // around: everything else here costs disk, and getting this one wrong
        // costs a message the operator believes they sent.
        if (protect.has(file)) continue;

        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        // The clock is the file's own mtime, for attached files and orphans
        // alike. It is the number the disk itself keeps, it is the only one an
        // orphan has at all, and for a file with a row it is within seconds of
        // that row's `created_at` by construction — the bytes are written and
        // then the row is. One clock, so a file and the row pointing at it can
        // never disagree about how old they are.
        if (stat.mtimeMs > cutoff) continue;

        try {
          await fsp.unlink(file);
        } catch {
          // Gone already, or a permission the panel does not have. Neither is
          // reclaimed disk, so neither is counted.
          continue;
        }
        deleted += 1;
        bytes += stat.size;
        const rows = rowsByPath.get(file);
        if (rows) clearable.push(...rows);
      }

      // Bookkeeping last, and only for files that are actually gone: a row
      // cleared before an unlink that then failed would tell the operator the
      // attachment is off the disk while it is still sitting on it.
      await this.clearAttachments(clearable);

      // The health strip caches its disk reading for five minutes, which is
      // right for a poll and wrong immediately after a deletion: an operator
      // who presses "delete the old ones", frees two gigabytes and then reads
      // the same number as before has been told the sweep did nothing.
      if (deleted > 0) WaHealthService.forgetMedia(currentTenantId());

      return { files: deleted, bytes, mb: toMb(bytes) };
    } catch (error) {
      console.warn(`WhatsApp media sweep failed: ${error.message}`);
      return { skipped: 'failed', files: 0, bytes: 0, mb: 0 };
    }
  }

  /**
   * One read of every row carrying an attachment, turned into the two things a
   * pass needs: which files are spoken for, and which rows to clear when a file
   * goes.
   *
   * One query rather than a lookup per file. The alternative — asking the
   * database about each file on disk — is thousands of round trips on the
   * installation this job exists for, which is precisely the one with the most
   * files.
   *
   * Two rows may name the same file, so the map holds a LIST of ids: clearing
   * only the first would leave the second pointing at bytes that are gone.
   */
  static async indexRows() {
    const rows = await tdb('wa_messages')
      .whereNotNull('attachment_path')
      .select('id', 'attachment_path', 'delivery_status');

    const protect = new Set();
    const rowsByPath = new Map();
    for (const row of rows) {
      const absolute = absoluteFor(row.attachment_path);
      if (!absolute) continue;
      if (PENDING_STATUSES.includes(row.delivery_status)) protect.add(absolute);
      const known = rowsByPath.get(absolute);
      if (known) known.push(row.id);
      else rowsByPath.set(absolute, [row.id]);
    }
    // O anexo de uma campanha que ainda vai enviar: um só arquivo para todos
    // os destinatários, e a maioria deles ainda nem virou linha em
    // `wa_messages` — sem isto, o arquivo contaria como órfão.
    const campaigns = await tdb('wa_broadcasts')
      .whereNotNull('attachment_path')
      .whereIn('status', ['draft', 'queued', 'running', 'paused'])
      .pluck('attachment_path');
    for (const relativo of campaigns) {
      const absolute = absoluteFor(relativo);
      if (absolute) protect.add(absolute);
    }
    return { protect, rowsByPath };
  }

  /**
   * Clears the `attachment_*` columns of the rows whose file has just gone.
   *
   * An UPDATE and never a DELETE. The row is the message: its text, who sent
   * it, when it was delivered. What it loses is three columns describing a file
   * that no longer exists, which the thread already knows how to draw.
   *
   * Chunked because a `whereIn` with a five-figure list is a statement some
   * engines refuse to plan and SQLite refuses to parse.
   */
  static async clearAttachments(ids) {
    if (!ids.length) return 0;
    const patch = {
      attachment_path: null,
      attachment_type: null,
      attachment_name: null,
      updated_at: new Date()
    };
    let cleared = 0;
    for (let i = 0; i < ids.length; i += 200) {
      cleared += await tdb('wa_messages').whereIn('id', ids.slice(i, i + 200)).update(patch);
    }
    return cleared;
  }
}

export default WaMediaSweeper;
