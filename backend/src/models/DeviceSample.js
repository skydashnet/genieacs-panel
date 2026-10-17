import { tbatchInsert, tdb } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

/** Rows come back with strings on one driver and numbers on another. */
function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    inform_at: timestampMs(row.inform_at),
    rx_power: row.rx_power === null || row.rx_power === undefined ? null : Number(row.rx_power),
    temperature: row.temperature === null || row.temperature === undefined
      ? null
      : Number(row.temperature),
    uptime_seconds: row.uptime_seconds === null || row.uptime_seconds === undefined
      ? null
      : Number(row.uptime_seconds)
  };
}

class DeviceSample {
  /**
   * The newest stored inform per device, as one grouped query.
   *
   * Read from the database rather than kept in memory on purpose: the panel
   * restarts often, and a cache that starts empty writes one duplicate row per
   * device per restart without anyone noticing. The
   * `(tenant_id, device_id, inform_at)` index serves this without touching the
   * table on any of the three engines.
   */
  static async newestInformByDevice() {
    const rows = await tdb('device_samples')
      .select('device_id')
      .max({ newest: 'inform_at' })
      .groupBy('device_id');
    const newest = new Map();
    for (const row of rows) newest.set(row.device_id, timestampMs(row.newest));
    return newest;
  }

  static async insertMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    // Chunked because SQLite has a variable ceiling and MySQL a packet size,
    // and a thousand-device fleet is one insert per tick otherwise.
    await tbatchInsert('device_samples', rows, 100);
    return rows.length;
  }

  static async listRange(deviceId, fromMs, toMs, limit = 1000) {
    const rows = await tdb('device_samples')
      .where({ device_id: deviceId })
      .where('inform_at', '>=', new Date(fromMs))
      .where('inform_at', '<=', new Date(toMs))
      .orderBy('inform_at', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 1000, 1), 5000));
    return rows.map(parseRow);
  }

  /** The rollup's input: every raw row of one closed window, all devices. */
  static async listForWindow(fromMs, toMs) {
    const rows = await tdb('device_samples')
      .where('inform_at', '>=', new Date(fromMs))
      .where('inform_at', '<', new Date(toMs))
      .orderBy('inform_at', 'asc');
    return rows.map(parseRow);
  }

  static async countAll() {
    const [row] = await tdb('device_samples').count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  /**
   * Deletes in bounded batches.
   *
   * `DELETE ... LIMIT` does not exist on PostgreSQL, so the portable shape is
   * select-then-delete-by-id. Unbounded, this is a single statement holding a
   * lock over a million rows while the request path waits behind it.
   */
  static async pruneOlderThan(cutoffMs, { batchSize = 5000, maxBatches = 20 } = {}) {
    let removed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // eslint-disable-next-line no-await-in-loop -- bounded, and each batch depends on the last
      const ids = await tdb('device_samples')
        .select('id')
        .where('inform_at', '<', new Date(cutoffMs))
        .limit(batchSize);
      if (ids.length === 0) break;
      // eslint-disable-next-line no-await-in-loop -- see above
      removed += await tdb('device_samples').whereIn('id', ids.map((row) => row.id)).del();
      if (ids.length < batchSize) break;
    }
    return removed;
  }
}

export default DeviceSample;
