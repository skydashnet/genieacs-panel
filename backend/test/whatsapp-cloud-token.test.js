/**
 * Troca do token da Meta num número oficial (POST /accounts/:id/meta-token).
 *
 * O Evolution v2 não tem rota para trocar o token de uma instância
 * WHATSAPP-BUSINESS — nela o token É a apikey —, então o painel apaga e cria
 * de novo com o MESMO nome, os mesmos ids da Meta e o MESMO `?t=` no webhook.
 * O que esta suíte prende: a ordem delete → create, o que cada um leva, o 404
 * do delete tolerado (retentativa), as recusas que não falam com o servidor e
 * a linha que nunca some quando algo dá errado.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

const EVO_BASE = 'https://evo-token.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentToken1234567890';
const NOVO_TOKEN = 'EAAGm0PX4ZCpsBAMetaTokenNovoDepoisDeRevogar0987';

let panelUrl;
let token;
let evoServer;
const desfazer = [];

const stub = {
  createStatus: 201,
  createBody: null,
  deleteStatus: 200,
  deleteBody: null
};
const requests = [];

function resetStub() {
  stub.createStatus = 201;
  stub.createBody = null;
  stub.deleteStatus = 200;
  stub.deleteBody = null;
}

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const path = req.url.split('?')[0];
      requests.push({ method: req.method, path, apikey: req.headers.apikey || null, body });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && path === '/') return send(200, { version: '2.3.0' });
      if (path === '/instance/create') {
        if (stub.createStatus !== 201) return send(stub.createStatus, stub.createBody);
        return send(201, {
          instance: { instanceName: body.instanceName, instanceId: 'cloud-instance-id', integration: body.integration },
          hash: body.token
        });
      }
      if (path.startsWith('/instance/delete/')) {
        if (stub.deleteStatus !== 200) return send(stub.deleteStatus, stub.deleteBody);
        return send(200, { status: 'SUCCESS' });
      }
      if (path.startsWith('/instance/connectionState/')) return send(200, { instance: { state: 'open' } });
      if (path.startsWith('/template/find/')) return send(200, []);
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const sent = (prefix) => requests.filter((r) => r.path.startsWith(prefix));

before(async () => {
  ({ panelUrl } = await startTestServers());
  const v2 = await startStub();
  evoServer = v2.server;
  desfazer.push(rotearBase(EVO_BASE, v2.url));

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60
  }));
});

after(async () => {
  for (const fn of desfazer) fn?.();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

beforeEach(() => {
  resetStub();
});

async function createCloud(label) {
  requests.length = 0;
  const r = await call(`${panelUrl}/api/whatsapp/accounts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      kind: 'cloud',
      baseUrl: EVO_BASE,
      adminKey: 'chave-global',
      label,
      metaToken: META_TOKEN,
      phoneNumberId: '109876543210987',
      wabaId: '123456789012345'
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { account: r.body.data.account, create: sent('/instance/create')[0] };
}

function trocar(id, body) {
  return call(`${panelUrl}/api/whatsapp/accounts/${id}/meta-token`, {
    method: 'POST',
    headers: authHeaders(token),
    body
  });
}

const linha = (id) => asTenant(() => WhatsAppAccount.getById(id));

describe('trocar o token da Meta', () => {
  it('apaga e recria a instância com o mesmo nome, os mesmos ids e o mesmo webhook', async () => {
    const { account, create: primeiro } = await createCloud('Oficial');
    requests.length = 0;

    const r = await trocar(account.id, { metaToken: NOVO_TOKEN, adminKey: 'chave-global' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.account.id, account.id);
    assert.ok(!JSON.stringify(r.body).includes(NOVO_TOKEN), 'o token não volta para o navegador');

    const deletes = sent('/instance/delete/');
    const creates = sent('/instance/create');
    assert.equal(deletes.length, 1);
    assert.equal(creates.length, 1);
    assert.ok(requests.indexOf(deletes[0]) < requests.indexOf(creates[0]), 'delete antes do create');
    assert.equal(deletes[0].path, `/instance/delete/${primeiro.body.instanceName}`);
    assert.equal(deletes[0].apikey, 'chave-global');

    const segundo = creates[0];
    assert.equal(segundo.apikey, 'chave-global');
    assert.equal(segundo.body.instanceName, primeiro.body.instanceName);
    assert.equal(segundo.body.token, NOVO_TOKEN);
    assert.equal(segundo.body.integration, 'WHATSAPP-BUSINESS');
    assert.equal(segundo.body.number, primeiro.body.number);
    assert.equal(segundo.body.businessId, primeiro.body.businessId);
    assert.equal(segundo.body.webhook.url, primeiro.body.webhook.url);

    const row = await linha(account.id);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), NOVO_TOKEN);
    assert.equal(row.last_error, null);
    assert.equal(row.name, account.name);
  });

  it('tolera o 404 do delete (retentativa) e recria mesmo assim', async () => {
    const { account } = await createCloud('Retentativa');
    stub.deleteStatus = 404;
    stub.deleteBody = { status: 404, error: 'Not Found', response: { message: ['The instance does not exist'] } };
    requests.length = 0;

    const r = await trocar(account.id, { metaToken: NOVO_TOKEN, adminKey: 'chave-global' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sent('/instance/create').length, 1);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(await linha(account.id)), NOVO_TOKEN);
  });

  it('recusa número QR sem falar com o servidor', async () => {
    const row = await asTenant(() => WhatsAppAccount.create({
      name: 'numero-qr',
      purpose: 'general',
      flavor: 'v2',
      integration: 'baileys',
      base_url: EVO_BASE,
      status: 'connected',
      ...WhatsAppConfigService.encryptInstanceToken('chave-da-instancia'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-qr')
    }));
    requests.length = 0;
    const r = await trocar(row.id, { metaToken: NOVO_TOKEN, adminKey: 'chave-global' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'not_cloud');
    assert.equal(requests.length, 0);
  });

  it('recusa token fora do formato sem falar com o servidor', async () => {
    const { account } = await createCloud('Formato');
    requests.length = 0;
    const r = await trocar(account.id, { metaToken: 'curto', adminKey: 'chave-global' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_meta_credentials');
    assert.equal(requests.length, 0);
  });

  it('sem chave admin no self-host recusa antes de qualquer requisição', async () => {
    const { account } = await createCloud('Sem chave');
    requests.length = 0;
    const r = await trocar(account.id, { metaToken: NOVO_TOKEN });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'admin_key_missing');
    assert.equal(requests.length, 0);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(await linha(account.id)), META_TOKEN);
  });

  it('create que falha mantém a linha, o token antigo e grava last_error', async () => {
    const { account } = await createCloud('Create falha');
    stub.createStatus = 500;
    stub.createBody = { error: 'Graph recusou o token' };
    const r = await trocar(account.id, { metaToken: NOVO_TOKEN, adminKey: 'chave-global' });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'http_error');
    const row = await linha(account.id);
    assert.ok(row, 'a linha nunca é apagada');
    assert.match(row.last_error, /http_error/);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), META_TOKEN);
  });

  it('nome ainda preso no servidor vira cloud_instance_still_exists', async () => {
    const { account } = await createCloud('Ainda existe');
    // 400 e não 401/403: esses o cliente lê como chave recusada antes de olhar
    // o corpo, e o caso aqui é o nome que o servidor ainda segura.
    stub.createStatus = 400;
    stub.createBody = { status: 400, error: 'Bad Request', response: { message: ['This name "x" is already in use.'] } };
    const r = await trocar(account.id, { metaToken: NOVO_TOKEN, adminKey: 'chave-global' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'cloud_instance_still_exists');
    const row = await linha(account.id);
    assert.match(row.last_error, /cloud_instance_still_exists/);
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), META_TOKEN);
  });

  it('conta inexistente é 404', async () => {
    const r = await trocar(999999, { metaToken: NOVO_TOKEN, adminKey: 'chave-global' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'account_not_found');
  });
});
