import { tdb, tinsert } from '../config/database.js';

class AppState {
  static async get(key) {
    const row = await tdb('app_state').where({ key }).first();
    return row?.value ?? null;
  }

  static async upsert(key, value) {
    // Composite conflict target — see the note in models/Setting.js.
    await tinsert('app_state', { key, value, updated_at: new Date() })
      .onConflict(['tenant_id', 'key'])
      .merge({ value, updated_at: new Date() });
  }
}

export default AppState;
