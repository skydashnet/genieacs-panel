import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: Setting } = await import('../src/models/Setting.js');

/**
 * "Status do serviço" da ficha: o que a ONT de cada contrato diz da linha
 * agora, lido do ACS — online pelo último inform, tempo ligado, IP da WAN,
 * sinal óptico. Quem não tem ONT vinculada diz isso, sem erro.
 */

let panelUrl;
let token;
let genie;

const status = (key) => call(`${panelUrl}/api/contacts/${encodeURIComponent(key)}/service-status`, { headers: authHeaders(token) });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const recente = buildDevice({ id: 'ONT-701', upTime: 86_400, rxPower: -19.7 });
  const antigo = buildDevice({ id: 'ONT-702', lastInform: new Date(Date.now() - 3 * 3_600_000).toISOString() });
  recente.InternetGatewayDevice.WANDevice[1].WANConnectionDevice[1].WANPPPConnection[1].ExternalIPAddress = {
    _value: '100.64.18.38', _writable: false, _timestamp: '2026-09-01T00:00:00.000Z'
  };
  genie = await startGenieAcsStub({ devices: [recente, antigo] });
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await getDb()('sgp_contacts').insert([
    { tenant_id: 1, contract: '701', client_name: 'COM ONT ONLINE', phone_e164: '5593991117001', state: 'active' },
    { tenant_id: 1, contract: '702', client_name: 'COM ONT SILENCIOSA', phone_e164: '5593991117002', state: 'active' },
    { tenant_id: 1, contract: '703', client_name: 'SEM ONT', phone_e164: '5593991117003', state: 'active' }
  ]);
  await getDb()('sgp_links').insert([
    { tenant_id: 1, device_id: 'ONT-701', contract: '701', client_name: 'COM ONT ONLINE', state: 'active', link_mode: 'manual' },
    { tenant_id: 1, device_id: 'ONT-702', contract: '702', client_name: 'COM ONT SILENCIOSA', state: 'active', link_mode: 'manual' }
  ]);
});

after(async () => {
  await genie?.close?.();
  await stopTestServers();
});

describe('status do serviço na ficha', () => {
  it('a ONT que informou agora está online, com tempo ligado, IP e sinal', async () => {
    const res = await status('701');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [contrato] = res.body.data.contracts;
    assert.equal(contrato.available, true);
    assert.equal(contrato.status, 'online');
    assert.equal(contrato.deviceId, 'ONT-701');
    assert.equal(contrato.uptimeSeconds, 86_400);
    assert.equal(contrato.ipAddress, '100.64.18.38');
    assert.equal(contrato.rxPower, -19.7);
    assert.match(contrato.model, /ZTE/);
    assert.doesNotMatch(JSON.stringify(res.body), /factory|joao@provedor/, 'nenhuma credencial sai');
  });

  it('a ONT que não informa há horas está offline', async () => {
    const res = await status('702');
    assert.equal(res.body.data.contracts[0].status, 'offline');
  });

  it('um contrato sem ONT vinculada diz isso, sem erro', async () => {
    const res = await status('703');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      { available: res.body.data.contracts[0].available, reason: res.body.data.contracts[0].reason },
      { available: false, reason: 'unlinked' }
    );
  });

  it('uma chave que não existe dá 404', async () => {
    const res = await status('CONTRATO-QUE-NAO-EXISTE');
    assert.equal(res.status, 404);
  });
});
