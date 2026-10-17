/**
 * Modelos aprovados da Meta (número oficial): sincronizar, ligar aos modelos
 * do painel e aos avisos automáticos, e usar fora da janela de 24 h.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { default: WaMetaTemplateService } = await import('../src/services/waMetaTemplateService.js');
const { default: WaCampaignService } = await import('../src/services/waCampaignService.js');

const EVO_BASE = 'https://evo-modelos.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentToken1234567890';

let panelUrl;
let token;
let server;
let desfazer;
let accountId;
const requests = [];
const stub = {
  templates: [
    {
      id: '11', name: 'aviso_fatura', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Olá {{1}}, sua fatura vence em {{2}}.' }]
    },
    {
      id: '12', name: 'aviso_geral', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Aviso do seu provedor: {{1}}' }]
    },
    {
      id: '13', name: 'promo_imagem', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING',
      components: [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Oferta' }]
    },
    {
      id: '14', name: 'em_analise', language: 'pt_BR', status: 'PENDING', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Oi {{1}}' }]
    }
  ],
  nextId: 0
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
      requests.push({ path, apikey: req.headers.apikey || null, body });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (path.startsWith('/template/find/')) return send(200, stub.templates);
      if (path.startsWith('/message/')) {
        stub.nextId += 1;
        return send(200, { key: { id: `wamid.t${stub.nextId}` } });
      }
      if (path.startsWith('/instance/connectionState/')) return send(200, { instance: { state: 'open' } });
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
    name: 'oficial-modelos',
    purpose: 'general',
    flavor: 'v2',
    integration: 'cloud',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-modelos')
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

describe('sincronizar os modelos da Meta', () => {
  it('busca pelo número oficial, com a chave dele, e guarda todos', async () => {
    requests.length = 0;
    const r = await api(`/accounts/${accountId}/templates/sync`, { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.length, 4);
    const pedido = requests.find((q) => q.path === '/template/find/oficial-modelos');
    assert.equal(pedido.apikey, META_TOKEN);
    const conta = await asTenant(() => WhatsAppAccount.getById(accountId));
    assert.ok(conta.meta_templates_synced_at);
  });

  it('o seletor só oferece os aprovados que o painel sabe enviar', async () => {
    const r = await api(`/meta-templates?accountId=${accountId}&usable=1`);
    assert.deepEqual(r.body.data.map((m) => m.name).sort(), ['aviso_fatura', 'aviso_geral']);
    const fatura = r.body.data.find((m) => m.name === 'aviso_fatura');
    assert.equal(fatura.paramCount, 2);
  });

  it('o que sumiu da Meta some daqui', async () => {
    const guardados = stub.templates;
    stub.templates = guardados.filter((m) => m.name !== 'em_analise');
    await api(`/accounts/${accountId}/templates/sync`, { method: 'POST' });
    stub.templates = guardados;
    const r = await api(`/meta-templates?accountId=${accountId}`);
    assert.ok(!r.body.data.some((m) => m.name === 'em_analise'));
    await api(`/accounts/${accountId}/templates/sync`, { method: 'POST' });
  });

  it('recusa sincronizar um número por QR', async () => {
    const qr = await asTenant(() => WhatsAppAccount.create({
      name: 'qr-comum', purpose: 'general', flavor: 'v2', base_url: EVO_BASE, status: 'connected',
      ...WhatsAppConfigService.encryptInstanceToken('tok'), ...WhatsAppConfigService.encryptWebhookToken('w')
    }));
    const r = await api(`/accounts/${qr.id}/templates/sync`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'meta_templates_cloud_only');
    await getDb()('whatsapp_accounts').where({ id: qr.id }).del();
  });
});

describe('ligar um modelo do painel a um modelo da Meta', () => {
  it('confere a quantidade de parâmetros e as variáveis', async () => {
    const errado = await api('/templates', {
      method: 'POST',
      body: {
        name: 'Fatura oficial', category: 'cobranca', body: 'Olá {{nome}}, vence {{vencimento}}.',
        metaTemplateName: 'aviso_fatura', metaLanguage: 'pt_BR', metaParams: ['nome']
      }
    });
    assert.equal(errado.status, 400);
    assert.equal(errado.body.code, 'meta_param_mismatch');

    const desconhecida = await api('/templates', {
      method: 'POST',
      body: {
        name: 'Fatura oficial', category: 'cobranca', body: 'Olá {{nome}}',
        metaTemplateName: 'aviso_fatura', metaLanguage: 'pt_BR', metaParams: ['nome', 'inventada']
      }
    });
    assert.equal(desconhecida.body.code, 'meta_param_mismatch');

    const pendente = await api('/templates', {
      method: 'POST',
      body: {
        name: 'Fatura oficial', category: 'cobranca', body: 'Olá {{nome}}',
        metaTemplateName: 'em_analise', metaLanguage: 'pt_BR', metaParams: ['nome']
      }
    });
    assert.equal(pendente.body.code, 'meta_template_unavailable');

    const certo = await api('/templates', {
      method: 'POST',
      body: {
        name: 'Fatura oficial', category: 'cobranca', body: 'Olá {{nome}}, vence {{vencimento}}.',
        metaTemplateName: 'aviso_fatura', metaLanguage: 'pt_BR', metaParams: ['nome', 'vencimento']
      }
    });
    assert.equal(certo.status, 201, JSON.stringify(certo.body));
    assert.equal(certo.body.data.metaTemplateName, 'aviso_fatura');
    assert.deepEqual(certo.body.data.metaParams, ['nome', 'vencimento']);

    // Renomear não apaga a ligação.
    const renomeado = await api(`/templates/${certo.body.data.id}`, { method: 'PUT', body: { name: 'Fatura (oficial)' } });
    assert.equal(renomeado.body.data.metaTemplateName, 'aviso_fatura');
    // E `metaTemplateName: ''` desliga.
    const desligado = await api(`/templates/${certo.body.data.id}`, { method: 'PUT', body: { metaTemplateName: '' } });
    assert.equal(desligado.body.data.metaTemplateName, null);
  });

  it('monta os parâmetros na ordem, e variável vazia não sai', () => {
    const modelo = { meta_template_name: 'aviso_fatura', meta_language: 'pt_BR', meta_params: '["primeiro_nome","texto"]' };
    assert.deepEqual(
      WaMetaTemplateService.buildPayload(modelo, { primeiro_nome: 'Maria' }, 'Linha 1\nLinha 2'),
      { name: 'aviso_fatura', language: 'pt_BR', params: ['Maria', 'Linha 1 · Linha 2'] }
    );
    assert.deepEqual(WaMetaTemplateService.buildPayload(modelo, { primeiro_nome: '' }, 'x'), { incomplete: ['primeiro_nome'] });
    assert.equal(WaMetaTemplateService.buildPayload({ meta_template_name: null }, {}, 'x'), null);
  });

  it('a campanha leva a foto do modelo da Meta em cada destinatário', () => {
    const modelo = { meta_template_name: 'aviso_geral', meta_language: 'pt_BR', meta_params: '["primeiro_nome"]' };
    const { prontos, templateIncomplete } = WaCampaignService.renderAll(
      'Oi {{primeiro_nome}}',
      [{ clientName: 'João Silva', contract: '1', phone: '559391111111' }, { clientName: '', contract: '2', phone: '559392222222' }],
      modelo
    );
    assert.equal(prontos.length, 1);
    assert.equal(templateIncomplete, 1);
    assert.deepEqual(prontos[0].metaTemplate, { name: 'aviso_geral', language: 'pt_BR', params: ['João'] });
  });
});

describe('avisos automáticos', () => {
  it('liga um aviso a um modelo de até um parâmetro, que recebe o texto inteiro', async () => {
    const demais = await api('/meta-notice-bindings', {
      method: 'PUT', body: { maintenance: { name: 'aviso_fatura', language: 'pt_BR' } }
    });
    assert.equal(demais.status, 400);
    assert.equal(demais.body.code, 'meta_param_mismatch');

    const ok = await api('/meta-notice-bindings', {
      method: 'PUT', body: { maintenance: { name: 'aviso_geral', language: 'pt_BR' } }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.maintenance, { name: 'aviso_geral', language: 'pt_BR', paramCount: 1 });
    assert.equal(ok.body.data.outage, null);

    const payload = await asTenant(() => WaMetaTemplateService.noticePayload('maintenance', 'Manutenção\namanhã'));
    assert.deepEqual(payload, { name: 'aviso_geral', language: 'pt_BR', params: ['Manutenção · amanhã'] });
    assert.equal(await asTenant(() => WaMetaTemplateService.noticePayload('outage', 'x')), null);
  });
});

describe('o atendente responde com modelo fora da janela', () => {
  let conversa;
  beforeEach(async () => {
    await getDb()('wa_messages').where({ delivery_status: 'queued' }).del();
    WaOutboxWorker.stop();
    requests.length = 0;
  });

  before(async () => {
    conversa = await asTenant(() => WaConversation.ensure({
      accountId, externalThreadId: '5593991230000@s.whatsapp.net', waPhone: '5593991230000', pushName: 'Ana'
    }));
    await getDb()('wa_conversations').where({ id: conversa.id })
      .update({ last_inbound_at: new Date(Date.now() - 40 * 3_600_000) });
  });

  it('sai por sendTemplate, com o texto do modelo na conversa', async () => {
    const r = await api(`/conversations/${conversa.id}/messages`, {
      method: 'POST',
      body: { metaTemplate: { name: 'aviso_geral', language: 'pt_BR', params: ['sua conexão voltou'] } }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.body, 'Aviso do seu provedor: sua conexão voltou');
    await WaOutboxWorker.tick();
    const tpl = requests.filter((q) => q.path.startsWith('/message/sendTemplate/'));
    assert.equal(tpl.length, 1);
    assert.deepEqual(tpl[0].body.components[0].parameters, [{ type: 'text', text: 'sua conexão voltou' }]);
  });

  it('recusa modelo que não está aprovado ou com parâmetro faltando', async () => {
    const pendente = await api(`/conversations/${conversa.id}/messages`, {
      method: 'POST', body: { metaTemplate: { name: 'em_analise', language: 'pt_BR', params: ['x'] } }
    });
    assert.equal(pendente.status, 400);
    assert.equal(pendente.body.code, 'meta_template_unavailable');
    const faltando = await api(`/conversations/${conversa.id}/messages`, {
      method: 'POST', body: { metaTemplate: { name: 'aviso_geral', language: 'pt_BR', params: [] } }
    });
    assert.equal(faltando.body.code, 'meta_template_unavailable');
  });
});
