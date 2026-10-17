import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { limparTextoDoModelo, promptDeModelo, variaveisForaDaLista } = await import('../src/utils/wa/waModeloIa.js');

/**
 * "Escrever com IA" nos modelos: o texto volta como rascunho, só com as
 * variáveis da categoria, e nada é gravado.
 */

const AI_KEY = 'chave-ia-modelos-123';
let panelUrl;
let token;
let aiServer;
let aiUrl;
let roteiro = [];
let pedidos = [];

const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });
const rascunho = (body) => api('/templates/ai-draft', { method: 'POST', body });

before(async () => {
  ({ panelUrl } = await startTestServers());
  aiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      pedidos.push(JSON.parse(raw || '{}'));
      const proximo = roteiro.shift() ?? 'Olá {{primeiro_nome}}!';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: proximo } }] }));
    });
  });
  aiUrl = await new Promise((resolve) => {
    aiServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${aiServer.address().port}/api/paas/v4`));
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  await new Promise((resolve) => aiServer.close(resolve));
  await stopTestServers();
});

beforeEach(() => {
  roteiro = [];
  pedidos = [];
});

describe('as funções puras', () => {
  const GERAL = ['nome', 'primeiro_nome', 'contrato', 'plano', 'valor'];

  it('o prompt lista só as variáveis da categoria', () => {
    const prompt = promptDeModelo({ empresa: 'Fibra X', categoria: 'atendimento', variaveis: ['nome', 'primeiro_nome', 'contrato', 'atendente'], tom: 'formal' });
    assert.match(prompt, /Fibra X/);
    assert.match(prompt, /\{\{atendente\}\}/);
    assert.doesNotMatch(prompt, /\{\{pix\}\}/);
    assert.match(prompt, /formal/);
  });

  it('limpa cerca de código, aspas e markdown, e tira a variável que não existe', () => {
    const { texto, removidas } = limparTextoDoModelo('```\n"Oi {{nome}}, sua {{fatura_x}} vence. **Pague** hoje."\n```', GERAL);
    assert.equal(texto, 'Oi {{nome}}, sua vence. *Pague* hoje.');
    assert.deepEqual(removidas, ['fatura_x']);
  });

  it('aponta o texto que cita os dois espelhos', () => {
    const { espelhos } = limparTextoDoModelo('{{dias_atraso}} e {{dias_para_vencer}}', ['dias_atraso', 'dias_para_vencer']);
    assert.equal(espelhos, true);
  });

  it('acha as variáveis fora da lista', () => {
    assert.deepEqual(variaveisForaDaLista('{{nome}} {{x}} {{x}} {{y}}', ['nome']), ['x', 'y']);
  });
});

describe('POST /templates/ai-draft', () => {
  it('sem IA configurada: 409 ai_key_required', async () => {
    const { status, body } = await rascunho({ category: 'geral', goal: 'avisar da promoção' });
    assert.equal(status, 409);
    assert.equal(body.code, 'ai_key_required');
    assert.equal(pedidos.length, 0);
  });

  it('o status mostra se a IA dos modelos está disponível', async () => {
    assert.equal((await api('/ai/status')).body.data.templates, false);
    const ok = await api('/bot-config', { method: 'PUT', body: { ai: { enabled: false, suggest: true, baseUrl: aiUrl, apiKey: AI_KEY, model: 'glm-4.5-flash' } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await api('/ai/status')).body.data.templates, true);
  });

  it('escreve do zero com as variáveis da categoria, e não grava nada', async () => {
    roteiro = ['Oi {{primeiro_nome}}, quem indicar um amigo ganha uma mensalidade grátis!'];
    const antes = await getDb()('wa_templates').count({ n: '*' }).first();
    const { status, body } = await rascunho({ category: 'geral', goal: 'avisar da indicação premiada', tone: 'amigavel' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.text, 'Oi {{primeiro_nome}}, quem indicar um amigo ganha uma mensalidade grátis!');
    assert.deepEqual(body.data.warnings, { removed: [], mirrors: false });
    const depois = await getDb()('wa_templates').count({ n: '*' }).first();
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(pedidos.length, 1);
    assert.match(pedidos[0].messages[0].content, /\{\{primeiro_nome\}\}/);
    assert.match(pedidos[0].messages[1].content, /indicação premiada/);
  });

  it('variável inventada: segunda tentativa com a correção, e o texto certo passa', async () => {
    roteiro = ['Oi {{cliente}}!', 'Oi {{nome}}!'];
    const { body } = await rascunho({ category: 'atendimento', goal: 'saudar' });
    assert.equal(body.data.text, 'Oi {{nome}}!');
    assert.equal(pedidos.length, 2);
    assert.match(pedidos[1].messages.at(-1).content, /\{\{cliente\}\}/);
    assert.deepEqual(body.data.warnings.removed, []);
  });

  it('se a segunda tentativa também erra, a variável sai e o aviso diz qual', async () => {
    roteiro = ['Oi {{cliente}}, tudo bem?', 'Oi {{cliente}}, tudo bem?'];
    const { body } = await rascunho({ category: 'atendimento', goal: 'saudar' });
    assert.equal(body.data.text, 'Oi, tudo bem?');
    assert.deepEqual(body.data.warnings.removed, ['cliente']);
  });

  it('com texto na caixa, pede para melhorar mantendo as variáveis', async () => {
    roteiro = ['Olá {{nome}}, sua fatura de {{valor}} vence em {{vencimento}}.'];
    const { body } = await rascunho({ category: 'cobranca', current: 'ola {{nome}} sua fatura {{valor}} vence {{vencimento}}', tone: 'formal' });
    assert.equal(body.data.text, 'Olá {{nome}}, sua fatura de {{valor}} vence em {{vencimento}}.');
    assert.match(pedidos[0].messages[1].content, /Melhore o texto/);
    assert.match(pedidos[0].messages[1].content, /ola \{\{nome\}\}/);
  });

  it('sem objetivo e sem texto: 400', async () => {
    const { status, body } = await rascunho({ category: 'geral', goal: '   ', current: '' });
    assert.equal(status, 400);
    assert.equal(body.code, 'ai_draft_goal');
  });

  it('vai para a Trilha sem o texto', async () => {
    roteiro = ['Oi {{nome}}!'];
    await rascunho({ category: 'atendimento', goal: 'saudar com segredo-no-pedido' });
    const linhas = await getDb()('audit_log').where({ action: 'whatsapp.template_ai_draft' });
    assert.ok(linhas.length >= 1);
    assert.equal(JSON.stringify(linhas).includes('segredo-no-pedido'), false);
    assert.equal(JSON.stringify(linhas).includes('Oi {{nome}}'), false);
  });

  it('quem só lê não gera rascunho (a IA é paga por uso)', async () => {
    const sem = await call(`${panelUrl}/api/whatsapp/templates/ai-draft`, { method: 'POST', body: { category: 'geral', goal: 'x' } });
    assert.equal(sem.status, 401);
  });
});
