import { executeQuery } from '../config/database.js';

class WifiSecurityConfig {
  static async getAll() {
    const query = 'SELECT * FROM wifi_security_config ORDER BY product_class ASC';
    const rows = await executeQuery(query);
    
    return rows.map(row => ({
      ...row,
      security_types_array: row.security_types ? row.security_types.split(',') : []
    }));
  }

  static async getById(id) {
    const query = 'SELECT * FROM wifi_security_config WHERE id = ?';
    const rows = await executeQuery(query, [id]);
    
    if (rows.length === 0) return null;
    
    const config = rows[0];
    return {
      ...config,
      security_types_array: config.security_types ? config.security_types.split(',') : []
    };
  }

  static async getByProductClass(productClass) {
    const query = 'SELECT * FROM wifi_security_config WHERE LOWER(product_class) = LOWER(?)';
    const rows = await executeQuery(query, [productClass]);
    
    if (rows.length === 0) return null;
    
    const config = rows[0];
    return {
      ...config,
      security_types_array: config.security_types ? config.security_types.split(',') : []
    };
  }

  static async create(configData) {
    const {
      product_class,
      security_types,
      password_param_path
    } = configData;

    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    const query = `
      INSERT INTO wifi_security_config (product_class, security_types, password_param_path)
      VALUES (?, ?, ?)
    `;
    
    const result = await executeQuery(query, [product_class, securityTypesString, password_param_path]);
    return result.insertId;
  }

  static async update(id, configData) {
    const {
      product_class,
      security_types,
      password_param_path
    } = configData;

    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    const query = `
      UPDATE wifi_security_config SET 
        product_class = ?, security_types = ?, password_param_path = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    
    const result = await executeQuery(query, [
      product_class, securityTypesString, password_param_path, id
    ]);
    
    return result.affectedRows > 0;
  }

  static async delete(id) {
    const query = 'DELETE FROM wifi_security_config WHERE id = ?';
    const result = await executeQuery(query, [id]);
    return result.affectedRows > 0;
  }
}

export default WifiSecurityConfig;