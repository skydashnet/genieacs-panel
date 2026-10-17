/**
 * As peças puras da API oficial da Meta: payloads, leitura dos modelos, a
 * regra da janela de 24 h e a classificação das recusas da Meta.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBusinessInstanceRequest,
  createMetaTemplateRequest,
  findMetaTemplatesRequest,
  readCreatedTemplate,
  readMetaError,
  readMetaTemplates,
  sanitizeMetaParam,
  sendTemplateRequest
} from '../src/utils/wa/evolutionApi.js';
import { decidirEnvioCloud, META_WINDOW_MARGIN_MS, META_WINDOW_MS } from '../src/utils/wa/waJanelaMeta.js';
import { lerFalhaDeEnvio, lerRecibo } from '../src/utils/wa/waRecibo.js';

const { isPermanentFailure } = await import('../src/services/waSendFailure.js');
const { WaError } = await import('../src/services/whatsappConfigService.js');
const { validateMetaTemplateInput } = await import('../src/services/waMetaTemplateService.js');

describe('payloads da integração WHATSAPP-BUSINESS', () => {
  test('o create leva o token, o Phone Number ID e a WABA, sem QR', () => {
    const r = createBusinessInstanceRequest({
      name: 'skygp_x', metaToken: 'EAAG...', phoneNumberId: '1099', wabaId: '2088', webhookUrl: 'https://p/api/whatsapp-webhook?t=abc'
    });
    assert.equal(r.path, '/instance/create');
    assert.equal(r.key, 'admin');
    assert.equal(r.body.integration, 'WHATSAPP-BUSINESS');
    assert.equal(r.body.token, 'EAAG...');
    assert.equal(r.body.number, '1099');
    assert.equal(r.body.businessId, '2088');
    assert.equal(r.body.qrcode, false);
    assert.equal(r.body.webhook.byEvents, false);
    assert.equal(r.body.instanceName, 'skygp_x');
  });

  test('o envio de modelo põe os parâmetros no corpo, na ordem', () => {
    const r = sendTemplateRequest('inst', '5593991935695', { name: 'aviso', language: 'pt_BR', params: ['a', 'b'] });
    assert.equal(r.path, '/message/sendTemplate/inst');
    assert.equal(r.key, 'instance');
    assert.deepEqual(r.body.components, [
      { type: 'body', parameters: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }
    ]);
    const semVariavel = sendTemplateRequest('inst', '559', { name: 'oi', language: 'pt_BR', params: [] });
    assert.deepEqual(semVariavel.body.components, []);
  });

  test('a listagem de modelos é por instância', () => {
    assert.deepEqual(findMetaTemplatesRequest('a b'), { path: '/template/find/a%20b', method: 'GET', key: 'instance' });
  });

  test('parâmetro sem quebra de linha, tab ou espaço em excesso', () => {
    assert.equal(sanitizeMetaParam('linha 1\n\nlinha 2\tfim     x'), 'linha 1 · linha 2 fim   x');
    assert.equal(sanitizeMetaParam('x'.repeat(2000)).length, 1024);
  });
});

describe('leitura dos modelos da Meta', () => {
  const modelos = readMetaTemplates({
    data: [
      {
        id: '1', name: 'aviso_fatura', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Olá {{1}}, sua fatura de {{2}} vence {{3}}.' }]
      },
      {
        id: '2', name: 'promo', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING',
        components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oferta!' }]
      },
      {
        id: '3', name: 'nomeado', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
        parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Oi {{nome}}' }]
      },
      {
        id: '4', name: 'codigo', language: 'pt_BR', status: 'APPROVED', category: 'AUTHENTICATION',
        components: [{ type: 'BODY', text: '{{1}} é seu código' }]
      },
      { name: '', language: 'pt_BR' }
    ]
  });

  test('conta os parâmetros posicionais pelo maior índice', () => {
    assert.equal(modelos.length, 4);
    const [fatura] = modelos;
    assert.equal(fatura.paramCount, 3);
    assert.equal(fatura.paramFormat, 'positional');
    assert.equal(fatura.supported, true);
    assert.equal(fatura.status, 'APPROVED');
  });

  test('mídia no cabeçalho entra; parâmetro nomeado e autenticação ficam fora do seletor', () => {
    assert.deepEqual(modelos.slice(1).map((m) => m.supported), [true, false, false]);
    assert.equal(modelos[1].headerFormat, 'IMAGE');
    assert.equal(modelos[2].paramFormat, 'named');
    assert.equal(modelos[0].headerFormat, 'NONE');
    assert.deepEqual(modelos[0].buttons, []);
  });

  test('aceita a lista na raiz', () => {
    assert.equal(readMetaTemplates([{ name: 'a', language: 'en', components: [] }]).length, 1);
  });
});

describe('a regra da janela de 24 horas', () => {
  const agora = Date.UTC(2026, 9, 1, 12);
  const h = (n) => new Date(agora - n * 3_600_000);

  test('número por QR não tem janela', () => {
    assert.equal(decidirEnvioCloud({ isCloud: false, lastInboundAt: null, now: agora }), 'text');
  });

  test('aberta → texto, mesmo havendo modelo', () => {
    assert.equal(decidirEnvioCloud({ isCloud: true, lastInboundAt: h(1), hasTemplate: true, now: agora }), 'text');
  });

  test('fechada → modelo se houver, recusa se não houver', () => {
    assert.equal(decidirEnvioCloud({ isCloud: true, lastInboundAt: h(25), hasTemplate: true, now: agora }), 'template');
    assert.equal(decidirEnvioCloud({ isCloud: true, lastInboundAt: h(25), now: agora }), 'refuse');
    assert.equal(decidirEnvioCloud({ isCloud: true, lastInboundAt: null, now: agora }), 'refuse');
  });

  test('a folga fecha a janela antes das 24 h', () => {
    const quase = new Date(agora - META_WINDOW_MS + META_WINDOW_MARGIN_MS / 2);
    assert.equal(decidirEnvioCloud({ isCloud: true, lastInboundAt: quase, now: agora }), 'refuse');
  });

  test('a janela de outro número não vale para este', () => {
    assert.equal(decidirEnvioCloud({ isCloud: true, sameAccount: false, lastInboundAt: h(1), now: agora }), 'refuse');
  });
});

describe('recusas da Meta', () => {
  const http = (status, body) => new WaError('whatsapp.error.httpError', {
    code: 'http_error', status: 502, vars: { status, body: JSON.stringify(body) }
  });

  test('131047 é definitiva mesmo dizendo "try again"', () => {
    assert.equal(isPermanentFailure(http(400, { error: { code: 131047, message: 'Re-engagement message, try again later' } })), true);
  });

  test('limite de vazão (130429) e token vencido (190) voltam para a fila', () => {
    assert.equal(isPermanentFailure(http(400, { error: { code: 130429, message: 'Rate limit hit' } })), false);
    assert.equal(isPermanentFailure(http(400, { error: { code: 190, message: 'Access token expired' } })), false);
  });

  test('o código do painel para janela fechada é definitivo', () => {
    assert.equal(isPermanentFailure(new WaError('x', { code: 'meta_window_closed', status: 409 })), true);
  });

  test('readMetaError reconhece a janela pelo código e pelo texto', () => {
    assert.deepEqual(readMetaError('{"code":131047}'), { code: 131047, windowClosed: true });
    assert.equal(readMetaError('More than 24 hours have passed').windowClosed, true);
    assert.equal(readMetaError('{"code":131026}').windowClosed, false);
  });
});

describe('recibos da API oficial', () => {
  test('SENT, DELIVERED e READ em maiúsculas', () => {
    assert.deepEqual(lerRecibo({ data: { keyId: 'wamid.1', status: 'DELIVERED' } }), { ids: ['wamid.1'], status: 'delivered' });
    assert.deepEqual(lerRecibo({ data: { keyId: 'wamid.1', status: 'SENT' } }), { ids: ['wamid.1'], status: 'sent' });
    assert.deepEqual(lerRecibo({ data: { keyId: 'wamid.1', status: 'read' } }), { ids: ['wamid.1'], status: 'read' });
  });

  test('FAILED vira falha de envio, com o erro da Meta', () => {
    const falha = lerFalhaDeEnvio({ data: { keyId: 'wamid.2', status: 'FAILED', errors: [{ code: 131047 }] } });
    assert.deepEqual(falha.ids, ['wamid.2']);
    assert.match(falha.errorText, /131047/);
    assert.equal(lerFalhaDeEnvio({ data: { keyId: 'wamid.2', status: 'DELIVERED' } }), null);
  });
});

describe('criar modelo na Meta: o pedido', () => {
  test('só corpo, sem variável: sem example, pela chave da instância', () => {
    const r = createMetaTemplateRequest('oficial x', {
      name: 'aviso_geral', category: 'UTILITY', language: 'pt_BR', bodyText: 'Aviso do provedor', examples: []
    });
    assert.equal(r.path, '/template/create/oficial%20x');
    assert.equal(r.method, 'POST');
    assert.equal(r.key, 'instance');
    assert.equal(r.body.allowCategoryChange, true);
    assert.deepEqual(r.body.components, [{ type: 'BODY', text: 'Aviso do provedor' }]);
  });

  test('corpo com variáveis leva uma linha de exemplo; cabeçalho, rodapé e botões na ordem', () => {
    const r = createMetaTemplateRequest('oficial', {
      name: 'fatura',
      category: 'UTILITY',
      language: 'pt_BR',
      bodyText: 'Olá {{1}}, vence {{2}}.',
      examples: ['Ana', '10/10'],
      headerText: 'Sua fatura',
      footerText: 'Provedor X',
      buttons: [
        { type: 'URL', text: 'Pagar', url: 'https://pague.test/x' },
        { type: 'QUICK_REPLY', text: 'Já paguei' }
      ]
    });
    assert.deepEqual(r.body.components.map((c) => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
    assert.deepEqual(r.body.components[0], { type: 'HEADER', format: 'TEXT', text: 'Sua fatura' });
    assert.deepEqual(r.body.components[1].example, { body_text: [['Ana', '10/10']] });
    assert.deepEqual(r.body.components[3].buttons, [
      { type: 'URL', text: 'Pagar', url: 'https://pague.test/x' },
      { type: 'QUICK_REPLY', text: 'Já paguei' }
    ]);
  });

  test('a resposta da criação vem na raiz ou em data', () => {
    assert.deepEqual(readCreatedTemplate({ id: 99, status: 'pending', category: 'utility' }),
      { id: '99', status: 'PENDING', category: 'UTILITY' });
    assert.deepEqual(readCreatedTemplate({ data: { id: '7', status: 'APPROVED' } }),
      { id: '7', status: 'APPROVED', category: null });
    assert.deepEqual(readCreatedTemplate(null), { id: null, status: null, category: null });
  });
});

describe('criar modelo na Meta: a validação', () => {
  const base = { name: 'aviso', category: 'UTILITY', language: 'pt_BR', bodyText: 'Oi {{1}}', examples: ['Ana'] };
  const campo = (input) => {
    try {
      validateMetaTemplateInput(input);
    } catch (error) {
      assert.ok(error instanceof WaError);
      assert.equal(error.code, 'invalid_meta_template');
      assert.equal(error.status, 400);
      return error.details.field;
    }
    return null;
  };

  test('normaliza nome, categoria, idioma e variáveis', () => {
    const m = validateMetaTemplateInput({
      name: '  Aviso Fatura ', category: 'marketing', language: '', bodyText: ' Oi {{ 1 }} ', examples: ['Ana\nSilva']
    });
    assert.equal(m.name, 'aviso_fatura');
    assert.equal(m.category, 'MARKETING');
    assert.equal(m.language, 'pt_BR');
    assert.equal(m.bodyText, 'Oi {{1}}');
    assert.deepEqual(m.examples, ['Ana · Silva']);
    assert.equal(m.paramCount, 1);
    assert.equal(m.headerText, null);
    assert.deepEqual(m.buttons, []);
  });

  test('aponta o campo errado', () => {
    assert.equal(campo({ ...base, name: 'aviso-fatura!' }), 'name');
    assert.equal(campo({ ...base, category: 'AUTHENTICATION' }), 'category');
    assert.equal(campo({ ...base, language: 'portugues' }), 'language');
    assert.equal(campo({ ...base, bodyText: '' }), 'bodyText');
    assert.equal(campo({ ...base, bodyText: 'x'.repeat(1025) }), 'bodyText');
    assert.equal(campo({ ...base, bodyText: 'Oi {{1}} e {{3}}', examples: ['a', 'b', 'c'] }), 'variables');
    assert.equal(campo({ ...base, bodyText: 'Oi {{nome}}', examples: ['a'] }), 'variables');
    assert.equal(campo({ ...base, examples: [] }), 'examples');
    assert.equal(campo({ ...base, examples: ['  '] }), 'examples');
    assert.equal(campo({ ...base, headerText: 'Olá {{1}}' }), 'headerText');
    assert.equal(campo({ ...base, footerText: 'x'.repeat(61) }), 'footerText');
    const botao = { type: 'QUICK_REPLY', text: 'Ok' };
    assert.equal(campo({ ...base, buttons: [botao, botao, botao, botao] }), 'buttons');
    assert.equal(campo({ ...base, buttons: [{ type: 'URL', text: 'Pagar', url: 'http://inseguro.test' }] }), 'buttons');
    assert.equal(campo({ ...base, buttons: [{ type: 'PHONE_NUMBER', text: 'Ligar' }] }), 'buttons');
    assert.equal(campo({ ...base, buttons: [{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }] }), 'buttons');
    assert.equal(campo({ ...base, footerText: 'x'.repeat(60), buttons: [botao] }), null);
  });
});
