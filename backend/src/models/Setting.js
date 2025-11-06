import { executeQuery } from '../config/database.js';

class Setting {
  static async getAll() {
    const query = 'SELECT key, value FROM settings';
    const rows = await executeQuery(query);
    
    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });
    
    return settings;
  }

  static async getByKey(key) {
    const query = 'SELECT value FROM settings WHERE key = ?';
    const rows = await executeQuery(query, [key]);
    return rows.length > 0 ? rows[0].value : null;
  }

  static async create(key, value) {
    const query = 'INSERT INTO settings (key, value) VALUES (?, ?)';
    await executeQuery(query, [key, value]);
    return true;
  }

  static async update(key, value) {
    const query = 'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?';
    const result = await executeQuery(query, [value, key]);
    return result.affectedRows > 0;
  }

  static async upsert(key, value) {
    const exists = await this.getByKey(key);
    if (exists) {
      return await this.update(key, value);
    } else {
      return await this.create(key, value);
    }
  }

  static async delete(key) {
    const query = 'DELETE FROM settings WHERE key = ?';
    const result = await executeQuery(query, [key]);
    return result.affectedRows > 0;
  }
}

export default Setting;