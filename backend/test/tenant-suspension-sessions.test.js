import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders,
  call,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: PlatformAdmin } = await import('../src/models/PlatformAdmin.js');

/**
 * Suspender um provedor é trancá-lo.
 *
 * O resolvedor responde 404 no host de um provedor suspenso, mas num deploy de
 * host único o escopo vem do token — e nenhum dos caminhos da sessão lia
 * `tenants.status`. Os operadores do provedor suspenso continuavam entrando,
 * renovando a sessão e usando o painel. Aqui: a sessão aberta cai na próxima
 * requisição, o refresh é recusado, o login também, e quem trabalha num
 * segundo provedor ativo continua entrando nele.
 */
let panelUrl;
let alfa;
let beta;

const SO_BETA = { username: 'so-beta', password: 'so-beta-senha-1', email: 'so-beta@exemplo.test' };
const DOS_DOIS = { username: 'dos-dois', password: 'dos-dois-senha-1', email: 'dos-dois@exemplo.test' };

const entrar = (pessoa, tenantId) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST',
  body: tenantId === undefined ? pessoa : { ...pessoa, tenantId }
});
const suspender = (status) => getDb()('tenants').where({ id: beta }).update({ status });

let sessao;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona', password: 'dona-senha-1', email: 'dona@exemplo.test' }
  });
  const ownerToken = setup.body.data.token;
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', { slug: 'beta', name: 'Provedor Beta', status: 'active' });

  for (const pessoa of [SO_BETA, DOS_DOIS]) {
    const { status, body } = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: authHeaders(ownerToken), body: { ...pessoa, role: 'admin' }
    });
    assert.equal(status, 201, JSON.stringify(body));
    pessoa.id = body.data.user.id;
  }
  // `so-beta` sai de Alfa e fica só em Beta; `dos-dois` trabalha nos dois.
  await db('tenant_users').where({ tenant_id: alfa, user_id: SO_BETA.id }).del();
  await TenantUser.create({ tenantId: beta, userId: SO_BETA.id, role: 'admin' });
  await TenantUser.create({ tenantId: beta, userId: DOS_DOIS.id, role: 'admin' });

  const entrou = await entrar(SO_BETA, beta);
  assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
  sessao = entrou.body.data;
});

after(async () => {
  await suspender('active');
  await stopTestServers();
});

describe('um provedor suspenso', () => {
  it('derruba a sessão que já estava aberta', async () => {
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(sessao.token) })).status, 200);
    const renovou = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', body: { refreshToken: sessao.refreshToken }
    });
    assert.equal(renovou.status, 200, 'o refresh tem que funcionar antes da suspensão para o teste abaixo valer');
    await suspender('suspended');
    const depois = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(sessao.token) });
    assert.notEqual(depois.status, 200, 'a sessão seguiu de pé no provedor suspenso');
  });

  it('não renova a sessão', async () => {
    const { status } = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', body: { refreshToken: sessao.refreshToken }
    });
    assert.notEqual(status, 200);
  });

  it('não recebe login novo', async () => {
    assert.notEqual((await entrar(SO_BETA, beta)).status, 200);
    assert.notEqual((await entrar(SO_BETA)).status, 200);
  });

  it('não tranca quem também trabalha num provedor ativo', async () => {
    const noAtivo = await entrar(DOS_DOIS, alfa);
    assert.equal(noAtivo.status, 200, JSON.stringify(noAtivo.body));
    assert.notEqual((await entrar(DOS_DOIS, beta)).status, 200);
  });

  it('mas quem opera a plataforma continua entrando, para poder reativar ou excluir', async () => {
    await PlatformAdmin.add(SO_BETA.id);
    try {
      const entrou = await entrar(SO_BETA, beta);
      assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
    } finally {
      await PlatformAdmin.remove(SO_BETA.id);
    }
  });

  it('e reativado, volta a receber', async () => {
    await suspender('active');
    assert.equal((await entrar(SO_BETA, beta)).status, 200);
  });
});
