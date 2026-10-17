import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

/**
 * O modo `agent`, do lado do painel: o hub que recebe o WebSocket do agente, o
 * conector que troca só o transporte, a chave e as rotas que a gerenciam.
 *
 * O "agente" daqui é um cliente mínimo escrito neste arquivo (o `WebSocket`
 * global do Node), falando o protocolo do contrato contra o GenieACS falso de
 * `genieacs-stub.js`. O programa de verdade é outro arquivo; o que se prova
 * aqui é o que o PAINEL garante, com qualquer agente do outro lado:
 *
 * - o pedido que chega ao GenieACS pelo agente é o mesmo que chegaria direto
 *   (caminho, busca, credencial, corpo) — o escopo por etiqueta incluso;
 * - o provedor sai da CHAVE, e só de uma chave válida de provedor ativo em
 *   modo `agent`; chave trocada derruba a conexão (4001), conexão nova
 *   substitui a velha (4002);
 * - agente fora do ar é `acs_agent_offline` NA HORA, e 503 nas rotas;
 * - a chave não aparece em trilha, exportação ou resposta que não a da geração.
 *
 * Edição self-hosted (o padrão). O que muda na SaaS — o modo nas mãos da
 * plataforma — está em `genieacs-agent-saas.test.js`: a edição é lida uma vez,
 * na carga, e um processo só tem uma.
 */

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: GenieAcsAuthService } = await import('../src/services/genieacsAuthService.js');
const { default: TenantExportService } = await import('../src/services/tenantExportService.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { runUnscoped } = await import('../src/config/tenantContext.js');
const { connectorFor } = await import('../src/services/genieacs/connector.js');
const { DEVICE_SCOPE_KEY, forgetSharedAcs } = await import('../src/services/genieacs/direct.js');
const { agentHub, hashAgentToken, AGENT_CONNECT_PATH } = await import('../src/services/genieacs/agentHub.js');
const { default: AgentConnector, AGENT_FALLBACK_ROOT, issueAgentToken } = await import('../src/services/genieacs/agent.js');

const SEGREDO_DA_NBI = 'segredo-da-nbi-do-alfa';
const FORMATO_DA_CHAVE = /^sgpa_[A-Za-z0-9_-]{43}$/;

let panelUrl;
let wsUrl;
let genie;
let alfa;
let beta;
const tokens = {};
/** Toda chave gerada neste arquivo — a trilha não pode conter nenhuma. */
const chavesGeradas = [];
/** Os agentes abertos por um caso, fechados no `afterEach`. */
const abertos = [];

const api = (papel, path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(tokens[papel]), ...(options.headers || {}) }
});

async function gerarChave(tenantId) {
  const { token } = await runInTenant(tenantId, () => issueAgentToken());
  chavesGeradas.push(token);
  return token;
}

const modo = (tenantId, valor) => runInTenant(tenantId, () => GenieAcsConnection.setMode(valor));

/**
 * O agente de mentira: conecta com a chave, diz `hello` e atende cada pedido
 * chamando o GenieACS falso, como o programa de verdade faz. `atender: false`
 * recebe e não responde; `aoPedir` troca o atendimento inteiro.
 */
async function ligarAgente(token, { atender = true, aoPedir = null, versao = '0.1.0-teste' } = {}) {
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
  const agente = { ws, pedidos: [], codigo: null };
  abertos.push(agente);
  agente.fechado = new Promise((resolve) => {
    ws.addEventListener('close', (evento) => {
      agente.codigo = evento.code;
      resolve(evento.code);
    });
  });
  ws.addEventListener('message', async (evento) => {
    const msg = JSON.parse(evento.data);
    if (msg.type !== 'request') return;
    agente.pedidos.push(msg);
    if (aoPedir) return aoPedir(msg, ws);
    if (!atender) return;
    const resposta = await fetch(`${genie.url}${msg.path}`, {
      method: msg.method,
      headers: msg.headers,
      body: msg.body === null ? undefined : Buffer.from(msg.body, 'base64'),
      redirect: 'manual'
    });
    const corpo = Buffer.from(await resposta.arrayBuffer());
    ws.send(JSON.stringify({
      type: 'response',
      id: msg.id,
      status: resposta.status,
      headers: Object.fromEntries(resposta.headers),
      body: corpo.length ? corpo.toString('base64') : null
    }));
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('o agente não conectou')), { once: true });
  });
  ws.send(JSON.stringify({ type: 'hello', version: versao }));
  return agente;
}

/** O status que o painel dá ao upgrade, lido cru (o `WebSocket` não expõe o 401). */
function statusDoUpgrade(token, caminho = AGENT_CONNECT_PATH) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${panelUrl}${caminho}`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    // Socket destruído sem resposta: é o que o painel faz com upgrade fora do
    // caminho do agente.
    req.on('error', () => resolve('destruido'));
    req.on('timeout', () => reject(new Error('upgrade sem resposta')));
    req.setTimeout(5_000);
    req.end();
  });
}

/** Espera uma condição, sem dormir mais do que precisa. */
async function ate(condicao, rotulo, prazoMs = 3_000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`esperando: ${rotulo}`);
}

/** Os pedidos que o GenieACS falso recebeu depois de `desde`, sem o que muda de uma chamada para a outra. */
const recebidos = (desde) => genie.state.requests.slice(desde)
  .map(({ method, path, search, authorization, contentType, body }) => ({ method, path, search, authorization, contentType, body }));

before(async () => {
  ({ panelUrl } = await startTestServers());
  wsUrl = `${panelUrl.replace(/^http/, 'ws')}${AGENT_CONNECT_PATH}`;
  genie = await startGenieAcsStub({
    devices: [
      buildDevice({ id: 'ont-alfa', tags: ['alfa_tag'] }),
      buildDevice({ id: 'ont-beta', pppoeUsername: 'maria@provedor', tags: ['beta_tag'] })
    ]
  });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'o-dono', password: 'senha-do-dono-1', email: 'o-dono@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  tokens.owner = setup.body.data.token;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // O alfa com o GenieACS falso e uma credencial de NBI: é ela que prova que o
  // pedido pelo agente leva a mesma credencial que o direto. O beta fica SEM
  // endereço nenhum — é o caso do agente sem URL configurada.
  await runInTenant(alfa, async () => {
    await Setting.upsert('genieAcsUrl', genie.url);
    await GenieAcsAuthService.saveConfig({ authType: 'bearer', secret: SEGREDO_DA_NBI });
  });

  const bcrypt = (await import('bcryptjs')).default;
  for (const papel of ['viewer', 'tech']) {
    const senha = `senha-do-${papel}-1`;
    const userId = await runInTenant(alfa, () => User.create({
      username: `op-${papel}`, password: bcrypt.hashSync(senha, 10), role: papel
    }));
    await runInTenant(alfa, () => TenantUser.create({ tenantId: alfa, userId, role: papel }));
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: `op-${papel}`, password: senha }
    });
    assert.ok(login.body?.data?.token, `o ${papel} precisa de um token`);
    tokens[papel] = login.body.data.token;
  }
});

afterEach(async () => {
  for (const agente of abertos.splice(0)) {
    if (agente.ws.readyState !== WebSocket.CLOSED) {
      agente.ws.close();
      await agente.fechado;
    }
  }
  await ate(() => !agentHub.isConnected(alfa) && !agentHub.isConnected(beta), 'o hub soltar as conexões');
  agentHub.forgetFailures();
  genie.state.respond = null;
  for (const id of [alfa, beta]) {
    await runInTenant(id, async () => {
      await GenieAcsConnection.setMode('direct');
      await Setting.upsert(DEVICE_SCOPE_KEY, '');
    });
  }
  forgetSharedAcs();
});

after(async () => {
  if (genie) await genie.close();
  await stopTestServers();
});

describe('quem o hub deixa entrar', () => {
  it('chave errada, ausente ou fora do formato: 401 no upgrade', async () => {
    await modo(alfa, 'agent');
    await gerarChave(alfa);
    assert.equal(await statusDoUpgrade(`sgpa_${'A'.repeat(43)}`), 401);
    assert.equal(await statusDoUpgrade(null), 401);
    assert.equal(await statusDoUpgrade('qualquer-coisa'), 401);
    assert.equal(agentHub.isConnected(alfa), false);
  });

  it('upgrade em outro caminho: o socket é fechado, sem resposta', async () => {
    const token = await gerarChave(alfa);
    assert.equal(await statusDoUpgrade(token, '/api/devices'), 'destruido');
  });

  it('chave válida de provedor em modo direct: 401 — e entra quando o modo vira agent', async () => {
    const token = await gerarChave(alfa);
    assert.equal(await statusDoUpgrade(token), 401);
    await modo(alfa, 'agent');
    assert.equal(await statusDoUpgrade(token), 101);
  });

  it('a chave de um provedor só serve o dono dela', async () => {
    await modo(alfa, 'agent');
    await modo(beta, 'agent');
    await gerarChave(alfa);
    const doBeta = await gerarChave(beta);

    const agente = await ligarAgente(doBeta);
    assert.equal(agentHub.isConnected(beta), true);
    assert.equal(agentHub.isConnected(alfa), false, 'a chave do beta abriu a conexão do alfa');

    // O pedido do alfa não desce pelo agente do beta — o alfa está sem agente.
    await assert.rejects(
      runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true })),
      (erro) => erro.code === 'acs_agent_offline'
    );
    assert.equal(agente.pedidos.length, 0, 'o agente do beta recebeu pedido do alfa');

    // E o do beta desce, e só pelo dele.
    const resposta = await runInTenant(beta, async () => (await connectorFor()).request('devices', { unscoped: true }));
    assert.equal(resposta.status, 200);
    assert.equal(agente.pedidos.length, 1);
  });

  it('chave nova derruba a conexão (4001), e a velha deixa de entrar', async () => {
    await modo(alfa, 'agent');
    const velha = await gerarChave(alfa);
    const agente = await ligarAgente(velha);

    const gerada = await api('owner', '/settings/genieacs-connection/agent-token', { method: 'POST' });
    assert.equal(gerada.status, 201, JSON.stringify(gerada.body));
    chavesGeradas.push(gerada.body.data.token);

    assert.equal(await agente.fechado, 4001);
    assert.equal(await statusDoUpgrade(velha), 401);
    assert.equal(await statusDoUpgrade(gerada.body.data.token), 101);
  });

  it('conexão nova do mesmo provedor substitui a antiga (4002)', async () => {
    await modo(alfa, 'agent');
    const token = await gerarChave(alfa);
    const primeiro = await ligarAgente(token);
    const segundo = await ligarAgente(token);
    assert.equal(await primeiro.fechado, 4002);
    assert.equal(agentHub.isConnected(alfa), true);

    const resposta = await runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true }));
    assert.equal(resposta.status, 200);
    assert.equal(primeiro.pedidos.length, 0);
    assert.equal(segundo.pedidos.length, 1);
  });

  it('sair do modo agent derruba a conexão (4003)', async () => {
    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa));
    const { status, body } = await api('owner', '/settings/genieacs-connection', { method: 'PUT', body: { mode: 'direct' } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(await agente.fechado, 4003);
  });

  it('o hello grava a versão e o último contato, e a tela vê o agente conectado', async () => {
    await modo(alfa, 'agent');
    await ligarAgente(await gerarChave(alfa));
    await ate(async () => (await runInTenant(alfa, () => GenieAcsConnection.agentInfo())).version === '0.1.0-teste', 'a versão gravada');
    const { body } = await api('owner', '/settings/genieacs-connection');
    assert.equal(body.data.agent.connected, true);
    assert.equal(body.data.agent.version, '0.1.0-teste');
    assert.ok(body.data.agent.lastSeenAt);
  });

  it('força bruta: 20 chaves erradas do mesmo IP, e a próxima é 429', async () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal(await statusDoUpgrade(`sgpa_${crypto.randomBytes(32).toString('base64url')}`), 401);
    }
    assert.equal(await statusDoUpgrade(`sgpa_${crypto.randomBytes(32).toString('base64url')}`), 429);
  });
});

describe('o protocolo, do lado do painel', () => {
  it('frame malformado e id desconhecido são ignorados, e a conexão segue servindo', async () => {
    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa));
    agente.ws.send('isto não é JSON');
    agente.ws.send(JSON.stringify({ type: 'response', id: 'id-que-ninguem-pediu', status: 200, headers: {}, body: null }));
    agente.ws.send(JSON.stringify([1, 2, 3]));
    agente.ws.send(JSON.stringify({ type: 'inventado' }));
    const resposta = await runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true }));
    assert.equal(resposta.status, 200);
    assert.equal(agentHub.isConnected(alfa), true);
  });

  it('frame maior que o teto derruba só aquela conexão, e o processo segue de pé', async () => {
    await modo(alfa, 'agent');
    const token = await gerarChave(alfa);
    const grande = await ligarAgente(token);
    grande.ws.send('x'.repeat(64 * 1024 * 1024 + 1));
    assert.equal(await grande.fechado, 1009);

    const outro = await ligarAgente(token);
    const resposta = await runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true }));
    assert.equal(resposta.status, 200);
    assert.equal(outro.pedidos.length, 1);
  });

  it('o erro do agente chega ao chamador com o código do protocolo', async () => {
    await modo(alfa, 'agent');
    await ligarAgente(await gerarChave(alfa), {
      aoPedir: (msg, ws) => ws.send(JSON.stringify({ type: 'error', id: msg.id, code: 'upstream_unreachable', message: 'recusou' }))
    });
    await assert.rejects(
      runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true })),
      (erro) => erro.code === 'acs_agent_upstream_unreachable'
    );
  });

  it('resposta malformada a um pedido que espera: falha na hora, sem esperar o prazo', async () => {
    await modo(alfa, 'agent');
    await ligarAgente(await gerarChave(alfa), {
      aoPedir: (msg, ws) => ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 'duzentos', headers: {}, body: null }))
    });
    const inicio = Date.now();
    await assert.rejects(
      runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true, timeoutMs: 10_000 })),
      (erro) => erro.code === 'acs_agent_bad_request'
    );
    assert.ok(Date.now() - inicio < 2_000, 'esperou o prazo por uma resposta que já tinha chegado');
  });

  it('o painel manda o batimento como mensagem, além do ping de protocolo', async () => {
    agentHub.close();
    const anterior = agentHub.pingIntervalMs;
    agentHub.pingIntervalMs = 40;
    try {
      await modo(alfa, 'agent');
      const agente = await ligarAgente(await gerarChave(alfa));
      const batimentos = [];
      agente.ws.addEventListener('message', (evento) => {
        if (JSON.parse(evento.data).type === 'ping') batimentos.push(Date.now());
      });
      await ate(() => batimentos.length >= 2, 'dois batimentos');
      assert.ok(agentHub.connectedSince(alfa) instanceof Date);
    } finally {
      agentHub.close();
      agentHub.pingIntervalMs = anterior;
    }
    assert.equal(agentHub.connectedSince(alfa), null);
  });
});

describe('o pedido pelo agente é o pedido direto', () => {
  it('listar equipamentos: o GenieACS recebe o mesmo caminho, a mesma busca e a mesma credencial', async () => {
    // A primeira listagem do provedor ainda descobre onde o modelo publica a
    // potência óptica (e guarda); a comparação é entre duas listagens já
    // "aquecidas", senão o direto teria um pedido a mais só por ter vindo antes.
    assert.equal((await api('owner', '/devices')).status, 200);
    const antesDireto = genie.state.requests.length;
    const direto = await api('owner', '/devices');
    assert.equal(direto.status, 200, JSON.stringify(direto.body));
    const pedidosDiretos = recebidos(antesDireto);
    assert.ok(pedidosDiretos.length > 0);
    assert.equal(pedidosDiretos[0].authorization, `Bearer ${SEGREDO_DA_NBI}`);

    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa));
    const antesAgente = genie.state.requests.length;
    const peloAgente = await api('owner', '/devices');
    assert.equal(peloAgente.status, 200, JSON.stringify(peloAgente.body));

    assert.deepEqual(recebidos(antesAgente), pedidosDiretos);
    assert.deepEqual(
      peloAgente.body.data.devices.map((d) => d._id ?? d.id),
      direto.body.data.devices.map((d) => d._id ?? d.id)
    );
    // O que desceu pela conexão: caminho relativo à raiz, nunca URL absoluta.
    for (const pedido of agente.pedidos) {
      assert.match(pedido.path, /^\/devices/);
      assert.equal(pedido.headers.Authorization, `Bearer ${SEGREDO_DA_NBI}`);
    }
  });

  it('uma tarefa (POST) chega com o corpo íntegro', async () => {
    const antesDireto = genie.state.requests.length;
    const direto = await api('owner', '/devices/reboot', { method: 'POST', body: { deviceId: 'ont-alfa' } });
    assert.equal(direto.status, 200, JSON.stringify(direto.body));
    const pedidoDireto = recebidos(antesDireto).find((p) => p.method === 'POST');
    assert.ok(pedidoDireto, 'o direto não mandou a tarefa');

    await modo(alfa, 'agent');
    await ligarAgente(await gerarChave(alfa));
    const antesAgente = genie.state.requests.length;
    const peloAgente = await api('owner', '/devices/reboot', { method: 'POST', body: { deviceId: 'ont-alfa' } });
    assert.equal(peloAgente.status, 200, JSON.stringify(peloAgente.body));
    const pedidoPeloAgente = recebidos(antesAgente).find((p) => p.method === 'POST');

    assert.deepEqual(pedidoPeloAgente, pedidoDireto);
    assert.equal(pedidoPeloAgente.contentType, 'application/json');
    assert.deepEqual(JSON.parse(pedidoPeloAgente.body), { name: 'reboot' });
  });

  it('o escopo por etiqueta continua valendo no modo agente', async () => {
    await runInTenant(alfa, () => Setting.upsert(DEVICE_SCOPE_KEY, 'alfa_tag'));
    await modo(alfa, 'agent');
    await ligarAgente(await gerarChave(alfa));

    const antes = genie.state.requests.length;
    const lista = await api('owner', '/devices');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const ids = lista.body.data.devices.map((d) => d._id ?? d.id);
    assert.deepEqual(ids, ['ont-alfa'], 'o modo agente mostrou equipamento de fora da etiqueta');
    assert.ok(
      recebidos(antes).every((p) => p.path !== '/devices' || decodeURIComponent(p.search).includes('"_tags":"alfa_tag"')),
      'a busca que desceu pelo agente não levou a etiqueta'
    );

    const tarefas = genie.state.tasks.length;
    const alheio = await api('owner', '/devices/reboot', { method: 'POST', body: { deviceId: 'ont-beta' } });
    assert.equal(alheio.status, 404, JSON.stringify(alheio.body));
    assert.equal(genie.state.tasks.length, tarefas, 'a tarefa chegou ao equipamento de fora da etiqueta');
  });

  it('um firmware (PUT de arquivo) desce como bytes, com os metadados nos cabeçalhos', async () => {
    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa), { versao: '1.1.0' });
    await ate(async () => (await runInTenant(alfa, () => GenieAcsConnection.agentInfo())).version === '1.1.0', 'a versão chegar');
    // Bytes que não são UTF-8 válido: passar por string os corromperia.
    const firmware = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f]);
    const resposta = await fetch(`${panelUrl}/api/devices/firmware/files`, {
      method: 'POST',
      headers: {
        ...authHeaders(tokens.owner),
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'F670L_V2.bin',
        'X-Fw-Product-Class': 'F670L',
        'X-Fw-Oui': 'ZTEOUI',
        'X-Fw-Version': encodeURIComponent('V2.0 beta')
      },
      body: firmware
    });
    const corpo = await resposta.json();
    assert.equal(resposta.status, 201, JSON.stringify(corpo));
    assert.equal(corpo.data.id, 'F670L_V2.bin');
    const put = agente.pedidos.find((p) => p.method === 'PUT');
    assert.equal(put.path, '/files/F670L_V2.bin');
    assert.ok(Buffer.from(put.body, 'base64').equals(firmware), 'o corpo desceu diferente');
    assert.equal(put.headers.fileType, '1 Firmware Upgrade Image');
    assert.equal(put.headers.productClass, 'F670L');
    assert.equal(put.headers.version, 'V2.0 beta');
    const gravado = genie.state.uploads.at(-1);
    assert.ok(gravado.bytes.equals(firmware), 'o GenieACS recebeu bytes diferentes');
    genie.state.files = [];
  });

  it('agente antigo (sem os cabeçalhos de arquivo): 409 acs_agent_outdated, e nada desce', async () => {
    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa), { versao: '1.0.0' });
    await ate(async () => (await runInTenant(alfa, () => GenieAcsConnection.agentInfo())).version === '1.0.0', 'a versão chegar');
    const resposta = await fetch(`${panelUrl}/api/devices/firmware/files`, {
      method: 'POST',
      headers: {
        ...authHeaders(tokens.owner),
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'velho.bin',
        'X-Fw-Product-Class': 'F670L'
      },
      body: Buffer.from('firmware')
    });
    const corpo = await resposta.json();
    assert.equal(resposta.status, 409, JSON.stringify(corpo));
    assert.equal(corpo.code, 'acs_agent_outdated');
    assert.ok(!agente.pedidos.some((p) => p.method === 'PUT'), 'o arquivo desceu ao agente antigo');
  });

  it('sem endereço configurado, a raiz lógica fixa monta o caminho', async () => {
    assert.equal(await runInTenant(beta, () => AgentConnector.rootUrl()), AGENT_FALLBACK_ROOT);
    await modo(beta, 'agent');
    const agente = await ligarAgente(await gerarChave(beta));
    const resposta = await runInTenant(beta, async () => (await connectorFor()).request('devices', {
      unscoped: true, query: { projection: '_id' }
    }));
    assert.equal(resposta.status, 200);
    assert.equal(agente.pedidos[0].path, '/devices?projection=_id');
  });
});

describe('o agente fora do ar', () => {
  it('é acs_agent_offline na hora, e não depois do prazo', async () => {
    await modo(alfa, 'agent');
    const inicio = Date.now();
    await assert.rejects(
      runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true })),
      (erro) => erro.code === 'acs_agent_offline' && erro.status === 503
    );
    const levou = Date.now() - inicio;
    assert.ok(levou < 1_000, `levou ${levou} ms para dizer que o agente está fora`);
  });

  it('e 503 nas rotas, com o último contato — a lista e o detalhe', async () => {
    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa));
    await ate(async () => (await runInTenant(alfa, () => GenieAcsConnection.agentInfo())).lastSeenAt, 'o primeiro contato');
    agente.ws.close();
    await agente.fechado;
    await ate(() => !agentHub.isConnected(alfa), 'o hub soltar a conexão');

    for (const caminho of ['/devices', '/devices/ont-alfa']) {
      const inicio = Date.now();
      const { status, body } = await api('owner', caminho);
      assert.equal(status, 503, `${caminho}: ${JSON.stringify(body)}`);
      assert.equal(body.success, false);
      assert.equal(body.code, 'acs_agent_offline');
      assert.ok(body.lastSeenAt && !Number.isNaN(Date.parse(body.lastSeenAt)), JSON.stringify(body));
      assert.ok(Date.now() - inicio < 1_000, `${caminho} esperou para responder`);
    }
  });

  it('o pedido sem resposta respeita o prazo', async () => {
    await modo(alfa, 'agent');
    const agente = await ligarAgente(await gerarChave(alfa), { atender: false });
    const inicio = Date.now();
    await assert.rejects(
      runInTenant(alfa, async () => (await connectorFor()).request('devices', { unscoped: true, timeoutMs: 300 })),
      (erro) => erro.name === 'TimeoutError' && erro.code === 'acs_agent_timeout'
    );
    const levou = Date.now() - inicio;
    assert.ok(levou >= 250 && levou < 3_000, `levou ${levou} ms`);
    assert.equal(agente.pedidos.length, 1);
    assert.equal(agente.pedidos[0].timeoutMs, 300);

    // E pelo hub direto, sem o prazo do conector por cima.
    await assert.rejects(
      agentHub.request(alfa, { method: 'GET', path: '/devices', timeoutMs: 150 }),
      (erro) => erro.name === 'TimeoutError'
    );
  });
});

describe('as rotas da chave e do modo', () => {
  it('a leitura traz o modo, se ele é editável e o estado do agente — sem digest', async () => {
    const { status, body } = await api('owner', '/settings/genieacs-connection');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.mode, 'direct');
    assert.equal(body.data.modeEditable, true);
    assert.deepEqual(Object.keys(body.data.agent).sort(), ['connected', 'connectedAt', 'lastSeenAt', 'tokenCreatedAt', 'tokenHint', 'version']);
    assert.equal(JSON.stringify(body).includes('hash'), false);
  });

  it('tunnel na instalação própria é 400, e modo inventado também', async () => {
    for (const mode of ['tunnel', 'qualquer', undefined]) {
      const { status } = await api('owner', '/settings/genieacs-connection', { method: 'PUT', body: { mode } });
      assert.equal(status, 400, String(mode));
    }
    assert.equal(await runInTenant(alfa, () => GenieAcsConnection.mode()), 'direct');
  });

  it('gerar chave fora do modo agent é 409 mode_not_agent', async () => {
    const { status, body } = await api('owner', '/settings/genieacs-connection/agent-token', { method: 'POST' });
    assert.equal(status, 409);
    assert.equal(body.code, 'mode_not_agent');
  });

  it('viewer e tech não alcançam nenhuma das três', async () => {
    for (const papel of ['viewer', 'tech']) {
      for (const [method, path, body] of [
        ['GET', '/settings/genieacs-connection'],
        ['PUT', '/settings/genieacs-connection', { mode: 'agent' }],
        ['POST', '/settings/genieacs-connection/agent-token']
      ]) {
        const resposta = await api(papel, path, { method, body });
        assert.equal(resposta.status, 403, `${papel} ${method} ${path}`);
        assert.equal(resposta.body.code, 'missing_permission');
      }
    }
  });

  it('modo agent e a chave: mostrada uma vez, guardada como sha256, com a dica', async () => {
    const trocou = await api('owner', '/settings/genieacs-connection', { method: 'PUT', body: { mode: 'agent' } });
    assert.equal(trocou.status, 200, JSON.stringify(trocou.body));
    assert.equal(trocou.body.data.mode, 'agent');

    const { status, body } = await api('owner', '/settings/genieacs-connection/agent-token', { method: 'POST' });
    assert.equal(status, 201, JSON.stringify(body));
    const { token, agent } = body.data;
    chavesGeradas.push(token);
    assert.match(token, FORMATO_DA_CHAVE);
    assert.equal(agent.tokenHint, token.slice(-4));
    assert.ok(agent.tokenCreatedAt);
    assert.equal(agent.connected, false);

    const linha = await getDb()('tenant_genieacs_connections').where({ tenant_id: alfa }).first();
    assert.equal(linha.agent_token_hash, hashAgentToken(token));
    assert.equal(linha.agent_token_hint, token.slice(-4));

    const lido = await api('owner', '/settings/genieacs-connection');
    assert.equal(JSON.stringify(lido.body).includes(token), false, 'a leitura devolveu a chave');
    assert.equal(lido.body.data.agent.tokenHint, token.slice(-4));
  });

  it('a trilha tem a troca de modo e a dica da chave — e nenhuma chave, em linha nenhuma', async () => {
    await api('owner', '/settings/genieacs-connection', { method: 'PUT', body: { mode: 'agent' } });
    const gerada = await api('owner', '/settings/genieacs-connection/agent-token', { method: 'POST' });
    chavesGeradas.push(gerada.body.data.token);

    const trilha = await getDb()('audit_log').where({ tenant_id: alfa }).orderBy('id', 'asc');
    const troca = trilha.filter((l) => l.action === 'genieacs.connection_changed').at(-1);
    assert.deepEqual(JSON.parse(troca.detail), { from: 'direct', to: 'agent' });
    const geracao = trilha.filter((l) => l.action === 'genieacs.agent_token_generated').at(-1);
    assert.deepEqual(JSON.parse(geracao.detail), { tokenHint: gerada.body.data.token.slice(-4) });

    // Todas as linhas, de todos os provedores, e a trilha da plataforma.
    const tudo = await runUnscoped('o teste procura a chave em toda a trilha', async () => [
      ...(await getDb()('audit_log').select('*')),
      ...(await getDb()('platform_audit').select('*'))
    ]);
    const texto = JSON.stringify(tudo);
    assert.ok(chavesGeradas.length >= 5);
    for (const chave of chavesGeradas) {
      assert.equal(texto.includes(chave), false, 'uma chave do agente foi parar na trilha');
      assert.equal(texto.includes(hashAgentToken(chave)), false, 'o digest da chave foi parar na trilha');
    }
  });

  it('a exportação do provedor não leva o digest da chave', async () => {
    const token = await gerarChave(alfa);
    const arquivo = await runInTenant(alfa, () => TenantExportService.build());
    const [conexao] = arquivo.data.tenant_genieacs_connections;
    assert.ok(conexao, 'a linha da conexão tinha que estar no arquivo');
    assert.equal('agent_token_hash' in conexao, false);
    assert.equal(conexao.agent_token_hint, token.slice(-4));
    const tudo = JSON.stringify(arquivo.data);
    assert.equal(tudo.includes(hashAgentToken(token)), false);
    assert.equal(tudo.includes(token), false);
  });
});
