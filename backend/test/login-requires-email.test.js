import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O terceiro passo da troca: `LOGIN_REQUIRES_EMAIL=true`.
 *
 * Arquivo separado porque a chave é lida do ambiente no import de
 * `config/login.js`, e `node --test` dá um processo por arquivo — que é o que
 * permite exercitar os dois mundos sem que um contamine o outro.
 *
 * O que se prova aqui é o que a chave custa, e é justamente por isso que ela é
 * uma variável de ambiente e não um botão na tela: com ela ligada, **uma conta
 * sem e-mail não entra por nada**. Virar isso num install onde alguém ainda não
 * cadastrou o endereço é trancar essa pessoa do lado de fora, sem tela para
 * desfazer.
 */
process.env.LOGIN_REQUIRES_EMAIL = 'true';

const {
  call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { LOGIN_REQUIRES_EMAIL } = await import('../src/config/login.js');

let panelUrl;
let tenantId;

const entrar = (identificador, senha) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST', body: { username: identificador, password: senha }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'com-email', password: 'senha-com-email-1', email: 'com@isp.exemplo' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));

  const bcrypt = (await import('bcryptjs')).default;
  const id = await runInTenant(tenantId, () => insertReturningId('users', {
    username: 'sem-email',
    password: bcrypt.hashSync('senha-sem-email-1', 4),
    role: 'admin'
  }));
  await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: id, role: 'admin' }));
});

after(async () => {
  await stopTestServers();
});

describe('com a chave virada', () => {
  it('a chave está mesmo ligada neste processo', () => {
    // Sem isto, um arquivo que não conseguisse ligar a chave passaria em tudo
    // abaixo por estar provando o comportamento antigo.
    assert.equal(LOGIN_REQUIRES_EMAIL, true);
  });

  it('entra pelo e-mail', async () => {
    assert.equal((await entrar('com@isp.exemplo', 'senha-com-email-1')).status, 200);
  });

  it('e o nome de usuário deixa de servir', async () => {
    const { status } = await entrar('com-email', 'senha-com-email-1');
    assert.equal(status, 401);
  });

  it('quem não tem e-mail não entra de jeito nenhum', async () => {
    // O custo da chave, dito sem rodeio. É por isto que ela é ambiente e não
    // botão: quem a vira precisa ter olhado `GET /api/auth/email-readiness`
    // antes.
    assert.equal((await entrar('sem-email', 'senha-sem-email-1')).status, 401);
    assert.equal((await entrar('', 'senha-sem-email-1')).status, 400);
  });

  it('e a senha errada continua sendo 401, não outra coisa', async () => {
    // A recusa por identificador e a recusa por senha respondem igual: separar
    // as duas contaria a quem tentasse quais contas já têm e-mail cadastrado.
    const porSenha = await entrar('com@isp.exemplo', 'senha-errada-1');
    const porNome = await entrar('com-email', 'senha-com-email-1');
    assert.equal(porSenha.status, 401);
    assert.equal(porNome.status, 401);
    assert.equal(porSenha.body.message, porNome.body.message);
  });

  it('o painel reporta a chave ligada', async () => {
    const login = await entrar('com@isp.exemplo', 'senha-com-email-1');
    const { body } = await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: { Authorization: `Bearer ${login.body.data.token}` }
    });
    assert.equal(body.data.loginRequiresEmail, true);
    // E diz que ainda há gente de fora: é o número que deveria ter sido olhado
    // antes de virar.
    assert.ok(body.data.withoutEmail >= 1);
    assert.equal(body.data.ready, false);
  });
});
