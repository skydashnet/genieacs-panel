import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A trava por CONTA contra força bruta — ver `src/models/AccountLockout.js`.
 *
 * O limitador do login conta por (provedor do host, endereço), e quem distribui
 * os palpites por muitos endereços nunca esbarra nele. O que este arquivo
 * prende é a contagem pelo ALVO: dez tentativas erradas travam a conta venham
 * de onde vierem; travada, a senha certa é recusada igual à errada; a trava
 * vence sozinha; entrar zera a contagem; e o código do 2FA, a troca de senha e
 * o aceite de convite contam na mesma trava.
 *
 * "Venham de onde vierem" é simulado esvaziando o balde do `authLimiter` antes
 * de cada tentativa: cada uma chega como se fosse de um (host, IP) novo. É
 * também o que deixa esta suíte entrar dezenas de vezes sem esbarrar nos vinte
 * por quarto de hora do limitador.
 */
const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { authLimiter, tenantIpKey } = await import('../src/middleware/rateLimit.js');
const { totpCode, totpStep } = await import('../src/utils/totp.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const {
  default: AccountLockout, LOCKOUT_MAX_ATTEMPTS
} = await import('../src/models/AccountLockout.js');

const DONA = { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' };
const ERRADA = 'senha-errada-000';

let panelUrl;
let donaToken;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONA });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donaToken = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

/** Cada tentativa como se viesse de um (host, IP) que o limitador nunca viu. */
async function baldeNovo() {
  const host = new URL(panelUrl).host;
  await authLimiter.resetKey(tenantIpKey({ ip: '127.0.0.1', headers: { host } }));
}
beforeEach(baldeNovo);

async function entrar(username, password, extra = {}) {
  await baldeNovo();
  return call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username, password, ...extra } });
}

let seq = 0;
/** Uma pessoa nova da equipe, com senha conhecida — cada caso trava a sua. */
async function pessoa() {
  seq += 1;
  const dados = {
    username: `alvo${seq}`,
    password: `senha-do-alvo-${seq}`,
    email: `alvo${seq}@exemplo.test`,
    role: 'admin'
  };
  const { status, body } = await call(`${panelUrl}/api/users`, {
    method: 'POST', headers: authHeaders(donaToken), body: dados
  });
  assert.equal(status, 201, JSON.stringify(body));
  return { ...dados, id: body.data.user.id };
}

async function linha(subject) {
  return getDb()('account_lockouts').where({ subject }).first();
}

async function travasNaTrilha(userId) {
  return getDb()('audit_log')
    .where({ action: AuditLog.ACTIONS.USER_ACCOUNT_LOCKED, subject_id: String(userId) });
}

function assertTravada({ status, body, response }) {
  assert.equal(status, 429, JSON.stringify(body));
  assert.equal(body.code, 'account_locked');
  assert.equal(body.success, false);
  assert.ok(!body.data?.token, 'travada, e mesmo assim saiu token');
  assert.ok(Number(response.headers.get('retry-after')) > 0);
}

async function errarSenha(alvo, vezes = LOCKOUT_MAX_ATTEMPTS) {
  for (let i = 0; i < vezes; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { status, body } = await entrar(alvo.username, ERRADA);
    assert.equal(status, 401, `tentativa ${i + 1}: ${JSON.stringify(body)}`);
    assert.notEqual(body.code, 'account_locked');
  }
}

describe('a senha', () => {
  it('dez erros, de endereços diferentes, travam a conta — e a senha certa é recusada', async () => {
    const alvo = await pessoa();
    await errarSenha(alvo);

    const certa = await entrar(alvo.username, alvo.password);
    assertTravada(certa);

    // A errada recebe exatamente a mesma resposta: a trava não confere nada.
    const errada = await entrar(alvo.username, ERRADA);
    assertTravada(errada);
    assert.deepEqual(errada.body, certa.body);

    // Pelo e-mail é a mesma conta, e a mesma trava.
    assertTravada(await entrar(alvo.email, alvo.password));

    const travada = await linha(AccountLockout.forUser(alvo.id));
    assert.ok(Number(travada.locked_until) > Date.now());
  });

  it('a trava deixa UMA linha na trilha, sem nada do que foi digitado', async () => {
    const alvo = await pessoa();
    await errarSenha(alvo);
    assertTravada(await entrar(alvo.username, alvo.password));
    assertTravada(await entrar(alvo.username, ERRADA));

    const linhas = await travasNaTrilha(alvo.id);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].actor_kind, 'system');
    const detalhe = JSON.parse(linhas[0].detail);
    assert.equal(detalhe.via, 'login');
    assert.equal(detalhe.username, alvo.username);
    assert.ok(!linhas[0].detail.includes(ERRADA));
    assert.ok(!linhas[0].detail.includes(alvo.password));
  });

  it('a trava vence sozinha', async () => {
    const alvo = await pessoa();
    await errarSenha(alvo);
    assertTravada(await entrar(alvo.username, alvo.password));

    // Em vez de esperar quinze minutos, o relógio da linha anda para trás.
    await getDb()('account_lockouts')
      .where({ subject: AccountLockout.forUser(alvo.id) })
      .update({ locked_until: Date.now() - 1000 });

    const { status, body } = await entrar(alvo.username, alvo.password);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.data.token);
    assert.equal(await linha(AccountLockout.forUser(alvo.id)), undefined);
  });

  it('entrar zera a contagem', async () => {
    const alvo = await pessoa();
    await errarSenha(alvo, LOCKOUT_MAX_ATTEMPTS - 1);
    assert.equal((await entrar(alvo.username, alvo.password)).status, 200);
    assert.equal(await linha(AccountLockout.forUser(alvo.id)), undefined);

    // Mais nove erros não travam: a conta dos nove de antes sumiu.
    await errarSenha(alvo, LOCKOUT_MAX_ATTEMPTS - 1);
    assert.equal((await entrar(alvo.username, alvo.password)).status, 200);
  });

  it('a janela vencida recomeça a contagem', async () => {
    const alvo = await pessoa();
    await errarSenha(alvo, LOCKOUT_MAX_ATTEMPTS - 1);
    await getDb()('account_lockouts')
      .where({ subject: AccountLockout.forUser(alvo.id) })
      .update({ window_started_at: Date.now() - 16 * 60 * 1000 });
    // Nove erros velhos não somam aos de agora.
    await errarSenha(alvo, LOCKOUT_MAX_ATTEMPTS - 1);
    assert.equal((await entrar(alvo.username, alvo.password)).status, 200);
  });

  it('login que não existe trava do mesmo jeito, e a resposta não diz quem tem conta', async () => {
    const alvo = await pessoa();
    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await entrar('ninguem-com-este-nome', ERRADA)).status, 401);
    }
    const inventado = await entrar('ninguem-com-este-nome', ERRADA);
    assertTravada(inventado);

    await errarSenha(alvo);
    const real = await entrar(alvo.username, ERRADA);
    assertTravada(real);
    assert.deepEqual(inventado.body, real.body);

    // O que foi digitado não fica em texto na tabela.
    const linhas = await getDb()('account_lockouts').select('subject');
    assert.ok(linhas.every((l) => !l.subject.includes('ninguem')));
  });

  it('uma rajada simultânea não ganha mais que os dez palpites', async () => {
    const alvo = await pessoa();
    await baldeNovo();
    const respostas = await Promise.all(Array.from({ length: 15 }, () => call(
      `${panelUrl}/api/auth/login`, { method: 'POST', body: { username: alvo.username, password: ERRADA } }
    )));
    const conferidas = respostas.filter((r) => r.status === 401).length;
    const travadas = respostas.filter((r) => r.status === 429 && r.body.code === 'account_locked').length;
    assert.ok(conferidas <= LOCKOUT_MAX_ATTEMPTS, `${conferidas} palpites conferidos`);
    assert.equal(conferidas + travadas, 15);
    assertTravada(await entrar(alvo.username, alvo.password));
  });

  it('a trava de uma conta não toca na outra', async () => {
    const alvo = await pessoa();
    const vizinho = await pessoa();
    await errarSenha(alvo);
    assertTravada(await entrar(alvo.username, alvo.password));
    assert.equal((await entrar(vizinho.username, vizinho.password)).status, 200);
  });

  it('trocar a senha pelo administrador destrava', async () => {
    const alvo = await pessoa();
    await errarSenha(alvo);
    assertTravada(await entrar(alvo.username, alvo.password));

    const nova = 'senha-nova-do-alvo-1';
    const { status, body } = await call(`${panelUrl}/api/users/${alvo.id}`, {
      method: 'PATCH', headers: authHeaders(donaToken), body: { password: nova }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((await entrar(alvo.username, nova)).status, 200);
  });
});

describe('o segundo fator', () => {
  it('códigos errados contam, e a senha certa que vem junto não zera nada', async () => {
    const alvo = await pessoa();
    const sessao = await entrar(alvo.username, alvo.password);
    const token = sessao.body.data.token;
    const setup = await call(`${panelUrl}/api/auth/mfa/setup`, {
      method: 'POST', headers: authHeaders(token), body: {}
    });
    const segredo = setup.body.data.secret;
    const ligado = await call(`${panelUrl}/api/auth/mfa/enable`, {
      method: 'POST', headers: authHeaders(token), body: { code: totpCode(segredo, totpStep()) }
    });
    assert.equal(ligado.status, 200, JSON.stringify(ligado.body));

    const agora = totpCode(segredo, totpStep());
    const errado = String((Number(agora) + 500_000) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await entrar(alvo.username, alvo.password, { totpCode: errado });
      assert.equal(status, 401, JSON.stringify(body));
      assert.equal(body.code, 'mfa_invalid');
    }

    // Senha e código certos, e mesmo assim não: a conta está travada.
    assertTravada(await entrar(alvo.username, alvo.password, { totpCode: totpCode(segredo, totpStep()) }));
    const linhas = await travasNaTrilha(alvo.id);
    assert.equal(linhas.length, 1);
    assert.equal(JSON.parse(linhas[0].detail).via, 'login_mfa');
  });
});

describe('a troca de senha', () => {
  it('a senha atual errada conta, na mesma trava do login', async () => {
    const alvo = await pessoa();
    const token = (await entrar(alvo.username, alvo.password)).body.data.token;
    const trocar = (currentPassword) => call(`${panelUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { currentPassword, newPassword: 'outra-senha-boa-1' }
    });

    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await trocar(ERRADA);
      assert.equal(status, 401, JSON.stringify(body));
    }
    assertTravada(await trocar(alvo.password));
    // A mesma trava fecha o formulário de entrada.
    assertTravada(await entrar(alvo.username, alvo.password));
    // E a senha não mudou.
    const { password } = await getDb()('users').where({ id: alvo.id }).first('password');
    const bcrypt = (await import('bcryptjs')).default;
    assert.ok(await bcrypt.compare(alvo.password, password));
    const linhas = await travasNaTrilha(alvo.id);
    assert.equal(JSON.parse(linhas[0].detail).via, 'change_password');
  });

  it('a troca que dá certo zera a contagem', async () => {
    const alvo = await pessoa();
    const token = (await entrar(alvo.username, alvo.password)).body.data.token;
    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await call(`${panelUrl}/api/auth/change-password`, {
        method: 'POST', headers: authHeaders(token), body: { currentPassword: ERRADA, newPassword: 'outra-senha-boa-1' }
      });
    }
    const ok = await call(`${panelUrl}/api/auth/change-password`, {
      method: 'POST', headers: authHeaders(token), body: { currentPassword: alvo.password, newPassword: 'outra-senha-boa-1' }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await linha(AccountLockout.forUser(alvo.id)), undefined);
  });
});

describe('o convite', () => {
  it('aceitar com a senha de uma conta que existe conta na mesma trava', async () => {
    const alvo = await pessoa();
    const convite = await call(`${panelUrl}/api/invites`, {
      method: 'POST', headers: authHeaders(donaToken), body: { role: 'tech' }
    });
    assert.equal(convite.status, 201, JSON.stringify(convite.body));
    const aceitar = (password) => call(`${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: convite.body.data.token, username: alvo.username, password }
    });

    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await aceitar(ERRADA);
      assert.equal(status, 401, JSON.stringify(body));
    }
    assertTravada(await aceitar(alvo.password));
    assertTravada(await entrar(alvo.username, alvo.password));
    const linhas = await travasNaTrilha(alvo.id);
    assert.equal(JSON.parse(linhas[0].detail).via, 'invite');
  });
});
