import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Na edição SaaS, o número que decide `LOGIN_REQUIRES_EMAIL` é do plano de
 * controle.
 *
 * `User.count()` e `countWithoutEmail()` contam a plataforma inteira — e é o
 * número certo, porque a chave é uma variável de ambiente do processo, não uma
 * configuração por provedor. Mas então quem pode lê-lo é quem pode virá-la.
 * Atrás de `operators.read`, um administrador de provedor via quantas contas
 * existem em toda a plataforma, um dado que não é do provedor dele.
 */
process.env.EDITION = 'saas';

const { authHeaders, call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

let panelUrl;
let ownerToken;
let ownerId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona', email: 'dona@isp.com', password: 'senha-da-dona-1' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;
});

after(async () => {
  await stopTestServers();
});

describe('GET /api/auth/email-readiness na edição SaaS', () => {
  it('é recusado a quem só administra um provedor', async () => {
    // O setup da edição SaaS pode ter posto a primeira conta no plano de
    // controle; tirada dali, ela é o que este caso precisa — uma dona de
    // provedor, e nada mais.
    await getDb()('platform_admins').where({ user_id: ownerId }).delete();
    // Sessão nova, porque `isPlatformAdmin` viaja no token.
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'dona@isp.com', password: 'senha-da-dona-1' }
    });
    assert.equal(login.status, 200);

    const r = await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: authHeaders(login.body.data.token)
    });
    // 404 e não 403, como todo o plano de controle: um 403 confirmaria que a
    // rota existe para quem não deveria saber dela.
    assert.equal(r.status, 404);
  });

  it('é lido pelo plano de controle', async () => {
    await getDb()('platform_admins').insert({ user_id: ownerId });
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'dona@isp.com', password: 'senha-da-dona-1' }
    });
    const r = await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: authHeaders(login.body.data.token)
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.ready, true);
  });
});
