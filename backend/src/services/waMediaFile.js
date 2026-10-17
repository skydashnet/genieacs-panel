import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';

/**
 * Turning `wa_messages.attachment_path` back into bytes on the wire.
 *
 * Two routes fetch the same file for two different audiences — the operator
 * with a session, the Evolution server with a signed link — and both go through
 * here, because everything dangerous about serving that file is the same for
 * both and must not be written twice.
 *
 * The danger is one column. `attachment_path` was written by `waMediaService`
 * from a file name that arrived in a webhook payload from a stranger's phone;
 * it is sanitised there, but "sanitised at write time, three releases ago" is
 * not a property this module can check. So the path is re-resolved and
 * re-confined here, on every read, and a path that lands outside `DATA_DIR` is
 * simply not a file we have.
 *
 * WHY THERE IS NO PROVIDER CHECK HERE, AND WHY THAT IS NOT AN OVERSIGHT
 *
 * Since wave 8 a stored path names the provider that wrote it —
 * `wa-media/t<id>/<conversa>/` — while a row written before it does not. This
 * module reads both without knowing the difference, deliberately: the string is
 * a location, not a claim, and the file it names is the one whose row the
 * caller was already allowed to read. The operator's route reaches the row
 * through `tdb`, so another provider's message does not exist to it; the
 * Evolution route reaches it through a signature only the panel can mint, for
 * one id it chose itself. Comparing the path against the provider in scope
 * would add nothing to either, and would break every pre-wave-8 row on a panel
 * that has more than one provider — the exact rows the contract froze as
 * still-serviceable.
 */

/** Every stored attachment lives under here, and nothing may resolve outside it. */
const ROOT = path.resolve(DATA_DIR);

/** Whether `candidate` is ROOT itself or something inside it. */
function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * ROOT with every symlink already followed, remembered after the first call.
 *
 * Needed because the textual check below compares strings, and a symlink is
 * exactly the case where the string and the file disagree. Resolving ROOT too,
 * rather than only the file, is what keeps a deployment whose DATA_DIR is
 * ITSELF reached through a symlink — `/var/data` → `/mnt/volume`, which is how
 * a moved volume usually looks — from rejecting every attachment it holds.
 */
let realRootCache = null;
async function realRoot() {
  if (realRootCache) return realRootCache;
  try {
    realRootCache = await fsp.realpath(ROOT);
  } catch {
    // DATA_DIR not created yet: fall back to the lexical root. Nothing is
    // served either way until a file exists under it.
    realRootCache = ROOT;
  }
  return realRootCache;
}

/**
 * The types that may be rendered in place.
 *
 * SVG is missing on purpose and the omission is the entire point of the list.
 * An SVG is a document with script in it; served inline it runs on the panel's
 * own origin, where the operator's session lives. The customer picks the file,
 * so "our own origin" would be theirs to script.
 */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

const FALLBACK_TYPE = 'application/octet-stream';

/** A MIME type is `type/subtype` and nothing else — parameters and all. */
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/;

/**
 * The stored type, or the safe default.
 *
 * The column holds whatever `Content-Type` some other server sent, truncated to
 * 128 characters. Echoing that into a response header unchecked is how a
 * newline in a stored string becomes a header of the attacker's choosing, so
 * anything that is not plainly a MIME type becomes the type that means
 * "unknown bytes".
 */
export function safeContentType(attachmentType) {
  const first = String(attachmentType || '').split(';')[0].trim().toLowerCase();
  return MIME.test(first) ? first : FALLBACK_TYPE;
}

/**
 * `inline` or `attachment`, and never `inline` for anything but a known image.
 *
 * Defaulting to `attachment` rather than to `inline` is what makes an unknown
 * or a spoofed type harmless: the browser saves it instead of deciding for
 * itself what to do with it.
 */
export function dispositionFor(attachmentType) {
  return INLINE_TYPES.has(safeContentType(attachmentType)) ? 'inline' : 'attachment';
}

/**
 * A `Content-Disposition` a browser and a header parser both read the same way.
 *
 * The ASCII `filename` is stripped down to characters that cannot end the
 * quoted string or the header; the RFC 5987 `filename*` carries the real name
 * for everything written this century. A name that survives to neither is left
 * out entirely rather than guessed at.
 */
export function contentDisposition(mode, name) {
  const raw = String(name || '').replace(/[\r\n]/g, '').slice(0, 200);
  if (!raw) return mode;
  const ascii = raw.replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'file';
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/**
 * The file one message's `attachment_path` names, or null.
 *
 * `null` for every way this can fail — no attachment, an escaping path, a row
 * whose file is gone — because the caller answers all of them with the same
 * 404, and a caller that had to tell them apart would be tempted to say which.
 *
 * @returns {Promise<{ absolutePath: string, size: number, type: string, name: string|null }|null>}
 */
export async function resolveStoredAttachment(row) {
  const relative = String(row?.attachment_path || '').trim();
  if (!relative) return null;

  // `path.resolve` collapses `..` BEFORE the prefix is checked, which is the
  // only order that works: comparing the raw string would pass
  // `wa-media/../../etc/passwd` and then open exactly that file. An absolute
  // stored path is also handled by this — `resolve` discards ROOT and the
  // result fails the prefix test below.
  const absolutePath = path.resolve(ROOT, relative);
  if (!inside(ROOT, absolutePath)) return null;

  let stat;
  let real;
  try {
    stat = await fsp.stat(absolutePath);
    // Checked a second time, on the path with the symlinks followed. The
    // lexical check above cannot see a link: `wa-media/x.jpg` pointing at
    // `/etc/shadow` passes it and then opens exactly that file.
    real = await fsp.realpath(absolutePath);
  } catch {
    return null;
  }
  if (!inside(await realRoot(), real)) return null;
  // A directory, a fifo or a device node is not an attachment. Streaming a
  // fifo would hold the response open for as long as nobody writes to it.
  if (!stat.isFile()) return null;

  return {
    // The resolved real path, so the file that was checked is the file that is
    // opened: anything else reopens by name and invites the swap in between.
    absolutePath: real,
    size: stat.size,
    type: safeContentType(row.attachment_type),
    name: row.attachment_name ? String(row.attachment_name) : null
  };
}

/**
 * Streams a resolved attachment.
 *
 * Streamed rather than read into memory: a 25 MB file per concurrent request is
 * a real amount of a small VPS's memory, and the ceiling on the stored file was
 * never a ceiling on how many are fetched at once.
 */
export function streamAttachment(res, resolved) {
  res.setHeader('Content-Type', resolved.type);
  res.setHeader('Content-Length', String(resolved.size));
  res.setHeader('Content-Disposition', contentDisposition(
    dispositionFor(resolved.type),
    resolved.name
  ));
  // Belt and braces with the disposition above: without it a browser may sniff
  // a file we called `application/octet-stream` and decide it is HTML.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(resolved.absolutePath);
  stream.on('error', () => {
    // The stat succeeded a moment ago, so this is a file that went away or a
    // permission that changed mid-flight. The headers are already out, so there
    // is no status left to send — destroy the socket rather than end a
    // truncated body that looks complete.
    res.destroy();
  });
  stream.pipe(res);
}

export default { resolveStoredAttachment, streamAttachment, dispositionFor, safeContentType };
