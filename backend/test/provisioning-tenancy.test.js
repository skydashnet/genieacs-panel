import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: ProvisioningProfile } = await import('../src/models/ProvisioningProfile.js');
const { default: ProvisioningRun } = await import('../src/models/ProvisioningRun.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');

/**
 * Provisioning, once the rulebook and the history belong to one provider.
 *
 * Two things are being proved here and they are not the same thing. The first
 * is the ordinary leak: a profile holds an ISP's own plan rules and its own
 * encrypted credentials, a run names a device id and a contract that are only
 * unique inside the ISP that issued them, and neither may be read by the other
 * provider through any of the readers.
 *
 * The second is the one that made this lane urgent. `reapInterrupted` and
 * `pruneOlderThan` carried no identity column in their WHERE at all — a status
 * and a cutoff, nothing else. Deployment-wide that was merely coarse. The
 * moment the scheduler runs them once per provider, the unscoped version fails
 * or deletes every other provider's rows, and does it again on the next
 * provider's turn. Those two are covered by seeding a second provider's rows
 * and asserting they are still there afterwards.
 *
 * Both providers name a profile "Fibra" on purpose: `name` was unique
 * deployment-wide until 0023, so the second ISP to pick the obvious name was
 * refused it by a row it could not see.
 */
let alfa;
let beta;

const PROFILE_NAME = 'Fibra';
// One device id, both providers. Two ISPs reading their own GenieACS do hand
// out the same ids, so this is the realistic case and not a contrived one.
const DEVICE = 'ONT-COLLIDE-PROV-1';

// MySQL's TIMESTAMP stores whole seconds, so a seeded time with milliseconds on
// it comes back rounded and a cutoff computed against it lands on the wrong
// side. Every timestamp this file writes is truncated to the second.
const secondsAgo = (seconds) => new Date(Math.floor(Date.now() / 1000 - seconds) * 1000);

const profileRow = (overrides = {}) => ({
  name: PROFILE_NAME,
  plan_patterns: JSON.stringify(['fibra']),
  priority: 20,
  enabled: true,
  ...overrides
});

/** The rows as the database holds them, provider column and all — never through a model. */
const raw = (where) => getDb()('provisioning_runs').where(where);
const rawProfiles = (where) => getDb()('provisioning_profiles').where(where);

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

describe('two providers naming a profile the same', () => {
  let alfaProfile;
  let betaProfile;

  before(async () => {
    // Written through the model, so the insert landing under the right
    // provider is itself part of what this proves.
    alfaProfile = await runInTenant(alfa, () => ProvisioningProfile.create(profileRow({
      description: 'Regras do Provedor Alfa'
    })));
    betaProfile = await runInTenant(beta, () => ProvisioningProfile.create(profileRow({
      description: 'Regras do Provedor Beta',
      priority: 5
    })));
  });

  it('lets both keep one, which the old global unique forbade', async () => {
    const rows = await rawProfiles({ name: PROFILE_NAME }).orderBy('id', 'asc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.tenant_id)).sort(),
      [Number(alfa), Number(beta)].sort()
    );
  });

  it('never hands one provider the other\'s profile, through any reader', async () => {
    const seen = await runInTenant(alfa, async () => ({
      all: await ProvisioningProfile.getAll(),
      enabled: await ProvisioningProfile.getEnabled(),
      byName: await ProvisioningProfile.getByName(PROFILE_NAME),
      byTheirId: await ProvisioningProfile.getById(betaProfile.id),
      count: await ProvisioningProfile.count(),
      countEnabled: await ProvisioningProfile.countEnabled()
    }));

    for (const rows of [seen.all, seen.enabled]) {
      assert.deepEqual(rows.map((row) => row.id), [alfaProfile.id]);
    }
    assert.equal(seen.byName.id, alfaProfile.id);
    assert.equal(seen.byName.description, 'Regras do Provedor Alfa');
    // The whole point: Beta's id is a real row, and Alfa asking for it by
    // number must be told there is no such profile rather than handed it.
    assert.equal(seen.byTheirId, null);
    assert.equal(seen.count, 1);
    assert.equal(seen.countEnabled, 1);
  });

  it('edits and deletes only its own, even when handed the other\'s id', async () => {
    // An id from the other provider reaching `update` or `delete` is what the
    // controller's 404 path depends on: neither may match a row.
    const updated = await runInTenant(
      alfa,
      () => ProvisioningProfile.update(betaProfile.id, { priority: 99 })
    );
    assert.equal(updated, null);
    assert.equal(await runInTenant(alfa, () => ProvisioningProfile.delete(betaProfile.id)), false);

    const theirs = await rawProfiles({ id: betaProfile.id }).first();
    assert.equal(theirs.priority, 5);
    assert.equal(theirs.description, 'Regras do Provedor Beta');
  });

  it('refuses to read or write a profile with no provider in scope', async () => {
    await assert.rejects(() => ProvisioningProfile.getAll(), { name: 'TenantScopeError' });
    await assert.rejects(
      () => ProvisioningProfile.create(profileRow({ name: 'Sem Provedor' })),
      { name: 'TenantScopeError' }
    );
  });

  it('never resolves a run\'s profile_id to another provider\'s profile', async () => {
    // `profile_id` is a plain integer key into a table both providers share, so
    // nothing in the schema stops a run from pointing across the boundary. What
    // must hold is that the lookup a reader does — profile id off the run, then
    // `getById` in the reader's own scope — cannot answer with the other
    // provider's rules or the name it gave them.
    const run = await runInTenant(alfa, () => ProvisioningRun.create({
      device_id: DEVICE,
      trigger: 'manual',
      status: 'success',
      profile_id: alfaProfile.id,
      profile_name: alfaProfile.name
    }));

    assert.equal(
      (await runInTenant(alfa, () => ProvisioningProfile.getById(run.profile_id))).description,
      'Regras do Provedor Alfa'
    );
    assert.equal(await runInTenant(beta, () => ProvisioningProfile.getById(run.profile_id)), null);

    // And the pathological direction: a run row that does point at the other
    // provider's profile still resolves to nothing for the provider reading it.
    await raw({ id: run.id }).update({ profile_id: betaProfile.id });
    const crossed = await runInTenant(alfa, () => ProvisioningRun.getById(run.id));
    assert.equal(Number(crossed.profile_id), Number(betaProfile.id));
    assert.equal(
      await runInTenant(alfa, () => ProvisioningProfile.getById(crossed.profile_id)),
      null
    );

    await raw({ id: run.id }).del();
  });
});

describe('two providers running against the same device id', () => {
  let alfaRun;
  let betaRun;

  before(async () => {
    alfaRun = await runInTenant(alfa, () => ProvisioningRun.create({
      device_id: DEVICE, trigger: 'poller', status: 'success', contract: '4001'
    }));
    betaRun = await runInTenant(beta, () => ProvisioningRun.create({
      device_id: DEVICE, trigger: 'poller', status: 'pending', contract: '9002'
    }));
  });

  after(async () => {
    await getDb()('provisioning_runs').del();
  });

  it('shows each provider only its own history', async () => {
    const seen = await runInTenant(alfa, async () => ({
      latest: await ProvisioningRun.getLatestByDeviceId(DEVICE),
      byDevice: await ProvisioningRun.listByDeviceId(DEVICE, 50),
      list: await ProvisioningRun.list({ limit: 50 }),
      byTheirId: await ProvisioningRun.getById(betaRun.id),
      active: await ProvisioningRun.getActiveByDeviceId(DEVICE),
      due: await ProvisioningRun.getDue(new Date(), 50)
    }));

    // Beta's row is the newer one and the only `pending` one, so an unfiltered
    // reader would return it for every one of these.
    assert.equal(seen.latest.id, alfaRun.id);
    assert.deepEqual(seen.byDevice.map((run) => run.contract), ['4001']);
    assert.deepEqual(seen.list.map((run) => run.contract), ['4001']);
    assert.equal(seen.byTheirId, null);
    assert.equal(seen.active, null);
    assert.deepEqual(seen.due, []);
  });

  it('does not let one provider\'s success settle the other\'s device', async () => {
    const seen = await runInTenant(beta, async () => ({
      hasSuccess: await ProvisioningRun.hasSuccess(DEVICE),
      settled: await ProvisioningRun.settledDeviceIds([DEVICE], new Date())
    }));

    // Alfa's run succeeded; Beta's device is still waiting. Read across the
    // boundary, Beta's poller would skip a device it has never provisioned.
    assert.equal(seen.hasSuccess, false);
    assert.equal(seen.settled.has(DEVICE), true, 'its own pending run settles it');

    await runInTenant(beta, () => ProvisioningRun.update(betaRun.id, { status: 'failed' }));
    const afterFailure = await runInTenant(
      beta,
      () => ProvisioningRun.settledDeviceIds([DEVICE], new Date())
    );
    assert.equal(afterFailure.has(DEVICE), false);
    await runInTenant(beta, () => ProvisioningRun.update(betaRun.id, { status: 'pending' }));
  });

  it('updates only its own row when handed the other provider\'s id', async () => {
    assert.equal(
      await runInTenant(alfa, () => ProvisioningRun.update(betaRun.id, { status: 'failed' })),
      null
    );
    assert.equal((await raw({ id: betaRun.id }).first()).status, 'pending');
  });
});

/**
 * The two sweeps whose WHERE names no identity column.
 *
 * Each seeds rows for both providers, runs the sweep as Alfa only, and asserts
 * Beta's rows are untouched — which is the assertion that fails if either
 * method loses its scope again.
 */
describe('the deployment-wide sweeps, now that they are per provider', () => {
  const OLD = () => secondsAgo(3600);
  const CUTOFF = () => secondsAgo(600);

  async function seed(tenantId, rows) {
    const created = [];
    for (const { aged_at: agedAt, ...row } of rows) {
      const run = await runInTenant(tenantId, () => ProvisioningRun.create(row));
      // `updated_at` is what both sweeps compare against, and the model stamps
      // it as now. Ageing it afterwards is the only way to put a row on the far
      // side of a cutoff without waiting an hour.
      await raw({ id: run.id }).update({ updated_at: agedAt });
      created.push(run.id);
    }
    return created;
  }

  beforeEach(async () => {
    await getDb()('provisioning_runs').del();
  });

  it('reaps only the interrupted runs of the provider doing the reaping', async () => {
    const [alfaStuck] = await seed(alfa, [
      { device_id: 'ONT-A-STUCK', trigger: 'poller', status: 'running', aged_at: OLD() }
    ]);
    const [betaStuck, betaFresh] = await seed(beta, [
      { device_id: 'ONT-B-STUCK', trigger: 'poller', status: 'running', aged_at: OLD() },
      { device_id: 'ONT-B-FRESH', trigger: 'poller', status: 'running', aged_at: secondsAgo(1) }
    ]);

    const failed = await runInTenant(alfa, () => ProvisioningRun.reapInterrupted(CUTOFF()));
    assert.equal(failed, 1, 'Alfa reaps exactly its own stuck run');

    assert.equal((await raw({ id: alfaStuck }).first()).status, 'failed');
    // Beta's process is alive and its run is genuinely in flight. Unscoped,
    // Alfa's boot would have failed it and put the device back into a backoff
    // for a run that is still writing to the ONT.
    assert.equal((await raw({ id: betaStuck }).first()).status, 'running');
    assert.equal((await raw({ id: betaStuck }).first()).error, null);
    assert.equal((await raw({ id: betaFresh }).first()).status, 'running');
  });

  it('prunes only the settled history of the provider whose retention it is', async () => {
    const [alfaOld, alfaRecent] = await seed(alfa, [
      { device_id: 'ONT-A-DONE', trigger: 'poller', status: 'success', aged_at: OLD() },
      { device_id: 'ONT-A-NEW', trigger: 'poller', status: 'success', aged_at: secondsAgo(1) }
    ]);
    const betaIds = await seed(beta, [
      { device_id: 'ONT-B-DONE', trigger: 'poller', status: 'success', aged_at: OLD() },
      { device_id: 'ONT-B-SKIP', trigger: 'poller', status: 'skipped', aged_at: OLD() },
      { device_id: 'ONT-B-GONE', trigger: 'poller', status: 'failed_permanent', aged_at: OLD() }
    ]);

    const deleted = await runInTenant(alfa, () => ProvisioningRun.pruneOlderThan(CUTOFF()));
    assert.equal(deleted, 1, 'Alfa deletes exactly its own aged row');

    assert.equal(await raw({ id: alfaOld }).first(), undefined);
    assert.ok(await raw({ id: alfaRecent }).first(), 'inside the window, so kept');
    // `runRetentionDays` is per-provider configuration, so Alfa's cutoff says
    // nothing about how long Beta agreed to keep its own history.
    const survivors = await getDb()('provisioning_runs').whereIn('id', betaIds);
    assert.equal(survivors.length, 3);
  });

  it('refuses to sweep at all with no provider in scope', async () => {
    await assert.rejects(
      () => ProvisioningRun.reapInterrupted(CUTOFF()),
      { name: 'TenantScopeError' }
    );
    await assert.rejects(
      () => ProvisioningRun.pruneOlderThan(CUTOFF()),
      { name: 'TenantScopeError' }
    );
  });
});

describe('the boot reaper, once there is more than one provider', () => {
  /**
   * `forSoleTenant` does not degrade when a second provider appears — it
   * REFUSES. So a job left on it is not a job that does less; it is a job that
   * stops. The reaper's own query is scoped, so nothing was keeping it there
   * except moving the scheduler in one piece, and the price of that tidiness
   * was every provider's interrupted runs sitting `running` for ever.
   */
  it('fails every provider\'s interrupted runs, not just the first one', async () => {
    const velho = secondsAgo(2 * 60 * 60);
    const doAlfa = await runInTenant(alfa, () => ProvisioningRun.create({
      device_id: 'ont-alfa-reap', status: 'running', trigger: 'poller'
    }));
    const doBeta = await runInTenant(beta, () => ProvisioningRun.create({
      device_id: 'ont-beta-reap', status: 'running', trigger: 'poller'
    }));
    for (const id of [doAlfa.id, doBeta.id]) {
      await getDb()('provisioning_runs').where({ id }).update({ updated_at: velho });
    }

    await SchedulerService.start();
    SchedulerService.stop();

    for (const [tenant, id, quem] of [[alfa, doAlfa.id, 'Alfa'], [beta, doBeta.id, 'Beta']]) {
      const row = await runInTenant(tenant, () => ProvisioningRun.getById(id));
      assert.equal(row.status, 'failed', `${quem}'s interrupted run should have been reaped`);
      assert.equal(row.error, 'provisioning.error.interrupted');
    }
  });
});

describe('the scheduler tick, once there is more than one provider', () => {
  /**
   * The last thing holding `tick` to one provider was `sgp_events`; with that
   * scoped, the loop divides the work instead of repeating it.
   *
   * The trap this covers is not the loop, it is the prune gate. `lastPruneAt`
   * is a counter on the class rather than a row, so decided INSIDE the loop the
   * first provider would set it and every provider after it would skip its own
   * prune — that day, and every day. The cadence is the deployment's; the rows
   * each pass deletes are the provider's.
   */
  it('prunes every provider on a prune day, not just the first', async () => {
    const velho = secondsAgo(400 * 24 * 60 * 60);
    const ids = {};
    for (const [tenant, quem] of [[alfa, 'alfa'], [beta, 'beta']]) {
      const run = await runInTenant(tenant, () => ProvisioningRun.create({
        device_id: `ont-${quem}-prune`, status: 'success', trigger: 'poller'
      }));
      ids[quem] = run.id;
      await getDb()('provisioning_runs').where({ id: run.id })
        .update({ updated_at: velho, created_at: velho });
    }

    // A prune day: the gate is a class counter, and zero is "never pruned".
    SchedulerService.lastPruneAt = 0;
    await SchedulerService.tick();

    for (const [tenant, quem] of [[alfa, 'alfa'], [beta, 'beta']]) {
      const row = await runInTenant(tenant, () => ProvisioningRun.getById(ids[quem]));
      assert.equal(row, null, `${quem}'s settled run should have been pruned too`);
    }
  });
});
