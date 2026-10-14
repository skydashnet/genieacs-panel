import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { toAnthropicMessages, AI_ADAPTERS } = await import('../src/services/waAiAdapters.js');
const { default: WaAiClient } = await import('../src/services/waAiClient.js');

describe('Claude (Anthropic): conversão de mensagens', () => {
  it('system vira campo próprio e turnos do mesmo papel se fundem', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'Seja breve.' },
      { role: 'user', content: 'oi' },
      { role: 'user', content: 'tem alguém?' }
    ]);
    assert.equal(system, 'Seja breve.');
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].content.map((b) => b.text), ['oi', 'tem alguém?']);
  });

  it('tool_calls viram tool_use e a resposta da ferramenta vira tool_result num turno user', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'minha fatura' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'consultar_fatura', arguments: '{"a":1}' } }]
      },
      { role: 'tool', tool_call_id: 't1', content: 'R$ 99' }
    ]);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(messages[1].content[0], { type: 'tool_use', id: 't1', name: 'consultar_fatura', input: { a: 1 } });
    assert.deepEqual(messages[2].content[0], { type: 'tool_result', tool_use_id: 't1', content: 'R$ 99' });
  });

  it('a resposta com tool_use volta no formato interno', () => {
    const r = AI_ADAPTERS.anthropic.parse({
      content: [{ type: 'text', text: 'Um instante' }, { type: 'tool_use', id: 'x', name: 'identificar_cliente', input: { doc: '1' } }]
    });
    assert.equal(r.content, 'Um instante');
    assert.deepEqual(r.toolCalls, [{ id: 'x', name: 'identificar_cliente', arguments: { doc: '1' } }]);
    assert.equal(r.message.tool_calls[0].function.arguments, '{"doc":"1"}');
  });
});

describe('Claude (Anthropic): cliente HTTP', () => {
  let server;
  let url;
  let visto;
  let recusa = null;
  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        visto = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
        res.writeHead(recusa?.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(recusa?.body ?? { content: [{ type: 'text', text: 'OK' }] }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it('chama /v1/messages com x-api-key e a versão', async () => {
    const r = await WaAiClient.chat({
      provider: 'anthropic', baseUrl: url, apiKey: 'sk-ant-teste', model: 'claude-sonnet-5-5',
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'oi' }]
    });
    assert.equal(r.content, 'OK');
    assert.equal(visto.url, '/v1/messages');
    assert.equal(visto.headers['x-api-key'], 'sk-ant-teste');
    assert.equal(visto.headers['anthropic-version'], '2023-06-01');
    assert.equal(visto.headers.authorization, undefined);
    assert.equal(visto.body.system, 'S');
    assert.equal(visto.body.model, 'claude-sonnet-5-5');
  });

  it('mapeia 401, saldo e 529', async () => {
    const caso = async (status, body) => {
      recusa = { status, body };
      try {
        await WaAiClient.chat({ provider: 'anthropic', baseUrl: url, apiKey: 'k', messages: [{ role: 'user', content: 'oi' }] });
      } catch (e) {
        return e.code;
      } finally {
        recusa = null;
      }
      return null;
    };
    assert.equal(await caso(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 'ai_unauthorized');
    assert.equal(await caso(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }), 'ai_no_balance');
    assert.equal(await caso(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 'ai_rate_limited');
  });
});
