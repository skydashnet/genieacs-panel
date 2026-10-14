import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  asTenant,
  authHeaders,
  call,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');

/**
 * O atendimento por IA: a IA fala dentro das travas do bot, só sabe da conta
 * pelas ferramentas, e o código de pagamento sai do SGP sem passar por ela.
 */

const INSTANCE = 'painel-ia';
const WEBHOOK_TOKEN = 'segredo-webhook-ia';
const APP = 'painel';
const SGP_TOKEN = 'token-sgp-ia';
const AI_KEY = 'chave-zai-secreta-123';
const DEVICE_ID = 'ia-device-1';
const CONTRACT = '8800';
const ASSINANTE = '5593981140001';
const DESCONHECIDO = '5593981149999';
const DOC = '52998224725';
const PIX = '00020126580014BR.GOV.BCB.PIX0136ia-teste-chave-pix5204000053039865802BR';
const SENHA_WIFI = 'senha-wifi-que-nunca-sai';

let panelUrl;
let token;
let genie;
let sgpServer;
let aiServer;
let aiUrl;
/** O que a IA de mentira responde, em ordem; e o que ela recebeu. */
let roteiro = [];
let pedidosIa = [];
let iaFora = false;
/** Uma recusa programada: `{ status, body }` que a IA de mentira devolve. */
let recusa = null;

function ontDoTeste() {
  const device = buildDevice({ id: DEVICE_ID, ssid: 'CLIENTE-IA' });
  device.VirtualParameters.OpticalRXPower = { _value: -21.5, _writable: false, _timestamp: '2026-09-01T00:00:00.000Z' };
  const wlan = device.InternetGatewayDevice.LANDevice[1].WLANConfiguration;
  wlan[1].PreSharedKey[1].KeyPassphrase._value = SENHA_WIFI;
  return device;
}

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== SGP_TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/consultacliente')) {
        if (payload.cpfcnpj === DOC || payload.contrato === '9100') {
          return send({ status: 1, contratos: [{ contratoId: '9100', cpfcnpj: DOC, razaoSocial: 'Ana', contratoStatusDisplay: 'Ativo' }] });
        }
        return send({ status: 0, msg: 'Cliente não encontrado' });
      }
      if (req.url.startsWith('/api/ura/titulos')) {
        return send({ status: 1, titulos: [{ numerodocumento: 'IA1', valor: '99,90', vencimento: '10/10/2026', status: 'Em aberto', pix: PIX }] });
      }
      res.writeHead(404);
      return res.end('{}');
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

/** A lista de mensagens que a z.ai recusa com 1214. */
function formaIlegal(messages = []) {
  const conversa = messages.filter((m) => m.role !== 'system');
  if (!conversa.length || conversa[0].role !== 'user') return true;
  if (!['user', 'tool'].includes(conversa.at(-1).role)) return true;
  return conversa.some((m, i) => i > 0 && conversa[i - 1].role === m.role && m.role !== 'tool');
}

/** Uma API compatível com OpenAI: devolve o próximo item do roteiro. */
function startAiStub() {
  aiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      pedidosIa.push({ url: req.url, auth: req.headers.authorization, payload });
      // As regras da z.ai para a lista de mensagens: abre e fecha com `user`, e
      // não repete o papel em turnos seguidos. O resto é 400 · 1214.
      if (formaIlegal(payload.messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: '1214', message: 'The messages parameter is illegal. Please check the documentation.' } }));
      }
      if (recusa) {
        res.writeHead(recusa.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(recusa.body));
      }
      if (iaFora) {
        res.writeHead(500);
        return res.end('{}');
      }
      if (req.headers.authorization !== `Bearer ${AI_KEY}`) {
        res.writeHead(401);
        return res.end('{}');
      }
      const proximo = roteiro.shift() ?? { content: 'Posso ajudar em algo mais?' };
      const message = proximo.tool
        ? { role: 'assistant', content: proximo.content ?? '', tool_calls: [{ id: `c${pedidosIa.length}`, type: 'function', function: { name: proximo.tool, arguments: JSON.stringify(proximo.args || {}) } }] }
        : { role: 'assistant', content: proximo.content };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => {
    aiServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${aiServer.address().port}/api/paas/v4`));
  });
}

let ids = 0;
async function receber(telefone, texto) {
  ids += 1;
  await call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, {
    method: 'POST',
    body: {
      event: 'messages.upsert',
      instance: INSTANCE,
      data: {
        key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id: `IA-${ids}` },
        pushName: 'Cliente',
        message: { conversation: texto },
        messageType: 'conversation',
        messageTimestamp: 1739990000
      }
    }
  });
}

const conversaDe = (telefone) => getDb()('wa_conversations').where({ wa_phone_e164: telefone }).first();
async function respostas(telefone) {
  const conversa = await conversaDe(telefone);
  if (!conversa) return [];
  return getDb()('wa_messages').where({ conversation_id: conversa.id, direction: 'out', is_note: false })
    .whereNull('external_id').orderBy('id').pluck('body');
}
async function limparFio(telefone) {
  const conversa = await conversaDe(telefone);
  if (!conversa) return;
  await getDb()('wa_messages').where({ conversation_id: conversa.id }).del();
  await getDb()('wa_conversations').where({ id: conversa.id }).del();
}
const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });
const salvarIa = (ai) => api('/bot-config', { method: 'PUT', body: { ai } });

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [ontDoTeste()] });
  const sgpUrl = await startSgpStub();
  aiUrl = await startAiStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona', password: 'dona-senha-123', email: 'dona@exemplo.test' }
  });
  token = setup.body.data.token;
  await call(`${panelUrl}/api/settings/genieAcsUrl`, { method: 'PUT', headers: authHeaders(token), body: { value: genie.url } });
  await call(`${panelUrl}/api/sgp/config`, {
    method: 'PUT', headers: authHeaders(token),
    body: { enabled: true, baseUrl: sgpUrl, app: APP, token: SGP_TOKEN, linkMode: 'pppoe' }
  });
  await asTenant(() => WhatsAppConfigService.saveConfig({ webhookBaseUrl: 'https://painel.provedor.example/api/whatsapp-webhook' }));
  await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE, purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.com.br',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia-ia'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  await insertReturningId('sgp_links', {
    device_id: DEVICE_ID, contract: CONTRACT, client_name: 'João', document: '12345678909',
    login: 'joao@ia', state: 'active', link_mode: 'manual', phone_e164: ASSINANTE
  });
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await new Promise((resolve) => aiServer.close(resolve));
  await genie.close();
  await stopTestServers();
});

beforeEach(() => {
  roteiro = [];
  pedidosIa = [];
  iaFora = false;
  recusa = null;
});

describe('a configuração da IA', () => {
  it('não liga sem chave, e a chave nunca volta', async () => {
    const semChave = await salvarIa({ enabled: true, baseUrl: aiUrl });
    assert.equal(semChave.status, 400);
    assert.equal(semChave.body.code, 'ai_key_required');

    const ok = await salvarIa({
      enabled: true, suggest: true, baseUrl: aiUrl, apiKey: AI_KEY, model: 'glm-4.5-flash',
      instructions: 'Plano 500 mega custa R$ 99,90.'
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const lido = await api('/bot-config');
    assert.equal(lido.body.data.ai.hasApiKey, true);
    assert.equal(lido.body.data.ai.keyHint, AI_KEY.slice(-4), 'só o fim da chave, para conferir');
    assert.equal(JSON.stringify(lido.body.data).includes(AI_KEY), false, 'a chave não sai do servidor');
    const guardado = await asTenant(() => getDb()('app_state').where({ key: 'wa_bot_config' }).first());
    assert.equal(String(guardado.value).includes(AI_KEY), false, 'guardada cifrada');
  });

  it('testar a conexão usa a chave salva', async () => {
    roteiro = [{ content: 'OK' }];
    const res = await api('/bot-config/ai-test', { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.reply, 'OK');
    assert.equal(pedidosIa[0].auth, `Bearer ${AI_KEY}`);
    assert.equal(pedidosIa[0].url, '/api/paas/v4/chat/completions');
  });

  it('testar outro endereço sem chave: 400, e nenhum pedido sai com a chave salva', async () => {
    const outro = aiUrl.replace('/api/paas/v4', '/outro');
    const res = await api('/bot-config/ai-test', { method: 'POST', body: { baseUrl: outro } });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'ai_key_required_for_new_url');
    assert.equal(pedidosIa.length, 0, 'nenhum pedido saiu');
  });

  it('trocar de provedor sem chave nova é recusado; provedor desconhecido também', async () => {
    const sem = await salvarIa({ provider: 'anthropic' });
    assert.equal(sem.status, 400, JSON.stringify(sem.body));
    assert.equal(sem.body.code, 'ai_key_required_for_new_url');
    const teste = await api('/bot-config/ai-test', { method: 'POST', body: { provider: 'anthropic' } });
    assert.equal(teste.body.code, 'ai_key_required_for_new_url');
    assert.equal(pedidosIa.length, 0, 'a chave salva não saiu para outro serviço');
    const invalido = await salvarIa({ provider: 'nao-existe', apiKey: 'x' });
    assert.equal(invalido.status, 400, JSON.stringify(invalido.body));
    const lido = await api('/bot-config');
    assert.equal(lido.body.data.ai.provider, 'openai-compatible', 'config legada segue no padrão');
  });

  it('o mesmo endereço, escrito de outro jeito, usa a chave salva', async () => {
    roteiro = [{ content: 'OK' }];
    const res = await api('/bot-config/ai-test', {
      method: 'POST', body: { baseUrl: `${aiUrl.replace('http://', 'HTTP://')}/` }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(pedidosIa[0].auth, `Bearer ${AI_KEY}`);
  });

  it('outro endereço com a chave da tela: vai só a chave da tela', async () => {
    const outro = aiUrl.replace('/api/paas/v4', '/outro');
    const res = await api('/bot-config/ai-test', { method: 'POST', body: { baseUrl: outro, apiKey: 'chave-da-tela' } });
    assert.equal(res.body.code, 'ai_unauthorized', JSON.stringify(res.body));
    assert.equal(pedidosIa.length, 1);
    assert.equal(pedidosIa[0].url, '/outro/chat/completions');
    assert.equal(pedidosIa[0].auth, 'Bearer chave-da-tela');
  });

  it('salvar outro endereço sem chave é recusado; com chave, aceito', async () => {
    const outro = aiUrl.replace('/api/paas/v4', '/outro');
    const semChave = await salvarIa({ baseUrl: outro });
    assert.equal(semChave.status, 400, JSON.stringify(semChave.body));
    assert.equal(semChave.body.code, 'ai_key_required_for_new_url');
    assert.equal((await api('/bot-config')).body.data.ai.baseUrl, aiUrl, 'o endereço não mudou');

    const mesmo = await salvarIa({ baseUrl: `${aiUrl}/` });
    assert.equal(mesmo.status, 200, JSON.stringify(mesmo.body));

    const comChave = await salvarIa({ baseUrl: outro, apiKey: AI_KEY });
    assert.equal(comChave.status, 200, JSON.stringify(comChave.body));
    assert.equal(comChave.body.data.ai.baseUrl, outro);

    // De volta ao endereço de verdade para os testes seguintes.
    const volta = await salvarIa({ baseUrl: aiUrl, apiKey: AI_KEY });
    assert.equal(volta.status, 200, JSON.stringify(volta.body));
  });
});

describe('o motivo da recusa', () => {
  it('chave recusada: a tela recebe o que o provedor disse, sem a chave', async () => {
    recusa = { status: 401, body: { error: { code: '1000', message: `Authentication failed for ${AI_KEY}` } } };
    const res = await api('/bot-config/ai-test', { method: 'POST', body: {} });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'ai_unauthorized');
    assert.match(res.body.message, /HTTP 401 · 1000: Authentication failed/);
    assert.equal(JSON.stringify(res.body).includes(AI_KEY), false);
  });

  it('sem saldo é outra coisa que limite de uso', async () => {
    recusa = { status: 429, body: { error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' } } };
    const res = await api('/bot-config/ai-test', { method: 'POST', body: {} });
    assert.equal(res.body.code, 'ai_no_balance');
    recusa = { status: 429, body: { error: { code: '1302', message: 'High concurrency' } } };
    assert.equal((await api('/bot-config/ai-test', { method: 'POST', body: {} })).body.code, 'ai_rate_limited');
  });

  it('a falha no atendimento fica com o motivo para a tela', async () => {
    await limparFio(ASSINANTE);
    recusa = { status: 401, body: { error: { code: '1000', message: 'Authentication failed' } } };
    await receber(ASSINANTE, 'oi');
    const lido = await api('/bot-config');
    assert.equal(lido.body.data.ai.lastError.code, 'ai_unauthorized');
    assert.match(lido.body.data.ai.lastError.detail, /HTTP 401/);
  });
});

describe('a IA atendendo', () => {
  it('responde com o texto da IA, com histórico e instruções da empresa no pedido', async () => {
    await limparFio(ASSINANTE);
    roteiro = [{ content: 'O plano de 500 mega custa R$ 99,90 por mês.' }];
    await receber(ASSINANTE, 'quanto custa o plano de 500 mega?');
    assert.deepEqual(await respostas(ASSINANTE), ['O plano de 500 mega custa R$ 99,90 por mês.']);
    const { payload } = pedidosIa[0];
    assert.equal(payload.model, 'glm-4.5-flash');
    assert.match(payload.messages[0].content, /Plano 500 mega custa R\$ 99,90/);
    assert.match(payload.messages[0].content, new RegExp(`contrato ${CONTRACT}`));
    assert.equal(payload.messages.at(-1).content, 'quanto custa o plano de 500 mega?');
    const nomes = payload.tools.map((t) => t.function.name);
    assert.ok(nomes.includes('consultar_fatura'));
    assert.ok(!nomes.includes('identificar_cliente'), 'já identificado');
    assert.ok(!nomes.includes('liberar_em_confianca'), 'liberação desligada não é oferecida');
    const origem = await getDb()('wa_messages').where({ direction: 'out' }).orderBy('id', 'desc').first('source');
    assert.equal(origem.source, 'bot');
  });

  it('a fatura: o texto da IA e o PIX literal do SGP', async () => {
    await limparFio(ASSINANTE);
    roteiro = [{ tool: 'consultar_fatura' }, { content: 'Encontrei sua fatura de R$ 99,90, os dados estão logo abaixo.' }];
    await receber(ASSINANTE, 'me manda a fatura');
    const [resposta] = await respostas(ASSINANTE);
    assert.match(resposta, /^Encontrei sua fatura/);
    assert.ok(resposta.includes(PIX), 'o PIX sai exatamente como o SGP mandou');
    // A segunda volta levou o resultado da ferramenta.
    assert.equal(pedidosIa[1].payload.messages.at(-1).role, 'tool');
  });

  it('a conexão: o sinal da ONT, e nunca a senha do Wi-Fi', async () => {
    await limparFio(ASSINANTE);
    roteiro = [{ tool: 'consultar_conexao' }, { content: 'Seu equipamento está online, com sinal bom.' }];
    await receber(ASSINANTE, 'minha internet está lenta');
    assert.match(pedidosIa[1].payload.messages.at(-1).content, /-21\.5/);
    assert.equal(JSON.stringify(pedidosIa).includes(SENHA_WIFI), false);
    assert.equal((await respostas(ASSINANTE)).join(' ').includes(SENHA_WIFI), false);
  });

  it('transferir: pausa o bot e manda a passagem', async () => {
    await limparFio(ASSINANTE);
    roteiro = [{ tool: 'transferir_para_atendente', args: { motivo: 'reclamação' } }];
    await receber(ASSINANTE, 'quero falar com uma pessoa');
    const conversa = await conversaDe(ASSINANTE);
    assert.ok(new Date(conversa.bot_paused_until).getTime() > Date.now());
    assert.equal((await respostas(ASSINANTE)).length, 1);
    const evento = await getDb()('wa_bot_events').where({ conversation_id: conversa.id }).orderBy('id', 'desc').first();
    assert.equal(evento.intent, 'atendente');

    // Pausado: a IA nem é chamada.
    pedidosIa = [];
    await receber(ASSINANTE, 'alô?');
    assert.equal(pedidosIa.length, 0);
  });

  it('identifica pelo CPF quem o cadastro não conhece', async () => {
    await limparFio(DESCONHECIDO);
    roteiro = [{ tool: 'identificar_cliente', args: { documento: DOC } }, { content: 'Pronto, encontrei seu cadastro.' }];
    await receber(DESCONHECIDO, `meu cpf é ${DOC}`);
    const conversa = await conversaDe(DESCONHECIDO);
    assert.equal(conversa.contract, '9100');
    assert.ok(pedidosIa[0].payload.tools.some((t) => t.function.name === 'identificar_cliente'));
    assert.deepEqual(await respostas(DESCONHECIDO), ['Pronto, encontrei seu cadastro.']);
  });

  it('pedido de senha: a resposta fixa, sem chamar a IA', async () => {
    await limparFio(ASSINANTE);
    await receber(ASSINANTE, 'qual a senha do wifi');
    assert.equal(pedidosIa.length, 0);
    assert.equal((await respostas(ASSINANTE)).length, 1);
  });

  it('IA fora do ar: o cliente recebe o menu e a tela vê o erro', async () => {
    await limparFio(ASSINANTE);
    iaFora = true;
    await receber(ASSINANTE, 'oi');
    const [resposta] = await respostas(ASSINANTE);
    assert.ok(resposta, 'o cliente não fica sem resposta');
    const lido = await api('/bot-config');
    assert.equal(lido.body.data.ai.lastError.code, 'ai_bad_response');
  });
});

describe('sugerir resposta ao atendente', () => {
  it('devolve o rascunho e não grava mensagem', async () => {
    await limparFio(ASSINANTE);
    roteiro = [{ content: 'Oi! Me conta o que aconteceu?' }];
    await receber(ASSINANTE, 'oi');
    const conversa = await conversaDe(ASSINANTE);
    const antes = (await getDb()('wa_messages').where({ conversation_id: conversa.id })).length;

    roteiro = [{ content: 'Olá João, vou verificar sua conexão agora.' }];
    pedidosIa = [];
    const res = await api(`/conversations/${conversa.id}/suggest-reply`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.text, 'Olá João, vou verificar sua conexão agora.');
    const nomes = pedidosIa[0].payload.tools.map((t) => t.function.name);
    assert.ok(!nomes.includes('transferir_para_atendente') && !nomes.includes('liberar_em_confianca'), 'só leitura');
    assert.equal((await getDb()('wa_messages').where({ conversation_id: conversa.id })).length, antes);

    const status = await api('/ai/status');
    assert.equal(status.body.data.suggest, true);
  });

  it('conversa em que só a equipe falou (a cobrança da régua): o rascunho sai, com a lista que a z.ai aceita', async () => {
    await salvarIa({ enabled: true, suggest: true });
    await asTenant(() => WaBotConfigService.invalidate());
    await limparFio(ASSINANTE);
    await receber(ASSINANTE, 'oi');
    const conversa = await conversaDe(ASSINANTE);
    await getDb()('wa_messages').where({ conversation_id: conversa.id }).del();
    await getDb()('wa_messages').insert([
      { tenant_id: 1, conversation_id: conversa.id, direction: 'out', body: 'Sua fatura vence hoje.', source: 'campaign' },
      { tenant_id: 1, conversation_id: conversa.id, direction: 'out', body: 'Segue o boleto.', source: 'campaign' }
    ]);
    roteiro = [{ content: 'Olá! Conseguiu pagar a fatura?' }];
    pedidosIa = [];
    const res = await api(`/conversations/${conversa.id}/suggest-reply`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.text, 'Olá! Conseguiu pagar a fatura?');
    const enviadas = pedidosIa[0].payload.messages.filter((m) => m.role !== 'system');
    assert.equal(enviadas.length, 1, 'as duas da equipe viram uma só, e a instrução fecha com user');
    assert.equal(enviadas[0].role, 'user');
  });

  it('o cliente mandou só uma imagem (o comprovante): ela entra como contexto, e o rascunho sai', async () => {
    await limparFio(ASSINANTE);
    await receber(ASSINANTE, 'oi');
    const conversa = await conversaDe(ASSINANTE);
    await getDb()('wa_messages').where({ conversation_id: conversa.id }).del();
    await getDb()('wa_messages').insert([
      { tenant_id: 1, conversation_id: conversa.id, direction: 'out', body: 'Sua fatura vence hoje.', source: 'campaign' },
      { tenant_id: 1, conversation_id: conversa.id, direction: 'in', body: null, attachment_path: 'wa/comprovante.jpg', attachment_type: 'image/jpeg', source: 'operator' }
    ]);
    roteiro = [{ content: 'Recebi o comprovante, obrigado!' }];
    pedidosIa = [];
    const res = await api(`/conversations/${conversa.id}/suggest-reply`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const enviadas = pedidosIa[0].payload.messages.filter((m) => m.role !== 'system');
    assert.match(enviadas[0].content, /o cliente enviou uma imagem/);
    assert.equal(enviadas.at(-1).role, 'user');
  });

  it('desligada: 409', async () => {
    await salvarIa({ suggest: false });
    const conversa = await conversaDe(ASSINANTE);
    const res = await api(`/conversations/${conversa.id}/suggest-reply`, { method: 'POST', body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ai_disabled');
    assert.equal((await api('/ai/status')).body.data.suggest, false);
  });

  it('IA desligada no atendimento: o bot de menu de sempre', async () => {
    await salvarIa({ enabled: false });
    await asTenant(() => WaBotConfigService.invalidate());
    await limparFio(ASSINANTE);
    await receber(ASSINANTE, 'oi');
    assert.equal(pedidosIa.length, 0);
    assert.equal((await respostas(ASSINANTE)).length, 1);
  });
});
