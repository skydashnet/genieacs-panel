import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { ensureSchema } from '../src/config/schema.js';
import { DEFAULT_SETTINGS, seedDefaults } from '../src/config/seed.js';
import { copyData } from '../src/services/dbManagementService.js';

function sqlite(filename) {
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      afterCreate(connection, done) {
        connection.pragma('foreign_keys = ON');
        done(null, connection);
      }
    }
  });
}

async function seedGraph(db, suffix) {
  const accountId = suffix === 'source' ? 1 : 2;
  await db('vendors').insert({
    id: suffix === 'source' ? 1 : 2,
    name: `Vendor ${suffix}`,
    manufacturer_patterns: '[]',
    product_patterns: '[]'
  });
  await db('wifi_security_mappings').insert({
    id: suffix === 'source' ? 1 : 2,
    vendor_id: suffix === 'source' ? 1 : 2,
    raw_security_value: 'raw',
    normalized_security: 'WPA2'
  });
  await db('mapping_nodes').insert([
    {
      node_id: `${suffix}-a`,
      type: 'odc',
      name: 'A',
      latitude: -6.2,
      longitude: 106.8
    },
    {
      node_id: `${suffix}-b`,
      type: 'odp',
      name: 'B',
      latitude: -6.21,
      longitude: 106.81
    }
  ]);
  await db('mapping_edges').insert({
    edge_id: `${suffix}-edge`,
    source: `${suffix}-a`,
    target: `${suffix}-b`
  });
  await db('customer_accounts').insert({
    id: accountId,
    customer_id: suffix === 'source' ? 'CSG-SOURCE2-111111' : 'CSG-TARGET2-222222',
    device_id: `${suffix}-device`,
    identity_hash: (suffix === 'source' ? 'a' : 'b').repeat(64),
    software_id: 'V1',
    pppoe_username: `${suffix}-pppoe`
  });
  await db('customer_wifi_credentials').insert({
    account_id: accountId,
    wifi_index: 1,
    ssid: `${suffix}-wifi`,
    password_ciphertext: `${suffix}-ciphertext`,
    password_iv: `${suffix}-iv`,
    password_tag: `${suffix}-tag`
  });
}

test('default virtual parameter mappings migrate to genieacs-installer names without overwriting custom values', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skygenpanel-seed-'));
  const db = sqlite(path.join(tempDir, 'settings.sqlite'));
  try {
    await ensureSchema(db);
    await db('settings').insert([
      { key: 'appName', value: 'GenieACS Panel' },
      { key: 'vpPppoeUsername', value: 'VirtualParameters.pppoeUsername' },
      { key: 'vpRxPower', value: 'VirtualParameters.CustomRxPower' },
      { key: 'vpUserPassword', value: 'VirtualParameters.userPassword' }
    ]);

    await seedDefaults(db);

    const rows = Object.fromEntries(
      (await db('settings').select('key', 'value')).map(({ key, value }) => [key, value])
    );
    assert.equal(rows.appName, 'SkyGenPanel');
    assert.equal(rows.vpPppoeUsername, 'VirtualParameters.PPPUsername');
    assert.equal(rows.vpRxPower, 'VirtualParameters.CustomRxPower');
    assert.equal(rows.vpUserPassword, '');
    assert.equal(rows.vpWanBridge, DEFAULT_SETTINGS.vpWanBridge);
  } finally {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('database migration replaces related tables atomically with foreign keys enabled', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skygenpanel-db-'));
  const source = sqlite(path.join(tempDir, 'source.sqlite'));
  const target = sqlite(path.join(tempDir, 'target.sqlite'));
  try {
    await ensureSchema(source);
    await ensureSchema(target);
    await seedGraph(source, 'source');
    await seedGraph(target, 'target');

    await copyData(source, target);

    assert.deepEqual(
      (await target('vendors').select('id', 'name')),
      [{ id: 1, name: 'Vendor source' }]
    );
    assert.deepEqual(
      (await target('mapping_nodes').select('node_id').orderBy('node_id')),
      [{ node_id: 'source-a' }, { node_id: 'source-b' }]
    );
    assert.deepEqual(
      (await target('mapping_edges').select('edge_id', 'source', 'target')),
      [{ edge_id: 'source-edge', source: 'source-a', target: 'source-b' }]
    );
    assert.deepEqual(
      (await target('customer_wifi_credentials')
        .select('account_id', 'wifi_index', 'ssid', 'password_ciphertext')),
      [{
        account_id: 1,
        wifi_index: 1,
        ssid: 'source-wifi',
        password_ciphertext: 'source-ciphertext'
      }]
    );
  } finally {
    await source.destroy();
    await target.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
