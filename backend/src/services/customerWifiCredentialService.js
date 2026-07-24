import 'dotenv/config';
import crypto from 'node:crypto';
import CustomerWifiCredential from '../models/CustomerWifiCredential.js';

const baseSecret = process.env.JWT_SECRET;
if (!baseSecret && process.env.APP_ENV === 'production') {
  throw new Error('JWT_SECRET must be set to protect saved customer WiFi passwords');
}
const encryptionKey = crypto
  .createHmac('sha256', baseSecret || 'insecure-development-secret')
  .update('skygenpanel-customer-wifi-password-v1')
  .digest();

export function encryptPassword(password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(password, 'utf8'),
    cipher.final()
  ]);
  return {
    password_ciphertext: ciphertext.toString('base64'),
    password_iv: iv.toString('base64'),
    password_tag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptPassword(row) {
  if (!row?.password_ciphertext || !row?.password_iv || !row?.password_tag) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(row.password_iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(row.password_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.password_ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return null;
  }
}

class CustomerWifiCredentialService {
  static async getSavedPasswordStatus(accountId) {
    const rows = await CustomerWifiCredential.getByAccountId(accountId);
    return new Map(rows.map((row) => [
      Number(row.wifi_index),
      {
        ssid: row.ssid,
        hasPassword: Boolean(
          row.password_ciphertext && row.password_iv && row.password_tag
        )
      }
    ]));
  }

  static async reveal(accountId, wifiIndex) {
    const row = await CustomerWifiCredential.getByAccountAndIndex(accountId, wifiIndex);
    return decryptPassword(row);
  }

  static async save(accountId, wifiIndex, ssid, password) {
    if (!password) {
      await CustomerWifiCredential.updateSsid(accountId, wifiIndex, ssid);
      return;
    }
    await CustomerWifiCredential.upsert({
      account_id: accountId,
      wifi_index: wifiIndex,
      ssid,
      ...encryptPassword(password)
    });
  }
}

export default CustomerWifiCredentialService;
