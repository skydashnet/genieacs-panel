import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WaSatisfactionService, lerNota } = await import('../src/services/waSatisfactionService.js');

const INSTANCE = 'painel-pesquisa';
const WEBHOOK_TOKEN = 'segredo-do-webhook-pesquisa';

let panelUrl;
let token;
let userId;
let accountId;
let seq = 0;

const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });
const encerrar = (id, status = 'closed') => call(`${panelUrl}/api/whatsapp/conversations/${id}/status`, {
  method: 'POST', headers: authHeaders(token), body: { status }
});
const linhaDe = (id) => getDb()('wa_conversations').where({ id }).first();
const pesquisaDe = (id) => getDb()('wa_satisfaction').where({ conversation_id: id }).orderBy('id', 'desc').first();
const saidasDoBot = (id) => getDb()('wa_messages').where({ conversation_id: id, direction: 'out', source: 'bot' }).orderBy('id');

function cliente(phone, texto) {
  seq += 1;
  return hook({
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: `PESQ-${seq}` },
      pushName: 'Cliente',
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  });
}

/** Uma conversa em que um atendente respondeu. */
async function atendida(phone, { comAtendente = true } = {}) {
  const conversa = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: `${phone}@s.whatsapp.net`,
    waPhone: phone,
    waLid: null,
    pushName: 'Cliente'
  }));
  if (comAtendente) {
    await asTenant(() => WaSendService.enqueue({ conversationId: conversa.id, body: 'Resolvido!', userId, source: 'operator' }));
  }
  return conversa.id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'atendente', password: 'atendente-senha-1', email: 'atendente@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    // O bot desligado: o que se testa é a pesquisa, e um menu no meio só
    // embaralharia a contagem do que saiu.
    botEnabled: false
  }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-pesquisa'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await asTenant(() => WaBotConfigService.saveConfig({ satisfaction: { enabled: true } }));
});

describe('lerNota', () => {
  it('lê o número, com ou sem palavra, e as estrelas', () => {
    for (const [texto, nota] of [['5', 5], [' 4 ', 4], ['3 estrelas', 3], ['nota 2', 2], ['⭐⭐⭐⭐', 4], ['1!', 1], ['5/5', 5]]) {
      assert.equal(lerNota(texto), nota, texto);
    }
  });

  it('o resto não é nota', () => {
    for (const texto of ['0', '6', '10', 'minha internet caiu de novo', '2 dias sem internet', '', '⭐⭐⭐⭐⭐⭐']) {
      assert.equal(lerNota(texto), null, texto);
    }
  });
});

describe('a pesquisa de satisfação', () => {
  it('encerrar pergunta; a nota alta agradece e a conversa continua encerrada', async () => {
    const id = await atendida('5593981120001');
    const { status } = await encerrar(id);
    assert.equal(status, 200);

    const pesquisa = await pesquisaDe(id);
    assert.equal(pesquisa.status, 'pending');
    assert.equal(Number(pesquisa.agent_user_id), Number(userId));
    assert.equal((await saidasDoBot(id)).length, 1);

    await cliente('5593981120001', '5');
    const depois = await pesquisaDe(id);
    assert.equal(depois.status, 'answered');
    assert.equal(depois.score, 5);
    const conversa = await linhaDe(id);
    assert.ok(conversa.closed_at, 'a nota não reabre a conversa');
    assert.equal(conversa.unread_count, 0);
    assert.equal((await saidasDoBot(id)).length, 2, 'pergunta e agradecimento');
  });

  it('a nota baixa pede comentário, e o comentário reabre a conversa', async () => {
    const id = await atendida('5593981120002');
    await encerrar(id);
    await cliente('5593981120002', '2');
    assert.equal((await pesquisaDe(id)).status, 'comment');
    assert.ok((await linhaDe(id)).closed_at);

    await cliente('5593981120002', 'Demorou muito para resolver');
    const pesquisa = await pesquisaDe(id);
    assert.equal(pesquisa.status, 'answered');
    assert.equal(pesquisa.score, 2);
    assert.equal(pesquisa.comment, 'Demorou muito para resolver');
    assert.equal((await linhaDe(id)).closed_at, null, 'quem deu nota baixa precisa ser lido');
    assert.equal((await saidasDoBot(id)).length, 3);
  });

  it('outro assunto tira a pesquisa do caminho e reabre a conversa', async () => {
    const id = await atendida('5593981120003');
    await encerrar(id);
    await cliente('5593981120003', 'a internet caiu de novo');
    assert.equal((await pesquisaDe(id)).status, 'skipped');
    assert.equal((await linhaDe(id)).closed_at, null);
  });

  it('não pergunta sem atendente, desligada, nem duas vezes pelo mesmo atendimento', async () => {
    const semGente = await atendida('5593981120004', { comAtendente: false });
    await encerrar(semGente);
    assert.equal(await pesquisaDe(semGente), undefined);

    await asTenant(() => WaBotConfigService.saveConfig({ satisfaction: { enabled: false } }));
    const desligada = await atendida('5593981120005');
    await encerrar(desligada);
    assert.equal(await pesquisaDe(desligada), undefined);
    await asTenant(() => WaBotConfigService.saveConfig({ satisfaction: { enabled: true } }));

    const id = await atendida('5593981120006');
    await encerrar(id);
    await cliente('5593981120006', '4');
    // Reabre e encerra de novo sem ninguém ter escrito: o atendimento é o mesmo.
    await encerrar(id, 'open');
    await encerrar(id);
    assert.equal((await getDb()('wa_satisfaction').where({ conversation_id: id })).length, 1);
  });

  it('o relatório soma as notas, por atendente, com os comentários das baixas', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/satisfaction-report?days=30`, { headers: authHeaders(token) });
    assert.equal(status, 200);
    const r = body.data;
    assert.ok(r.asked >= 4);
    assert.equal(r.answered, 3);
    assert.deepEqual(r.distribution, [0, 1, 0, 1, 1]);
    assert.equal(r.average, 3.7);
    assert.equal(r.byAgent[0].name, 'atendente');
    assert.equal(r.lowScores.length, 1);
    assert.equal(r.lowScores[0].comment, 'Demorou muito para resolver');

    const direto = await asTenant(() => WaSatisfactionService.report({ days: 999 }));
    assert.equal(direto.days, 30, 'um período fora da lista vira 30');
  });

  it('o dossiê do assinante leva a pesquisa', async () => {
    const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');
    assert.ok(SCOPED_TABLES.has('wa_satisfaction'));
  });
});
