import { getDb } from '../config/database.js';

class Setting {
  static async getAll() {
    const rows = await getDb()('settings').select('key', 'value');
    const settings = {};
    rows.forEach((row) => {
      settings[row.key] = row.value;
    });
    return settings;
  }

  static async getByKey(key) {
    const row = await getDb()('settings').where({ key }).first();
    return row ? row.value : null;
  }

  static async create(key, value) {
    await getDb()('settings').insert({ key, value });
    return true;
  }

  static async update(key, value) {
    const affected = await getDb()('settings')
      .where({ key })
      .update({ value, updated_at: new Date() });
    return affected > 0;
  }

  static async upsert(key, value) {
    const exists = await this.getByKey(key);
    if (exists !== null) {
      return await this.update(key, value);
    }
    return await this.create(key, value);
  }

  static async delete(key) {
    const affected = await getDb()('settings').where({ key }).del();
    return affected > 0;
  }
}

export default Setting;
