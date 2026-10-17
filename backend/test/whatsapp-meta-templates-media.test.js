/**
 * Modelos da Meta com cabeçalho de mídia e botão de URL dinâmica, de ponta a
 * ponta: sincronizar, ligar a um modelo do painel (de onde vem a mídia, qual
 * variável completa a URL do botão) e enviar fora da janela de 24 h,
 * conferindo o corpo que chega ao Evolution.
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
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { default: WaMetaTemplateService } = await import('../src/services/waMetaTemplateService.js');

const EVO_BASE = 'https://evo-midia.provedor.test';
const META_TOKEN = 'EAAGm0PX4ZCpsBAMetaPermanentTokenMidia123456';

let panelUrl;
let token;
let server;
let desfazer;
let accountId;
const requests = [];
let nextId = 0;
const templates = [
  {
    id: '21', name: 'boleto_documento', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'DOCUMENT' },
      { type: 'BODY', text: 'Olá {{1}}, segue o seu boleto.' },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'Já paguei' },
        { type: 'URL', text: 'Pagar', url: 'https://pagar.provedor.test/f/{{1}}' }
      ] }
    ]
  },
  {
    id: '22', name: 'promo_imagem', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING',
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oferta da semana' }]
  },
  {
    id: '23', name: 'loja_local', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
    components: [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'Estamos aqui' }]
  }
];

before(async () => {
  ({ panelUrl } = await startTestServers());
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const path = req.url.split('?')[0];
      requests.push({ path, body });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (path.startsWith('/template/find/')) return send(200, templates);
      if (path.startsWith('/message/')) {
        nextId += 1;
        return send(200, { key: { id: `wamid.m${nextId}` } });
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
    name: 'oficial-midia',
    purpose: 'general',
    flavor: 'v2',
    integration: 'cloud',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(META_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-midia')
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

describe('sincronizar modelos com mídia e botão', () => {
  it('documento e imagem no cabeçalho, e botão dinâmico, entram como suportados', async () => {
    const r = await api(`/accounts/${accountId}/templates/sync`, { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const por = Object.fromEntries(r.body.data.map((m) => [m.name, m]));
    assert.equal(por.boleto_documento.usable, true);
    assert.equal(por.boleto_documento.headerFormat, 'DOCUMENT');
    assert.equal(por.boleto_documento.headerParamCount, 0);
    assert.deepEqual(por.boleto_documento.buttons, [
      { index: 0, type: 'QUICK_REPLY', urlHasParam: false },
      { index: 1, type: 'URL', urlHasParam: true }
    ]);
    assert.equal(por.promo_imagem.usable, true);
    assert.equal(por.promo_imagem.headerFormat, 'IMAGE');
    assert.equal(por.loja_local.usable, false);
    assert.equal(por.loja_local.headerFormat, 'LOCATION');

    const usaveis = await api(`/meta-templates?accountId=${accountId}&usable=1`);
    assert.deepEqual(usaveis.body.data.map((m) => m.name).sort(), ['boleto_documento', 'promo_imagem']);
  });

  it('aviso automático não pode usar modelo que pede cabeçalho', async () => {
    const r = await api('/meta-notice-bindings', {
      method: 'PUT', body: { maintenance: { name: 'promo_imagem', language: 'pt_BR' } }
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'meta_param_mismatch');
  });
});

describe('ligar modelo do painel com cabeçalho e botão', () => {
  const base = {
    name: 'Boleto oficial', category: 'cobranca', body: 'Olá {{nome}}, boleto: {{link_boleto}}',
    metaTemplateName: 'boleto_documento', metaLanguage: 'pt_BR', metaParams: ['nome']
  };

  it('exige a origem do cabeçalho e a variável do botão', async () => {
    const semCabecalho = await api('/templates', { method: 'POST', body: { ...base, metaButtonParam: 'linha_digitavel' } });
    assert.equal(semCabecalho.status, 400);
    assert.equal(semCabecalho.body.code, 'meta_header_mismatch');

    const http = await api('/templates', {
      method: 'POST',
      body: { ...base, metaHeader: { source: 'url', value: 'http://inseguro.test/b.pdf' }, metaButtonParam: 'linha_digitavel' }
    });
    assert.equal(http.body.code, 'meta_header_mismatch');

    const inventada = await api('/templates', {
      method: 'POST',
      body: { ...base, metaHeader: { source: 'variable', value: 'inventada' }, metaButtonParam: 'linha_digitavel' }
    });
    assert.equal(inventada.body.code, 'meta_header_mismatch');

    const semBotao = await api('/templates', {
      method: 'POST', body: { ...base, metaHeader: { source: 'variable', value: 'link_boleto' } }
    });
    assert.equal(semBotao.status, 400);
    assert.equal(semBotao.body.code, 'meta_button_mismatch');
  });

  it('salva a ligação válida e devolve a origem e a variável do botão', async () => {
    const r = await api('/templates', {
      method: 'POST',
      body: { ...base, metaHeader: { source: 'variable', value: 'link_boleto' }, metaButtonParam: 'linha_digitavel' }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.metaHeader, { source: 'variable', value: 'link_boleto' });
    assert.equal(r.body.data.metaButtonParam, 'linha_digitavel');
    const row = await getDb()('wa_templates').where({ id: r.body.data.id }).first();
    assert.equal(row.meta_button_index, 1);

    // Trocar para um modelo sem botão descarta a variável do botão.
    const trocado = await api(`/templates/${r.body.data.id}`, {
      method: 'PUT',
      body: {
        metaTemplateName: 'promo_imagem', metaLanguage: 'pt_BR', metaParams: [],
        metaHeader: { source: 'url', value: 'https://cdn.provedor.test/promo.png' }, metaButtonParam: 'linha_digitavel'
      }
    });
    assert.equal(trocado.status, 200, JSON.stringify(trocado.body));
    assert.equal(trocado.body.data.metaButtonParam, null);
    assert.deepEqual(trocado.body.data.metaHeader, { source: 'url', value: 'https://cdn.provedor.test/promo.png' });
  });
});

describe('envio fora da janela', () => {
  let conversa;

  before(async () => {
    conversa = await asTenant(() => WaConversation.ensure({
      accountId, externalThreadId: '5593991239999@s.whatsapp.net', waPhone: '5593991239999', pushName: 'Maria'
    }));
    await getDb()('wa_conversations').where({ id: conversa.id })
      .update({ last_inbound_at: new Date(Date.now() - 40 * 3_600_000) });
  });

  beforeEach(async () => {
    await getDb()('wa_messages').where({ delivery_status: 'queued' }).del();
    WaOutboxWorker.stop();
    // A campanha espera o ritmo das automáticas; cada teste começa com a vez livre.
    await getDb()('app_state').whereIn('key', [WaOutboxWorker.PACE_KEY, WaOutboxWorker.WINDOW_KEY]).del();
    requests.length = 0;
  });

  const ligacao = {
    meta_template_name: 'boleto_documento',
    meta_language: 'pt_BR',
    meta_params: '["nome"]',
    meta_header: JSON.stringify({ source: 'variable', value: 'link_boleto', type: 'document' }),
    meta_button_param: 'linha_digitavel',
    meta_button_index: 1
  };

  it('cabeçalho de documento pela variável e botão com o sufixo', async () => {
    const vars = { nome: 'Maria', link_boleto: 'https://boletos.provedor.test/b/998877', linha_digitavel: '23790001' };
    const meta = WaMetaTemplateService.buildPayload(ligacao, vars, 'texto');
    assert.deepEqual(meta.header, { type: 'document', link: 'https://boletos.provedor.test/b/998877', filename: 'boleto.pdf' });
    const msg = await asTenant(() => WaSendService.enqueue({
      conversationId: conversa.id, body: 'Olá Maria', source: 'campaign', metaTemplate: meta
    }));
    const salvo = JSON.parse((await getDb()('wa_messages').where({ id: msg.id }).first()).meta_template);
    assert.deepEqual(salvo.buttons, [{ index: 1, param: '23790001' }]);

    await WaOutboxWorker.tick();
    const tpl = requests.filter((q) => q.path === '/message/sendTemplate/oficial-midia');
    assert.equal(tpl.length, 1);
    assert.equal(tpl[0].body.name, 'boleto_documento');
    assert.deepEqual(tpl[0].body.components, [
      {
        type: 'header',
        parameters: [{ type: 'document', document: { link: 'https://boletos.provedor.test/b/998877', filename: 'boleto.pdf' } }]
      },
      { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: '23790001' }] }
    ]);
    const row = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(row.sent_as, 'template');
  });

  it('link de boleto vazio ou sem https deixa o destinatário de fora', () => {
    const vazio = WaMetaTemplateService.buildPayload(ligacao, { nome: 'M', link_boleto: '', linha_digitavel: '1' }, 'x');
    assert.deepEqual(vazio, { incomplete: ['link_boleto'] });
    const http = WaMetaTemplateService.buildPayload(ligacao, { nome: 'M', link_boleto: 'http://x.test/b', linha_digitavel: '1' }, 'x');
    assert.deepEqual(http, { incomplete: ['link_boleto'] });
  });

  it('cabeçalho do anexo da campanha usa o link assinado da própria mensagem', async () => {
    const meta = WaMetaTemplateService.buildPayload({
      meta_template_name: 'promo_imagem', meta_language: 'pt_BR', meta_params: '[]',
      meta_header: JSON.stringify({ source: 'attachment', value: null, type: 'image' })
    }, {}, 'x');
    assert.deepEqual(meta, { name: 'promo_imagem', language: 'pt_BR', params: [], header: { type: 'image', source: 'attachment' } });
    const msg = await asTenant(() => WaSendService.enqueue({
      conversationId: conversa.id, body: 'Oferta', source: 'campaign', metaTemplate: meta
    }));
    await getDb()('wa_messages').where({ id: msg.id })
      .update({ attachment_path: 'wa-out/promo.png', attachment_type: 'image/png', attachment_name: 'promo.png' });
    await WaOutboxWorker.tick();
    const tpl = requests.filter((q) => q.path === '/message/sendTemplate/oficial-midia');
    const enviada = await getDb()('wa_messages').where({ id: msg.id }).first();
    assert.equal(tpl.length, 1, JSON.stringify(enviada));
    const [cabecalho] = tpl[0].body.components;
    assert.equal(cabecalho.type, 'header');
    const link = cabecalho.parameters[0].image.link;
    assert.ok(link.startsWith(`https://painel.provedor.test/api/whatsapp-media/${msg.id}?t=`), link);
  });

  it('o atendente manda modelo com documento e botão, conferidos contra o modelo', async () => {
    const faltando = await api(`/conversations/${conversa.id}/messages`, {
      method: 'POST', body: { metaTemplate: { name: 'boleto_documento', language: 'pt_BR', params: ['Maria'] } }
    });
    assert.equal(faltando.status, 400);
    assert.equal(faltando.body.code, 'meta_template_unavailable');

    const r = await api(`/conversations/${conversa.id}/messages`, {
      method: 'POST',
      body: {
        metaTemplate: {
          name: 'boleto_documento', language: 'pt_BR', params: ['Maria'],
          header: { type: 'document', link: 'https://boletos.provedor.test/b/1', filename: 'fatura.pdf' },
          buttons: [{ index: 1, param: 'abc' }]
        }
      }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await WaOutboxWorker.tick();
    const tpl = requests.filter((q) => q.path === '/message/sendTemplate/oficial-midia');
    assert.equal(tpl.length, 1);
    assert.deepEqual(tpl[0].body.components[0].parameters[0].document, { link: 'https://boletos.provedor.test/b/1', filename: 'fatura.pdf' });
    assert.deepEqual(tpl[0].body.components[2], { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'abc' }] });
  });
});
