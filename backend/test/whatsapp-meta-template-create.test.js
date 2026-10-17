/**
 * Criar um modelo da Meta pelo painel: o pedido que chega ao servidor
 * Evolution, a sincronização depois da criação, e as recusas — de validação
 * (sem ir à rede), de número por QR e da própria Meta.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');

const EVO_BASE = 'https://evo-criar-modelo.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentTokenCriar123456';

let panelUrl;
let token;
let server;
let desfazer;
let accountId;
const requests = [];
const stub = {
  templates: [
    {
      id: '21', name: 'ja_existia', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Aviso: {{1}}' }]
    }
  ],
  // Quando preenchido, a criação devolve este erro da Meta em vez de aceitar.
  recusa: null
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const path = req.url.split('?')[0];
      requests.push({ path, method: req.method, apikey: req.headers.apikey || null, body });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (path.startsWith('/template/create/')) {
        if (stub.recusa) return send(400, stub.recusa);
        const id = String(100 + stub.templates.length);
        stub.templates.push({
          id, name: body.name, language: body.language, status: 'PENDING', category: body.category,
          components: body.components
        });
        return send(200, { id, status: 'PENDING', category: body.category });
      }
      if (path.startsWith('/template/find/')) return send(200, stub.templates);
      return send(404, { error: 'not found' });
    });
  });
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  desfazer = rotearBase(EVO_BASE, url);

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
  const row = await asTenant(() => WhatsAppAccount.create({
    name: 'oficial-criar',
    purpose: 'general',
    flavor: 'v2',
    integration: 'cloud',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-criar')
  }));
  accountId = row.id;
});

after(async () => {
  desfazer?.();
  WaOutboxWorker.stop();
  await new Promise((resolve) => server.close(resolve));
  await stopTestServers();
});

const api = (path, init = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...init });

const MODELO = {
  name: 'Aviso Fatura',
  category: 'UTILITY',
  language: 'pt_BR',
  headerText: 'Sua fatura',
  bodyText: 'Olá {{1}}, sua fatura vence em {{2}}.',
  examples: ['Ana', '10/10'],
  footerText: 'Provedor Exemplo',
  buttons: [{ type: 'URL', text: 'Pagar', url: 'https://pague.provedor.test/fatura' }]
};

describe('criar modelo na Meta pelo painel', () => {
  it('manda o modelo no formato da Meta, pela chave do número, e já devolve PENDING', async () => {
    requests.length = 0;
    const r = await api(`/accounts/${accountId}/templates`, { method: 'POST', body: MODELO });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.name, 'aviso_fatura');
    assert.equal(r.body.data.status, 'PENDING');
    assert.equal(r.body.data.usable, false);
    assert.equal(r.body.data.paramCount, 2);
    assert.ok(r.body.data.id, 'a linha veio da sincronização depois da criação');

    const pedido = requests.find((q) => q.path === '/template/create/oficial-criar');
    assert.ok(pedido, 'pediu a criação ao servidor');
    assert.equal(pedido.method, 'POST');
    assert.equal(pedido.apikey, META_TOKEN);
    assert.equal(pedido.body.name, 'aviso_fatura');
    assert.equal(pedido.body.category, 'UTILITY');
    assert.equal(pedido.body.allowCategoryChange, true);
    assert.deepEqual(pedido.body.components.map((c) => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
    const corpo = pedido.body.components.find((c) => c.type === 'BODY');
    assert.deepEqual(corpo.example, { body_text: [['Ana', '10/10']] });
    assert.ok(requests.some((q) => q.path === '/template/find/oficial-criar'), 'sincronizou depois de criar');
  });

  it('a lista do número passa a mostrar o modelo em análise', async () => {
    const r = await api(`/meta-templates?accountId=${accountId}`);
    const criado = r.body.data.find((m) => m.name === 'aviso_fatura');
    assert.equal(criado.status, 'PENDING');
    assert.equal(criado.supported, true);
    const utilizaveis = await api(`/meta-templates?accountId=${accountId}&usable=1`);
    assert.ok(!utilizaveis.body.data.some((m) => m.name === 'aviso_fatura'));
  });

  it('recusa de validação não chega ao servidor e aponta o campo', async () => {
    requests.length = 0;
    const r = await api(`/accounts/${accountId}/templates`, {
      method: 'POST',
      body: { ...MODELO, bodyText: 'Olá {{1}} e {{3}}', examples: ['a', 'b', 'c'] }
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_meta_template');
    // O campo vai na mensagem (`details` só sai em desenvolvimento).
    assert.match(r.body.message, /variables/);
    assert.equal(requests.length, 0);
  });

  it('recusa em número por QR', async () => {
    const qr = await asTenant(() => WhatsAppAccount.create({
      name: 'qr-criar', purpose: 'general', flavor: 'v2', base_url: EVO_BASE, status: 'connected',
      ...WhatsAppConfigService.encryptInstanceToken('tok'), ...WhatsAppConfigService.encryptWebhookToken('w')
    }));
    requests.length = 0;
    const r = await api(`/accounts/${qr.id}/templates`, { method: 'POST', body: MODELO });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'meta_templates_cloud_only');
    assert.equal(requests.length, 0);
    await getDb()('whatsapp_accounts').where({ id: qr.id }).del();
  });

  it('id que não existe dá 404 antes de olhar o corpo', async () => {
    const r = await api('/accounts/999999/templates', { method: 'POST', body: {} });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'account_not_found');
  });

  it('a recusa da Meta volta como http_error com o texto dela', async () => {
    stub.recusa = { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'Nome já usado' } };
    try {
      const r = await api(`/accounts/${accountId}/templates`, {
        method: 'POST',
        body: { ...MODELO, name: 'outro_modelo' }
      });
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.code, 'http_error');
      assert.match(JSON.stringify(r.body), /Nome já usado/);
    } finally {
      stub.recusa = null;
    }
  });

  it('pede a permissão de configuração do WhatsApp', async () => {
    const r = await call(`${panelUrl}/api/whatsapp/accounts/${accountId}/templates`, { method: 'POST', body: MODELO });
    assert.equal(r.status, 401);
  });
});
