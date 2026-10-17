import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WaResponseTimeService } = await import('../src/services/waResponseTimeService.js');
const { tinsert } = await import('../src/config/database.js');

let panelUrl;
let token;
let userId;
let accountId;
let seq = 0;

const MIN = 60_000;
const base = Date.now() - 6 * 60 * MIN;
const em = (minutos) => new Date(base + minutos * MIN);

async function conversa(phone) {
  const c = await asTenant(() => WaConversation.ensure({
    accountId, externalThreadId: `${phone}@s.whatsapp.net`, waPhone: phone, waLid: null, pushName: 'Cliente'
  }));
  return c.id;
}

async function msg(conversationId, minutos, tipo) {
  seq += 1;
  const row = {
    conversation_id: conversationId,
    direction: tipo === 'cliente' ? 'in' : 'out',
    body: tipo,
    source: tipo === 'bot' ? 'bot' : 'operator',
    sent_by: tipo === 'painel' ? userId : null,
    external_id: tipo === 'painel' ? null : `RT-${seq}`,
    delivery_status: tipo === 'cliente' ? null : 'sent',
    created_at: em(minutos),
    updated_at: em(minutos)
  };
  await asTenant(() => tinsert('wa_messages', row));
}

const pedido = (conversationId, minutos) => asTenant(() => tinsert('wa_bot_events', {
  conversation_id: conversationId, intent: 'atendente', created_at: em(minutos)
}));

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'plantao', password: 'plantao-senha-1', email: 'plantao@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-tempo', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-tempo'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-tempo')
  }));
  accountId = account.id;

  // Sem bot: o cliente escreve e uma pessoa responde 4 min depois.
  const a = await conversa('5593981140001');
  await msg(a, 0, 'cliente');
  await msg(a, 1, 'cliente');
  await msg(a, 4, 'painel');

  // O bot resolveu sozinho: não é espera.
  const b = await conversa('5593981140002');
  await msg(b, 10, 'cliente');
  await msg(b, 10, 'bot');

  // O bot resolveu, e só depois o cliente pediu gente: conta do pedido.
  const c = await conversa('5593981140003');
  await msg(c, 60, 'cliente');
  await msg(c, 60, 'bot');
  await msg(c, 70, 'cliente');
  await msg(c, 70, 'bot');
  await pedido(c, 70);
  await msg(c, 80, 'painel');

  // Respondido pelo celular do provedor (eco, sem ninguém logado).
  const d = await conversa('5593981140004');
  await msg(d, 120, 'cliente');
  await msg(d, 121, 'eco');

  // Ainda esperando.
  const e = await conversa('5593981140005');
  await msg(e, 200, 'cliente');
});

after(async () => {
  await stopTestServers();
});

describe('o tempo de resposta', () => {
  it('mede da espera até a primeira resposta de gente, e não o que o bot resolveu', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/response-time-report?days=7`, { headers: authHeaders(token) });
    assert.equal(status, 200);
    const r = body.data;
    assert.equal(r.answered, 3);
    assert.equal(r.medianSeconds, 240);
    assert.equal(r.p90Seconds, 528);
    assert.deepEqual(r.within.map((w) => w.rate), [2 / 3, 1, 1]);
    const plantao = r.byAgent.find((a) => a.userId === userId);
    assert.equal(plantao.name, 'plantao');
    assert.equal(plantao.answered, 2);
    assert.equal(plantao.medianSeconds, 420);
    assert.equal(r.byAgent.find((a) => a.userId === null).answered, 1, 'o eco do celular conta sem atendente');
    assert.equal(r.waitingNow.count, 1);
    assert.equal(r.byHour.reduce((t, h) => t + h.answered, 0), 3);
  });

  it('com horário de atendimento, o que começou fora dele fica à parte', async () => {
    await asTenant(() => WaBotConfigService.saveConfig({
      hours: { enabled: true, week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true })) }
    }));
    try {
      const r = await asTenant(() => WaResponseTimeService.report({ days: 7 }));
      assert.equal(r.hoursEnabled, true);
      assert.equal(r.answered, 0);
      assert.equal(r.medianSeconds, null);
      assert.equal(r.outsideHours.answered, 3);
    } finally {
      await asTenant(() => WaBotConfigService.saveConfig({ hours: { enabled: false } }));
    }
  });

  it('um período fora da lista vira 7', async () => {
    const r = await asTenant(() => WaResponseTimeService.report({ days: 999 }));
    assert.equal(r.days, 7);
    await getDb()('wa_messages').count();
  });
});
