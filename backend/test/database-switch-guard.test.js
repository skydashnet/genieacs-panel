import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { switchDatabase, testConfig } = await import('../src/services/dbManagementService.js');

/**
 * O segundo portão da troca de banco: o que não depende de ninguém lembrar.
 *
 * `edition-saas.test.js` cobre o primeiro — a rota nem existe fora da edição
 * self-hosted. O problema daquele portão é a forma: ele lê `EDITION`, que cai
 * em `selfhosted` quando não definido e que o `install.sh` escreve em todo
 * `.env` gerado. Uma instalação que ganha um segundo provedor sem que alguém
 * troque a variável continua com a rota viva — e `copyData` lê todas as tabelas
 * sem predicado de provedor, para host, usuário e senha vindos do corpo do
 * request.
 *
 * A contagem de provedores é um fato que o processo confere sozinho, e é por
 * isso que ela vale ter ALÉM do portão de edição, não no lugar dele.
 */
let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  await getDb()('tenants').where({ slug: 'beta' }).del();
  await stopTestServers();
});

const alvo = {
  client: 'mysql2',
  host: 'servidor-do-atacante.example',
  port: 3306,
  user: 'u',
  password: 'p',
  database: 'd',
  migrateData: true
};

describe('switching the database on a shared deployment', () => {
  it('is refused the moment a second provider exists', async () => {
    await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    try {
      const { status, body } = await call(`${panelUrl}/api/database/switch`, {
        method: 'POST',
        headers: authHeaders(token),
        body: alvo
      });

      assert.equal(status, 400);
      assert.equal(body.success, false);
      // A recusa tem de vir do portão, e não de o host do atacante estar
      // inacessível: um 'connection failed' passaria neste teste sem que nada
      // estivesse protegido, e passaria também num deploy onde o host responde.
      assert.match(body.message, /provider|provedor|Anbieter|fournisseur/i);
    } finally {
      await getDb()('tenants').where({ slug: 'beta' }).del();
    }
  });

  /**
   * O serviço recusa por conta própria, sem depender de a rota estar montada.
   * É o que faz o portão valer para qualquer caminho que chegue nele depois.
   */
  it('is refused at the service, not merely at the route', async () => {
    await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    try {
      await assert.rejects(
        () => switchDatabase(alvo, { migrateData: true }),
        (error) => error.translationKey === 'database.switchNotSoleProvider'
      );
    } finally {
      await getDb()('tenants').where({ slug: 'beta' }).del();
    }
  });

  /**
   * Um provedor suspenso continua sendo um provedor com dados no banco, então
   * a contagem não filtra por status — pelo mesmo motivo que a do sweeper.
   */
  it('counts a suspended provider too', async () => {
    await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'suspended' });
    try {
      await assert.rejects(
        () => switchDatabase(alvo, { migrateData: true }),
        (error) => error.translationKey === 'database.switchNotSoleProvider'
      );
    } finally {
      await getDb()('tenants').where({ slug: 'beta' }).del();
    }
  });

  /**
   * O outro sentido, e é o que impede a correção de passar simplesmente
   * quebrando a funcionalidade: com um provedor só — a instalação para a qual
   * este recurso existe — a troca segue seu caminho normal e só para no passo
   * seguinte.
   *
   * O passo seguinte aqui é a validação dos campos, de propósito. Chegar até a
   * tentativa de conexão provaria o mesmo e abriria um socket para um host
   * inexistente dentro da suíte, o que só acrescenta uma dependência de rede e
   * um tempo de espera que ninguém controla. `validateExternal` roda logo
   * depois do portão e antes de qualquer I/O: recusar POR ELA é exatamente a
   * prova de que o portão deixou passar.
   */
  it('lets a single-provider install through to the next step', async () => {
    await assert.rejects(
      () => switchDatabase({ client: 'mysql2', migrateData: true }, { migrateData: true }),
      (error) => error.translationKey === 'database.missingMysqlFields'
    );
  });
});

/**
 * `POST /api/database/test` abria um socket para host e porta do corpo sem
 * passar pelo portão — e a resposta distingue "conectou", "recusou" e "não
 * respondeu". Num deploy compartilhado, isso é varredura de portas da rede
 * interna pelas mãos de um administrador de provedor.
 */
describe('testing a database connection on a shared deployment', () => {
  const sonda = { ...alvo, host: '127.0.0.1', port: 6379 };

  it('is refused the moment a second provider exists, before any socket', async () => {
    await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    try {
      const { status, body } = await call(`${panelUrl}/api/database/test`, {
        method: 'POST',
        headers: authHeaders(token),
        body: sonda
      });

      assert.equal(status, 400);
      assert.equal(body.success, false);
      // Pelo mesmo motivo do teste da troca: a recusa tem de vir do portão, e
      // não de a porta estar fechada.
      assert.match(body.message, /provider|provedor|Anbieter|fournisseur/i);
      assert.doesNotMatch(body.message, /ECONNREFUSED|ETIMEDOUT/);
    } finally {
      await getDb()('tenants').where({ slug: 'beta' }).del();
    }
  });

  it('is refused at the service, not merely at the route', async () => {
    await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'suspended' });
    try {
      await assert.rejects(
        () => testConfig(sonda),
        (error) => error.translationKey === 'database.switchNotSoleProvider'
      );
    } finally {
      await getDb()('tenants').where({ slug: 'beta' }).del();
    }
  });

  it('lets a single-provider install through to the next step', async () => {
    await assert.rejects(
      () => testConfig({ client: 'mysql2' }),
      (error) => error.translationKey === 'database.missingMysqlFields'
    );
  });

  /**
   * Com um provedor só a conexão é tentada, e o que volta do driver é o código,
   * não a prosa: a porta 1 do loopback recusa na hora, sem rede nenhuma.
   */
  it('reflects only the driver error code, not its message', async () => {
    const { status, body } = await call(`${panelUrl}/api/database/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { ...sonda, port: 1 }
    });

    assert.equal(status, 400);
    assert.match(body.message, /ECONNREFUSED|CONNECTION_ERROR/);
    assert.doesNotMatch(body.message, /127\.0\.0\.1|connect /);
  });
});
