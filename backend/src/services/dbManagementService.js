import knexFactory from 'knex';
import { getDb, closePool } from '../config/database.js';
import { buildKnexConfig, readDbConfig, writeDbConfig } from '../config/dbConfig.js';
import { ensureSchema } from '../config/schema.js';
import { seedDefaults } from '../config/seed.js';

const COPY_TABLES = [
  'users',
  'settings',
  'app_state',
  'vendors',
  'wifi_security_config',
  'wifi_security_mappings',
  'mapping_nodes',
  'mapping_edges',
  'map_settings',
  'customer_accounts'
];

function normalizeConfig(input) {
  const client = input.client === 'mysql' || input.client === 'mysql2' ? 'mysql2' : 'sqlite3';
  if (client === 'mysql2') {
    return {
      client: 'mysql2',
      host: input.host,
      port: Number(input.port) || 3306,
      user: input.user,
      password: input.password ?? '',
      database: input.database
    };
  }
  return { client: 'sqlite3' };
}

function validateExternal(config) {
  if (config.client !== 'mysql2') return;
  const missing = ['host', 'user', 'database'].filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing MySQL fields: ${missing.join(', ')}`);
  }
}

export async function testConfig(rawConfig) {
  const config = normalizeConfig(rawConfig);
  validateExternal(config);
  let probe;
  try {
    probe = knexFactory(buildKnexConfig(config));
    await probe.raw('SELECT 1');
    return true;
  } finally {
    if (probe) await probe.destroy();
  }
}

export function getActiveConfig() {
  const config = readDbConfig();
  const safe = { client: config.client === 'mysql2' || config.client === 'mysql' ? 'mysql2' : 'sqlite3' };
  if (safe.client === 'mysql2') {
    safe.host = config.host;
    safe.port = config.port;
    safe.user = config.user;
    safe.database = config.database;
  }
  return safe;
}

export async function copyData(source, target) {
  const snapshots = new Map();
  for (const table of COPY_TABLES) {
    if (await source.schema.hasTable(table)) {
      snapshots.set(table, await source(table).select('*'));
    }
  }

  await target.transaction(async (trx) => {
    for (const table of [...COPY_TABLES].reverse()) {
      if (await trx.schema.hasTable(table)) {
        await trx(table).del();
      }
    }

    for (const table of COPY_TABLES) {
      const rows = snapshots.get(table) || [];
      if (rows.length > 0 && await trx.schema.hasTable(table)) {
        await trx.batchInsert(table, rows, 100);
      }
    }
  });
}

function isSameConfig(left, right) {
  const a = normalizeConfig(left);
  const b = normalizeConfig(right);
  if (a.client !== b.client) return false;
  if (a.client === 'sqlite3') return true;
  return (
    a.host === b.host &&
    Number(a.port) === Number(b.port) &&
    a.user === b.user &&
    a.password === b.password &&
    a.database === b.database
  );
}

export async function switchDatabase(rawConfig, { migrateData = false } = {}) {
  const config = normalizeConfig(rawConfig);
  validateExternal(config);

  const currentConfig = readDbConfig();
  if (isSameConfig(currentConfig, config)) {
    writeDbConfig(config);
    return getActiveConfig();
  }

  await testConfig(config);

  const target = knexFactory(buildKnexConfig(config));
  try {
    await ensureSchema(target);

    if (migrateData) {
      const source = getDb();
      await copyData(source, target);
    } else {
      await seedDefaults(target);
    }
  } finally {
    await target.destroy();
  }

  writeDbConfig(config);
  await closePool();

  return getActiveConfig();
}
