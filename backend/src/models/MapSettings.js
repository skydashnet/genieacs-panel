import { getDb, tdb, tinsert } from '../config/database.js';

/**
 * Brasília: o painel é vendido a provedores brasileiros, e o onboarding e a aba
 * Geral pedem a cada um onde a planta dele fica. Jacarta era a casa do projeto
 * de origem, não a nossa — e é o mesmo par que `seed.js` grava.
 */
export const DEFAULTS = Object.freeze({
  center_lat: '-15.7942',
  center_lng: '-47.8822',
  max_zoom_in: '18',
  max_zoom_out: '5',
  default_zoom: '13'
});

/**
 * Where the operator's own fibre plant is centred, per provider.
 *
 * The row is a singleton keyed `id: 1`, which is why every query here reads
 * `where({ id: 1 })` — and why this table was the sharpest of the unconverted
 * ones. That WHERE was never an identity filter: with one row in the table it
 * means "the only row", so a second provider saving its map centre overwrote
 * the first's, and `reset()` put the deployment's single row back to defaults
 * for everybody.
 *
 * Since 0025 the primary key is `(tenant_id, id)`, so each provider keeps its
 * own row 1 and `tdb` supplies the provider half of the key. `where({ id: 1 })`
 * stays exactly as it reads — it is now half of a real key rather than a
 * synonym for "everything".
 */
class MapSettings {
  static async get() {
    const row = await tdb('map_settings').where({ id: 1 }).first();
    return row || null;
  }

  static async upsert(settings) {
    const exists = await tdb('map_settings').where({ id: 1 }).first();
    if (exists) {
      await tdb('map_settings').where({ id: 1 }).update({
        center_lat: settings.center_lat,
        center_lng: settings.center_lng,
        max_zoom_in: settings.max_zoom_in,
        max_zoom_out: settings.max_zoom_out,
        default_zoom: settings.default_zoom,
        updated_at: getDb().fn.now()
      });
    } else {
      // `tinsert` stamps the provider. Without it the row would fall to the
      // column default — provider #1 — and the second provider's first save
      // would land on top of the first provider's map.
      await tinsert('map_settings', {
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
