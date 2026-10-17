import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: SgpEvent } = await import('../src/models/SgpEvent.js');
const { default: SgpService } = await import('../src/services/sgpService.js');

/**
 * The ERP event log, once it belongs to one provider at a time.
 *
 * `sgp_events` is the PII-heaviest table the panel has — contract, document,
 * PPPoE login, device id and a redacted payload — and it was carrying two
 * separate deployment-wide faults. `pruneOlderThan` had no identity column in
 * its WHERE, so one ISP's retention setting deleted everybody's settled
 * history. And `dedupe_key` was unique across the whole deployment while it is
 * built from an SGP event id, which is a sequential number inside one ISP's
 * ERP: two providers both reach event #12345, and the second one to arrive was
 * read as a redelivery of the first, answered 200 duplicate, and thrown away
 * with nothing logged anywhere.
 *
 * The webhook is the other half. It is unauthenticated, it carries no session,
 * and every request under `/api` resolves to the first provider — so the HMAC
 * could only ever be checked against provider #1's secret and a second ISP's
 * SGP could not deliver at all. It resolves its own provider now: the delivery
 * is verified against each provider's own secret, and the one whose secret
 * verifies is the one the event is filed under.
 */
let alfa;
let beta;
let panelUrl;
let adminToken;

const SECRET_ALFA = crypto.randomBytes(32).toString('hex');
const SECRET_BETA = crypto.randomBytes(32).toString('hex');

/** The same event id both ERPs hand out, which is the collision itself. */
const SHARED_EVENT_ID = '12345';
const SHARED_CONTRACT = '4321';
const BETA_ONLY_CONTRACT = 'CONTRATO-SO-DA-BETA';

const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

/** Posts pre-serialized bytes, so the signature covers exactly what is sent. */
async function postWebhook(body, secret) {
  const response = await fetch(`${panelUrl}/api/sgp/events/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-SGP-Signature': `sha256=${sign(body, secret)}` } : {})
    },
    body
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The rows as the database holds them, provider and all — never through a model. */
const raw = (where) => getDb()('sgp_events').where(where);

const eventRow = (overrides) => ({
  dedupe_key: 'seed:default',
  source: 'reconcile',
  type: 'blocked',
  raw_type: 'Bloqueado',
  contract: '9000',
  document: '12345678909',
  login: 'assinante@provedor',
  device_id: null,
  status: 'processed',
  payload: '{}',
  occurred_at: null,
  received_at: new Date('2024-01-01T00:00:00Z'),
  ...overrides
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // Each provider turns delivery on with its own secret, through its own
  // configuration — which lives in the scoped `app_state`, and is the reason
  // the endpoint could not read a second provider's secret before.
  await runInTenant(alfa, () => SgpService.saveConfig({
    webhookEnabled: true, webhookSecret: SECRET_ALFA
  }));
  await runInTenant(beta, () => SgpService.saveConfig({
    webhookEnabled: true, webhookSecret: SECRET_BETA
  }));

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  adminToken = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('the silent drop', () => {
  it('stores both providers\' event #12345 instead of discarding the second', async () => {
    const body = JSON.stringify({
      id: SHARED_EVENT_ID, evento: 'liberado', contrato: SHARED_CONTRACT
    });

    const first = await postWebhook(body, SECRET_ALFA);
    const second = await postWebhook(body, SECRET_BETA);

    // The second delivery is a new event, not a redelivery: 202, not 200.
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(second.status, 202, JSON.stringify(second.body));
    assert.equal(second.body.duplicate, false);
    assert.notEqual(first.body.id, second.body.id);

    const rows = await raw({ contract: SHARED_CONTRACT }).orderBy('id', 'asc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.tenant_id)).sort(),
      [Number(alfa), Number(beta)].sort()
    );
    // The keys really are identical — the collision is real, and it is the
    // provider column that now tells the two rows apart.
    assert.equal(rows[0].dedupe_key, rows[1].dedupe_key);
  });

  it('still treats a redelivery inside one provider as a duplicate', async () => {
    const body = JSON.stringify({
      id: SHARED_EVENT_ID, evento: 'liberado', contrato: SHARED_CONTRACT
    });

    const again = await postWebhook(body, SECRET_ALFA);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);

    // And nothing was written: still exactly one row per provider.
    assert.equal((await raw({ contract: SHARED_CONTRACT })).length, 2);
    assert.equal((await raw({ tenant_id: alfa, contract: SHARED_CONTRACT })).length, 1);
  });

  it('deduplicates within the provider that signed, not across providers', async () => {
    const key = 'webhook:manual-collision';
    const row = { ...eventRow({ dedupe_key: key, contract: '5555', status: 'pending' }) };

    const mine = await runInTenant(alfa, () => SgpEvent.insertIfNew(row));
    const theirs = await runInTenant(beta, () => SgpEvent.insertIfNew(row));
    const mineAgain = await runInTenant(alfa, () => SgpEvent.insertIfNew(row));

    assert.equal(mine.created, true);
    assert.equal(theirs.created, true);
    assert.equal(mineAgain.created, false);
    assert.equal(mineAgain.event.id, mine.event.id);
    assert.equal(Number(theirs.event.tenant_id), Number(beta));
    assert.equal((await raw({ dedupe_key: key })).length, 2);
  });

  it('refuses to write an event outside a provider', async () => {
    await assert.rejects(
      () => SgpEvent.insertIfNew(eventRow({ dedupe_key: 'seed:no-provider' })),
      { name: 'TenantScopeError' }
    );
    assert.equal((await raw({ dedupe_key: 'seed:no-provider' })).length, 0);
  });
});

describe('a delivery finding its own provider', () => {
  it('files the event under whoever\'s secret signed the bytes', async () => {
    const body = JSON.stringify({
      id: 'evt-beta-777', evento: 'bloqueado', contrato: BETA_ONLY_CONTRACT
    });

    assert.equal((await postWebhook(body, SECRET_BETA)).status, 202);

    const rows = await raw({ contract: BETA_ONLY_CONTRACT });
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].tenant_id), Number(beta));
  });

  it('rejects a delivery signed with a secret no provider uses', async () => {
    const body = JSON.stringify({ id: 'evt-forjado', evento: 'liberado', contrato: '6001' });

    const unsigned = await postWebhook(body, null);
    const wrong = await postWebhook(body, crypto.randomBytes(32).toString('hex'));

    assert.equal(unsigned.status, 401);
    assert.equal(wrong.status, 401);
    // Byte-identical answers: nothing here tells a prober how many providers
    // exist, which of them uses SGP, or that its guess was close.
    assert.deepEqual(unsigned.body, { success: false, code: 'invalid_signature' });
    assert.deepEqual(wrong.body, unsigned.body);
    assert.equal((await raw({ contract: '6001' })).length, 0);
  });

  it('refuses rather than guessing when two providers share a secret', async () => {
    await runInTenant(beta, () => SgpService.saveConfig({ webhookSecret: SECRET_ALFA }));
    try {
      const body = JSON.stringify({ id: 'evt-ambiguo', evento: 'liberado', contrato: '6002' });
      const { status, body: answer } = await postWebhook(body, SECRET_ALFA);

      assert.equal(status, 401);
      assert.deepEqual(answer, { success: false, code: 'invalid_signature' });
      // Guessing would have written one ISP's subscriber into the other's log.
      assert.equal((await raw({ contract: '6002' })).length, 0);
    } finally {
      await runInTenant(beta, () => SgpService.saveConfig({ webhookSecret: SECRET_BETA }));
    }
  });

  it('answers 404 while no provider has delivery switched on', async () => {
    await runInTenant(alfa, () => SgpService.saveConfig({ webhookEnabled: false }));
    await runInTenant(beta, () => SgpService.saveConfig({ webhookEnabled: false }));
    try {
      const body = JSON.stringify({ id: 'evt-desligado', evento: 'liberado', contrato: '6003' });
      const { status, body: answer } = await postWebhook(body, SECRET_ALFA);

      // The 404 is what keeps a survey of panels from noticing SGP here at
      // all, and it survives the deployment having more than one provider.
      assert.equal(status, 404);
      assert.deepEqual(answer, { success: false, code: 'webhook_disabled' });
    } finally {
      await runInTenant(alfa, () => SgpService.saveConfig({ webhookEnabled: true }));
      await runInTenant(beta, () => SgpService.saveConfig({ webhookEnabled: true }));
    }
  });

  it('leaves every other request resolving to the first provider', async () => {
    // The webhook opens its own scope and nothing else changed: an ordinary
    // authenticated request still carries no provider hint and still resolves
    // the way it always did.
    const { status, body } = await call(`${panelUrl}/api/sgp/events?limit=200`, {
      headers: authHeaders(adminToken)
    });

    assert.equal(status, 200);
    const contracts = body.data.events.map((event) => event.contract);
    assert.ok(contracts.includes(SHARED_CONTRACT));
    // Beta's own contract was stored by Beta's own delivery and must not be
    // readable from a session that belongs to Alfa.
    assert.ok(!contracts.includes(BETA_ONLY_CONTRACT));
  });
});

describe('reading one provider\'s log', () => {
  before(async () => {
    await runInTenant(beta, () => SgpEvent.insertIfNew(eventRow({
      dedupe_key: 'seed:beta-pendente', contract: '9101', status: 'pending'
    })));
  });

  it('never returns another provider\'s row through any reader', async () => {
    const seen = await runInTenant(alfa, async () => ({
      all: await SgpEvent.list({ limit: 200 }),
      byContract: await SgpEvent.list({ contract: '9101' }),
      pending: await SgpEvent.getPending(100),
      byKey: await SgpEvent.getByDedupeKey('seed:beta-pendente')
    }));

    const foreign = await raw({ tenant_id: beta }).first();
    assert.ok(foreign, 'the other provider does have rows to leak');

    for (const rows of [seen.all, seen.pending]) {
      assert.ok(rows.every((row) => Number(row.tenant_id) === Number(alfa)));
    }
    assert.deepEqual(seen.byContract, []);
    assert.equal(seen.byKey, null);
    assert.equal(await runInTenant(alfa, () => SgpEvent.getById(foreign.id)), null);
  });

  it('counts and updates only its own', async () => {
    const foreign = await raw({ dedupe_key: 'seed:beta-pendente' }).first();

    const counts = await runInTenant(alfa, () => SgpEvent.countByStatus());
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    assert.equal(total, (await raw({ tenant_id: alfa })).length);

    // An id from another provider updates nothing, rather than editing a row
    // the caller cannot even read.
    assert.equal(await runInTenant(alfa, () => SgpEvent.update(foreign.id, { status: 'failed' })), null);
    assert.equal((await raw({ id: foreign.id }).first()).status, 'pending');
  });
});

describe('pruning settled history', () => {
  // MySQL's TIMESTAMP holds whole seconds, so the seeded times are whole
  // seconds: a fractional one is rounded there and not here.
  const OLD = new Date('2024-01-01T00:00:00Z');
  const CUTOFF = new Date('2024-06-01T00:00:00Z');

  before(async () => {
    const seeds = [
      ['prune:alfa-processado', 'processed'],
      ['prune:alfa-ignorado', 'ignored'],
      ['prune:alfa-pendente', 'pending']
    ];
    for (const [key, status] of seeds) {
      await runInTenant(alfa, () => SgpEvent.insertIfNew(eventRow({
        dedupe_key: key, contract: '9200', status
      })));
      await runInTenant(beta, () => SgpEvent.insertIfNew(eventRow({
        dedupe_key: key, contract: '9200', status
      })));
    }
    // Written after the insert: the model stamps `updated_at` itself, and what
    // is being tested is what the cutoff selects.
    await raw({ contract: '9200' }).update({ updated_at: OLD });
  });

  it('deletes this provider\'s settled rows and leaves the other\'s standing', async () => {
    const deleted = await runInTenant(alfa, () => SgpEvent.pruneOlderThan(CUTOFF));
    assert.equal(deleted, 2);

    const survivors = await raw({ contract: '9200' }).orderBy('id', 'asc');
    const theirs = survivors.filter((row) => Number(row.tenant_id) === Number(beta));
    // The point of the whole conversion: one ISP's retention window is not an
    // instruction to delete every other ISP's history.
    assert.equal(theirs.length, 3);
    assert.deepEqual(
      theirs.map((row) => row.dedupe_key).sort(),
      ['prune:alfa-ignorado', 'prune:alfa-pendente', 'prune:alfa-processado']
    );

    // A pending event is still work to do, whatever its age.
    const mine = survivors.filter((row) => Number(row.tenant_id) === Number(alfa));
    assert.deepEqual(mine.map((row) => row.dedupe_key), ['prune:alfa-pendente']);
  });

  it('refuses to prune with no provider in scope', async () => {
    await assert.rejects(() => SgpEvent.pruneOlderThan(CUTOFF), { name: 'TenantScopeError' });
    assert.ok((await raw({ tenant_id: beta })).length > 0);
  });
});
