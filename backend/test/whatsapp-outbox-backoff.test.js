import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService, WaError } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage, RECLAIM_MS } = await import('../src/models/WaMessage.js');
const { isPermanentFailure } = await import('../src/services/waSendFailure.js');
const {
  default: WaOutboxWorker,
  MAX_ATTEMPTS,
  retryDelayMs,
  retryScheduleMs
} = await import('../src/services/waOutboxWorker.js');

/**
 * The queue that has to survive a server that blinks.
 *
 * What is defended here is a measurement, not a preference: with three instant
 * attempts and a five-second loop, an Evolution restart lasting twenty seconds
 * failed every queued message permanently — during a dunning campaign,
 * thousands at once. So these tests ask two things of the outbox. That a
 * failure it cannot name buys the message a wait measured in minutes, and that
 * a failure it CAN name — a number nobody owns — does not spend those minutes
 * before saying so.
 *
 * Nothing here sleeps. A backoff is checked by reading the due time the worker
 * wrote and comparing it against the schedule the worker computes; the passage
 * of time is simulated by moving that due time into the past, which is exactly
 * what a later tick would find.
 */
const EVO_BASE = 'https://evo.provedor.test';
const ACCOUNT = 'painel-recuo';
const ACCOUNT_TOKEN = 'token-recuo-999';

/**
 * A moment with its milliseconds cut off.
 *
 * MySQL's `TIMESTAMP` holds whole seconds unless a column asks for more, and
 * these columns do not — so a seeded `…347.402` reads back as `…347.000` there
 * and a comparison against what was written would fail on CI and nowhere else.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

/**
 * `next_attempt_at` as milliseconds, whatever the engine handed back.
 *
 * Three engines, three shapes: a `Date` from MySQL and Postgres, epoch millis
 * from SQLite (which stores what knex bound), and a bare string from anything
 * that writes one. `waHealthService.asIso` has the same job for the same reason.
 */
function dueMs(row) {
  const value = row?.next_attempt_at;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value);
  return Date.parse(text.includes('T') ? text : `${text}Z`);
}

/** What the stub answers a send with, per test. */
const stub = { status: 200, body: null, nextId: 0 };

/** Every send the stub saw. */
const sends = [];

let evoServer;
let evoLocalUrl;
let desfazerRota;
let accountId;
let conversationId;

function startEvolutionStub() {
  evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      if (!path.startsWith('/message/sendText/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'unknown route' }));
      }
      sends.push({ path });
      res.writeHead(stub.status, { 'Content-Type': 'application/json' });
      if (stub.status === 200) {
        stub.nextId += 1;
        return res.end(JSON.stringify({ key: { id: `EVO-${stub.nextId}` }, status: 'PENDING' }));
      }
      return res.end(JSON.stringify(stub.body ?? { message: 'server error' }));
    });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${evoServer.address().port}`));
  });
}

/** One outbound row, with the queue state the test needs. */
async function seedMessage(patch = {}) {
  return asTenant(() => WaMessage.create({
    conversation_id: conversationId,
    direction: 'out',
    body: 'a mensagem',
    is_note: false,
    // 'operator', e não 'campaign': a automática sai no ritmo do worker (uma a
    // cada 20–45 s), e o que este arquivo mede é a espera entre TENTATIVAS,
    // não entre mensagens. O ritmo tem teste próprio em whatsapp-outbox-pace.
    source: 'operator',
    delivery_status: 'queued',
    created_at: wholeSecond(Date.now() - 60_000),
    updated_at: wholeSecond(Date.now() - 60_000),
    ...patch
  }));
}

const reload = (id) => asTenant(() => WaMessage.getById(id));
const sendable = (limit = 20) => asTenant(() => WaMessage.listSendable(limit));

/** The wait moved out of the way, which is what a later tick would find. */
const makeDue = (id) => asTenant(() => WaMessage.update(id, {
  next_attempt_at: wholeSecond(Date.now() - 10_000)
}));

before(async () => {
  await startTestServers();
  evoLocalUrl = await startEvolutionStub();

  // The SSRF guard blocks loopback by literal, so the account points at a name
  // that resolves nowhere and `fetch` is rewritten onto the stub. Everything
  // past that line is real: a real socket, real status codes, real bodies.
  // O cliente Evolution conecta por `PinnedTransport`, não por `fetch`: a rota
  // para o dublê troca os encaixes dele, e a guarda de endereço roda inteira.
  desfazerRota = rotearBase(EVO_BASE, evoLocalUrl);

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    // Well above anything these tests send: the per-minute ceiling is another
    // file's subject, and a pass cut short by it would look like a backoff.
    rateLimitPerMin: 200
  }));

  const account = await asTenant(() => WhatsAppAccount.create({
    name: ACCOUNT,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(ACCOUNT_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-recuo')
  }));
  accountId = account.id;

  const conversation = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: '5593981110499@s.whatsapp.net',
    waPhone: '5593981110499',
    waLid: null,
    pushName: 'Cliente'
  }));
  conversationId = conversation.id;
});

after(async () => {
  desfazerRota?.();
  WaOutboxWorker.stop();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_messages').del();
  // `stop()` also drops the rolling send window, so no test inherits a minute
  // another one spent.
  WaOutboxWorker.stop();
  stub.status = 200;
  stub.body = null;
  sends.length = 0;
});

describe('the retry window outlasts a restart', () => {
  it('is measured in minutes, and every wait is capped', () => {
    const waits = retryScheduleMs();
    assert.equal(waits.length, MAX_ATTEMPTS - 1, 'every attempt but the last is followed by a wait');

    // The first wait alone has to cover the twenty-second restart that used to
    // fail the whole queue, or the backoff has not fixed anything.
    assert.ok(waits[0] >= 20_000, `first wait is ${waits[0]} ms`);

    const total = waits.reduce((sum, wait) => sum + wait, 0);
    assert.ok(
      total >= 15 * 60_000,
      `the window is ${Math.round(total / 60_000)} min, and minutes rather than seconds is the point`
    );
    // And not so long that a failed message is one the panel quietly held onto:
    // the operator has to learn about it the same day.
    assert.ok(total <= 4 * 60 * 60_000);

    for (let i = 1; i < waits.length; i += 1) {
      assert.ok(waits[i] >= waits[i - 1], 'the waits grow');
      assert.ok(waits[i] <= 30 * 60_000, 'and stop growing at the ceiling');
    }
  });
});

describe('a transient failure is not a verdict', () => {
  it('leaves the row queued and out of reach until its due time', async () => {
    const message = await seedMessage();
    stub.status = 503;

    await WaOutboxWorker.tick();

    let row = await reload(message.id);
    assert.equal(row.delivery_status, 'queued', 'a server having a bad minute is not a failed message');
    assert.equal(row.attempts, 1);
    assert.match(row.delivery_error, /http_error/);

    const waited = dueMs(row) - Date.now();
    assert.ok(waited > 0, 'the row is due in the future');
    // Whole seconds on MySQL, so the comparison is generous at the edges; what
    // it asserts is that the wait came from the schedule rather than from the
    // five-second tick.
    assert.ok(Math.abs(waited - retryDelayMs(1)) <= 5_000, `waited ${waited} ms`);

    assert.deepEqual(await sendable(), [], 'and invisible to the worker while it waits');

    // A pass five seconds later must not touch it — the bug this wave is about
    // is exactly that pass burning an attempt.
    await WaOutboxWorker.tick();
    assert.equal(sends.length, 1, 'no second send before the due time');
    assert.equal((await reload(message.id)).attempts, 1);

    // Once due, the next attempt runs and the wait after it is longer.
    await makeDue(message.id);
    await WaOutboxWorker.tick();
    row = await reload(message.id);
    assert.equal(row.attempts, 2);
    assert.equal(row.delivery_status, 'queued');
    assert.ok(dueMs(row) - Date.now() > retryDelayMs(1), 'the backoff grows');
  });

  it('gives up only once the whole window is spent', async () => {
    const message = await seedMessage();
    stub.status = 502;

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- the attempts are a sequence, one wait apart
      await WaOutboxWorker.tick();
      // eslint-disable-next-line no-await-in-loop
      const row = await reload(message.id);
      assert.equal(row.delivery_status, 'queued', `attempt ${attempt} is not the last`);
      assert.equal(row.attempts, attempt);
      const waited = dueMs(row) - Date.now();
      assert.ok(
        Math.abs(waited - retryDelayMs(attempt)) <= 5_000,
        `attempt ${attempt} waits ${waited} ms, the schedule says ${retryDelayMs(attempt)} ms`
      );
      // eslint-disable-next-line no-await-in-loop
      await makeDue(message.id);
    }

    await WaOutboxWorker.tick();
    const row = await reload(message.id);
    assert.equal(row.delivery_status, 'failed');
    assert.equal(row.attempts, MAX_ATTEMPTS);
    assert.equal(row.next_attempt_at, null, 'a failed row has nothing left to wait for');
    assert.equal(sends.length, MAX_ATTEMPTS);

    // And a pass after that must not pick it up again.
    await WaOutboxWorker.tick();
    assert.equal(sends.length, MAX_ATTEMPTS);
  });
});

describe('a permanent failure does not spend the window', () => {
  /** The two servers refuse an unusable number in their own shapes. */
  const refusals = [
    ['Evolution v2', {
      status: 400,
      error: 'Bad Request',
      response: { message: ['The number 5593981110499 is not on WhatsApp'] }
    }],
    ['Evolution GO', { error: 'invalid JID: recipient is not on whatsapp' }]
  ];

  for (const [server, body] of refusals) {
    it(`fails on the first attempt when ${server} says the number is not a recipient`, async () => {
      const message = await seedMessage();
      stub.status = 400;
      stub.body = body;

      await WaOutboxWorker.tick();

      const row = await reload(message.id);
      assert.equal(row.delivery_status, 'failed', 'no point waiting half an hour for a number nobody owns');
      assert.equal(row.attempts, 1, 'and no point spending the rest of the attempts either');
      assert.equal(row.next_attempt_at, null);
      assert.equal(sends.length, 1);

      await WaOutboxWorker.tick();
      assert.equal(sends.length, 1);
    });
  }

  it('fails a thread with no address at all without troubling the server', async () => {
    // A cadastro corrected to something that is not a phone number: the row can
    // never be composed into a request, so every attempt would fail identically.
    const orphan = await asTenant(() => WaConversation.ensure({
      accountId,
      externalThreadId: 'grupo-sem-numero@g.us',
      waPhone: '',
      waLid: '',
      pushName: 'Grupo'
    }));
    const message = await seedMessage({ conversation_id: orphan.id });

    const summary = await WaOutboxWorker.tick();

    assert.equal(summary.failed, 1);
    assert.equal(sends.length, 0);
    const row = await reload(message.id);
    assert.equal(row.delivery_status, 'failed');
    assert.equal(row.attempts, 1);
  });

  it('reads the doubt in favour of another attempt', () => {
    const httpError = (status, body) => new WaError('whatsapp.error.httpError', {
      code: 'http_error',
      status: 502,
      vars: { status, body: JSON.stringify(body) }
    });

    // Named, and therefore permanent.
    assert.equal(isPermanentFailure(new WaError('x', { code: 'no_destination' })), true);
    assert.equal(isPermanentFailure(httpError(400, { message: ['number is invalid'] })), true);
    assert.equal(isPermanentFailure(httpError(400, { error: 'media type unsupported' })), true);

    // Everything else buys another attempt, including the shapes that read like
    // a refusal and are not.
    assert.equal(isPermanentFailure(new WaError('x', { code: 'timeout' })), false);
    assert.equal(isPermanentFailure(new WaError('x', { code: 'unreachable' })), false);
    assert.equal(isPermanentFailure(new WaError('x', { code: 'no_account' })), false);
    assert.equal(isPermanentFailure(httpError(503, { error: 'service unavailable' })), false);
    assert.equal(isPermanentFailure(httpError(429, { error: 'too many requests' })), false);
    assert.equal(isPermanentFailure(httpError(400, { error: 'number temporarily blocked' })), false);
    assert.equal(isPermanentFailure(httpError(400, { error: 'session not connected' })), false);
    assert.equal(isPermanentFailure(httpError(502, { error: 'could not reach WhatsApp' })), false);
    // A bug in the panel is not a verdict about the number.
    assert.equal(isPermanentFailure(new TypeError('x is not a function')), false);
  });
});

describe('the due time decides what the worker can see', () => {
  it('hides a row due later and shows one that has never failed', async () => {
    const later = await seedMessage({ next_attempt_at: wholeSecond(Date.now() + 10 * 60_000) });
    // NULL is what every row written before migration 0018 carries, and it has
    // to mean "due now" or an install's whole queue stops the day it upgrades.
    const upgraded = await seedMessage({ next_attempt_at: null });

    assert.deepEqual(await sendable(), [upgraded.id]);
    assert.equal(await asTenant(() => WaMessage.claim(later.id)), null, 'nor can it be claimed directly');

    await makeDue(later.id);
    const ids = (await sendable()).slice().sort((a, b) => a - b);
    assert.deepEqual(ids, [later.id, upgraded.id].sort((a, b) => a - b));
  });

  it('still reclaims a stale sending row after RECLAIM_MS', async () => {
    // A pass that died mid-send. Its due time is in the future — written by the
    // failure before it — and must not keep the row unreachable: a crash is
    // recoverable or it is not.
    const stale = await seedMessage({
      delivery_status: 'sending',
      claimed_at: wholeSecond(Date.now() - RECLAIM_MS - 60_000),
      attempts: 1,
      next_attempt_at: wholeSecond(Date.now() + 10 * 60_000)
    });
    const fresh = await seedMessage({
      delivery_status: 'sending',
      claimed_at: wholeSecond(Date.now()),
      attempts: 1
    });

    assert.deepEqual(await sendable(), [stale.id]);

    const claimed = await asTenant(() => WaMessage.claim(stale.id));
    assert.ok(claimed, 'the stale row is claimable, exactly as before');
    assert.equal(claimed.attempts, 2);
    assert.equal(await asTenant(() => WaMessage.claim(fresh.id)), null, 'the fresh one belongs to a live pass');
  });
});

describe('requeue makes a failed row sendable again', () => {
  it('clears the attempts and the wait, and refuses a row that never failed', async () => {
    const failed = await seedMessage({
      delivery_status: 'failed',
      attempts: MAX_ATTEMPTS,
      delivery_error: 'http_error | 502',
      next_attempt_at: wholeSecond(Date.now() + 30 * 60_000)
    });
    assert.deepEqual(await sendable(), [], 'a failed row is out of the queue');

    const back = await asTenant(() => WaMessage.requeue(failed.id));
    assert.equal(back.delivery_status, 'queued');
    assert.equal(back.attempts, 0);
    assert.equal(back.next_attempt_at, null, 'the operator decided the reason is over');
    assert.equal(back.delivery_error, null);
    assert.deepEqual(await sendable(), [failed.id]);

    // Only a failed row is eligible, and the WHERE says so: the row is queued
    // now, and requeuing it again would reset a backoff doing its job.
    assert.equal(await asTenant(() => WaMessage.requeue(failed.id)), null);

    const sent = await seedMessage({ delivery_status: 'sent', external_id: 'EVO-JA-FOI' });
    assert.equal(await asTenant(() => WaMessage.requeue(sent.id)), null, 'and a sent row is never resent');
  });
});
