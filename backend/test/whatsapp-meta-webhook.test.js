/**
 * O webhook da Meta registrado pelo painel na conta WABA de cada número
 * oficial (`POST /{waba}/subscribed_apps` com `override_callback_uri`).
 *
 * O token de verificação do servidor Evolution é um só para todos os números
 * dele; na SaaS, para todos os provedores. Em vez de mostrá-lo para o provedor
 * colar no app dele, o painel o manda direto à Meta com o token do número. O
 * que este arquivo guarda: a chamada sai com o que a Meta pede, uma recusa
 * dela não desfaz o número, "registrar de novo" funciona e não alcança o
 * número de outro provedor, e o self-host continua vendo o próprio token.
 * O lado SaaS (o provedor NÃO vê o token) está em
 * `platform-managed-settings.test.js`.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  asTenant, authHeaders, call, defaultTenantId, getDb, insertReturningId, startTestServers, stopTestServers
} from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { setMetaGraphFetcher, META_GRAPH_VERSION } = await import('../src/services/metaWebhookService.js');

const EVO_BASE = 'https://evo-oficial.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentToken1234567890';
const NOVO_TOKEN = 'EAAGm0PX4ZCpsBANovoTokenPermanente0987654321';
const VERIFY = 'verifica-meta-do-servidor';
const WABA = '123456789012345';

let panelUrl;
let token;
let evoServer;
const desfazer = [];

/** A Graph falsa: o que ela responde e o que recebeu. */
const graph = { status: 200, body: { success: true }, throws: false };
const graphCalls = [];

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const path = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && path === '/') return send(200, { version: '2.3.0' });
      if (path === '/instance/create') {
        return send(201, {
          instance: { instanceName: body.instanceName, instanceId: 'cloud-instance-id', integration: body.integration },
          hash: body.token
        });
      }
      if (path.startsWith('/instance/connectionState/')) return send(200, { instance: { state: 'open' } });
      if (path.startsWith('/instance/delete/')) return send(200, { status: 'SUCCESS' });
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const v2 = await startStub();
  evoServer = v2.server;
  desfazer.push(rotearBase(EVO_BASE, v2.url));

  setMetaGraphFetcher(async (url, init) => {
    graphCalls.push({ url, init, body: JSON.parse(init.body) });
    if (graph.throws) throw new Error(`connect ECONNREFUSED ${url}`);
    return new Response(JSON.stringify(graph.body), {
      status: graph.status,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60,
    cloudVerifyToken: VERIFY
  }));
});

beforeEach(() => {
  graph.status = 200;
  graph.body = { success: true };
  graph.throws = false;
  graphCalls.length = 0;
});

after(async () => {
  setMetaGraphFetcher(null);
  for (const fn of desfazer) fn?.();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

function createCloud(label) {
  return call(`${panelUrl}/api/whatsapp/accounts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      kind: 'cloud',
      baseUrl: EVO_BASE,
      adminKey: 'chave-global',
      label,
      metaToken: META_TOKEN,
      phoneNumberId: '109876543210987',
      wabaId: WABA
    }
  });
}

const registrar = (id) => call(`${panelUrl}/api/whatsapp/accounts/${id}/meta-webhook`, {
  method: 'POST', headers: authHeaders(token)
});

describe('registrar o webhook na criação', () => {
  it('chama subscribed_apps com a URL do servidor, o token de verificação e o token do número', async () => {
    const { status, body } = await createCloud('Oficial');
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(graphCalls.length, 1);
    const [chamada] = graphCalls;
    assert.equal(chamada.url, `https://graph.facebook.com/${META_GRAPH_VERSION}/${WABA}/subscribed_apps`);
    assert.equal(META_GRAPH_VERSION, 'v21.0');
    assert.equal(chamada.init.method, 'POST');
    assert.equal(chamada.init.headers.Authorization, `Bearer ${META_TOKEN}`);
    assert.deepEqual(chamada.body, {
      override_callback_uri: `${EVO_BASE}/webhook/meta`,
      verify_token: VERIFY
    });
    assert.ok(!chamada.url.includes(META_TOKEN), 'o token não vai na URL');

    const account = body.data.account;
    assert.equal(account.metaWebhookStatus, 'ok');
    assert.equal(account.metaWebhookError, null);
    assert.ok(account.metaWebhookAt);
  });

  it('recusa da Meta não desfaz o número: fica gravada como erro', async () => {
    graph.status = 400;
    graph.body = { error: { message: 'Callback verification failed', code: 2200 } };
    const { status, body } = await createCloud('Recusado');
    assert.equal(status, 201, JSON.stringify(body));
    const account = body.data.account;
    assert.equal(account.integration, 'cloud');
    assert.equal(account.metaWebhookStatus, 'error');
    assert.equal(account.metaWebhookError, '(2200) Callback verification failed');
    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.equal(row.meta_webhook_status, 'error');
  });

  it('Meta fora do ar vira meta_unreachable, sem a exceção do fetch', async () => {
    graph.throws = true;
    const { status, body } = await createCloud('Sem rede');
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.account.metaWebhookStatus, 'error');
    assert.equal(body.data.account.metaWebhookError, 'meta_unreachable');
  });

  it('a troca de token registra de novo, com o token novo', async () => {
    const { body } = await createCloud('Troca');
    graphCalls.length = 0;
    const r = await call(`${panelUrl}/api/whatsapp/accounts/${body.data.account.id}/meta-token`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { metaToken: NOVO_TOKEN, adminKey: 'chave-global' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(graphCalls.length, 1);
    assert.equal(graphCalls[0].init.headers.Authorization, `Bearer ${NOVO_TOKEN}`);
    assert.equal(r.body.data.account.metaWebhookStatus, 'ok');
  });
});

describe('registrar de novo', () => {
  it('depois de uma recusa, a nova tentativa grava ok', async () => {
    graph.status = 400;
    graph.body = { error: { message: 'Invalid OAuth access token', code: 190 } };
    const { body } = await createCloud('De novo');
    const id = body.data.account.id;
    assert.equal(body.data.account.metaWebhookStatus, 'error');

    graph.status = 200;
    graph.body = { success: true };
    graphCalls.length = 0;
    const r = await registrar(id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.account.metaWebhookStatus, 'ok');
    assert.equal(r.body.data.account.metaWebhookError, null);
    // O token vem da linha, decifrado.
    assert.equal(graphCalls[0].init.headers.Authorization, `Bearer ${META_TOKEN}`);
  });

  it('nova recusa é 502 meta_webhook_failed e fica gravada', async () => {
    const { body } = await createCloud('Recusa no retry');
    graph.status = 403;
    graph.body = { error: { message: 'Permissions error', code: 200 } };
    const r = await registrar(body.data.account.id);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'meta_webhook_failed');
    const row = await asTenant(() => WhatsAppAccount.getById(body.data.account.id));
    assert.equal(row.meta_webhook_error, '(200) Permissions error');
  });

  it('número por QR é 409 not_cloud, sem falar com a Meta', async () => {
    const id = await asTenant(async () => (await WhatsAppAccount.create({
      name: 'skygp_qr_meta', purpose: 'general', flavor: 'v2', base_url: EVO_BASE, status: 'connected'
    })).id);
    const r = await registrar(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_cloud');
    assert.equal(graphCalls.length, 0);
  });

  it('o número oficial de outro provedor é 404, e a Meta não é chamada', async () => {
    const beta = await insertReturningId('tenants', { slug: 'beta-meta', name: 'Beta', status: 'active' });
    assert.notEqual(beta, await defaultTenantId());
    const alheio = await insertReturningId('whatsapp_accounts', {
      tenant_id: beta,
      name: 'skygp_beta_oficial',
      purpose: 'general',
      flavor: 'v2',
      integration: 'cloud',
      meta_phone_number_id: '109876543210000',
      meta_waba_id: '999999999999999',
      base_url: EVO_BASE,
      status: 'connected'
    });
    const r = await registrar(alheio);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'account_not_found');
    assert.equal(graphCalls.length, 0);
    const row = await getDb()('whatsapp_accounts').where({ id: alheio }).first();
    assert.equal(row.meta_webhook_status, null);
  });
});

describe('a configuração no self-host', () => {
  it('continua devolvendo o token de verificação para quem opera o servidor', async () => {
    const { body } = await call(`${panelUrl}/api/whatsapp/config`, { headers: authHeaders(token) });
    assert.equal(body.data.platformManaged, false);
    assert.equal(body.data.cloudWebhook.verifyToken, VERIFY);
    assert.equal(body.data.cloudWebhook.auto, undefined);
  });
});
