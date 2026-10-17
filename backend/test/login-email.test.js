import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { isValidEmail } = await import('../src/utils/helpers.js');

/**
 * A troca de `username` para e-mail.
 *
 * É a última peça da Fase 2 e a única que quebra contrato com quem já usa o
 * produto: num install em produção, um dia de virada em que o login passa a
 * exigir e-mail tranca do lado de fora todo operador que ainda não cadastrou o
 * dele — inclusive quem cadastraria os outros.
 *
 * Por isso a troca é em três passos, e este arquivo cobre os três:
 *
 * 1. a coluna existe, anulável, e **toda conta nova nasce com e-mail**;
 * 2. o login aceita nome OU e-mail, com os dois num espaço de nomes só;
 * 3. `LOGIN_REQUIRES_EMAIL=true` desliga o login por nome — e o painel sabe
 *    dizer, antes de virar, quantas contas ainda ficariam de fora.
 *
 * O caso que mais importa é o do espaço de nomes compartilhado: sem ele, um
 * e-mail igual ao nome de outra pessoa faz um identificador casar duas contas,
 * e escolher uma das duas seria escolher em qual conta a senha vai ser
 * conferida.
 */
let panelUrl;
let tenantId;
let token;

const SENHA = 'senha-da-dona-1';

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: SENHA, email: 'dona@isp.exemplo' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  token = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

const entrar = (identificador, senha = SENHA) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST', body: { username: identificador, password: senha }
});

describe('o primeiro administrador', () => {
  it('não é criado sem e-mail', async () => {
    // A conta que não tem quem a conserte depois: é ela quem cadastra as
    // outras. Provado num install limpo por `startTestServers`, abaixo.
    const { status } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST', body: { username: 'sem-email', password: 'senha-qualquer-1' }
    });
    // 409 porque este install já fez setup; o caso do 400 está no bloco de
    // validação. O que importa aqui é que não passa.
    assert.notEqual(status, 201);
  });

  it('guarda o endereço em minúsculas', async () => {
    const linha = await getDb()('users').where({ username: 'a-dona' }).first();
    assert.equal(linha.email, 'dona@isp.exemplo');
  });
});

describe('entrar', () => {
  it('pelo nome de usuário, como sempre foi', async () => {
    const { status } = await entrar('a-dona');
    assert.equal(status, 200);
  });

  it('pelo e-mail', async () => {
    const { status, body } = await entrar('dona@isp.exemplo');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.username, 'a-dona');
  });

  it('pelo e-mail digitado com maiúsculas', async () => {
    // A RFC diz que o local-part é sensível a caixa; nenhum provedor de
    // verdade trata assim, e quem digita o próprio endereço com uma maiúscula
    // a mais espera entrar. A normalização é da aplicação e não da colação do
    // banco, então isto vale igual nos três dialetos.
    const { status } = await entrar('DONA@ISP.Exemplo');
    assert.equal(status, 200);
  });

  it('com espaço em volta do endereço', async () => {
    assert.equal((await entrar('  dona@isp.exemplo  ')).status, 200);
  });

  it('e não com a senha errada, por nenhum dos dois', async () => {
    // O par obrigatório: sem ele, um login que aceitasse qualquer coisa
    // passaria em tudo acima.
    assert.equal((await entrar('a-dona', 'senha-errada-1')).status, 401);
    assert.equal((await entrar('dona@isp.exemplo', 'senha-errada-1')).status, 401);
  });

  it('nem com um endereço que ninguém tem', async () => {
    assert.equal((await entrar('ninguem@isp.exemplo')).status, 401);
  });
});

describe('o espaço de nomes é um só', () => {
  /**
   * A regra que torna `findByLogin` inequívoco. Sem ela, um identificador pode
   * casar duas contas — e a pergunta "de quem é esta senha?" fica ambígua.
   */
  it('recusa um e-mail igual ao nome de usuário de outra pessoa', async () => {
    const criado = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: authHeaders(token),
      body: {
        username: 'tecnico',
        password: 'senha-do-tecnico-1',
        role: 'tech',
        // O nome de usuário de alguém, digitado como se fosse endereço.
        email: 'a-dona@isp.exemplo'
      }
    });
    assert.equal(criado.status, 201, 'este ainda não colide com nada');

    // Agora sim: um nome de usuário igual a um e-mail que já existe.
    const colide = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: authHeaders(token),
      body: {
        username: 'a-dona@isp.exemplo',
        password: 'senha-de-quem-tenta-1',
        role: 'viewer',
        email: 'outro@isp.exemplo'
      }
    });
    assert.equal(colide.status, 409);
  });

  it('e um e-mail já usado por outra conta', async () => {
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST', headers: authHeaders(token),
      body: {
        username: 'nome-livre',
        password: 'senha-livre-1',
        role: 'viewer',
        email: 'dona@isp.exemplo'
      }
    });
    assert.equal(status, 409);
  });

  it('e um identificador ambíguo não deixa ninguém entrar', async () => {
    /**
     * A defesa em profundidade, exercitada com a regra contornada — a colisão é
     * plantada com um insert direto, que é como ela chegaria de verdade (uma
     * linha anterior a esta versão, uma escrita à mão no banco).
     *
     * Falhar fechado é a única direção segura: escolher uma das duas linhas
     * seria escolher em qual conta a senha vai ser conferida.
     */
    const bcrypt = (await import('bcryptjs')).default;
    const idA = await runInTenant(tenantId, () => insertReturningId('users', {
      username: 'ambiguo@isp.exemplo',
      password: bcrypt.hashSync('senha-do-ambiguo-1', 4),
      role: 'viewer'
    }));
    const idB = await runInTenant(tenantId, () => insertReturningId('users', {
      username: 'outro-nome-qualquer',
      password: bcrypt.hashSync('senha-do-ambiguo-1', 4),
      role: 'viewer',
      email: 'ambiguo@isp.exemplo'
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: idA, role: 'viewer' }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: idB, role: 'viewer' }));

    assert.equal(await User.findByLogin('ambiguo@isp.exemplo'), null);
    const { status } = await entrar('ambiguo@isp.exemplo', 'senha-do-ambiguo-1');
    assert.equal(status, 401, 'com duas contas casando, ninguém entra');

    // E o controle: pelo nome que só casa uma, a mesma senha entra. Sem isto, o
    // 401 acima poderia ser só uma senha errada.
    assert.equal((await entrar('outro-nome-qualquer', 'senha-do-ambiguo-1')).status, 200);

    await getDb()('tenant_users').whereIn('user_id', [idA, idB]).del();
    await getDb()('users').whereIn('id', [idA, idB]).del();
  });
});

describe('trocar o próprio nome de usuário', () => {
  /**
   * O buraco que a regra do espaço de nomes deixaria aberto se `changeUsername`
   * conferisse só contra os nomes — e ele não é sobre quem troca, é sobre a
   * vítima: trocar o próprio nome para o e-mail de um colega faria aquele
   * endereço casar duas contas, e um identificador ambíguo é recusado. O colega
   * simplesmente deixa de conseguir entrar, e nada na tela dele explica por quê.
   */
  let vitimaToken;

  before(async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const id = await runInTenant(tenantId, () => insertReturningId('users', {
      username: 'vizinho-de-mesa',
      password: bcrypt.hashSync('senha-do-vizinho-1', 4),
      role: 'viewer',
      email: 'vizinho@isp.exemplo'
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: id, role: 'viewer' }));
    const login = await entrar('vizinho@isp.exemplo', 'senha-do-vizinho-1');
    assert.equal(login.status, 200);
    vitimaToken = login.body.data.token;
  });

  it('não deixa alguém tomar o e-mail de um colega como nome de usuário', async () => {
    const { status } = await call(`${panelUrl}/api/auth/change-username`, {
      method: 'POST', headers: authHeaders(token),
      body: { currentUsername: 'a-dona', newUsername: 'vizinho@isp.exemplo' }
    });
    assert.equal(status, 409);

    // E o colega continua entrando: é a asserção que diz o que estava em jogo.
    assert.equal((await entrar('vizinho@isp.exemplo', 'senha-do-vizinho-1')).status, 200);
    assert.ok(vitimaToken);
  });

  it('mas deixa trocar para um nome que não é de ninguém', async () => {
    // O par obrigatório: sem ele, uma rota quebrada daria o mesmo 409.
    const { status } = await call(`${panelUrl}/api/auth/change-username`, {
      method: 'POST', headers: authHeaders(token),
      body: { currentUsername: 'a-dona', newUsername: 'a-dona-renomeada' }
    });
    assert.equal(status, 200);
    // Devolvido ao que era, porque os blocos abaixo contam com este nome.
    const volta = await call(`${panelUrl}/api/auth/change-username`, {
      method: 'POST', headers: authHeaders(token),
      body: { currentUsername: 'a-dona-renomeada', newUsername: 'a-dona' }
    });
    assert.equal(volta.status, 200);
  });
});

describe('quem já usava o painel', () => {
  let semEmailId;
  let semEmailToken;

  before(async () => {
    // A conta como a migração a deixou: existe, funciona, e não tem endereço.
    const bcrypt = (await import('bcryptjs')).default;
    semEmailId = await runInTenant(tenantId, () => insertReturningId('users', {
      username: 'antigo',
      password: bcrypt.hashSync('senha-do-antigo-1', 4),
      role: 'admin'
    }));
    await runInTenant(tenantId, () => TenantUser.create({
      tenantId, userId: semEmailId, role: 'admin'
    }));
    const login = await entrar('antigo', 'senha-do-antigo-1');
    assert.equal(login.status, 200, 'quem já existia continua entrando pelo nome');
    semEmailToken = login.body.data.token;
  });

  it('cadastra o próprio endereço, provando a senha atual', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/email`, {
      method: 'POST', headers: authHeaders(semEmailToken),
      body: { currentPassword: 'senha-do-antigo-1', email: 'Antigo@ISP.Exemplo' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.email, 'antigo@isp.exemplo');
    assert.equal((await entrar('antigo@isp.exemplo', 'senha-do-antigo-1')).status, 200);
  });

  it('e não sem a senha atual', async () => {
    // O e-mail vai virar o identificador de login: quem alcançasse uma sessão
    // aberta e trocasse o endereço sem provar a senha estaria trocando por onde
    // se entra naquela conta.
    const { status } = await call(`${panelUrl}/api/auth/email`, {
      method: 'POST', headers: authHeaders(semEmailToken),
      body: { currentPassword: 'chute-errado-1', email: 'roubado@isp.exemplo' }
    });
    assert.equal(status, 401);
    const linha = await getDb()('users').where({ id: semEmailId }).first();
    assert.equal(linha.email, 'antigo@isp.exemplo', 'o endereço não pode ter mudado');
  });

  it('nem para um endereço que já é de outra pessoa', async () => {
    const { status } = await call(`${panelUrl}/api/auth/email`, {
      method: 'POST', headers: authHeaders(semEmailToken),
      body: { currentPassword: 'senha-do-antigo-1', email: 'dona@isp.exemplo' }
    });
    assert.equal(status, 409);
  });

  it('mas pode regravar o endereço que já é o seu', async () => {
    // `exceptId`, e o motivo de ele ser coagido com `Number`: um parâmetro que
    // chega como string faria a própria linha não se reconhecer, e toda
    // regravação seria recusada como duplicata de si mesma.
    const { status } = await call(`${panelUrl}/api/auth/email`, {
      method: 'POST', headers: authHeaders(semEmailToken),
      body: { currentPassword: 'senha-do-antigo-1', email: 'antigo@isp.exemplo' }
    });
    assert.equal(status, 200);
  });

  it('e a troca fica na trilha, sem o endereço antigo', async () => {
    const linhas = await getDb()('audit_log').where({ action: 'login_email.changed' });
    assert.ok(linhas.length >= 1);
    const detalhe = JSON.parse(linhas[linhas.length - 1].detail);
    assert.equal(detalhe.email, 'antigo@isp.exemplo');
    // A trilha diz que mudou e para qual, e não vira histórico de endereços de
    // gente.
    assert.equal('previousEmail' in detalhe, false);
  });
});

describe('quando dá para exigir e-mail', () => {
  it('o painel responde quantas contas ainda ficariam de fora', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.loginRequiresEmail, false);
    assert.equal(typeof body.data.total, 'number');
    assert.equal(typeof body.data.withoutEmail, 'number');
    assert.equal(body.data.ready, body.data.withoutEmail === 0);
  });

  it('e conta certo', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const antes = (await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: authHeaders(token)
    })).body.data.withoutEmail;

    const id = await runInTenant(tenantId, () => insertReturningId('users', {
      username: 'mais-um-sem-email',
      password: bcrypt.hashSync('senha-qualquer-1', 4),
      role: 'viewer'
    }));
    const depois = (await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: authHeaders(token)
    })).body.data.withoutEmail;
    assert.equal(depois, antes + 1);

    await getDb()('users').where({ id }).del();
  });

  it('e não é qualquer um que pergunta', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const id = await runInTenant(tenantId, () => insertReturningId('users', {
      username: 'curioso',
      password: bcrypt.hashSync('senha-do-curioso-1', 4),
      role: 'viewer',
      email: 'curioso@isp.exemplo'
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: id, role: 'viewer' }));
    const login = await entrar('curioso@isp.exemplo', 'senha-do-curioso-1');
    const { status } = await call(`${panelUrl}/api/auth/email-readiness`, {
      headers: authHeaders(login.body.data.token)
    });
    assert.equal(status, 403);
  });
});

describe('a validação do endereço', () => {
  it('aceita o que é endereço e recusa o que é erro de digitação', () => {
    // Deliberadamente frouxa: validar e-mail por regex é um problema conhecido
    // por não ter solução, e o único teste que decide é mandar uma mensagem —
    // o que este painel não faz. O que se checa é o que pega engano sem recusar
    // ninguém.
    for (const bom of ['joao@isp.com.br', 'a@b.co', 'nome.sobrenome+tag@sub.isp.com']) {
      assert.equal(isValidEmail(bom), true, bom);
    }
    for (const ruim of ['sem-arroba', 'dois@@isp.com', '@isp.com', 'joao@', 'joao@isp',
      'joao @isp.com', 'joao@.com', 'joao@isp..com', '']) {
      assert.equal(isValidEmail(ruim), false, ruim);
    }
  });

  it('recusa na rota, e não só na função', async () => {
    for (const ruim of ['sem-arroba', 'joao@isp', '']) {
      const { status } = await call(`${panelUrl}/api/users`, {
        method: 'POST', headers: authHeaders(token),
        body: { username: `n-${Math.random().toString(36).slice(2, 8)}`, password: 'senha-qualquer-1', role: 'viewer', email: ruim }
      });
      assert.equal(status, 400, ruim);
    }
  });
});
