import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: DeviceHistoryService } = await import('../src/services/deviceHistoryService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

/**
 * The fleet read is stubbed rather than served by a GenieACS.
 *
 * What is under test is the deduplication, the rollup and the retention, and
 * all three are pure functions of one fleet read. Standing up an ACS would test
 * the reader in `deviceService`, which has its own coverage, and would make
 * "a device that has not informed since the last sample" impossible to write.
 */
let fleet = [];
let realTelemetryFleet;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Background work has no request, so nothing has resolved a provider. */
const collect = (options) => asTenant(() => DeviceHistoryService.collect(options));
const rollup = (options) => asTenant(() => DeviceHistoryService.rollup(options));
const prune = (options) => asTenant(() => DeviceHistoryService.prune(options));
const pass = (now) => asTenant(() => DeviceHistoryService.passForTenant(now));
const saveConfig = (patch) => asTenant(() => DeviceHistoryService.saveConfig(patch));

function reading(deviceId, { informAt, rxPower = -21.5, temperature = 42, uptime = 86_400 } = {}) {
  return {
    deviceId,
    lastInform: new Date(informAt).toISOString(),
    rxPower,
    temperature,
    uptime
  };
}

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  realTelemetryFleet = DeviceService.getTelemetryFleet;
  DeviceService.getTelemetryFleet = async () => fleet;
  await saveConfig({ enabled: true });
});

after(async () => {
  DeviceService.getTelemetryFleet = realTelemetryFleet;
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('device_samples').del();
  await getDb()('device_sample_hours').del();
  fleet = [];
});

describe('sample collection', () => {
  it('stores one row per device on the first pass', async () => {
    const informAt = Date.now() - 5 * 60_000;
    fleet = [reading('ont-a', { informAt }), reading('ont-b', { informAt })];

    const summary = await collect({});
    assert.equal(summary.stored, 2);
    assert.equal(summary.error, null);

    const rows = await getDb()('device_samples').orderBy('device_id');
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].rx_power), -21.5);
    assert.equal(Number(rows[0].uptime_seconds), 86_400);
  });

  it('stores the inform truncated to whole seconds', async () => {
    // The dedupe compares the reading against what came back from the database,
    // and MySQL's `timestamp` has no sub-second precision. Storing a value with
    // milliseconds there would round it, make the comparison unequal for the
    // same inform, and write a duplicate row on every tick. Asserting the
    // truncation is how that stays caught on SQLite too, where the column would
    // otherwise keep the milliseconds and hide it.
    fleet = [reading('ont-a', { informAt: Date.now() - 5 * 60_000 + 437 })];
    await collect({});

    const [row] = await getDb()('device_samples');
    assert.equal(new Date(row.inform_at).getTime() % 1000, 0);
  });

  it('stores nothing when the device has not informed since the last sample', async () => {
    const informAt = Date.now() - 5 * 60_000;
    fleet = [reading('ont-a', { informAt })];
    await collect({});

    // Same inform, a newer reading: GenieACS is still serving what is on file.
    fleet = [reading('ont-a', { informAt, rxPower: -30 })];
    const summary = await collect({});

    assert.equal(summary.stored, 0);
    assert.equal(summary.unchanged, 1);
    assert.equal((await getDb()('device_samples')).length, 1);
  });

  it('stores again once the device informs anew', async () => {
    const first = Date.now() - 30 * 60_000;
    fleet = [reading('ont-a', { informAt: first })];
    await collect({});

    fleet = [reading('ont-a', { informAt: first + 15 * 60_000, rxPower: -24 })];
    const summary = await collect({});

    assert.equal(summary.stored, 1);
    const rows = await getDb()('device_samples').orderBy('inform_at');
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[1].rx_power), -24);
  });

  it('leaves no rows for a device that stopped informing, so the gap is the outage', async () => {
    const informAt = Date.now() - 3 * DAY;
    fleet = [reading('ont-dark', { informAt })];
    await collect({});
    await collect({});
    await collect({});

    assert.equal((await getDb()('device_samples')).length, 1);
  });

  it('skips a device whose clock puts its inform in the future', async () => {
    fleet = [reading('ont-future', { informAt: Date.now() + 5 * DAY })];
    const summary = await collect({});
    assert.equal(summary.stored, 0);
    assert.equal(summary.skipped, 1);
  });

  it('reports a broken GenieACS instead of throwing', async () => {
    DeviceService.getTelemetryFleet = async () => { throw new Error('ECONNREFUSED'); };
    const summary = await collect({});
    assert.equal(summary.error, 'ECONNREFUSED');
    DeviceService.getTelemetryFleet = async () => fleet;
  });
});

describe('hourly rollup', () => {
  it('collapses the raw rows of one hour into one bucket', async () => {
    const hourStart = Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR;
    for (const [offset, rx] of [[0, -20], [900_000, -22], [1_800_000, -24]]) {
      fleet = [reading('ont-a', { informAt: hourStart + offset, rxPower: rx })];
      // eslint-disable-next-line no-await-in-loop -- each pass depends on the last
      await collect({});
    }

    const summary = await rollup({});
    assert.equal(summary.buckets, 1);

    const [bucket] = await getDb()('device_sample_hours');
    assert.equal(Number(bucket.sample_count), 3);
    assert.equal(Number(bucket.rx_min), -24);
    assert.equal(Number(bucket.rx_max), -20);
    assert.equal(Number(bucket.rx_avg), -22);
  });

  it('is a correction rather than a duplication when it runs again', async () => {
    const hourStart = Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR;
    fleet = [reading('ont-a', { informAt: hourStart, rxPower: -20 })];
    await collect({});

    await rollup({});
    await rollup({});

    assert.equal((await getDb()('device_sample_hours')).length, 1);
  });

  it('leaves the hour still in progress alone', async () => {
    /**
     * A leitura tem que cair na hora CORRENTE, e `Date.now() - 60_000` não
     * garante isso: rodando no primeiro minuto de uma hora, um minuto atrás é a
     * hora ANTERIOR, que já fechou — o rollup a agrupa, `buckets` vem 1, e o
     * teste falha. É um em cada sessenta minutos, ou ~1,7% das rodadas, e foi
     * uma das duas causas do "flake" que a suíte carregava havia meses: no CI
     * ele aparecia como um arquivo vermelho sem relação com o que estava sendo
     * mudado, e re-rodar resolvia — que é exatamente como um teste dependente
     * do relógio se disfarça de infraestrutura.
     *
     * O piso é o começo da hora corrente. Resta a janela de o relógio virar
     * ENTRE o `collect` e o `rollup` abaixo, que é de milissegundos e não dá
     * para fechar sem injetar um relógio no serviço.
     */
    const agora = Date.now();
    const inicioDaHora = Math.floor(agora / HOUR) * HOUR;
    fleet = [reading('ont-a', { informAt: Math.max(inicioDaHora + 1000, agora - 60_000) })];
    await collect({});
    const summary = await rollup({});
    assert.equal(summary.buckets, 0);
  });
});

describe('retention', () => {
  it('deletes only what is past the cutoff', async () => {
    const old = Date.now() - 40 * DAY;
    const recent = Date.now() - 60_000;
    fleet = [reading('ont-a', { informAt: old })];
    await collect({});
    fleet = [reading('ont-a', { informAt: recent })];
    await collect({});

    const summary = await prune({});
    assert.equal(summary.raw, 1);

    const rows = await getDb()('device_samples');
    assert.equal(rows.length, 1);
  });
});

describe('the read path', () => {
  beforeEach(async () => {
    const base = Date.now() - 6 * HOUR;
    for (let step = 0; step < 4; step += 1) {
      fleet = [reading('ont-a', { informAt: base + step * HOUR, rxPower: -20 - step })];
      // eslint-disable-next-line no-await-in-loop -- each pass depends on the last
      await collect({});
    }
  });

  it('returns raw points in ascending time for a short window', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/devices/ont-a/history`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.resolution, 'raw');
    assert.ok(body.data.points.length >= 4);
    const times = body.data.points.map((point) => point.t);
    assert.deepEqual(times, [...times].sort((left, right) => left - right));
  });

  it('falls back to the hourly grain for a long window', async () => {
    await rollup({});
    const from = new Date(Date.now() - 60 * DAY).toISOString();
    const { body } = await call(
      `${panelUrl}/api/devices/ont-a/history?from=${encodeURIComponent(from)}`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.resolution, 'hourly');
  });

  it('refuses a backwards or oversized range', async () => {
    const from = new Date(Date.now()).toISOString();
    const to = new Date(Date.now() - DAY).toISOString();
    const backwards = await call(
      `${panelUrl}/api/devices/ont-a/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: authHeaders(token) }
    );
    assert.equal(backwards.status, 400);

    const ancient = new Date(Date.now() - 800 * DAY).toISOString();
    const oversized = await call(
      `${panelUrl}/api/devices/ont-a/history?from=${encodeURIComponent(ancient)}`,
      { headers: authHeaders(token) }
    );
    assert.equal(oversized.status, 400);
  });

  it('requires a session', async () => {
    const { status } = await call(`${panelUrl}/api/devices/ont-a/history`);
    assert.equal(status, 401);
  });
});

describe('the driver', () => {
  it('does nothing at all while the feature is off', async () => {
    await saveConfig({ enabled: false });
    fleet = [reading('ont-a', { informAt: Date.now() - 60_000 })];

    const summary = await pass(Date.now());
    assert.equal(summary.collected, null);
    assert.equal((await getDb()('device_samples')).length, 0);

    await saveConfig({ enabled: true });
  });

  it('holds the interval between two passes', async () => {
    const now = Date.now();
    fleet = [reading('ont-a', { informAt: now - 60_000 })];
    const first = await pass(now);
    assert.ok(first.collected);

    fleet = [reading('ont-a', { informAt: now - 30_000 })];
    const second = await pass(now + 60_000);
    assert.equal(second.collected, null, 'a pass inside the interval must not sample again');
  });
});
