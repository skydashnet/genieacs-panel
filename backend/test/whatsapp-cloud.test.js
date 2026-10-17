/**
 * API oficial da Meta pela integração WHATSAPP-BUSINESS do Evolution v2.
 *
 * Um número oficial nasce sem QR, com o token da Meta como chave da instância,
 * e só aceita texto livre dentro da janela de 24 h desde a última mensagem do
 * cliente. Fora dela, só modelo aprovado — e a Meta recusa o resto com 131047,
 * que a fila tem de tratar como definitivo.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { default: WaInboundService } = await import('../src/services/waInboundService.js');
const { EVENTOS } = await import('../src/utils/wa/waEventos.js');

const EVO_BASE = 'https://evo-oficial.provedor.test';
const GO_BASE = 'https://evo-go.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentToken1234567890';

let panelUrl;
let token;
let evoServer;
let goServer;
const desfazer = [];

const stub = {
  sendStatus: 200,
  sendBody: null,
  nextId: 0,
  state: 'open'
};
const requests = [];

function startStub(flavor) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const path = req.url.split('?')[0];
      requests.push({ flavor, method: req.method, path, apikey: req.headers.apikey || null, body });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (flavor === 'go') {
        if (path === '/server/ok') return send(200, { status: 'ok' });
        return send(404, { error: 'not found' });
      }
      if (req.method === 'GET' && path === '/') return send(200, { version: '2.3.0' });
      if (path === '/instance/create') {
        return send(201, {
          instance: { instanceName: body.instanceName, instanceId: 'cloud-instance-id', integration: body.integration },
          // O servidor adota o token da Meta como apikey da instância.
          hash: body.token
        });
      }
      if (path.startsWith('/instance/connectionState/')) {
        return send(200, { instance: { state: stub.state } });
      }
      if (path.startsWith('/message/sendText/') || path.startsWith('/message/sendTemplate/')
        || path.startsWith('/message/sendMedia/')) {
        if (stub.sendStatus !== 200) return send(stub.sendStatus, stub.sendBody);
        stub.nextId += 1;
        return send(200, { key: { id: `wamid.${stub.nextId}`, remoteJid: body.number } });
      }
      if (path.startsWith('/instance/delete/')) return send(200, { status: 'SUCCESS' });
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
  const v2 = await startStub('v2');
  const go = await startStub('go');
  evoServer = v2.server;
  goServer = go.server;
  desfazer.push(rotearBase(EVO_BASE, v2.url), rotearBase(GO_BASE, go.url));

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
  WaOutboxWorker.stop();
  await Promise.all([evoServer, goServer].map((s) => new Promise((resolve) => s.close(resolve))));
  await stopTestServers();
});

function createCloud(extra = {}) {
  return call(`${panelUrl}/api/whatsapp/accounts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      kind: 'cloud',
      baseUrl: EVO_BASE,
      adminKey: 'chave-global',
      label: 'Oficial',
      metaToken: META_TOKEN,
      phoneNumberId: '109876543210987',
      wabaId: '123456789012345',
      ...extra
    }
  });
}

describe('criar um número oficial', () => {
  let account;

  it('cria a instância WHATSAPP-BUSINESS sem QR e já conectada', async () => {
    requests.length = 0;
    const { status, body } = await createCloud();
    assert.equal(status, 201, JSON.stringify(body));
    account = body.data.account;
    assert.equal(body.data.qr, null);
    assert.equal(body.data.pending, false);
    assert.equal(account.integration, 'cloud');
    assert.equal(account.metaPhoneNumberId, '109876543210987');
    assert.equal(account.metaWabaId, '123456789012345');
    assert.equal(account.status, 'connected');

    const create = sent('/instance/create')[0];
    assert.equal(create.apikey, 'chave-global');
    assert.equal(create.body.integration, 'WHATSAPP-BUSINESS');
    assert.equal(create.body.token, META_TOKEN);
    assert.equal(create.body.number, '109876543210987');
    assert.equal(create.body.businessId, '123456789012345');
    assert.equal(create.body.qrcode, false);
    assert.equal(create.body.webhook.byEvents, false);
    assert.ok(create.body.webhook.url.includes('?t='));
    // Nenhuma leitura de QR: o número oficial não pareia.
    assert.equal(sent('/instance/connect/').length, 0);
  });

  it('guarda o token da Meta como chave da instância, e ele não sai para o navegador', async () => {
    const row = await asTenant(() => WhatsAppAccount.getById(account.id));
    assert.equal(WhatsAppConfigService.decryptInstanceToken(row), META_TOKEN);
    const listed = await call(`${panelUrl}/api/whatsapp/accounts`, { headers: authHeaders(token) });
    assert.ok(!JSON.stringify(listed.body).includes(META_TOKEN));
  });

  it('recusa QR, reinício e desconexão de um número oficial', async () => {
    for (const [method, path] of [['GET', 'qr'], ['POST', 'restart'], ['POST', 'disconnect']]) {
      const r = await call(`${panelUrl}/api/whatsapp/accounts/${account.id}/${path}`, {
        method, headers: authHeaders(token)
      });
      assert.equal(r.status, 409, path);
      assert.equal(r.body.code, 'not_applicable_cloud', path);
    }
  });

  it('recusa credenciais fora do formato antes de falar com o servidor', async () => {
    requests.length = 0;
    const r = await createCloud({ phoneNumberId: '+55 93 99193-5695' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_meta_credentials');
    assert.equal(requests.length, 0);
  });

  it('recusa um servidor Evolution GO', async () => {
    const r = await createCloud({ baseUrl: GO_BASE });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'cloud_requires_v2');
  });

  it('remove sem logout, que não existe num número oficial', async () => {
    requests.length = 0;
    const extra = await createCloud({ label: 'Para apagar' });
    requests.length = 0;
    const r = await call(`${panelUrl}/api/whatsapp/accounts/${extra.body.data.account.id}`, {
      method: 'DELETE', headers: authHeaders(token), body: { adminKey: 'chave-global' }
    });
    assert.equal(r.status, 200);
    assert.equal(sent('/instance/logout/').length, 0);
    assert.equal(sent('/instance/delete/').length, 1);
  });
});

describe('a janela de 24 horas', () => {
  let cloudId;
  let seq = 0;

  before(async () => {
    const row = await asTenant(() => WhatsAppAccount.create({
      name: 'oficial-janela',
      purpose: 'general',
      flavor: 'v2',
      integration: 'cloud',
      base_url: EVO_BASE,
      status: 'connected',
      ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-oficial')
    }));
    cloudId = row.id;
  });

  beforeEach(async () => {
    await getDb()('wa_messages').where({ delivery_status: 'queued' }).del();
    WaOutboxWorker.stop();
    stub.sendStatus = 200;
    stub.sendBody = null;
    requests.length = 0;
  });

  async function conversa(lastInboundAt) {
    seq += 1;
    const phone = `5593991100${String(seq).padStart(3, '0')}`;
    const c = await asTenant(() => WaConversation.ensure({
      accountId: cloudId,
      externalThreadId: `${phone}@s.whatsapp.net`,
      waPhone: phone,
      pushName: 'Cliente'
    }));
    await getDb()('wa_conversations').where({ id: c.id }).update({ last_inbound_at: lastInboundAt });
    return c;
  }

  const horasAtras = (h) => new Date(Date.now() - h * 3_600_000);

  it('janela aberta: texto livre sai normalmente', async () => {
    const c = await conversa(horasAtras(2));
    const r = await call(`${panelUrl}/api/whatsapp/conversations/${c.id}/messages`, {
      method: 'POST', headers: authHeaders(token), body: { body: 'oi' }
    });
    assert.equal(r.status, 201);
    await WaOutboxWorker.tick();
    assert.equal(sent('/message/sendText/').length, 1);
    const row = await getDb()('wa_messages').where({ id: r.body.data.id }).first();
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.sent_as, 'text');
  });

  it('janela fechada sem modelo: recusa no envio, com o texto ainda na caixa', async () => {
    const c = await conversa(horasAtras(30));
    const r = await call(`${panelUrl}/api/whatsapp/conversations/${c.id}/messages`, {
      method: 'POST', headers: authHeaders(token), body: { body: 'oi' }
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'meta_window_closed');
    // Nota interna não sai para o cliente, então não depende da janela.
    const nota = await call(`${panelUrl}/api/whatsapp/conversations/${c.id}/messages`, {
      method: 'POST', headers: authHeaders(token), body: { body: 'anotação', isNote: true }
    });
    assert.equal(nota.status, 201);
  });

  it('conversa que nunca teve resposta do cliente também está fora da janela', async () => {
    const c = await conversa(null);
    await assert.rejects(
      asTenant(() => WaSendService.enqueue({ conversationId: c.id, body: 'aviso', source: 'campaign' })),
      (error) => error.code === 'meta_window_closed'
    );
  });

  it('janela fechada com modelo: sai como template, com os parâmetros', async () => {
    const c = await conversa(horasAtras(48));
    const msg = await asTenant(() => WaSendService.enqueue({
      conversationId: c.id,
      body: 'Sua fatura vence amanhã',
      source: 'campaign',
      metaTemplate: { name: 'aviso_fatura', language: 'pt_BR', params: ['Maria', 'R$ 99,90\nvence amanhã'] }
    }));
    await WaOutboxWorker.tick();
    const tpl = sent('/message/sendTemplate/');
    assert.equal(tpl.length, 1);
    assert.equal(sent('/message/sendText/').length, 0);
    assert.equal(tpl[0].body.name, 'aviso_fatura');
    assert.equal(tpl[0].body.language, 'pt_BR');
    assert.deepEqual(tpl[0].body.components, [{
      type: 'body',
      // A Meta recusa quebra de linha em parâmetro.
      parameters: [{ type: 'text', text: 'Maria' }, { type: 'text', text: 'R$ 99,90 · vence amanhã' }]
    }]);
    const row = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(row.sent_as, 'template');
    assert.equal(row.delivery_status, 'sent');
  });

  it('a janela que fechou depois de enfileirar falha de uma vez, sem nova tentativa', async () => {
    const c = await conversa(horasAtras(2));
    const msg = await asTenant(() => WaSendService.enqueue({ conversationId: c.id, body: 'oi', source: 'operator' }));
    await getDb()('wa_conversations').where({ id: c.id }).update({ last_inbound_at: horasAtras(25) });
    await WaOutboxWorker.tick();
    const row = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(row.delivery_status, 'failed');
    assert.match(row.delivery_error, /^meta_window_closed/);
    assert.equal(requests.length, 0);
  });

  it('a recusa 131047 da Meta vira falha definitiva', async () => {
    const c = await conversa(horasAtras(1));
    stub.sendStatus = 400;
    stub.sendBody = {
      status: 400,
      error: 'Bad Request',
      response: { message: [{ code: 131047, title: 'Re-engagement message', message: 'More than 24 hours have passed' }] }
    };
    const msg = await asTenant(() => WaSendService.enqueue({ conversationId: c.id, body: 'oi', source: 'operator' }));
    await WaOutboxWorker.tick();
    const row = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(row.delivery_status, 'failed');
    assert.match(row.delivery_error, /^meta_window_closed/);
  });

  it('o recibo FAILED da Meta marca como falha a mensagem que já tinha saído', async () => {
    const c = await conversa(horasAtras(1));
    const msg = await asTenant(() => WaSendService.enqueue({ conversationId: c.id, body: 'oi', source: 'operator' }));
    await WaOutboxWorker.tick();
    const enviada = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(enviada.delivery_status, 'sent');
    const account = await asTenant(() => WhatsAppAccount.getById(cloudId));
    const result = await asTenant(() => WaInboundService.handle(account, EVENTOS.RECIBO, {
      event: 'messages.update',
      data: { keyId: enviada.external_id, status: 'FAILED', errors: [{ code: 131047, title: 'Re-engagement message' }] }
    }));
    assert.equal(result.status, 'failed');
    const row = await asTenant(() => WaMessage.getById(msg.id));
    assert.equal(row.delivery_status, 'failed');
    assert.equal(row.delivery_error, 'meta_window_closed');
  });

  it('DELIVERED em maiúsculas sobe o recibo', async () => {
    const c = await conversa(horasAtras(1));
    const msg = await asTenant(() => WaSendService.enqueue({ conversationId: c.id, body: 'oi', source: 'operator' }));
    await WaOutboxWorker.tick();
    const enviada = await getDb()('wa_messages').where({ id: msg.id }).first();
    const account = await asTenant(() => WhatsAppAccount.getById(cloudId));
    await asTenant(() => WaInboundService.handle(account, EVENTOS.RECIBO, {
      event: 'messages.update',
      data: { keyId: enviada.external_id, status: 'DELIVERED' }
    }));
    const row = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(row.delivery_status, 'delivered');
  });
});

describe('o webhook da Meta na configuração', () => {
  it('guarda o token de verificação cifrado e o devolve para colar no app da Meta', async () => {
    const put = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { cloudVerifyToken: 'verifica-meta-123', cloudCallbackUrl: 'https://evo.exemplo.com/webhook/meta' }
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await call(`${panelUrl}/api/whatsapp/config`, { headers: authHeaders(token) });
    assert.deepEqual(get.body.data.cloudWebhook, {
      callbackUrl: 'https://evo.exemplo.com/webhook/meta',
      verifyToken: 'verifica-meta-123'
    });
    const raw = await getDb()('app_state').where({ key: 'whatsapp_evolution_config' }).first();
    assert.ok(!raw.value.includes('verifica-meta-123'), 'o token não fica em claro no banco');
  });

  it('sem URL própria, o callback é o /webhook/meta do servidor gerenciado', () => {
    assert.equal(
      WhatsAppConfigService.cloudCallbackUrl({ cloudCallbackUrl: '', managedUrl: 'https://evo.plataforma.com/' }),
      'https://evo.plataforma.com/webhook/meta'
    );
    assert.equal(WhatsAppConfigService.cloudCallbackUrl({ cloudCallbackUrl: '', managedUrl: '' }), '');
  });
});
