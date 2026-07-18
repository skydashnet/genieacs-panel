import knexFactory from 'knex';
import { getDb, closePool } from '../config/database.js';
import { buildKnexConfig, readDbConfig, writeDbConfig } from '../config/dbConfig.js';
import { ensureSchema } from '../config/schema.js';
import { seedDefaults } from '../config/seed.js';

const COPY_TABLES = [
  'users',
  'settings',
  'vendors',
  'wifi_security_config',
  'wifi_security_mappings',
  'mapping_nodes',
  'mapping_edges',
  'map_settings'
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

async function copyData(source, target) {
  for (const table of COPY_TABLES) {
    const hasTable = await target.schema.hasTable(table);
    if (!hasTable) continue;

    const rows = await source(table).select('*');
    if (rows.length === 0) continue;

    await target(table).del();
    await target.batchInsert(table, rows, 100);
  }
}

export async function switchDatabase(rawConfig, { migrateData = false } = {}) {
  const config = normalizeConfig(rawConfig);
  validateExternal(config);

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
