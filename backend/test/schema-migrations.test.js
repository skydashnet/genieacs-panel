import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { ensureSchema, MIGRATIONS_TABLE } = await import('../src/config/schema.js');
const { migrations, SCHEMA_TABLES } = await import('../src/config/migrations.js');
const { buildKnexConfig } = await import('../src/config/dbConfig.js');
const { default: Tenant } = await import('../src/models/Tenant.js');

/** Every table the application expects once the runner is done. */
const APP_TABLES = [
  'users',
  'settings',
  'app_state',
  'vendors',
  'wifi_security_config',
  'mapping_nodes',
  'mapping_edges',
  'map_settings',
  'customer_accounts',
  'device_profiles',
  'sgp_links',
  'customer_wifi_credentials',
  'provisioning_profiles',
  'provisioning_runs',
  'sgp_events',
  'whatsapp_accounts',
  'device_samples',
  'device_sample_hours',
  'device_swaps',
  'outage_events'
];

/** Every secret kept in its own columns records which key encrypted it. */
const SECRET_KEY_VERSION_COLUMNS = [
  ['customer_accounts', 'password_key_version'],
  ['customer_wifi_credentials', 'password_key_version'],
  ['provisioning_profiles', 'wifi_password_key_version'],
  ['provisioning_profiles', 'cpe_password_key_version'],
  ['whatsapp_accounts', 'token_key_version'],
  ['whatsapp_accounts', 'webhook_token_key_version']
];

const ALL_IDS = migrations.map((migration) => migration.id);
// Everything from here on is the tenancy work; the "before" state is the
// schema as it stood just ahead of it. Comparing by id rather than naming one
// migration means a new tenancy step does not need this test edited.
const FIRST_TENANCY_MIGRATION = '0010_customer_accounts_tenant';
const LEGACY_USERNAME = 'legacy-admin';
const LEGACY_APP_NAME = 'Legacy Panel';
const LEGACY_STATE_KEY = 'sgp_integration_config';
const LEGACY_STATE_VALUE = '{"enabled":true,"app":"painel"}';

// Scratch databases for the cases that need a second, independent file: the
// harness owns a single database and it is spoken for by the legacy fixture.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-migrations-'));
const scratchPools = [];

function createDatabase(name) {
  const db = knexFactory(buildKnexConfig({
    client: 'sqlite3',
    filename: path.join(scratchDir, `${name}.sqlite`)
  }));
  scratchPools.push(db);
  return db;
}

async function appliedIds(db) {
  const rows = await db(MIGRATIONS_TABLE).select('id').orderBy('id');
  return rows.map((row) => row.id);
}

/**
 * The layout of an installation that predates the migration runner: the two
 * tables it always had, without the columns and tables added since.
 */
async function createLegacyInstallation(db) {
  await db.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('password', 255).notNullable();
    t.string('role', 32).notNullable().defaultTo('user');
    t.timestamp('created_at').defaultTo(db.fn.now());
    t.timestamp('updated_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('settings', (t) => {
    t.string('key', 128).primary();
    t.text('value');
    t.timestamp('updated_at').defaultTo(db.fn.now());
  });
  // Same shape as `settings`: `key` alone is the primary key. 0015 has to move
  // both, with rows already in them.
  await db.schema.createTable('app_state', (t) => {
    t.string('key', 128).primary();
    t.text('value');
    t.timestamp('updated_at').defaultTo(db.fn.now());
  });
  await db('users').insert({
    username: LEGACY_USERNAME,
    password: 'legacy-hash',
    role: 'admin'
  });
  await db('settings').insert({ key: 'appName', value: LEGACY_APP_NAME });
  // An integration blob, because that is what this table really holds and
  // losing one in a backfill would cost an operator their SGP credentials.
  await db('app_state').insert({ key: LEGACY_STATE_KEY, value: LEGACY_STATE_VALUE });
}

before(async () => {
  await startTestServers({ beforeSchema: createLegacyInstallation });
});

after(async () => {
  await Promise.all(scratchPools.splice(0).map((db) => db.destroy()));
  fs.rmSync(scratchDir, { recursive: true, force: true });
  await stopTestServers();
});

/**
 * A 0052 derruba `wifi_security_mappings`, e é o único passo destes que
 * DESCARTA dado de alguém. O que este bloco afirma não é que a tabela some —
 * isso é trivial —, é que ela some **sozinha**: o resto do catálogo do provedor
 * fica de pé, com as linhas que tinha.
 *
 * A instalação antiga é montada à mão e o marcador da 0052 é apagado do
 * registro, que é a forma honesta de simular "um deploy que ainda tem a
 * tabela": rodar o `ensureSchema` de novo é literalmente o que acontece no
 * boot depois do update.
 */
describe('derrubando a tabela que nunca teve leitor', () => {
  const db = createDatabase('drop-wifi-mappings');
  let vendorId;

  before(async () => {
    await ensureSchema(db);

    const tenant = await db('tenants').orderBy('id', 'asc').first();
    vendorId = await insertReturningId('vendors', {
      tenant_id: tenant.id,
      name: 'ZTE',
      manufacturer_patterns: JSON.stringify(['zte']),
      product_patterns: JSON.stringify(['f670']),
      wifi_password_path: 'PreSharedKey.1.KeyPassphrase',
      priority: 20,
      enabled: true
    }, db);
    await db('wifi_security_config').insert({
      tenant_id: tenant.id,
      product_class: 'F670L',
      security_types: 'WPA2',
      password_param_path: 'PreSharedKey.1.KeyPassphrase'
    });

    // A tabela como a instalação antiga a tem, com uma linha dentro.
    await db.schema.createTable('wifi_security_mappings', (t) => {
      t.increments('id').primary();
      t.integer('vendor_id').unsigned().notNullable()
        .references('id').inTable('vendors').onDelete('CASCADE');
      t.string('raw_security_value', 128).notNullable();
      t.string('normalized_security', 128).notNullable();
      t.integer('tenant_id').unsigned().notNullable();
    });
    await db('wifi_security_mappings').insert({
      tenant_id: tenant.id,
      vendor_id: vendorId,
      raw_security_value: '11i',
      normalized_security: 'WPA2'
    });

    await db(MIGRATIONS_TABLE).where({ id: '0052_drop_wifi_security_mappings' }).del();
    await ensureSchema(db);
  });

  it('a tabela deixa de existir', async () => {
    assert.equal(await db.schema.hasTable('wifi_security_mappings'), false);
  });

  it('e o resto do catálogo do provedor fica de pé, com as linhas que tinha', async () => {
    // É a afirmação que dá sentido à migration: um DROP que leva junto o
    // fabricante ou a política de WiFi tiraria do painel os caminhos de
    // parâmetro que ele ESCREVE no aparelho — e isso falha em silêncio.
    const vendors = await db('vendors').select('id', 'name');
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0].name, 'ZTE');
    assert.equal(Number(vendors[0].id), Number(vendorId));

    const configs = await db('wifi_security_config').select('product_class');
    assert.equal(configs.length, 1);
    assert.equal(configs[0].product_class, 'F670L');
  });

  it('e o passo fica registrado, então o boot seguinte não tenta de novo', async () => {
    assert.ok((await appliedIds(db)).includes('0052_drop_wifi_security_mappings'));
  });
});

describe('migrating a fresh database', () => {
  const db = createDatabase('fresh');

  before(async () => {
    await ensureSchema(db);
  });

  it('creates every application table', async () => {
    for (const table of APP_TABLES) {
      assert.ok(await db.schema.hasTable(table), `expected table ${table}`);
    }
  });

  it('records every migration id', async () => {
    assert.deepEqual(await appliedIds(db), [...ALL_IDS].sort());
  });

  it('keeps the columns the later steps would otherwise add', async () => {
    assert.ok(await db.schema.hasColumn('users', 'token_version'));
    for (const column of [
      'password_hash',
      'password_ciphertext',
      'password_iv',
      'password_tag',
      'password_updated_at'
    ]) {
      assert.ok(
        await db.schema.hasColumn('customer_accounts', column),
        `expected column ${column}`
      );
    }
  });

  // Without these, rotating JWT_SECRET makes every stored secret unreadable
  // and says nothing about it, because decryption reports failure as "empty".
  it('records which key encrypted every secret held in its own columns', async () => {
    for (const [table, column] of SECRET_KEY_VERSION_COLUMNS) {
      assert.ok(
        await db.schema.hasColumn(table, column),
        `expected ${table}.${column}`
      );
    }
  });
});

describe('running the migrations again', () => {
  const db = createDatabase('repeat');

  before(async () => {
    await ensureSchema(db);
    await db('users').insert({ username: 'kept', password: 'hash', role: 'admin' });
  });

  it('is a no-op on the second run', async () => {
    await ensureSchema(db);
    assert.deepEqual(await appliedIds(db), [...ALL_IDS].sort());
  });

  it('does not duplicate the ledger rows or lose data', async () => {
    await ensureSchema(db);
    const [{ count }] = await db(MIGRATIONS_TABLE).count({ count: '*' });
    assert.equal(Number(count), ALL_IDS.length);
    const user = await db('users').where({ username: 'kept' }).first();
    assert.equal(user.password, 'hash');
  });
});

describe('baselining an installation created before the runner existed', () => {
  it('records every migration id for the legacy database', async () => {
    assert.deepEqual(await appliedIds(getDb()), [...ALL_IDS].sort());
  });

  it('keeps the rows the legacy tables already held', async () => {
    const db = getDb();
    const user = await db('users').where({ username: LEGACY_USERNAME }).first();
    assert.ok(user, 'expected the legacy user to survive');
    assert.equal(user.password, 'legacy-hash');
    assert.equal(user.role, 'admin');

    const setting = await db('settings').where({ key: 'appName' }).first();
    assert.equal(setting.value, LEGACY_APP_NAME);

    // The blob survives the primary-key move intact. A backfill that mangled
    // this would cost an operator their stored SGP credentials.
    const state = await db('app_state').where({ key: LEGACY_STATE_KEY }).first();
    assert.equal(state.value, LEGACY_STATE_VALUE);
  });

  // 0015 moves `key` from being the primary key on its own to being half of
  // `(tenant_id, key)`. This is the only step in the phase that touches a
  // primary key, and the three dialects spell it differently, so it is checked
  // here — in the block that runs against whichever dialect is under test —
  // rather than in the SQLite-only scratch databases below.
  describe('moving the key/value tables to a per-provider primary key', () => {
    const rowsFor = (db, table, key) => db(table).where({ key });

    it('carries the legacy rows over to the install\'s own provider', async () => {
      const db = getDb();
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      for (const [table, key] of [['settings', 'appName'], ['app_state', LEGACY_STATE_KEY]]) {
        const [row] = await rowsFor(db, table, key);
        assert.equal(Number(row.tenant_id), Number(tenant.id), `${table}.tenant_id`);
      }
    });

    it('lets a second provider hold the same key with its own value', async () => {
      const db = getDb();
      await db('tenants').insert({ slug: 'pk-beta', name: 'Provedor Beta', status: 'active' });
      const beta = await db('tenants').where({ slug: 'pk-beta' }).first();
      try {
        await db('settings').insert({ tenant_id: beta.id, key: 'appName', value: 'Outro Painel' });
        const rows = await rowsFor(db, 'settings', 'appName');
        assert.equal(rows.length, 2);
        assert.deepEqual(
          rows.map((r) => r.value).sort(),
          [LEGACY_APP_NAME, 'Outro Painel'].sort()
        );

        // Same provider, same key, twice — still refused.
        await assert.rejects(
          () => db('settings').insert({ tenant_id: beta.id, key: 'appName', value: 'Terceiro' })
        );

        // The conflict target has to be the composite key. Getting this wrong
        // is invisible on MySQL, which ignores the target entirely, and throws
        // on SQLite and Postgres — so it is asserted behaviourally.
        await db('settings')
          .insert({ tenant_id: beta.id, key: 'appName', value: 'Renomeado' })
          .onConflict(['tenant_id', 'key'])
          .merge({ value: 'Renomeado' });
        const merged = await rowsFor(db, 'settings', 'appName');
        assert.equal(merged.length, 2, 'the upsert must update, not append');
        assert.equal(
          merged.find((r) => Number(r.tenant_id) === Number(beta.id)).value,
          'Renomeado'
        );
      } finally {
        await db('settings').where({ tenant_id: beta.id }).del();
        await db('tenants').where({ id: beta.id }).del();
      }
    });

    it('refuses a row for a provider that does not exist', async () => {
      await assert.rejects(
        () => getDb()('settings').insert({ tenant_id: 999999, key: 'appName', value: 'x' })
      );
    });
  });

  it('fills in what the legacy layout was missing', async () => {
    const db = getDb();
    assert.ok(await db.schema.hasColumn('users', 'token_version'));
    const user = await db('users').where({ username: LEGACY_USERNAME }).first();
    assert.equal(Number(user.token_version), 0);
    for (const table of APP_TABLES) {
      assert.ok(await db.schema.hasTable(table), `expected table ${table}`);
    }
  });

  it('records rather than re-runs steps whose objects are all present', async () => {
    // A database that already has everything, but no ledger: the runner has to
    // adopt it as-is instead of trying to create what is already there.
    const db = createDatabase('baseline');
    await ensureSchema(db);
    await db('users').insert({ username: 'pre-existing', password: 'hash', role: 'admin' });
    await db.schema.dropTable(MIGRATIONS_TABLE);

    await ensureSchema(db);

    assert.deepEqual(await appliedIds(db), [...ALL_IDS].sort());
    const user = await db('users').where({ username: 'pre-existing' }).first();
    assert.equal(user.password, 'hash');
  });
});

describe('making the contract cadastre per-provider', () => {
  const db = createDatabase('sgp-links-tenancy');
  let alfa;

  /**
   * The upgrade path, which is the one that runs on every install already
   * standing — and the one the tenancy tests cannot reach, because they start
   * from a database the runner has already finished with.
   *
   * `sgp_links.device_id` was unique across the deployment. Step 0019 drops
   * that unique and puts `['tenant_id', 'device_id']` in its place, which on
   * SQLite means rebuilding the table with rows in it. A row that is here
   * afterwards is a row the rebuild carried.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < FIRST_TENANCY_MIGRATION)) {
      await migration.up(db);
    }
    await db('settings').insert({ key: 'appName', value: 'Provedor Alfa' });
    const accountId = await insertReturningId('customer_accounts', {
      customer_id: 'CSG-BBBBBBB-222222',
      device_id: 'ont-legada',
      identity_hash: 'k'.repeat(64),
      software_id: 'V2',
      pppoe_username: 'cliente-legado',
      active: true
    }, db);
    await db('sgp_links').insert({
      device_id: 'ont-legada',
      account_id: accountId,
      contract: '9001',
      client_name: 'Maria Souza',
      document: '98765432100',
      phone_manual: '5511999990000'
    });

    await ensureSchema(db);
    alfa = await db('tenants').orderBy('id', 'asc').first();
  });

  it('gives the cadastre it already had to the install\'s own provider', async () => {
    const link = await db('sgp_links').where({ device_id: 'ont-legada' }).first();
    assert.equal(Number(link.tenant_id), Number(alfa.id));
    // The rebuild has to carry every column, not just the key ones: this is the
    // row an operator sees on screen, and losing the phone number would break
    // the WhatsApp side silently.
    assert.equal(link.contract, '9001');
    assert.equal(link.client_name, 'Maria Souza');
    assert.equal(link.document, '98765432100');
    assert.equal(link.phone_manual, '5511999990000');
  });

  it('lets a second provider hold the same device id', async () => {
    const betaId = await insertReturningId('tenants', {
      slug: 'beta', name: 'Provedor Beta', status: 'active'
    }, db);
    await db('sgp_links').insert({
      tenant_id: betaId, device_id: 'ont-legada', contract: '7002'
    });

    const rows = await db('sgp_links').where({ device_id: 'ont-legada' });
    assert.equal(rows.length, 2, 'the old global unique would have refused the second');
  });

  it('still refuses a duplicate device id inside one provider', async () => {
    await assert.rejects(() => db('sgp_links').insert({
      tenant_id: alfa.id, device_id: 'ont-legada', contract: '9002'
    }));
  });
});

describe('the schema table list', () => {
  const db = createDatabase('coverage');

  before(async () => {
    await ensureSchema(db);
  });

  // Copying a panel to another database walks this list. When it was written
  // out by hand it fell eight tables behind, and a switch would have carried
  // the panel across without any of the WhatsApp data.
  it('names every table the migrations create', async () => {
    const created = [];
    for (const table of SCHEMA_TABLES) {
      if (await db.schema.hasTable(table)) created.push(table);
    }
    assert.deepEqual(created.sort(), [...SCHEMA_TABLES].sort());
  });

  it('covers every application table the tests know about', () => {
    const missing = APP_TABLES.filter((table) => !SCHEMA_TABLES.includes(table));
    assert.deepEqual(missing, []);
  });

  // Order is what makes the list safe to insert along and delete against.
  it('lists parents before the tables that reference them', () => {
    const position = (table) => SCHEMA_TABLES.indexOf(table);
    for (const [child, parent] of [
      ['mapping_edges', 'mapping_nodes'],
      ['sgp_links', 'customer_accounts'],
      ['customer_wifi_credentials', 'customer_accounts'],
      ['provisioning_runs', 'provisioning_profiles'],
      ['wa_conversations', 'whatsapp_accounts'],
      ['wa_messages', 'wa_conversations'],
      // Not tidiness: `copyData` deletes in reverse order and inserts forward,
      // so the foreign key added by 0015 is only satisfiable because `tenants`
      // precedes both of these.
      ['settings', 'tenants'],
      ['app_state', 'tenants']
    ]) {
      assert.ok(
        position(parent) < position(child),
        `${parent} must come before ${child}`
      );
    }
  });
});

describe('making customer accounts per-provider', () => {
  const db = createDatabase('tenancy');
  let alfa;

  before(async () => {
    // The state just before tenancy, populated the way a running install is:
    // an account with children pointing at it, so the rebuild the unique swap
    // needs on SQLite has something to lose if it goes wrong.
    for (const migration of migrations.filter((m) => m.id < FIRST_TENANCY_MIGRATION)) {
      await migration.up(db);
    }
    await db('settings').insert({ key: 'appName', value: 'Provedor Alfa' });
    const accountId = await insertReturningId('customer_accounts', {
      customer_id: 'CSG-AAAAAAA-111111',
      device_id: 'dev-1',
      identity_hash: 'h'.repeat(64),
      software_id: 'V1',
      pppoe_username: 'cliente01',
      active: true
    }, db);
    await db('customer_wifi_credentials').insert({
      account_id: accountId, wifi_index: 1, ssid: 'CasaDoJoao'
    });
    await db('sgp_links').insert({ device_id: 'dev-1', account_id: accountId, contract: '4321' });

    await ensureSchema(db);
    alfa = await db('tenants').orderBy('id', 'asc').first();
  });

  it('turns the install into the first provider, under the name already on screen', async () => {
    assert.equal(alfa.slug, 'default');
    assert.equal(alfa.name, 'Provedor Alfa');
  });

  it('keeps the accounts and everything pointing at them', async () => {
    const account = await db('customer_accounts').where({ device_id: 'dev-1' }).first();
    assert.equal(account.customer_id, 'CSG-AAAAAAA-111111');
    assert.equal(Number(account.tenant_id), Number(alfa.id));

    // The unique swap rebuilds the table on SQLite, where a cascading delete
    // would take these with it.
    const [{ n }] = await db('customer_wifi_credentials').count({ n: '*' });
    assert.equal(Number(n), 1);
    const link = await db('sgp_links').where({ device_id: 'dev-1' }).first();
    assert.equal(Number(link.account_id), Number(account.id));
  });

  // The whole point: identity_hash is sha256(softwareId, pppoe_username), so
  // two providers running the same firmware with a subscriber of the same name
  // produce the same value. Globally unique, the second provider's sync would
  // find the first provider's account.
  it('lets a second provider reuse every identity value', async () => {
    const betaId = await insertReturningId('tenants', {
      slug: 'beta', name: 'Provedor Beta', status: 'active'
    }, db);
    await insertReturningId('customer_accounts', {
      tenant_id: betaId,
      customer_id: 'CSG-AAAAAAA-111111',
      device_id: 'dev-1',
      identity_hash: 'h'.repeat(64),
      software_id: 'V1',
      pppoe_username: 'cliente01',
      active: true
    }, db);

    const [{ n }] = await db('customer_accounts').where({ device_id: 'dev-1' }).count({ n: '*' });
    assert.equal(Number(n), 2, 'both providers should hold the same device id');
  });

  it('still rejects a duplicate inside one provider', async () => {
    const beta = await db('tenants').where({ slug: 'beta' }).first();
    await assert.rejects(() => insertReturningId('customer_accounts', {
      tenant_id: beta.id,
      customer_id: 'CSG-AAAAAAA-111111',
      device_id: 'dev-9',
      identity_hash: 'x'.repeat(64),
      software_id: 'V1',
      pppoe_username: 'outro',
      active: true
    }, db));
  });
});

describe('making the SGP log and the provisioning trail per-provider', () => {
  const db = createDatabase('sgp-provisioning-tenancy');
  let alfa;
  let profileId;

  /**
   * The same upgrade path as the cadastre above, for the three steps that
   * followed it: 0022 on `device_profiles`, 0023 on the provisioning pair and
   * 0024 on `sgp_events`. Each drops a unique the panel never minted the value
   * for — a GenieACS device id, a name an operator typed, a key built from an
   * SGP event id — and puts the pair carrying `tenant_id` in its place. On
   * SQLite that rebuilds the table with its rows inside.
   *
   * The `*-tenancy` suites cover what these tables do afterwards, thoroughly,
   * but every one of them starts from a database the runner has already
   * finished with. Nothing else here walks the rebuild with data in it.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < FIRST_TENANCY_MIGRATION)) {
      await migration.up(db);
    }
    await db('settings').insert({ key: 'appName', value: 'Provedor Alfa' });
    await db('device_profiles').insert({
      device_id: 'ont-antiga',
      installation_date: '2023-05-14',
      installation_tag: 'InstaladoEm'
    });
    await db('sgp_events').insert({
      dedupe_key: 'webhook:12345',
      source: 'webhook',
      type: 'activated',
      contract: '3003',
      document: '11122233344',
      status: 'processed',
      received_at: new Date()
    });
    profileId = await insertReturningId('provisioning_profiles', {
      name: 'Padrao', priority: 5, enabled: true
    }, db);
    await db('provisioning_runs').insert({
      device_id: 'ont-antiga',
      profile_id: profileId,
      trigger: 'poller',
      status: 'success',
      attempt_count: 2
    });

    await ensureSchema(db);
    alfa = await db('tenants').orderBy('id', 'asc').first();
  });

  // The non-key columns as much as the keys. An installation date is what the
  // panel dates a warranty from, and a document is the subscriber's CPF —
  // losing either in a rebuild would say nothing at the time.
  it('gives the rows it already had to the install\'s own provider', async () => {
    const profile = await db('device_profiles').where({ device_id: 'ont-antiga' }).first();
    assert.equal(Number(profile.tenant_id), Number(alfa.id));
    assert.equal(profile.installation_tag, 'InstaladoEm');
    assert.match(String(profile.installation_date), /2023-05-14/);

    const event = await db('sgp_events').where({ dedupe_key: 'webhook:12345' }).first();
    assert.equal(Number(event.tenant_id), Number(alfa.id));
    assert.equal(event.contract, '3003');
    assert.equal(event.document, '11122233344');
    assert.equal(event.status, 'processed');

    const provisioningProfile = await db('provisioning_profiles').where({ id: profileId }).first();
    assert.equal(Number(provisioningProfile.tenant_id), Number(alfa.id));
    assert.equal(provisioningProfile.name, 'Padrao');
  });

  // `provisioning_runs` gains no composite unique, so what the rebuild of the
  // profiles table beside it could break is the reference: a run has to still
  // point at the profile it ran.
  it('keeps a run pointing at the profile it ran', async () => {
    const run = await db('provisioning_runs').where({ device_id: 'ont-antiga' }).first();
    assert.equal(Number(run.tenant_id), Number(alfa.id));
    assert.equal(Number(run.profile_id), Number(profileId));
    assert.equal(Number(run.attempt_count), 2);
  });

  it('lets a second provider reuse every value the panel does not mint', async () => {
    const betaId = await insertReturningId('tenants', {
      slug: 'beta', name: 'Provedor Beta', status: 'active'
    }, db);

    await db('device_profiles').insert({
      tenant_id: betaId, device_id: 'ont-antiga', installation_tag: 'beta'
    });
    await db('sgp_events').insert({
      tenant_id: betaId,
      dedupe_key: 'webhook:12345',
      source: 'webhook',
      type: 'activated',
      contract: '8008',
      status: 'pending',
      received_at: new Date()
    });
    await db('provisioning_profiles').insert({ tenant_id: betaId, name: 'Padrao', priority: 9 });

    for (const [table, where] of [
      ['device_profiles', { device_id: 'ont-antiga' }],
      ['sgp_events', { dedupe_key: 'webhook:12345' }],
      ['provisioning_profiles', { name: 'Padrao' }]
    ]) {
      // eslint-disable-next-line no-await-in-loop -- three probes
      const rows = await db(table).where(where);
      assert.equal(rows.length, 2, `the old global unique on ${table} would have refused the second`);
    }
  });

  it('still refuses a duplicate inside one provider', async () => {
    await assert.rejects(() => db('device_profiles').insert({
      tenant_id: alfa.id, device_id: 'ont-antiga', installation_tag: 'x'
    }), 'device_profiles');
    await assert.rejects(() => db('sgp_events').insert({
      tenant_id: alfa.id,
      dedupe_key: 'webhook:12345',
      source: 'webhook',
      type: 'activated',
      status: 'pending',
      received_at: new Date()
    }), 'sgp_events');
    await assert.rejects(() => db('provisioning_profiles').insert({
      tenant_id: alfa.id, name: 'Padrao', priority: 1
    }), 'provisioning_profiles');
  });
});

describe('giving every provider a subscription', () => {
  const db = createDatabase('billing');
  const BILLING_MIGRATION = '0035_plans_and_subscriptions';
  let alfa;
  let beta;

  /**
   * The upgrade path of 0034: an install with two providers and no notion of
   * a plan. What has to come out the other side is a deployment where nothing
   * changed for either of them — `active`, on a plan that limits nothing —
   * because an upgrade cannot be the day an ISP in production discovers it is
   * locked out or over some limit it never agreed to.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < BILLING_MIGRATION)) {
      await migration.up(db);
    }
    alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
    beta = await insertReturningId('tenants', { slug: 'beta', name: 'Provedor Beta', status: 'active' }, db);
    await ensureSchema(db);
  });

  it('creates the unlimited plan exactly once', async () => {
    const plans = await db('plans').where({ code: 'unlimited' });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].max_operators, null);
    assert.equal(plans[0].max_subscribers, null);
    assert.equal(plans[0].max_devices, null);
  });

  it('puts every existing provider on it, active, with no trial to expire', async () => {
    for (const tenantId of [alfa, beta]) {
      const row = await db('subscriptions').where({ tenant_id: tenantId }).first();
      assert.ok(row, `provider ${tenantId} has no subscription`);
      assert.equal(row.status, 'active');
      assert.equal(row.trial_ends_at, null);
      const plan = await db('plans').where({ id: row.plan_id }).first();
      assert.equal(plan.code, 'unlimited');
    }
  });

  it('can be asked to run a second time without duplicating a row', async () => {
    // The step and its ledger row are two statements; a process that dies in
    // between comes back to a backfill that has already run. Asked directly,
    // the way that boot would ask it.
    const step = migrations.find((m) => m.id === BILLING_MIGRATION);
    await step.up(db);
    await ensureSchema(db);
    const [{ n }] = await db('subscriptions').count({ n: '*' });
    assert.equal(Number(n), 2);
    const [{ p }] = await db('plans').where({ code: 'unlimited' }).count({ p: '*' });
    assert.equal(Number(p), 1);
  });
});

describe('o cadastro fiscal chegando a uma base que já tem provedores', () => {
  const db = createDatabase('billing-profile');
  const FISCAL_MIGRATION = '0043_tenant_billing_profile';
  let alfa;
  let beta;

  /**
   * O caminho de upgrade da 0042 — e o que ele tem que garantir é que NADA
   * mude para quem já está lá. As doze colunas nascem nulas, ninguém é
   * obrigado a preencher nada para continuar entrando no painel, e os dois
   * provedores que já existiam continuam com nome, slug e situação intactos.
   *
   * O risco real desta migração não é o schema: é o passo ser pulado em
   * silêncio. O runner compara ids (`schema.js:67`), então um id repetido num
   * banco que já rodou o homônimo seria marcado como aplicado sem rodar, e o
   * painel subiria contra um schema sem as colunas.
   *
   * Aconteceu duas vezes nesta fatia, e as duas foram pegas: `0040` já estava
   * tomado pelo webhook do WhatsApp quando o passo foi escrito, e `0042` foi
   * tomado pela garra da campanha enquanto a fatia estava em revisão. O caso
   * abaixo é o que transformou o segundo num conflito de merge em vez de num
   * passo pulado num banco de produção.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < FISCAL_MIGRATION)) {
      await migration.up(db);
    }
    alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
    beta = await insertReturningId(
      'tenants', { slug: 'beta', name: 'Provedor Beta', status: 'active' }, db
    );
    await ensureSchema(db);
  });

  it('acrescenta as doze colunas', async () => {
    for (const coluna of Tenant.BILLING_COLUMNS) {
      assert.equal(await db.schema.hasColumn('tenants', coluna), true, `falta ${coluna}`);
    }
  });

  it('e todas nascem nulas para quem já existia', async () => {
    for (const tenantId of [alfa, beta]) {
      const row = await db('tenants').where({ id: tenantId }).first();
      for (const coluna of Tenant.BILLING_COLUMNS) {
        assert.equal(row[coluna] ?? null, null, `${coluna} do provedor ${tenantId} nasceu preenchida`);
      }
    }
  });

  it('sem tocar em nada do que já estava escrito', async () => {
    const row = await db('tenants').where({ id: beta }).first();
    assert.equal(row.slug, 'beta');
    assert.equal(row.name, 'Provedor Beta');
    assert.equal(row.status, 'active');
  });

  it('e pode ser pedida de novo sem estourar', async () => {
    // O passo e a linha do ledger são duas escritas; um processo que morre
    // entre as duas volta a um passo que já rodou. Pedido direto, do jeito que
    // o boot pediria.
    const step = migrations.find((m) => m.id === FISCAL_MIGRATION);
    await step.up(db);
    await ensureSchema(db);
    assert.equal(await db.schema.hasColumn('tenants', 'billing_tax_id'), true);
  });

  /**
   * A armadilha que quase aconteceu: `0040` já estava tomado. Um id repetido
   * não dá erro — o runner pula o passo e grava que aplicou.
   */
  it('e nenhum id do ledger se repete', () => {
    const ids = migrations.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), ids, 'os ids têm que estar em ordem crescente');
  });
});

describe('a marca do prazo já avisado', () => {
  const db = createDatabase('expiry-warned');
  const AVISO_MIGRATION = '0044_subscription_expiry_warned_for';

  /**
   * O caminho de upgrade da 0044. A coluna nasce nula, e nula é o certo:
   * ninguém foi avisado ainda. O risco desta migração não é o schema — é um
   * default não-nulo que faria todo provedor parecer já avisado do prazo que
   * ele tem agora, e o primeiro aviso nunca sairia.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < AVISO_MIGRATION)) {
      await migration.up(db);
    }
    await ensureSchema(db);
  });

  it('acrescenta a coluna', async () => {
    assert.equal(await db.schema.hasColumn('subscriptions', 'expiry_warned_for'), true);
  });

  it('e ela nasce nula para toda assinatura que já existia', async () => {
    const linhas = await db('subscriptions');
    for (const linha of linhas) {
      assert.equal(linha.expiry_warned_for ?? null, null);
    }
  });

  it('e pode ser pedida de novo sem estourar', async () => {
    const step = migrations.find((m) => m.id === AVISO_MIGRATION);
    await step.up(db);
    await ensureSchema(db);
    assert.equal(await db.schema.hasColumn('subscriptions', 'expiry_warned_for'), true);
  });
});

describe('the provider name leaving settings', () => {
  const db = createDatabase('tenant-name');
  const NAME_MIGRATION = '0036_tenant_name_from_app_name';
  let alfa;
  let beta;

  /**
   * The upgrade path of 0035. `settings.appName` was what the sidebar showed;
   * `tenants.name` was what the console listed. The copy has to move the name
   * an operator actually typed, and only that one: a provider minted by the
   * console carries the factory `appName` and a real name of its own, and
   * copying the factory string over it would rename "Provedor Beta" to
   * "SkyGenPanel".
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < NAME_MIGRATION)) {
      await migration.up(db);
    }
    alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
    beta = await insertReturningId('tenants', { slug: 'beta', name: 'Provedor Beta', status: 'active' }, db);
    await db('settings').where({ tenant_id: alfa, key: 'appName' }).del();
    await db('settings').insert([
      { tenant_id: alfa, key: 'appName', value: 'Fibra do Vale' },
      { tenant_id: beta, key: 'appName', value: 'SkyGenPanel' }
    ]);
    await ensureSchema(db);
  });

  it('moves the name the operator typed onto the provider row', async () => {
    assert.equal((await db('tenants').where({ id: alfa }).first()).name, 'Fibra do Vale');
  });

  it('leaves a provider whose setting is still the factory value alone', async () => {
    assert.equal((await db('tenants').where({ id: beta }).first()).name, 'Provedor Beta');
  });

  it('runs only once', async () => {
    await db('settings').where({ tenant_id: alfa, key: 'appName' }).update({ value: 'Outro Nome' });
    await ensureSchema(db);
    assert.equal((await db('tenants').where({ id: alfa }).first()).name, 'Fibra do Vale',
      'after the copy, the setting no longer drives the name');
  });
});

/**
 * A data de suspensão de quem já estava suspenso, lida da trilha.
 *
 * A coluna nasce nula para todo mundo, e provedores suspensos antes dela
 * existirem não teriam data nenhuma — "parado desde sempre", que não é uma
 * resposta. `platform_audit` registra toda mudança de status com `{ from, to }`
 * no `detail`, e é compartilhada e sem FK para `tenants` de propósito, para
 * sobreviver à exclusão do provedor: a data real está lá.
 *
 * Os dois lados no mesmo bloco de propósito. Inventar data é tão errado quanto
 * não achar a que existe — `updated_at` daria um número plausível para todo
 * mundo, e plausível e errado é pior que vazio.
 */
describe('o backfill da data de suspensão', () => {
  const db = createDatabase('suspended-at-backfill');
  const PASSO = '0049_tenant_suspended_at_backfill';
  let comTrilha;
  let semTrilha;
  let reativado;
  const quandoFoi = new Date('2026-03-01T12:00:00Z');

  const linha = (id) => db('tenants').where({ id }).first();

  before(async () => {
    await ensureSchema(db);

    comTrilha = await insertReturningId('tenants',
      { slug: 'com-trilha', name: 'Com Trilha', status: 'suspended' }, db);
    semTrilha = await insertReturningId('tenants',
      { slug: 'sem-trilha', name: 'Sem Trilha', status: 'suspended' }, db);
    reativado = await insertReturningId('tenants',
      { slug: 'reativado', name: 'Reativado', status: 'suspended' }, db);

    await db('platform_audit').insert([
      {
        action: 'tenant.status_changed',
        tenant_id: comTrilha,
        tenant_slug: 'com-trilha',
        detail: JSON.stringify({ from: 'active', to: 'suspended' }),
        created_at: quandoFoi
      },
      // Ruído que o filtro tem que ignorar: outra ação, no mesmo provedor.
      {
        action: 'tenant.renamed',
        tenant_id: comTrilha,
        tenant_slug: 'com-trilha',
        detail: JSON.stringify({ to: 'Outro Nome' }),
        created_at: new Date('2026-06-01T12:00:00Z')
      },
      // Este foi suspenso, reativado, e suspenso de novo SEM registro da
      // última vez. A linha mais recente termina em `active`, então a resposta
      // honesta é não saber — e não a data da suspensão antiga.
      {
        action: 'tenant.status_changed',
        tenant_id: reativado,
        tenant_slug: 'reativado',
        detail: JSON.stringify({ from: 'active', to: 'suspended' }),
        created_at: new Date('2026-01-01T12:00:00Z')
      },
      {
        action: 'tenant.status_changed',
        tenant_id: reativado,
        tenant_slug: 'reativado',
        detail: JSON.stringify({ from: 'suspended', to: 'active' }),
        created_at: new Date('2026-02-01T12:00:00Z')
      }
    ]);

    // A coluna existe e está nula: é o estado em que o passo encontra uma
    // instalação que acabou de subir a migração anterior.
    await db('tenants').update({ suspended_at: null });
    await migrations.find((m) => m.id === PASSO).up(db);
  });

  it('acha na trilha a data em que o provedor foi suspenso', async () => {
    const achada = (await linha(comTrilha)).suspended_at;
    assert.ok(achada, 'não achou a data que estava na trilha');
    assert.equal(new Date(achada).getTime(), quandoFoi.getTime());
  });

  it('e deixa NULO quem a trilha não sabe, em vez de inventar', async () => {
    assert.equal((await linha(semTrilha)).suspended_at, null);
  });

  it('e não usa uma suspensão antiga que já tinha sido desfeita', async () => {
    // A mudança mais recente deste terminou em `active`. A suspensão atual veio
    // depois e não deixou registro: a data velha seria uma mentira precisa.
    assert.equal((await linha(reativado)).suspended_at, null);
  });

  it('não encosta em provedor ativo', async () => {
    const ativo = await db('tenants').where({ status: 'active' }).first();
    assert.equal(ativo.suspended_at, null);
  });

  it('roda de novo sem estragar o que já achou', async () => {
    await migrations.find((m) => m.id === PASSO).up(db);
    assert.equal(
      new Date((await linha(comTrilha)).suspended_at).getTime(), quandoFoi.getTime()
    );
  });
});

/**
 * O endereço do webhook gravado antes de a garantia do caminho existir.
 *
 * O defeito apareceu num painel em produção: `webhookBaseUrl` guardado como
 * `https://painel.exemplo.com`, sem caminho. O servidor Evolution faz POST na
 * raiz, o frontend responde 200 com HTML, o servidor registra entrega
 * bem-sucedida, e nada chega nunca. `normalizeWebhookBaseUrl` passou a
 * completar o caminho, mas só na GRAVAÇÃO — e depender de alguém abrir a aba e
 * clicar em Salvar é depender de alguém suspeitar primeiro.
 *
 * Os dois lados no mesmo lugar, porque reescrever demais custa mais caro que
 * não reescrever: quem serve o painel sob um prefixo próprio digitou aquele
 * caminho de propósito, e esta migração não pode passar por cima dele.
 */
describe('o caminho do webhook nas linhas que já estavam gravadas', () => {
  const db = createDatabase('webhook-path-backfill');
  const PASSO = '0051_whatsapp_webhook_path_backfill';
  const CHAVE = 'whatsapp_evolution_config';
  let alfa;

  const blobDe = async (tenantId) => JSON.parse(
    (await db('app_state').where({ tenant_id: tenantId, key: CHAVE }).first()).value
  );

  const gravar = async (tenantId, blob) => db('app_state').insert({
    tenant_id: tenantId, key: CHAVE, value: JSON.stringify(blob)
  });

  let semCaminho;
  let comBarra;
  let jaCerto;
  let caminhoProprio;
  let semEndereco;
  let quebrado;

  before(async () => {
    for (const migration of migrations.filter((m) => m.id < PASSO)) {
      await migration.up(db);
    }
    alfa = (await db('tenants').orderBy('id', 'asc').first()).id;

    const novoProvedor = async (slug) => insertReturningId(
      'tenants', { slug, name: slug, status: 'active' }, db
    );
    semCaminho = alfa;
    comBarra = await novoProvedor('com-barra');
    jaCerto = await novoProvedor('ja-certo');
    caminhoProprio = await novoProvedor('caminho-proprio');
    semEndereco = await novoProvedor('sem-endereco');
    quebrado = await novoProvedor('quebrado');

    // O caso de produção: só o host, e mais campos ao lado que não podem ser
    // perdidos na reescrita — inclusive o segredo cifrado.
    await gravar(semCaminho, {
      enabled: true,
      webhookBaseUrl: 'https://painel.exemplo.test',
      allowedHosts: ['evo.exemplo.test'],
      managedAdminKey: { v: 1, ciphertext: 'cifra', iv: 'iv', tag: 'tag', key_version: 2 },
      rateLimitPerMin: 20
    });
    await gravar(comBarra, { enabled: true, webhookBaseUrl: 'https://painel.exemplo.test/' });
    await gravar(jaCerto, {
      enabled: true, webhookBaseUrl: 'https://painel.exemplo.test/api/whatsapp-webhook'
    });
    // Quem roteia um caminho próprio para o painel. Reescrever isto quebra a
    // instalação dele, e é o erro mais caro que este passo pode cometer.
    await gravar(caminhoProprio, {
      enabled: true, webhookBaseUrl: 'https://painel.exemplo.test/painel/api/whatsapp-webhook'
    });
    await gravar(semEndereco, { enabled: false, webhookBaseUrl: '' });
    await db('app_state').insert({ tenant_id: quebrado, key: CHAVE, value: 'isto não é json' });

    await ensureSchema(db);
  });

  it('completa o caminho de quem gravou só o host', async () => {
    const blob = await blobDe(semCaminho);
    assert.equal(blob.webhookBaseUrl, 'https://painel.exemplo.test/api/whatsapp-webhook');
  });

  it('e o resto do blob sobrevive intacto, o segredo cifrado inclusive', async () => {
    // A reescrita é um JSON.parse seguido de um JSON.stringify. Perder a chave
    // admin cifrada aqui seria destruir um segredo sem erro e sem volta.
    const blob = await blobDe(semCaminho);
    assert.equal(blob.enabled, true);
    assert.equal(blob.rateLimitPerMin, 20);
    assert.deepEqual(blob.allowedHosts, ['evo.exemplo.test']);
    assert.deepEqual(blob.managedAdminKey, {
      v: 1, ciphertext: 'cifra', iv: 'iv', tag: 'tag', key_version: 2
    });
  });

  it('a barra sozinha também conta como "sem caminho"', async () => {
    assert.equal(
      (await blobDe(comBarra)).webhookBaseUrl, 'https://painel.exemplo.test/api/whatsapp-webhook'
    );
  });

  it('NÃO reescreve o caminho próprio de quem serve o painel sob um prefixo', async () => {
    // O caso que decide se este passo é seguro. Um `endsWith` ingênuo diria que
    // `/painel/api/whatsapp-webhook` já termina certo — e diz, e é por isso que
    // ele passa intacto. O que não pode acontecer é ele virar
    // `/api/whatsapp-webhook` e o roteamento do operador parar de casar.
    assert.equal(
      (await blobDe(caminhoProprio)).webhookBaseUrl,
      'https://painel.exemplo.test/painel/api/whatsapp-webhook'
    );
  });

  it('não inventa endereço para quem não tem nenhum', async () => {
    assert.equal((await blobDe(semEndereco)).webhookBaseUrl, '');
  });

  it('e um valor que não é JSON não derruba o passo nem é tocado', async () => {
    const linha = await db('app_state').where({ tenant_id: quebrado, key: CHAVE }).first();
    assert.equal(linha.value, 'isto não é json');
  });

  it('quem já estava certo não é reescrito', async () => {
    assert.equal(
      (await blobDe(jaCerto)).webhookBaseUrl, 'https://painel.exemplo.test/api/whatsapp-webhook'
    );
  });

  it('e rodar de novo não muda mais nada', async () => {
    // Idempotência pedida do jeito que o boot pediria: o passo direto, e
    // depois o runner inteiro.
    const step = migrations.find((m) => m.id === PASSO);
    await step.up(db);
    await ensureSchema(db);
    assert.equal(
      (await blobDe(semCaminho)).webhookBaseUrl, 'https://painel.exemplo.test/api/whatsapp-webhook'
    );
    assert.equal(
      (await blobDe(caminhoProprio)).webhookBaseUrl,
      'https://painel.exemplo.test/painel/api/whatsapp-webhook'
    );
  });

  it('e `isApplied` responde que sim depois de rodar', async () => {
    // É o que impede o passo de rodar de novo num banco que já o tem — e, num
    // banco antigo sendo baselined, o que impede de marcá-lo como aplicado sem
    // ter rodado.
    const step = migrations.find((m) => m.id === PASSO);
    assert.equal(await step.isApplied(db), true);
  });
});

describe('a cor dos números que já existiam', () => {
  const db = createDatabase('whatsapp-account-color');
  const PASSO = '0055_whatsapp_account_color';
  let alfa;
  let beta;

  const numero = (tenantId, nome, extra = {}) => insertReturningId('whatsapp_accounts', {
    tenant_id: tenantId, name: nome, base_url: 'https://evo.exemplo.test', ...extra
  }, db);
  const coresDe = async (tenantId) => (await db('whatsapp_accounts')
    .where({ tenant_id: tenantId }).orderBy('id')).map((row) => row.color);

  /**
   * O caminho de upgrade de verdade: a tabela SEM a coluna, com números dentro.
   * A fábrica da tabela já nasce com `color`, então a coluna é tirada à mão para
   * o banco ficar como estava antes deste passo.
   */
  before(async () => {
    for (const migration of migrations.filter((m) => m.id < PASSO)) {
      await migration.up(db);
    }
    await db.schema.alterTable('whatsapp_accounts', (t) => t.dropColumn('color'));
    alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
    beta = await insertReturningId('tenants', { slug: 'beta', name: 'Beta', status: 'active' }, db);

    // Intercalados de propósito: a ordem por id mistura os dois provedores, e
    // a cor de um não pode sair da contagem do outro.
    await numero(alfa, 'alfa-suporte');
    await numero(beta, 'beta-unico');
    await numero(alfa, 'alfa-cobranca');
    await numero(alfa, 'alfa-vendas');
    await ensureSchema(db);
  });

  it('dá a cada número do provedor uma cor diferente, em ordem de id', async () => {
    assert.deepEqual(await coresDe(alfa), ['blue', 'pink', 'lime']);
  });

  it('e o vizinho começa a paleta do zero, sem contar as cores do outro', async () => {
    assert.deepEqual(await coresDe(beta), ['blue']);
  });

  it('rodar de novo preenche só quem está sem cor, sem repetir as que já existem', async () => {
    // O processo que morre entre o passo e o registro dele volta a este passo.
    // O que ele achar sem cor ganha a próxima livre do provedor — não a
    // primeira da paleta de novo.
    await numero(alfa, 'alfa-atrasado');
    const step = migrations.find((m) => m.id === PASSO);
    await step.up(db);
    assert.deepEqual(await coresDe(alfa), ['blue', 'pink', 'lime', 'violet']);
    assert.equal(await step.isApplied(db), true);
  });

  it('e rodar de novo não troca a cor de ninguém', async () => {
    const antes = await coresDe(alfa);
    await db('whatsapp_accounts').where({ name: 'alfa-suporte' }).update({ color: 'lime' });
    const step = migrations.find((m) => m.id === PASSO);
    await step.up(db);
    assert.deepEqual(await coresDe(alfa), ['lime', ...antes.slice(1)], 'a cor escolhida à mão foi sobrescrita');
  });
});
