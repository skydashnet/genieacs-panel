import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');

const { default: AppState } = await import('../src/models/AppState.js');

const { deriveContractState } = await import('../src/services/sgpService.js');

const APP = 'painel';
const TOKEN = 'token-da-frota-123';
const ONLINE_MINUTES = 2;
const OFFLINE_MINUTES = 120;
const UNKNOWN_LOGIN = 'desconhecido@provedor';

// One row per fixture device: what the panel stores, what SGP answers, and how
// long ago the ONT informed.
const FLEET = [
  { device: 'fleet-active', customerId: 'CSG-FLEET01-000001', pppoe: 'ativo@provedor', informedMinutesAgo: ONLINE_MINUTES },
  { device: 'fleet-blocked', customerId: 'CSG-FLEET02-000002', pppoe: 'bloqueado@provedor', informedMinutesAgo: ONLINE_MINUTES },
  { device: 'fleet-cancelled', customerId: 'CSG-FLEET03-000003', pppoe: 'cancelado@provedor', informedMinutesAgo: ONLINE_MINUTES },
  { device: 'fleet-offline', customerId: 'CSG-FLEET04-000004', pppoe: 'offline@provedor', informedMinutesAgo: OFFLINE_MINUTES },
  { device: 'fleet-manual', customerId: 'CSG-FLEET05-000005', pppoe: 'manual@provedor', informedMinutesAgo: ONLINE_MINUTES },
  // Never reaches GenieACS: the SGP lookup for this login answers with an error.
  { device: 'fleet-failure', customerId: 'CSG-FLEET06-000006', pppoe: 'falha@provedor', informedMinutesAgo: null },
  { device: 'fleet-empty', customerId: 'CSG-FLEET07-000007', pppoe: 'vazio@provedor', informedMinutesAgo: ONLINE_MINUTES },
  { device: 'fleet-nopppoe', customerId: 'CSG-FLEET08-000008', pppoe: '', informedMinutesAgo: null },
  { device: 'fleet-unknown', customerId: 'CSG-FLEET09-000009', pppoe: UNKNOWN_LOGIN, informedMinutesAgo: null }
];

const FAILING_LOGIN = 'falha@provedor';
const MANUAL_LOGIN = 'manual@provedor';

const CONTRACTS = {
  1001: {
    contrato: 1001,
    contratoStatusDisplay: 'Ativo',
    planoInternet: 'Fibra 300MB',
    razaoSocial: 'Ana Lima',
    login: 'ativo@provedor',
    bloqueado: false
  },
  1002: {
    contrato: 1002,
    contratoStatusDisplay: 'Bloqueado',
    planoInternet: 'Fibra 300MB',
    razaoSocial: 'Bruno Reis',
    login: 'bloqueado@provedor',
    bloqueado: true
  },
  1003: {
    contrato: 1003,
    contratoStatusDisplay: 'Cancelado',
    planoInternet: 'Fibra 300MB',
    razaoSocial: 'Carla Souza',
    login: 'cancelado@provedor',
    bloqueado: true
  },
  1004: {
    contrato: 1004,
    contratoStatusDisplay: 'Ativo',
    planoInternet: 'Fibra 500MB',
    razaoSocial: 'Diego Alves',
    login: 'offline@provedor',
    bloqueado: false
  },
  1005: {
    contrato: 1005,
    contratoStatusDisplay: 'Ativo',
    planoInternet: 'Fibra 500MB',
    razaoSocial: 'Elisa Moura',
    login: MANUAL_LOGIN,
    bloqueado: false
  },
  // The contract the PPPoE lookup would pick for the manually linked ONT.
  1099: {
    contrato: 1099,
    contratoStatusDisplay: 'Ativo',
    planoInternet: 'Fibra 100MB',
    razaoSocial: 'Elisa Moura (outro contrato)',
    login: MANUAL_LOGIN,
    bloqueado: false
  }
};

const CONTRACTS_BY_LOGIN = {
  'ativo@provedor': ['1001'],
  'bloqueado@provedor': ['1002'],
  'cancelado@provedor': ['1003'],
  'offline@provedor': ['1004'],
  [MANUAL_LOGIN]: ['1099'],
  'vazio@provedor': []
};

const GENIE_DEVICES = [
  'fleet-active',
  'fleet-blocked',
  'fleet-cancelled',
  'fleet-offline',
  'fleet-manual',
  'fleet-empty'
];

let panelUrl;
let token;
let sgpServer;
let sgpUrl;
let genieServer;
let genieUrl;
const requests = [];

/** Minimal stand-in for a provider's SGP instance. */
function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      requests.push({ url: req.url, payload });
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (payload.app !== APP || payload.token !== TOKEN) {
        return send({ status: 0, msg: 'Token inválido' });
      }
      if (req.url.startsWith('/api/ura/consultacliente')) {
        if (payload.login === UNKNOWN_LOGIN) {
          return send({ status: 0, msg: 'Cliente não encontrado' });
        }
        if (payload.login === FAILING_LOGIN) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 0, msg: 'Erro interno' }));
        }
        const keys = payload.login
          ? (CONTRACTS_BY_LOGIN[String(payload.login)] || [])
          : (payload.contrato ? [String(payload.contrato)] : []);
        return send({
          status: 1,
          contratos: keys.map((key) => CONTRACTS[key]).filter(Boolean)
        });
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 0, msg: 'Endpoint inexistente' }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

/**
 * Stand-in for GenieACS. `_lastInform` is generated per request so the freshness
 * window is always measured against the moment the panel asks.
 */
function startGenieStub() {
  genieServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/devices')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const documents = GENIE_DEVICES.map((deviceId) => {
      const entry = FLEET.find((item) => item.device === deviceId);
      return {
        _id: deviceId,
        _lastInform: new Date(Date.now() - entry.informedMinutesAgo * 60_000).toISOString(),
        VirtualParameters: { PPPUsername: { _value: entry.pppoe } }
      };
    });
    // An ONT that GenieACS knows but the panel never gave a Customer ID.
    documents.push({
      _id: 'fleet-orphan',
      _lastInform: new Date().toISOString(),
      VirtualParameters: { PPPUsername: { _value: 'orfao@provedor' } }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(documents));
  });
  return new Promise((resolve) => {
    genieServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${genieServer.address().port}`);
    });
  });
}

async function enableIntegration(patch = {}) {
  return call(`${panelUrl}/api/sgp/config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe', ...patch }
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  [sgpUrl, genieUrl] = await Promise.all([startSgpStub(), startGenieStub()]);

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => Setting.upsert('genieAcsUrl', genieUrl));
  await getDb()('customer_accounts').insert(FLEET.map((entry, index) => ({
    customer_id: entry.customerId,
    device_id: entry.device,
    identity_hash: `fleet${index}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: entry.pppoe,
    active: true
  })));
});

after(async () => {
  await Promise.all([
    new Promise((resolve) => sgpServer.close(resolve)),
    new Promise((resolve) => genieServer.close(resolve))
  ]);
  await stopTestServers();
});

describe('contract state normalization', () => {
  const cases = [
    ['Ativo', null, 'active'],
    ['ATIVO', null, 'active'],
    ['Bloqueado', null, 'blocked'],
    ['Suspenso', null, 'blocked'],
    ['Bloqueado por inadimplência', null, 'blocked'],
    ['Cancelado', null, 'cancelled'],
    ['Encerrado', null, 'cancelled'],
    ['Desativado', null, 'cancelled'],
    ['Inativo', null, 'cancelled'],
    ['Pré-contrato', null, 'unknown'],
    [null, null, 'unknown']
  ];

  for (const [statusLabel, blocked, expected] of cases) {
    it(`reads ${statusLabel ?? 'an empty label'} as ${expected}`, () => {
      assert.equal(deriveContractState({ statusLabel, status: null, blocked }), expected);
    });
  }

  it('ignores accents and casing in the label', () => {
    assert.equal(deriveContractState({ statusLabel: 'SUSPENSÃO POR ATRASO' }), 'blocked');
    assert.equal(deriveContractState({ statusLabel: 'INADIMPLÊNCIA' }), 'blocked');
  });

  it('reads the state from the raw status when the install sends no label', () => {
    assert.equal(deriveContractState({ statusLabel: null, status: 'Cancelado' }), 'cancelled');
  });

  it('lets the blocked flag outrank a label that still says active', () => {
    assert.equal(deriveContractState({ statusLabel: 'Ativo', blocked: true }), 'blocked');
  });

  it('keeps a cancellation over the blocked flag', () => {
    assert.equal(deriveContractState({ statusLabel: 'Cancelado', blocked: true }), 'cancelled');
  });
});

describe('fleet routes while the integration is off', () => {
  it('requires an administrator session', async () => {
    for (const [method, path] of [['GET', 'links'], ['GET', 'overview'], ['POST', 'sync']]) {
      const { status } = await call(`${panelUrl}/api/sgp/${path}`, { method });
      assert.equal(status, 401, `${method} /${path}`);
    }
  });

  it('answers not_configured on every fleet route', async () => {
    for (const [method, path] of [['GET', 'links'], ['GET', 'overview'], ['POST', 'sync']]) {
      const { status, body } = await call(`${panelUrl}/api/sgp/${path}`, {
        method,
        headers: authHeaders(token)
      });
      assert.equal(status, 409, `${method} /${path}`);
      assert.equal(body.code, 'not_configured', `${method} /${path}`);
    }
  });
});

describe('fleet synchronization', () => {
  let firstRun;

  before(async () => {
    const config = await enableIntegration();
    assert.equal(config.body.data.ready, true);
    // The operator picked contract 1005 by hand, while the PPPoE lookup for the
    // same ONT resolves to 1099.
    const linked = await call(`${panelUrl}/api/sgp/devices/fleet-manual/link`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { contract: '1005' }
    });
    assert.equal(linked.body.data.link.linkMode, 'manual');
    CONTRACTS['1005'].planoInternet = 'Fibra 700MB';

    const run = await call(`${panelUrl}/api/sgp/sync`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(run.status, 200);
    firstRun = run.body.data;
  });

  // `FLEET.length + 1` is the orphan: an ONT GenieACS knows and no account
  // covers. The sweep reaches it because the login it reports is identifier
  // enough on its own — which is the whole point of the pppoe link mode.
  it('counts every device it examined, account or not', () => {
    assert.equal(firstRun.total, FLEET.length + 1);
    assert.equal(firstRun.created, 4);
    assert.equal(firstRun.updated, 1);
    assert.equal(firstRun.linked, 5);
    assert.ok(Number.isFinite(firstRun.durationMs));
    assert.ok(Date.parse(firstRun.startedAt) <= Date.parse(firstRun.finishedAt));
  });

  it('does not abort the run when one device fails', async () => {
    assert.equal(firstRun.failed, 1);
    const row = await getDb()('sgp_links').where({ device_id: 'fleet-failure' }).first();
    assert.equal(row, undefined);
    const active = await getDb()('sgp_links').where({ device_id: 'fleet-active' }).first();
    assert.equal(active.contract, '1001');
  });

  it('skips devices with no identifier and lookups that match no contract', () => {
    // Three as before, plus the orphan: SGP knows no contract for the login
    // it reports, which is a skip and not a failure.
    assert.equal(firstRun.skipped, 4);
  });

  it('counts a customer SGP does not know as skipped rather than failed', async () => {
    // SGP rejects an unknown customer the same way it reports a real error;
    // counting those as failures would drown the operator in false alarms.
    const row = await getDb()('sgp_links').where({ device_id: 'fleet-unknown' }).first();
    assert.equal(row, undefined);
    assert.equal(firstRun.failed, 1);
  });

  it('persists the derived state of every contract it wrote', async () => {
    const rows = await getDb()('sgp_links').select('device_id', 'state');
    const byDevice = Object.fromEntries(rows.map((row) => [row.device_id, row.state]));
    assert.equal(byDevice['fleet-active'], 'active');
    assert.equal(byDevice['fleet-blocked'], 'blocked');
    assert.equal(byDevice['fleet-cancelled'], 'cancelled');
  });

  it('refreshes a manual link without re-pointing it', async () => {
    const row = await getDb()('sgp_links').where({ device_id: 'fleet-manual' }).first();
    assert.equal(row.contract, '1005');
    assert.equal(row.plan, 'Fibra 700MB');
    assert.equal(row.link_mode, 'manual');
    assert.ok(
      !requests.some((entry) => entry.payload.login === MANUAL_LOGIN),
      'a manual link must never be resolved through the PPPoE login'
    );
  });

  it('stores the last run summary for the next page load', async () => {
    const row = { value: await asTenant(() => AppState.get('sgp_sync_last_run')) };
    assert.deepEqual(JSON.parse(row.value), firstRun);
  });

  it('reports the second run as updates rather than creations', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/sync`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(body.data.created, 0);
    assert.equal(body.data.updated, 5);
    assert.equal(body.data.failed, 1);
    // The orphan is skipped on every run, not just the first: SGP still knows
    // no contract for the login it reports.
    assert.equal(body.data.skipped, 4);
    assert.equal(body.data.linked, 5);
  });
});

describe('fleet reconciliation overview', () => {
  let overview;

  before(async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/overview`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    overview = body.data;
  });

  it('counts the devices GenieACS knows against the links the panel stores', () => {
    assert.equal(overview.enabled, true);
    assert.equal(overview.totals.devices, GENIE_DEVICES.length + 1);
    assert.equal(overview.totals.linked, 5);
    assert.equal(overview.totals.unlinked, 2);
    assert.ok(Date.parse(overview.generatedAt));
  });

  it('groups the linked contracts by derived state', () => {
    assert.deepEqual(overview.byState, {
      active: 3,
      blocked: 1,
      cancelled: 1,
      unknown: 0
    });
  });

  it('flags ONTs informing on a blocked or cancelled contract', () => {
    const ids = overview.divergences.onlineBlocked.map((entry) => entry.deviceId).sort();
    assert.deepEqual(ids, ['fleet-blocked', 'fleet-cancelled']);
    assert.equal(overview.totals.onlineBlocked, 2);
    const blocked = overview.divergences.onlineBlocked
      .find((entry) => entry.deviceId === 'fleet-blocked');
    assert.equal(blocked.contract, '1002');
    assert.equal(blocked.clientName, 'Bruno Reis');
    assert.equal(blocked.statusLabel, 'Bloqueado');
    assert.equal(blocked.state, 'blocked');
    assert.ok(Date.parse(blocked.lastInform));
  });

  it('flags active contracts whose ONT stopped informing', () => {
    assert.equal(overview.totals.offlineActive, 1);
    const [entry] = overview.divergences.offlineActive;
    assert.equal(entry.deviceId, 'fleet-offline');
    assert.equal(entry.contract, '1004');
    assert.equal(entry.state, 'active');
  });

  it('lists the devices with no SGP link at all', () => {
    const unlinked = overview.divergences.unlinked;
    assert.equal(unlinked.length, 2);
    const empty = unlinked.find((entry) => entry.deviceId === 'fleet-empty');
    assert.equal(empty.customerId, 'CSG-FLEET07-000007');
    assert.equal(empty.pppoe, 'vazio@provedor');
    const orphan = unlinked.find((entry) => entry.deviceId === 'fleet-orphan');
    assert.equal(orphan.customerId, null);
    assert.equal(orphan.pppoe, 'orfao@provedor');
  });

  it('carries the last sync summary so the UI survives a reload', () => {
    assert.equal(overview.lastSync.total, FLEET.length + 1);
    assert.equal(overview.lastSync.linked, 5);
    assert.ok(Date.parse(overview.lastSync.finishedAt));
  });
});

describe('stored link listing', () => {
  it('returns every link for the devices list to merge', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/links`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.links.length, 5);
    const manual = body.data.links.find((link) => link.deviceId === 'fleet-manual');
    assert.deepEqual(Object.keys(manual), [
      'deviceId',
      'contract',
      'clientName',
      'plan',
      'status',
      'statusLabel',
      'state',
      'linkMode',
      'lastSyncedAt'
    ]);
    assert.equal(manual.contract, '1005');
    assert.equal(manual.state, 'active');
    assert.equal(manual.linkMode, 'manual');
    assert.ok(Date.parse(manual.lastSyncedAt));
  });

  it('never exposes the subscriber document in the fleet listing', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/links`, { headers: authHeaders(token) });
    assert.ok(body.data.links.every((link) => !('document' in link)));
  });
});
