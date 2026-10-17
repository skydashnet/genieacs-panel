import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A chave `LOGIN_REQUIRES_EMAIL` vale em TODO caminho que emite sessão.
 *
 * `config/login.js` define o passo 3 como "uma conta sem e-mail não entra por
 * nada". Valia só no `/login`: aceitar um convite com nome e senha de uma
 * conta herdada emitia sessão com a chave ligada, e o refresh renovava por sete
 * dias a sessão de quem a chave deveria ter trancado. Quem virava a chave para
 * forçar a migração não forçava ninguém.
 *
 * A chave é lida na carga do módulo, então vai para o ambiente antes do importe
 * dinâmico da harness — e `node --test` dá um processo por arquivo, o que
 * mantém as outras suítes com a chave desligada.
 */
process.env.LOGIN_REQUIRES_EMAIL = 'true';

const {
  authHeaders, asTenant, call, defaultTenantId, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { generateTokens } = await import('../src/middleware/auth.js');
const bcrypt = (await import('bcryptjs')).default;

const DONA = { username: 'dona', email: 'dona@isp.com', password: 'senha-da-dona-1' };
const LEGADO = { username: 'legado', password: 'senha-do-legado-1' };
const MIGRADO = { username: 'migrado', email: 'migrado@isp.com', password: 'senha-do-migrado-1' };

let panelUrl;
let donaToken;
let tenantId;
let legadoId;
let migradoId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONA });
  assert.equal(setup.status, 201);
  donaToken = setup.body.data.token;

  // Duas contas SEM vínculo com o provedor, para que o convite tenha o que
  // aceitar: a herdada, sem e-mail, e uma que já migrou.
  legadoId = await asTenant(() => User.create({
    username: LEGADO.username, password: bcrypt.hashSync(LEGADO.password, 4), role: 'tech'
  }));
  migradoId = await asTenant(() => User.create({
    username: MIGRADO.username, email: MIGRADO.email,
    password: bcrypt.hashSync(MIGRADO.password, 4), role: 'tech'
  }));
});

after(async () => {
  await stopTestServers();
});

async function convite() {
  const inv = await call(`${panelUrl}/api/invites`, {
    method: 'POST', headers: authHeaders(donaToken), body: { role: 'tech' }
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  return inv.body.data.invite?.token ?? inv.body.data.token;
}

describe('com a chave ligada, o login', () => {
  it('recusa o nome, mesmo com a senha certa', async () => {
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: LEGADO.username, password: LEGADO.password }
    });
    assert.equal(status, 401);
  });

  it('aceita o e-mail de quem já migrou', async () => {
    await asTenant(() => TenantUser.create({ tenantId, userId: migradoId, role: 'tech' }));
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: MIGRADO.email, password: MIGRADO.password }
    });
    assert.equal(status, 200);
    await asTenant(() => TenantUser.remove(tenantId, migradoId));
  });
});

describe('com a chave ligada, o aceite de convite', () => {
  // A porta dos fundos: o mesmo nome e a mesma senha que o `/login` recusa.
  it('recusa uma conta sem e-mail, e não emite sessão', async () => {
    const token = await convite();
    const r = await call(`${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: LEGADO.username, password: LEGADO.password }
    });
    assert.equal(r.status, 401);
    assert.ok(!r.body?.data?.token, 'nenhuma sessão pode ter sido emitida');
    assert.equal(await asTenant(() => TenantUser.find(tenantId, legadoId)), null,
      'o vínculo não pode ter sido escrito');
  });

  // A regra é "sem e-mail não entra", e não "convite não entra": quem migrou
  // continua podendo ser convidado.
  it('ainda aceita uma conta que já tem e-mail', async () => {
    const token = await convite();
    const r = await call(`${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: MIGRADO.email, password: MIGRADO.password }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.data.token);
    await asTenant(() => TenantUser.remove(tenantId, migradoId));
  });
});

describe('com a chave ligada, o refresh', () => {
  /**
   * Uma sessão aberta ANTES da virada. O token é cunhado direto, porque é
   * exatamente o cenário: a pessoa entrou quando o nome ainda servia, a chave
   * virou, e o refresh dela chega agora.
   */
  it('recusa renovar a sessão de uma conta sem e-mail', async () => {
    await asTenant(() => TenantUser.create({ tenantId, userId: legadoId, role: 'tech' }));
    const user = await asTenant(() => User.findById(legadoId));
    const { refreshToken } = generateTokens(user, { tenant_id: tenantId, role: 'tech' });

    const r = await call(`${panelUrl}/api/auth/refresh`, { method: 'POST', body: { refreshToken } });
    assert.equal(r.status, 403);
    await asTenant(() => TenantUser.remove(tenantId, legadoId));
  });

  it('renova a de quem tem e-mail', async () => {
    await asTenant(() => TenantUser.create({ tenantId, userId: migradoId, role: 'tech' }));
    const user = await asTenant(() => User.findById(migradoId));
    const { refreshToken } = generateTokens(user, { tenant_id: tenantId, role: 'tech' });

    const r = await call(`${panelUrl}/api/auth/refresh`, { method: 'POST', body: { refreshToken } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await asTenant(() => TenantUser.remove(tenantId, migradoId));
  });
});

describe('o número que decide a chave', () => {
  // No self-hosted, quem administra a equipe é quem opera o host.
  it('é lido por quem administra a equipe', async () => {
    const r = await call(`${panelUrl}/api/auth/email-readiness`, { headers: authHeaders(donaToken) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.loginRequiresEmail, true);
    assert.equal(r.body.data.ready, false, 'a conta herdada ainda não tem e-mail');
  });
});

describe('o cadastro do próprio e-mail', () => {
  /**
   * O 409 dali diz se um endereço tem conta em algum provedor da plataforma —
   * a tabela é uma só. O oráculo é inerente à unicidade global; o que se tira
   * dele é a escala, e é isso que se afirma: a décima primeira pergunta no
   * mesmo quarto de hora é recusada antes de chegar ao banco.
   */
  it('é limitado antes de virar uma enumeração', async () => {
    let ultimo;
    for (let i = 0; i < 11; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ultimo = await call(`${panelUrl}/api/auth/email`, {
        method: 'POST', headers: authHeaders(donaToken),
        body: { currentPassword: 'errada', email: `sonda-${i}@exemplo.com` }
      });
    }
    assert.equal(ultimo.status, 429);
    assert.equal(ultimo.body.code, 'rate_limited');
  });
});

describe('a tela de operadores', () => {
  it('responde na língua do pedido', async () => {
    const r = await call(`${panelUrl}/api/users/999999`, {
      method: 'PATCH',
      headers: { ...authHeaders(donaToken), 'Accept-Language': 'pt-BR' },
      body: { role: 'viewer' }
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.message, 'Operador não encontrado');
  });
});
