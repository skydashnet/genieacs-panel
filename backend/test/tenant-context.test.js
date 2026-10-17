import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const {
  TenantScopeError, currentContext, currentTenantId, hasTenantContext, runInTenant, runUnscoped
} = await import('../src/config/tenantContext.js');
const { tdb, tinsert, tinsertReturningId } = await import('../src/config/database.js');
const { SCOPED_TABLES, SHARED_TABLES, pendingTables, unknownScopedTables } = await import(
  '../src/config/tenantScope.js'
);
const { SCHEMA_TABLES } = await import('../src/config/migrations.js');

before(async () => {
  await startTestServers();
});

after(async () => {
  await stopTestServers();
});

describe('the provider in scope', () => {
  it('is whatever runInTenant was given', () => {
    runInTenant(7, () => {
      assert.equal(currentTenantId(), 7);
      assert.equal(hasTenantContext(), true);
    });
  });

  it('does not leak out of the callback', () => {
    runInTenant(7, () => currentTenantId());
    assert.equal(hasTenantContext(), false);
  });

  it('survives an await inside the callback', async () => {
    await runInTenant(9, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(currentTenantId(), 9);
    });
  });

  it('nests, innermost winning', () => {
    runInTenant(1, () => {
      runInTenant(2, () => assert.equal(currentTenantId(), 2));
      assert.equal(currentTenantId(), 1);
    });
  });

  // The point of the whole design: no default, so a forgotten scope is a
  // failure rather than a read of every provider's rows.
  it('throws rather than defaulting when there is none', () => {
    assert.throws(() => currentTenantId(), TenantScopeError);
  });

  it('rejects an id that is not a positive integer', () => {
    for (const bad of [0, -1, null, undefined, 'one', 1.5]) {
      assert.throws(() => runInTenant(bad, () => {}), TenantScopeError);
    }
  });
});

describe('deliberately unscoped work', () => {
  it('records why, and still refuses to invent a provider', () => {
    runUnscoped('copying the panel between databases', () => {
      assert.equal(currentContext().unscoped, 'copying the panel between databases');
      assert.throws(() => currentTenantId(), /copying the panel between databases/);
    });
  });

  it('cannot be opened without a reason', () => {
    assert.throws(() => runUnscoped('', () => {}), TenantScopeError);
  });
});

describe('the scoped table list', () => {
  it('names only tables the schema actually has', () => {
    assert.deepEqual(unknownScopedTables(), []);
  });

  it('accounts for every table, as scoped, shared or still pending', () => {
    const covered = new Set([...SCOPED_TABLES, ...SHARED_TABLES, ...pendingTables()]);
    assert.deepEqual([...covered].sort(), [...SCHEMA_TABLES].sort());
  });
});

describe('the scoped query builder', () => {
  // The transition behaviour, and what lets the conversion proceed a few tables
  // at a time. `users` stands in for "not converted yet" — it has to be a table
  // still absent from the allowlist, so this moves as the phase does. It took
  // over from `vendors`, scoped as of 0026, which took over from
  // `device_profiles`, scoped as of 0022.
  it('leaves a table that has not been converted unfiltered', async () => {
    const rows = await tdb('users').select('username').limit(1);
    assert.ok(Array.isArray(rows));
  });

  it('writes through tinsert without a provider while the table is pending', async () => {
    await tinsert('users', { username: 'scope-probe-pending', password: 'x' });
    const row = await getDb()('users').where({ username: 'scope-probe-pending' }).first();
    assert.equal(row.password, 'x');
  });

  /**
   * O `where` do `tdb` não se aplica a um insert — o knex o ignora — então o
   * `insert` recusa. O que faltava era a recusa sobreviver ao ENCADEAMENTO:
   * um builder do knex devolve a si mesmo em `where`, `whereIn` e afins, e
   * entregar o retorno cru derrubava o proxy. `tdb('x').where(...).insert(...)`
   * escrevia linha sem `tenant_id`, e o `defaultTo(tenant.id)` da coluna
   * absorvia em silêncio, arquivando a linha no provedor #1.
   *
   * Nenhum call site faz isso hoje. O sentido de um mecanismo é que nenhum
   * possa começar a fazer.
   */
  it('refuses an insert reached through a chained builder, not only a direct one', async () => {
    await runInTenant(1, () => {
      const scoped = tdb('customer_accounts');
      assert.throws(() => scoped.insert({ customer_id: 'x' }), TenantScopeError);

      for (const encadeado of [
        () => tdb('customer_accounts').where({ id: 1 }),
        () => tdb('customer_accounts').whereIn('id', [1, 2]),
        () => tdb('customer_accounts').orderBy('id', 'asc').limit(1)
      ]) {
        assert.throws(
          () => encadeado().insert({ customer_id: 'x' }),
          TenantScopeError,
          encadeado.toString()
        );
      }
    });
  });

  it('still answers a chained read normally', async () => {
    const rows = await runInTenant(1, () => tdb('customer_accounts')
      .where('id', '>', 0)
      .orderBy('id', 'asc')
      .limit(1)
      .select('id'));
    assert.ok(Array.isArray(rows), 'o guard não pode custar a leitura');
  });

  it('returns the generated id', async () => {
    // users is still pending, so this exercises the unscoped path.
    // mapping_nodes moved under scoping and now needs a provider — which is
    // what tenant-scoping.test.js covers.
    const id = await tinsertReturningId('users', {
      username: 'scope-probe-user',
      password: 'x'
    });
    assert.ok(Number(id) > 0);
  });
});
