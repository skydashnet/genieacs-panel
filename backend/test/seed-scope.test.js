import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { DEFAULT_SETTINGS, seedDefaults } from '../src/config/seed.js';

/**
 * Semear um provedor custa o de um provedor, e não o da instalação inteira.
 *
 * `seedDefaults` percorria todos os provedores — dezessete consultas cada um,
 * mesmo sem nada a inserir — e o cadastro público a chamava dentro da própria
 * transação. Medido: 24 consultas com um provedor, 704 com 41, 3424 com 201.
 * Numa rota sem sessão, isso é um custo que cresce com o número de clientes e
 * que qualquer estranho aciona.
 *
 * O que se afirma aqui é o teto: com trinta provedores a mais na instalação,
 * semear UM custa o mesmo que custaria sozinho. E que ele nasce inteiro —
 * settings, mapa, catálogo copiado de quem já tem, e o trial — porque a
 * economia não pode ter sido conseguida deixando algo de fora.
 */

const EXTRAS = 30;
let db;
let fonteId;

before(async () => {
  await startTestServers();
  db = getDb();
  const fonte = await db('tenants').orderBy('id', 'asc').first();
  fonteId = fonte.id;
  // O catálogo de que os novos vão copiar. Sem ele a cópia é vazia e o caso do
  // catálogo passaria sem provar que a fonte é achada fora da lista semeada.
  await db('vendors').insert({
    tenant_id: fonteId,
    name: 'Fabricante Fonte',
    manufacturer_patterns: JSON.stringify(['fonte']),
    product_patterns: JSON.stringify(['ONU-F']),
    parameter_prefix: 'InternetGatewayDevice',
    priority: 5,
    enabled: true
  });
  for (let i = 0; i < EXTRAS; i += 1) {
    await db('tenants').insert({ slug: `extra${i}`, name: `Extra ${i}`, status: 'active' });
  }
});

after(async () => {
  await stopTestServers();
});

async function contar(fn) {
  let n = 0;
  const conta = () => { n += 1; };
  db.on('query', conta);
  try {
    await fn();
  } finally {
    db.off('query', conta);
  }
  return n;
}

describe('seeding one provider', () => {
  let novoId;

  it('does not visit the other thirty', async () => {
    await db('tenants').insert({ slug: 'novato', name: 'Novato', status: 'active' });
    novoId = (await db('tenants').where({ slug: 'novato' }).first()).id;

    const consultas = await contar(() => seedDefaults(db, { tenantIds: [novoId] }));
    // Um provedor sozinho custa ~24 consultas mais a cópia do catálogo; trinta
    // a mais custariam mais de quinhentas. O teto fica bem acima do primeiro e
    // bem abaixo do segundo, para pegar a regressão e não o ruído.
    assert.ok(consultas < 80, `semear um provedor custou ${consultas} consultas`);

    const untouched = await db('settings').where({ tenant_id: (await db('tenants').where({ slug: 'extra0' }).first()).id });
    assert.equal(untouched.length, 0, 'os outros não podem ter sido semeados de carona');
  });

  it('still gives it everything a provider is born with', async () => {
    const settings = await db('settings').where({ tenant_id: novoId });
    assert.equal(settings.length, Object.keys(DEFAULT_SETTINGS).length);
    assert.ok(await db('map_settings').where({ tenant_id: novoId, id: 1 }).first(), 'o centro do mapa');
    const catalogo = await db('vendors').where({ tenant_id: novoId });
    assert.equal(catalogo.length, 1, 'o catálogo, copiado de um provedor FORA da lista semeada');
    assert.equal(catalogo[0].name, 'Fabricante Fonte');
    const assinatura = await db('subscriptions').where({ tenant_id: novoId }).first();
    assert.equal(assinatura?.status, 'trial');
  });

  // O boot continua semeando a instalação inteira: a economia é de quem pede
  // um provedor, não uma mudança no que o boot faz.
  it('the whole-deployment pass still seeds everybody', async () => {
    await seedDefaults(db);
    const extra = await db('tenants').where({ slug: 'extra7' }).first();
    assert.equal((await db('settings').where({ tenant_id: extra.id })).length, Object.keys(DEFAULT_SETTINGS).length);
    assert.equal((await db('subscriptions').where({ tenant_id: extra.id })).length, 1);
  });
});
