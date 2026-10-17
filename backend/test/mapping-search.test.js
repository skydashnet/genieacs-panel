import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: MappingController } = await import('../src/controllers/mappingController.js');

/**
 * A caixa "Buscar endereço" da Topologia.
 *
 * O Nominatim responde o que o teste mandar; nada sai de verdade. O que se
 * defende: o resultado vem curto e no formato que o mapa usa, a busca curta
 * não consulta ninguém, a falha lá fora vira 502 e sem sessão é 401.
 */
const realFetch = globalThis.fetch;
let panelUrl;
let token;
let consultas;

function fake(status, body) {
  consultas = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://nominatim.openstreetmap.org/')) return realFetch(input, init);
    consultas.push(new URL(url));
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
  MappingController.SEARCH_INTERVAL_MS = 0;
});

afterEach(() => { globalThis.fetch = realFetch; });
after(async () => { await stopTestServers(); });

const buscar = (q, headers = authHeaders(token)) =>
  call(`${panelUrl}/api/mapping-data/geocode?q=${encodeURIComponent(q)}`, { headers });

describe('GET /api/mapping-data/geocode', () => {
  it('devolve até 5 lugares com rótulo curto, só no Brasil', async () => {
    fake(200, [
      {
        lat: '-4.2761', lon: '-55.9836',
        display_name: 'Rodovia Transamazônica, Bela Vista, Itaituba, Região Geográfica Imediata de Itaituba, Região Geográfica Intermediária de Santarém, Pará, Região Norte, 68180-010, Brasil'
      },
      { lat: 'x', lon: '1', display_name: 'sem coordenada' }
    ]);
    const res = await buscar('Transamazônica, Itaituba');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, [
      { lat: -4.2761, lng: -55.9836, label: 'Rodovia Transamazônica, Bela Vista, Itaituba, Pará, Região Norte' }
    ]);
    assert.equal(consultas.length, 1);
    assert.equal(consultas[0].searchParams.get('countrycodes'), 'br');
    assert.equal(consultas[0].searchParams.get('limit'), '5');
    assert.equal(consultas[0].searchParams.get('q'), 'Transamazônica, Itaituba');
  });

  it('nada achado é lista vazia, não erro', async () => {
    fake(200, []);
    const res = await buscar('Lugar Nenhum');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });

  it('busca curta é recusada sem consultar; sem sessão, 401', async () => {
    fake(200, []);
    assert.equal((await buscar('ab')).status, 400);
    assert.equal((await buscar('Itaituba', {})).status, 401);
    assert.deepEqual(consultas, []);
  });

  it('Nominatim fora do ar vira 502', async () => {
    fake(503, {});
    const res = await buscar('Itaituba');
    assert.equal(res.status, 502);
    assert.ok(res.body.message);
  });
});
