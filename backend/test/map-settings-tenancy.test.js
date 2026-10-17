import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertReturningId, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: MapSettings } = await import('../src/models/MapSettings.js');
const { default: migrations } = await import('../src/config/migrations.js');
const { runUnscoped } = await import('../src/config/tenantContext.js');

/**
 * The map centre, per provider.
 *
 * `map_settings` was the only unconverted table whose WHERE was not an identity
 * filter at all. It is a singleton keyed `id: 1`, so `where({ id: 1 })` meant
 * "the only row" — and the second provider to save its map centre wrote over
 * the first's, while `reset()` put the deployment's single row back to defaults
 * for everybody. There is nothing shared about a latitude: it is literally
 * where one ISP's city is.
 *
 * Migration 0025 makes the key `(tenant_id, id)`, so each provider keeps its
 * own row 1 and `tdb` supplies the provider half.
 */
let alfa;
let beta;

before(async () => {
  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', {
    slug: 'beta', name: 'Provedor Beta', status: 'active'
  });
});

after(async () => {
  await stopTestServers();
});

const save = (tenant, patch) => runInTenant(tenant, () => MapSettings.upsert(patch));
const read = (tenant) => runInTenant(tenant, () => MapSettings.get());

const SANTAREM = { center_lat: '-2.4431', center_lng: '-54.7083', max_zoom_in: '19', max_zoom_out: '4', default_zoom: '14' };
const MANAUS = { center_lat: '-3.1190', center_lng: '-60.0217', max_zoom_in: '17', max_zoom_out: '6', default_zoom: '12' };

describe('two providers, two cities', () => {
  it('lets each keep its own centre', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);

    const deAlfa = await read(alfa);
    const deBeta = await read(beta);
    assert.equal(deAlfa.center_lat, SANTAREM.center_lat, 'Alfa is still where Alfa put it');
    assert.equal(deBeta.center_lat, MANAUS.center_lat);
    assert.notEqual(deAlfa.center_lat, deBeta.center_lat);
  });

  it('keeps a save by one from moving the other', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);
    // The bug, exactly: with one deployment-wide row, this second save WAS the
    // first provider's map from here on.
    await save(beta, { ...MANAUS, default_zoom: '15' });

    const deAlfa = await read(alfa);
    assert.equal(deAlfa.center_lat, SANTAREM.center_lat);
    assert.equal(deAlfa.default_zoom, SANTAREM.default_zoom, 'Alfa never asked for a new zoom');
  });

  it('resets one provider without resetting the other', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);

    await runInTenant(beta, () => MapSettings.reset());

    const deAlfa = await read(alfa);
    const deBeta = await read(beta);
    assert.equal(deAlfa.center_lat, SANTAREM.center_lat, 'a reset next door is not a reset here');
    assert.notEqual(deBeta.center_lat, MANAUS.center_lat, 'and Beta really did reset');
  });

  it('gives each provider its own row 1 rather than sharing one', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);

    // Read unfiltered on purpose: the claim is about what the TABLE holds. A
    // scoped read would show one row either way and prove nothing.
    const rows = await getDb()('map_settings').where({ id: 1 }).orderBy('tenant_id');
    assert.equal(rows.length, 2, 'the old primary key allowed exactly one');
    assert.deepEqual(rows.map((r) => Number(r.tenant_id)), [Number(alfa), Number(beta)]);
  });
});

describe('o padrão é Brasília, não Jacarta', () => {
  const passo = migrations.find((m) => m.id === '0061_map_center_brasilia');
  // O runner roda os passos fora de qualquer provedor (`ensureSchema`); aqui também.
  const semProvedor = (fn) => runUnscoped('teste do passo 0061', fn);
  const JACARTA = { center_lat: '-6.2088', center_lng: '106.8456', max_zoom_in: '18', max_zoom_out: '5', default_zoom: '13' };

  it('restaurar o padrão leva a Brasília', async () => {
    await save(alfa, SANTAREM);
    await runInTenant(alfa, () => MapSettings.reset());
    const deAlfa = await read(alfa);
    assert.equal(deAlfa.center_lat, '-15.7942');
    assert.equal(deAlfa.center_lng, '-47.8822');
  });

  it('a migração tira de Jacarta só quem ainda está lá', async () => {
    assert.ok(passo, 'o passo 0061 existe');
    await save(alfa, JACARTA);
    await save(beta, MANAUS);
    assert.equal(await semProvedor(() => passo.isApplied(getDb())), false, 'há provedor em Jacarta');

    await semProvedor(() => passo.up(getDb()));

    const deAlfa = await read(alfa);
    const deBeta = await read(beta);
    assert.equal(deAlfa.center_lat, '-15.7942');
    assert.equal(deAlfa.center_lng, '-47.8822');
    assert.equal(deAlfa.default_zoom, JACARTA.default_zoom, 'o zoom não é tocado');
    assert.equal(deBeta.center_lat, MANAUS.center_lat, 'quem escolheu a própria cidade fica onde está');
    assert.equal(await semProvedor(() => passo.isApplied(getDb())), true);
  });
});
