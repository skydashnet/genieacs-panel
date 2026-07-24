import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { ensureSchema } from '../src/config/schema.js';
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
}

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
  } finally {
    await source.destroy();
    await target.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
