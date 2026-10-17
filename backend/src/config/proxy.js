import 'dotenv/config';

/**
 * Express `trust proxy` value derived from TRUST_PROXY.
 *
 * Unset or `0` keeps the proxy headers untrusted, which is the only safe
 * default when the listeners are reachable directly (`skygenpanel expose`).
 * A hop count such as `1` is correct when a reverse proxy or Cloudflare Tunnel
 * on the same host is the only way in: without it every client collapses into
 * a single rate-limit bucket and `req.secure` never sees the terminated TLS.
 */
export function parseTrustProxy(raw = process.env.TRUST_PROXY) {
  const value = String(raw ?? '').trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return null;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const TRUST_PROXY = parseTrustProxy();

/**
 * Whether the browser reached us over HTTPS. `req.secure` already accounts for
 * X-Forwarded-Proto once `trust proxy` is configured; the override exists for
 * proxies that terminate TLS without advertising it.
 */
export function isRequestSecure(req) {
  const override = String(process.env.PORTAL_COOKIE_SECURE ?? 'auto').trim().toLowerCase();
  if (override === 'true' || override === '1') return true;
  if (override === 'false' || override === '0') return false;
  return Boolean(req.secure);
}
