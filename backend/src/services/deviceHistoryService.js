import AppState from '../models/AppState.js';
import DeviceSample from '../models/DeviceSample.js';
import DeviceSampleHour from '../models/DeviceSampleHour.js';
import DeviceService from './deviceService.js';
import { forEveryTenant } from '../config/tenantJobs.js';
import { TenantCache } from '../config/tenantCache.js';
import { RAW_SAMPLE_RETENTION, HOURLY_SAMPLE_RETENTION } from '../config/retention.js';
import { timestampMs } from '../utils/helpers.js';

const CONFIG_KEY = 'device_history_config';
const LAST_SAMPLE_KEY = 'device_history_last_sample';
const LAST_ROLLUP_KEY = 'device_history_last_rollup';
const LAST_PRUNE_KEY = 'device_history_last_prune';

/** How often the driver wakes. Whether a pass is *due* is decided in the tick. */
const TICK_INTERVAL_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Points a single chart read may return, whichever grain it lands on. */
const MAX_POINTS = 1000;

export const DEFAULT_HISTORY_CONFIG = Object.freeze({
  enabled: false,
  // 15 minutes. The alert scan runs at 5 and its rules are measured in tens of
  // minutes; a degradation curve does not need finer, and 90 days at this grain
  // is already more points than a chart can draw.
  intervalSeconds: 900,
  rawRetentionDays: RAW_SAMPLE_RETENTION.defaultDays,
  rollupRetentionDays: HOURLY_SAMPLE_RETENTION.defaultDays
});

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** A telemetry reading is only a reading when it is a finite number. */
function reading(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function averageOf(values) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

class DeviceHistoryService {
  static configCache = new TenantCache(30_000);

  static timer = null;

  static invalidateConfigCache() {
    this.configCache.clear();
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;

    let stored = {};
    const raw = await AppState.get(CONFIG_KEY);
    if (raw) {
      try {
        stored = JSON.parse(raw) || {};
      } catch {
        stored = {};
      }
    }
    return this.configCache.set({
      enabled: stored.enabled === true,
      // Floored at 5 minutes: the ceiling on rows per device per day is set
      // here, and a 60-second interval would multiply the table by fifteen for
      // a curve nobody can read at that resolution.
      intervalSeconds: clampNumber(stored.intervalSeconds, 300, 86_400, 900),
      rawRetentionDays: clampNumber(stored.rawRetentionDays, RAW_SAMPLE_RETENTION.minDays, RAW_SAMPLE_RETENTION.maxDays, RAW_SAMPLE_RETENTION.defaultDays),
      rollupRetentionDays: clampNumber(stored.rollupRetentionDays, HOURLY_SAMPLE_RETENTION.minDays, HOURLY_SAMPLE_RETENTION.maxDays, HOURLY_SAMPLE_RETENTION.defaultDays),
      updatedAt: stored.updatedAt || null
    });
  }

  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      intervalSeconds: patch.intervalSeconds === undefined
        ? current.intervalSeconds
        : clampNumber(patch.intervalSeconds, 300, 86_400, 900),
      rawRetentionDays: patch.rawRetentionDays === undefined
        ? current.rawRetentionDays
        : clampNumber(patch.rawRetentionDays, RAW_SAMPLE_RETENTION.minDays, RAW_SAMPLE_RETENTION.maxDays, RAW_SAMPLE_RETENTION.defaultDays),
      rollupRetentionDays: patch.rollupRetentionDays === undefined
        ? current.rollupRetentionDays
        : clampNumber(patch.rollupRetentionDays, HOURLY_SAMPLE_RETENTION.minDays, HOURLY_SAMPLE_RETENTION.maxDays, HOURLY_SAMPLE_RETENTION.defaultDays),
      updatedAt: new Date().toISOString()
    };
    await AppState.upsert(CONFIG_KEY, JSON.stringify(next));
    this.configCache.invalidate();
    return this.getConfig();
  }

  // ------------------------------------------------------------------ driver

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`Device history tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One wake-up, one pass per provider.
   *
   * Per provider rather than `forSoleTenant`, because everything this reads is
   * already scoped: the GenieACS URL in `settings`, the config and stamps in
   * `app_state`, and both sample tables. A loop divides the work here, it does
   * not repeat it.
   */
  static async tick() {
    // `forEveryTenant`: a passada de um provedor suspenso é só a PODA — ver
    // `passForTenant`. Sem isso, `device_samples` e `device_sample_hours` dele
    // não tinham prazo nenhum, e a retenção padrão de 14 e 90 dias valia só
    // para quem estava ativo.
    return forEveryTenant((tenant) => this.passForTenant(Date.now(), {
      retentionOnly: tenant.status !== 'active'
    }), {
      onError: (error) => console.warn(`Device history pass failed: ${error.message}`)
    });
  }

  static async readStamp(key) {
    const parsed = timestampMs(await AppState.get(key));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  static async writeStamp(key, at) {
    await AppState.upsert(key, new Date(at).toISOString());
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.retentionOnly] Só a poda, sem coletar nem consolidar.
   *   É o que um provedor SUSPENSO recebe: `collect` fala com o GenieACS dele, e
   *   perguntar à rede de quem está suspenso seria trabalho de verdade
   *   acontecendo lá dentro. Apagar o que passou do prazo não é — é o contrário,
   *   é parar de guardar. A consolidação some junto porque só existe para
   *   alimentar o que a coleta traz.
   */
  static async passForTenant(now = Date.now(), { retentionOnly = false } = {}) {
    const config = await this.getConfig();
    const summary = { collected: null, rolled: null, pruned: null };
    if (!config.enabled) return summary;

    if (!retentionOnly
      && now - (await this.readStamp(LAST_SAMPLE_KEY)) >= config.intervalSeconds * 1000) {
      summary.collected = await this.collect({ now });
      await this.writeStamp(LAST_SAMPLE_KEY, now);
    }
    if (!retentionOnly && now - (await this.readStamp(LAST_ROLLUP_KEY)) >= HOUR_MS) {
      summary.rolled = await this.rollup({ now });
      await this.writeStamp(LAST_ROLLUP_KEY, now);
    }
    if (now - (await this.readStamp(LAST_PRUNE_KEY)) >= DAY_MS) {
      summary.pruned = await this.prune({ now });
      await this.writeStamp(LAST_PRUNE_KEY, now);
    }
    return summary;
  }

  // -------------------------------------------------------------- collection

  /**
   * One fleet read, one row per device that has informed since its last stored
   * sample.
   *
   * Never throws, for the reason `WaAlertService.runScan` does not: a GenieACS
   * that is down must not take the driver with it.
   */
  static async collect({ now = Date.now() } = {}) {
    const summary = { stored: 0, unchanged: 0, skipped: 0, error: null };
    try {
      const fleet = await DeviceService.getTelemetryFleet();
      if (!Array.isArray(fleet) || fleet.length === 0) return summary;

      const newest = await DeviceSample.newestInformByDevice();
      const rows = [];
      for (const device of fleet) {
        if (!device.deviceId) {
          summary.skipped += 1;
          continue;
        }
        // Truncated to whole seconds before it is either compared or stored.
        //
        // MySQL's `timestamp` has no sub-second precision, so a value carrying
        // milliseconds is rounded on the way in. Comparing the untruncated
        // reading against what came back then finds them unequal for the *same*
        // inform, and the next pass stores the row again — a duplicate per
        // device per tick, forever, on every MySQL install. Truncating here
        // means the value compared is the value the column can hold, on all
        // three engines.
        const informMs = Math.floor(timestampMs(device.lastInform) / 1000) * 1000;
        if (!Number.isFinite(informMs) || informMs > now + HOUR_MS) {
          // Never informed, or a clock far enough ahead that the row would sort
          // into the future and sit at the end of every chart.
          summary.skipped += 1;
          continue;
        }
        const stored = newest.get(device.deviceId);
        if (Number.isFinite(stored) && informMs <= stored) {
          // The device has not informed since the last sample, so GenieACS is
          // still serving the reading already on file.
          summary.unchanged += 1;
          continue;
        }
        rows.push({
          device_id: String(device.deviceId).slice(0, 255),
          inform_at: new Date(informMs),
          rx_power: reading(device.rxPower),
          temperature: reading(device.temperature),
          uptime_seconds: reading(device.uptime)
        });
      }
      summary.stored = await DeviceSample.insertMany(rows);
    } catch (error) {
      summary.error = error.message;
      console.warn(`Device history collection failed: ${error.message}`);
    }
    return summary;
  }

  // ------------------------------------------------------------------ rollup

  /**
   * Collapses the raw rows of closed hours into one bucket per device per hour.
   *
   * The bucketing happens in JavaScript, never in SQL. `date_trunc` is
   * PostgreSQL, `DATE_FORMAT` is MySQL and `strftime` is SQLite, and the suite
   * runs on all three. One closed hour of a thousand-device fleet is a few
   * thousand rows, which is a cheap thing to group in memory and an expensive
   * thing to make portable in SQL.
   */
  static async rollup({ now = Date.now() } = {}) {
    const summary = { buckets: 0, from: null, to: null, error: null };
    try {
      const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
      // Up to a day of closed hours per pass, so an install that was down for a
      // week catches up over a week of ticks rather than in one long query.
      const from = currentHour - DAY_MS;
      const rows = await DeviceSample.listForWindow(from, currentHour);
      if (rows.length === 0) return summary;

      const buckets = new Map();
      for (const row of rows) {
        const bucketAt = Math.floor(row.inform_at / HOUR_MS) * HOUR_MS;
        const key = `${row.device_id} ${bucketAt}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { deviceId: row.device_id, bucketAt, rx: [], temp: [], uptime: null };
          buckets.set(key, bucket);
        }
        if (row.rx_power !== null) bucket.rx.push(row.rx_power);
        if (row.temperature !== null) bucket.temp.push(row.temperature);
        // Last within the hour, because the rows arrive ordered by inform.
        if (row.uptime_seconds !== null) bucket.uptime = row.uptime_seconds;
      }

      const written = [...buckets.values()].map((bucket) => ({
        device_id: bucket.deviceId,
        bucket_at: new Date(bucket.bucketAt),
        sample_count: Math.max(bucket.rx.length, bucket.temp.length),
        rx_min: bucket.rx.length ? Math.min(...bucket.rx) : null,
        rx_avg: averageOf(bucket.rx),
        rx_max: bucket.rx.length ? Math.max(...bucket.rx) : null,
        temp_min: bucket.temp.length ? Math.min(...bucket.temp) : null,
        temp_avg: averageOf(bucket.temp),
        temp_max: bucket.temp.length ? Math.max(...bucket.temp) : null,
        uptime_last: bucket.uptime
      }));

      summary.buckets = await DeviceSampleHour.upsertMany(written);
      summary.from = new Date(from).toISOString();
      summary.to = new Date(currentHour).toISOString();
    } catch (error) {
      summary.error = error.message;
      console.warn(`Device history rollup failed: ${error.message}`);
    }
    return summary;
  }

  static async prune({ now = Date.now() } = {}) {
    const config = await this.getConfig();
    const summary = { raw: 0, hourly: 0, error: null };
    try {
      summary.raw = await DeviceSample.pruneOlderThan(now - config.rawRetentionDays * DAY_MS);
      summary.hourly = await DeviceSampleHour.pruneOlderThan(
        now - config.rollupRetentionDays * DAY_MS
      );
    } catch (error) {
      summary.error = error.message;
      console.warn(`Device history prune failed: ${error.message}`);
    }
    return summary;
  }

  // --------------------------------------------------------------- read path

  /**
   * The series for one device, at whichever grain the range can afford.
   *
   * Raw while the window is inside the raw retention *and* would fit under the
   * point cap; hourly otherwise. The caller is told which it got, because a
   * chart that silently changes meaning between two ranges is worse than one
   * that says so.
   */
  static async readRange(deviceId, { from, to } = {}) {
    const config = await this.getConfig();
    const toMs = Number.isFinite(to) ? to : Date.now();
    const fromMs = Number.isFinite(from) ? from : toMs - DAY_MS;
    const spanMs = Math.max(toMs - fromMs, 0);

    const rawWindowMs = config.rawRetentionDays * DAY_MS;
    const estimatedRawPoints = spanMs / (config.intervalSeconds * 1000);
    const useRaw = spanMs <= rawWindowMs && estimatedRawPoints <= MAX_POINTS;

    if (useRaw) {
      const rows = await DeviceSample.listRange(deviceId, fromMs, toMs, MAX_POINTS);
      return {
        deviceId,
        resolution: 'raw',
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        // Seconds, not ISO: a thousand ISO strings would be most of the payload
        // and the client formats the axis anyway.
        points: rows.map((row) => ({
          t: Math.round(row.inform_at / 1000),
          rx: row.rx_power,
          tc: row.temperature,
          up: row.uptime_seconds
        }))
      };
    }

    const rows = await DeviceSampleHour.listRange(deviceId, fromMs, toMs, MAX_POINTS);
    return {
      deviceId,
      resolution: 'hourly',
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      points: rows.map((row) => ({
        t: Math.round(row.bucket_at / 1000),
        rx: row.rx_avg,
        rxMin: row.rx_min,
        rxMax: row.rx_max,
        tc: row.temp_avg,
        up: row.uptime_last
      }))
    };
  }

  /**
   * Two past readings for one device, for the line an alert carries.
   *
   * A WhatsApp alert is plain text and cannot hold a chart, but "-27 dBm now,
   * -22 a week ago" is the difference between a slow slide and a sudden drop,
   * which is the difference between scheduling a visit and treating it as an
   * incident.
   */
  static async recentSummary(deviceId, { now = Date.now() } = {}) {
    const config = await this.getConfig();
    if (!config.enabled) return null;
    const day = await DeviceSample.listRange(deviceId, now - 25 * HOUR_MS, now - 23 * HOUR_MS, 4);
    const week = await DeviceSampleHour.listRange(deviceId, now - 8 * DAY_MS, now - 6 * DAY_MS, 4);
    const rx24h = day.find((row) => row.rx_power !== null)?.rx_power ?? null;
    const rx7d = week.find((row) => row.rx_avg !== null)?.rx_avg ?? null;
    if (rx24h === null && rx7d === null) return null;
    return { rx24h, rx7d };
  }
}

export default DeviceHistoryService;
