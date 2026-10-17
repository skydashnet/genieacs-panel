import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');

const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: SgpLink } = await import('../src/models/SgpLink.js');

// Reached directly, with no request behind them, so nothing has resolved a
// provider. The routes that call these are already inside one.
const ensureAccount = (input) => asTenant(() => CustomerService.ensureAccount(input));
const syncDevices = (...args) => asTenant(() => CustomerService.syncDevices(...args));
const upsertLink = (link) => asTenant(() => SgpLink.upsert(link));
const linkFor = (deviceId) => asTenant(() => SgpLink.getByDeviceId(deviceId));

let portalUrl;

async function enableAutoGeneration() {
  await asTenant(() => Setting.upsert('autoGenerateCustomerId', 'true'));
}

before(async () => {
  ({ portalUrl } = await startTestServers());
  await enableAutoGeneration();
});

after(async () => {
  await stopTestServers();
});

describe('a firmware upgrade is not a change of subscriber', () => {
  const DEVICE = 'ONT-FIRMWARE-1';

  it('keeps the account, Customer ID and portal password across a version bump', async () => {
    const before = await ensureAccount({
      _id: DEVICE, softwareId: 'V1.0.0', pppoe: 'firmware@isp'
    });
    const after = await ensureAccount({
      _id: DEVICE, softwareId: 'V2.5.1', pppoe: 'firmware@isp'
    });

    assert.equal(after.id, before.id);
    assert.equal(after.customer_id, before.customer_id);
    assert.equal(after.password_hash, before.password_hash);
    // The stored identity follows the device instead of going stale.
    assert.equal(after.software_id, 'V2.5.1');
  });

  it('treats a differently cased PPPoE login as the same subscriber', async () => {
    const before = await ensureAccount({
      _id: 'ONT-CASE-1', softwareId: 'V1.0.0', pppoe: 'MixedCase@isp'
    });
    const after = await ensureAccount({
      _id: 'ONT-CASE-1', softwareId: 'V1.0.0', pppoe: ' mixedcase@isp '
    });
    assert.equal(after.id, before.id);
  });
});

describe('an ONT re-provisioned for another subscriber', () => {
  const DEVICE = 'ONT-REUSE-1';
  let first;
  let second;

  before(async () => {
    first = await ensureAccount({
      _id: DEVICE, softwareId: 'V1.0.0', pppoe: 'subscriber-a@isp'
    });
    await upsertLink({
      device_id: DEVICE,
      account_id: first.id,
      contract: '11111',
      client_name: 'Subscriber A',
      document: '12345678901',
      link_mode: 'auto'
    });
    second = await ensureAccount({
      _id: DEVICE, softwareId: 'V3.0.0', pppoe: 'subscriber-b@isp'
    });
  });

  it('issues a new account instead of handing over the previous one', () => {
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.customer_id, first.customer_id);
    assert.notEqual(second.password_hash, first.password_hash);
    assert.equal(second.pppoe_username, 'subscriber-b@isp');
  });

  it('retires the previous account so its credentials stop working', async () => {
    const retired = await getDb()('customer_accounts').where({ id: first.id }).first();
    assert.equal(Boolean(retired.active), false);
    assert.notEqual(retired.device_id, DEVICE);

    const password = CustomerPortalPasswordService.reveal(
      await getDb()('customer_accounts').where({ id: first.id }).first()
    );
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: first.customer_id, password }
    });
    assert.equal(login.status, 401, 'a retired account must not be able to sign in');
  });

  it('drops the SGP contract bound to the previous subscriber', async () => {
    assert.equal(await linkFor(DEVICE), null);
  });

  it('lets the new subscriber sign in with their own credentials', async () => {
    const account = await getDb()('customer_accounts').where({ id: second.id }).first();
    const password = CustomerPortalPasswordService.reveal(account);
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: second.customer_id, password }
    });
    assert.equal(login.status, 200);
  });
});

describe('a replacement ONT for the same subscriber', () => {
  it('carries the Customer ID over to the new device', async () => {
    const original = await ensureAccount({
      _id: 'ONT-SWAP-OLD', softwareId: 'V1.0.0', pppoe: 'swap@isp'
    });
    // New hardware means a new GenieACS device ID and usually new firmware, so
    // the PPPoE login is the only identifier that still matches.
    const replacement = await ensureAccount({
      _id: 'ONT-SWAP-NEW', softwareId: 'V9.9.9', pppoe: 'swap@isp'
    });

    assert.equal(replacement.id, original.id);
    assert.equal(replacement.customer_id, original.customer_id);
    assert.equal(replacement.device_id, 'ONT-SWAP-NEW');
    assert.equal(replacement.software_id, 'V9.9.9');
  });
});

describe('fleet synchronization', () => {
  it('retires an inherited account when the sync sees a new PPPoE login', async () => {
    const DEVICE = 'ONT-SYNC-1';
    const previous = await ensureAccount({
      _id: DEVICE, softwareId: 'V1.0.0', pppoe: 'sync-a@isp'
    });

    // syncDevices used to skip every device that already had an account, so a
    // reassignment was never noticed.
    const ids = await syncDevices(
      [{ _id: DEVICE, softwareId: 'V1.0.0', pppoe: 'sync-b@isp' }],
      { enabled: true }
    );

    const current = ids.get(DEVICE);
    assert.ok(current, 'the device should still resolve to a Customer ID');
    assert.notEqual(current, previous.customer_id);

    const retired = await getDb()('customer_accounts').where({ id: previous.id }).first();
    assert.equal(Boolean(retired.active), false);
  });

  it('leaves an unchanged fleet alone', async () => {
    const DEVICE = 'ONT-SYNC-2';
    const account = await ensureAccount({
      _id: DEVICE, softwareId: 'V1.0.0', pppoe: 'sync-stable@isp'
    });
    const ids = await syncDevices(
      [{ _id: DEVICE, softwareId: 'V1.0.0', pppoe: 'sync-stable@isp' }],
      { enabled: true }
    );
    assert.equal(ids.get(DEVICE), account.customer_id);
  });
});
