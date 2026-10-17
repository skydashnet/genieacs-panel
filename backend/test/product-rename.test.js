import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { migrations } = await import('../src/config/migrations.js');
const { seedDefaults } = await import('../src/config/seed.js');
const { PRODUCT_NAME } = await import('../src/config/brand.js');

/**
 * O produto passou a se chamar "TR69 Controle".
 *
 * O que muda é só o que ainda estava no valor de FÁBRICA: o provedor que nunca
 * escolheu nome e o `appName` que ninguém editou. Quem se deu um nome fica com
 * ele — trocar isso seria apagar uma escolha do provedor.
 */
const RENAME = migrations.find((m) => m.id === '0062_product_rename_tr69_controle');

before(async () => {
  await startTestServers();
});

after(async () => {
  await stopTestServers();
});

describe('product rename to TR69 Controle', () => {
  it('renames a provider still carrying a factory name, and only that one', async () => {
    const db = getDb();
    const antigo = await insertReturningId('tenants', { slug: 'antigo', name: 'SkyGenPanel', status: 'active' });
    const maisAntigo = await insertReturningId('tenants', { slug: 'mais-antigo', name: 'GenieACS Panel', status: 'active' });
    const escolhido = await insertReturningId('tenants', { slug: 'escolhido', name: 'Tavares Fibra', status: 'active' });

    assert.equal(await RENAME.isApplied(db), false);
    await RENAME.up(db);
    assert.equal(await RENAME.isApplied(db), true);

    assert.equal((await db('tenants').where({ id: antigo }).first()).name, PRODUCT_NAME);
    assert.equal((await db('tenants').where({ id: maisAntigo }).first()).name, PRODUCT_NAME);
    assert.equal((await db('tenants').where({ id: escolhido }).first()).name, 'Tavares Fibra');
  });

  it('moves the factory appName setting to the new name and leaves a typed one alone', async () => {
    const db = getDb();
    const fabrica = await insertReturningId('tenants', { slug: 'fabrica', name: 'Provedor A', status: 'active' });
    const proprio = await insertReturningId('tenants', { slug: 'proprio', name: 'Provedor B', status: 'active' });
    await db('settings').insert([
      { tenant_id: fabrica, key: 'appName', value: 'SkyGenPanel' },
      { tenant_id: proprio, key: 'appName', value: 'Meu Painel' }
    ]);

    await seedDefaults(db, { tenantIds: [fabrica, proprio] });

    const ler = async (tenantId) => (await db('settings').where({ tenant_id: tenantId, key: 'appName' }).first()).value;
    assert.equal(await ler(fabrica), PRODUCT_NAME);
    assert.equal(await ler(proprio), 'Meu Painel');
  });
});
