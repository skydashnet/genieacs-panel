import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * De quem um provedor novo herda o catálogo de equipamentos.
 *
 * Até aqui: do provedor de MENOR ID que tivesse um. Era certo com um ISP — é o
 * provedor que a migração 0026 carimbou sobre as linhas que já existiam, logo é
 * o catálogo que o deploy de fato roda. Com vários, virou outra coisa: o
 * primeiro ISP passou a ser a referência de todos os próximos sem ninguém ter
 * decidido isso, e ele edita ou apaga o dele à vontade, porque é dele.
 *
 * O que o arquivo prova é a inversão e o que ela NÃO derruba: com uma caixa de
 * plataforma, ela manda; sem caixa, a regra antiga vale byte por byte no
 * self-hosted (`default-catalogue-selfhosted.test.js`). Na edição hospedada,
 * que é a deste arquivo, o recuo para um provedor não copia nada: o catálogo de
 * um cliente não vira o de outro.
 *
 * Por que isto não é cosmético: do catálogo saem os caminhos de parâmetro que o
 * painel ESCREVE no CPE. Sem ele a troca de senha de WiFi adivinha o caminho —
 * inclusive quando quem troca é o assinante pelo portal — e o provisionamento
 * para de escrever VLAN e service list. A falha é silenciosa.
 */
/**
 * Edição hospedada, e antes do harness: `User.createFirstAdmin` só põe o
 * primeiro administrador no cadastro da plataforma quando `IS_SAAS`, que é lido
 * no import. Sem esta linha a sessão da dona não abre o console, e a rota
 * responde 404 a ela — que é a resposta certa para quem não tem a chave, e não
 * o que este arquivo quer medir. É também o cenário honesto: caixa de
 * plataforma só existe em deploy hospedado.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Vendor } = await import('../src/models/Vendor.js');
const { default: WifiSecurityConfig } = await import('../src/models/WifiSecurityConfig.js');
const { catalogueSource, seedDefaults } = await import('../src/config/seed.js');

let panelUrl;
let instalacao;

const vendorRow = (nome) => ({
  name: nome,
  manufacturer_patterns: ['zte'],
  product_patterns: ['f670'],
  wifi_password_path: 'PreSharedKey.1.KeyPassphrase',
  priority: 20,
  enabled: 1
});

const criarProvedor = async (slug, name, kind = 'provider') => {
  const db = getDb();
  await db('tenants').insert({ slug, name, status: 'active', kind });
  return (await db('tenants').where({ slug }).first()).id;
};

const vendorsDe = (tenantId) =>
  getDb()('vendors').where({ tenant_id: tenantId }).orderBy('id', 'asc');

const apagarCatalogo = async (tenantId) => {
  const db = getDb();
  await db('vendors').where({ tenant_id: tenantId }).del();
  await db('wifi_security_config').where({ tenant_id: tenantId }).del();
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  instalacao = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

describe('a fonte do catálogo padrão', () => {
  it('sem caixa de plataforma, é o provedor de menor id que tenha catálogo', async () => {
    // O comportamento de hoje, e o que protege todo install self-hosted: ali
    // não há plataforma nenhuma para decidir, e a instalação é a única
    // referência que existe.
    await runInTenant(instalacao, () => Vendor.create(vendorRow('Fonte da instalação')));
    const fonte = await catalogueSource(getDb());
    assert.equal(fonte.kind, 'provider');
    assert.equal(Number(fonte.id), Number(instalacao));
  });

  /**
   * Mas, na edição hospedada, um provedor novo NÃO herda dela. Fonte `provider`
   * aqui é o catálogo que outro cliente customizou — os fabricantes e o
   * `wifi_security_config` dele —, e copiá-lo é vazar dado de um provedor para
   * outro. O recuo continua valendo no self-hosted, onde a instalação inteira é
   * de um ISP só (`default-catalogue-selfhosted.test.js`).
   */
  it('e, na edição hospedada, o provedor novo NÃO herda dela', async () => {
    const novo = await criarProvedor('beta', 'Provedor Beta');
    await seedDefaults();
    assert.deepEqual(await vendorsDe(novo), []);
    assert.equal(
      (await getDb()('wifi_security_config').where({ tenant_id: novo })).length,
      0
    );
    // E a fonte de quem ninguém copiou segue intacta.
    assert.deepEqual(
      (await vendorsDe(instalacao)).map((v) => v.name),
      ['Fonte da instalação']
    );
  });
});

/**
 * A inversão, e o caso que dá nome ao arquivo.
 */
describe('e com a caixa da plataforma', () => {
  let caixa;

  before(async () => {
    // Criada DEPOIS dos provedores, então com id MAIOR — que é a situação real
    // de qualquer deploy que rodou `create-platform-tenant.js` depois de já
    // atender ISPs. Sob a regra antiga ela nunca seria escolhida.
    caixa = await criarProvedor('plataforma', 'Plataforma', 'platform');
    await runInTenant(caixa, () => Vendor.create(vendorRow('Fabricante da plataforma')));
    await runInTenant(caixa, () => WifiSecurityConfig.create({
      product_class: 'F670L',
      security_types: 'WPA2',
      password_param_path: 'PreSharedKey.1.KeyPassphrase'
    }));
  });

  it('a fonte passa a ser ela, mesmo havendo provedor com id menor', async () => {
    const fonte = await catalogueSource(getDb());
    assert.equal(fonte.kind, 'platform');
    assert.equal(Number(fonte.id), Number(caixa));
  });

  it('e o provedor que nasce agora herda o catálogo DELA', async () => {
    const novo = await criarProvedor('gama', 'Provedor Gama');
    await seedDefaults();
    assert.deepEqual(
      (await vendorsDe(novo)).map((v) => v.name),
      ['Fabricante da plataforma']
    );
  });

  it('e quem já tinha catálogo não é tocado', async () => {
    // Apagar um fabricante é uma edição como outra qualquer: o que ficou de pé
    // quer dizer que um operador esteve ali, e o catálogo é dele.
    assert.deepEqual(
      (await vendorsDe(instalacao)).map((v) => v.name),
      ['Fonte da instalação']
    );
  });

  it('e não copia de novo no boot seguinte', async () => {
    const antes = (await vendorsDe(caixa)).map((v) => v.name);
    await seedDefaults();
    assert.deepEqual((await vendorsDe(caixa)).map((v) => v.name), antes);
  });
});

/**
 * A caixa vazia, na edição hospedada.
 *
 * Antes ela recebia cópia do primeiro ISP no boot, e era assim que nascia com
 * o catálogo do deploy. Era também a mesma cópia entre clientes que a regra
 * acima proíbe: o catálogo do primeiro ISP é dele, customizado por ele. Agora
 * a caixa é montada por quem opera o deploy, e o console mostra a fonte como
 * `provider` enquanto ela estiver vazia.
 */
describe('e a caixa vazia', () => {
  it('não recebe cópia de provedor nenhum, e nem o provedor que nasce junto', async () => {
    const db = getDb();
    const caixa = await db('tenants').where({ kind: 'platform' }).first();
    await apagarCatalogo(caixa.id);

    // Vazia, ela não pode ser a fonte de ninguém — inclusive de si mesma. E o
    // `kind` continua dizendo 'provider', que é o que o console exibe.
    const fonte = await catalogueSource(db);
    assert.equal(fonte.kind, 'provider');

    const novo = await criarProvedor('epsilon', 'Provedor Epsilon');
    await seedDefaults();
    assert.deepEqual(await vendorsDe(caixa.id), []);
    assert.deepEqual(await vendorsDe(novo), []);
    assert.equal((await catalogueSource(db)).kind, 'provider');

    // Recheada à mão — o caminho que sobra —, ela volta a ser a fonte. É também
    // o estado de que a rota do console, logo abaixo, precisa.
    await runInTenant(caixa.id, () => Vendor.create(vendorRow('Fabricante da plataforma')));
    assert.equal((await catalogueSource(db)).kind, 'platform');
  });
});

describe('e a rota do console', () => {
  let token;
  let tokenSemChave;

  before(async () => {
    const setup = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
    });
    // O `setup` já pode ter sido consumido por outro passo; o que importa é ter
    // uma sessão de quem está no cadastro da plataforma.
    if (setup.status === 201) {
      token = setup.body.data.token;
    } else {
      const entrou = await call(`${panelUrl}/api/auth/login`, {
        method: 'POST',
        body: { username: 'a-dona', password: 'senha-da-dona-1' }
      });
      token = entrou.body.data.token;
    }

    const criado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {
        username: 'so-do-provedor', password: 'senha-do-operador-1',
        role: 'admin', email: 'so-do-provedor@exemplo.test'
      }
    });
    assert.equal(criado.status, 201);
    const entrou = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'so-do-provedor', password: 'senha-do-operador-1' }
    });
    tokenSemChave = entrou.body.data.token;
  });

  const ler = (comToken = token) =>
    call(`${panelUrl}/api/platform/catalogue`, { headers: authHeaders(comToken) });

  it('diz qual catálogo está valendo e quem é o dono dele', async () => {
    const resposta = await ler();
    assert.equal(resposta.status, 200);
    const { source, sourceTenant, box } = resposta.body.data;
    assert.equal(source, 'platform');
    assert.equal(box.slug, 'plataforma');
    assert.equal(sourceTenant.slug, 'plataforma');
  });

  it('e nomeia os fabricantes que o provedor novo vai herdar', async () => {
    const { defaults } = (await ler()).body.data;
    assert.ok(defaults.vendors > 0, 'o catálogo padrão tem que ter fabricante');
    for (const fabricante of defaults.vendorNames) {
      assert.equal(typeof fabricante.name, 'string');
      assert.equal(typeof fabricante.enabled, 'boolean');
    }
  });

  /**
   * O fato que SÓ o console sabe: nenhum provedor enxerga os outros, então
   * "quem está sem catálogo" não existe em tela nenhuma hoje.
   */
  it('e lista os provedores com quantas linhas cada um tem', async () => {
    const vazio = await criarProvedor('delta', 'Provedor Delta');
    const { providers } = (await ler()).body.data;

    const delta = providers.find((p) => p.slug === 'delta');
    assert.ok(delta, 'o provedor recém-criado tem que aparecer');
    assert.equal(delta.rows, 0);
    assert.equal(Number(delta.id), Number(vazio));

    // E a caixa da plataforma NÃO está na lista de provedores: ela não é
    // cliente, e misturá-la ali é a confusão que o `kind` existe para desfazer.
    assert.equal(providers.some((p) => p.slug === 'plataforma'), false);
  });

  it('sem sessão, 401', async () => {
    assert.equal((await call(`${panelUrl}/api/platform/catalogue`)).status, 401);
  });

  /**
   * **404 e não 403**, e a escolha é de `requirePlatformAdmin`: um 403 contaria
   * a um administrador de provedor que o plano de controle existe neste deploy
   * e que ele apenas não está nele — o fato que não vale confirmar.
   */
  it('e um administrador de provedor não descobre que o console existe', async () => {
    const resposta = await ler(tokenSemChave);
    assert.equal(resposta.status, 404);
    assert.equal(resposta.body?.data?.source, undefined);
  });
});
