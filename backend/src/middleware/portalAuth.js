import 'dotenv/config';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import CustomerAccount from '../models/CustomerAccount.js';
import { isRequestSecure } from '../config/proxy.js';
import { DEVELOPMENT_FALLBACK, assertNotPlaceholderSecret, isProduction } from '../config/runtimeEnv.js';
import { subscriptionRefusal } from './subscriptionGate.js';

export const PORTAL_COOKIE_NAME = 'skygp_portal_session';
const PORTAL_SESSION_TTL_SECONDS = 30 * 60;

const baseSecret = process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET;
if (!baseSecret && isProduction()) {
  throw new Error('PORTAL_JWT_SECRET or JWT_SECRET must be set in production');
}
assertNotPlaceholderSecret('PORTAL_JWT_SECRET', process.env.PORTAL_JWT_SECRET);
const portalSecret = process.env.PORTAL_JWT_SECRET || crypto
  .createHmac('sha256', baseSecret || DEVELOPMENT_FALLBACK)
  .update('skygenpanel-customer-portal-v1')
  .digest('hex');

function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

/**
 * Qual senha do portal esta sessão provou, sem carregar a senha nem o hash.
 *
 * O cookie vive meia hora e, até aqui, só `active` e `customer_id` eram
 * relidos a cada requisição: quando o operador redefinia a senha do portal —
 * justamente porque alguém que não devia a tinha —, quem já estava dentro
 * seguia dentro até o cookie vencer. Agora o cookie leva uma impressão do
 * `password_hash` do momento do login, e a guarda compara com o hash de agora.
 *
 * Do hash, e não de `password_updated_at` contra o `iat`, porque é exato: o
 * bcrypt tem sal, então TODA redefinição muda o hash, mesmo no mesmo segundo do
 * login; o `iat` tem resolução de segundo e o `timestamp` do MySQL arredonda,
 * então a comparação de relógios ou deixa passar o cookie do mesmo segundo ou
 * recusa o login feito logo depois da troca. E o apagamento dos dados do
 * assinante zera o hash, o que também encerra a sessão. É um sha256 truncado de
 * um bcrypt: o payload do JWT é legível por quem tem o cookie, e isto não
 * serve para nada fora desta comparação.
 */
function passwordFingerprint(account) {
  const hash = account?.password_hash;
  if (!hash) return null;
  return crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 22);
}

/**
 * A sessão ainda corresponde à senha atual do portal?
 *
 * Cookies de antes da impressão não a trazem; para esses, a regra de relógio:
 * emitido antes da última troca de senha, recusado. Em segundos inteiros,
 * porque é a resolução do `iat` — some em meia hora, quando o último deles vencer.
 */
function sessionMatchesPassword(decoded, account) {
  // Comparação simples, sem tempo constante: a impressão vem de um JWT
  // assinado, então quem chama não escolhe o valor que está sendo comparado.
  if (decoded.pwd !== undefined) {
    const atual = passwordFingerprint(account);
    return Boolean(atual) && decoded.pwd === atual;
  }
  const trocadaEm = account.password_updated_at ? new Date(account.password_updated_at).getTime() : NaN;
  if (!Number.isFinite(trocadaEm)) return true;
  return Number(decoded.iat) >= Math.floor(trocadaEm / 1000);
}

/**
 * The provider travels in the payload, and that is belt as well as braces.
 *
 * The braces already hold: `CustomerAccount.getById` below reads through `tdb`,
 * so a cookie minted on one provider's portal finds no account under the host
 * it is replayed at and is refused. But that refusal lives in the SHAPE of a
 * query rather than in the session, and a future reader that forgets the
 * filter would turn a replayed cookie into a working one. Signing the provider
 * makes the refusal a fact about the cookie instead.
 */
export function signPortalSession(account) {
  return jwt.sign(
    {
      accountId: account.id,
      customerId: account.customer_id,
      tenantId: Number(account.tenant_id),
      // Ver `passwordFingerprint`: redefinir a senha encerra este cookie.
      pwd: passwordFingerprint(account),
      tokenType: 'customer'
    },
    portalSecret,
    {
      expiresIn: PORTAL_SESSION_TTL_SECONDS,
      issuer: 'skygenpanel',
      audience: 'skygenpanel-customer-portal'
    }
  );
}

export function portalCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isRequestSecure(req),
    maxAge: PORTAL_SESSION_TTL_SECONDS * 1000,
    path: '/'
  };
}

export function portalClearCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isRequestSecure(req),
    path: '/'
  };
}

export async function authenticatePortalCustomer(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[PORTAL_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionRequired'),
        code: 'customer_session_required'
      });
    }
    const decoded = jwt.verify(token, portalSecret, {
      issuer: 'skygenpanel',
      audience: 'skygenpanel-customer-portal'
    });
    if (decoded.tokenType !== 'customer' || !decoded.accountId) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionInvalid'),
        code: 'customer_session_invalid'
      });
    }
    // A cookie that names a provider other than the host's is refused before
    // the account is even read. Cookies minted before this field existed carry
    // no `tenantId` and are left to the scoped read below, which is what kept
    // them safe until now — a session in flight during an upgrade should not
    // be thrown away.
    if (decoded.tenantId !== undefined && Number(decoded.tenantId) !== Number(req.tenantId)) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionInvalid'),
        code: 'customer_session_invalid'
      });
    }
    const account = await CustomerAccount.getById(decoded.accountId);
    if (
      !account
      || !account.active
      || account.customer_id !== decoded.customerId
      || !sessionMatchesPassword(decoded, account)
    ) {
      return res.status(401).json({
        success: false,
        message: req.t('portal.sessionStale'),
        code: 'customer_session_invalid'
      });
    }
    req.customer = account;
    // Depois da sessão do assinante, pelo mesmo motivo do painel: quem não tem
    // sessão recebe 401 e nunca aprende nada sobre a fatura do provedor. E
    // `past_due` passa por aqui inteiro — o assinante não é quem deve.
    const recusa = await subscriptionRefusal(req, { portal: true });
    if (recusa) return res.status(402).json(recusa);
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: req.t('portal.sessionExpired'),
      code: 'customer_session_expired'
    });
  }
}
