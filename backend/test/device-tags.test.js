import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  asTenant, authHeaders, call, getDb, insertReturningId, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: DeviceTagService, tagValue } = await import('../src/services/deviceTagService.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

const DEVICE = 'ZTE-F670L-ZTE3BJNP5335356';
const LOGIN = 'st100.563';
/** What the other tool left on the ONT, which the panel must not touch. */
const FOREIGN = ['cliente_f4ad7f86', 'seller_6edfdf0d', 'Installed_20260921'];

/** The SGP cadastre: login → contract. Reassigned by the tests that move it. */
let cadastre;
/** GenieACS's tag store, by device id. */
let tags;
let failTagWrites = false;
let genieServer;
let sgpServer;
let panelUrl;
let token;
let storeSlug;

const linkDevice = (contract) => asTenant(() => SgpService.linkDevice(DEVICE, { contract }));
const unlinkDevice = () => asTenant(() => SgpService.unlinkDevice(DEVICE));
const tagsOf = () => [...tags.get(DEVICE)].sort();

function document(id) {
  return {
    _id: id,
    _tags: [...(tags.get(id) || [])],
    _lastInform: new Date().toISOString(),
    _deviceId: { _SerialNumber: 'ZTE3BJNP5335356', _Manufacturer: 'ZTE', _ProductClass: 'F670L' },
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: { _value: 'V9.0.11P1N49B' } },
      WANDevice: {
        1: { WANConnectionDevice: { 1: { WANPPPConnection: { 1: { Username: { _value: LOGIN } } } } } }
      }
    }
  };
}

function startGenieStub() {
  genieServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const tagPath = url.pathname.match(/^\/devices\/([^/]+)\/tags\/([^/]+)$/);
    if (tagPath) {
      if (failTagWrites) {
        res.writeHead(500);
        return res.end('boom');
      }
      const id = decodeURIComponent(tagPath[1]);
      const tag = decodeURIComponent(tagPath[2]);
      const set = tags.get(id);
      if (req.method === 'POST') set.add(tag);
      if (req.method === 'DELETE') set.delete(tag);
      res.writeHead(200);
      return res.end('');
    }
    if (!url.pathname.startsWith('/devices')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const raw = url.searchParams.get('query');
    const filter = raw ? JSON.parse(raw)._id : null;
    const wanted = filter?.$in ?? (filter ? [filter] : null);
    const rows = [...tags.keys()]
      .filter((id) => !wanted || wanted.includes(id))
      .map(document);
    res.writeHead(200, { 'Content-Type': 'application/json', total: String(rows.length) });
    res.end(JSON.stringify(rows));
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
      const contract = payload.contrato ?? cadastre.get(payload.login);
      return res.end(JSON.stringify({
        status: 1,
        contratos: contract
          ? [{ contrato: String(contract), contratoStatusDisplay: 'Ativo', login: LOGIN, bloqueado: false }]
          : []
      }));
    });
  });
  return new Promise((done) => {
    sgpServer.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const [sgpUrl, genieUrl] = await Promise.all([startSgpStub(), startGenieStub()]);
  await asTenant(() => Setting.upsert('genieAcsUrl', genieUrl));
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: 'painel', token: 'token-tags', linkMode: 'pppoe'
  }));
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'Thiago Técnico', password: 'operator-password-1', email: 'thiago@exemplo.test' }
  });
  token = setup.body.data.token;
  const tenant = await getDb()('tenants').orderBy('id', 'asc').first();
  storeSlug = `loja_${tagValue(tenant.slug)}`;
});

after(async () => {
  await Promise.all([
    new Promise((done) => sgpServer.close(done)),
    new Promise((done) => genieServer.close(done))
  ]);
  await stopTestServers();
});

beforeEach(async () => {
  cadastre = new Map([[LOGIN, '593']]);
  tags = new Map([[DEVICE, new Set(FOREIGN)]]);
  failTagWrites = false;
  await getDb()('sgp_links').del();
  await getDb()('customer_accounts').del();
});

describe('the value a tag can carry', () => {
  it('keeps only what GenieACS accepts', () => {
    assert.equal(tagValue('CSG-2JRSUBT-A3B6TF'), 'CSG_2JRSUBT_A3B6TF');
    assert.equal(tagValue('Thiago Técnico'), 'Thiago_Tecnico');
    assert.equal(tagValue('  --  '), null);
  });
});

describe('the contract tag', () => {
  it('is written when the ONT is linked, with the store', async () => {
    await linkDevice('593');
    assert.deepEqual(tagsOf(), [...FOREIGN, 'contrato_593', storeSlug].sort());
  });

  it('follows the link to another contract', async () => {
    await linkDevice('593');
    await linkDevice('600');
    assert.ok(tagsOf().includes('contrato_600'));
    assert.ok(!tagsOf().includes('contrato_593'));
  });

  it('goes away when the ONT is unlinked', async () => {
    await linkDevice('593');
    await unlinkDevice();
    assert.ok(!tagsOf().some((tag) => tag.startsWith('contrato_')));
  });

  it('is written when the link comes from the reported login', async () => {
    await asTenant(() => SgpService.resolveDeviceContract(DEVICE));
    assert.ok(tagsOf().includes('contrato_593'));
  });
});

describe('what the other tool wrote', () => {
  it('is never touched', async () => {
    await linkDevice('593');
    await unlinkDevice();
    for (const tag of FOREIGN) assert.ok(tagsOf().includes(tag), `${tag} survives`);
  });
});

describe('the customer ID and the technician', () => {
  it('are written when the installation is recorded', async () => {
    const { record } = await CustomerPortalPasswordService.createRecord();
    await asTenant(() => insertReturningId('customer_accounts', {
      customer_id: 'CSG-2JRSUBT-A3B6TF',
      device_id: DEVICE,
      identity_hash: 'tags'.padEnd(64, '0'),
      software_id: 'V9.0.11P1N49B',
      pppoe_username: LOGIN,
      active: true,
      ...record
    }));

    const { status } = await call(
      `${panelUrl}/api/devices/${encodeURIComponent(DEVICE)}/installation-date`,
      { method: 'PUT', headers: authHeaders(token), body: { installationDate: '2026-09-21' } }
    );
    assert.equal(status, 200);
    assert.ok(tagsOf().includes('idcliente_CSG_2JRSUBT_A3B6TF'));
    assert.ok(tagsOf().includes('tecnico_Thiago_Tecnico'));
  });

  it('keeps the technician when a later pass has none to give', async () => {
    tags.get(DEVICE).add('tecnico_Thiago_Tecnico');
    await asTenant(() => DeviceTagService.reconcile(DEVICE));
    assert.ok(tagsOf().includes('tecnico_Thiago_Tecnico'));
  });
});

describe('the fleet pass', () => {
  it('tags every linked ONT during the base sync', async () => {
    await getDb()('sgp_links').insert({
      tenant_id: (await getDb()('tenants').orderBy('id', 'asc').first()).id,
      device_id: DEVICE,
      contract: '593',
      link_mode: 'manual'
    });
    await asTenant(() => SgpService.syncFleet());
    assert.ok(tagsOf().includes('contrato_593'));
    assert.ok(tagsOf().includes(storeSlug));
  });

  it('writes nothing to a fleet already in line', async () => {
    await linkDevice('593');
    const summary = await asTenant(() => DeviceTagService.reconcileFleet());
    assert.equal(summary.changed, 0);
  });
});

describe('a GenieACS that refuses the tag', () => {
  it('does not cost the operator the link', async () => {
    failTagWrites = true;
    const link = await linkDevice('593');
    assert.equal(link.contract, '593');
  });
});
