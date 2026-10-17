import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { asTenant, authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: MapStatusService, classifyNode } = await import('../src/services/mapStatusService.js');
const { default: OutageWatcher } = await import('../src/services/outageWatcher.js');

/**
 * Estado ao vivo na Topologia (`GET /api/mapping-data/status`).
 *
 * O ponto do mapa encontra o equipamento pelo PPPoE. O que se defende: online,
 * sinal fraco, offline e desconhecido saem certos; login com maiúscula ou
 * espaço ainda casa; ponto sem PPPoE fica de fora; sem ponto com PPPoE o ACS
 * nem é consultado; ACS fora do ar vira 502 com o motivo.
 */
let panelUrl;
let token;
let genie;
const velho = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [
      buildDevice({ id: 'ONT-BOA', pppoeUsername: 'ana@vila', rxPower: -20 }),
      buildDevice({ id: 'ONT-FRACA', pppoeUsername: 'bia@vila', rxPower: -29.5 }),
      buildDevice({ id: 'ONT-OFF', pppoeUsername: 'caio@vila', rxPower: -21, lastInform: velho })
    ]
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

afterEach(() => {
  genie.state.respond = null;
  MapStatusService.clearCache();
});

const status = () => call(`${panelUrl}/api/mapping-data/status`, { headers: authHeaders(token) });
const ponto = (node_id, pppoe) => call(`${panelUrl}/api/mapping-data/nodes`, {
  method: 'POST',
  headers: authHeaders(token),
  body: { node_id, type: 'ont', name: node_id, latitude: -4.27, longitude: -55.98, ...(pppoe ? { pppoe } : {}) }
});

describe('GET /api/mapping-data/status', () => {
  it('sem ponto com PPPoE, lista vazia e nenhuma consulta ao ACS', async () => {
    await ponto('caixa-sem-login');
    const antes = genie.state.requests.length;
    const res = await status();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.items, []);
    assert.equal(genie.state.requests.length, antes);
  });

  it('online, fraco, offline e desconhecido; login casa sem diferenciar maiúscula', async () => {
    await ponto('cli-ana', ' ANA@vila ');
    await ponto('cli-bia', 'bia@vila');
    await ponto('cli-caio', 'caio@vila');
    await ponto('cli-ze', 'ze@vila');
    const res = await status();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const porId = Object.fromEntries(res.body.data.items.map((item) => [item.node_id, item]));
    assert.equal(porId['cli-ana'].state, 'online');
    assert.equal(porId['cli-ana'].deviceId, 'ONT-BOA');
    assert.equal(porId['cli-bia'].state, 'weak');
    assert.equal(porId['cli-bia'].rxPower, -29.5);
    assert.equal(porId['cli-caio'].state, 'offline');
    assert.equal(porId['cli-ze'].state, 'unknown');
    assert.equal(porId['caixa-sem-login'], undefined);
    assert.deepEqual(res.body.data.summary, { online: 1, weak: 1, offline: 1, unknown: 1 });
  });

  it('caixa com a maioria dos clientes offline aparece como provável rompimento', async () => {
    const edge = (edge_id, source, target) => call(`${panelUrl}/api/mapping-data/edges`, {
      method: 'POST', headers: authHeaders(token), body: { edge_id, source, target, fiber_type: 'drop' }
    });
    const caixa = await call(`${panelUrl}/api/mapping-data/nodes`, {
      method: 'POST', headers: authHeaders(token),
      body: { node_id: 'cto-rua-b', type: 'odp', name: 'CTO Rua B', latitude: -4.28, longitude: -55.99, capacity: 8 }
    });
    assert.equal(caixa.status, 201);
    // Três clientes na caixa: dois caíram há horas, um segue online.
    genie.state.devices.push(
      buildDevice({ id: 'ONT-RB1', pppoeUsername: 'rb1@vila', lastInform: velho }),
      buildDevice({ id: 'ONT-RB2', pppoeUsername: 'rb2@vila', lastInform: velho }),
      buildDevice({ id: 'ONT-RB3', pppoeUsername: 'rb3@vila' })
    );
    for (const n of [1, 2, 3]) {
      await ponto(`cli-rb${n}`, `rb${n}@vila`);
      await edge(`drop-rb${n}`, 'cto-rua-b', `cli-rb${n}`);
    }
    const res = await status();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rompimento = res.body.data.outages.find((item) => item.node_id === 'cto-rua-b');
    assert.ok(rompimento, JSON.stringify(res.body.data.outages));
    assert.equal(rompimento.name, 'CTO Rua B');
    assert.equal(rompimento.count, 2);
    assert.equal(rompimento.total, 3);
    assert.deepEqual(rompimento.clients.sort(), ['cli-rb1', 'cli-rb2']);
    assert.equal(rompimento.since, velho);
  });

  it('o rompimento entra no histórico, com o pico, e fecha quando a caixa volta', async () => {
    const historico = () => call(`${panelUrl}/api/mapping-data/outages`, { headers: authHeaders(token) });
    // O teste anterior deixou a CTO Rua B com 2 de 3 offline; o vigia grava.
    await OutageWatcher.tick();
    let res = await historico();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const aberto = res.body.data.events.find((event) => event.node_id === 'cto-rua-b');
    assert.ok(aberto, JSON.stringify(res.body.data));
    assert.equal(aberto.ended_at, null);
    assert.equal(aberto.peak_count, 2);
    assert.equal(aberto.total_clients, 3);
    // O MySQL guarda o horário sem milissegundos: compara-se ao segundo.
    assert.ok(Math.abs(Date.parse(aberto.started_at) - Date.parse(velho)) < 1000, `${aberto.started_at} ≠ ${velho}`);
    assert.equal(res.body.data.byNode[0].node_name, 'CTO Rua B');

    // Os dois voltam: a próxima leitura fecha a ocorrência.
    for (const device of genie.state.devices) {
      if (device._id === 'ONT-RB1' || device._id === 'ONT-RB2') device._lastInform = new Date().toISOString();
    }
    MapStatusService.clearCache();
    await OutageWatcher.tick();
    res = await historico();
    const fechado = res.body.data.events.find((event) => event.node_id === 'cto-rua-b');
    assert.ok(fechado.ended_at);
    assert.ok(fechado.minutes >= 179, String(fechado.minutes));
    assert.equal(res.body.data.events.filter((event) => event.node_id === 'cto-rua-b').length, 1, 'uma ocorrência, não uma por leitura');
  });

  it('lista os equipamentos com PPPoE que ainda não estão no mapa', async () => {
    genie.state.devices.push(buildDevice({ id: 'ONT-NOVO', pppoeUsername: 'novo@vila' }));
    MapStatusService.clearCache();
    const res = await call(`${panelUrl}/api/mapping-data/unmapped`, { headers: authHeaders(token) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const logins = res.body.data.items.map((item) => item.pppoe);
    assert.ok(logins.includes('novo@vila'));
    // Já no mapa (mesmo com maiúscula/espaço no ponto): fica de fora.
    assert.ok(!logins.includes('ana@vila'));
    assert.ok(!logins.includes('rb1@vila'));
    assert.equal(res.body.data.total, logins.length);
  });

  it('ACS fora do ar vira 502 com o motivo', async () => {
    genie.state.respond = ({ send }) => send(401, {});
    const res = await status();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'genieacs_http');
    assert.match(res.body.message, /401/);
  });

  it('sem sessão, 401', async () => {
    assert.equal((await call(`${panelUrl}/api/mapping-data/status`)).status, 401);
  });
});

describe('classifyNode', () => {
  it('RX ausente não é sinal fraco', () => {
    assert.equal(classifyNode({ online: true, rxPower: null }), 'online');
    assert.equal(classifyNode({ online: true, rxPower: -27 }), 'online');
    assert.equal(classifyNode({ online: true, rxPower: -27.1 }), 'weak');
    assert.equal(classifyNode(null), 'unknown');
  });
});
