import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * As duas pontas do modo agente, juntas: o painel de verdade (hub, conector,
 * rotas) e o PROGRAMA de verdade (`agent/skygenpanel-agent.mjs`), falando com o
 * GenieACS falso. Os outros dois arquivos provam cada ponta contra um dublê da
 * outra; este prova que as duas, como foram escritas, se entendem — o
 * contrato é o mesmo dos dois lados, e não só no papel.
 *
 * - a lista de equipamentos e o teste de conexão passam pelo agente, com a
 *   credencial da NBI e o cabeçalho `total` (de que a contagem depende);
 * - desligado o agente, a rota diz 503 `acs_agent_offline`; religado, volta;
 * - gerar outra chave derruba o agente com "chave revogada".
 */

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');
const { default: GenieAcsAuthService } = await import('../src/services/genieacsAuthService.js');
const { connectorFor } = await import('../src/services/genieacs/connector.js');
const { agentHub } = await import('../src/services/genieacs/agentHub.js');
const { startAgent } = await import('../agent/skygenpanel-agent.mjs');

const SEGREDO_DA_NBI = 'segredo-da-nbi-e2e';

let panelUrl;
let genie;
let tenantId;
let ownerToken;
let token;
const ligados = [];

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(ownerToken), ...(options.headers || {}) }
});

async function ate(condicao, rotulo, prazoMs = 5_000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`esperando: ${rotulo}`);
}

/** O programa do agente, com o log guardado e a reconexão curta. */
function ligar(chave = token) {
  const linhas = [];
  const guarda = (nivel) => (...args) => linhas.push(`${nivel} ${args.join(' ')}`);
  const agente = startAgent({
    panelUrl,
    token: chave,
    genieacsUrl: genie.url,
    logger: { info: guarda('info'), warn: guarda('warn'), error: guarda('error') },
    backoff: { minMs: 20, maxMs: 200 }
  });
  const ligado = { agente, log: () => linhas.join('\n') };
  ligados.push(ligado);
  return ligado;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [buildDevice({ id: 'ont-1' }), buildDevice({ id: 'ont-2', pppoeUsername: 'joao@provedor' })]
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dono-e2e', password: 'senha-do-dono-e2e-1', email: 'dono-e2e@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  ownerToken = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  // Nenhum endereço de GenieACS gravado no painel: no modo agente, quem sabe
  // onde ele está é o agente.
  await runInTenant(tenantId, () => GenieAcsAuthService.saveConfig({ authType: 'bearer', secret: SEGREDO_DA_NBI }));

  const trocou = await api('/settings/genieacs-connection', { method: 'PUT', body: { mode: 'agent' } });
  assert.equal(trocou.status, 200, JSON.stringify(trocou.body));
  const gerada = await api('/settings/genieacs-connection/agent-token', { method: 'POST' });
  assert.equal(gerada.status, 201, JSON.stringify(gerada.body));
  token = gerada.body.data.token;
});

afterEach(async () => {
  for (const { agente } of ligados.splice(0)) await agente.stop();
  await ate(() => !agentHub.isConnected(tenantId), 'o hub soltar a conexão');
  genie.state.respond = null;
});

after(async () => {
  if (genie) await genie.close();
  await stopTestServers();
});

describe('o painel e o programa do agente, juntos', () => {
  it('a lista de equipamentos passa pelo agente, com a credencial da NBI', async () => {
    ligar();
    await ate(() => agentHub.isConnected(tenantId), 'o agente conectar');
    const desde = genie.state.requests.length;
    const { status, body } = await api('/devices');
    assert.equal(status, 200, JSON.stringify(body));
    const ids = JSON.stringify(body.data);
    assert.match(ids, /ont-1/);
    assert.match(ids, /ont-2/);
    const pedidos = genie.state.requests.slice(desde);
    assert.ok(pedidos.length > 0, 'o GenieACS não recebeu nada');
    assert.ok(pedidos.every((p) => p.authorization === `Bearer ${SEGREDO_DA_NBI}`), 'a credencial não chegou ao GenieACS');
  });

  it('o cabeçalho total atravessa o agente', async () => {
    genie.state.respond = ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json', total: '4321' });
      res.end('[]');
    };
    ligar();
    await ate(() => agentHub.isConnected(tenantId), 'o agente conectar');
    const resposta = await runInTenant(tenantId, async () => (await connectorFor()).request('devices', { query: { limit: 1 } }));
    assert.equal(resposta.headers.get('total'), '4321');
  });

  it('o status mostra conectado, a versão do programa e desde quando', async () => {
    ligar();
    await ate(async () => (await api('/settings/genieacs-connection')).body.data.agent.version, 'a versão chegar');
    const { agent } = (await api('/settings/genieacs-connection')).body.data;
    assert.equal(agent.connected, true);
    assert.match(agent.version, /^\d+\.\d+\.\d+/);
    assert.ok(Date.parse(agent.connectedAt) <= Date.now());
    assert.equal(agent.tokenHint, token.slice(-4));
  });

  it('o teste de conexão testa o caminho pelo agente, e não uma URL', async () => {
    ligar();
    await ate(() => agentHub.isConnected(tenantId), 'o agente conectar');
    const { status, body } = await api('/settings/test-genieacs', { method: 'POST', body: { url: 'http://127.0.0.1:1/' } });
    assert.equal(status, 200, JSON.stringify(body));
    // O stub ignora o `limit`: o que importa é a contagem ter vindo pelo agente.
    assert.ok(body.data.deviceCount > 0, JSON.stringify(body));
  });

  it('agente desligado: 503 acs_agent_offline, na lista e no teste; religado, volta sozinho', async () => {
    const primeiro = ligar();
    await ate(() => agentHub.isConnected(tenantId), 'o agente conectar');
    await primeiro.agente.stop();
    await ate(() => !agentHub.isConnected(tenantId), 'o hub perceber a queda');

    const lista = await api('/devices');
    assert.equal(lista.status, 503);
    assert.equal(lista.body.code, 'acs_agent_offline');
    assert.ok(lista.body.lastSeenAt, 'sem o último contato, a tela não diz "desde quando"');
    const teste = await api('/settings/test-genieacs', { method: 'POST', body: {} });
    assert.equal(teste.status, 503);
    assert.equal(teste.body.code, 'acs_agent_offline');
    assert.equal((await api('/settings/genieacs-connection')).body.data.agent.connectedAt, null);

    ligar();
    await ate(() => agentHub.isConnected(tenantId), 'o agente voltar');
    assert.equal((await api('/devices')).status, 200);
  });

  it('gerar outra chave derruba o agente, que registra "chave revogada" e não entra mais com a velha', async () => {
    const ligado = ligar();
    await ate(() => agentHub.isConnected(tenantId), 'o agente conectar');
    const nova = await api('/settings/genieacs-connection/agent-token', { method: 'POST' });
    assert.equal(nova.status, 201);
    await ate(() => /chave revogada/.test(ligado.log()), 'o agente registrar a revogação');
    // A reconexão com a chave velha é recusada (401) e o agente diz isso.
    await ate(() => /chave recusada pelo painel \(HTTP 401\)/.test(ligado.log()), 'o 401 da chave velha');
    assert.equal(agentHub.isConnected(tenantId), false);
    assert.ok(!ligado.log().includes(token), 'o log do agente tem a chave');
    await ligado.agente.stop();

    token = nova.body.data.token;
    ligar(token);
    await ate(() => agentHub.isConnected(tenantId), 'o agente entrar com a chave nova');
    assert.equal(await runInTenant(tenantId, () => GenieAcsConnection.mode()), 'agent');
  });
});
