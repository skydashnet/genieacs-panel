import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { classifySyncError } = await import('../src/services/customerSyncErrors.js');
const { default: CustomerIdSyncJob } = await import('../src/services/customerIdSyncJob.js');
const { default: CustomerPortalPasswordService } = await import('../src/services/customerPortalPasswordService.js');

/**
 * "Sincronizar IDs de cliente" ao salvar as configurações.
 *
 * O que estes casos defendem: a falha diz o motivo (em produção também, pelo
 * `code`), sem repetir URL nem texto cru do ACS; uma frota grande não estoura
 * o limite de parâmetros do banco; e a opção desligada não toca no ACS.
 */
const SENHA = 'operator-password-1';

let panelUrl;
let token;
let genie;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [
      buildDevice({ id: 'ONT-1', pppoeUsername: 'ana@vila' }),
      buildDevice({ id: 'ONT-2', pppoeUsername: 'bia@centro' })
    ]
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: SENHA, email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

afterEach(async () => {
  await CustomerIdSyncJob.idle();
  genie.state.respond = null;
  DeviceService.CUSTOMER_IDENTITY_TIMEOUT_MS = 60_000;
  CustomerIdSyncJob.BUDGET_MS = 20_000;
});

const ligar = (valor) => asTenant(() => Setting.upsert('autoGenerateCustomerId', valor));
const sincronizar = () => call(`${panelUrl}/api/settings/sync-customer-ids`, { method: 'POST', headers: authHeaders(token) });
const contas = async () => Number((await getDb()('customer_accounts').count({ n: '*' }))[0].n);

describe('POST /api/settings/sync-customer-ids', () => {
  it('desligada, responde enabled:false sem perguntar nada ao ACS', async () => {
    await ligar('false');
    const antes = genie.state.requests.length;
    const res = await sincronizar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.enabled, false);
    assert.equal(genie.state.requests.length, antes);
  });

  it('ligada, gera um ID por aparelho', async () => {
    await ligar('true');
    const res = await sincronizar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.enabled, true);
    assert.equal(res.body.data.total, 2);
    assert.equal(res.body.data.pending, 0);
    // De novo: nada novo, tudo preservado.
    const again = await sincronizar();
    assert.equal(again.status, 200);
    assert.equal(again.body.data.generated, 0);
    assert.equal(again.body.data.existing, 2);
  });

  it('dois pedidos seguidos: o segundo não ouve "em andamento" de uma passada que já acabou', async (t) => {
    await ligar('true');
    // Gravar o desfecho demora (no MySQL do CI, demorava o bastante): a
    // resposta tem de esperar a trava sair, senão o segundo pedido a encontra.
    const lento = CustomerIdSyncJob.remember.bind(CustomerIdSyncJob);
    t.mock.method(CustomerIdSyncJob, 'remember', async (...args) => {
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      return lento(...args);
    });
    const first = await sincronizar();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.notEqual(first.body.data.running, true);
    const second = await sincronizar();
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.data.running, true, 'a passada anterior já tinha acabado');
    assert.equal(typeof second.body.data.generated, 'number');
  });

  it('ACS que não responde a tempo vira genieacs_timeout, não o erro genérico', async () => {
    await ligar('true');
    DeviceService.CUSTOMER_IDENTITY_TIMEOUT_MS = 150;
    genie.state.respond = ({ send }) => setTimeout(() => send(200, []), 1_000);
    const res = await sincronizar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'genieacs_timeout');
    assert.match(res.body.message, /GenieACS/);
    assert.ok(!JSON.stringify(res.body).includes(genie.url), 'a URL do ACS não sai na resposta');
  });

  it('401 do ACS vira genieacs_http com o status e a frase da credencial', async () => {
    await ligar('true');
    genie.state.respond = ({ send }) => send(401, { error: 'nope' });
    const res = await sincronizar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'genieacs_http');
    assert.equal(res.body.status, 401);
    assert.notEqual(res.body.message, 'Could not sync customer IDs');
  });

  it('500 do ACS diz o status na mensagem', async () => {
    await ligar('true');
    genie.state.respond = ({ send }) => send(500, {});
    const res = await sincronizar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'genieacs_http');
    assert.match(res.body.message, /500/);
  });

  it('resposta que não é lista vira genieacs_bad_response', async () => {
    await ligar('true');
    genie.state.respond = ({ send }) => send(200, { not: 'a list' });
    const res = await sincronizar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'genieacs_bad_response');
  });

  it('1.200 aparelhos passam sem estourar o limite de parâmetros', async (t) => {
    await ligar('true');
    // O bcrypt de cada senha do portal é o que torna a passada lenta; aqui o
    // assunto são os lotes do banco, então uma senha pronta serve a todas.
    const pronta = await CustomerPortalPasswordService.createRecord();
    t.mock.method(CustomerPortalPasswordService, 'createRecord', async () => pronta);
    const frota = Array.from({ length: 1200 }, (_, i) => buildDevice({ id: `BIG-${i}`, pppoeUsername: `cliente${i}@rede` }));
    genie.state.respond = ({ send }) => send(200, frota);
    CustomerIdSyncJob.BUDGET_MS = 120_000;
    const res = await sincronizar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.total, 1200);
    assert.equal(res.body.data.pending, 0);
    assert.ok(await contas() >= 1200);
    // A segunda passada lê as 1.200 de volta pelos lotes.
    const again = await sincronizar();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.generated, 0);
  });

  it('passada mais longa que o prazo responde "em andamento" e termina sozinha', async (t) => {
    await ligar('true');
    let liberar;
    const segura = new Promise((resolve) => { liberar = resolve; });
    const original = CustomerService.syncDevices.bind(CustomerService);
    t.mock.method(CustomerService, 'syncDevices', async (...args) => { await segura; return original(...args); });
    genie.state.respond = ({ send }) => send(200, [buildDevice({ id: 'LENTA-1', pppoeUsername: 'lenta@rede' })]);
    CustomerIdSyncJob.BUDGET_MS = 100;

    const res = await sincronizar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.running, true);
    assert.ok(res.body.message.length > 0);

    // Pedir de novo não abre uma segunda passada.
    const pedidosAntes = genie.state.requests.length;
    const deNovo = await sincronizar();
    assert.equal(deNovo.body.data.running, true);
    assert.equal(genie.state.requests.length, pedidosAntes);

    liberar();
    await CustomerIdSyncJob.idle();
    const conta = await getDb()('customer_accounts').where({ device_id: 'LENTA-1' }).first();
    assert.ok(conta?.customer_id, 'a passada em segundo plano gerou o ID');
  });
});

describe('GET /api/settings/customer-id-sync', () => {
  const status = () => call(`${panelUrl}/api/settings/customer-id-sync`, { headers: authHeaders(token) });

  it('guarda como terminou a última passada, com contagens', async () => {
    await ligar('true');
    const res = await sincronizar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await CustomerIdSyncJob.idle();
    const st = await status();
    assert.equal(st.status, 200);
    assert.equal(st.body.data.enabled, true);
    assert.equal(st.body.data.running, false);
    assert.equal(st.body.data.last.ok, true);
    assert.equal(typeof st.body.data.last.total, 'number');
    assert.ok(st.body.data.last.finishedAt);
  });

  it('falha guardada com o motivo traduzido e o status HTTP', async () => {
    await ligar('true');
    genie.state.respond = ({ send }) => send(401, {});
    assert.equal((await sincronizar()).status, 502);
    await CustomerIdSyncJob.idle();
    const st = await status();
    assert.equal(st.body.data.last.ok, false);
    assert.equal(st.body.data.last.code, 'genieacs_http');
    assert.equal(st.body.data.last.status, 401);
    assert.match(st.body.data.last.message, /401/);
  });

  it('mostra a passada em curso, e a chave interna não aparece na lista de configurações', async (t) => {
    await ligar('true');
    let liberar;
    const segura = new Promise((resolve) => { liberar = resolve; });
    const original = CustomerService.syncDevices.bind(CustomerService);
    t.mock.method(CustomerService, 'syncDevices', async (...args) => { await segura; return original(...args); });
    CustomerIdSyncJob.BUDGET_MS = 50;
    assert.equal((await sincronizar()).body.data.running, true);
    const st = await status();
    assert.equal(st.body.data.running, true);
    assert.ok(st.body.data.startedAt);
    liberar();
    await CustomerIdSyncJob.idle();
    assert.equal((await status()).body.data.running, false);
    const lista = await call(`${panelUrl}/api/settings`, { headers: authHeaders(token) });
    assert.ok(!('customerIdSyncLast' in lista.body.data));
  });
});

describe('classifySyncError', () => {
  it('reconhece cada causa', () => {
    const casos = [
      [Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'genieacs_timeout'],
      [new Error('GenieACS URL not configured'), 'genieacs_not_configured'],
      [new Error('GenieACS API responded with status: 403'), 'genieacs_http'],
      [new Error('GenieACS API answered with a redirect (status: 302); the configured GenieACS URL must serve the request itself'), 'genieacs_http'],
      [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'genieacs_unreachable'],
      [Object.assign(new Error('refused'), { code: 'GENIEACS_EGRESS_REFUSED' }), 'genieacs_unreachable'],
      [new Error('Invalid GenieACS customer identity response'), 'genieacs_bad_response'],
      [Object.assign(new Error('x'), { translationKey: 'settings.customerIdAllocationFailed' }), 'allocation_failed'],
      [new Error('SQLITE_BUSY: database is locked'), 'database']
    ];
    for (const [erro, code] of casos) assert.equal(classifySyncError(erro).code, code, erro.message);
    assert.equal(classifySyncError(new Error('GenieACS API responded with status: 403')).reasonKey, 'settings.customerIdSync.unauthorized');
  });
});
