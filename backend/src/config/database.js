import knexFactory from 'knex';
import { buildKnexConfig, isSqlite } from './dbConfig.js';

let db;

export function getDb() {
  if (!db) {
    db = knexFactory(buildKnexConfig());
  }
  return db;
}

export async function testConnection() {
  try {
    await getDb().raw('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error.message);
    return false;
  }
}

export async function closePool() {
  if (db) {
    await db.destroy();
    db = null;
  }
}

export async function testExternalConnection(config) {
  let probe;
  try {
    probe = knexFactory(buildKnexConfig(config));
    await probe.raw('SELECT 1');
    return true;
  } catch (error) {
    throw new Error(error.message);
  } finally {
    if (probe) await probe.destroy();
  }
}

export { isSqlite };
