import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { totpCode, totpStep } = await import('../src/utils/totp.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: PlatformAdmin } = await import('../src/models/PlatformAdmin.js');

/**
 * O dono exige o login em duas etapas da equipe, e a equipe destrava quem
 * perdeu o celular e os códigos.
 *
 * O que estes casos defendem: só o dono liga a exigência, e só depois de usar o
 * 2FA ele mesmo; quem está sem 2FA é parado NA PRÓXIMA requisição, mesmo com
 * uma sessão aberta antes da exigência, e ainda alcança a própria conta para
 * ativar; o outro provedor da mesma pessoa não é afetado; e destravar alguém
 * segue as regras da troca de senha pela equipe — o dono só pelo dono, quem
 * trabalha em outro provedor ou opera a plataforma só pelo servidor.
 */
const SENHA = 'policy-password-1';
const DONO = 'dona';

let panelUrl;
let alfa;
let beta;
const tokens = {};
const segredos = {};
const ids = {};

const post = (path, body, token) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });
const put = (path, body, token) => call(`${panelUrl}${path}`, { method: 'PUT', headers: authHeaders(token), body });
const get = (path, token) => call(`${panelUrl}${path}`, { headers: authHeaders(token) });
const login = (username, extra = {}) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST',
  body: { username, password: SENHA, ...extra }
});
/** Um código do passo seguinte: o do passo atual já pode ter sido gasto. */
const proximo = (quem) => totpCode(segredos[quem], totpStep() + 1);

async function ativar(quem) {
  const setup = await post('/api/auth/mfa/setup', {}, tokens[quem]);
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  segredos[quem] = setup.body.data.secret;
  const ligou = await post('/api/auth/mfa/enable', { code: totpCode(segredos[quem], totpStep()) }, tokens[quem]);
  assert.equal(ligou.status, 200, JSON.stringify(ligou.body));
  // Ativar derruba as sessões abertas antes; a de quem ativou segue com o
  // token que a própria resposta traz.
  tokens[quem] = ligou.body.data.token;
}

async function criar(username, role) {
  const { status, body } = await post('/api/users', {
    username, password: SENHA, role, email: `${username}@exemplo.test`
  }, tokens[DONO]);
  assert.equal(status, 201, JSON.stringify(body));
  ids[username] = body.data.user.id;
  const entrou = await login(username);
  assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
  tokens[username] = entrou.body.data.token;
}

const linhas = (action) => getDb()('audit_log').where({ action }).orderBy('id', 'asc');

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: DONO, password: SENHA, email: 'dona@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  tokens[DONO] = setup.body.data.token;
  ids[DONO] = setup.body.data.user.id;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  await criar('gerente', 'admin');
  await criar('plantao', 'tech');
  await criar('consultor', 'admin');
});

after(async () => {
  await stopTestServers();
});

describe('a exigência', () => {
  it('começa desligada, contando quem ainda não ativou', async () => {
    // Um provedor como os instalados antes da 0065: o `/setup` agora cria o
    // dono, e este bloco precisa de um provedor sem nenhum `owner` para provar
    // a metade da regra que ainda vale para eles.
    await getDb()('tenant_users').where({ tenant_id: alfa, user_id: ids[DONO] }).update({ role: 'admin' });
    const { status, body } = await get('/api/tenant/security', tokens.gerente);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data, { requireMfa: false, membersWithoutMfa: 4, canChange: true });
  });

  // Instalação sem dono (o caso acima): sem esta metade da regra, ninguém ali
  // conseguiria ligar a exigência.
  it('num provedor sem nenhum owner, o admin decide', async () => {
    const { status, body } = await put('/api/tenant/security', { requireMfa: false }, tokens.gerente);
    assert.equal(status, 200, JSON.stringify(body));
  });

  it('com um owner, só ele — o admin tem settings.write e mesmo assim não', async () => {
    await getDb()('tenant_users').where({ tenant_id: alfa, user_id: ids[DONO] }).update({ role: 'owner' });
    const { status } = await put('/api/tenant/security', { requireMfa: true }, tokens.gerente);
    assert.equal(status, 403);
    const visto = (await get('/api/tenant/security', tokens.gerente)).body.data;
    assert.equal(visto.requireMfa, false);
    assert.equal(visto.canChange, false);
    assert.equal((await get('/api/tenant/security', tokens[DONO])).body.data.canChange, true);
  });

  it('o dono sem 2FA não liga: ele se trancaria no primeiro clique', async () => {
    const { status, body } = await put('/api/tenant/security', { requireMfa: true }, tokens[DONO]);
    assert.equal(status, 409);
    assert.equal(body.code, 'mfa_enable_yourself_first');
  });

  it('recusa o que não é booleano', async () => {
    const { status } = await put('/api/tenant/security', { requireMfa: 'sim' }, tokens[DONO]);
    assert.equal(status, 400);
  });

  it('com o 2FA dele ligado, o dono liga, e a trilha diz de quê para quê', async () => {
    await ativar(DONO);
    const { status, body } = await put('/api/tenant/security', { requireMfa: true }, tokens[DONO]);
    assert.equal(status, 200, JSON.stringify(body));
    const trilha = await linhas(AuditLog.ACTIONS.TENANT_MFA_REQUIRED_CHANGED);
    assert.equal(trilha.length, 1);
    assert.deepEqual(JSON.parse(trilha[0].detail), { from: false, to: true });
    assert.deepEqual((await get('/api/tenant/security', tokens[DONO])).body.data,
      { requireMfa: true, membersWithoutMfa: 3, canChange: true });
  });

  it('gravar o mesmo valor de novo não suja a trilha', async () => {
    await put('/api/tenant/security', { requireMfa: true }, tokens[DONO]);
    assert.equal((await linhas(AuditLog.ACTIONS.TENANT_MFA_REQUIRED_CHANGED)).length, 1);
  });
});

describe('quem está sem 2FA num provedor que exige', () => {
  it('é parado na próxima requisição, com a sessão aberta ANTES da exigência', async () => {
    const { status, body } = await get('/api/users', tokens.gerente);
    assert.equal(status, 403);
    assert.equal(body.code, 'mfa_enrollment_required');
  });

  it('ainda alcança a própria conta e o nome do provedor', async () => {
    const eu = await get('/api/auth/user', tokens.gerente);
    assert.equal(eu.status, 200);
    assert.equal(eu.body.data.mfaEnrollmentRequired, true);
    assert.equal((await get('/api/auth/mfa', tokens.gerente)).status, 200);
    assert.equal((await get('/api/tenant/public', tokens.gerente)).status, 200);
  });

  it('o login diz logo que precisa ativar', async () => {
    const { status, body } = await login('plantao');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.mfaEnrollmentRequired, true);
  });

  it('quem já usa o 2FA não é parado', async () => {
    const { status } = await get('/api/users', tokens[DONO]);
    assert.equal(status, 200);
    assert.equal((await get('/api/auth/user', tokens[DONO])).body.data.mfaEnrollmentRequired, false);
  });

  it('depois de ativar, a mesma aba volta a trabalhar, com o token que a ativação devolve', async () => {
    await ativar('gerente');
    assert.equal((await get('/api/users', tokens.gerente)).status, 200);
    assert.equal((await get('/api/auth/user', tokens.gerente)).body.data.mfaEnrollmentRequired, false);
  });

  it('desligar o próprio 2FA é recusado enquanto o provedor exigir', async () => {
    const { status, body } = await post('/api/auth/mfa/disable', {
      password: SENHA, code: proximo('gerente')
    }, tokens.gerente);
    assert.equal(status, 409);
    assert.equal(body.code, 'mfa_required_by_provider');
    const linha = await getDb()('users').where({ id: ids.gerente }).first('totp_enabled_at');
    assert.ok(linha.totp_enabled_at, 'o 2FA foi desligado mesmo com o provedor exigindo');
  });

  it('o outro provedor da mesma pessoa não é afetado', async () => {
    const db = getDb();
    await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
    await db('tenant_users').insert({ tenant_id: beta, user_id: ids.consultor, role: 'admin' });

    const emBeta = await login('consultor', { tenantId: beta });
    assert.equal(emBeta.status, 200, JSON.stringify(emBeta.body));
    assert.equal(emBeta.body.data.user.mfaEnrollmentRequired, false);
    assert.equal((await get('/api/users', emBeta.body.data.token)).status, 200);

    const emAlfa = await login('consultor', { tenantId: alfa });
    assert.equal(emAlfa.body.data.user.mfaEnrollmentRequired, true);
    assert.equal((await get('/api/users', emAlfa.body.data.token)).body.code, 'mfa_enrollment_required');
  });

  it('desligar a exigência libera todo mundo', async () => {
    assert.equal((await put('/api/tenant/security', { requireMfa: false }, tokens[DONO])).status, 200);
    const { status } = await get('/api/users', (await login('consultor', { tenantId: alfa })).body.data.token);
    assert.equal(status, 200);
  });
});

describe('destravar quem perdeu o celular e os códigos', () => {
  it('o plantão não destrava ninguém', async () => {
    const { status } = await post(`/api/users/${ids.gerente}/mfa-reset`, {}, tokens.plantao);
    assert.equal(status, 403);
  });

  it('o admin destrava o plantão: 2FA, códigos e sessões somem, e a trilha nomeia a pessoa', async () => {
    await ativar('plantao');
    const velho = tokens.plantao;
    const { status, body } = await post(`/api/users/${ids.plantao}/mfa-reset`, {}, tokens.gerente);
    assert.equal(status, 200, JSON.stringify(body));

    const linha = await getDb()('users').where({ id: ids.plantao }).first();
    assert.equal(linha.totp_enabled_at, null);
    assert.equal(linha.totp_ciphertext, null);
    const [{ n }] = await getDb()('user_recovery_codes').where({ user_id: ids.plantao }).count({ n: '*' });
    assert.equal(Number(n), 0);
    assert.equal((await get('/api/auth/user', velho)).status, 403, 'a sessão aberta sobreviveu ao destravar');
    assert.equal((await login('plantao')).status, 200, 'sem 2FA, a senha sozinha tem que bastar');

    const trilha = await linhas(AuditLog.ACTIONS.OPERATOR_MFA_RESET);
    assert.equal(trilha.length, 1);
    assert.deepEqual(JSON.parse(trilha[0].detail), { username: 'plantao' });
  });

  it('o 2FA do dono, só o dono desliga', async () => {
    const { status } = await post(`/api/users/${ids[DONO]}/mfa-reset`, {}, tokens.gerente);
    assert.equal(status, 403);
    assert.ok((await getDb()('users').where({ id: ids[DONO] }).first()).totp_enabled_at);
  });

  it('a si mesmo, não: o cartão da conta faz isso com senha e código', async () => {
    const { status } = await post(`/api/users/${ids.gerente}/mfa-reset`, {}, tokens.gerente);
    assert.equal(status, 400);
  });

  it('quem trabalha em outro provedor, só pelo servidor', async () => {
    const consultor = await login('consultor', { tenantId: alfa });
    tokens.consultor = consultor.body.data.token;
    await ativar('consultor');
    const { status, body } = await post(`/api/users/${ids.consultor}/mfa-reset`, {}, tokens[DONO]);
    assert.equal(status, 409);
    assert.equal(body.code, 'mfa_elsewhere');
    assert.ok((await getDb()('users').where({ id: ids.consultor }).first()).totp_enabled_at);
  });

  it('quem opera a plataforma, só pelo servidor', async () => {
    await PlatformAdmin.add(ids.gerente);
    try {
      const { status, body } = await post(`/api/users/${ids.gerente}/mfa-reset`, {}, tokens[DONO]);
      assert.equal(status, 409);
      assert.equal(body.code, 'mfa_platform');
    } finally {
      await PlatformAdmin.remove(ids.gerente);
    }
  });

  it('quem não tem 2FA não tem o que destravar', async () => {
    const { status, body } = await post(`/api/users/${ids.plantao}/mfa-reset`, {}, tokens[DONO]);
    assert.equal(status, 409);
    assert.equal(body.code, 'mfa_not_enabled');
  });

  it('quem não é da equipe responde como inexistente', async () => {
    const { status } = await post('/api/users/999999/mfa-reset', {}, tokens[DONO]);
    assert.equal(status, 404);
  });

  it('a lista da equipe diz quem tem 2FA', async () => {
    const { body } = await get('/api/users', tokens[DONO]);
    const porNome = Object.fromEntries(body.data.users.map((u) => [u.username, u.mfaEnabled]));
    assert.deepEqual(porNome, { consultor: true, dona: true, gerente: true, plantao: false });
  });

  it('o comando do servidor destrava o dono', () => {
    const script = new URL('../scripts/reset-mfa.js', import.meta.url).pathname;
    const run = spawnSync(process.execPath, [script, DONO], { env: process.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /turned off/);
  });

  it('e o dono fica sem 2FA, com as sessões encerradas', async () => {
    const linha = await getDb()('users').where({ id: ids[DONO] }).first();
    assert.equal(linha.totp_enabled_at, null);
    assert.equal((await get('/api/auth/user', tokens[DONO])).status, 403);
  });
});
