import knexFactory from 'knex';
import { buildKnexConfig, isSqlite } from './dbConfig.js';
import { installSqlSentinel } from './sqlSentinel.js';
import { installRls } from './rls.js';
import { currentTenantId, TenantScopeError } from './tenantContext.js';
import { isScoped } from './tenantScope.js';

const TENANT_COLUMN = 'tenant_id';

let db;

export function getDb() {
  if (!db) {
    // Armed here rather than at the call sites so that every query reaches it,
    // including the ones written before the helpers existed. Under any other
    // APP_ENV this returns the handle untouched.
    const config = buildKnexConfig();
    // A ordem importa: a sentinela observa o SQL que sai, e o envoltório do RLS
    // acrescenta uma transação por consulta. Envolvendo por fora, a sentinela
    // continua vendo exatamente o mesmo SQL que veria sem RLS — do contrário
    // toda leitura escopada passaria a chegar nela dentro de uma transação e a
    // guarda mudaria de comportamento por causa de uma opção de deploy.
    db = installRls(installSqlSentinel(knexFactory(config)), { client: config.client });
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

/**
 * Inserts a row and returns its generated id.
 *
 * SQLite and MySQL hand the id back from `insert()` itself; Postgres needs an
 * explicit RETURNING clause and gives back a row object. Asking every dialect
 * for RETURNING would work but makes knex log a warning on MySQL, so the
 * branch is explicit and the non-Postgres path stays what it always was.
 *
 * The dialect is read off the connection rather than re-read from the config
 * file, which would mean a synchronous disk read on every insert — and would
 * describe the wrong connection for a transaction opened on another instance.
 */
export async function insertReturningId(table, row, trx = null) {
  const knex = trx || getDb();

  if (knex.client.config.client === 'pg') {
    const [inserted] = await knex(table).insert(row).returning('id');
    return typeof inserted === 'object' && inserted !== null ? inserted.id : inserted;
  }

  const [id] = await knex(table).insert(row);
  return id;
}

/**
 * A query builder for a table that belongs to one provider, with the provider's
 * filter already applied.
 *
 * Models call this instead of `getDb()` and stop knowing that providers exist.
 * The filter cannot be forgotten because it is never written by hand, and a
 * call made with no provider in scope throws rather than reading everyone's
 * rows.
 *
 * A table not yet converted (see `tenantScope.js`) is returned unfiltered,
 * which is what makes the conversion possible a few tables at a time.
 */
export function tdb(table, trx = null) {
  const knex = trx || getDb();
  if (!isScoped(table)) return knex(table);

  const query = knex(table).where(`${table}.${TENANT_COLUMN}`, currentTenantId());

  // knex ignores `where` on an insert, so `tdb('x').insert(...)` would write an
  // unscoped row and look perfectly reasonable doing it. Closing that door here
  // is the difference between a mechanism and a convention.
  //
  // The guard has to survive CHAINING, which is the part that was missing: a
  // knex builder returns itself from `where`, `whereIn` and the rest, so
  // handing back the bare return value dropped the proxy and
  // `tdb('x').where(...).insert(...)` wrote a row with no provider on it. The
  // column's `defaultTo(tenant.id)` then absorbed it in silence, filing another
  // ISP's row under provider #1 instead of raising. No call site does that
  // today; the point of a mechanism is that none can start.
  return guardInserts(query, table);
}

/**
 * Wraps one builder so that `insert` refuses and every builder it hands back
 * carries the same refusal.
 */
function guardInserts(query, table) {
  return new Proxy(query, {
    get(target, property, receiver) {
      if (property === 'insert') {
        return () => {
          throw new TenantScopeError(
            `insert into "${table}" must go through tinsert(), which sets the provider; `
            + 'a where clause does not apply to an insert.'
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        // A knex builder returns ITSELF for chaining, and that is the case
        // worth catching: give back the proxy instead so the next link is
        // guarded too. Anything else — a promise from `then`, a string from
        // `toString` — is the method's own answer and passes through untouched.
        return result === target ? receiver : result;
      };
    }
  });
}

/** The provider column for a row about to be written, or nothing when the table is not scoped. */
function withTenant(table, row) {
  if (!isScoped(table)) return row;
  const tenantId = currentTenantId();
  return Array.isArray(row)
    ? row.map((one) => ({ ...one, [TENANT_COLUMN]: tenantId }))
    : { ...row, [TENANT_COLUMN]: tenantId };
}

/**
 * Insert into a provider-owned table. Returns the knex insert builder, so
 * `onConflict(...).merge(...)` still chains off it.
 */
export function tinsert(table, row, trx = null) {
  const knex = trx || getDb();
  return knex(table).insert(withTenant(table, row));
}

/**
 * Chunked insert with the provider set on every row.
 *
 * `knex.batchInsert` takes the table name as a string and never passes through
 * `tdb`, so a caller reaching for it directly writes rows with no provider —
 * and the column's default would file them under the installation's own,
 * silently and wrongly, for anybody else. Long recipient lists still need the
 * chunking, so the stamping lives here rather than the call site.
 */
export function tbatchInsert(table, rows, chunkSize = 50, trx = null) {
  const knex = trx || getDb();
  return knex.batchInsert(table, withTenant(table, rows), chunkSize);
}

/** Insert and return the generated id, with the provider set. */
export function tinsertReturningId(table, row, trx = null) {
  return insertReturningId(table, withTenant(table, row), trx);
}

/**
 * Se um erro é o banco recusando uma linha por índice único — nos três
 * dialetos. Quem trata uma corrida entre dois escritores iguais precisa
 * perguntar isto, e cada um perguntava com a própria lista de códigos.
 */
export function isUniqueViolation(error) {
  const code = String(error?.code ?? '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'ER_DUP_ENTRY' || code === '23505';
}

/**
 * Se um erro é o banco desfazendo uma escrita por deadlock (ou, no SQLite, por
 * arquivo ocupado) — o tipo de erro em que tentar de novo é a resposta certa.
 */
export function isDeadlock(error) {
  const code = String(error?.code ?? '');
  return code === 'ER_LOCK_DEADLOCK' || Number(error?.errno) === 1213
    || code === '40P01' || code === 'SQLITE_BUSY';
}

/**
 * Roda `fn` e, se o banco a desfizer por deadlock, roda de novo — até
 * `attempts` vezes, com uma pausa curta e sorteada entre elas para as duas
 * escritas não baterem de novo no mesmo instante. Qualquer outro erro sobe na
 * hora.
 *
 * Existe por causa do MySQL: `INSERT … ON DUPLICATE KEY UPDATE` simultâneos
 * na mesma tabela (a sincronização da frota grava vários vínculos em
 * paralelo) podem travar um ao outro no InnoDB, e o banco resolve derrubando
 * um deles. A escrita derrubada não fez nada; repeti-la é seguro.
 */
export async function withDeadlockRetry(fn, { attempts = 3, pauseMs = 25 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isDeadlock(error)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, pauseMs * attempt + Math.floor(Math.random() * pauseMs)); });
    }
  }
}

export { isSqlite };
