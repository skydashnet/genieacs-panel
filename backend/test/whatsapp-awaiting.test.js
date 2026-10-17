import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { tinsert } = await import('../src/config/database.js');

/**
 * "Aguardando resposta": o cliente falou por último e ninguém respondeu.
 * Resposta é gente ou bot; nota interna e envio automático não contam.
 */

let panelUrl;
let token;
let accountId;
let seq = 0;

const lista = async () => (await call(`${panelUrl}/api/whatsapp/conversations?status=all`, { headers: authHeaders(token) })).body.data;
const msg = (conversationId, direction, { source = 'operator', isNote = false, minutosAtras = 0 } = {}) => {
  seq += 1;
  const quando = new Date(Date.now() - minutosAtras * 60_000);
  return asTenant(() => tinsert('wa_messages', {
    conversation_id: conversationId, direction, body: `m${seq}`, source, is_note: isNote,
    external_id: isNote ? null : `AW-${seq}`, created_at: quando, updated_at: quando
  }));
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'espera', password: 'espera-senha-1', email: 'espera@exemplo.test' }
  });
  token = setup.body.data.token;
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-espera', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('t-espera'),
    ...WhatsAppConfigService.encryptWebhookToken('w-espera')
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('aguardando resposta', () => {
  it('marca quem falou por último, desde a primeira mensagem sem resposta', async () => {
    const c = await asTenant(() => WaConversation.ensure({
      accountId, externalThreadId: '5593981190001@s.whatsapp.net', waPhone: '5593981190001', waLid: null, pushName: 'Ana'
    }));
    await getDb()('wa_conversations').where({ id: c.id }).update({ engaged_at: new Date(), last_message_at: new Date() });
    const daConversa = async () => (await lista()).find((x) => x.id === c.id);

    await msg(c.id, 'in', { minutosAtras: 30 });
    await msg(c.id, 'out', { minutosAtras: 25 });
    assert.equal((await daConversa()).awaitingSince, null, 'respondida');

    await msg(c.id, 'in', { minutosAtras: 12 });
    await msg(c.id, 'in', { minutosAtras: 5 });
    const marcada = await daConversa();
    assert.ok(marcada.awaitingSince);
    const minutos = Math.round((Date.now() - new Date(marcada.awaitingSince).getTime()) / 60_000);
    assert.ok(minutos >= 11 && minutos <= 13, `desde a primeira sem resposta (${minutos} min)`);

    // Nota interna e cobrança automática não respondem o cliente.
    await msg(c.id, 'out', { isNote: true });
    await msg(c.id, 'out', { source: 'campaign' });
    assert.ok((await daConversa()).awaitingSince);

    // O bot respondendo conta.
    await msg(c.id, 'out', { source: 'bot' });
    assert.equal((await daConversa()).awaitingSince, null);
  });
});
