import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

let panelUrl;
const admin = { username: 'operator', password: 'initial-password-1', email: 'operator@exemplo.test' };
let session;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('operator setup', () => {
  it('reports that the panel needs its first administrator', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(status, 200);
    assert.equal(body.data.needsSetup, true);
  });

  it('rejects a password shorter than eight characters', async () => {
    const { status } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'operator', password: 'short', email: 'operator@exemplo.test' }
    });
    assert.equal(status, 400);
  });

  it('creates the first administrator and returns a session', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: admin
    });
    assert.equal(status, 201);
    assert.equal(body.data.user.role, 'owner');
    assert.ok(body.data.token);
    assert.ok(body.data.refreshToken);
    session = body.data;
  });

  it('refuses a second setup once an administrator exists', async () => {
    const { status } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'intruder', password: 'another-password-1', email: 'intruder@exemplo.test' }
    });
    assert.equal(status, 409);
  });

  it('no longer reports that setup is needed', async () => {
    const { body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(body.data.needsSetup, false);
  });
});

describe('operator login', () => {
  it('rejects a wrong password without revealing which field failed', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Accept-Language': 'en' },
      body: { username: admin.username, password: 'wrong-password' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid username or password');
  });

  it('rejects an unknown user with the same message', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Accept-Language': 'en' },
      body: { username: 'nobody', password: 'wrong-password' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid username or password');
  });

  it('never returns the stored password hash', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: admin
    });
    assert.equal(status, 200);
    assert.equal(body.data.user.password, undefined);
    session = body.data;
  });
});

describe('protected routes', () => {
  it('requires a token', async () => {
    const { status } = await call(`${panelUrl}/api/auth/user`);
    assert.equal(status, 401);
  });

  it('rejects a forged token', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders('not.a.jwt')
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'invalid_token');
  });

  it('rejects a refresh token used as an access token', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(session.refreshToken)
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'invalid_token');
  });

  it('accepts a valid access token', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(session.token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.username, admin.username);
  });

  it('blocks a cross-origin browser request', async () => {
    const { status } = await call(`${panelUrl}/api/auth/user`, {
      headers: { ...authHeaders(session.token), Origin: 'https://evil.example' }
    });
    assert.equal(status, 403);
  });
});

describe('token refresh', () => {
  it('rejects an access token presented as a refresh token', async () => {
    const { status } = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: session.token }
    });
    assert.equal(status, 403);
  });

  it('exchanges a refresh token for a new pair', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: session.refreshToken }
    });
    assert.equal(status, 200);
    assert.ok(body.data.token);
    assert.ok(body.data.refreshToken);
    session = body.data;
  });
});

describe('session revocation', () => {
  it('invalidates existing tokens after a password change', async () => {
    const previousToken = session.token;
    const previousRefreshToken = session.refreshToken;

    const changed = await call(`${panelUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: authHeaders(previousToken),
      body: { currentPassword: admin.password, newPassword: 'rotated-password-2' }
    });
    assert.equal(changed.status, 200);
    admin.password = 'rotated-password-2';

    const reused = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(previousToken)
    });
    assert.equal(reused.status, 403);

    const refreshed = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: previousRefreshToken }
    });
    assert.equal(refreshed.status, 403);
  });

  it('invalidates the token used to log out', async () => {
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: admin });
    assert.equal(login.status, 200);

    const loggedOut = await call(`${panelUrl}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(login.body.data.token)
    });
    assert.equal(loggedOut.status, 200);

    const reused = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(login.body.data.token)
    });
    assert.equal(reused.status, 403);
  });
});

/**
 * The same public route as in `tenant-subdomain.test.js`, on the deployment
 * that has no subdomains — which is every self-hosted install.
 *
 * It belongs next to `setup-status` because it is the same kind of call: one of
 * the two things the login screen asks before there is anybody to
 * authenticate. This suite is where it matters that no host names a provider,
 * so the answer comes from the installation's own row — the path a change that
 * only ever considered the multi-tenant case would quietly break, on every
 * install that exists today.
 */
describe('the provider a login screen sees, with no subdomains configured', () => {
  it('answers with the installation\'s own provider', async () => {
    const { status, body } = await call(`${panelUrl}/api/tenant/public`);
    assert.equal(status, 200);
    assert.ok(body.data.name, 'the screen needs a name to render');
    assert.equal(body.data.slug, 'default');
  });

  /**
   * A lista é fechada de propósito: esta rota é ABERTA, então todo campo novo
   * aqui é publicado sem sessão, e a forma de decidir isso é ter que mexer
   * nesta linha.
   *
   * `kind` entrou pela mesma porta e com a mesma cobrança: ele não diz nada
   * sobre o NEGÓCIO deste provedor — diz qual dos endereços do próprio deploy
   * se está olhando, o de um ISP ou o da caixa com que a plataforma atende os
   * ISPs. O nome e o slug, que já saem aqui, já dizem isso a quem souber ler;
   * o campo apenas para de exigir que se saiba. Sem ele, o onboarding manda a
   * caixa da plataforma configurar um GenieACS que ela não tem por que ter.
   */
  it('returns the public fields and nothing else', async () => {
    const { body } = await call(`${panelUrl}/api/tenant/public`);
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ['edition', 'kind', 'name', 'panelBaseDomain', 'shared', 'slug']
    );
    assert.equal(body.data.kind, 'provider');
  });
});

/**
 * Os muros da sessão valem para TODA forma de estabelecer sessão.
 *
 * Existia uma segunda porta — `authenticateTokenOptional`, a forma "sessão se
 * houver" — que nenhuma rota usava e que não aplicava nenhum dos três muros que
 * a forma obrigatória aplica: a recusa de escrita dentro de uma personificação,
 * a recusa por assinatura, e o ator no escopo do provedor.
 *
 * Código morto exportado não é inerte: parece revisado. A primeira rota que a
 * adotasse — o caso natural é uma página semipública que mostra mais para quem
 * está logado — nasceria servindo provedor inadimplente e aceitando escrita
 * dentro de um atendimento, sem que ninguém tivesse decidido isso.
 *
 * Este teste é o que impede a porta de voltar sem os muros.
 */
describe('não existe uma segunda porta de sessão', () => {
  it('o middleware não exporta uma forma opcional sem os muros', async () => {
    const auth = await import('../src/middleware/auth.js');
    assert.equal(
      auth.authenticateTokenOptional, undefined,
      'uma forma opcional de sessão precisa aplicar impersonationRefusal, '
      + 'subscriptionRefusal e o ator no escopo — como a obrigatória faz'
    );
  });

  it('e a forma obrigatória continua sendo a que as rotas usam', async () => {
    const auth = await import('../src/middleware/auth.js');
    assert.equal(typeof auth.authenticateToken, 'function');
  });
});
