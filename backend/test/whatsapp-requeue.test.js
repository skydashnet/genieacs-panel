import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders,
  call,
  getDb,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { whatsappBulkRequeueLimiter } = await import('../src/middleware/rateLimit.js');

/**
 * Resending is putting the row back in the queue, not writing another one.
 *
 * What these tests defend is a subscriber's inbox. The screen's old "resend"
 * read the row's body and sent a NEW message: the failed row stayed where it
 * was, the customer got the same dunning notice twice, and a message whose
 * whole content was an attachment could not be resent at all — there was no
 * body to read, so the button did nothing and said nothing. So the assertions
 * below are as much about what did NOT happen (a second row, a neighbour's
 * queue moving, a `sent` row going out again) as about what did.
 */
const EVO_BASE = 'https://evo.provedor.test';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * A moment with its milliseconds cut off.
 *
 * MySQL's `TIMESTAMP` keeps whole seconds unless the column asks for fractional
 * precision, and `wa_messages.created_at` does not. Every window in this file
 * is a comparison against a seeded time, so the times seeded are ones all three
 * engines can actually hold.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let panelUrl;
let token;
let userId;
let alfa;
let beta;
let alfaAccountId;
let betaAccountId;
let alfaConversationId;
let betaConversationId;

let threadSeq = 0;

async function newConversation(tenantId, accountId) {
  threadSeq += 1;
  const suffix = String(threadSeq).padStart(3, '0');
  return runInTenant(tenantId, () => WaConversation.ensure({
    accountId,
    externalThreadId: `55939822${suffix}@s.whatsapp.net`,
    waPhone: `55939822${suffix}`,
    waLid: null,
    pushName: 'Cliente'
  }));
}

/**
 * One outbound row, aged by the caller.
 *
 * `created_at` is always explicit: it is the column the bulk window is measured
 * on, so a row whose age is left to the clock would make half of these tests
 * assert nothing.
 */
async function seedMessage(patch, {
  tenantId = alfa,
  conversationId = alfaConversationId,
  ageMs = 10 * MINUTE
} = {}) {
  return runInTenant(tenantId, () => WaMessage.create({
    conversation_id: conversationId,
    direction: 'out',
    is_note: false,
    source: 'operator',
    body: 'Sua fatura vence hoje.',
    created_at: wholeSecond(Date.now() - ageMs),
    updated_at: wholeSecond(Date.now() - ageMs),
    ...patch
  }));
}

/** A row that burned its attempts, as the worker leaves one. */
const failed = ({ seed, ...patch } = {}) => seedMessage({
  delivery_status: 'failed',
  delivery_error: 'Connection refused',
  attempts: 5,
  ...patch
}, seed);

const row = (id) => getDb()('wa_messages').where({ id }).first();

/** Ids, not a COUNT: Postgres hands COUNT over as a string and a length cannot lie. */
const rowsIn = (conversationId) => getDb()('wa_messages')
  .where({ conversation_id: conversationId })
  .pluck('id');

const requeue = (id) => call(`${panelUrl}/api/whatsapp/messages/${id}/requeue`, {
  method: 'POST',
  headers: authHeaders(token),
  body: {}
});

const requeueFailed = (body) => call(`${panelUrl}/api/whatsapp/messages/requeue-failed`, {
  method: 'POST',
  headers: authHeaders(token),
  body
});

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
  beta = (await db('tenants').orderBy('id', 'desc').first()).id;

  await runInTenant(alfa, () => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
  }));

  const mine = await runInTenant(alfa, () => WhatsAppAccount.create({
    name: 'painel-refila',
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-principal'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-principal')
  }));
  alfaAccountId = mine.id;

  const theirs = await runInTenant(beta, () => WhatsAppAccount.create({
    name: 'painel-vizinho',
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-vizinho'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-vizinho')
  }));
  betaAccountId = theirs.id;

  alfaConversationId = (await newConversation(alfa, alfaAccountId)).id;
  betaConversationId = (await newConversation(beta, betaAccountId)).id;
});

after(async () => {
  await stopTestServers();
});

// The conversation rows survive; only the messages go, so no test inherits
// another one's queue.
beforeEach(async () => {
  await getDb()('wa_messages').del();
});

describe('one failed message, back in the queue as itself', () => {
  it('requeues the row without writing a second one', async () => {
    const message = await failed({ next_attempt_at: wholeSecond(Date.now() + HOUR) });
    const before2 = await rowsIn(alfaConversationId);

    const { status, body } = await requeue(message.id);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.id, message.id, 'the answer is the same row, not a copy of it');
    assert.equal(body.data.deliveryStatus, 'queued');
    assert.equal(body.data.attempts, 0);

    const after2 = await rowsIn(alfaConversationId);
    assert.deepEqual(
      after2,
      before2,
      'a resend that adds a row is the bug: the subscriber would get the message twice'
    );

    const stored = await row(message.id);
    assert.equal(stored.delivery_status, 'queued');
    assert.equal(stored.attempts, 0);
    assert.equal(stored.delivery_error, null);
    assert.equal(stored.claimed_at, null);
    assert.equal(
      stored.next_attempt_at,
      null,
      'due now: the operator who pressed decided the reason for the failure is over'
    );
  });

  it('makes the row sendable again, which is the whole point', async () => {
    const message = await failed();
    const stuck = await runInTenant(alfa, () => WaMessage.listSendable(50));
    assert.ok(!stuck.includes(message.id), 'a failed row is out of the worker\'s reach');

    assert.equal((await requeue(message.id)).status, 200);

    const sendable = await runInTenant(alfa, () => WaMessage.listSendable(50));
    assert.ok(sendable.includes(message.id), 'and back in it once requeued');
  });

  /**
   * The case the old button could not do at all. No body means nothing to read
   * and re-post, so the screen's resend was silent — while the row it should
   * have been retrying sat there with the file still on disk.
   */
  it('requeues a message whose whole content was an attachment', async () => {
    const message = await failed({
      body: null,
      attachment_path: 'wa-media/1/fatura.pdf',
      attachment_type: 'application/pdf',
      attachment_name: 'fatura.pdf'
    });
    const before2 = await rowsIn(alfaConversationId);

    const { status, body } = await requeue(message.id);
    assert.equal(status, 200);
    assert.equal(body.data.deliveryStatus, 'queued');
    assert.equal(body.data.body, null);
    assert.deepEqual(
      body.data.attachment,
      { type: 'application/pdf', name: 'fatura.pdf' },
      'the file rides the same row, so nothing has to be uploaded again'
    );

    assert.deepEqual(await rowsIn(alfaConversationId), before2);
    assert.equal((await row(message.id)).attachment_path, 'wa-media/1/fatura.pdf');
  });

  it('refuses a message that was sent, rather than sending it twice', async () => {
    const message = await seedMessage({
      delivery_status: 'sent',
      external_id: 'EVO-JA-FOI',
      attempts: 1
    });

    const { status, body } = await requeue(message.id);
    assert.equal(status, 409);
    assert.equal(body.success, false);
    assert.equal(body.code, 'message_not_requeueable');
    assert.equal((await row(message.id)).delivery_status, 'sent');
  });

  it('refuses a queued message, whose backoff is doing its job', async () => {
    const due = wholeSecond(Date.now() + 4 * MINUTE);
    const message = await seedMessage({
      delivery_status: 'queued',
      attempts: 2,
      next_attempt_at: due
    });

    const { status, body } = await requeue(message.id);
    assert.equal(status, 409);
    assert.equal(body.code, 'message_not_requeueable');

    const stored = await row(message.id);
    assert.equal(stored.attempts, 2, 'a refusal changes nothing; it does not half-apply');
    assert.equal(new Date(stored.next_attempt_at).getTime(), due.getTime());
  });

  it('refuses an id that is not a row, in the same words', async () => {
    const { status, body } = await requeue(999_999);
    assert.equal(status, 409);
    assert.equal(
      body.code,
      'message_not_requeueable',
      '"not yours", "not there" and "not failed" are one sentence on purpose'
    );
  });

  it('cannot reach the neighbour\'s failed message', async () => {
    const theirs = await failed({ seed: { tenantId: beta, conversationId: betaConversationId } });

    const { status } = await requeue(theirs.id);
    assert.equal(status, 409);
    assert.equal(
      (await row(theirs.id)).delivery_status,
      'failed',
      'another provider\'s row is not forbidden here, it does not exist'
    );
  });

  it('is admin-only, like everything else on this surface', async () => {
    const message = await failed();
    const { status } = await call(`${panelUrl}/api/whatsapp/messages/${message.id}/requeue`, {
      method: 'POST',
      body: {}
    });
    assert.equal(status, 401);
    assert.equal((await row(message.id)).delivery_status, 'failed');
  });
});

describe('the bulk requeue after a campaign fell over', () => {
  // O teto desta rota é de 12 por minuto, e este bloco a exercita mais vezes
  // que isso de propósito: ele varre as janelas. Zerado por caso para que a
  // suíte prove o comportamento da rota e não o do limitador — que tem prova
  // própria em `whatsapp-outbox.test.js`.
  beforeEach(() => whatsappBulkRequeueLimiter.resetKey(`user:${userId}`));

  it('takes this provider\'s failures and never the neighbour\'s', async () => {
    const mine = [await failed(), await failed(), await failed()];
    const theirs = [
      await failed({ seed: { tenantId: beta, conversationId: betaConversationId } }),
      await failed({ seed: { tenantId: beta, conversationId: betaConversationId } })
    ];

    const { status, body } = await requeueFailed({ hours: 24 });
    assert.equal(status, 200);
    assert.equal(body.data.requeued, 3, 'three of ours, and only ours');

    for (const message of mine) {
      assert.equal((await row(message.id)).delivery_status, 'queued');
    }
    for (const message of theirs) {
      assert.equal(
        (await row(message.id)).delivery_status,
        'failed',
        'an admin at one ISP does not get to move another ISP\'s queue'
      );
    }

    const stillTheirs = await getDb()('wa_messages')
      .where({ tenant_id: beta, delivery_status: 'failed' })
      .pluck('id');
    assert.equal(stillTheirs.length, 2, 'their whole campaign is still theirs to recover');
  });

  it('leaves sent and queued rows alone, exactly as the single route does', async () => {
    const gone = await seedMessage({ delivery_status: 'sent', external_id: 'EVO-FOI-1' });
    const waiting = await seedMessage({ delivery_status: 'queued', attempts: 1 });
    const broken = await failed();

    const { body } = await requeueFailed({ hours: 24 });
    assert.equal(body.data.requeued, 1);

    assert.equal((await row(gone.id)).delivery_status, 'sent');
    assert.equal((await row(waiting.id)).attempts, 1, 'a live backoff is not reset by a sweep');
    assert.equal((await row(broken.id)).delivery_status, 'queued');
  });

  it('takes only the failures inside the window it was given', async () => {
    const recent = await failed({ seed: { ageMs: 2 * HOUR } });
    const older = await failed({ seed: { ageMs: 10 * HOUR } });

    const { body } = await requeueFailed({ hours: 6 });
    assert.equal(body.data.requeued, 1);
    assert.equal((await row(recent.id)).delivery_status, 'queued');
    assert.equal(
      (await row(older.id)).delivery_status,
      'failed',
      'ten hours ago is outside a six-hour window, and the window is the request'
    );
  });

  it('clamps a month-wide window down to the ceiling', async () => {
    const today = await failed({ seed: { ageMs: 3 * HOUR } });
    const lastWeek = await failed({ seed: { ageMs: 7 * 24 * HOUR } });
    const justOutside = await failed({ seed: { ageMs: 25 * HOUR } });

    const { body } = await requeueFailed({ hours: 720 });
    assert.equal(body.data.requeued, 1, 'a month of failures is not what the button offers');
    assert.equal((await row(today.id)).delivery_status, 'queued');
    assert.equal((await row(lastWeek.id)).delivery_status, 'failed');
    assert.equal(
      (await row(justOutside.id)).delivery_status,
      'failed',
      'the ceiling is a day, so an hour past it is past it'
    );
  });

  it('clamps a window under an hour up instead of refusing the request', async () => {
    const fresh = await failed({ seed: { ageMs: 10 * MINUTE } });
    const old = await failed({ seed: { ageMs: 3 * HOUR } });

    const { status, body } = await requeueFailed({ hours: 0 });
    assert.equal(status, 200);
    assert.equal(body.data.requeued, 1);
    assert.equal((await row(fresh.id)).delivery_status, 'queued');
    assert.equal((await row(old.id)).delivery_status, 'failed');
  });

  it('falls back to the ceiling when the request says nothing usable', async () => {
    const inside = await failed({ seed: { ageMs: 6 * HOUR } });
    const outside = await failed({ seed: { ageMs: 30 * HOUR } });

    const { status, body } = await requeueFailed({ hours: 'muitas' });
    assert.equal(status, 200);
    assert.equal(body.data.requeued, 1);
    assert.equal((await row(inside.id)).delivery_status, 'queued');
    assert.equal((await row(outside.id)).delivery_status, 'failed');
  });

  it('answers zero rather than an error when nothing failed', async () => {
    await seedMessage({ delivery_status: 'sent', external_id: 'EVO-CALMO' });

    const { status, body } = await requeueFailed({ hours: 24 });
    assert.equal(status, 200);
    assert.equal(
      body.data.requeued,
      0,
      'nothing to requeue is a real answer; a screen cannot tell it from a broken button without the count'
    );
  });

  it('clears the failure and its backoff on every row it takes', async () => {
    const message = await failed({ next_attempt_at: wholeSecond(Date.now() + HOUR) });

    await requeueFailed({ hours: 24 });

    const stored = await row(message.id);
    assert.equal(stored.delivery_status, 'queued');
    assert.equal(stored.attempts, 0);
    assert.equal(stored.delivery_error, null);
    assert.equal(stored.claimed_at, null);
    assert.equal(stored.next_attempt_at, null, 'the same patch the single route applies');
  });

  it('is admin-only too', async () => {
    const message = await failed();
    const { status } = await call(`${panelUrl}/api/whatsapp/messages/requeue-failed`, {
      method: 'POST',
      body: { hours: 24 }
    });
    assert.equal(status, 401);
    assert.equal((await row(message.id)).delivery_status, 'failed');
  });
});
