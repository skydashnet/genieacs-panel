import 'dotenv/config';
import crypto from 'node:crypto';
import { DEVELOPMENT_FALLBACK, isProduction } from '../../config/runtimeEnv.js';

/**
 * The credential on `GET /api/whatsapp-media/:id`.
 *
 * That route is fetched by the Evolution server, which has no session and no
 * cookie: the only thing it carries is what the panel put in the URL when it
 * despatched the message. So the URL itself is the credential, and everything
 * that makes it safe to hand out lives here — one place, because the outbox
 * mints and the route verifies, and a signer and a verifier that drift apart
 * fail open rather than closed.
 *
 * The key is derived from `JWT_SECRET` under a context string of its own, the
 * same construction `secretBox.js` uses for stored secrets. A dedicated
 * derivation is not ceremony: `JWT_SECRET` used raw as an HMAC key here would
 * mean a media link and a session token are signed by the same key, and the
 * whole point of a per-context key is that a weakness in one use can never be
 * spent on another.
 *
 * There is no key VERSION here, unlike `secretBox`, and deliberately: a link
 * lives fifteen minutes. Rotating the base secret invalidates whatever is in
 * flight, the outbox mints a new link on the next attempt, and there is nothing
 * stored to read back and so nothing to lose.
 */

/**
 * Fifteen minutes.
 *
 * The Evolution server fetches at despatch time — it is answering the request
 * that gave it this URL — so the window only has to cover one round trip and a
 * slow queue. What it must NOT do is outlive the send: a link that survives is
 * a customer's file readable by anyone who ever saw the URL, in a proxy log or
 * a server's own access log, for as long as the file exists.
 */
export const MEDIA_TOKEN_TTL_MS = 15 * 60 * 1000;

const CONTEXT = 'wa-media';


let cachedKey = null;
let cachedFrom = null;

function signingKey() {
  if (!process.env.JWT_SECRET && isProduction()) {
    throw new Error('JWT_SECRET must be set to sign WhatsApp media links');
  }
  const base = process.env.JWT_SECRET || DEVELOPMENT_FALLBACK;
  // Derived once and remembered, but remembered against the secret that
  // produced it: a process whose JWT_SECRET changes under it must not keep
  // signing with the old one.
  if (cachedKey && cachedFrom === base) return cachedKey;
  cachedKey = crypto.createHmac('sha256', base).update(CONTEXT).digest();
  cachedFrom = base;
  return cachedKey;
}

/**
 * The signature over one id and one expiry.
 *
 * `exp` is used as the STRING that appears in the token rather than as a
 * number, so the bytes signed are the bytes presented: re-serialising it would
 * let `0900` and `900` differ in the token and agree in the HMAC input.
 */
function digest(id, exp) {
  return crypto.createHmac('sha256', signingKey())
    .update(`${id}.${exp}`)
    .digest('hex');
}

/**
 * Mints `<exp>.<hmac>` for one message id.
 *
 * @param {number|string} id `wa_messages.id`
 * @returns {string}
 */
export function sign(id, now = Date.now()) {
  const exp = String(Math.floor((now + MEDIA_TOKEN_TTL_MS) / 1000));
  return `${exp}.${digest(String(id), exp)}`;
}

/**
 * Whether `token` was minted here, for THIS id, and has not expired.
 *
 * The comparison is constant time. `timingSafeEqual` throws when the buffers
 * differ in length — which a hand-made token trivially arranges — so the length
 * is checked first: a mismatch is a bad token, not a 500.
 *
 * @returns {boolean}
 */
export function verify(id, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [exp, provided] = parts;
  // Digits only: `Number('12e9')` and `Number(' 12')` both parse, and neither
  // is anything this signer ever wrote.
  if (!/^[0-9]{1,15}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now) return false;

  const expected = Buffer.from(digest(String(id), exp), 'utf8');
  const presented = Buffer.from(provided, 'utf8');
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/** The `t` of a query string as one string. Express hands an array for `?t=a&t=b`. */
export function tokenFromQuery(query) {
  const raw = query?.t;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return '';
}
