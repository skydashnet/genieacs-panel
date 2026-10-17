/**
 * Modelos da Meta com cabeçalho de mídia e botão de URL dinâmica: a leitura do
 * que a Meta devolve, os componentes do envio e a limpeza do que vai na fila.
 * Só peças puras — o fluxo inteiro está em `whatsapp-meta-templates-media`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMetaButtons,
  normalizeMetaHeader,
  readMetaTemplates,
  sanitizeMetaFilename,
  sanitizeMetaLink,
  sendTemplateRequest
} from '../src/utils/wa/evolutionApi.js';

const { normalizeMetaTemplate } = await import('../src/services/waSendService.js');
const { metaFilename } = await import('../src/services/waMetaTemplateService.js');

const modelo = (name, components, extra = {}) => ({
  id: name, name, language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components, ...extra
});

describe('leitura: cabeçalho e botões', () => {
  const lidos = readMetaTemplates([
    modelo('boleto_doc', [
      { type: 'HEADER', format: 'DOCUMENT' },
      { type: 'BODY', text: 'Olá {{1}}, segue o boleto.' },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'Já paguei' },
        { type: 'URL', text: 'Pagar', url: 'https://pagar.provedor.test/f/{{1}}' }
      ] }
    ]),
    modelo('promo_video', [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Veja' }]),
    modelo('cabecalho_texto', [{ type: 'HEADER', format: 'TEXT', text: 'Oi {{1}}' }, { type: 'BODY', text: 'x' }]),
    modelo('local', [{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'x' }]),
    modelo('dois_botoes', [
      { type: 'BODY', text: 'x' },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', url: 'https://a.test/{{1}}' },
        { type: 'URL', url: 'https://b.test/{{1}}' }
      ] }
    ]),
    modelo('meio_da_url', [
      { type: 'BODY', text: 'x' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://a.test/{{1}}/fim' }] }
    ]),
    modelo('cabecalho_nomeado', [{ type: 'HEADER', format: 'TEXT', text: 'Oi {{nome}}' }, { type: 'BODY', text: 'x' }])
  ]);
  const por = Object.fromEntries(lidos.map((m) => [m.name, m]));

  test('documento no cabeçalho e botão de URL com {{1}} no fim são suportados', () => {
    const m = por.boleto_doc;
    assert.equal(m.supported, true);
    assert.equal(m.headerFormat, 'DOCUMENT');
    assert.equal(m.headerParamCount, 0);
    assert.deepEqual(m.buttons, [
      { index: 0, type: 'QUICK_REPLY', urlHasParam: false },
      { index: 1, type: 'URL', urlHasParam: true }
    ]);
    assert.equal(por.promo_video.supported, true);
  });

  test('cabeçalho de texto com uma variável entra, e conta a variável', () => {
    assert.equal(por.cabecalho_texto.supported, true);
    assert.equal(por.cabecalho_texto.headerFormat, 'TEXT');
    assert.equal(por.cabecalho_texto.headerParamCount, 1);
  });

  test('LOCATION, dois botões dinâmicos, sufixo no meio da URL e variável nomeada ficam fora', () => {
    assert.equal(por.local.headerFormat, 'LOCATION');
    assert.equal(por.local.supported, false);
    assert.equal(por.dois_botoes.supported, false);
    assert.equal(por.meio_da_url.supported, false);
    assert.equal(por.cabecalho_nomeado.supported, false);
    assert.equal(por.cabecalho_nomeado.paramFormat, 'named');
  });
});

describe('envio: os componentes da Cloud API', () => {
  test('documento com nome, corpo e botão, nessa ordem', () => {
    const r = sendTemplateRequest('inst', '559', {
      name: 'boleto_doc',
      language: 'pt_BR',
      params: ['Maria'],
      header: { type: 'document', link: 'https://x.test/b.pdf', filename: 'boleto.pdf' },
      buttons: [{ index: 1, param: 'abc123' }]
    });
    assert.deepEqual(r.body.components, [
      { type: 'header', parameters: [{ type: 'document', document: { link: 'https://x.test/b.pdf', filename: 'boleto.pdf' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'abc123' }] }
    ]);
  });

  test('imagem e vídeo vão só com o link; texto com a variável', () => {
    const img = sendTemplateRequest('i', '5', { name: 'a', language: 'pt_BR', params: [], header: { type: 'image', link: 'https://x.test/a.png', filename: 'ignorado' } });
    assert.deepEqual(img.body.components, [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.test/a.png' } }] }]);
    const vid = sendTemplateRequest('i', '5', { name: 'a', language: 'pt_BR', params: [], header: { type: 'video', link: 'https://x.test/a.mp4' } });
    assert.deepEqual(vid.body.components[0].parameters, [{ type: 'video', video: { link: 'https://x.test/a.mp4' } }]);
    const txt = sendTemplateRequest('i', '5', { name: 'a', language: 'pt_BR', params: [], header: { type: 'text', params: ['Ana'] } });
    assert.deepEqual(txt.body.components, [{ type: 'header', parameters: [{ type: 'text', text: 'Ana' }] }]);
  });

  test('cabeçalho de anexo ainda não resolvido não sai', () => {
    const r = sendTemplateRequest('i', '5', { name: 'a', language: 'pt_BR', params: [], header: { type: 'document', source: 'attachment' } });
    assert.deepEqual(r.body.components, []);
  });
});

describe('limpeza do que vai na fila', () => {
  test('link só https, sem credencial embutida', () => {
    assert.equal(sanitizeMetaLink('https://x.test/a.pdf'), 'https://x.test/a.pdf');
    assert.equal(sanitizeMetaLink('http://x.test/a.pdf'), null);
    assert.equal(sanitizeMetaLink('javascript:alert(1)'), null);
    assert.equal(sanitizeMetaLink('https://user:pw@x.test/a'), null);
    assert.equal(sanitizeMetaLink(`https://x.test/${'a'.repeat(2000)}`), null);
    assert.equal(sanitizeMetaLink(''), null);
  });

  test('nome de arquivo curto, sem caminho e sem controle, mantendo a extensão', () => {
    assert.equal(sanitizeMetaFilename('../../etc/boleto.pdf'), 'boleto.pdf');
    assert.equal(sanitizeMetaFilename('a\u0000b\n.pdf'), 'ab.pdf');
    const longo = sanitizeMetaFilename(`${'x'.repeat(200)}.pdf`);
    assert.equal(longo.length, 80);
    assert.ok(longo.endsWith('.pdf'));
  });

  test('cabeçalho e botões normalizados; o inválido some', () => {
    assert.deepEqual(normalizeMetaHeader({ type: 'DOCUMENT', link: 'https://x.test/b', filename: 'dir/b.pdf' }),
      { type: 'document', link: 'https://x.test/b', filename: 'b.pdf' });
    assert.deepEqual(normalizeMetaHeader({ type: 'image', link: 'https://x.test/a.png', filename: 'x' }),
      { type: 'image', link: 'https://x.test/a.png' });
    assert.deepEqual(normalizeMetaHeader({ type: 'video', source: 'attachment', link: 'qualquer' }),
      { type: 'video', source: 'attachment' });
    assert.equal(normalizeMetaHeader({ type: 'image', link: 'http://x.test/a.png' }), null);
    assert.equal(normalizeMetaHeader({ type: 'location' }), null);
    assert.deepEqual(normalizeMetaHeader({ type: 'text', params: ['a\nb', 'extra'] }), { type: 'text', params: ['a · b'] });
    assert.equal(normalizeMetaHeader({ type: 'text', params: [''] }), null);
    assert.deepEqual(
      normalizeMetaButtons([{ index: 1, param: 'b' }, { index: 0, param: 'a' }, { index: 1, param: 'dup' }, { index: 12, param: 'x' }, { index: 2, param: '' }]),
      [{ index: 0, param: 'a' }, { index: 1, param: 'b' }]
    );
  });

  test('o modelo da fila só leva cabeçalho e botões quando há', () => {
    assert.deepEqual(normalizeMetaTemplate({ name: 'a', language: 'pt_BR', params: ['x'] }), { name: 'a', language: 'pt_BR', params: ['x'] });
    assert.deepEqual(
      normalizeMetaTemplate({
        name: 'a', language: 'pt_BR', params: [],
        header: { type: 'document', link: 'https://x.test/f.pdf' }, buttons: [{ index: 0, param: 'z' }]
      }),
      { name: 'a', language: 'pt_BR', params: [], header: { type: 'document', link: 'https://x.test/f.pdf' }, buttons: [{ index: 0, param: 'z' }] }
    );
  });

  test('o nome do documento vem do link ou da variável', () => {
    assert.equal(metaFilename('link_boleto', 'https://x.test/boleto/123'), 'boleto.pdf');
    assert.equal(metaFilename('link_boleto', 'https://x.test/f/fatura-10.pdf'), 'fatura-10.pdf');
    assert.equal(metaFilename('', 'https://x.test/'), 'documento.pdf');
  });
});
