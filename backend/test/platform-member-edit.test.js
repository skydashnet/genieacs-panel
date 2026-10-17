import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A conta de um membro da equipe, mexida do console: editar (login, e-mail,
 * telefone, papel), gerar um link novo de senha, definir a senha na hora e
 * encerrar as sessões. Tudo pelo provedor da URL — e 404 para quem trabalha
 * em outro.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');

const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };

let panelUrl;
let alfa;
let beta;
let token;
let mariaId;
let joaoId;

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

const member = (tenantId, userId, suffix = '', options = {}) =>
  api(`/platform/tenants/${tenantId}/members/${userId}${suffix}`, options);

async function criarOperador(tenantId, body) {
  const res = await api(`/platform/tenants/${tenantId}/operators`, { method: 'POST', body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function login(username, password) {
  return call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username, password } });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  const ownerId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: ownerId }).first())) {
    await getDb()('platform_admins').insert({ user_id: ownerId });
  }
  const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
  beta = criado.body.data.tenant.id;

  const maria = await criarOperador(alfa, {
    username: 'maria', email: 'maria@exemplo.test', role: 'tech', phone: '(11) 98765-4321'
  });
  mariaId = maria.membership.userId;
  assert.equal(maria.membership.phone, '5511987654321', 'o telefone nasce normalizado');

  const joao = await criarOperador(beta, {
    username: 'joao', email: 'joao@exemplo.test', role: 'admin', password: 'joao-senha-123'
  });
  joaoId = joao.membership.userId;
});

after(async () => {
  await stopTestServers();
});

describe('editar um membro', () => {
  it('lista com e-mail e telefone', async () => {
    const { body } = await api(`/platform/tenants/${alfa}/members`);
    const maria = body.data.memberships.find((m) => m.userId === mariaId);
    assert.equal(maria.email, 'maria@exemplo.test');
    assert.equal(maria.phone, '5511987654321');
  });

  it('troca papel, login, e-mail e telefone', async () => {
    const { status, body } = await member(alfa, mariaId, '', {
      method: 'PATCH',
      body: { role: 'admin', username: 'maria.silva', email: 'Maria.Silva@Exemplo.test', phone: '21 3333-4444' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.membership.role, 'admin');
    assert.equal(body.data.membership.username, 'maria.silva');
    assert.equal(body.data.membership.email, 'maria.silva@exemplo.test');
    assert.equal(body.data.membership.phone, '552133334444');
    assert.equal(body.data.sharedAccount, false);

    const trilha = await getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'operator.updated', actor_kind: 'platform' }).first();
    assert.ok(trilha, 'o provedor vê na trilha dele');
    assert.ok(await getDb()('platform_audit').where({ action: 'tenant.member_updated' }).first());
  });

  it('telefone vazio apaga, e telefone inválido é recusado', async () => {
    const apaga = await member(alfa, mariaId, '', { method: 'PATCH', body: { phone: '' } });
    assert.equal(apaga.body.data.membership.phone, null);
    const ruim = await member(alfa, mariaId, '', { method: 'PATCH', body: { phone: '12' } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_phone');
  });

  it('recusa login ou e-mail já usados por outra pessoa', async () => {
    const nome = await member(alfa, mariaId, '', { method: 'PATCH', body: { username: 'joao' } });
    assert.equal(nome.status, 409);
    assert.equal(nome.body.code, 'username_taken');
    const email = await member(alfa, mariaId, '', { method: 'PATCH', body: { email: 'joao@exemplo.test' } });
    assert.equal(email.status, 409);
    assert.equal(email.body.code, 'email_taken');
  });

  it('não deixa o provedor sem administrador', async () => {
    const { status } = await member(beta, joaoId, '', { method: 'PATCH', body: { role: 'viewer' } });
    assert.equal(status, 409);
  });

  it('não alcança quem trabalha em outro provedor', async () => {
    for (const [method, suffix, body] of [
      ['PATCH', '', { username: 'invasor' }],
      ['POST', '/password-link', {}],
      ['POST', '/password', { password: 'outra-senha-123' }],
      ['POST', '/sessions/revoke', {}]
    ]) {
      const { status } = await member(alfa, joaoId, suffix, { method, body });
      assert.equal(status, 404, `${method} ${suffix}`);
    }
    assert.equal((await getDb()('users').where({ id: joaoId }).first()).username, 'joao');
  });
});

describe('senha e sessões', () => {
  it('um link novo invalida o anterior, e a trilha não guarda o segredo', async () => {
    const primeiro = await member(alfa, mariaId, '/password-link', { method: 'POST', body: {} });
    assert.equal(primeiro.status, 200, JSON.stringify(primeiro.body));
    assert.ok(primeiro.body.data.token);
    const segundo = await member(alfa, mariaId, '/password-link', { method: 'POST', body: {} });
    assert.notEqual(segundo.body.data.token, primeiro.body.data.token);

    const abertos = await getDb()('auth_tickets')
      .where({ user_id: mariaId, purpose: 'password_reset' })
      .whereNull('redeemed_at');
    assert.equal(abertos.length, 1, 'só o último link fica valendo');

    const linhas = await getDb()('platform_audit').where({ action: 'tenant.member_password_link' });
    assert.ok(linhas.length >= 2);
    for (const linha of linhas) {
      assert.equal(String(linha.detail).includes(segundo.body.data.token), false);
    }
  });

  it('definir senha na hora deixa entrar com ela e derruba a sessão antiga', async () => {
    const definida = await member(alfa, mariaId, '/password', {
      method: 'POST', body: { password: 'maria-nova-123' }
    });
    assert.equal(definida.status, 200);
    const entrou = await login('maria.silva', 'maria-nova-123');
    assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
    const sessao = entrou.body.data.token;
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(sessao) })).status, 200);

    const curta = await member(alfa, mariaId, '/password', { method: 'POST', body: { password: 'curta' } });
    assert.equal(curta.status, 400);

    const encerra = await member(alfa, mariaId, '/sessions/revoke', { method: 'POST', body: {} });
    assert.equal(encerra.status, 200);
    // A sessão antiga é recusada: o `token_version` dela já não é o da conta.
    const depois = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(sessao) });
    assert.ok([401, 403].includes(depois.status), `sessão antiga ainda vale: ${depois.status}`);
    assert.ok(await getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'operator.sessions_revoked' }).first());
  });

  it('quem não é administrador da plataforma não enxerga as rotas', async () => {
    const entrou = await login('joao', 'joao-senha-123');
    const alheio = entrou.body.data.token;
    const { status } = await call(`${panelUrl}/api/platform/tenants/${beta}/members/${joaoId}`, {
      method: 'PATCH',
      headers: authHeaders(alheio),
      body: { username: 'joao2' }
    });
    assert.equal(status, 404);
  });
});
