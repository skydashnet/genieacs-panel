import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { authHeaders, call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/**
 * Importação de KML/KMZ na Topologia (`POST /api/mapping-data/import`).
 *
 * O que se defende: acrescenta sem apagar o que já está no mapa; id que já
 * existe é pulado, nunca sobrescrito; cabo para ponto inexistente volta em
 * `errors`; lote grande demais e waypoint inválido são recusados; e a
 * correção do validador de waypoints vale também para o cadastro manual.
 */
let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => { await stopTestServers(); });

const importar = (body, headers = authHeaders(token)) =>
  call(`${panelUrl}/api/mapping-data/import`, { method: 'POST', headers, body });
const ponto = (node_id, extra = {}) => ({ node_id, type: 'odp', name: node_id, latitude: -4.27, longitude: -55.98, ...extra });

describe('POST /api/mapping-data/import', () => {
  it('sem sessão, 401', async () => {
    assert.equal((await importar({ nodes: [], edges: [] }, {})).status, 401);
  });

  it('acrescenta ao que já existe, sem apagar', async () => {
    const manual = await call(`${panelUrl}/api/mapping-data/nodes`, {
      method: 'POST', headers: authHeaders(token), body: ponto('manual-1', { name: 'Desenhado à mão' })
    });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));

    const res = await importar({
      nodes: [ponto('kml-a'), ponto('kml-b', { latitude: -4.28 })],
      edges: [{ edge_id: 'kml-cabo-1', source: 'kml-a', target: 'manual-1', fiber_type: 'drop', distance: 120, waypoints: [[-4.275, -55.981]] }]
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { createdNodes: 2, createdEdges: 1, skippedNodes: 0, skippedEdges: 0, errors: [] });

    const nodes = await getDb()('mapping_nodes').select('node_id', 'name');
    assert.deepEqual(nodes.map((n) => n.node_id).sort(), ['kml-a', 'kml-b', 'manual-1']);
    const cabo = await getDb()('mapping_edges').where({ edge_id: 'kml-cabo-1' }).first();
    assert.deepEqual(JSON.parse(cabo.waypoints), [[-4.275, -55.981]]);
  });

  it('id que já existe é pulado e contado, nunca sobrescrito', async () => {
    const res = await importar({
      nodes: [ponto('manual-1', { name: 'Nome do KML' }), ponto('kml-c')],
      edges: [{ edge_id: 'kml-cabo-1', source: 'kml-a', target: 'kml-b' }]
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.createdNodes, 1);
    assert.equal(res.body.data.skippedNodes, 1);
    assert.equal(res.body.data.skippedEdges, 1);
    const manual = await getDb()('mapping_nodes').where({ node_id: 'manual-1' }).first();
    assert.equal(manual.name, 'Desenhado à mão');
  });

  it('cabo para ponto que não existe volta em errors', async () => {
    const res = await importar({ nodes: [], edges: [{ edge_id: 'orfao', source: 'kml-a', target: 'nao-existe' }] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.errors, ['orfao']);
    assert.equal(await getDb()('mapping_edges').where({ edge_id: 'orfao' }).first(), undefined);
  });

  it('recusa lote grande demais, formato errado e waypoint inválido', async () => {
    assert.equal((await importar({ nodes: 'x', edges: [] })).status, 400);
    const muitos = Array.from({ length: 2001 }, (_, i) => ponto(`n-${i}`));
    assert.equal((await importar({ nodes: muitos, edges: [] })).status, 400);
    const ruim = await importar({ nodes: [], edges: [{ edge_id: 'ruim', source: 'kml-a', target: 'kml-b', waypoints: [[200, 0]] }] });
    assert.equal(ruim.status, 400);
  });

  it('o cadastro manual também recusa waypoint inválido (era aceito em silêncio)', async () => {
    const res = await call(`${panelUrl}/api/mapping-data/edges`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { edge_id: 'manual-cabo', source: 'kml-a', target: 'kml-b', waypoints: [[1, 2, 3]] }
    });
    assert.equal(res.status, 400);
  });
});
