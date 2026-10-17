import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

// Reached directly, with no request behind them, so nothing has resolved a
// provider. The routes that call these are already inside one.
const resolve = (...args) => asTenant(() => SgpService.resolveDeviceContract(...args));
const syncFleet = () => asTenant(() => SgpService.syncFleet());
const linkRow = (deviceId) => asTenant(() => getDb()('sgp_links').where({ device_id: deviceId }).first());

const APP = 'painel';
const TOKEN = 'token-sem-conta';

/**
 * The fleet this whole thread is about: ONTs reporting a PPPoE login in their
 * own TR-098 tree, on a GenieACS with no VirtualParameters, and with no
 * customer account anywhere — the operator never turned Customer ID
 * generation on.
 */
const ONT = {
  bare: { device: 'sem-conta-1', login: 'assinante-um@provedor' },
  moved: { device: 'sem-conta-2', login: 'assinante-dois@provedor' },
  bridged: { device: 'sem-conta-3', login: null },
  withAccount: { device: 'com-conta', login: 'reportado@provedor' }
};

const reported = new Map(Object.values(ONT).map((ont) => [ont.device, ont.login]));

let sgpServer;
let genieServer;
let lookups = [];

function document(deviceId) {
  const login = reported.get(deviceId);
  const wan = login
    ? { 1: { WANConnectionDevice: { 1: { WANPPPConnection: { 1: { Username: { _value: login } } } } } } }
    : {};
  return {
    _id: deviceId,
    _lastInform: new Date().toISOString(),
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: { _value: 'V1.0.0' } },
      WANDevice: wan
    }
  };
}

function startGenieStub() {
  genieServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/devices')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const raw = url.searchParams.get('query');
    const wanted = raw ? JSON.parse(raw)._id : null;
    const ids = wanted ? [wanted] : [...reported.keys()];
    res.writeHead(200, { 'Content-Type': 'application/json', total: String(ids.length) });
    res.end(JSON.stringify(ids.filter((id) => reported.has(id)).map(document)));
  });
  return new Promise((done) => {
    genieServer.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${genieServer.address().port}`);
    });
  });
}

/** Answers with one contract per login, named after it. */
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
      lookups.push(payload);
      const login = payload.login;
      if (!login) return res.end(JSON.stringify({ status: 1, contratos: [] }));
      return res.end(JSON.stringify({
        status: 1,
        contratos: [{
          contrato: 7000 + [...reported.keys()].findIndex((id) => reported.get(id) === login),
          contratoStatusDisplay: 'Ativo',
          planoInternet: 'Fibra 1GB',
          razaoSocial: `Titular de ${login}`,
          cpfcnpj: '12345678909',
          login,
          bloqueado: false
        }]
      }));
    });
  });
  return new Promise((done) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

before(async () => {
  await startTestServers();
  const [sgpUrl, genieUrl] = await Promise.all([startSgpStub(), startGenieStub()]);
  await asTenant(() => Setting.upsert('genieAcsUrl', genieUrl));
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe'
  }));

  // One device does have an account, to prove the account still wins.
  const { record } = await CustomerPortalPasswordService.createRecord();
  await asTenant(() => insertReturningId('customer_accounts', {
    customer_id: 'CSG-CONTA01-000001',
    device_id: ONT.withAccount.device,
    identity_hash: 'com-conta'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'daconta@provedor',
    active: true,
    ...record
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
  lookups = [];
  reported.set(ONT.moved.device, ONT.moved.login);
  await asTenant(() => getDb()('sgp_links').del());
});

describe('an ONT with no customer account', () => {
  it('is linked by the login it reports itself', async () => {
    const { link } = await resolve(ONT.bare.device);

    assert.equal(lookups.at(-1).login, ONT.bare.login);
    assert.equal(link.client_name, `Titular de ${ONT.bare.login}`);
    assert.equal(link.link_mode, 'auto');
  });

  it('stores the link with no account behind it', async () => {
    await resolve(ONT.bare.device);
    const row = await linkRow(ONT.bare.device);

    assert.ok(row, 'the link exists');
    assert.equal(row.account_id, null);
  });

  it('still reports unlinked when the ONT reports no login', async () => {
    await assert.rejects(
      () => resolve(ONT.bridged.device),
      (error) => error.code === 'unlinked'
    );
    assert.equal(lookups.length, 0, 'nothing was asked of SGP');
  });

  it("leaves an account's own login in charge where there is one", async () => {
    await resolve(ONT.withAccount.device);
    // The account says `daconta@provedor`; the ONT reports something else.
    assert.equal(lookups.at(-1).login, 'daconta@provedor');
  });
});

describe('an ONT that changed subscriber', () => {
  it('is not served the previous subscriber\'s contract', async () => {
    const { link: first } = await resolve(ONT.moved.device);
    assert.equal(first.client_name, `Titular de ${ONT.moved.login}`);

    // The ONT is re-provisioned for someone else. With no account there is no
    // retirement to lean on: the reported login is the only thing that says so.
    reported.set(ONT.moved.device, ONT.bare.login);

    const { link: second } = await resolve(ONT.moved.device);
    assert.equal(second.client_name, `Titular de ${ONT.bare.login}`);
    assert.equal(second.contract, String(7000));
  });

  it('does not answer from a cache that belongs to the previous one', async () => {
    await resolve(ONT.moved.device);
    reported.set(ONT.moved.device, ONT.bare.login);
    lookups = [];

    // Well inside the cache TTL, so only the login change can force this.
    await resolve(ONT.moved.device);
    assert.equal(lookups.at(-1)?.login, ONT.bare.login);
  });
});

describe('the fleet sweep', () => {
  it('reaches devices that have no account at all', async () => {
    const summary = await syncFleet();

    assert.ok(summary.total >= 3, 'the account-less ONTs are targets');
    const bare = await linkRow(ONT.bare.device);
    assert.ok(bare, 'the sweep linked an ONT with no account');
    assert.equal(bare.account_id, null);
  });

  it('skips the ONT that reports no login instead of failing over it', async () => {
    const summary = await syncFleet();

    assert.equal(summary.failed, 0);
    assert.equal(await linkRow(ONT.bridged.device), undefined);
  });
});
