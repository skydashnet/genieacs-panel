import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { asTenant, authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: MapStatusService } = await import('../src/services/mapStatusService.js');

/**
 * "Colocar todos no mapa" (`GET /api/mapping-data/bulk-placement`).
 *
 * Os equipamentos fora do mapa, separados pelo que a sincronização do SGP já
 * guardou. O que se defende: com coordenadas → `ready` (login com maiúscula e
 * espaço ainda casa); só com endereço → `needsAddress`; pelo vínculo do
 * equipamento quando o login não casa; o endereço do cliente dono do
 * contrato; sem contato → `noAddress`; quem já está no mapa não aparece; o
 * contato de outro provedor não conta; nada vai ao Nominatim.
 */
const realFetch = globalThis.fetch;
let panelUrl;
let token;
let genie;
let nominatim;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [
      buildDevice({ id: 'ONT-ANA', pppoeUsername: 'ANA@vila ' }),
      buildDevice({ id: 'ONT-BIA', pppoeUsername: 'bia@vila' }),
      buildDevice({ id: 'ONT-CAIO', pppoeUsername: 'caio@vila' }),
      buildDevice({ id: 'ONT-DUDA', pppoeUsername: 'login-trocado' }),
      buildDevice({ id: 'ONT-ZE', pppoeUsername: 'ze@vila' }),
      buildDevice({ id: 'ONT-VIZ', pppoeUsername: 'vizinho@vila' }),
      buildDevice({ id: 'ONT-JA', pppoeUsername: 'ja@vila' })
    ]
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));

  const db = getDb();
  const tenantId = await defaultTenantId();
  await db('tenants').insert({ slug: 'outro', name: 'Outro', status: 'active' });
  const outroId = (await db('tenants').where({ slug: 'outro' }).first()).id;
  await db('sgp_contacts').insert([
    {
      tenant_id: tenantId, contract: 'C-ANA', client_name: 'Ana', login: 'ana@vila',
      address: 'Rua A, 10 · Itaituba/PA',
      address_parts: JSON.stringify({ street: 'Rua A', number: '10', city: 'Itaituba', state: 'PA', latitude: -4.2761, longitude: -55.9836 })
    },
    {
      tenant_id: tenantId, contract: 'C-BIA', client_name: 'Bia', login: 'bia@vila',
      address_parts: JSON.stringify({ street: 'Rodovia Transamazônica', number: '100', city: 'Itaituba', state: 'PA' })
    },
    { tenant_id: tenantId, contract: 'C-CAIO', client_name: 'Caio', login: 'caio@vila', client_ref: 'cli-9' },
    {
      tenant_id: tenantId, contract: 'C-DUDA', client_name: 'Duda', login: 'duda@vila',
      address_parts: JSON.stringify({ city: 'Itaituba', state: 'PA', latitude: -4.29, longitude: -55.97 })
    },
    { tenant_id: tenantId, contract: 'C-JA', client_name: 'Já no mapa', login: 'ja@vila',
      address_parts: JSON.stringify({ city: 'Itaituba', latitude: -4.3, longitude: -55.9 }) },
    {
      tenant_id: outroId, contract: 'C-VIZ', client_name: 'Vizinho', login: 'vizinho@vila',
      address_parts: JSON.stringify({ city: 'Belém', latitude: -1.45, longitude: -48.5 })
    }
  ]);
  await db('sgp_clients').insert({
    tenant_id: tenantId, sgp_client_id: 'cli-9', name: 'Caio',
    address: JSON.stringify({ street: 'Rua do Cliente', number: '7', city: 'Itaituba', state: 'PA', latitude: -4.28, longitude: -55.99 })
  });
  await db('sgp_links').insert({ tenant_id: tenantId, device_id: 'ONT-DUDA', contract: 'C-DUDA', client_name: 'Duda' });
  const ponto = await call(`${panelUrl}/api/mapping-data/nodes`, {
    method: 'POST', headers: authHeaders(token),
    body: { node_id: 'cli-ja', type: 'ont', name: 'Já', latitude: -4.3, longitude: -55.9, pppoe: ' JA@vila' }
  });
  assert.equal(ponto.status, 201, JSON.stringify(ponto.body));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  MapStatusService.clearCache();
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

const previa = (headers = authHeaders(token)) => call(`${panelUrl}/api/mapping-data/bulk-placement`, { headers });

describe('GET /api/mapping-data/bulk-placement', () => {
  it('separa os fora do mapa pelo que o SGP já guardou, sem consultar o Nominatim', async () => {
    nominatim = 0;
    globalThis.fetch = (input, init) => {
      if (String(input).includes('nominatim')) nominatim += 1;
      return realFetch(input, init);
    };
    const res = await previa();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { ready, needsAddress, noAddress, total, truncated } = res.body.data;
    assert.equal(total, 6);
    assert.equal(truncated, false);

    const prontos = Object.fromEntries(ready.map((item) => [item.deviceId, item]));
    assert.deepEqual(Object.keys(prontos).sort(), ['ONT-ANA', 'ONT-CAIO', 'ONT-DUDA']);
    // Login com maiúscula e espaço no ACS casa com o contato.
    assert.deepEqual(prontos['ONT-ANA'], {
      pppoe: 'ANA@vila', deviceId: 'ONT-ANA', contract: 'C-ANA', clientName: 'Ana',
      address: 'Rua A, 10 · Itaituba/PA', lat: -4.2761, lng: -55.9836
    });
    // Contrato sem endereço próprio: o do cliente dono dele.
    assert.equal(prontos['ONT-CAIO'].lat, -4.28);
    assert.match(prontos['ONT-CAIO'].address, /Rua do Cliente, 7/);
    // Login que não casa: pelo vínculo do equipamento no SGP.
    assert.equal(prontos['ONT-DUDA'].contract, 'C-DUDA');

    assert.deepEqual(needsAddress.map((item) => item.deviceId), ['ONT-BIA']);
    assert.equal(needsAddress[0].lat, undefined);
    assert.match(needsAddress[0].address, /Rodovia Transamazônica, 100/);

    // Sem contato, e o contato de outro provedor não conta.
    assert.deepEqual(noAddress.map((item) => [item.deviceId, item.reason]).sort(),
      [['ONT-VIZ', 'no_contract'], ['ONT-ZE', 'no_contract']]);
    // Já no mapa (com maiúscula e espaço no ponto): fica de fora.
    assert.ok(![...ready, ...needsAddress, ...noAddress].some((item) => item.deviceId === 'ONT-JA'));
    assert.equal(nominatim, 0);
  });

  it('contrato sem nem a cidade vai para os sem endereço', async () => {
    const tenantId = await defaultTenantId();
    await getDb()('sgp_contacts').insert({ tenant_id: tenantId, contract: 'C-ZE', client_name: 'Zé', login: 'ze@vila' });
    const res = await previa();
    const ze = res.body.data.noAddress.find((item) => item.deviceId === 'ONT-ZE');
    assert.equal(ze.reason, 'no_address');
    assert.equal(ze.clientName, 'Zé');
  });

  it('ACS fora do ar vira 502 com o motivo; sem sessão, 401', async () => {
    genie.state.respond = ({ send }) => send(401, {});
    try {
      const res = await previa();
      assert.equal(res.status, 502);
      assert.equal(res.body.code, 'genieacs_http');
    } finally {
      genie.state.respond = null;
    }
    assert.equal((await previa({})).status, 401);
  });
});
