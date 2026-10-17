import { tdb, tinsert } from '../config/database.js';

class Setting {
  static async getAll() {
    const rows = await tdb('settings').select('key', 'value');
    const settings = {};
    rows.forEach((row) => {
      settings[row.key] = row.value;
    });
    return settings;
  }

  static async getByKey(key) {
    const row = await tdb('settings').where({ key }).first();
    return row ? row.value : null;
  }

  static async create(key, value) {
    await tinsert('settings', { key, value });
    return true;
  }

  static async update(key, value) {
    const affected = await tdb('settings')
      .where({ key })
      .update({ value, updated_at: new Date() });
    return affected > 0;
  }

  static async upsert(key, value) {
    // The conflict target is the composite primary key, not `key` alone:
    // since 0014 the same key exists once per provider. On MySQL the target is
    // ignored either way, so getting this wrong is invisible there and fails
    // loudly on SQLite and Postgres.
    await tinsert('settings', { key, value, updated_at: new Date() })
      .onConflict(['tenant_id', 'key'])
      .merge({ value, updated_at: new Date() });
    return true;
  }

  static async delete(key) {
    const affected = await tdb('settings').where({ key }).del();
    return affected > 0;
  }
}

export default Setting;
