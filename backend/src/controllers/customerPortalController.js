import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import CustomerService from '../services/customerService.js';
import DeviceService from '../services/deviceService.js';
import {
  PORTAL_COOKIE_NAME,
  portalCookieOptions,
  signPortalSession
} from '../middleware/portalAuth.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

class CustomerPortalController {
  static overviewCache = new Map();

  static async login(req, res) {
    try {
      const customerId = CustomerService.normalizeCustomerId(req.body?.customerId);
      const password = String(req.body?.password ?? '').trim();
      if (!customerId || !/^\d{6}$/.test(password)) {
        return res.status(401).json(createErrorResponse('ID Customer atau password salah'));
      }

      const account = await CustomerAccount.getByCustomerId(customerId);
      const expectedPassword = CustomerService.passwordForCustomerId(customerId);
      if (!account || !safeEqual(password, expectedPassword)) {
        return res.status(401).json(createErrorResponse('ID Customer atau password salah'));
      }

      res.cookie(PORTAL_COOKIE_NAME, signPortalSession(account), portalCookieOptions(req));
      return res.json(createResponse('Login pelanggan berhasil', {
        customerId: account.customer_id
      }));
    } catch (error) {
      console.error('Customer portal login error:', error);
      return res.status(500).json(createErrorResponse('Portal pelanggan tidak dapat memproses login'));
    }
  }

  static async session(req, res) {
    return res.json(createResponse('Sesi pelanggan aktif', {
      customerId: req.customer.customer_id
    }));
  }

  static async overview(req, res) {
    try {
      const cacheKey = String(req.customer.id);
      const cached = CustomerPortalController.overviewCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json(createResponse('Informasi ONT tersedia', {
          customerId: req.customer.customer_id,
          ...cached.data
        }));
      }

      const data = await DeviceService.getCustomerPortalOverview(req.customer.device_id);
      CustomerPortalController.overviewCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + 30_000
      });
      return res.json(createResponse('Informasi ONT tersedia', {
        customerId: req.customer.customer_id,
        ...data
      }));
    } catch (error) {
      console.error('Customer portal overview error:', error);
      if (error.message === 'Device not found') {
        return res.status(404).json(createErrorResponse(
          'ONT tidak ditemukan. Hubungi penyedia layanan untuk memeriksa registrasi perangkat.'
        ));
      }
      return res.status(502).json(createErrorResponse(
        'Data ONT sedang tidak dapat diambil. Coba lagi beberapa saat.'
      ));
    }
  }

  static async logout(req, res) {
    res.clearCookie(PORTAL_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/'
    });
    return res.json(createResponse('Sesi pelanggan telah berakhir'));
  }
}

export default CustomerPortalController;
