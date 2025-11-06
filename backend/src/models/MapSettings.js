import { executeQuery } from '../config/database.js';

class MapSettings {
  static async get() {
    const query = 'SELECT * FROM map_settings WHERE id = 1';
    const rows = await executeQuery(query);
    return rows.length > 0 ? rows[0] : null;
  }

  static async create(settings) {
    const {
      center_lat = '-6.2088',
      center_lng = '106.8456',
      max_zoom_in = '18',
      max_zoom_out = '5',
      default_zoom = '13'
    } = settings;

    const query = `
      INSERT INTO map_settings (id, center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom)
      VALUES (1, ?, ?, ?, ?, ?)
    `;
    
    await executeQuery(query, [center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom]);
    return true;
  }

  static async update(settings) {
    const {
      center_lat,
      center_lng,
      max_zoom_in,
      max_zoom_out,
      default_zoom
    } = settings;

    const query = `
      UPDATE map_settings SET 
        center_lat = ?, center_lng = ?, max_zoom_in = ?, max_zoom_out = ?, default_zoom = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `;
    
    const result = await executeQuery(query, [
      center_lat, center_lng, max_zoom_in, max_zoom_out, default_zoom
    ]);
    
    return result.affectedRows > 0;
  }

  static async upsert(settings) {
    const exists = await this.get();
    if (exists) {
      return await this.update(settings);
    } else {
      return await this.create(settings);
    }
  }

  static async reset() {
    const defaults = {
      center_lat: '-6.2088',
      center_lng: '106.8456',
      max_zoom_in: '18',
      max_zoom_out: '5',
      default_zoom: '13'
    };
    
    return await this.upsert(defaults);
  }
}

export default MapSettings;