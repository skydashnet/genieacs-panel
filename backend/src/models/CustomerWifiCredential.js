import { getDb } from '../config/database.js';

class CustomerWifiCredential {
  static async getByAccountId(accountId) {
    return getDb()('customer_wifi_credentials')
      .where({ account_id: accountId })
      .orderBy('wifi_index');
  }

  static async getByAccountAndIndex(accountId, wifiIndex) {
    return (
      (await getDb()('customer_wifi_credentials')
        .where({ account_id: accountId, wifi_index: wifiIndex })
        .first()) || null
    );
  }

  static async upsert(record) {
    const db = getDb();
    await db('customer_wifi_credentials')
      .insert(record)
      .onConflict(['account_id', 'wifi_index'])
      .merge({
        ssid: record.ssid,
        password_ciphertext: record.password_ciphertext,
        password_iv: record.password_iv,
        password_tag: record.password_tag,
        updated_at: new Date()
      });
    return this.getByAccountAndIndex(record.account_id, record.wifi_index);
  }

  static async updateSsid(accountId, wifiIndex, ssid) {
    return getDb()('customer_wifi_credentials')
      .where({ account_id: accountId, wifi_index: wifiIndex })
      .update({ ssid, updated_at: new Date() });
  }
}

export default CustomerWifiCredential;
