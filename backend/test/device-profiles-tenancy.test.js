import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: DeviceProfile } = await import('../src/models/DeviceProfile.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { forEachTenant } = await import('../src/config/tenantJobs.js');

/**
 * The installation dates, once they belong to one provider at a time.
 *
 * `device_profiles` is small and looks harmless, which is why it was the last
 * table holding the Customer ID sweep to `forSoleTenant`. Its `device_id` was
 * UNIQUE deployment-wide, and two providers reading their own GenieACS do see
 * the same ids — so the second provider to save a date never got a row of its
 * own, it overwrote the first's. From there the date flowed into the suffix of
 * a Customer ID, which is how one ISP's install date ended up naming another
 * ISP's subscriber.
 *
 * The dates below differ on purpose: the suffix is what makes a wrong read
 * visible in the Customer ID rather than only in a column nobody looks at.
 */
let alfa;
let beta;

const DEVICE = 'ONT-COLLIDE-PROFILE-1';
const DATE_ALFA = '2023-01-05';
const DATE_BETA = '2024-07-09';
const SUFFIX_ALFA = '230105';
const SUFFIX_BETA = '240709';

// One subscriber identity, reported to both providers. Identical on purpose:
// `identity_hash` is sha256(softwareId, pppoe_username), so the sweep's own
// collision case runs alongside the profile's.
const SOFTWARE_ID = 'V4.0.0-BUILD2';
const PPPOE = 'assinante@isp';
const device = (id = DEVICE) => ({ _id: id, softwareId: SOFTWARE_ID, pppoe: PPPOE });

/**
 * The boot job from `server.js`, with the GenieACS read replaced by a fixture.
 * Everything that matters here is below that read: the sweep now runs once per
 * provider, inside each provider's own scope, and both providers are handed the
 * same device id because that is what two ACS installations actually report.
 */
const sweep = (devices) => forEachTenant(async () => {
  if (!await CustomerService.isAutoGenerationEnabled()) return null;
  return devices.length ? CustomerService.syncDevices(devices, { enabled: true }) : null;
});

/** The rows as the database holds them, provider and all — never through a model. */
const raw = (table, where) => getDb()(table).where(where);

/** The day a DATE column names, whether the engine returns a string or a Date. */
const day = (value) => (value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10));

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  for (const tenant of [alfa, beta]) {
    await runInTenant(tenant, async () => {
      await Setting.upsert('autoGenerateCustomerId', 'true');
      await Setting.upsert('customerIdSuffixMode', 'installation_date');
    });
  }

  // Written through the model, so the upsert inside a provider's scope is
  // itself part of what these tests prove.
  await runInTenant(alfa, () => DeviceProfile.upsertInstallationDate(DEVICE, DATE_ALFA, 'TAG-A'));
  await runInTenant(beta, () => DeviceProfile.upsertInstallationDate(DEVICE, DATE_BETA, 'TAG-B'));
});

after(async () => {
  await stopTestServers();
});

describe('two providers dating the same device id', () => {
  it('lets both keep a profile for it', async () => {
    const rows = await raw('device_profiles', { device_id: DEVICE }).orderBy('id', 'asc');

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.tenant_id)).sort(),
      [Number(alfa), Number(beta)].sort()
    );
  });

  it('shows each provider only its own', async () => {
    const mine = await runInTenant(alfa, () => DeviceProfile.getByDeviceId(DEVICE));
    const theirs = await runInTenant(beta, () => DeviceProfile.getByDeviceId(DEVICE));

    assert.equal(day(mine.installation_date), DATE_ALFA);
    assert.equal(mine.installation_tag, 'TAG-A');
    assert.equal(day(theirs.installation_date), DATE_BETA);
    assert.equal(theirs.installation_tag, 'TAG-B');
    assert.notEqual(mine.id, theirs.id);
  });

  it('reports a device only the other provider has dated as undated', async () => {
    await runInTenant(beta, () => DeviceProfile.upsertInstallationDate('ONT-BETA-ONLY', DATE_BETA, 'TAG-B'));

    assert.equal(await runInTenant(alfa, () => DeviceProfile.getByDeviceId('ONT-BETA-ONLY')), null);
  });

  it('refuses to read or write outside a provider', async () => {
    await assert.rejects(() => DeviceProfile.getByDeviceId(DEVICE), { name: 'TenantScopeError' });
    await assert.rejects(
      () => DeviceProfile.upsertInstallationDate('ONT-NO-PROVIDER', DATE_ALFA, 'TAG-X'),
      { name: 'TenantScopeError' }
    );
  });
});

// The bug the old global unique caused, asserted head-on: the write path picks
// insert or update from a read of the same table, so an unfiltered read made
// the second provider's save an edit of the first provider's row.
describe('saving a date for a device the other provider has already dated', () => {
  const SHARED = 'ONT-COLLIDE-PROFILE-2';

  it('creates the second provider its own row', async () => {
    const mine = await runInTenant(alfa, () => DeviceProfile.upsertInstallationDate(SHARED, DATE_ALFA, 'TAG-A'));
    const theirs = await runInTenant(beta, () => DeviceProfile.upsertInstallationDate(SHARED, DATE_BETA, 'TAG-B'));

    assert.notEqual(mine.id, theirs.id);
    assert.equal(Number(mine.tenant_id), Number(alfa));
    assert.equal(Number(theirs.tenant_id), Number(beta));
    assert.equal((await raw('device_profiles', { device_id: SHARED })).length, 2);
  });

  it('leaves the first provider\'s date exactly as it was', async () => {
    const mine = await raw('device_profiles', { tenant_id: alfa, device_id: SHARED }).first();

    assert.equal(day(mine.installation_date), DATE_ALFA);
    assert.equal(mine.installation_tag, 'TAG-A');
  });

  it('updates its own row on the next save instead of adding another', async () => {
    const again = await runInTenant(beta, () => DeviceProfile.upsertInstallationDate(SHARED, '2025-03-02', 'TAG-B2'));

    assert.equal(day(again.installation_date), '2025-03-02');
    assert.equal((await raw('device_profiles', { device_id: SHARED })).length, 2);
    assert.equal(
      day((await raw('device_profiles', { tenant_id: alfa, device_id: SHARED }).first()).installation_date),
      DATE_ALFA
    );
  });
});

describe('the Customer ID sweep, per provider', () => {
  let mine;
  let theirs;

  it('mints each provider an account from its own installation date', async () => {
    await sweep([device()]);

    const rows = await raw('customer_accounts', { device_id: DEVICE }).orderBy('id', 'asc');
    mine = rows.find((row) => Number(row.tenant_id) === Number(alfa));
    theirs = rows.find((row) => Number(row.tenant_id) === Number(beta));

    assert.equal(rows.length, 2);
    // The suffix is the whole proof: read across providers, both accounts
    // would carry whichever date happened to be stored under the device id.
    assert.ok(mine.customer_id.endsWith(SUFFIX_ALFA), `${mine.customer_id} should end with ${SUFFIX_ALFA}`);
    assert.ok(theirs.customer_id.endsWith(SUFFIX_BETA), `${theirs.customer_id} should end with ${SUFFIX_BETA}`);
  });

  it('leaves the other provider\'s account untouched on the next pass', async () => {
    await sweep([device()]);

    const rows = await raw('customer_accounts', { device_id: DEVICE }).orderBy('id', 'asc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [Number(row.tenant_id), row.customer_id]).sort(),
      [[Number(alfa), mine.customer_id], [Number(beta), theirs.customer_id]].sort()
    );
    // A retirement renames `device_id` to `retired:<id>`. One provider's pass
    // seeing the other's account for the same device would have retired it,
    // because the PPPoE login it carries belongs to a subscriber it cannot see.
    // `where(..., 'like', ...)` and NOT knex's `whereLike`: that helper asks for
    // a case-SENSITIVE match, which MySQL implements by appending
    // `COLLATE utf8_bin` — a utf8mb3 collation the server refuses against a
    // utf8mb4 column. Case does not matter here anyway; the prefix is a literal
    // this codebase writes itself.
    assert.equal((await getDb()('customer_accounts').where('device_id', 'like', 'retired:%')).length, 0);
  });

  it('does not mint a provider an id out of a date it never recorded', async () => {
    await runInTenant(alfa, () => DeviceProfile.upsertInstallationDate('ONT-ALFA-ONLY', DATE_ALFA, 'TAG-A'));
    await sweep([{ _id: 'ONT-ALFA-ONLY', softwareId: 'V9.9.9', pppoe: 'somente.alfa@isp' }]);

    // Both providers were handed the device — that is what two ACS reporting
    // the same id looks like — but only Alfa has dated it. Beta's pass finds no
    // profile of its own and mints nothing, where an unfiltered read would have
    // stamped Alfa's install date onto Beta's subscriber.
    const rows = await raw('customer_accounts', { device_id: 'ONT-ALFA-ONLY' });

    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].tenant_id), Number(alfa));
    assert.ok(rows[0].customer_id.endsWith(SUFFIX_ALFA));
  });
});
