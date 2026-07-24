import 'dotenv/config';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import CustomerAccount from '../models/CustomerAccount.js';

export const PORTAL_COOKIE_NAME = 'skygp_portal_session';
const PORTAL_SESSION_TTL_SECONDS = 30 * 60;

const baseSecret = process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET;
if (!baseSecret && process.env.APP_ENV === 'production') {
  throw new Error('PORTAL_JWT_SECRET or JWT_SECRET must be set in production');
}
const portalSecret = process.env.PORTAL_JWT_SECRET || crypto
  .createHmac('sha256', baseSecret || 'insecure-development-secret')
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

export function signPortalSession(account) {
  return jwt.sign(
    { accountId: account.id, customerId: account.customer_id, tokenType: 'customer' },
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
    secure: req.secure,
    maxAge: PORTAL_SESSION_TTL_SECONDS * 1000,
    path: '/'
  };
}

export async function authenticatePortalCustomer(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[PORTAL_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Customer session required' });
    }
    const decoded = jwt.verify(token, portalSecret, {
      issuer: 'skygenpanel',
      audience: 'skygenpanel-customer-portal'
    });
    if (decoded.tokenType !== 'customer' || !decoded.accountId) {
      return res.status(401).json({ success: false, message: 'Invalid customer session' });
    }
    const account = await CustomerAccount.getById(decoded.accountId);
    if (!account || !account.active || account.customer_id !== decoded.customerId) {
      return res.status(401).json({ success: false, message: 'Customer session is no longer valid' });
    }
    req.customer = account;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Customer session expired',
      code: 'customer_session_expired'
    });
  }
}
