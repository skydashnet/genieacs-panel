import { tdb, tinsert } from '../config/database.js';

class CustomerWifiCredential {
  static async getByAccountId(accountId) {
    return tdb('customer_wifi_credentials')
      .where({ account_id: accountId })
      .orderBy('wifi_index');
  }

  static async getByAccountAndIndex(accountId, wifiIndex) {
    return (
      (await tdb('customer_wifi_credentials')
        .where({ account_id: accountId, wifi_index: wifiIndex })
        .first()) || null
    );
  }

  static async upsert(record) {
    // The conflict target has to name the unique exactly as 0027 left it,
    // `tenant_id` included. SQLite and Postgres match the clause against a real
    // index and refuse an insert whose target names none; MySQL ignores the
    // target and fires on whichever unique the row actually collided with, so a
    // wrong target there is not an error at all, which is how this would have
    // reached production looking healthy.
    //
    // The provider is not in the merge: it identifies the row rather than
    // describing it, and `tinsert` is the only thing entitled to write it.
    await tinsert('customer_wifi_credentials', record)
      .onConflict(['tenant_id', 'account_id', 'wifi_index'])
      .merge({
        ssid: record.ssid,
        password_ciphertext: record.password_ciphertext,
        password_iv: record.password_iv,
        password_tag: record.password_tag,
        // Must move with the ciphertext it describes: a stale version points
        // decryption at the wrong key and the password is gone.
        password_key_version: record.password_key_version ?? null,
        updated_at: new Date()
      });
    return this.getByAccountAndIndex(record.account_id, record.wifi_index);
  }

  static async updateSsid(accountId, wifiIndex, ssid) {
    return tdb('customer_wifi_credentials')
      .where({ account_id: accountId, wifi_index: wifiIndex })
      .update({ ssid, updated_at: new Date() });
  }
}

export default CustomerWifiCredential;
