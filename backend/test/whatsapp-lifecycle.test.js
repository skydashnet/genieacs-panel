import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearEvolution } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { setProbeFetcher } = await import('../src/services/evolutionInstanceService.js');
const { WA_ACCOUNT_COLORS, nextAccountColor } = await import('../src/config/waAccountColors.js');

const WEBHOOK_BASE = 'https://painel.provedor.com.br/api/whatsapp-webhook';

let panelUrl;
let token;

/**
 * The fake servers listen on loopback, which the SSRF guard blocks — correctly,
 * and that block is itself covered elsewhere. So the panel is pointed at a
 * TEST-NET-3 address (203.0.113.0/24, public as far as the guard is concerned)
 * and only the socket is redirected, one layer below. The client's own code
 * path — allowlist, guard, headers, status handling — runs unchanged.
 */
const LOOPBACK_FOR = new Map();
let desfazerRota;

function installFakeDns() {
  // Um andar abaixo do que era: o cliente conecta por `PinnedTransport` ao
  // endereço que ele mesmo conferiu, e `globalThis.fetch` não é mais o caminho.
  // O que se redireciona é o `connect` do cliente, DEPOIS da guarda — que vê o
  // literal de TEST-NET-3 e deixa passar, como deixaria em produção.
  //
  // O esquema desce junto com o socket, e pela mesma razão de sempre.
  //
  // O cliente exige `https:` porque a chave dele viaja em toda requisição,
  // então o servidor tem de se ANUNCIAR como https para o caminho de código sob
  // teste rodar inteiro — allowlist, guard, headers. Só que o dublê é HTTP
  // puro, e falar TLS com ele exigiria um certificado auto-assinado mais
  // `rejectUnauthorized: false`, que é exatamente o que este código nunca faz,
  // nem em teste. Esta camada já mente sobre ONDE o socket vai; mentir também
  // sobre o esquema é a mesma mentira, uma linha abaixo da que se quer testar.
  desfazerRota = rotearEvolution((url) => {
    const port = LOOPBACK_FOR.get(url.hostname);
    return port ? `http://127.0.0.1:${port}${url.pathname}${url.search}` : null;
  });
}

/**
 * A stand-in for one Evolution server, in one of its two flavours.
 *
 * It answers the routes `utils/wa/evolutionApi.js` builds and records every
 * request, so a test can assert that the v2 and the GO payloads really differ
 * on the wire rather than only in the builder's unit tests.
 */
function startEvolution(flavor, ip) {
  const state = {
    requests: [],
    createStatus: 200,
    qrPending: false,
    restartStatus: 200,
    deleteStatus: 200,
    connected: false,
    loggedIn: false,
    createdName: null,
    // v2 hands back a key of its own choosing; whatever it says wins over the
    // token the panel minted.
    apiKey: `server-key-${flavor}`,
    // O webhook como o servidor o guarda. `null` é o estado de uma instância
    // que já existia quando o painel a adotou: o create respondeu "already
    // exists" e o webhook do payload nunca foi escrito.
    webhook: null
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const path = req.url.split('?')[0];
      state.requests.push({ method: req.method, path, apikey: req.headers.apikey || null, body });

      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const handler = flavor === 'go' ? goRoutes : v2Routes;
      const answer = handler(state, req.method, path, body);
      return send(answer.status, answer.data);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      LOOPBACK_FOR.set(ip, server.address().port);
      resolve({ state, server, baseUrl: `https://${ip}:${server.address().port}` });
    });
  });
}

const CONFLICT = { status: 409, data: { error: 'This instance name is already in use' } };
const NO_QR = { status: 400, data: { error: 'no QR code available' } };
const NOT_FOUND = { status: 404, data: { error: 'not found' } };

function v2Routes(state, method, path, body) {
  // v2 has no /server/ok; its root carries the version, which is what the probe
  // reads.
  if (method === 'GET' && path === '/') {
    return { status: 200, data: { version: '2.2.3', clientName: 'evolution_exchange' } };
  }
  if (method === 'POST' && path === '/instance/create') {
    state.createdName = body?.name || body?.instanceName || null;
    if (state.createStatus !== 200) return CONFLICT;
    // O create é o ÚNICO lugar em que o webhook entrava, e é por isso que o
    // ramo do conflito acima deixa `state.webhook` em null: é o estado real de
    // uma instância adotada em vez de criada.
    if (body?.webhook) state.webhook = { ...body.webhook };
    return {
      status: 200,
      data: {
        instance: { instanceName: state.createdName, instanceId: 'v2-instance-id', status: 'created' },
        hash: { apikey: state.apiKey },
        qrcode: { base64: 'data:image/png;base64,V2QR', code: '2@v2' }
      }
    };
  }
  if (method === 'GET' && path === '/instance/fetchInstances') {
    return { status: 200, data: [{ id: 'v2-recovered-id', name: state.createdName, connectionStatus: 'close' }] };
  }
  if (method === 'GET' && path.startsWith('/instance/connect/')) {
    return state.qrPending
      ? NO_QR
      : { status: 200, data: { base64: 'data:image/png;base64,V2QRNOVO', code: '2@novo' } };
  }
  if (method === 'GET' && path.startsWith('/instance/connectionState/')) {
    return { status: 200, data: { instance: { state: state.connected ? 'open' : 'close' } } };
  }
  if (method === 'POST' && path.startsWith('/instance/restart/')) {
    return state.restartStatus === 200
      ? { status: 200, data: { status: 'SUCCESS' } }
      : { status: 400, data: { error: 'no active session' } };
  }
  if (method === 'DELETE' && path.startsWith('/instance/logout/')) {
    return { status: 200, data: { status: 'SUCCESS' } };
  }
  if (method === 'DELETE' && path.startsWith('/instance/delete/')) {
    return state.deleteStatus === 200
      ? { status: 200, data: { status: 'SUCCESS' } }
      : { status: 500, data: { error: 'internal error deleting instance' } };
  }
  if (method === 'GET' && path.startsWith('/webhook/find/')) {
    // Instância sem webhook responde objeto vazio, e não 404: é o que o v2 faz,
    // e é o que torna "ausente" um veredito e não um erro de transporte.
    return { status: 200, data: state.webhook ? { webhook: state.webhook } : {} };
  }
  if (method === 'POST' && path.startsWith('/webhook/set/')) {
    const w = body?.webhook && typeof body.webhook === 'object' ? body.webhook : body;
    state.webhook = {
      enabled: w?.enabled !== false,
      url: String(w?.url ?? ''),
      byEvents: Boolean(w?.byEvents),
      events: Array.isArray(w?.events) ? [...w.events] : []
    };
    return { status: 200, data: { webhook: state.webhook } };
  }
  if (method === 'POST' && path.startsWith('/chat/whatsappNumbers/')) {
    return {
      status: 200,
      data: [
        { number: '559381110449', exists: true },
        { number: '5511999999999', exists: false }
      ]
    };
  }
  return NOT_FOUND;
}

function goRoutes(state, method, path, body) {
  if (method === 'GET' && path === '/server/ok') return { status: 200, data: { status: 'ok' } };
  if (method === 'POST' && path === '/instance/create') {
    state.createdName = body?.name || null;
    if (state.createStatus !== 200) return CONFLICT;
    // GO echoes the id and the token it was handed; the QR only exists after
    // /instance/connect starts the whatsmeow client.
    return {
      status: 200,
      data: { message: 'success', data: { id: body?.instanceId, name: body?.name, token: body?.token } }
    };
  }
  if (method === 'GET' && path === '/instance/all') {
    return {
      status: 200,
      data: { message: 'success', data: [{ id: 'go-recovered-id', name: state.createdName, connected: false }] }
    };
  }
  if (method === 'POST' && path === '/instance/connect') {
    return { status: 200, data: { message: 'success', data: {} } };
  }
  if (method === 'GET' && path === '/instance/qr') {
    return state.qrPending
      ? NO_QR
      : { status: 200, data: { message: 'success', data: { qrcode: 'data:image/png;base64,GOQR', code: '2@go' } } };
  }
  if (method === 'GET' && path === '/instance/status') {
    return {
      status: 200,
      data: { message: 'success', data: { Connected: state.connected, LoggedIn: state.loggedIn } }
    };
  }
  if (method === 'POST' && path === '/instance/reconnect') {
    return state.restartStatus === 200
      ? { status: 200, data: { message: 'success' } }
      : { status: 400, data: { error: 'no active session' } };
  }
  if (method === 'DELETE' && path === '/instance/logout') {
    return { status: 200, data: { message: 'success' } };
  }
  if (method === 'DELETE' && path.startsWith('/instance/delete/')) {
    return state.deleteStatus === 200
      ? { status: 200, data: { message: 'success' } }
      : { status: 500, data: { error: 'could not delete instance' } };
  }
  return NOT_FOUND;
}

let v2;
let go;
let conflicting;
/** Um v2 que já tinha a instância: é o caso em que o webhook nunca é escrito. */
let adotado;

function created(state) {
  return state.requests.find((r) => r.method === 'POST' && r.path === '/instance/create');
}

async function createAccount(baseUrl, extra = {}) {
  return call(`${panelUrl}/api/whatsapp/accounts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { baseUrl, adminKey: 'chave-global', ...extra }
  });
}

before(async () => {
  installFakeDns();
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  [v2, go, conflicting, adotado] = await Promise.all([
    startEvolution('v2', '203.0.113.11'),
    startEvolution('go', '203.0.113.12'),
    startEvolution('go', '203.0.113.13'),
    startEvolution('v2', '203.0.113.14')
  ]);

  await call(`${panelUrl}/api/whatsapp/config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { enabled: true, webhookBaseUrl: WEBHOOK_BASE }
  });
});

after(async () => {
  desfazerRota?.();
  await Promise.all([v2, go, conflicting, adotado].map(
    (fake) => new Promise((resolve) => fake.server.close(resolve))
  ));
  await stopTestServers();
});

describe('creating an instance on an Evolution v2 server', () => {
  let account;
  /** A resposta inteira da criação: o QR vive nela, não dentro da conta. */
  let criada;

  it('detects the flavour by probe before building any payload', async () => {
    const { status, body } = await createAccount(v2.baseUrl, { label: 'Suporte', purpose: 'support' });
    assert.equal(status, 201);
    criada = { body };
    account = body.data.account;
    assert.equal(account.flavor, 'v2');
    assert.equal(account.purpose, 'support');
    assert.equal(account.status, 'connecting');

    const probes = v2.state.requests.filter((r) => r.method === 'GET' && ['/server/ok', '/'].includes(r.path));
    assert.deepEqual(probes.map((r) => r.path).sort(), ['/', '/server/ok']);
    // Both probes come before the create, or the payload would have been built
    // for a server we had not identified yet.
    assert.ok(v2.state.requests.indexOf(probes[0]) < v2.state.requests.indexOf(created(v2.state)));
  });

  it('sends the v2 payload, with the webhook inside the create', () => {
    const request = created(v2.state);
    assert.equal(request.apikey, 'chave-global');
    assert.equal(request.body.qrcode, true);
    assert.equal(request.body.integration, 'WHATSAPP-BAILEYS');
    // Both spellings: newer builds want `name`, older ones `instanceName`.
    assert.equal(request.body.instanceName, request.body.name);
    assert.equal(request.body.webhook.enabled, true);
    assert.ok(request.body.webhook.url.startsWith(`${WEBHOOK_BASE}?t=`));
    // byEvents would append the event name after the query and stop `?t=`
    // parsing as one — the webhook would then reject every event.
    assert.equal(request.body.webhook.byEvents, false);
    assert.ok(request.body.webhook.events.includes('QRCODE_UPDATED'));
    // GO-only fields must not appear, and vice versa.
    assert.equal(request.body.advancedSettings, undefined);
  });

  it('returns the QR the create already carried, without a second round trip', () => {
    assert.equal(v2.state.requests.filter((r) => r.path.startsWith('/instance/connect/')).length, 0);
    // O QR vem no campo próprio da resposta, NÃO dentro da conta: ele é
    // credencial de pareamento e saiu do serializador compartilhado, que serve
    // rotas de `whatsapp.read`.
    assert.equal(criada.body.data.qr, 'data:image/png;base64,V2QR');
    assert.equal(account.qrCode, undefined, 'o QR não pode voltar dentro da conta');
    assert.ok(account.qrUpdatedAt);
  });

  it('stores the key the server chose over the token it minted', async () => {
    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), 'server-key-v2');
    assert.equal(row.instance_id, 'v2-instance-id');
  });
});

describe('creating an instance on an Evolution GO server', () => {
  let account;

  it('creates, then connects — which is what actually starts the client', async () => {
    const { status, body } = await createAccount(go.baseUrl, { label: 'Cobrança', purpose: 'billing' });
    assert.equal(status, 201);
    account = body.data.account;
    assert.equal(account.flavor, 'go');

    const request = created(go.state);
    assert.ok(request.body.instanceId, 'our own id is sent: GO deletes by id, not by name');
    assert.ok(request.body.token);
    assert.equal(request.body.advancedSettings.rejectCall, true);
    // alwaysOnline stays false here and is true on v2: marking the device
    // always available suppresses the notification on the operator's phone.
    assert.equal(request.body.advancedSettings.alwaysOnline, false);
    assert.equal(request.body.advancedSettings.readMessages, false);
    assert.equal(request.body.qrcode, undefined);
    assert.equal(request.body.webhook, undefined);

    const connect = go.state.requests.find((r) => r.path === '/instance/connect');
    assert.ok(connect, 'without /instance/connect the instance exists and never connects');
    assert.ok(connect.body.webhookUrl.startsWith(`${WEBHOOK_BASE}?t=`));
    assert.ok(connect.body.subscribe.includes('QRCODE'));
    // The instance token, not the global key: GO picks the instance by header.
    assert.equal(connect.apikey, request.body.token);
  });

  it('asks for the QR separately, because the create had none', () => {
    assert.ok(go.state.requests.some((r) => r.path === '/instance/qr'));
    assert.equal(account.qrCode, undefined, 'o QR não pode voltar dentro da conta');
  });

  it('gives each number its own webhook secret', async () => {
    const rows = await asTenant(() => WhatsAppAccount.getAll());
    const secrets = rows.map((row) => WhatsAppConfigService.decryptWebhookToken(row));
    assert.equal(new Set(secrets).size, rows.length);
    assert.ok(secrets.every((secret) => secret.length === 64));
  });
});

describe('an instance the server already has', () => {
  it('recovers its id from the listing instead of failing', async () => {
    conflicting.state.createStatus = 409;
    const { status, body } = await createAccount(conflicting.baseUrl);
    // "already in use" is the reconnect path: the row can be gone from the
    // panel while the instance is alive on the server.
    assert.equal(status, 201);
    const row = await asTenant(() => WhatsAppAccount.getById(body.data.account.id));
    assert.equal(row.instance_id, 'go-recovered-id');
    assert.ok(conflicting.state.requests.some((r) => r.path === '/instance/all'));
  });
});

describe('a QR that is not ready yet', () => {
  let pendingAccount;

  it('reports GO\'s 400 as pending rather than as a failure', async () => {
    go.state.qrPending = true;
    const { status, body } = await createAccount(go.baseUrl);
    assert.equal(status, 201);
    assert.equal(body.data.pending, true);
    assert.equal(body.data.qr, null);
    // Still 'connecting': the whatsmeow client is booting, not broken.
    assert.equal(body.data.account.status, 'connecting');
    assert.equal(body.data.account.lastError, null);
    pendingAccount = body.data.account;
  });

  it('hands over the QR on the next ask', async () => {
    go.state.qrPending = false;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${pendingAccount.id}/qr`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.pending, false);
    assert.equal(body.data.qr, 'data:image/png;base64,GOQR');
  });

  it('answers 404 for a number the panel does not have', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/999999/qr`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
    assert.equal(body.code, 'account_not_found');
  });
});

describe('reading the connection state', () => {
  let account;

  before(async () => {
    const { body } = await createAccount(go.baseUrl, { label: 'Estado' });
    account = body.data.account;
  });

  it('does not demote a number that is still pairing', async () => {
    go.state.connected = false;
    go.state.loggedIn = false;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/status`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    // The server is right and is reported, but a number that never connected
    // reads as disconnected for as long as its QR is on screen.
    assert.equal(body.data.state, 'disconnected');
    assert.equal(body.data.account.status, 'connecting');
  });

  it('promotes to connected, which is the escape hatch for a lost event', async () => {
    go.state.connected = true;
    go.state.loggedIn = true;
    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/status`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.state, 'connected');
    assert.equal(body.data.account.status, 'connected');
    // The QR is spent once the pairing lands.
    assert.equal(body.data.account.qrCode, undefined);
    assert.ok(body.data.account.lastSeenAt);
  });

  it('demotes only a number that was connected', async () => {
    go.state.connected = false;
    go.state.loggedIn = false;
    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/status`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.account.status, 'disconnected');
  });
});

describe('restart and disconnect', () => {
  let account;

  before(async () => {
    const { body } = await createAccount(v2.baseUrl, { label: 'Reinício' });
    account = body.data.account;
  });

  it('names "no active session" instead of dumping the server error', async () => {
    v2.state.restartStatus = 400;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/restart`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 409);
    assert.equal(body.code, 'no_session');
  });

  it('restarts with the instance key, not the global one', async () => {
    v2.state.restartStatus = 200;
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/restart`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.account.status, 'connecting');
    const restart = v2.state.requests.filter((r) => r.path.startsWith('/instance/restart/')).pop();
    assert.equal(restart.apikey, 'server-key-v2');
  });

  it('logs out, which is the only way to force a new QR', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${account.id}/disconnect`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.account.status, 'disconnected');
    assert.equal(body.data.account.qrCode, undefined);
  });
});

describe('editing what the panel knows about a number', () => {
  let account;

  before(async () => {
    const { body } = await createAccount(v2.baseUrl, { label: 'Antigo' });
    account = body.data.account;
  });

  it('renames, repurposes and moves the default flag', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/${account.id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: { label: 'Vendas', purpose: 'sales', isDefault: true }
    });
    assert.equal(status, 200);
    assert.equal(body.data.account.label, 'Vendas');
    assert.equal(body.data.account.purpose, 'sales');
    assert.equal(body.data.account.isDefault, true);

    // Exactly one row may carry the flag.
    const rows = await asTenant(() => WhatsAppAccount.getAll());
    assert.equal(rows.filter((row) => row.is_default).length, 1);
  });

  it('refuses a purpose the router would not understand', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/accounts/${account.id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: { purpose: 'qualquer-coisa' }
    });
    assert.equal(status, 400);
  });
});

/**
 * A cor de cada número, que é o que separa as conversas de um número das do
 * outro na caixa de entrada.
 */
describe('a cor de cada número', () => {
  const cores = async () => (await asTenant(() => WhatsAppAccount.getAll())).map((row) => row.color);

  it('cada número novo nasce com uma cor que nenhum outro tem, enquanto houver livre', async () => {
    // Até o nono número, nunca duas iguais; a partir dele, a menos usada. Os
    // números criados pelos casos acima contam — é o provedor inteiro.
    for (let rodada = 0; rodada < WA_ACCOUNT_COLORS.length + 1; rodada += 1) {
      // eslint-disable-next-line no-await-in-loop -- a cor de um depende dos anteriores
      const antes = await cores();
      // eslint-disable-next-line no-await-in-loop -- idem
      const { status, body } = await createAccount(v2.baseUrl, { label: `Cor ${rodada}` });
      assert.equal(status, 201);
      const cor = body.data.account.color;
      assert.equal(cor, nextAccountColor(antes));
      if (antes.length < WA_ACCOUNT_COLORS.length) {
        assert.ok(!antes.includes(cor), `repetiu ${cor} com ${antes.length} números`);
      }
    }
  });

  it('e a listagem entrega a cor, que é o que a caixa de entrada lê', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts`, { headers: authHeaders(token) });
    assert.equal(status, 200);
    for (const account of body.data) {
      assert.ok(WA_ACCOUNT_COLORS.includes(account.color), `${account.id} sem cor da paleta`);
    }
  });

  it('o administrador troca por outra da paleta', async () => {
    const [primeiro] = await asTenant(() => WhatsAppAccount.getAll());
    const outra = WA_ACCOUNT_COLORS.find((cor) => cor !== primeiro.color);
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/${primeiro.id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: { color: outra }
    });
    assert.equal(status, 200);
    assert.equal(body.data.account.color, outra);
    // E trocar a cor não mexe no resto do número.
    assert.equal(body.data.account.label, primeiro.label);
    assert.equal(body.data.account.purpose, primeiro.purpose);
  });

  it('e uma cor fora da paleta é recusada, sem gravar nada', async () => {
    const [primeiro] = await asTenant(() => WhatsAppAccount.getAll());
    for (const invalida of ['red', '#ff0000', '', 'BLUE']) {
      // eslint-disable-next-line no-await-in-loop -- um valor por vez
      const { status } = await call(`${panelUrl}/api/whatsapp/accounts/${primeiro.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: { color: invalida }
      });
      assert.equal(status, 400, `aceitou ${JSON.stringify(invalida)}`);
    }
    assert.equal((await asTenant(() => WhatsAppAccount.getById(primeiro.id))).color, primeiro.color);
  });
});

describe('checking numbers on WhatsApp', () => {
  before(async () => {
    // The check goes out through a connected number, so one has to exist.
    const { body } = await createAccount(v2.baseUrl, { label: 'Consulta' });
    v2.state.connected = true;
    await call(`${panelUrl}/api/whatsapp/accounts/${body.data.account.id}/status`, {
      headers: authHeaders(token)
    });
  });

  it('answers in the order asked, matching through the ninth-digit rewrite', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/check-number`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { numbers: ['+55 (93) 98111-0449', '5511999999999', '5500000000000'] }
    });
    assert.equal(status, 200);
    // The server answered '559381110449' — the same number without the ninth
    // digit. Matching it exactly would have reported a real number as absent.
    assert.deepEqual(body.data, [
      { number: '5593981110449', exists: true },
      { number: '5511999999999', exists: false },
      { number: '5500000000000', exists: false }
    ]);
  });
});

describe('removing a number', () => {
  it('drops the row even when the server refuses, and says so', async () => {
    const { body: createdBody } = await createAccount(v2.baseUrl, { label: 'Descartar' });
    const id = createdBody.data.account.id;
    v2.state.deleteStatus = 500;

    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token),
      // Self-host: the server's global key lives in the request, not in the row.
      body: { adminKey: 'chave-global' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.removedOnServer, false);
    assert.ok(body.data.serverError, 'an instance left running has to be reported');
    // Refusing to delete locally would leave the operator with a row they can
    // never get rid of.
    assert.equal(await asTenant(() => WhatsAppAccount.getById(id)), null);
  });

  it('reports a clean removal when the server agrees', async () => {
    const { body: createdBody } = await createAccount(v2.baseUrl, { label: 'Remover' });
    const id = createdBody.data.account.id;
    v2.state.deleteStatus = 200;

    const { body } = await call(`${panelUrl}/api/whatsapp/accounts/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token),
      body: { adminKey: 'chave-global' }
    });
    assert.equal(body.data.removedOnServer, true);
    assert.equal(body.data.serverError, null);
    assert.ok(v2.state.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/instance/logout/')));
  });
});

describe('what reaches the browser', () => {
  it('never carries a stored secret, in any response', async () => {
    const rows = await asTenant(() => WhatsAppAccount.getAll());
    const secrets = rows.flatMap((row) => [
      WhatsAppConfigService.decryptInstanceToken(row),
      WhatsAppConfigService.decryptWebhookToken(row)
    ]).filter(Boolean);
    assert.ok(secrets.length, 'the fixture would be vacuous without stored secrets');

    const listed = await call(`${panelUrl}/api/whatsapp/accounts`, { headers: authHeaders(token) });
    const fresh = await createAccount(v2.baseUrl, { label: 'Vazamento' });
    const status = await call(
      `${panelUrl}/api/whatsapp/accounts/${fresh.body.data.account.id}/status`,
      { headers: authHeaders(token) }
    );

    for (const payload of [listed.body, fresh.body, status.body]) {
      const serialized = JSON.stringify(payload);
      for (const secret of [...secrets, 'server-key-v2', 'chave-global']) {
        assert.equal(serialized.includes(secret), false, `${secret} leaked`);
      }
      assert.equal(serialized.includes('ciphertext'), false);
    }
  });

  it('requires an authenticated admin everywhere', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/accounts`, {
      method: 'POST',
      body: { baseUrl: v2.baseUrl }
    });
    assert.equal(status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conferir o webhook depois da criação
//
// O que estes casos travam é a diferença entre "não chega nada" e "não chega
// nada PORQUE". Até existirem, o painel mostrava um número conectado ao lado de
// "Nunca chegou nada" e as três causas — webhook ausente, webhook apontando
// para outro lugar, webhook certo que ninguém chama — eram a mesma tela.
// ─────────────────────────────────────────────────────────────────────────────
describe('conferir o webhook no servidor', () => {
  let conta;

  it('diz ok quando o servidor tem o webhook que o create escreveu', async () => {
    const criada = await createAccount(v2.baseUrl, { label: 'Conferência' });
    conta = criada.body.data.account;

    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${conta.id}/webhook`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.verdict, 'ok');
    assert.equal(body.data.supported, true);
  });

  it('devolve a URL do servidor com o token REDIGIDO', async () => {
    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${conta.id}/webhook`,
      { headers: authHeaders(token) }
    );
    // O que sai daqui vai para a tela e para uma coluna do banco que fica ao
    // lado da versão cifrada do mesmo segredo. Guardar a URL inteira seria
    // guardar o token em claro na linha do cofre.
    assert.ok(body.data.serverUrl.startsWith(`${WEBHOOK_BASE}?t=`));
    assert.ok(body.data.serverUrl.endsWith('?t=***'));

    const row = await asTenant(() => WhatsAppAccount.getById(conta.id));
    const guardado = WhatsAppConfigService.decryptWebhookToken(row);
    assert.ok(guardado);
    assert.ok(!body.data.serverUrl.includes(guardado));
    assert.ok(!String(row.webhook_server_url).includes(guardado));
  });

  it('guarda o veredito, para a tira de saúde não ir ao Evolution a cada volta', async () => {
    const row = await asTenant(() => WhatsAppAccount.getById(conta.id));
    assert.equal(row.webhook_verdict, 'ok');
    assert.ok(row.webhook_checked_at);
  });

  it('acusa o webhook ausente de uma instância que o painel ADOTOU', async () => {
    // O caso que motivou a onda inteira. O create responde "already exists", o
    // painel recupera só o id — e o webhook do payload nunca é escrito. O
    // número pareia, conecta, e não entrega nada. Antes disto, em lugar nenhum.
    adotado.state.createStatus = 409;
    const criada = await createAccount(adotado.baseUrl, { label: 'Adotada' });
    assert.equal(criada.status, 201);
    const id = criada.body.data.account.id;
    assert.equal(adotado.state.webhook, null);

    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${id}/webhook`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.verdict, 'absent');
    assert.equal(body.data.serverUrl, '');
  });

  it('reescreve o webhook, e confere lendo de volta', async () => {
    const criada = await createAccount(adotado.baseUrl, { label: 'Consertada' });
    const id = criada.body.data.account.id;
    const antes = await asTenant(() => WhatsAppAccount.getById(id));
    const tokenAntes = WhatsAppConfigService.decryptWebhookToken(antes);

    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${id}/webhook`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    assert.equal(body.data.verdict, 'ok');

    const escrito = adotado.state.requests.filter(
      (r) => r.method === 'POST' && r.path.startsWith('/webhook/set/')
    ).pop();
    assert.ok(escrito);
    // A lista de eventos vai junto: o v2 trata isto como substituição INTEIRA,
    // e mandar só a URL deixaria um webhook configurado que não assina nada —
    // o mesmo silêncio, com aparência de conserto.
    assert.equal(escrito.body.webhook.byEvents, false);
    assert.ok(escrito.body.webhook.events.includes('MESSAGES_UPSERT'));

    // O token é o MESMO. Trocá-lo abriria uma janela em que o painel já espera
    // o novo e o servidor ainda manda o antigo: todo evento dessa janela vira
    // 401, que é a falha que este conserto existe para acabar.
    const depois = await asTenant(() => WhatsAppAccount.getById(id));
    assert.equal(WhatsAppConfigService.decryptWebhookToken(depois), tokenAntes);
  });

  it('acusa token_mismatch quando o servidor guarda outro token', async () => {
    const criada = await createAccount(adotado.baseUrl, { label: 'Token velho' });
    const id = criada.body.data.account.id;
    await call(`${panelUrl}/api/whatsapp/accounts/${id}/webhook`, {
      method: 'POST', headers: authHeaders(token)
    });
    // É o que acontece quando alguém reinstala o painel apontando para as
    // mesmas instâncias: a URL continua certa e todo evento leva 401.
    adotado.state.webhook.url = `${WEBHOOK_BASE}?t=de-outro-painel`;

    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${id}/webhook`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.verdict, 'token_mismatch');
  });

  it('acusa url_mismatch quando o webhook aponta para outro lugar', async () => {
    const criada = await createAccount(adotado.baseUrl, { label: 'Outro destino' });
    const id = criada.body.data.account.id;
    await call(`${panelUrl}/api/whatsapp/accounts/${id}/webhook`, {
      method: 'POST', headers: authHeaders(token)
    });
    adotado.state.webhook.url = 'https://n8n.exemplo.test/webhook/evolution?t=qualquer';

    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${id}/webhook`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.verdict, 'url_mismatch');
  });

  it('não inventa veredito para o GO, que não devolve o webhook', async () => {
    const criada = await createAccount(go.baseUrl, { label: 'GO sem leitura' });
    const { body } = await call(
      `${panelUrl}/api/whatsapp/accounts/${criada.body.data.account.id}/webhook`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.supported, false);
    assert.equal(body.data.verdict, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A volta completa
//
// O que estes casos travam é o limite da conferência anterior. `inspectWebhook`
// compara o que o servidor guarda com o que o painel espera, e as DUAS pontas
// dessa comparação saem do mesmo `webhookBaseUrl` — digitado à mão, conferido
// só na forma. Com um endereço errado os dois lados concordam e o veredito
// responde `ok` sobre uma instalação que não entrega nada.
// ─────────────────────────────────────────────────────────────────────────────
describe('a volta do webhook', () => {
  let id;

  before(async () => {
    const criada = await createAccount(v2.baseUrl, { label: 'Volta' });
    id = criada.body.data.account.id;
  });

  after(() => setProbeFetcher(null));

  const sondar = () => call(
    `${panelUrl}/api/whatsapp/accounts/${id}/webhook/probe`,
    { method: 'POST', headers: authHeaders(token) }
  );

  /** Um destino que responde o que se mandar. Guarda o que recebeu. */
  function destino(resposta) {
    const visto = { url: null, body: null };
    setProbeFetcher(async (url, init) => {
      visto.url = String(url);
      visto.body = JSON.parse(String(init?.body ?? '{}'));
      if (resposta instanceof Error) throw resposta;
      return { status: resposta.status, text: async () => resposta.corpo };
    });
    return visto;
  }

  it('manda a sonda para a URL COM o token, e não para a base', async () => {
    const visto = destino({ status: 200, corpo: '{}' });
    await sondar();
    // Sem o token a volta não provaria nada sobre autenticação, que é metade
    // do que ela existe para provar.
    assert.ok(visto.url.includes('?t='));
    assert.ok(visto.url.startsWith(WEBHOOK_BASE));
    assert.equal(visto.body.event, 'panel.probe');
    assert.ok(/^[a-f0-9]{32}$/.test(visto.body.probe.nonce));
  });

  it('só diz `reached` quando o nonce que ela sorteou volta', async () => {
    let sorteado = null;
    setProbeFetcher(async (url, init) => {
      sorteado = JSON.parse(String(init.body)).probe.nonce;
      return { status: 200, text: async () => JSON.stringify({ success: true, pong: sorteado }) };
    });
    const { body } = await sondar();
    assert.equal(body.data.verdict, 'reached');
    assert.ok(sorteado);
  });

  it('PEGA o caso que a conferência estática aprova: 200 que não é o webhook', async () => {
    // O `webhookBaseUrl` sem caminho nenhum. O POST cai na raiz do painel, o
    // frontend responde 200 com HTML, e o servidor Evolution registra entrega
    // bem-sucedida. A comparação com o que o servidor guarda diz `ok` — os dois
    // lados dela saem deste mesmo endereço errado. Só a volta pega.
    destino({ status: 200, corpo: '<!doctype html><title>Painel</title><div id="root"></div>' });
    const { body } = await sondar();
    assert.equal(body.data.verdict, 'wrong_target');
  });

  it('separa caminho errado, proxy barrando e servidor mudo', async () => {
    destino({ status: 404, corpo: 'Cannot POST /api/whatsapp/webhook' });
    assert.equal((await sondar()).body.data.verdict, 'not_found');

    destino({ status: 403, corpo: 'Forbidden' });
    assert.equal((await sondar()).body.data.verdict, 'blocked');

    destino(new Error('getaddrinfo ENOTFOUND painel.provedor.com.br'));
    assert.equal((await sondar()).body.data.verdict, 'unreachable');
  });

  it('um 401 na volta é o endereço levando a OUTRO painel', async () => {
    // O painel manda o token DELE. Se quem atende recusa, quem atende não é
    // este painel — e isso é diagnóstico, não erro de transporte.
    destino({ status: 401, corpo: '{"success":false,"error":"unauthorized"}' });
    assert.equal((await sondar()).body.data.verdict, 'unauthorized');
  });

  it('guarda o veredito, e a falha de transporte não vira exceção', async () => {
    destino(new Error('socket hang up'));
    const { status, body } = await sondar();
    // O operador pediu um diagnóstico, e "não deu para chegar" É o diagnóstico.
    assert.equal(status, 200);
    assert.equal(body.data.verdict, 'unreachable');
    assert.equal(body.data.account.webhookProbeVerdict, 'unreachable');
    assert.ok(body.data.account.webhookProbedAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O QR é credencial de pareamento, e a permissão tem que refletir isso
//
// A rota dedicada ao QR pede `whatsapp.config`, de propósito. Mas o
// serializador compartilhado o incluía, e ele serve `GET /accounts` e
// `/accounts/:id/status` — as duas com `whatsapp.read`. Um `tech`, que tem
// `read` e não tem `config`, fazia polling na listagem durante uma reconexão,
// lia o QR e pareava o próprio celular ao número do provedor: passava a
// receber a caixa de entrada dos assinantes e a falar COMO o provedor.
//
// Parear é estritamente pior que `whatsapp.send`, e estava atrás da permissão
// mais fraca das duas.
// ─────────────────────────────────────────────────────────────────────────────
describe('por onde o QR sai', () => {
  it('não sai na listagem nem no estado, que são rotas de leitura', async () => {
    const criacao = await createAccount(v2.baseUrl, { label: 'QR fechado' });
    const id = criacao.body.data.account.id;

    const lista = await call(`${panelUrl}/api/whatsapp/accounts`, { headers: authHeaders(token) });
    assert.equal(lista.status, 200);
    for (const conta of lista.body.data) {
      assert.equal(conta.qrCode, undefined, 'o QR voltou na listagem');
    }

    const estado = await call(`${panelUrl}/api/whatsapp/accounts/${id}/status`, {
      headers: authHeaders(token)
    });
    assert.equal(estado.status, 200);
    assert.equal(estado.body.data.account.qrCode, undefined, 'o QR voltou no estado');
  });

  it('sai só pela rota dedicada, e num campo próprio', async () => {
    const criacao = await createAccount(v2.baseUrl, { label: 'QR pela rota' });
    const id = criacao.body.data.account.id;

    const { status, body } = await call(`${panelUrl}/api/whatsapp/accounts/${id}/qr`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    // O campo próprio da resposta, que é o que a tela lê — e que só chega a
    // quem tem `whatsapp.config`.
    assert.ok(String(body.data.qr).startsWith('data:image/png;base64,'));
    assert.equal(body.data.account.qrCode, undefined);
  });
});

describe('with the integration switched off', () => {
  it('refuses to create anything', async () => {
    await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: false }
    });
    const { status, body } = await createAccount(v2.baseUrl);
    assert.equal(status, 400);
    assert.equal(body.code, 'not_configured');
  });

  it('refuses to create when the webhook URL is missing, since nothing would come back', async () => {
    await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { webhookBaseUrl: '' }
    });
    // Enabling without a webhook is refused by the config route itself, so the
    // state under test is reached by writing it directly.
    const { default: AppState } = await import('../src/models/AppState.js');
    const stored = JSON.parse(await asTenant(() => AppState.get('whatsapp_evolution_config')));
    await asTenant(() => AppState.upsert('whatsapp_evolution_config', JSON.stringify({
      ...stored, enabled: true, webhookBaseUrl: ''
    })));
    WhatsAppConfigService.configCache.clear();

    const { status, body } = await createAccount(v2.baseUrl);
    assert.equal(status, 400);
    assert.equal(body.code, 'incomplete_config');
  });
});
