import { getDb } from '../config/database.js';

const DEFAULTS = {
  center_lat: '-6.2088',
  center_lng: '106.8456',
  max_zoom_in: '18',
  max_zoom_out: '5',
  default_zoom: '13'
};

class MapSettings {
  static async get() {
    const row = await getDb()('map_settings').where({ id: 1 }).first();
    return row || null;
  }

  static async upsert(settings) {
    const db = getDb();
    const exists = await db('map_settings').where({ id: 1 }).first();
    if (exists) {
      await db('map_settings').where({ id: 1 }).update({
        center_lat: settings.center_lat,
        center_lng: settings.center_lng,
        max_zoom_in: settings.max_zoom_in,
        max_zoom_out: settings.max_zoom_out,
        default_zoom: settings.default_zoom,
        updated_at: db.fn.now()
      });
    } else {
      await db('map_settings').insert({
        id: 1,
        center_lat: settings.center_lat ?? DEFAULTS.center_lat,
        center_lng: settings.center_lng ?? DEFAULTS.center_lng,
        max_zoom_in: settings.max_zoom_in ?? DEFAULTS.max_zoom_in,
        max_zoom_out: settings.max_zoom_out ?? DEFAULTS.max_zoom_out,
        default_zoom: settings.default_zoom ?? DEFAULTS.default_zoom
      });
    }
    return true;
  }

  static async reset() {
    return this.upsert(DEFAULTS);
  }
}

export default MapSettings;
