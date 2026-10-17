import { getDb } from './database.js';
import { migrations } from './migrations.js';
import { runUnscoped } from './tenantContext.js';

export const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Creates the bookkeeping table. Returns true when this call created it, which
 * is how `ensureSchema` tells a brand-new database (or an installation that
 * predates the runner) from one it has already migrated.
 */
async function ensureMigrationsTable(db) {
  if (await db.schema.hasTable(MIGRATIONS_TABLE)) return false;
  try {
    await db.schema.createTable(MIGRATIONS_TABLE, (t) => {
      t.string('id', 128).primary();
      t.timestamp('applied_at').defaultTo(db.fn.now());
    });
    return true;
  } catch (error) {
    // Another process may have created it between the check and the create.
    if (!(await db.schema.hasTable(MIGRATIONS_TABLE))) throw error;
    return false;
  }
}

async function appliedIds(db) {
  const rows = await db(MIGRATIONS_TABLE).select('id');
  return new Set(rows.map((row) => row.id));
}

async function record(db, id) {
  await db(MIGRATIONS_TABLE).insert({ id, applied_at: db.fn.now() });
}

/**
 * Brings the database up to date, in order, recording every step it applies.
 *
 * Safe to call on every boot: steps that are already recorded are skipped, and
 * the ones that do run are idempotent anyway.
 *
 * An installation created before this runner existed has no `schema_migrations`
 * table but does have application tables. That case is baselined: each step is
 * asked whether its objects are already present, and if so it is recorded as
 * applied instead of being executed. Steps whose objects are missing (an old
 * database that never had `sgp_links`, say) still run, so a partial upgrade is
 * finished rather than skipped.
 */
export async function ensureSchema(db = getDb()) {
  return runUnscoped('the migration runner', () => migrate(db));
}

/**
 * Declared unscoped rather than left contextless because a backfill's whole job
 * is to touch rows that belong to a provider that does not exist yet: the step
 * that creates the first `tenants` row reads `settings` to name it, and the
 * SQLite rebuilds copy whole scoped tables into shadow tables. Every one of
 * those is a query the SQL sentinel would otherwise refuse, and rightly — it is
 * only the declaration here that tells it the crossing is deliberate.
 */
async function migrate(db) {
  const isNewLedger = await ensureMigrationsTable(db);
  const baseline = isNewLedger && (await db.schema.hasTable('users'));
  const applied = await appliedIds(db);

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const alreadyPresent = baseline && migration.isApplied
      ? await migration.isApplied(db)
      : false;
    if (!alreadyPresent) await migration.up(db);
    await record(db, migration.id);
  }
}
