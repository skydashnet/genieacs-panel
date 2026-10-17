import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

// Reached directly, with no request behind them, so nothing has resolved a
// provider. The routes that call these are already inside one.
const resolveDeviceContract = (...args) => asTenant(() => SgpService.resolveDeviceContract(...args));
const upsertLink = (link) => asTenant(() => SgpLink.upsert(link));

const APP = 'painel';
const TOKEN = 'token-freshness';
const DEVICE = 'sgp-freshness-device';

let sgpServer;
let sgpUrl;
let lookups = 0;

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/api/ura/consultacliente')) {
        lookups += 1;
        return res.end(JSON.stringify({
          status: 1,
          contratos: [{
            contrato: 9001,
            contratoStatusDisplay: 'Ativo',
            planoInternet: 'Fibra 1GB',
            razaoSocial: 'Titular Atual',
            cpfcnpj: '12345678909',
            login: payload.login,
            bloqueado: false
          }]
        }));
      }
      return res.end(JSON.stringify({ status: 1 }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

async function createAccount(deviceId, pppoe, customerId) {
  const { record } = await CustomerPortalPasswordService.createRecord();
  const id = await insertReturningId('customer_accounts', {
    customer_id: customerId,
    device_id: deviceId,
    identity_hash: customerId.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: pppoe,
    active: true,
    ...record
  });
  return id;
}

before(async () => {
  await startTestServers();
  sgpUrl = await startSgpStub();
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe'
  }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('a cached SGP link', () => {
  it('is refused when it belongs to a different account than the device does now', async () => {
    const previousAccountId = await createAccount(DEVICE, 'antigo@isp', 'CSG-STALE01-234567');
    await upsertLink({
      device_id: DEVICE,
      account_id: previousAccountId,
      contract: '1111',
      client_name: 'Titular Anterior',
      document: '99999999999',
      login: 'antigo@isp',
      link_mode: 'auto'
    });

    // The ONT is handed to someone else, so the account bound to it changes.
    await getDb()('customer_accounts').where({ id: previousAccountId }).update({
      active: false, device_id: `retired:${previousAccountId}`, identity_hash: `retired:${previousAccountId}`
    });
    const newAccountId = await createAccount(DEVICE, 'novo@isp', 'CSG-FRESH01-234567');

    const { link } = await resolveDeviceContract(DEVICE);
    assert.equal(link.account_id, newAccountId);
    assert.equal(link.contract, '9001');
    assert.notEqual(link.client_name, 'Titular Anterior');
  });

  /**
   * A manual pin belongs to the subscriber it was made for. When the ONT
   * changes hands the link above it is dropped, and what is left has to be
   * resolved afresh for whoever holds the device now — not reported as having
   * no contract because the dead pin left nothing to look up by.
   */
  it('re-resolves a manual link whose account changed, instead of going unlinked', async () => {
    const device = `${DEVICE}-manual`;
    const previousAccountId = await createAccount(device, 'antigo@isp', 'CSG-STALE02-234567');
    await upsertLink({
      device_id: device,
      account_id: previousAccountId,
      contract: '1111',
      client_name: 'Titular Anterior',
      document: '99999999999',
      login: 'antigo@isp',
      link_mode: 'manual'
    });

    await getDb()('customer_accounts').where({ id: previousAccountId }).update({
      active: false, device_id: `retired:${previousAccountId}`, identity_hash: `retired:${previousAccountId}`
    });
    const newAccountId = await createAccount(device, 'outro@isp', 'CSG-FRESH02-234567');

    const { link } = await resolveDeviceContract(device);
    assert.equal(link.account_id, newAccountId);
    assert.equal(link.contract, '9001');
    assert.equal(link.link_mode, 'auto', 'the previous subscriber\'s pin does not survive them');
  });

  it('is served from cache while it is still fresh', async () => {
    const before = lookups;
    await resolveDeviceContract(DEVICE);
    assert.equal(lookups, before, 'a fresh link must not hit the provider again');
  });

  it('is refreshed once it passes its time to live', async () => {
    await getDb()('sgp_links').where({ device_id: DEVICE }).update({
      last_synced_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
      client_name: 'Plano Antigo'
    });
    const before = lookups;
    const { link } = await resolveDeviceContract(DEVICE);
    assert.equal(lookups, before + 1, 'an expired link must be looked up again');
    assert.equal(link.client_name, 'Titular Atual');
  });

  it('treats a link with no timestamp as expired', () => {
    assert.equal(SgpService.isLinkExpired({ last_synced_at: null }), true);
    assert.equal(SgpService.isLinkExpired({ last_synced_at: new Date() }), false);
  });
});
