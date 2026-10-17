import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertReturningId, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Vendor } = await import('../src/models/Vendor.js');
const { default: WifiSecurityConfig } = await import('../src/models/WifiSecurityConfig.js');

/**
 * Two rows a provider should not be able to have twice.
 *
 * The product-class one is the bug: `getByProductClass` takes `.first()`, so a
 * second config for the same class does not compete with the first — it simply
 * never applies. An operator who adds a corrected config beside an old one
 * watches the old one keep winning, with nothing on screen saying why. The
 * duplicate vendor NAME is milder — the name is not what detection matches on —
 * but the list is how an operator finds the row they mean to edit, and two rows
 * called "ZTE" make that a guess.
 *
 * Refused at the model rather than by a database constraint, and that is a
 * deliberate limit: a unique index added by migration would fail on an
 * installation that already holds duplicates, which strands an upgrade halfway.
 * This stops NEW ones on every engine, today; the constraint can follow once
 * installs are known clean.
 */
let alfa;
let beta;

before(async () => {
  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', {
    slug: 'beta', name: 'Provedor Beta', status: 'active'
  });
});

after(async () => {
  await stopTestServers();
});

const vendorPayload = (name) => ({
  name,
  manufacturer_patterns: 'ZTE',
  product_patterns: 'F670L',
  wifi_password_path: 'Device.WiFi.X'
});

const configPayload = (productClass) => ({
  product_class: productClass,
  security_types: 'WPA2',
  password_param_path: 'Device.WiFi.AccessPoint.1.Security.KeyPassphrase'
});

describe('a second config for the same product class', () => {
  it('is refused rather than added where it would never apply', async () => {
    await runInTenant(alfa, async () => {
      assert.ok(await WifiSecurityConfig.create(configPayload('F670L')));
      assert.equal(await WifiSecurityConfig.create(configPayload('F670L')), null);
    });
  });

  it('is refused whatever the case, because the reader ignores case too', async () => {
    await runInTenant(alfa, async () => {
      assert.equal(await WifiSecurityConfig.create(configPayload('f670l')), null);
    });
  });

  it('does not stop another provider from having its own', async () => {
    await runInTenant(beta, async () => {
      assert.ok(await WifiSecurityConfig.create(configPayload('F670L')));
    });
  });

  /**
   * The case that nearly shipped broken: the id arrives from a route parameter
   * as a STRING, so a row compared strictly against a number does not recognise
   * itself — and every edit that kept its own product class would be refused as
   * a duplicate of itself.
   */
  it('lets a row keep its own product class through an edit, id as a string', async () => {
    const id = await runInTenant(alfa, async () => {
      const row = await WifiSecurityConfig.getByProductClass('F670L');
      return row.id;
    });
    await runInTenant(alfa, async () => {
      assert.equal(
        await WifiSecurityConfig.update(String(id), configPayload('F670L')),
        true,
        'a row is not its own duplicate'
      );
    });
  });

  it('answers not-found, never duplicate, for another provider row', async () => {
    const betaId = await runInTenant(beta, async () => {
      const row = await WifiSecurityConfig.getByProductClass('F670L');
      return row.id;
    });
    await runInTenant(alfa, async () => {
      assert.equal(
        await WifiSecurityConfig.update(String(betaId), configPayload('F670L')),
        false,
        'the row is not this provider to edit, and saying "duplicate" would describe one it cannot see'
      );
    });
  });
});

describe('a second vendor by the same name', () => {
  it('is refused inside one provider', async () => {
    await runInTenant(alfa, async () => {
      assert.ok(await Vendor.create(vendorPayload('ZTE')));
      assert.equal(await Vendor.create(vendorPayload('zte')), null);
    });
  });

  it('does not stop another provider from having one', async () => {
    await runInTenant(beta, async () => {
      assert.ok(await Vendor.create(vendorPayload('ZTE')));
    });
  });

  it('lets a vendor keep its own name through an edit, id as a string', async () => {
    const id = await runInTenant(alfa, async () => {
      const rows = await Vendor.getAll();
      return rows.find((row) => row.name === 'ZTE').id;
    });
    await runInTenant(alfa, async () => {
      assert.equal(await Vendor.update(String(id), vendorPayload('ZTE')), true);
    });
  });
});
