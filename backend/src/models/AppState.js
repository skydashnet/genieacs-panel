import { getDb } from '../config/database.js';

class AppState {
  static async get(key) {
    const row = await getDb()('app_state').where({ key }).first();
    return row?.value ?? null;
  }

  static async upsert(key, value) {
    await getDb()('app_state')
      .insert({ key, value, updated_at: new Date() })
      .onConflict('key')
      .merge({ value, updated_at: new Date() });
  }
}

export default AppState;
