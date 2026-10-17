import { tdb, tinsert } from '../config/database.js';
import { timestampMs } from '../utils/helpers.js';

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    bucket_at: timestampMs(row.bucket_at),
    sample_count: Number(row.sample_count ?? 0),
    rx_min: numberOrNull(row.rx_min),
    rx_avg: numberOrNull(row.rx_avg),
    rx_max: numberOrNull(row.rx_max),
    temp_min: numberOrNull(row.temp_min),
    temp_avg: numberOrNull(row.temp_avg),
    temp_max: numberOrNull(row.temp_max),
    uptime_last: numberOrNull(row.uptime_last)
  };
}

class DeviceSampleHour {
  /**
   * Writes a batch of buckets, replacing any that are already there.
   *
   * Read-then-write rather than `onConflict().merge()`: the `excluded.` form
   * that makes merge useful is PostgreSQL and SQLite syntax, and MySQL spells
   * it differently. `SgpEvent.insertIfNew` settled on the same shape for the
   * same reason. The unique on (tenant, device, bucket) is what makes re-running
   * a rollup a correction rather than a duplication.
   */
  static async upsertMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    let written = 0;
    for (const row of rows) {
      const { device_id: deviceId, bucket_at: bucketAt, ...values } = row;
      // eslint-disable-next-line no-await-in-loop -- one bucket at a time, by design
      const existing = await tdb('device_sample_hours')
        .where({ device_id: deviceId, bucket_at: bucketAt })
        .first();
      if (existing) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await tdb('device_sample_hours').where({ id: existing.id }).update(values);
      } else {
        // eslint-disable-next-line no-await-in-loop -- see above
        await tinsert('device_sample_hours', { device_id: deviceId, bucket_at: bucketAt, ...values });
      }
      written += 1;
    }
    return written;
  }

  static async listRange(deviceId, fromMs, toMs, limit = 1000) {
    const rows = await tdb('device_sample_hours')
      .where({ device_id: deviceId })
      .where('bucket_at', '>=', new Date(fromMs))
      .where('bucket_at', '<=', new Date(toMs))
      .orderBy('bucket_at', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 1000, 1), 5000));
    return rows.map(parseRow);
  }

  static async pruneOlderThan(cutoffMs, { batchSize = 5000, maxBatches = 20 } = {}) {
    let removed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // eslint-disable-next-line no-await-in-loop -- bounded, each batch depends on the last
      const ids = await tdb('device_sample_hours')
        .select('id')
        .where('bucket_at', '<', new Date(cutoffMs))
        .limit(batchSize);
      if (ids.length === 0) break;
      // eslint-disable-next-line no-await-in-loop -- see above
      removed += await tdb('device_sample_hours').whereIn('id', ids.map((row) => row.id)).del();
      if (ids.length < batchSize) break;
    }
    return removed;
  }
}

export default DeviceSampleHour;
