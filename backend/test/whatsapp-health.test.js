import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  asTenant,
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
const { default: WaHealthService } = await import('../src/services/waHealthService.js');

/**
 * "Is this working?" — the read that exists so the answer is not "a customer
 * complained".
 *
 * What these tests are actually defending is the difference between a number
 * and a moment. `queued: 40` is a busy afternoon or a dead panel, and the count
 * cannot tell you which; `oldestQueuedAt` can. `queued: 0` is a quiet morning
 * or a webhook that has not fired since Tuesday, and again only a timestamp
 * separates them. So the timestamps get as many tests as the counters, and the
 * seeded rows below carry deliberate `created_at` values rather than "now".
 */
const EVO_BASE = 'https://evo.provedor.test';
const MAIN = 'painel-saude';
const OTHER = 'painel-vizinho';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A moment with its milliseconds cut off.
 *
 * MySQL's `TIMESTAMP` keeps whole seconds unless a column asks for fractional
 * precision, and these do not — so a row seeded at `…347.402` reads back as
 * `…347.000` there and identically on the other two engines. Comparing what
 * was written against what came back is the point of these tests, so they
 * write times the storage can actually hold. Nothing in the product depends on
 * sub-second ordering of these columns, which is the fact this makes visible.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let panelUrl;
let token;
let mainAccountId;
let alfa;
let beta;
let betaAccountId;
let betaConversationId;

let threadSeq = 0;

/** A fresh thread, so no test inherits another one's leftovers. */
async function newConversation(tenantId = alfa, accountId = null) {
  threadSeq += 1;
  const suffix = String(threadSeq).padStart(3, '0');
  return runInTenant(tenantId, () => WaConversation.ensure({
    accountId: accountId ?? mainAccountId,
    externalThreadId: `55939811${suffix}@s.whatsapp.net`,
    waPhone: `55939811${suffix}`,
    waLid: null,
    pushName: 'Cliente'
  }));
}

/**
 * One row, with its age chosen by the caller.
 *
 * `created_at` is passed explicitly because every interesting case here is
 * about age: a failure three days old must not be inside a 24 h window, and the
 * oldest queued message is only meaningful against the others.
 */
async function seedMessage(conversationId, patch, tenantId = alfa) {
  return runInTenant(tenantId, () => WaMessage.create({
    conversation_id: conversationId,
    direction: 'out',
    is_note: false,
    source: 'operator',
    created_at: wholeSecond(Date.now() - HOUR),
    ...patch
  }));
}

/** The health read as the panel itself performs it, for the default provider. */
const health = () => asTenant(() => WaHealthService.read());

/**
 * Back to a panel that has never done anything.
 *
 * The conversation ROWS survive — `betaConversationId` is minted once and
 * referred to throughout — but everything a health read looks at on them is
 * cleared. Without this, the arrival one test writes to `last_inbound_at` is
 * still there for the test that asserts nothing has ever arrived, and "the
 * webhook is dead" quietly stops being testable.
 */
async function wipeMessages() {
  const db = getDb();
  await db('wa_messages').del();
  await db('wa_conversations').update({
    last_inbound_at: null,
    last_message_at: null,
    unread_count: 0,
    closed_at: null
  });
  WaHealthService.forgetMedia();
}

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
  beta = (await db('tenants').orderBy('id', 'desc').first()).id;

  // Inside a provider: `app_state` became per-provider while this was being
  // written, so a configuration write with nobody in scope now refuses.
  await runInTenant(alfa, () => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
  }));

  const main = await runInTenant(alfa, () => WhatsAppAccount.create({
    name: MAIN,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-principal'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-principal')
  }));
  mainAccountId = main.id;

  const neighbour = await runInTenant(beta, () => WhatsAppAccount.create({
    name: OTHER,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-vizinho'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-vizinho')
  }));
  betaAccountId = neighbour.id;

  const betaThread = await newConversation(beta, betaAccountId);
  betaConversationId = betaThread.id;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await wipeMessages();
});

describe('the counters', () => {
  it('counts a seeded mix of queued, sending, sent and failed', async () => {
    const thread = await newConversation();
    for (let n = 0; n < 3; n += 1) await seedMessage(thread.id, { delivery_status: 'queued' });
    await seedMessage(thread.id, { delivery_status: 'sending' });
    for (let n = 0; n < 5; n += 1) {
      await seedMessage(thread.id, { delivery_status: 'sent', external_id: `EVO-SENT-${n}` });
    }
    await seedMessage(thread.id, { delivery_status: 'failed' });
    await seedMessage(thread.id, { delivery_status: 'failed' });

    const { outbox } = await health();
    assert.equal(outbox.queued, 3);
    assert.equal(outbox.sending, 1);
    assert.equal(outbox.failed24h, 2);
  });

  /**
   * The engine disagreement `waBotService` sidestepped by pulling ids.
   *
   * Postgres returns COUNT as a bigint the driver hands over as a STRING. A
   * strip fed `"3"` still renders "3" and still passes `queued > 0`, so nothing
   * looks wrong until a comparison sorts lexically or a concatenation turns
   * `"40" + 0` into 400. A health read cannot dodge it by pulling rows — being
   * cheap is the point — so it coerces, and this is the test that says so.
   */
  it('returns counts as numbers on every engine, never as strings', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, { delivery_status: 'queued' });

    const snapshot = await health();
    for (const value of [
      snapshot.accounts.total,
      snapshot.accounts.connected,
      snapshot.accounts.disconnected,
      snapshot.outbox.queued,
      snapshot.outbox.sending,
      snapshot.outbox.failed24h,
      snapshot.inbox.unread,
      snapshot.inbox.openConversations,
      snapshot.media.files,
      snapshot.media.bytes
    ]) {
      assert.equal(typeof value, 'number', 'every figure crosses the wire as a number');
      assert.ok(Number.isFinite(value));
    }
  });

  it('counts the paired numbers and how many of them cannot send', async () => {
    const { accounts } = await health();
    assert.equal(accounts.total, 1);
    assert.equal(accounts.connected, 1);
    assert.equal(accounts.disconnected, 0);

    const spare = await runInTenant(alfa, () => WhatsAppAccount.create({
      name: 'painel-reserva-saude',
      purpose: 'support',
      flavor: 'v2',
      base_url: EVO_BASE,
      status: 'disconnected',
      ...WhatsAppConfigService.encryptInstanceToken('token-reserva'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-reserva')
    }));

    const after2 = await health();
    assert.equal(after2.accounts.total, 2);
    assert.equal(after2.accounts.connected, 1);
    assert.equal(after2.accounts.disconnected, 1, 'a number that cannot send is counted as such');

    await runInTenant(alfa, () => WhatsAppAccount.remove(spare.id));
  });
});

describe('failed24h is a window, not a total', () => {
  it('excludes a failure from three days ago', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, {
      delivery_status: 'failed',
      created_at: wholeSecond(Date.now() - 3 * DAY)
    });
    await seedMessage(thread.id, {
      delivery_status: 'failed',
      created_at: wholeSecond(Date.now() - 2 * HOUR)
    });

    const { outbox } = await health();
    assert.equal(
      outbox.failed24h,
      1,
      'a failure from three days ago is history; only the last 24 h are news'
    );
  });

  it('counts a failure from just inside the window and drops one just outside', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, {
      delivery_status: 'failed',
      created_at: wholeSecond(Date.now() - DAY + 5 * MINUTE)
    });
    await seedMessage(thread.id, {
      delivery_status: 'failed',
      created_at: wholeSecond(Date.now() - DAY - 5 * MINUTE)
    });

    const { outbox } = await health();
    assert.equal(outbox.failed24h, 1);
  });
});

describe('oldestQueuedAt — the number that says the queue stopped moving', () => {
  it('is the oldest still-queued message and ignores the ones that went out', async () => {
    const thread = await newConversation();

    // Older than everything, but it LEFT. A queue read that looked at this row
    // would report a panel as stuck on the evidence of its own success.
    await seedMessage(thread.id, {
      delivery_status: 'sent',
      external_id: 'EVO-OLD-SENT',
      created_at: wholeSecond(Date.now() - 5 * DAY)
    });

    const stuckSince = wholeSecond(Date.now() - 2 * DAY);
    await seedMessage(thread.id, { delivery_status: 'queued', created_at: stuckSince });
    await seedMessage(thread.id, {
      delivery_status: 'queued',
      created_at: wholeSecond(Date.now() - 10 * MINUTE)
    });

    const { outbox } = await health();
    assert.equal(outbox.queued, 2);
    assert.ok(outbox.oldestQueuedAt, 'a queue with rows in it has an oldest');
    assert.equal(
      new Date(outbox.oldestQueuedAt).getTime(),
      stuckSince.getTime(),
      'the oldest QUEUED one, not the oldest row'
    );
  });

  /**
   * The seam between the health strip and the outbox's backoff.
   *
   * A message that bounced goes back to 'queued' with a due time in the future.
   * It IS waiting to go out, so it counts in `queued` — but it is not the queue
   * standing still, and reporting it as the oldest waiting message would turn a
   * healthy retry into a red "stuck since two days ago" on the operator's
   * screen. `retrying` is the slice, and `oldestQueuedAt` skips it.
   */
  it('ignores a message that is waiting out a retry, and counts it separately', async () => {
    const thread = await newConversation();

    await seedMessage(thread.id, {
      delivery_status: 'queued',
      created_at: wholeSecond(Date.now() - 2 * DAY),
      next_attempt_at: wholeSecond(Date.now() + 10 * MINUTE)
    });

    const { outbox } = await health();
    assert.equal(outbox.queued, 1, 'it is still waiting to go out');
    assert.equal(outbox.retrying, 1, 'and the reason it is waiting is a scheduled attempt');
    assert.equal(outbox.oldestQueuedAt, null, 'so the queue has no stuck age at all');
  });

  /**
   * NULL means due now, and it is the common case rather than an edge one:
   * every first attempt and every row written before the column existed.
   */
  it('treats a null due time as due now', async () => {
    const thread = await newConversation();
    const waitingSince = wholeSecond(Date.now() - 3 * MINUTE);

    await seedMessage(thread.id, {
      delivery_status: 'queued',
      created_at: waitingSince,
      next_attempt_at: null
    });
    await seedMessage(thread.id, {
      delivery_status: 'queued',
      created_at: wholeSecond(Date.now() - 4 * DAY),
      next_attempt_at: wholeSecond(Date.now() + MINUTE)
    });

    const { outbox } = await health();
    assert.equal(outbox.queued, 2);
    assert.equal(outbox.retrying, 1);
    assert.equal(
      new Date(outbox.oldestQueuedAt).getTime(),
      waitingSince.getTime(),
      'the oldest DUE one, not the oldest queued row'
    );
  });

  it('is null when nothing is waiting', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, { delivery_status: 'sent', external_id: 'EVO-CALM' });

    const { outbox } = await health();
    assert.equal(outbox.queued, 0);
    assert.equal(outbox.oldestQueuedAt, null);
  });

  it('crosses the wire as an ISO string the browser can parse', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, {
      delivery_status: 'queued',
      created_at: wholeSecond(Date.now() - 3 * HOUR)
    });

    const { body } = await call(`${panelUrl}/api/whatsapp/health`, {
      headers: authHeaders(token)
    });
    const iso = body.data.outbox.oldestQueuedAt;
    assert.equal(typeof iso, 'string');
    assert.ok(iso.endsWith('Z'), `expected an ISO instant, got ${iso}`);
    assert.ok(!Number.isNaN(Date.parse(iso)), 'the strip formats this; an unparsable one prints nothing');
  });
});

describe('lastInboundAt — the number that catches a dead webhook', () => {
  it('is null on a panel that has never received anything', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, { delivery_status: 'sent', external_id: 'EVO-ONLY-OUT' });

    const snapshot = await health();
    assert.equal(
      snapshot.lastInboundAt,
      null,
      'never having received is its own state, and the strip says it differently'
    );
    assert.ok(snapshot.lastOutboundAt, 'outbound still reads, so the two are plainly independent');
  });

  it('reports the newest arrival once something has come in', async () => {
    const quiet = await newConversation();
    const recent = await newConversation();

    const older = wholeSecond(Date.now() - 4 * DAY);
    const newer = wholeSecond(Date.now() - 30 * MINUTE);
    await runInTenant(alfa, () => WaConversation.update(quiet.id, { last_inbound_at: older }));
    await runInTenant(alfa, () => WaConversation.update(recent.id, { last_inbound_at: newer }));

    const snapshot = await health();
    assert.equal(new Date(snapshot.lastInboundAt).getTime(), newer.getTime());
  });

  it('stays null while the outbox is empty, which is the silent-panel case', async () => {
    const snapshot = await health();
    assert.equal(snapshot.outbox.queued, 0);
    assert.equal(snapshot.lastInboundAt, null);
    assert.equal(
      snapshot.lastOutboundAt,
      null,
      'an empty queue and nothing ever moving is not health; it is the alarm'
    );
  });
});

describe('lastOutboundAt', () => {
  it('is the newest message that actually left, whichever receipt it reached', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, {
      delivery_status: 'sent',
      external_id: 'EVO-A',
      created_at: wholeSecond(Date.now() - 3 * HOUR)
    });
    const newest = wholeSecond(Date.now() - 20 * MINUTE);
    await seedMessage(thread.id, {
      delivery_status: 'read',
      external_id: 'EVO-B',
      created_at: newest
    });
    await seedMessage(thread.id, {
      delivery_status: 'delivered',
      external_id: 'EVO-C',
      created_at: wholeSecond(Date.now() - 90 * MINUTE)
    });

    const snapshot = await health();
    assert.equal(new Date(snapshot.lastOutboundAt).getTime(), newest.getTime());
  });

  it('ignores messages that are still queued or failed — those never left', async () => {
    const thread = await newConversation();
    await seedMessage(thread.id, { delivery_status: 'queued', created_at: wholeSecond(Date.now()) });
    await seedMessage(thread.id, { delivery_status: 'failed', created_at: wholeSecond(Date.now()) });

    const snapshot = await health();
    assert.equal(snapshot.lastOutboundAt, null);
  });
});

describe('the inbox figures', () => {
  it('counts threads with unread messages, not the messages in them', async () => {
    const loud = await newConversation();
    const quiet = await newConversation();
    await runInTenant(alfa, () => WaConversation.update(loud.id, { unread_count: 30 }));
    await runInTenant(alfa, () => WaConversation.update(quiet.id, { unread_count: 0 }));

    const { inbox } = await health();
    assert.equal(inbox.unread, 1, 'one customer who sent thirty messages is one thread to open');
    assert.ok(inbox.openConversations >= 2);
  });

  it('leaves closed threads out of both figures', async () => {
    const closed = await newConversation();
    await runInTenant(alfa, () => WaConversation.update(closed.id, {
      unread_count: 4,
      closed_at: wholeSecond(Date.now())
    }));

    const before2 = await health();
    const open = await newConversation();
    await runInTenant(alfa, () => WaConversation.update(open.id, { unread_count: 1 }));
    const after2 = await health();

    assert.equal(after2.inbox.unread, before2.inbox.unread + 1);
    assert.equal(after2.inbox.openConversations, before2.inbox.openConversations + 1);
  });
});

describe('one provider never sees another provider\'s numbers', () => {
  it('keeps the neighbour\'s queue, failures and arrivals out of this read', async () => {
    const mine = await newConversation();
    await seedMessage(mine.id, { delivery_status: 'queued' });

    // The neighbour is in a worse state than we are in every single figure.
    for (let n = 0; n < 9; n += 1) {
      await seedMessage(betaConversationId, { delivery_status: 'queued' }, beta);
    }
    for (let n = 0; n < 4; n += 1) {
      await seedMessage(betaConversationId, { delivery_status: 'failed' }, beta);
    }
    await seedMessage(betaConversationId, { delivery_status: 'sending' }, beta);
    await runInTenant(beta, () => WaConversation.update(betaConversationId, {
      unread_count: 7,
      last_inbound_at: wholeSecond(Date.now())
    }));

    const mineHealth = await health();
    assert.equal(mineHealth.outbox.queued, 1, 'nine of the neighbour\'s queued rows are not ours');
    assert.equal(mineHealth.outbox.failed24h, 0);
    assert.equal(mineHealth.outbox.sending, 0);
    assert.equal(mineHealth.accounts.total, 1, 'the neighbour\'s paired number is not ours either');
    assert.equal(mineHealth.lastInboundAt, null, 'their arrival does not make our webhook alive');

    // And the mirror image: the neighbour sees their own numbers, not ours.
    const theirs = await runInTenant(beta, () => WaHealthService.read());
    assert.equal(theirs.outbox.queued, 9);
    assert.equal(theirs.outbox.failed24h, 4);
    assert.equal(theirs.accounts.total, 1);
    assert.ok(theirs.lastInboundAt, 'their own arrival is theirs to see');
  });
});

describe('the media reading', () => {
  const mediaRoot = () => path.join(process.env.DATA_DIR, 'wa-media');

  async function writeAttachment(conversationId, name, bytes, ageMs = 0) {
    const dir = path.join(mediaRoot(), String(conversationId));
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fsp.writeFile(file, Buffer.alloc(bytes, 1));
    if (ageMs > 0) {
      const when = wholeSecond(Date.now() - ageMs);
      await fsp.utimes(file, when, when);
    }
    return file;
  }

  it('counts only this provider\'s files, and the oldest of them', async () => {
    await fsp.rm(mediaRoot(), { recursive: true, force: true });
    WaHealthService.forgetMedia();

    const mine = await newConversation();
    await writeAttachment(mine.id, 'foto.jpg', 1000);
    await writeAttachment(mine.id, 'antiga.jpg', 500, 10 * DAY);

    // The neighbour's attachments sit in the same tree, under their own
    // conversation id. The path carries no provider, so only the ownership
    // lookup keeps their photos out of our number.
    await writeAttachment(betaConversationId, 'deles.jpg', 9_000_000);

    const { media } = await health();
    assert.equal(media.files, 2, 'the neighbour\'s file is in the same tree and is not ours');
    assert.equal(media.bytes, 1500);
    assert.ok(media.oldestAt, 'files on disk have an oldest');
    const ageDays = (Date.now() - Date.parse(media.oldestAt)) / DAY;
    assert.ok(ageDays > 9 && ageDays < 11, `expected the 10-day-old file, got ${media.oldestAt}`);

    const theirs = await runInTenant(beta, () => WaHealthService.read());
    assert.equal(theirs.media.files, 1);
    assert.equal(theirs.media.bytes, 9_000_000);
  });

  it('is zero, not an error, on a panel with no media directory yet', async () => {
    await fsp.rm(mediaRoot(), { recursive: true, force: true });
    WaHealthService.forgetMedia();

    const { media } = await health();
    assert.deepEqual(media, { files: 0, bytes: 0, oldestAt: null });
  });

  /**
   * The whole reason the walk is cached: this figure is the only part of the
   * read that touches the disk, and the strip polls. A second call inside the
   * TTL must not stat a single file again.
   */
  it('serves a cached reading rather than walking the disk on every poll', async () => {
    await fsp.rm(mediaRoot(), { recursive: true, force: true });
    WaHealthService.forgetMedia();

    const mine = await newConversation();
    await writeAttachment(mine.id, 'primeira.jpg', 100);
    const first = await health();
    assert.equal(first.media.files, 1);

    await writeAttachment(mine.id, 'segunda.jpg', 100);
    const second = await health();
    assert.equal(
      second.media.files,
      1,
      'the new file is not seen until the cache expires — that is the trade, and it is deliberate'
    );

    WaHealthService.forgetMedia();
    const third = await health();
    assert.equal(third.media.files, 2, 'and it is seen the moment the reading is refreshed');
  });
});

/**
 * O degrau entre "quebrado" e "nunca conferido".
 *
 * Nasceu de um painel em produção com "Nunca chegou nada" ao lado de um webhook
 * que a tela declarava saudável: a URL e o token conferiam, a lista de eventos
 * veio vazia, e isso lia como `ok`. A tira ficava muda e o botão de reaplicar —
 * que é o conserto — some da tela quando o veredito é `ok`. Sem sintoma e sem
 * caminho.
 */
describe('o webhook conferido que não dá para conferir inteiro', () => {
  const comVeredito = (verdict) => asTenant(
    () => WhatsAppAccount.update(mainAccountId, { webhook_verdict: verdict })
  );

  const limpar = () => asTenant(() => WhatsAppAccount.update(mainAccountId, {
    webhook_verdict: null, webhook_probe_verdict: null, webhook_refused_at: null
  }));

  it('`events_unknown` conta em `unverifiable`, e NÃO em `broken`', async () => {
    // Acusar um servidor possivelmente são é o erro mais caro aqui: um v2
    // antigo que não devolve o campo está perfeitamente bem.
    await comVeredito('events_unknown');
    const { webhook } = await health();
    assert.equal(webhook.unverifiable, 1);
    assert.equal(webhook.broken, 0);
    await limpar();
  });

  it('e nem em `unchecked`: ele FOI conferido', async () => {
    // A diferença que a tela lê: "nunca conferido" oferece a conferência,
    // "não dá para conferir a lista" oferece a reescrita. Dizer que nunca se
    // olhou uma conta que foi olhada é a mentira que este degrau desfaz.
    await comVeredito('events_unknown');
    assert.equal((await health()).webhook.unchecked, 0);
    await limpar();
  });

  it('um veredito realmente quebrado continua em `broken`', async () => {
    await comVeredito('url_mismatch');
    const { webhook } = await health();
    assert.equal(webhook.broken, 1);
    assert.equal(webhook.unverifiable, 0);
    await limpar();
  });

  it('e `ok` não conta em lugar nenhum', async () => {
    await comVeredito('ok');
    const { webhook } = await health();
    assert.equal(webhook.broken, 0);
    assert.equal(webhook.unverifiable, 0);
    assert.equal(webhook.unchecked, 0);
    await limpar();
  });

  it('a volta que falhou continua tendo precedência sobre tudo', async () => {
    // Um webhook que não é entregável torna irrelevante o que está gravado no
    // servidor — inclusive a dúvida sobre a lista de eventos.
    await asTenant(() => WhatsAppAccount.update(mainAccountId, {
      webhook_verdict: 'events_unknown', webhook_probe_verdict: 'wrong_target'
    }));
    const { webhook } = await health();
    assert.equal(webhook.unreachable, 1);
    assert.equal(webhook.unverifiable, 0);
    await limpar();
  });
});

/**
 * O prazo de guarda, ao lado da contagem do que já está guardado.
 *
 * `media.bytes` dizia quanto ocupa e não dizia por quanto tempo, e as duas
 * metades dessa frase só significam alguma coisa juntas: "9,4 KB" é irrelevante
 * e "9,4 KB para sempre" é uma decisão. Estes dois prazos são os ÚNICOS do
 * sistema que nascem em zero — telemetria, eventos do ERP, provisionamento e
 * trilha todos nascem com prazo —, e é onde ficam o texto das conversas, as
 * fotos e os documentos do assinante.
 */
describe('os prazos de guarda viajam com a contagem', () => {
  it('zero é o padrão, e zero quer dizer para sempre', async () => {
    const { retention } = await health();
    assert.equal(retention.mediaDays, 0);
    assert.equal(retention.messageDays, 0);
  });

  it('e o que o provedor salvou é o que a tira lê', async () => {
    await asTenant(() => WhatsAppConfigService.saveConfig({
      mediaRetentionDays: 90, messageRetentionDays: 365
    }));
    const { retention } = await health();
    assert.equal(retention.mediaDays, 90);
    assert.equal(retention.messageDays, 365);
    await asTenant(() => WhatsAppConfigService.saveConfig({
      mediaRetentionDays: 0, messageRetentionDays: 0
    }));
  });

  it('e é do provedor em escopo, não do vizinho', async () => {
    // A configuração mora em `app_state`, que é escopada. Um prazo lido fora
    // do escopo mostraria ao provedor o prazo de outro — e, pior, o faria
    // acreditar que tem prazo quando não tem.
    await runInTenant(beta, () => WhatsAppConfigService.saveConfig({ mediaRetentionDays: 7 }));
    assert.equal((await health()).retention.mediaDays, 0, 'leu o prazo do vizinho');
    assert.equal(
      (await runInTenant(beta, () => WaHealthService.read())).retention.mediaDays, 7
    );
  });
});

describe('the route', () => {
  it('answers the frozen shape', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/health`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);

    const data = body.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'accounts', 'inbox', 'lastInboundAt', 'lastOutboundAt', 'media', 'outbox', 'retention', 'webhook'
    ]);
    assert.deepEqual(Object.keys(data.accounts).sort(), ['connected', 'disconnected', 'total']);
    assert.deepEqual(Object.keys(data.outbox).sort(), ['failed24h', 'oldestQueuedAt', 'queued', 'retrying', 'sending']);
    assert.deepEqual(Object.keys(data.inbox).sort(), ['openConversations', 'unread']);
    assert.deepEqual(Object.keys(data.media).sort(), ['bytes', 'files', 'oldestAt']);
    assert.deepEqual(Object.keys(data.retention).sort(), ['mediaDays', 'messageDays']);
    assert.deepEqual(
      Object.keys(data.webhook).sort(),
      ['broken', 'refusedAt', 'unchecked', 'unreachable', 'unverifiable']
    );
  });

  it('is admin-only, like everything else on this surface', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/health`);
    assert.equal(status, 401);
  });
});
