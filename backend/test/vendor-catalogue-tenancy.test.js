import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Vendor } = await import('../src/models/Vendor.js');
const { default: WifiSecurityConfig } = await import('../src/models/WifiSecurityConfig.js');
const { default: VendorService } = await import('../src/services/vendorService.js');
const { seedDefaults } = await import('../src/config/seed.js');

/**
 * The equipment catalogue, once it belongs to one provider at a time.
 *
 * Both providers describe the same ZTE with the same name and the same product
 * class, which is the realistic case rather than a contrived one: the hardware
 * is the same everywhere, so two ISPs cataloguing it independently write the
 * same words. What differs is the paths they have corrected, and correcting a
 * path is exactly what the panel is for — which is why these tables became
 * per-provider even though their content is a fact about firmware.
 *
 * Two failures are being proved out, and they are not the same one. Reads
 * leaking is the mild one. `Vendor.update` and `Vendor.delete`, and the two
 * deletes below them, take a bare id off the URL, so unscoped they edit and
 * remove another provider's rows.
 *
 * Havia uma terceira, e ela some junto com a tabela: `vendors` era pai de
 * `wifi_security_mappings` com ON DELETE CASCADE, então apagar um fabricante
 * levava os mapeamentos de OUTRO provedor — uma escrita destrutiva cujo alcance
 * quem apagava não conseguia nem ver. A 0052 derrubou aquela tabela, que nunca
 * teve leitor em runtime, e com ela o único caminho de cascata entre provedores
 * que o catálogo tinha.
 */
let alfa;
let beta;

const VENDOR_NAME = 'ZTE';
const PRODUCT_CLASS = 'F670L';

const vendorRow = (overrides = {}) => ({
  name: VENDOR_NAME,
  manufacturer_patterns: ['zte'],
  product_patterns: ['f670'],
  parameter_prefix: 'X_ZTE-COM_WANPONInterfaceConfig',
  wifi_password_path: 'PreSharedKey.1.KeyPassphrase',
  priority: 20,
  enabled: 1,
  description: 'Alfa',
  ...overrides
});

/** The rows as the database holds them, provider column and all — never through a model. */
const rawVendors = (where) => getDb()('vendors').where(where);
const rawConfigs = (where) => getDb()('wifi_security_config').where(where);

const count = async (query) => {
  const [row] = await query.count({ n: '*' });
  return Number(row.n);
};

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

describe('two providers cataloguing the same equipment', () => {
  let alfaVendor;
  let betaVendor;

  before(async () => {
    // Written through the models, so the whole path — insert, remap, read — is
    // itself part of what is under test.
    alfaVendor = await runInTenant(alfa, () => Vendor.create(vendorRow()));
    betaVendor = await runInTenant(
      beta,
      () => Vendor.create(vendorRow({
        description: 'Beta',
        wifi_password_path: 'PreSharedKey.2.KeyPassphrase'
      }))
    );
  });

  it('lets both keep a vendor of the same name', async () => {
    const rows = await rawVendors({ name: VENDOR_NAME }).orderBy('id', 'asc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.tenant_id)).sort(),
      [Number(alfa), Number(beta)].sort()
    );
  });

  it('never returns the other provider\'s vendor through any reader', async () => {
    const seen = await runInTenant(alfa, async () => ({
      all: await Vendor.getAll(),
      enabled: await Vendor.getEnabled(),
      theirs: await Vendor.findById(betaVendor)
    }));

    assert.deepEqual(seen.all.map((row) => row.id), [alfaVendor]);
    assert.deepEqual(seen.enabled.map((row) => row.id), [alfaVendor]);
    // Not a 403-shaped answer: the id has to read as absent, because saying
    // "exists but not yours" is itself the leak.
    assert.equal(seen.theirs, null);
  });

  it('detects the vendor this provider described, not the other\'s', async () => {
    const mine = await runInTenant(
      alfa,
      () => VendorService.detectVendor('ZTE Corporation', PRODUCT_CLASS, null)
    );
    const theirs = await runInTenant(
      beta,
      () => VendorService.detectVendor('ZTE Corporation', PRODUCT_CLASS, null)
    );

    assert.equal(mine.id, alfaVendor);
    assert.equal(theirs.id, betaVendor);
    assert.equal(mine.wifi_password_path, 'PreSharedKey.1.KeyPassphrase');
    assert.equal(theirs.wifi_password_path, 'PreSharedKey.2.KeyPassphrase');
  });

  it('refuses to write a vendor outside a provider', async () => {
    await assert.rejects(
      () => Vendor.create(vendorRow({ name: 'Sem Provedor' })),
      { name: 'TenantScopeError' }
    );
  });

  it('leaves the other provider\'s vendor standing through an update', async () => {
    assert.equal(
      await runInTenant(alfa, () => Vendor.update(betaVendor, vendorRow({ name: 'Sequestrado' }))),
      false
    );

    const theirs = await rawVendors({ id: betaVendor }).first();
    assert.equal(theirs.name, VENDOR_NAME);
    assert.equal(theirs.description, 'Beta');
  });

  it('deletes nothing when it is handed the other provider\'s id', async () => {
    assert.equal(await runInTenant(alfa, () => Vendor.delete(betaVendor)), false);

    assert.equal(await count(rawVendors({ id: betaVendor })), 1);
    assert.equal(await count(rawVendors({ id: alfaVendor })), 1);
  });
});

describe('the WiFi parameter path per product class', () => {
  let alfaConfig;
  let betaConfig;

  before(async () => {
    alfaConfig = await runInTenant(alfa, () => WifiSecurityConfig.create({
      product_class: PRODUCT_CLASS,
      security_types: ['WPA2', 'WPA3'],
      password_param_path: 'PreSharedKey.1.KeyPassphrase'
    }));
    betaConfig = await runInTenant(beta, () => WifiSecurityConfig.create({
      product_class: PRODUCT_CLASS,
      security_types: ['WPA2'],
      password_param_path: 'KeyPassphrase'
    }));
  });

  // The lookup is case-insensitive because a product class is whatever the CPE
  // reported. The lowercase spelling is asked for on purpose: it has to keep
  // matching the row, and still only this provider's.
  it('matches its own provider\'s row, whatever the case', async () => {
    const mine = await runInTenant(
      alfa,
      () => WifiSecurityConfig.getByProductClass(PRODUCT_CLASS.toLowerCase())
    );
    const theirs = await runInTenant(
      beta,
      () => WifiSecurityConfig.getByProductClass(PRODUCT_CLASS.toLowerCase())
    );

    assert.equal(mine.id, alfaConfig);
    assert.equal(theirs.id, betaConfig);
    assert.equal(mine.password_param_path, 'PreSharedKey.1.KeyPassphrase');
    assert.deepEqual(mine.security_types_array, ['WPA2', 'WPA3']);
  });

  it('finds nothing when only the other provider has the product class', async () => {
    await runInTenant(beta, () => WifiSecurityConfig.create({
      product_class: 'HG8245Q2',
      security_types: ['WPA2'],
      password_param_path: 'KeyPassphrase'
    }));

    const found = await runInTenant(alfa, () => WifiSecurityConfig.getByProductClass('HG8245Q2'));
    assert.equal(found, null);

    const listed = await runInTenant(alfa, () => WifiSecurityConfig.getAll());
    assert.deepEqual(listed.map((row) => row.product_class), [PRODUCT_CLASS]);
  });

  it('leaves the other provider\'s config standing through a delete and an update', async () => {
    assert.equal(await runInTenant(alfa, () => WifiSecurityConfig.delete(betaConfig)), false);
    assert.equal(
      await runInTenant(alfa, () => WifiSecurityConfig.update(betaConfig, {
        product_class: PRODUCT_CLASS,
        security_types: ['NONE'],
        password_param_path: 'Sequestrado'
      })),
      false
    );

    const survivor = await rawConfigs({ id: betaConfig }).first();
    assert.equal(survivor.password_param_path, 'KeyPassphrase');
    assert.equal(survivor.security_types, 'WPA2');
  });
});

/**
 * The half of the slice the schema cannot do.
 *
 * Nothing seeds `vendors` — the catalogue is the operator's work — so a
 * provider created after 0026 boots with nothing, and nothing is the failure
 * that never announces itself: detection matches no vendor and the WiFi write
 * has no path to use. The seed hands such a provider a copy of a catalogue that
 * exists, and has to do it without touching the provider it copied from and
 * without doing it twice.
 */
describe('the catalogue a brand-new provider is given at boot', () => {
  let gama;
  let alfaBefore;
  let betaBefore;

  const catalogueOf = async (tenantId) => ({
    vendors: await rawVendors({ tenant_id: tenantId }).orderBy('id', 'asc'),
    configs: await rawConfigs({ tenant_id: tenantId }).orderBy('id', 'asc')
  });

  before(async () => {
    const db = getDb();
    alfaBefore = await catalogueOf(alfa);
    betaBefore = await catalogueOf(beta);
    await db('tenants').insert({ slug: 'gama', name: 'Provedor Gama', status: 'active' });
    gama = (await db('tenants').where({ slug: 'gama' }).first()).id;

    // What the next boot does, and the only thing that happens to a provider
    // added between two restarts.
    await seedDefaults();
  });

  it('gives it every vendor the source provider has', async () => {
    const copied = await catalogueOf(gama);

    assert.deepEqual(
      copied.vendors.map((row) => row.name),
      alfaBefore.vendors.map((row) => row.name)
    );
    assert.deepEqual(
      copied.configs.map((row) => row.password_param_path),
      alfaBefore.configs.map((row) => row.password_param_path)
    );
    assert.ok(copied.vendors.length > 0);
  });

  it('leaves the provider it copied from exactly as it was', async () => {
    assert.deepEqual(await catalogueOf(alfa), alfaBefore);
  });

  // Beta wrote its own catalogue, which is what an operator editing one looks
  // like from here. It must not be replaced by the source provider's.
  it('does not touch a provider that already has a catalogue', async () => {
    assert.deepEqual(await catalogueOf(beta), betaBefore);
  });

  it('leaves the new provider a catalogue that actually works', async () => {
    const detected = await runInTenant(
      gama,
      () => VendorService.detectVendor('ZTE Corporation', PRODUCT_CLASS, null)
    );
    const config = await runInTenant(
      gama,
      () => WifiSecurityConfig.getByProductClass(PRODUCT_CLASS)
    );

    assert.equal(detected.name, VENDOR_NAME);
    assert.equal(detected.wifi_password_path, 'PreSharedKey.1.KeyPassphrase');
    assert.equal(config.password_param_path, 'PreSharedKey.1.KeyPassphrase');
  });

  it('does not copy again on the next boot', async () => {
    const afterFirstBoot = await catalogueOf(gama);
    assert.ok(afterFirstBoot.vendors.length > 0);

    await seedDefaults();

    assert.deepEqual(await catalogueOf(gama), afterFirstBoot);
  });

  it('does not restore a catalogue the operator has emptied', async () => {
    // Deleting the last vendor is an edit like any other. What keeps the copy
    // from undoing it is that the provider still holds the rest of its
    // catalogue, so it does not read as never having had one.
    await runInTenant(gama, async () => {
      for (const vendor of await Vendor.getAll()) await Vendor.delete(vendor.id);
    });

    await seedDefaults();

    assert.equal(await count(rawVendors({ tenant_id: gama })), 0);
    assert.ok(await count(rawConfigs({ tenant_id: gama })) > 0);
  });
});
