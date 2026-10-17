import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { runInTenant } = await import('../src/config/tenantContext.js');

/**
 * Which provider an inbound message is filed under.
 *
 * The webhook is the one WhatsApp path with no session behind it: an Evolution
 * server posts an event, and the ONLY thing naming the provider is the instance
 * name, which `whatsapp_accounts` resolves before the scope is opened. So the
 * scope is right by the time the message is written — and the write still has
 * to use it.
 *
 * It did not. `waInboundService` wrote the row through `insertReturningId`
 * rather than `tinsertReturningId`, and only the `t` variant stamps
 * `tenant_id`. The raw one let the column fall to the DEFAULT that migration
 * 0012 set, which is provider #1. With one provider the two behave identically,
 * which is exactly why nothing caught it: the existing leak test builds its
 * rows through `WaMessage.create`, so it exercised the model and never this.
 *
 * Everything here therefore needs TWO providers. With one, the default is the
 * right answer by accident and every assertion below passes on the bug.
 */
const BETA_INSTANCE = 'painel-beta';
const BETA_WEBHOOK_TOKEN = 'segredo-webhook-beta';

let panelUrl;
let alfa;
let beta;

before(async () => {
  ({ panelUrl } = await startTestServers());

  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', {
    slug: 'beta', name: 'Provedor Beta', status: 'active'
  });

  // Beta's own Evolution instance. The name is what the webhook resolves, and
  // it is globally unique for precisely that reason.
  await runInTenant(beta, () => WhatsAppAccount.create({
    name: BETA_INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.beta.com.br',
    status: 'pending',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-beta'),
    ...WhatsAppConfigService.encryptWebhookToken(BETA_WEBHOOK_TOKEN)
  }));
});

after(async () => {
  await stopTestServers();
});

function evento(id, texto) {
  return {
    event: 'messages.upsert',
    instance: BETA_INSTANCE,
    data: {
      key: { remoteJid: '5593988887777@s.whatsapp.net', fromMe: false, id },
      pushName: 'Assinante do Beta',
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

describe('an inbound message belongs to the provider whose instance received it', () => {
  it('files the message under that provider and not under the first one', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp-webhook?t=${BETA_WEBHOOK_TOKEN}`,
      { method: 'POST', body: evento('BETA-1', 'oi, minha internet caiu') }
    );
    assert.equal(status, 200);
    assert.equal(body.handled, true);

    // Read unfiltered on purpose: the point is which value the column HOLDS,
    // and a scoped read would hide a wrong one by refusing to return the row.
    const row = await getDb()('wa_messages').where({ external_id: 'BETA-1' }).first();
    assert.ok(row, 'the message should have landed');
    assert.equal(Number(row.tenant_id), Number(beta), 'filed under Beta, whose server sent it');
    assert.notEqual(Number(row.tenant_id), Number(alfa), 'and never under the first provider');
  });

  it('puts the message in Beta operator inbox, and leaves Alfa inbox empty', async () => {
    await call(
      `${panelUrl}/api/whatsapp-webhook?t=${BETA_WEBHOOK_TOKEN}`,
      { method: 'POST', body: evento('BETA-2', 'segunda mensagem') }
    );

    const vistasPeloBeta = await runInTenant(beta, () =>
      getDb()('wa_messages').where({ external_id: 'BETA-2' }).first());
    assert.ok(vistasPeloBeta, 'Beta should see the message its own server delivered');

    // The half that actually hurts: the row filed under the wrong provider is
    // not merely mislabelled, it shows up in another ISP operator inbox.
    const alfaMessages = await asTenant(() => getDb()('wa_messages').where({ tenant_id: alfa }));
    assert.equal(
      alfaMessages.filter((m) => String(m.external_id || '').startsWith('BETA-')).length,
      0,
      'Alfa must not hold a single message that arrived at Beta'
    );
  });

  it('files the conversation under the same provider as its messages', async () => {
    const row = await getDb()('wa_messages').where({ external_id: 'BETA-1' }).first();
    const thread = await getDb()('wa_conversations').where({ id: row.conversation_id }).first();
    assert.equal(
      Number(thread.tenant_id),
      Number(row.tenant_id),
      'a thread and its messages cannot belong to different providers'
    );
  });
});
