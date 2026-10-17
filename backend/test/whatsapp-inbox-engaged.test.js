import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { default: migrations } = await import('../src/config/migrations.js');
const { runUnscoped } = await import('../src/config/tenantContext.js');

/**
 * A cobrança automática não enche a caixa de entrada.
 *
 * Com a régua ligada, cada fatura do mês criava uma conversa no topo de
 * "Abertas" — sem o cliente ter dito nada. Agora a conversa só entra em
 * "Abertas" quando há gente dos dois lados (o cliente escreveu, ou um
 * atendente escreveu nela); até lá ela mora em "Sem resposta", e a busca por
 * nome ou telefone a encontra de qualquer um dos dois.
 */

const INSTANCE = 'painel-engajada';
const WEBHOOK_TOKEN = 'segredo-do-webhook-engajada';

let panelUrl;
let token;
let accountId;

const listar = (query = '') => call(
  `${panelUrl}/api/whatsapp/conversations${query}`,
  { headers: authHeaders(token) }
);
const idsDe = (res) => (res.body.data ?? []).map((row) => row.id);
const linhaDe = (id) => getDb()('wa_conversations').where({ id }).first();
const ms = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });

function entrada({ id, remoteJid, texto }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe: false, id },
      pushName: 'Cliente',
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

/** Uma conversa nova com uma cobrança automática, como a régua a deixa. */
async function cobranca(phone) {
  const conversa = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: `${phone}@s.whatsapp.net`,
    waPhone: phone,
    waLid: null,
    pushName: 'Assinante'
  }));
  await asTenant(() => WaSendService.enqueue({
    conversationId: conversa.id,
    body: 'Sua fatura vence hoje.',
    source: 'campaign'
  }));
  return conversa.id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia-engajada'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('a conversa que só recebeu cobrança', () => {
  it('fica fora de "Abertas", em "Sem resposta", e a busca a encontra', async () => {
    const id = await cobranca('5593981120001');

    assert.equal(idsDe(await listar()).includes(id), false, 'não está em Abertas');
    const semResposta = await listar('?status=noreply');
    assert.equal(semResposta.status, 200);
    assert.equal(idsDe(semResposta).includes(id), true, 'está em Sem resposta');
    assert.equal(idsDe(await listar('?search=5593981120001')).includes(id), true, 'a busca acha');
    assert.equal(idsDe(await listar('?status=all')).includes(id), true);
  });

  it('vai para "Abertas" quando o cliente responde', async () => {
    const phone = '5593981120002';
    const id = await cobranca(phone);

    const res = await hook(entrada({ id: 'RESP-1', remoteJid: `${phone}@s.whatsapp.net`, texto: 'já paguei' }));
    assert.equal(res.body.handled, true);

    assert.ok((await linhaDe(id)).engaged_at, 'engajada');
    assert.equal(idsDe(await listar()).includes(id), true, 'agora em Abertas');
    assert.equal(idsDe(await listar('?status=noreply')).includes(id), false);
  });

  it('vai para "Abertas" quando o atendente escreve nela', async () => {
    const id = await cobranca('5593981120003');
    await asTenant(() => WaSendService.enqueue({ conversationId: id, body: 'Oi, tudo bem?', source: 'operator' }));
    assert.equal(idsDe(await listar()).includes(id), true);
  });
});

describe('a conversa que já tem gente', () => {
  it('não sobe para o topo com uma cobrança automática', async () => {
    const id = await cobranca('5593981120004');
    // Em segundos inteiros: o TIMESTAMP do MySQL não guarda milissegundos, e
    // um `…839` gravado volta `…000` — a comparação acusaria uma mudança que
    // não houve.
    const antes = new Date(Math.floor((Date.now() - 3600_000) / 1000) * 1000);
    await asTenant(() => WaConversation.update(id, { engaged_at: antes, last_message_at: antes }));

    await asTenant(() => WaSendService.enqueue({ conversationId: id, body: 'Lembrete.', source: 'campaign' }));
    await asTenant(() => WaSendService.enqueue({ conversationId: id, body: 'Queda na região.', source: 'alert' }));

    const linha = await linhaDe(id);
    assert.equal(ms(linha.last_message_at), ms(antes), 'o envio automático não mexe na ordem');
    assert.equal(idsDe(await listar()).includes(id), true, 'e continua em Abertas');
  });
});

describe('a migration 0084', () => {
  it('marca como engajada quem já teve gente e deixa de fora quem só recebeu cobrança', async () => {
    const comEntrada = await cobranca('5593981120005');
    await asTenant(() => WaConversation.update(comEntrada, { last_inbound_at: new Date(), engaged_at: null }));
    const comAtendente = await cobranca('5593981120006');
    await asTenant(() => WaSendService.enqueue({ conversationId: comAtendente, body: 'Oi', source: 'operator' }));
    await asTenant(() => WaConversation.update(comAtendente, { engaged_at: null }));
    const soCobranca = await cobranca('5593981120007');

    const migration = migrations.find((m) => m.id === '0084_wa_conversations_engaged_at');
    await runUnscoped('teste do passo 0084', () => migration.up(getDb()));

    assert.ok((await linhaDe(comEntrada)).engaged_at);
    assert.ok((await linhaDe(comAtendente)).engaged_at);
    assert.equal((await linhaDe(soCobranca)).engaged_at, null);
  });
});
