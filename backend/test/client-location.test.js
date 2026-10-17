import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/**
 * "Colocar no mapa" abrindo na casa do cliente
 * (`GET /api/mapping-data/client-location`).
 *
 * O endereço vem do que a sincronização do SGP guardou. O que se defende:
 * coordenadas do SGP usadas direto, sem consulta; sem elas, o endereço vai ao
 * Nominatim (rua, depois cidade); login com maiúscula ainda casa; contrato
 * sem endereço usa o do cliente; sem contrato, `found:false`; o contato de
 * outro provedor não aparece; sem sessão, 401.
 */
const realFetch = globalThis.fetch;
let panelUrl;
let token;
let consultas;

function nominatim(responder) {
  consultas = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://nominatim.openstreetmap.org/')) return realFetch(input, init);
    const parsed = new URL(url);
    consultas.push(parsed);
    const [status, body] = responder(parsed);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const db = getDb();
  const tenantId = await defaultTenantId();
  const [outro] = await db('tenants').insert({ slug: 'outro', name: 'Outro', status: 'active' }).returning('id').catch(async () => {
    await db('tenants').insert({ slug: 'outro', name: 'Outro', status: 'active' });
    return [await db('tenants').where({ slug: 'outro' }).first()];
  });
  const outroId = typeof outro === 'object' ? outro.id : outro;
  await db('sgp_contacts').insert([
    {
      tenant_id: tenantId, contract: 'C-GPS', client_name: 'Ana com GPS', login: 'ana@vila',
      address: 'Rua A, 10 · Centro - Itaituba/PA',
      address_parts: JSON.stringify({ street: 'Rua A', number: '10', city: 'Itaituba', state: 'PA', latitude: -4.2761, longitude: -55.9836 })
    },
    {
      tenant_id: tenantId, contract: 'C-RUA', client_name: 'Bia sem GPS', login: 'bia@vila',
      address_parts: JSON.stringify({ street: 'Rodovia Transamazônica', number: '100', district: 'Bela Vista', city: 'Itaituba', state: 'PA', zip: '68180010' })
    },
    {
      tenant_id: tenantId, contract: 'C-CLI', client_name: 'Caio', login: 'caio@vila', client_ref: 'cli-9'
    },
    {
      tenant_id: outroId, contract: 'C-VIZINHO', client_name: 'Vizinho', login: 'vizinho@vila',
      address_parts: JSON.stringify({ city: 'Belém', state: 'PA', latitude: -1.45, longitude: -48.5 })
    }
  ]);
  await db('sgp_clients').insert({
    tenant_id: tenantId, sgp_client_id: 'cli-9', name: 'Caio',
    address: JSON.stringify({ street: 'Rua do Cliente', number: '7', city: 'Itaituba', state: 'PA', latitude: -4.28, longitude: -55.99 })
  });
});

afterEach(() => { globalThis.fetch = realFetch; });
after(async () => { await stopTestServers(); });

const onde = (query, headers = authHeaders(token)) =>
  call(`${panelUrl}/api/mapping-data/client-location?${new URLSearchParams(query)}`, { headers });

describe('GET /api/mapping-data/client-location', () => {
  it('coordenadas do SGP: o ponto é esse, sem consultar o Nominatim; login com maiúscula casa', async () => {
    nominatim(() => [500, {}]);
    const res = await onde({ pppoe: ' ANA@Vila ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, {
      found: true, contract: 'C-GPS', clientName: 'Ana com GPS', address: 'Rua A, 10 · Centro - Itaituba/PA',
      lat: -4.2761, lng: -55.9836, precision: 'sgp'
    });
    assert.equal(consultas.length, 0);
  });

  it('sem coordenadas: localiza pelo endereço (rua e número)', async () => {
    nominatim((url) => [200, url.searchParams.get('street') ? [{ lat: '-4.2699', lon: '-55.9911' }] : []]);
    const res = await onde({ pppoe: 'bia@vila' });
    assert.equal(res.body.data.precision, 'address');
    assert.equal(res.body.data.lat, -4.2699);
    assert.match(res.body.data.address, /Rodovia Transamazônica, 100/);
    assert.equal(consultas[0].searchParams.get('street'), '100 Rodovia Transamazônica');
  });

  it('rua não achada: fica a cidade, e a tela avisa para ajustar', async () => {
    nominatim((url) => [200, url.searchParams.get('street') ? [] : [{ lat: '-4.2760', lon: '-55.9830' }]]);
    const res = await onde({ pppoe: 'bia@vila' });
    assert.equal(res.body.data.precision, 'city');
  });

  it('Nominatim fora do ar: volta o endereço sem ponto, não erro', async () => {
    nominatim(() => [503, {}]);
    const res = await onde({ pppoe: 'bia@vila' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.found, true);
    assert.equal(res.body.data.lat, undefined);
    assert.ok(res.body.data.address);
  });

  it('contrato sem endereço usa o do cliente dono dele', async () => {
    nominatim(() => [500, {}]);
    const res = await onde({ pppoe: 'caio@vila' });
    assert.equal(res.body.data.precision, 'sgp');
    assert.equal(res.body.data.lat, -4.28);
    assert.match(res.body.data.address, /Rua do Cliente, 7/);
  });

  it('sem contrato: found:false; de outro provedor: não aparece; sem nada: 400; sem sessão: 401', async () => {
    nominatim(() => [500, {}]);
    assert.deepEqual((await onde({ pppoe: 'ninguem@vila' })).body.data, { found: false });
    assert.deepEqual((await onde({ pppoe: 'vizinho@vila' })).body.data, { found: false });
    assert.equal((await onde({})).status, 400);
    assert.equal((await onde({ pppoe: 'ana@vila' }, {})).status, 401);
  });
});
