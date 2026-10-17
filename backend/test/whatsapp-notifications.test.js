import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { tinsert } = await import('../src/config/database.js');

let panelUrl;
let token;
let userId;
let accountId;
let seq = 0;

const notificacoes = (after) => call(
  `${panelUrl}/api/whatsapp/notifications${after ? `?after=${encodeURIComponent(after)}` : ''}`,
  { headers: authHeaders(token) }
);

async function conversa(phone, patch = {}) {
  const c = await asTenant(() => WaConversation.ensure({
    accountId, externalThreadId: `${phone}@s.whatsapp.net`, waPhone: phone, waLid: null, pushName: `Cliente ${phone.slice(-2)}`
  }));
  if (Object.keys(patch).length) await getDb()('wa_conversations').where({ id: c.id }).update(patch);
  return c.id;
}

const recebe = (conversationId, body) => {
  seq += 1;
  return asTenant(() => tinsert('wa_messages', {
    conversation_id: conversationId, direction: 'in', body, source: 'operator',
    external_id: `NOTIF-${seq}`, created_at: new Date(), updated_at: new Date()
  }));
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'plantao', password: 'plantao-senha-1', email: 'plantao@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;
  await asTenant(() => WhatsAppConfigService.saveConfig({ botEnabled: true }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-sino', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-sino'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-sino')
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('o sino do navegador', () => {
  it('a primeira leitura só devolve o cursor', async () => {
    const { status, body } = await notificacoes();
    assert.equal(status, 200);
    assert.deepEqual(body.data.items, []);
    assert.match(body.data.cursor, /^\d+$/);
  });

  it('um cursor que não é id vale como primeira leitura', async () => {
    const { status, body } = await notificacoes('2026-10-05T00:00:00.000Z');
    assert.equal(status, 200);
    assert.deepEqual(body.data.items, []);
    assert.match(body.data.cursor, /^\d+$/);
  });

  it('toca para a conversa do atendente e para quem espera gente; não para o bot nem para o colega', async () => {
    const { body: primeira } = await notificacoes();
    const cursor = primeira.data.cursor;

    const minha = await conversa('5593981170001', { assigned_user_id: userId });
    const doColega = await conversa('5593981170002', { assigned_user_id: userId + 999 });
    const comBot = await conversa('5593981170003');
    const pediuGente = await conversa('5593981170004', { bot_paused_until: new Date(Date.now() + 3600_000) });
    await recebe(minha, 'minha internet caiu');
    await recebe(doColega, 'oi');
    await recebe(comBot, '2');
    await recebe(pediuGente, 'quero falar com alguém');
    await asTenant(() => tinsert('wa_messages', {
      conversation_id: minha, direction: 'in', body: null, attachment_type: 'image/jpeg', source: 'operator',
      external_id: 'NOTIF-FOTO', created_at: new Date(), updated_at: new Date()
    }));

    const { body } = await notificacoes(cursor);
    const porConversa = body.data.items.map((i) => i.conversationId);
    assert.deepEqual([...new Set(porConversa)].sort(), [minha, pediuGente].sort());
    const texto = body.data.items.find((i) => i.conversationId === minha && i.preview);
    assert.equal(texto.preview, 'minha internet caiu');
    assert.equal(texto.mine, true);
    assert.equal(texto.contact, 'Cliente 01');
    assert.ok(body.data.items.some((i) => i.conversationId === minha && i.hasAttachment));

    // O cursor avança: lido de novo, não repete.
    const { body: depois } = await notificacoes(body.data.cursor);
    assert.deepEqual(depois.data.items, []);
  });

  it('mais de 50 de uma vez: o resto vem na leitura seguinte, sem repetir', async () => {
    const { body: primeira } = await notificacoes();
    const minha = await conversa('5593981170009', { assigned_user_id: userId });
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await recebe(minha, `mensagem ${i}`);
    }
    const { body: a } = await notificacoes(primeira.data.cursor);
    const { body: b } = await notificacoes(a.data.cursor);
    assert.equal(a.data.items.length, 50);
    assert.equal(b.data.items.length, 10);
    const ids = [...a.data.items, ...b.data.items].map((i) => i.messageId);
    assert.equal(new Set(ids).size, 60);
  });
});
