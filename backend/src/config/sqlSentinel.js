import { currentContext } from './tenantContext.js';
import { SCOPED_TABLES } from './tenantScope.js';

/**
 * Fails any query that touches a provider-owned table without a provider
 * filter, so that every test in the suite is also a scoping test.
 *
 * The helpers in `database.js` make the filter impossible to forget as long as
 * a model goes through them; this catches the cases they cannot — the raw
 * handle with a table name on it, a `knex.raw`, a join that pulls in a second
 * scoped table and filters only the first. The static guard in
 * `tenant-scoping.test.js` reads the source for the first of those; this one
 * reads the SQL that actually left for the database, so it also sees the ones
 * no source pattern matches, and it sees them on the paths the tests really
 * walk rather than the ones a regex can imagine.
 *
 * It is a test instrument and nothing else: armed only under `APP_ENV=test`.
 * In production the query has already been written, and a panel that refuses
 * to serve a page because a SELECT looked wrong to a regex is a worse outage
 * than the leak it was guarding against.
 *
 * WHAT IT CANNOT SEE, and there is a fair amount of it:
 *
 *  - Whether the filter names the RIGHT provider. It looks for the column, not
 *    for the value; `where tenant_id = 7` inside provider 3's request passes.
 *    Proving the value is `tenant-leak.test.js`'s job — two providers, natural
 *    keys that deliberately collide, and an assertion about the rows that come
 *    back.
 *  - Anything the table name is not spelled out in: a view, a CTE that renames
 *    a scoped table, a subquery reached only by alias. The name has to appear
 *    literally in the statement text.
 *  - Which of several scoped tables in one statement a bare `tenant_id`
 *    belongs to. A statement naming one table is credited with an unqualified
 *    column, because it can only be that table's; a statement naming several
 *    has to carry a qualified `"table"."tenant_id"` for each, because
 *    "somebody in here filtered something" is not an isolation claim.
 *  - A filter that is there but useless — `tenant_id IS NOT NULL`, or one
 *    OR-ed with a condition that opens the row set up again. Reading a WHERE
 *    tree out of a SQL string is exactly the fragile parsing this avoids.
 *
 * So it is a floor, not a proof. It cannot say a query is right; it can only
 * say that a query which never mentions the provider column at all is wrong.
 */

const TENANT_COLUMN = 'tenant_id';

// A table name is only a table name when nothing word-ish sits against it,
// which is what keeps `wa_broadcasts` from matching inside
// `wa_broadcast_recipients`, and a column named after a table from counting as
// the table.
function nameIn(sql, name) {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(sql);
}

// Every dialect here quotes differently — SQLite and Postgres with double
// quotes, MySQL with backticks — and a hand-written `raw` quotes not at all.
// Matching around the separator covers the three without a dialect branch.
function qualifiedTenantColumn(sql, table) {
  return new RegExp(
    `(?<![A-Za-z0-9_])${table}["\`\\]]?\\s*\\.\\s*["\`\\[]?${TENANT_COLUMN}(?![A-Za-z0-9_])`
  ).test(sql);
}

// Only a statement that carries rows in or out can carry someone else's. DDL,
// PRAGMA and the transaction verbs name tables — a foreign key in a CREATE
// TABLE names two — and none of them reads a row belonging to anybody.
const DML = /^\s*(?:with\b[\s\S]*?\)\s*)?(select|insert|update|delete|replace)\b/i;

// knex's own plumbing, which parses as DML and names the table but never
// touches a row belonging to a provider: the catalogue lookup that precedes an
// ALTER, and the copy into the shadow table that SQLite's rebuild of an altered
// table is made of. Both come from the schema builder, so they are the
// migration's business rather than any provider's.
const KNEX_PLUMBING = /\bsqlite_master\b|\binformation_schema\b|_knex_temp_alter/i;

export function isDml(sql) {
  return DML.test(sql) && !KNEX_PLUMBING.test(sql);
}

/** The provider-owned tables this statement names. */
export function scopedTablesIn(sql) {
  return [...SCOPED_TABLES].filter((table) => nameIn(sql, table));
}

/**
 * The provider-owned tables this statement touches with no filter in sight.
 * Empty means it passes, which is a much weaker claim than that it is right.
 */
export function unscopedTablesIn(sql) {
  if (!isDml(sql)) return [];
  const tables = scopedTablesIn(sql);
  if (tables.length === 0) return [];

  // One table in the statement: an unqualified `tenant_id` anywhere in it can
  // only be that table's. This is the shape of nearly everything the helpers
  // emit — `insert into "settings" ("tenant_id", ...)` names the column in the
  // insert list, where there is no clause to qualify it with.
  if (tables.length === 1) {
    return nameIn(sql, TENANT_COLUMN) ? [] : tables;
  }

  return tables.filter((table) => !qualifiedTenantColumn(sql, table));
}

export class UnscopedQueryError extends Error {
  constructor(tables, sql, bindings, origin) {
    const plural = tables.length > 1;
    super(
      `SQL sentinel: ${tables.map((table) => `"${table}"`).join(', ')} `
      + `${plural ? 'are provider-owned tables' : 'is a provider-owned table'}, and this `
      + `query carries no provider filter for ${plural ? 'them' : 'it'}.\n`
      + `  from:     ${origin || 'unknown — no query builder was involved'}\n`
      + `  sql:      ${sql}\n`
      + `  bindings: ${JSON.stringify(bindings)}\n`
      + 'Either the query belongs on tdb()/tinsert(), or the read really does span '
      + 'every provider and belongs inside runUnscoped(reason, fn), with the reason '
      + 'written at the call site.'
    );
    this.name = 'UnscopedQueryError';
    this.tables = tables;
    this.sql = sql;
    this.origin = origin;
  }
}

/**
 * Where the query was written.
 *
 * knex emits `query` several async hops from the code that asked for it, so by
 * then the stack is nothing but knex frames and the await chain. That is why
 * the origin is taken when the builder is made and carried forward, rather
 * than read off the stack at the point of failure.
 */
function callSite() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  const { stack } = new Error();
  Error.stackTraceLimit = limit;

  // `database.js` is skipped along with knex's own frames: `tdb` and the
  // insert helpers are where the builder is made, never where the query was
  // decided on, and blaming them would file every caller's mistake under one
  // line of plumbing.
  const frame = (stack || '').split('\n').slice(2).find((line) => (
    line.includes('/')
    && !line.includes('node_modules/knex/')
    && !line.includes('sqlSentinel.js')
    && !line.includes('config/database.js')
    && !line.includes('node:internal')
  ));
  return frame ? frame.trim().replace(/^at\s+/, '') : null;
}

let judgeFixtures = false;

/** True for a query written by the test suite rather than by the panel. */
function fromTestSuite(origin) {
  if (judgeFixtures) return false;
  return Boolean(origin) && /[/\\]test[/\\]/.test(origin);
}

/**
 * Judges the suite's own fixtures for as long as `fn` runs.
 *
 * This exists so the sentinel's own test can watch it fire. Every other way of
 * proving that from a test is a lie: a fixture is precisely what the sentinel
 * declines to judge, so a planted query would pass and the test would report a
 * working guard whether or not one was there. Nothing but that test should
 * reach for this.
 */
export async function judgingFixtures(fn) {
  judgeFixtures = true;
  try {
    return await fn();
  } finally {
    judgeFixtures = false;
  }
}

// Set by the builder-level listener and read by the client-level one, which
// knex fires immediately afterwards on the same synchronous stack. The pair is
// what carries the verdict's inputs across the async gap, and one slot is
// enough because nothing else runs between those two events.
let pending = null;

const ARMED = Symbol.for('skygenpanel.sqlSentinel.armed');

/**
 * Tags every query builder with where it was written and what was declared
 * around it.
 *
 * Both have to be read HERE, while the builder is being made, because neither
 * survives to the point where the query is judged. The stack by then is knex's
 * own; and the provider context is gone too, which is the surprising half: the
 * connection pool resolves an acquisition from its own queue, so the
 * continuation that finally emits `query` runs outside the AsyncLocalStorage
 * scope the caller opened. (Inside a transaction it does survive — the
 * connection was taken once, up front — which is exactly the kind of
 * inconsistency that would make a `runUnscoped` declaration work in some
 * places and silently fail in others.)
 *
 * The patch goes on the client's prototype rather than on the instance because
 * a transaction runs on a client of its own, built with `Object.create` from
 * that same prototype — and a transaction is where the wholesale rewrites live.
 * An instance patch would leave exactly the statements worth watching untagged.
 */
function armBuilderCapture(client) {
  const prototype = Object.getPrototypeOf(client);
  if (prototype[ARMED]) return;
  prototype[ARMED] = true;

  for (const factory of ['queryBuilder', 'raw']) {
    const original = prototype[factory];
    prototype[factory] = function taggedFactory(...args) {
      const builder = original.apply(this, args);
      const written = { origin: callSite(), unscoped: currentContext()?.unscoped || null };
      if (typeof builder?.on === 'function') {
        builder.on('query', () => { pending = written; });
      }
      return builder;
    };
  }
}

/**
 * Arms the sentinel on a knex instance. A no-op unless `APP_ENV=test`.
 *
 * knex emits `query` from inside the promise that runs the statement, so
 * throwing here rejects that promise: the failure lands on the `await` that
 * asked for the query, inside the test that walked into it, instead of
 * arriving later as an unhandled rejection with nothing to attach it to. The
 * connection is released either way — knex acquires it in a `try/finally`
 * around the callback that emits this event.
 *
 * Two things are deliberately not judged:
 *
 *  - Work inside `runUnscoped`, which has already said in words that it spans
 *    every provider. That is the escape hatch, and it is a better one than a
 *    list of tolerated SQL patterns: a pattern list goes on passing long after
 *    the reason for it is gone, while a `runUnscoped` reason sits at the call
 *    site where the next reader can argue with it.
 *  - Queries written by the test suite itself. Fixtures reach for the raw
 *    handle on purpose — seeding one provider's rows to prove another cannot
 *    read them is the whole method of `tenant-leak.test.js` — and a fixture is
 *    not application code. It is the same boundary the static guard draws by
 *    scanning `src/` and nothing else. The cost is real: a sloppy fixture that
 *    matches a row without naming its provider goes unremarked. It is paid
 *    because the alternative is a `runUnscoped` wrapper around a hundred and
 *    fifty setup lines, which would teach everyone to reach for the hatch by
 *    reflex — and the hatch is only worth anything while it is rare.
 */
export function installSqlSentinel(knex) {
  if (process.env.APP_ENV !== 'test') return knex;

  armBuilderCapture(knex.client);

  knex.on('query', ({ sql, bindings }) => {
    const written = pending;
    pending = null;

    if (typeof sql !== 'string') return;
    if (written?.unscoped) return;
    if (fromTestSuite(written?.origin)) return;

    const offenders = unscopedTablesIn(sql);
    if (offenders.length > 0) {
      throw new UnscopedQueryError(offenders, sql, bindings, written?.origin);
    }
  });

  return knex;
}
