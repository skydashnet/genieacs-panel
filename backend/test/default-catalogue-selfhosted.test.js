import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O outro lado de `default-catalogue.test.js`: no self-hosted, o recuo para o
 * provedor de menor id CONTINUA copiando.
 *
 * `IS_SAAS` é lido no import, então a edição é fixada por arquivo. Este roda
 * self-hosted de propósito, mesmo que o ambiente diga outra coisa: ali a
 * instalação inteira é de um ISP só, e o catálogo dela é a única referência
 * que existe — um provedor novo nascer vazio seria a falha silenciosa que a
 * cópia existe para evitar.
 */
process.env.EDITION = 'selfhosted';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: Vendor } = await import('../src/models/Vendor.js');
const { catalogueSource, seedDefaults } = await import('../src/config/seed.js');

let instalacao;

before(async () => {
  await startTestServers();
  instalacao = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

describe('o catálogo padrão no self-hosted', () => {
  it('a fonte é o provedor de menor id, e o provedor novo herda dela', async () => {
    const db = getDb();
    await runInTenant(instalacao, () => Vendor.create({
      name: 'Fonte da instalação',
      manufacturer_patterns: ['zte'],
      product_patterns: ['f670'],
      wifi_password_path: 'PreSharedKey.1.KeyPassphrase',
      priority: 20,
      enabled: 1
    }));
    assert.equal((await catalogueSource(db)).kind, 'provider');

    await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    const novo = (await db('tenants').where({ slug: 'beta' }).first()).id;
    await seedDefaults();

    assert.deepEqual(
      (await db('vendors').where({ tenant_id: novo }).orderBy('id', 'asc')).map((v) => v.name),
      ['Fonte da instalação']
    );
  });
});
