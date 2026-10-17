import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { TenantScopeError, runInTenant, currentTenantId } = await import('../src/config/tenantContext.js');
const { tdb, tinsert, tinsertReturningId } = await import('../src/config/database.js');
const { forSoleTenant } = await import('../src/config/tenantJobs.js');
const { default: MappingEdge } = await import('../src/models/MappingEdge.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');


let alfa;
let beta;

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

describe('a scoped table', () => {
  const account = (suffix) => ({
    customer_id: `CSG-SCOPE${suffix}-00000${suffix}`,
    device_id: `scope-dev-${suffix}`,
    identity_hash: String(suffix).repeat(64).slice(0, 64),
    software_id: 'V1',
    pppoe_username: `scope-${suffix}`,
    active: true
  });

  it('reads only the provider in scope', async () => {
    await runInTenant(alfa, () => tinsert('customer_accounts', account(1)));
    await runInTenant(beta, () => tinsert('customer_accounts', account(2)));

    const mine = await runInTenant(alfa, () => tdb('customer_accounts').select('device_id'));
    assert.deepEqual(mine.map((r) => r.device_id), ['scope-dev-1']);

    const theirs = await runInTenant(beta, () => tdb('customer_accounts').select('device_id'));
    assert.deepEqual(theirs.map((r) => r.device_id), ['scope-dev-2']);
  });

  it('cannot be read at all without a provider in scope', async () => {
    assert.throws(() => tdb('customer_accounts'), TenantScopeError);
    assert.throws(() => tinsert('customer_accounts', account(3)), TenantScopeError);
  });

  // knex ignores a where clause on an insert, so this would otherwise be an
  // unscoped write that looks entirely reasonable.
  it('refuses an insert through the query builder, pointing at tinsert', async () => {
    await runInTenant(alfa, () => {
      assert.throws(
        () => tdb('customer_accounts').insert(account(4)),
        /must go through tinsert/
      );
    });
  });

  it('stamps the provider on every row written', async () => {
    const id = await runInTenant(beta, () => tinsertReturningId('customer_accounts', account(5)));
    const row = await getDb()('customer_accounts').where({ id }).first();
    assert.equal(Number(row.tenant_id), Number(beta));
  });

  it('will not update or delete across providers', async () => {
    // Its own row rather than one left behind by an earlier test: a shared
    // fixture makes a failure here depend on what ran before it.
    const target = { ...account(6), device_id: 'scope-dev-target' };
    await runInTenant(alfa, () => tinsert('customer_accounts', target));

    const changed = await runInTenant(beta, () => tdb('customer_accounts')
      .where({ device_id: target.device_id })
      .update({ pppoe_username: 'stolen' }));
    assert.equal(changed, 0);

    const removed = await runInTenant(beta, () => tdb('customer_accounts')
      .where({ device_id: target.device_id })
      .del());
    assert.equal(removed, 0);

    const survivor = await getDb()('customer_accounts')
      .where({ device_id: target.device_id })
      .first();
    assert.ok(survivor, 'the row must still be there');
    assert.equal(survivor.pppoe_username, target.pppoe_username);
  });
});

describe('the scoping guard', () => {
  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  // The mechanism is only worth having if bypassing it is caught. Once a table
  // is converted, reaching it through the raw handle is how the filter gets
  // quietly lost again.
  it('finds no converted table reached through the raw database handle', () => {
    const allowed = new Set([
      // Copies the whole panel between databases; every row is its business.
      path.join(SRC, 'services', 'dbManagementService.js'),
      // The migration runner and the seed run before any provider exists — and
      // a backfill's whole job is to touch rows that do not have one yet. This
      // is the one place a file-wide pass is right rather than lazy: every
      // access here is legitimately cross-provider, so requiring a marker per
      // site would train the eye to skip them.
      path.join(SRC, 'config', 'migrations.js'),
      path.join(SRC, 'config', 'schema.js'),
      path.join(SRC, 'config', 'seed.js'),
      path.join(SRC, 'config', 'database.js')
    ]);

    const offences = [];
    for (const file of sourceFiles(SRC)) {
      if (allowed.has(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const table of SCOPED_TABLES) {
          const direct = new RegExp(`(getDb\\(\\)|\\bdb|\\btrx)\\(\\s*['"\`]${table}['"\`]`);
          if (!direct.test(line)) continue;
          // An exemption has to be written at the site and say why. A file-wide
          // pass would hide the next one that arrives underneath it.
          const preceding = lines.slice(Math.max(0, index - 12), index).join('\n');
          if (/tenant-scope-exempt:\s*\S/.test(preceding)) continue;
          offences.push(
            `${path.relative(SRC, file)}:${index + 1} reaches "${table}" directly`
          );
        }
      });
    }
    assert.deepEqual(offences, []);
  });
});

describe('a wholesale rewrite stops at the provider doing it', () => {
  const plant = (suffix) => ({
    nodes: [
      { node_id: `ODP-${suffix}`, type: 'ODP', name: `Caixa ${suffix}`, latitude: -23.5, longitude: -46.6 },
      { node_id: `OLT-${suffix}`, type: 'OLT', name: `OLT ${suffix}`, latitude: -23.4, longitude: -46.5 }
    ],
    edges: [
      { edge_id: `E-${suffix}`, source: `OLT-${suffix}`, target: `ODP-${suffix}`, fiber_type: 'drop' }
    ]
  });

  async function plantOf(tenantId) {
    const nodes = await getDb()('mapping_nodes').where({ tenant_id: tenantId }).pluck('node_id');
    const edges = await getDb()('mapping_edges').where({ tenant_id: tenantId }).pluck('edge_id');
    return { nodes: nodes.sort(), edges: edges.sort() };
  }

  // syncData deletes and reinserts in one transaction. Unqualified, importing a
  // map replaced every provider's plant with the importer's.
  it('leaves the other provider\'s fiber plant standing through a syncData', async () => {
    const a = plant('A');
    const b = plant('B');
    await runInTenant(alfa, () => MappingEdge.syncData(a.nodes, a.edges));
    await runInTenant(beta, () => MappingEdge.syncData(b.nodes, b.edges));

    assert.deepEqual(await plantOf(alfa), { nodes: ['ODP-A', 'OLT-A'].sort(), edges: ['E-A'] });
    assert.deepEqual(await plantOf(beta), { nodes: ['ODP-B', 'OLT-B'].sort(), edges: ['E-B'] });
  });

  it('leaves it standing through a resetAll too', async () => {
    const a = plant('A');
    const b = plant('B');
    await runInTenant(alfa, () => MappingEdge.syncData(a.nodes, a.edges));
    await runInTenant(beta, () => MappingEdge.syncData(b.nodes, b.edges));

    await runInTenant(beta, () => MappingEdge.resetAll());

    assert.deepEqual(await plantOf(alfa), { nodes: ['ODP-A', 'OLT-A'].sort(), edges: ['E-A'] });
    assert.deepEqual(await plantOf(beta), { nodes: [], edges: [] });
  });

  it('lets both providers use the same node and edge names', async () => {
    const shared = {
      nodes: [{ node_id: 'ODP-01', type: 'ODP', name: 'Mesma caixa', latitude: -1, longitude: -1 }],
      edges: []
    };
    await runInTenant(alfa, () => MappingEdge.syncData(shared.nodes, shared.edges));
    await runInTenant(beta, () => MappingEdge.syncData(shared.nodes, shared.edges));

    const [{ n }] = await getDb()('mapping_nodes').where({ node_id: 'ODP-01' }).count({ n: '*' });
    assert.equal(Number(n), 2);
  });

  // Choosing a default number cleared is_default on every row, everywhere.
  it('leaves the other provider\'s default WhatsApp number alone', async () => {
    const make = (tenantId, name, isDefault) => runInTenant(tenantId, () => WhatsAppAccount.create({
      name, purpose: 'support', flavor: 'v2', base_url: 'https://evo.example',
      status: 'connected', is_default: isDefault
    }));

    const theirs = await make(alfa, 'skygp_default_alfa', true);
    const mineFirst = await make(beta, 'skygp_first_beta', true);
    const mineSecond = await make(beta, 'skygp_second_beta', false);

    await runInTenant(beta, () => WhatsAppAccount.setDefault(mineSecond.id));

    const row = async (id) => getDb()('whatsapp_accounts').where({ id }).first();
    assert.equal(Boolean((await row(theirs.id)).is_default), true, 'the other provider keeps its default');
    assert.equal(Boolean((await row(mineFirst.id)).is_default), false);
    assert.equal(Boolean((await row(mineSecond.id)).is_default), true);
  });
});

describe('background work that still reads across providers', () => {
  // These jobs are driven by a query that has no provider in it yet — the
  // outbox reads every sendable message on the deployment. Running them once
  // per provider would send each message twice rather than split them, so they
  // run once and stop the day the assumption breaks. This suite has two
  // providers, so that day is now.
  it('refuses to run once a second provider exists', async () => {
    await assert.rejects(
      () => forSoleTenant('The WhatsApp outbox', async () => 'ran'),
      (error) => {
        assert.equal(error.name, 'TenantScopeError');
        assert.match(error.message, /The WhatsApp outbox/);
        assert.match(error.message, /Scope its driving query/);
        return true;
      }
    );
  });

  it('runs in the sole provider when there is only one', async () => {
    const db = getDb();
    await db('tenants').where({ id: beta }).update({ status: 'suspended' });
    try {
      const seen = await forSoleTenant('probe', () => currentTenantId());
      assert.equal(seen, alfa);
    } finally {
      await db('tenants').where({ id: beta }).update({ status: 'active' });
    }
  });
});
