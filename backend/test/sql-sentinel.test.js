import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const {
  UnscopedQueryError, installSqlSentinel, judgingFixtures, scopedTablesIn, unscopedTablesIn
} = await import('../src/config/sqlSentinel.js');
const { runInTenant, runUnscoped } = await import('../src/config/tenantContext.js');
const { tdb, tinsert } = await import('../src/config/database.js');

let alfa;

before(async () => {
  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

describe('what the sentinel reads out of a statement', () => {
  it('names a provider-owned table that appears with no provider column', () => {
    assert.deepEqual(
      unscopedTablesIn('select * from `wa_messages` where `id` = ?'),
      ['wa_messages']
    );
  });

  it('accepts an unqualified column when only one table could own it', () => {
    assert.deepEqual(unscopedTablesIn('select * from "settings" where "tenant_id" = ?'), []);
    assert.deepEqual(
      unscopedTablesIn('insert into "settings" ("tenant_id", "key") values (?, ?)'),
      []
    );
  });

  // The case a whole-statement rule gets wrong: one filter is not two.
  it('demands a qualified column from each table when a statement names several', () => {
    const sql = 'select * from "wa_messages" '
      + 'inner join "wa_conversations" on "wa_conversations"."id" = "wa_messages"."conversation_id" '
      + 'where "wa_messages"."tenant_id" = ?';
    assert.deepEqual(unscopedTablesIn(sql), ['wa_conversations']);
  });

  it('reads the three dialects\' quoting, and none at all', () => {
    for (const sql of [
      'select * from `sgp_links` where `sgp_links`.`tenant_id` = ?',
      'select * from "sgp_links" where "sgp_links"."tenant_id" = ?',
      'select * from sgp_links where sgp_links.tenant_id = ?'
    ]) {
      assert.deepEqual(scopedTablesIn(sql), ['sgp_links']);
      assert.deepEqual(unscopedTablesIn(sql), []);
    }
  });

  // Only rows can be leaked. A foreign key names a table without reading it,
  // and knex reads the catalogue before every ALTER.
  it('says nothing about schema work', () => {
    assert.deepEqual(
      unscopedTablesIn('create table "x" ("id" integer, foreign key ("a") references "vendors" ("id"))'),
      []
    );
    assert.deepEqual(
      unscopedTablesIn("SELECT type, sql FROM sqlite_master WHERE lower(tbl_name)='vendors'"),
      []
    );
    assert.deepEqual(
      unscopedTablesIn('INSERT INTO "_knex_temp_alter123" SELECT * FROM "vendors"'),
      []
    );
  });

  it('says nothing about the tables that belong to the deployment', () => {
    assert.deepEqual(unscopedTablesIn('select * from `users` where `email` = ?'), []);
    assert.deepEqual(unscopedTablesIn('select * from `tenant_users` where `user_id` = ?'), []);
  });

  // `wa_broadcasts` is a prefix of `wa_broadcast_recipients`, and `vendor_id`
  // contains a table name that is not the table.
  it('does not mistake one name for another that contains it', () => {
    assert.deepEqual(
      scopedTablesIn('select * from `wa_broadcast_recipients` where `tenant_id` = ?'),
      ['wa_broadcast_recipients']
    );
    assert.deepEqual(scopedTablesIn('select * from `some_table` where `vendor_id` = ?'), []);
  });
});

// Without this the rest of the suite proves nothing: a sentinel that never
// fires and a sentinel that cannot fire look identical from every test that
// passes. `judgingFixtures` is what lets a fixture be judged like panel code,
// which is the only way to plant an unscoped query and watch it be refused.
describe('the sentinel firing', () => {
  it('rejects the query and names the table, the place and the SQL', async () => {
    await judgingFixtures(async () => {
      await assert.rejects(
        () => getDb()('customer_accounts').where({ device_id: 'no-such-device' }),
        (error) => {
          assert.ok(error instanceof UnscopedQueryError);
          assert.deepEqual(error.tables, ['customer_accounts']);
          assert.match(error.message, /sql:.*customer_accounts/s);
          assert.match(error.origin || '', /sql-sentinel\.test\.js/);
          return true;
        }
      );
    });
  });

  it('lets the same read through once it says why it spans every provider', async () => {
    await judgingFixtures(async () => {
      const rows = await runUnscoped(
        'the sentinel\'s own test, proving the hatch opens',
        () => getDb()('customer_accounts').where({ device_id: 'no-such-device' })
      );
      assert.deepEqual(rows, []);
    });
  });

  // The pool hands a connection back on its own callback, so by the time knex
  // announces the query the caller's provider context is gone. Reading the
  // declaration when the query is built rather than when it runs is what makes
  // the hatch work outside a transaction at all.
  it('honours the hatch on a pooled connection, not only inside a transaction', async () => {
    await judgingFixtures(async () => {
      await runUnscoped('a second pooled statement, after the first released its connection', async () => {
        await getDb()('wa_messages').where({ id: -1 });
        await getDb()('wa_conversations').where({ id: -1 });
      });
    });
  });

  // Nothing about a running panel should depend on it. A regex that decides a
  // query looks wrong must never be what takes a provider's dashboard down.
  it('is not armed anywhere but a test run', () => {
    const knex = {
      client: Object.create({ queryBuilder() {}, raw() {} }),
      listeners: 0,
      on() { this.listeners += 1; }
    };
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      installSqlSentinel(knex);
    } finally {
      process.env.APP_ENV = previous;
    }
    assert.equal(knex.listeners, 0);
  });

  it('stays quiet for the helpers, which write the filter themselves', async () => {
    await judgingFixtures(async () => {
      await runInTenant(alfa, async () => {
        await tinsert('settings', { key: 'sentinel.probe', value: 'x' });
        assert.equal((await tdb('settings').where({ key: 'sentinel.probe' }).first()).value, 'x');
      });
    });
  });
});
