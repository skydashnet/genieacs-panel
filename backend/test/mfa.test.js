import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const {
  base32Decode, base32Encode, totpCode, totpStep, totpUri, verifyTotp
} = await import('../src/utils/totp.js');
const { hashRecoveryCode, normalizeRecoveryCode } = await import('../src/services/mfaService.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');

/**
 * Login em duas etapas com app autenticador.
 *
 * O que estes casos defendem: a senha errada continua sem pista nenhuma; a
 * senha certa sem o código não abre sessão em ramo nenhum; o mesmo código não
 * entra duas vezes; o código de recuperação é gasto uma vez; e o segredo nunca
 * sai do servidor depois da ativação.
 */
const USUARIO = 'operator';
const SENHA = 'operator-password-1';

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: USUARIO, password: SENHA, email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

const post = (path, body, headers = authHeaders(token)) => call(`${panelUrl}${path}`, { method: 'POST', headers, body });
const login = (extra = {}) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST',
  body: { username: USUARIO, password: SENHA, ...extra }
});
const agora = () => totpCode(segredo, totpStep());
let segredo;
let recuperacao;
let alfa;

describe('o código, sem rede', () => {
  it('confere com os vetores do RFC 6238 (SHA-1, 8 dígitos)', () => {
    const s = base32Encode(Buffer.from('12345678901234567890'));
    for (const [t, esperado] of [
      [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
      [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']
    ]) {
      assert.equal(totpCode(s, Math.floor(t / 30), 8), esperado, `T=${t}`);
    }
    assert.equal(base32Decode(s).toString(), '12345678901234567890');
  });

  it('aceita um passo para cada lado, e não dois', () => {
    const s = base32Encode(Buffer.from('segredo-de-teste-20b'));
    const t = 1_700_000_000_000;
    const passo = totpStep(t);
    assert.equal(verifyTotp(s, totpCode(s, passo - 1), { nowMs: t }), passo - 1);
    assert.equal(verifyTotp(s, totpCode(s, passo + 1), { nowMs: t }), passo + 1);
    assert.equal(verifyTotp(s, totpCode(s, passo - 2), { nowMs: t }), null);
    assert.equal(verifyTotp(s, totpCode(s, passo + 2), { nowMs: t }), null);
  });

  it('não aceita de novo o passo já usado, nem um anterior', () => {
    const s = base32Encode(Buffer.from('segredo-de-teste-20b'));
    const t = 1_700_000_000_000;
    const passo = totpStep(t);
    assert.equal(verifyTotp(s, totpCode(s, passo), { nowMs: t, afterStep: passo }), null);
    assert.equal(verifyTotp(s, totpCode(s, passo - 1), { nowMs: t, afterStep: passo - 1 }), null);
    assert.equal(verifyTotp(s, totpCode(s, passo), { nowMs: t, afterStep: passo - 1 }), passo);
  });

  it('recusa o que não é código de 6 dígitos', () => {
    const s = base32Encode(Buffer.from('segredo-de-teste-20b'));
    for (const ruim of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      assert.equal(verifyTotp(s, ruim), null, JSON.stringify(ruim));
    }
  });

  it('a URI traz o emissor, a conta e os parâmetros padrão', () => {
    const uri = totpUri({ secret: 'ABC', label: 'op@x.test', issuer: 'SkyGenPanel' });
    assert.match(uri, /^otpauth:\/\/totp\/SkyGenPanel%3Aop%40x\.test\?/);
    assert.match(uri, /secret=ABC/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });

  it('o código de recuperação não liga para traço, espaço nem maiúscula', () => {
    assert.equal(normalizeRecoveryCode(' ABCDE-12345 '), 'abcde12345');
    assert.equal(hashRecoveryCode('ABCDE-12345'), hashRecoveryCode('abcde12345'));
  });
});

describe('ativar', () => {
  it('sem 2FA, o login é o de sempre', async () => {
    const { status } = await login();
    assert.equal(status, 200);
  });

  it('o segredo pendente não vale até o primeiro código certo', async () => {
    const { status, body } = await post('/api/auth/mfa/setup', {});
    assert.equal(status, 200, JSON.stringify(body));
    segredo = body.data.secret;
    assert.match(body.data.uri, /^otpauth:\/\/totp\//);
    // Pendente: o login continua sem pedir código.
    assert.equal((await login()).status, 200);
    assert.equal((await call(`${panelUrl}/api/auth/mfa`, { headers: authHeaders(token) })).body.data.enabled, false);
  });

  it('código errado não liga', async () => {
    const errado = String((Number(agora()) + 1) % 1_000_000).padStart(6, '0');
    const { status, body } = await post('/api/auth/mfa/enable', { code: errado });
    assert.equal(status, 400);
    assert.equal(body.code, 'mfa_invalid');
  });

  it('código certo liga e devolve dez códigos de recuperação, uma vez', async () => {
    const antes = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.USER_MFA_ENABLED }).count({ n: '*' });
    const velho = token;
    const { status, body } = await post('/api/auth/mfa/enable', { code: agora() });
    assert.equal(status, 200, JSON.stringify(body));
    recuperacao = body.data.recoveryCodes;

    // Ativar é mudar credencial: a sessão aberta antes cai, e a aba de quem
    // ativou segue com os tokens novos que a resposta traz.
    assert.ok(body.data.token && body.data.refreshToken, 'a ativação não devolveu sessão nova');
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(velho) })).status, 403,
      'a sessão de antes da ativação continuou valendo');
    token = body.data.token;
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(token) })).status, 200);
    const renovou = await call(`${panelUrl}/api/auth/refresh`, { method: 'POST', body: { refreshToken: body.data.refreshToken } });
    assert.equal(renovou.status, 200, JSON.stringify(renovou.body));
    assert.equal(recuperacao.length, 10);
    assert.equal(new Set(recuperacao).size, 10);
    const depois = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.USER_MFA_ENABLED }).count({ n: '*' });
    assert.equal(Number(depois[0].n), Number(antes[0].n) + 1);

    // Só o hash fica guardado, e o segredo não aparece em texto no banco.
    const linhas = await getDb()('user_recovery_codes').select('code_hash');
    assert.ok(linhas.every((l) => !recuperacao.includes(l.code_hash)));
    const usuario = await getDb()('users').where({ username: USUARIO }).first();
    assert.ok(!JSON.stringify(usuario).includes(segredo), 'o segredo foi gravado em texto');
  });

  it('não dá para começar de novo por cima de um 2FA ligado', async () => {
    const { status, body } = await post('/api/auth/mfa/setup', {});
    assert.equal(status, 409);
    assert.equal(body.code, 'mfa_already_enabled');
  });

  it('a conta diz que está ligado — e só isso', async () => {
    const { body } = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(token) });
    assert.equal(body.data.mfaEnabled, true);
    assert.ok(!JSON.stringify(body).includes(segredo));
    assert.ok(!/totp/i.test(JSON.stringify(body)), 'coluna do 2FA vazou na resposta da conta');
    const status = await call(`${panelUrl}/api/auth/mfa`, { headers: authHeaders(token) });
    assert.deepEqual(status.body.data, { enabled: true, recoveryRemaining: 10 });
  });
});

describe('entrar com 2FA', () => {
  it('senha errada é o 401 de sempre, sem pista de que há 2FA', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: USUARIO, password: 'senha-errada' }
    });
    assert.equal(status, 401);
    assert.notEqual(body.code, 'mfa_required');
    assert.ok(!/mfa|dois|two/i.test(JSON.stringify(body)));
  });

  it('senha certa sem código não abre sessão: pede o código', async () => {
    const { status, body } = await login();
    assert.equal(status, 401);
    assert.equal(body.code, 'mfa_required');
    assert.equal(body.data?.token, undefined);
  });

  it('o console também pede o código', async () => {
    const { status, body } = await login({ destination: 'console' });
    assert.equal(status, 401);
    assert.equal(body.code, 'mfa_required');
  });

  it('aceitar convite com a conta que já existe também pede o código', async () => {
    // Aceitar convite emite sessão só com a senha de quem já tem conta. Sem o
    // código aqui, uma senha vazada entraria pela porta do convite.
    const convite = await post('/api/invites', { role: 'tech' });
    assert.equal(convite.status, 201, JSON.stringify(convite.body));
    const aceitar = (extra = {}) => call(`${panelUrl}/api/invites/token/accept`, {
      method: 'POST',
      body: { token: convite.body.data.token, username: USUARIO, password: SENHA, email: 'operator@exemplo.test', ...extra }
    });
    const semCodigo = await aceitar();
    assert.equal(semCodigo.status, 401, JSON.stringify(semCodigo.body));
    assert.equal(semCodigo.body.code, 'mfa_required');
    assert.equal(semCodigo.body.data?.token, undefined);
    const errado = await aceitar({ totpCode: '000000' });
    assert.equal(errado.status, 401);
    assert.equal(errado.body.code, 'mfa_invalid');
  });

  it('código errado não entra', async () => {
    const errado = String((Number(agora()) + 1) % 1_000_000).padStart(6, '0');
    const { status, body } = await login({ totpCode: errado });
    assert.equal(status, 401);
    assert.equal(body.code, 'mfa_invalid');
  });

  it('com dois provedores, o código sobrevive à pergunta "em qual?" e só é gasto na sessão', async () => {
    // A pessoa passa a trabalhar em dois provedores: a senha e o código certos
    // levam à pergunta, e a tela reenvia o MESMO código com a escolha. Gasto na
    // primeira ida, ele seria recusado como repetição na segunda.
    const db = getDb();
    await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    const beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
    const usuario = await db('users').where({ username: USUARIO }).first();
    await db('tenant_users').insert({ tenant_id: beta, user_id: usuario.id, role: 'admin' });
    alfa = (await db('tenants').orderBy('id', 'asc').first()).id;

    // O passo da ativação já foi gasto; o de um passo à frente ainda não. É o
    // único que vale agora sem esperar trinta segundos.
    const proximo = totpCode(segredo, totpStep() + 1);
    const pergunta = await login({ totpCode: proximo });
    assert.equal(pergunta.status, 409, JSON.stringify(pergunta.body));
    assert.equal(pergunta.body.code, 'choose_destination');

    const entrou = await login({ totpCode: proximo, tenantId: alfa });
    assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
    assert.ok(entrou.body.data.token);

    // E agora, sim, gasto: o mesmo código não abre outra sessão.
    const repetido = await login({ totpCode: proximo, tenantId: alfa });
    assert.equal(repetido.status, 401);
    assert.equal(repetido.body.code, 'mfa_invalid');
  });

  it('o código de recuperação entra uma vez, deixa linha na trilha, e acaba', async () => {
    const antes = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.USER_MFA_RECOVERY_USED }).count({ n: '*' });
    const primeira = await login({ totpCode: ` ${recuperacao[0].toUpperCase()} `, tenantId: alfa });
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    const depois = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.USER_MFA_RECOVERY_USED }).count({ n: '*' });
    assert.equal(Number(depois[0].n), Number(antes[0].n) + 1);

    const segunda = await login({ totpCode: recuperacao[0], tenantId: alfa });
    assert.equal(segunda.status, 401);
    assert.equal(segunda.body.code, 'mfa_invalid');
    const { body } = await call(`${panelUrl}/api/auth/mfa`, { headers: authHeaders(token) });
    assert.equal(body.data.recoveryRemaining, 9);
  });
});

describe('trocar os códigos e desligar', () => {
  it('trocar os códigos exige senha e segundo fator, e invalida os antigos', async () => {
    const semSenha = await post('/api/auth/mfa/recovery-codes', { password: 'errada', code: recuperacao[1] });
    assert.equal(semSenha.status, 401);
    assert.equal(semSenha.body.code, 'invalid_password');

    const antes = token;
    const { status, body } = await post('/api/auth/mfa/recovery-codes', { password: SENHA, code: recuperacao[1] });
    assert.equal(status, 200, JSON.stringify(body));
    const novos = body.data.recoveryCodes;
    // Quem troca os códigos acha que os antigos vazaram: as sessões caem junto.
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(antes) })).status, 403);
    token = body.data.token;
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(token) })).status, 200);
    assert.equal(novos.length, 10);

    const velho = await login({ totpCode: recuperacao[2], tenantId: alfa });
    assert.equal(velho.status, 401, 'o código antigo continuou valendo');
    recuperacao = novos;
  });

  it('desligar exige senha E segundo fator', async () => {
    const semCodigo = await post('/api/auth/mfa/disable', { password: SENHA, code: '000000' });
    assert.equal(semCodigo.status, 400);
    assert.equal(semCodigo.body.code, 'mfa_invalid');
    const semSenha = await post('/api/auth/mfa/disable', { password: 'errada', code: recuperacao[0] });
    assert.equal(semSenha.status, 401);
    assert.equal((await call(`${panelUrl}/api/auth/mfa`, { headers: authHeaders(token) })).body.data.enabled, true);
  });

  it('desligado, o login volta a ser só a senha, e os códigos somem', async () => {
    const antes = token;
    const { status, body } = await post('/api/auth/mfa/disable', { password: SENHA, code: recuperacao[0] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(antes) })).status, 403,
      'a sessão de antes do desligamento continuou valendo');
    token = body.data.token;
    assert.equal((await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(token) })).status, 200);
    assert.equal((await login({ tenantId: alfa })).status, 200);
    assert.equal(Number((await getDb()('user_recovery_codes').count({ n: '*' }))[0].n), 0);
    const usuario = await getDb()('users').where({ username: USUARIO }).first();
    assert.equal(usuario.totp_ciphertext, null);
  });
});
