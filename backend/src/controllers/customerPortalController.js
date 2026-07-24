import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import CustomerService from '../services/customerService.js';
import CustomerWifiCredentialService from '../services/customerWifiCredentialService.js';
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
      const deviceData = cached && cached.expiresAt > Date.now()
        ? cached.data
        : await DeviceService.getCustomerPortalOverview(req.customer.device_id);
      if (!cached || cached.expiresAt <= Date.now()) {
        // Cache only non-secret GenieACS data. Decrypted passwords are loaded
        // per authenticated request and never retained in process memory.
        CustomerPortalController.overviewCache.set(cacheKey, {
          data: deviceData,
          expiresAt: Date.now() + 30_000
        });
      }
      const savedCredentials = await CustomerWifiCredentialService.getSavedPasswordStatus(
        req.customer.id
      );
      const data = {
        ...deviceData,
        wifi: deviceData.wifi.map((network) => ({
          ...network,
          hasSavedPassword: Boolean(
            savedCredentials.get(Number(network.index))?.hasPassword
          )
        }))
      };
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

  static async updateWifi(req, res) {
    try {
      const wifiIndex = Number(req.body?.index);
      const ssid = String(req.body?.ssid ?? '').trim();
      const password = req.body?.password === undefined
        ? ''
        : String(req.body.password);

      if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
        return res.status(400).json(createErrorResponse('Jaringan WiFi tidak valid'));
      }
      if (!ssid || ssid.length > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) {
        return res.status(400).json(createErrorResponse(
          'Nama WiFi harus berisi 1 sampai 32 karakter tanpa karakter kontrol'
        ));
      }
      if (password && !/^[\x20-\x7e]{8,63}$/.test(password)) {
        return res.status(400).json(createErrorResponse(
          'Password WiFi harus terdiri dari 8 sampai 63 karakter'
        ));
      }

      // The device target is resolved only from the authenticated account.
      // Never accept a device ID supplied by the browser.
      const current = await DeviceService.getCustomerPortalOverview(
        req.customer.device_id
      );
      const network = current.wifi.find((entry) => Number(entry.index) === wifiIndex);
      if (!network) {
        return res.status(404).json(createErrorResponse(
          'Jaringan WiFi tersebut tidak dilaporkan oleh ONT'
        ));
      }

      await DeviceService.updateWifiConfig(req.customer.device_id, wifiIndex, {
        ssid,
        password
      });
      await CustomerWifiCredentialService.save(
        req.customer.id,
        wifiIndex,
        ssid,
        password
      );
      CustomerPortalController.overviewCache.delete(String(req.customer.id));
      DeviceService.dashboardCache.expiresAt = 0;

      return res.json(createResponse(
        'Perubahan WiFi dikirim ke ONT. Perangkat dapat terputus beberapa saat.',
        { index: wifiIndex, ssid }
      ));
    } catch (error) {
      console.error('Customer portal WiFi update error:', error);
      if (error.message === 'Device not found') {
        return res.status(404).json(createErrorResponse('ONT tidak ditemukan'));
      }
      if (/^WiFi /.test(error.message)) {
        return res.status(400).json(createErrorResponse(error.message));
      }
      return res.status(502).json(createErrorResponse(
        'Perubahan WiFi belum dapat dikirim. Coba lagi beberapa saat.'
      ));
    }
  }

  static async revealWifiPassword(req, res) {
    try {
      const wifiIndex = Number(req.params?.index);
      if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
        return res.status(400).json(createErrorResponse('Jaringan WiFi tidak valid'));
      }
      const password = await CustomerWifiCredentialService.reveal(
        req.customer.id,
        wifiIndex
      );
      if (!password) {
        return res.status(404).json(createErrorResponse(
          'Password jaringan ini belum pernah disimpan melalui portal'
        ));
      }
      return res.json(createResponse('Password WiFi tersedia', { password }));
    } catch (error) {
      console.error('Customer portal WiFi password reveal error:', error);
      return res.status(500).json(createErrorResponse(
        'Password WiFi belum dapat dibuka. Coba lagi beberapa saat.'
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
