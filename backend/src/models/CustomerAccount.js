import { getDb } from '../config/database.js';

class CustomerAccount {
  static async getAll() {
    return getDb()('customer_accounts').orderBy('created_at', 'desc');
  }

  static async getById(id) {
    return (await getDb()('customer_accounts').where({ id }).first()) || null;
  }

  static async getByCustomerId(customerId) {
    return (
      (await getDb()('customer_accounts')
        .where({ customer_id: customerId, active: true })
        .first()) || null
    );
  }

  static async getByDeviceId(deviceId) {
    return (await getDb()('customer_accounts').where({ device_id: deviceId }).first()) || null;
  }

  static async getByIdentityHash(identityHash) {
    return (
      (await getDb()('customer_accounts').where({ identity_hash: identityHash }).first()) || null
    );
  }

  static async create(account) {
    const [id] = await getDb()('customer_accounts').insert(account);
    return this.getById(id);
  }

  static async touch(id, deviceId) {
    await getDb()('customer_accounts').where({ id }).update({
      device_id: deviceId,
      last_seen_at: new Date(),
      updated_at: new Date()
    });
    return this.getById(id);
  }

  static async getIdsByDeviceIds(deviceIds) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return [];
    return getDb()('customer_accounts')
      .select('device_id', 'customer_id')
      .whereIn('device_id', deviceIds);
  }
}

export default CustomerAccount;
