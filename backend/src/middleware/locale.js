import { DEFAULT_LOCALE, negotiateLocale, translate } from '../i18n/index.js';

/**
 * Resolves the response language for every request and exposes `req.t`.
 *
 * The panel sends the operator's chosen language in `Accept-Language`, so the
 * header covers both an explicit choice and the browser default. Responses
 * carry `Content-Language` and vary on the negotiated header so proxies do not
 * serve one language to a client that asked for another.
 */
export function attachLocale(req, res, next) {
  const locale = negotiateLocale(req.headers['accept-language']) || DEFAULT_LOCALE;
  req.locale = locale;
  req.t = (key, vars) => translate(locale, key, vars);
  res.setHeader('Content-Language', locale);
  res.vary('Accept-Language');
  return next();
}

export default attachLocale;
