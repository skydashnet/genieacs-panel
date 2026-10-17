import fs from 'fs';
import path from 'path';
import { DB_CONFIG_PATH, SQLITE_PATH, ensureDataDir } from './paths.js';

const DEFAULT_CONFIG = { client: 'sqlite3' };

const MYSQL_CLIENTS = new Set(['mysql', 'mysql2']);
const POSTGRES_CLIENTS = new Set(['pg', 'postgres', 'postgresql']);

/** Canonical knex client name for whatever spelling the stored config uses. */
export function resolveClient(config = readDbConfig()) {
  const client = String(config?.client || '').toLowerCase();
  if (MYSQL_CLIENTS.has(client)) return 'mysql2';
  if (POSTGRES_CLIENTS.has(client)) return 'pg';
  return 'better-sqlite3';
}

/**
 * The connection as an environment variable, for the deployment that has no
 * disk worth keeping a file on.
 *
 * `db-config.json` is right for a self-hosted install: the operator switches
 * databases from the settings screen, and the file is what remembers it. The
 * hosted edition runs from an image against a managed Postgres, where the
 * connection is a secret the platform injects and the settings screen does not
 * exist. `DATABASE_URL` wins over the file when both are present, so an image
 * cannot be pointed at the wrong database by a stale volume.
 *
 *   postgres://user:pass@host:5432/dbname?schema=panel&sslmode=require
 *   mysql://user:pass@host:3306/dbname
 *
 * `schema` (Postgres only) is the search path, which is how one managed
 * database can hold more than one panel. `sslmode=require` turns TLS on with
 * verification; `sslmode=no-verify` keeps TLS and drops the check, for a
 * provider whose certificate chain is not the machine's to trust.
 */
export function dbConfigFromEnv(url = process.env.DATABASE_URL) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const client = POSTGRES_CLIENTS.has(scheme) ? 'pg' : MYSQL_CLIENTS.has(scheme) ? 'mysql2' : null;
  if (!client) {
    throw new Error(`DATABASE_URL must start with postgres:// or mysql://; received "${scheme}://"`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL names no database');

  const config = {
    client,
    host: parsed.hostname,
    port: Number(parsed.port) || (client === 'pg' ? 5432 : 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database
  };
  const schema = parsed.searchParams.get('schema');
  if (client === 'pg' && schema) config.schema = schema;
  const sslmode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
  if (sslmode && sslmode !== 'disable') {
    config.ssl = true;
    config.sslRejectUnauthorized = sslmode !== 'no-verify';
  }
  const poolMax = Number(parsed.searchParams.get('pool'));
  if (poolMax > 0) config.poolMax = poolMax;
  return config;
}

export function readDbConfig() {
  const fromEnv = dbConfigFromEnv();
  if (fromEnv) return fromEnv;
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
  const client = resolveClient(config);

  if (client === 'pg') {
    return {
      client: 'pg',
      connection: {
        host: config.host,
        port: Number(config.port) || 5432,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized !== false } : false
      },
      // Lets one database hold several independent panels — which is how the
      // test suite keeps parallel files apart, and how a deployment can share
      // a managed Postgres it does not own outright.
      ...(config.schema ? { searchPath: [config.schema] } : {}),
      pool: { min: 0, max: Number(config.poolMax) || 10 }
    };
  }

  if (client === 'mysql2') {
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
      /**
       * O que toda conexão SQLite precisa antes da primeira consulta.
       *
       * O padrão do SQLite é o journal `delete`, em que um leitor tranca um
       * escritor e um escritor tranca os leitores — o arquivo inteiro, não a
       * linha. E cada conexão do `better-sqlite3` é um handle próprio sobre o
       * mesmo arquivo: o pool do knex abre até dez, elas colidem de verdade
       * dentro do processo, e o `skygenpanel-backup` é um segundo processo
       * abrindo o mesmo banco. Sem `busy_timeout`, essa colisão não espera —
       * vira `SQLITE_BUSY` na hora, que chega ao operador como "database is
       * locked" sem nada por perto que explique.
       *
       * `journal_mode` é PERSISTENTE: mora no cabeçalho do arquivo, então
       * aplicá-lo por conexão é no-op depois da primeira. Fica aqui mesmo
       * assim, porque é aqui que a conexão nasce e porque um arquivo novo —
       * install novo, banco de teste — precisa dele igual. Já o `busy_timeout`
       * é por conexão, e por isso NÃO pode sair daqui.
       *
       * Cinco segundos é escolha, não número redondo: o `better-sqlite3` é
       * síncrono, então esperar por um lock trava o event loop inteiro e não só
       * a consulta. É margem para o `backup()`, que copia página a página e é o
       * único concorrente entre processos, e é curto o bastante para um lock
       * preso não virar um servidor mudo por meio minuto.
       *
       * O que deliberadamente NÃO está aqui: `synchronous = NORMAL`, que
       * costuma acompanhar o WAL e troca durabilidade por velocidade — decisão
       * de operação, não padrão; e `pool.max = 1`, que mataria a contenção e
       * abriria deadlock, porque uma transação seguraria a única conexão
       * enquanto qualquer consulta fora dela esperaria para sempre.
       */
      afterCreate(conn, done) {
        conn.pragma('journal_mode = WAL');
        conn.pragma('busy_timeout = 5000');
        conn.pragma('foreign_keys = ON');
        done(null, conn);
      }
    }
  };
}

export function isSqlite(config = readDbConfig()) {
  return resolveClient(config) === 'better-sqlite3';
}
