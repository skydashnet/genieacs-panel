import CustomerWifiCredential from '../models/CustomerWifiCredential.js';
import { createSecretBox } from '../utils/secretBox.js';

let box;
function secretBox() {
  if (!box) box = createSecretBox('skygenpanel-customer-wifi-password-v1');
  return box;
}

export function encryptPassword(password) {
  return secretBox().encrypt(password);
}

export function decryptPassword(row) {
  return secretBox().decrypt(row);
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
