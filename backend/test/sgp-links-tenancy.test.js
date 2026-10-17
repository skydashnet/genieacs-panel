import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: WaConversationService } = await import('../src/services/waConversationService.js');

/**
 * The contract cadastre, once it belongs to one provider at a time.
 *
 * `sgp_links` is what turns a device id into a subscriber, so it is also what
 * the WhatsApp side resolves an inbound phone number against. Deployment-wide
 * it was the last place where one provider's operator could type a number and
 * be handed another provider's contract, name and document — and where the
 * self-service bot could read that subscriber's data to whoever held the
 * phone. Resolving a number to a subscriber is still convenience and never
 * authentication; what changes here is that it stops leaking across providers.
 *
 * The two rows carry the SAME `device_id` on purpose. Two providers reading
 * their own GenieACS do see the same ids, which is exactly what the old global
 * unique made impossible and what 0017's `['tenant_id', 'device_id']` allows.
 */
let alfa;
let beta;

const DEVICE = 'ONT-COLLIDE-SGP-1';
const CONTRACT_ALFA = '4001';
const CONTRACT_BETA = '9002';
const PHONE_ALFA = '5511900000001';
const PHONE_BETA = '5511900000002';

const linkRow = (contract, phone, name) => ({
  device_id: DEVICE,
  contract,
  client_name: name,
  document: '12345678909',
  plan: 'Fibra 1GB',
  phone_e164: phone,
  link_mode: 'auto'
});

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // Written through the model, so the upsert inside a provider's scope is
  // itself part of what these tests prove.
  await runInTenant(alfa, () => SgpLink.upsert(linkRow(CONTRACT_ALFA, PHONE_ALFA, 'Assinante Alfa')));
  await runInTenant(beta, () => SgpLink.upsert(linkRow(CONTRACT_BETA, PHONE_BETA, 'Assinante Beta')));
});

after(async () => {
  await stopTestServers();
});

/** The rows as the database holds them, provider and all — never through a model. */
const raw = (where) => getDb()('sgp_links').where(where);

describe('two providers cataloguing the same device id', () => {
  it('lets both keep a row for it', async () => {
    const rows = await raw({ device_id: DEVICE }).orderBy('id', 'asc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.tenant_id)).sort(),
      [Number(alfa), Number(beta)].sort()
    );
  });

  it('shows each provider only its own', async () => {
    const mine = await runInTenant(alfa, () => SgpLink.getByDeviceId(DEVICE));
    const theirs = await runInTenant(beta, () => SgpLink.getByDeviceId(DEVICE));

    assert.equal(mine.contract, CONTRACT_ALFA);
    assert.equal(theirs.contract, CONTRACT_BETA);
    assert.notEqual(mine.id, theirs.id);
  });

  it('never returns the other provider\'s row through any reader', async () => {
    const seen = await runInTenant(alfa, async () => ({
      all: await SgpLink.getAll(),
      byIds: await SgpLink.getByDeviceIds([DEVICE]),
      page: await SgpLink.listAfterId(0, 50),
      byContract: await SgpLink.getByContract(CONTRACT_BETA),
      count: await SgpLink.count()
    }));

    for (const rows of [seen.all, seen.byIds, seen.page]) {
      assert.deepEqual(rows.map((row) => row.contract), [CONTRACT_ALFA]);
    }
    // Contract numbers are the provider's own sequence, so two providers can
    // hand out the same one. Alfa asking for Beta's must find nothing.
    assert.deepEqual(seen.byContract, []);
    assert.equal(seen.count, 1);
  });

  it('leaves the other provider\'s row standing through a delete', async () => {
    const row = linkRow('4002', '5511900000003', 'Assinante Alfa Dois');
    row.device_id = 'ONT-COLLIDE-SGP-2';
    await runInTenant(alfa, () => SgpLink.upsert(row));
    await runInTenant(beta, () => SgpLink.upsert({ ...row, contract: '9003' }));

    assert.equal(await runInTenant(alfa, () => SgpLink.deleteByDeviceId(row.device_id)), true);

    const survivors = await raw({ device_id: row.device_id });
    assert.equal(survivors.length, 1);
    assert.equal(Number(survivors[0].tenant_id), Number(beta));
  });

  it('corrects a number only on its own provider\'s rows', async () => {
    await runInTenant(alfa, () => SgpLink.setManualPhone(CONTRACT_ALFA, '5511911111111'));

    const mine = await raw({ tenant_id: alfa, contract: CONTRACT_ALFA }).first();
    const theirs = await raw({ tenant_id: beta, contract: CONTRACT_BETA }).first();
    assert.equal(mine.phone_manual, '5511911111111');
    assert.equal(theirs.phone_manual, null);
  });
});

describe('the upsert, now that the unique is per provider', () => {
  it('updates its own row instead of inserting a second one', async () => {
    const updated = await runInTenant(
      alfa,
      () => SgpLink.upsert(linkRow(CONTRACT_ALFA, PHONE_ALFA, 'Assinante Alfa Renomeado'))
    );

    assert.equal(updated.client_name, 'Assinante Alfa Renomeado');
    assert.equal(Number(updated.tenant_id), Number(alfa));
    assert.equal((await raw({ device_id: DEVICE })).length, 2);
  });

  it('does not touch the other provider\'s row for the same device', async () => {
    const theirs = await raw({ tenant_id: beta, device_id: DEVICE }).first();
    assert.equal(theirs.client_name, 'Assinante Beta');
    assert.equal(theirs.contract, CONTRACT_BETA);
  });

  it('refuses to write outside a provider', async () => {
    await assert.rejects(
      () => SgpLink.upsert(linkRow('4003', '5511900000004', 'Sem Provedor')),
      { name: 'TenantScopeError' }
    );
  });
});

describe('resolving an inbound phone number', () => {
  it('finds the subscriber the number belongs to in this provider', async () => {
    const { link, matchedOn } = await runInTenant(
      alfa,
      () => WaConversationService.resolveSubscriber(PHONE_ALFA)
    );

    assert.equal(link.contract, CONTRACT_ALFA);
    assert.equal(matchedOn, 'sgp');
  });

  // The point of the whole change. A number that exists only in Beta's
  // cadastre has to come back unknown to Alfa, not as a subscriber: the bot
  // answers a resolved contact with contract state and invoices.
  it('reports a number that exists only in another provider as unknown', async () => {
    const resolved = await runInTenant(
      alfa,
      () => WaConversationService.resolveSubscriber(PHONE_BETA)
    );

    assert.deepEqual(resolved, { link: null, account: null, matchedOn: null });
  });

  it('does not leak the other provider\'s number through the manual override', async () => {
    await runInTenant(beta, () => SgpLink.setManualPhone(CONTRACT_BETA, '5511922222222'));

    const resolved = await runInTenant(
      alfa,
      () => WaConversationService.resolveSubscriber('5511922222222')
    );
    assert.equal(resolved.link, null);
  });

  it('does not match the other provider\'s subscriber by name', async () => {
    const found = await runInTenant(
      alfa,
      () => WaConversationService.contractsMatchingClientName('Assinante Beta')
    );

    assert.deepEqual(found, []);
  });
});
