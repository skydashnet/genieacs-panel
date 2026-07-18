import { getDb } from '../config/database.js';

function withArray(row) {
  if (!row) return null;
  return {
    ...row,
    security_types_array: row.security_types ? row.security_types.split(',') : []
  };
}

class WifiSecurityConfig {
  static async getAll() {
    const rows = await getDb()('wifi_security_config').orderBy('product_class', 'asc');
    return rows.map(withArray);
  }

  static async getById(id) {
    const row = await getDb()('wifi_security_config').where({ id }).first();
    return withArray(row);
  }

  static async getByProductClass(productClass) {
    const row = await getDb()('wifi_security_config')
      .whereRaw('LOWER(product_class) = LOWER(?)', [productClass])
      .first();
    return withArray(row);
  }

  static async create(configData) {
    const { product_class, security_types, password_param_path } = configData;
    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    const [id] = await getDb()('wifi_security_config').insert({
      product_class,
      security_types: securityTypesString,
      password_param_path
    });
    return id;
  }

  static async update(id, configData) {
    const { product_class, security_types, password_param_path } = configData;
    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    const count = await getDb()('wifi_security_config').where({ id }).update({
      product_class,
      security_types: securityTypesString,
      password_param_path,
      updated_at: getDb().fn.now()
    });
    return count > 0;
  }

  static async delete(id) {
    const count = await getDb()('wifi_security_config').where({ id }).del();
    return count > 0;
  }
}

export default WifiSecurityConfig;
