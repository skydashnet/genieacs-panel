import crypto from 'node:crypto';

/**
 * Constant-time comparison. `crypto.timingSafeEqual` throws when the buffers
 * differ in length, so the length is checked first — that leak is unavoidable
 * and harmless for a fixed-width digest.
 */
export function timingSafeCompare(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return false;
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const SIGNATURE_HEADERS = Object.freeze([
  'x-sgp-signature', 'x-signature', 'x-hub-signature-256', 'x-webhook-signature'
]);
const TIMESTAMP_HEADERS = Object.freeze(['x-sgp-timestamp', 'x-timestamp', 'x-webhook-timestamp']);

export function readSignatureHeader(headers) {
  for (const name of SIGNATURE_HEADERS) {
    const value = headers?.[name];
    if (value) return String(value).trim();
  }
  return null;
}

export function readTimestampHeader(headers) {
  for (const name of TIMESTAMP_HEADERS) {
    const value = headers?.[name];
    if (value) return String(value).trim();
  }
  return null;
}

/** Seconds since the epoch from either an epoch value or an ISO timestamp. */
function parseTimestamp(value) {
  if (!value) return null;
  if (/^\d{9,13}$/.test(value)) {
    const numeric = Number(value);
    return numeric > 1e11 ? Math.trunc(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.trunc(parsed / 1000);
}

function digestsFor(rawBody, secret, timestamp) {
  // Two conventions are accepted: the body alone, and Stripe's
  // `<timestamp>.<body>`. Which one this provider's SGP uses is unknown, and
  // both require the shared secret, so accepting either costs nothing.
  const payloads = [rawBody];
  if (timestamp) payloads.push(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]));
  return payloads.map((payload) => crypto.createHmac('sha256', secret).update(payload).digest());
}

function candidateBuffers(signature) {
  const cleaned = signature.replace(/^sha256[=\s]/i, '').trim();
  const buffers = [];
  if (/^[0-9a-f]+$/i.test(cleaned) && cleaned.length % 2 === 0) {
    buffers.push(Buffer.from(cleaned, 'hex'));
  }
  if (/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    buffers.push(Buffer.from(cleaned, 'base64'));
  }
  return buffers;
}

/**
 * Verifies an inbound webhook against the shared secret.
 *
 * Header name, digest encoding and signed payload are all accepted in several
 * shapes because SGP's exact convention is not documented for integrators.
 * Everything accepted still requires the secret; nothing here weakens the
 * check. The reason string is for the panel's own event log — the response
 * itself never says which part failed.
 */
export function verifyWebhookSignature({
  rawBody,
  secret,
  headers = {},
  toleranceSeconds = 300,
  requireTimestamp = false
}) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  const signature = readSignatureHeader(headers);
  if (!signature) return { ok: false, reason: 'missing_signature' };

  const timestampHeader = readTimestampHeader(headers);
  const timestamp = parseTimestamp(timestampHeader);
  if (requireTimestamp) {
    if (timestamp === null) return { ok: false, reason: 'missing_timestamp' };
    const drift = Math.abs(Math.trunc(Date.now() / 1000) - timestamp);
    if (drift > toleranceSeconds) return { ok: false, reason: 'stale_timestamp' };
  }

  const provided = candidateBuffers(signature);
  if (provided.length === 0) return { ok: false, reason: 'invalid_signature' };

  const expected = digestsFor(rawBody, secret, timestampHeader);
  for (const candidate of provided) {
    for (const digest of expected) {
      if (timingSafeCompare(candidate, digest)) return { ok: true, reason: null };
    }
  }
  return { ok: false, reason: 'invalid_signature' };
}
