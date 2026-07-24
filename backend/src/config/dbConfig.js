import fs from 'fs';
import path from 'path';
import { DB_CONFIG_PATH, SQLITE_PATH, ensureDataDir } from './paths.js';

const DEFAULT_CONFIG = { client: 'sqlite3' };

export function readDbConfig() {
  try {
    if (fs.existsSync(DB_CONFIG_PATH)) {
      const raw = fs.readFileSync(DB_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.client) return parsed;
    }
  } catch (error) {
    console.error('Failed reading db-config.json, falling back to SQLite:', error.message);
  }
  return DEFAULT_CONFIG;
}

export function writeDbConfig(config) {
  ensureDataDir();
  const tempPath = path.join(
    path.dirname(DB_CONFIG_PATH),
    `.db-config.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(tempPath, DB_CONFIG_PATH);
    fs.chmodSync(DB_CONFIG_PATH, 0o600);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

export function buildKnexConfig(config = readDbConfig()) {
  if (config.client === 'mysql2' || config.client === 'mysql') {
    return {
      client: 'mysql2',
      connection: {
        host: config.host,
        port: Number(config.port) || 3306,
        user: config.user,
        password: config.password,
        database: config.database,
        charset: 'utf8mb4'
      },
      pool: { min: 0, max: Number(config.poolMax) || 10 }
    };
  }

  ensureDataDir();
  return {
    client: 'better-sqlite3',
    connection: { filename: config.filename || SQLITE_PATH },
    useNullAsDefault: true,
    pool: {
      afterCreate(conn, done) {
        conn.pragma('foreign_keys = ON');
        done(null, conn);
      }
    }
  };
}

export function isSqlite(config = readDbConfig()) {
  return config.client !== 'mysql2' && config.client !== 'mysql';
}
