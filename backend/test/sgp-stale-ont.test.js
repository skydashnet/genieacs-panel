import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: DeviceSwap } = await import('../src/models/DeviceSwap.js');
const { default: Setting } = await import('../src/models/Setting.js');

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/**
 * The case that started this: contract 5 is online at the SGP, but the ONT
 * linked to it stopped informing twelve days ago — the subscriber got a new
 * ONT, which informs with the same PPPoE login, and the link stayed behind.
 */
const fleet = () => [
  { _id: 'ont-old', login: 'TA100.001', lastInform: ago(12 * DAY) },
  { _id: 'ont-new', login: 'ta100.001', lastInform: ago(60 * 1000) },
  // Silent for a day: an outage, not gone equipment.
  { _id: 'ont-quiet', login: 'ta100.002', lastInform: ago(DAY) },
  // Silent for ten days, and nothing took its place in this ACS.
  { _id: 'ont-gone', login: 'ta100.003', lastInform: ago(10 * DAY) }
];

const CADASTRE = new Map([
  ['ta100.001', '5'],
  ['ta100.002', '7'],
  ['ta100.003', '9']
]);

let genieServer;
let sgpServer;

function document(ont) {
  return {
    _id: ont._id,
    _lastInform: ont.lastInform,
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: { _value: '3FE49568HJIL97' } },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: { WANPPPConnection: { 1: { Username: { _value: ont.login } } } }
          }
        }
      }
    }
  };
}

function copyPath(source, target, path) {
  const keys = path.split('.');
  let from = source;
  for (const key of keys) {
    if (!from || typeof from !== 'object' || !(key in from)) return;
    from = from[key];
  }
  let to = target;
  keys.slice(0, -1).forEach((key) => {
    to[key] = to[key] && typeof to[key] === 'object' ? to[key] : {};
    to = to[key];
  });
  to[keys.at(-1)] = structuredClone(from);
}

function startGenieStub() {
  genieServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' || !url.pathname.startsWith('/devices')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    const raw = url.searchParams.get('query');
    const wanted = raw ? JSON.parse(raw)._id : null;
    const projection = (url.searchParams.get('projection') || '').split(',').filter(Boolean);
    const rows = fleet()
      .filter((ont) => !wanted || typeof wanted !== 'string' || ont._id === wanted)
      .map((ont) => {
        const full = document(ont);
        if (projection.length === 0) return full;
        const out = { _id: full._id };
        projection.forEach((path) => copyPath(full, out, path));
        return out;
      });
    res.writeHead(200, { 'Content-Type': 'application/json', total: String(rows.length) });
    return res.end(JSON.stringify(rows));
  });
  return new Promise((done) => {
    genieServer.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${genieServer.address().port}`));
  });
}

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!req.url.startsWith('/api/ura/consultacliente')) {
        return res.end(JSON.stringify({ status: 1 }));
      }
      const login = String(payload.login || '').toLowerCase();
      const contract = CADASTRE.get(login);
      return res.end(JSON.stringify({
        status: 1,
        contratos: contract
          ? [{ contrato: contract, contratoStatusDisplay: 'Ativo', login, bloqueado: false }]
          : []
      }));
    });
  });
  return new Promise((done) => {
    sgpServer.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

const link = (deviceId, contract, login, extra = {}) => asTenant(() => SgpLink.upsert({
  device_id: deviceId,
  account_id: null,
  contract,
  client_name: `Cliente ${contract}`,
  status: '1',
  status_label: 'Ativo',
  state: 'active',
  login,
  link_mode: 'auto',
  last_synced_at: new Date(),
  ...extra
}));

before(async () => {
  await startTestServers();
  const [genieUrl, sgpUrl] = await Promise.all([startGenieStub(), startSgpStub()]);
  await asTenant(() => Setting.upsert('genieAcsUrl', genieUrl));
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: 'painel', token: 'token-stale', linkMode: 'pppoe'
  }));
});

after(async () => {
  await Promise.all([
    new Promise((done) => sgpServer.close(done)),
    new Promise((done) => genieServer.close(done))
  ]);
  await stopTestServers();
});

beforeEach(async () => {
  await asTenant(() => getDb()('sgp_links').del());
  await asTenant(() => getDb()('device_swaps').del());
  await link('ont-old', '5', 'ta100.001');
  await link('ont-quiet', '7', 'ta100.002');
  await link('ont-gone', '9', 'ta100.003');
});

const overview = () => asTenant(() => SgpService.getFleetOverview());
const sync = () => asTenant(() => SgpService.syncFleet());

describe('the SGP overview', () => {
  it('lists an active contract whose ONT is silent for days, with the ONT that took over', async () => {
    const { totals, divergences } = await overview();
    const stale = divergences.staleActive;

    assert.equal(totals.staleActive, 2);
    assert.deepEqual(stale.map((entry) => entry.deviceId).sort(), ['ont-gone', 'ont-old']);
    const old = stale.find((entry) => entry.deviceId === 'ont-old');
    assert.equal(old.contract, '5');
    assert.equal(old.successor.deviceId, 'ont-new');
    assert.equal(old.successor.matchedBy, 'pppoe');
  });

  it('has no successor for an ONT nothing replaced', async () => {
    const { divergences } = await overview();
    assert.equal(divergences.staleActive.find((entry) => entry.deviceId === 'ont-gone').successor, null);
  });

  it('leaves a one-day outage out', async () => {
    const { divergences } = await overview();
    assert.ok(!divergences.staleActive.some((entry) => entry.deviceId === 'ont-quiet'));
    assert.ok(divergences.offlineActive.some((entry) => entry.deviceId === 'ont-quiet'));
  });
});

describe('the fleet sync', () => {
  it('moves the stranded link onto the ONT now informing, and keeps it there', async () => {
    const result = await sync();

    assert.equal(result.relinked, 1);
    assert.equal(await asTenant(() => SgpLink.getByDeviceId('ont-old')), null,
      'the sweep does not write the contract back onto the silent ONT');
    assert.equal((await asTenant(() => SgpLink.getByDeviceId('ont-new'))).contract, '5');
    const [swap] = await asTenant(() => DeviceSwap.listForDevice('ont-new'));
    assert.equal(swap.matched_by, 'stale_pppoe');
    assert.equal(swap.previous_device_id, 'ont-old');

    const again = await sync();
    assert.equal(again.relinked, 0);
    assert.equal(await asTenant(() => SgpLink.getByDeviceId('ont-old')), null);
  });

  it('never moves a manual link', async () => {
    await link('ont-old', '5', 'ta100.001', { link_mode: 'manual' });
    const result = await sync();

    assert.equal(result.relinked, 0);
    assert.equal((await asTenant(() => SgpLink.getByDeviceId('ont-old'))).contract, '5');
  });

  it('leaves the ONTs without a successor where they are', async () => {
    await sync();
    assert.equal((await asTenant(() => SgpLink.getByDeviceId('ont-gone'))).contract, '9');
    assert.equal((await asTenant(() => SgpLink.getByDeviceId('ont-quiet'))).contract, '7');
  });
});

describe('the listing status filter', () => {
  it('reads stale as silent for three days', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    assert.deepEqual(DeviceService.buildDeviceStatusQuery('stale', now), {
      _lastInform: { $lt: '2026-09-24T12:00:00.000Z' }
    });
    assert.equal(DeviceService.normalizeDeviceListQuery({ status: 'stale' }).status, 'stale');
  });
});
