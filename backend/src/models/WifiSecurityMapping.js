import { getDb } from '../config/database.js';

class WifiSecurityMapping {
  static async getByVendor(vendorId) {
    return getDb()('wifi_security_mappings')
      .where({ vendor_id: vendorId })
      .orderBy('raw_security_value', 'asc');
  }

  static async create({ vendor_id, raw_security_value, normalized_security, description }) {
    const [id] = await getDb()('wifi_security_mappings').insert({
      vendor_id,
      raw_security_value,
      normalized_security,
      description
    });
    return id;
  }

  static async update(id, { raw_security_value, normalized_security, description }) {
    const count = await getDb()('wifi_security_mappings')
      .where({ id })
      .update({
        raw_security_value,
        normalized_security,
        description,
        updated_at: getDb().fn.now()
      });
    return count > 0;
  }

  static async delete(id) {
    const count = await getDb()('wifi_security_mappings').where({ id }).del();
    return count > 0;
  }
}

export default WifiSecurityMapping;
