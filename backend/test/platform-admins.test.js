import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O cadastro do plano de controle, editado pelo plano de controle.
 *
 * Estas três rotas têm uma propriedade que nenhuma outra do console tem: **elas
 * editam o cadastro que as autoriza.** Todas as outras são poderosas para fora
 * — criam provedores, mudam faturas, abrem sessão no painel de um cliente —,
 * e esta é poderosa para dentro. Daí as duas coisas que este arquivo existe
 * para provar, e que não são "as rotas respondem":
 *
 * 1. **O cadastro não chega a zero.** Zerado, a guarda passa a responder 404
 *    para todo mundo, não há rota que conceda de volta, e a instalação inteira
 *    fica sem plano de controle até alguém abrir um cliente SQL. É a única
 *    operação deste painel cujo desfazer não está no painel. A recusa é
 *    provada aqui pelo caminho comum e pelo caminho da corrida — dois pedidos
 *    simultâneos tirando os dois últimos —, porque é a corrida que uma
 *    contagem escrita antes da remoção deixaria passar.
 * 2. **Quem deu a chave a quem fica registrado.** Uma promoção que não deixa
 *    rastro é a única forma de alguém aparecer com poder sobre o deploy inteiro
 *    sem que nada diga de onde ele veio.
 *
 * A edição é escolhida antes de a aplicação ser importada, como em
 * `platform-tenants.test.js`: `edition.js` lê o ambiente na importação, os
 * `import` estáticos são içados acima de tudo, e `node --test` dá um processo
 * por arquivo. Ao contrário de `platform-members.test.js`, aqui as rotas são
 * alcançadas no app de verdade — a linha que as monta é desta onda, e montá-las
 * num express de mentira provaria o roteador sem provar a montagem.
 */
process.env.EDITION = 'saas';

const {
  authHeaders,
  call,
  getDb,
  startTestServers,
  stopTestServers
} = await import('./helpers/harness.js');

const { default: PlatformAdmin } = await import('../src/models/PlatformAdmin.js');
const { generateImpersonationToken } = await import('../src/middleware/auth.js');

const OWNER = { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' };
// Administradora DO PROVEDOR, e nada mais. Recebe a chave no meio do arquivo e
// a devolve, com o mesmo token na mão o tempo todo.
const ANA = { username: 'ana', password: 'ana-senha-1', email: 'ana@exemplo.test' };
// Concedida pelo e-mail, que é o outro jeito de a pessoa ser conhecida.
const BIA = { username: 'bia', password: 'bia-senha-1', email: 'bia@exemplo.test' };
// Nunca esteve no cadastro. É por ela que se pergunta o que as três rotas
// respondem a quem está fora do plano.
const CARLOS = { username: 'carlos', password: 'carlos-senha-1', email: 'carlos@exemplo.test' };

let panelUrl;
let alfa;
let beta;
let ownerToken;
let ownerId;
let anaToken;
let anaId;
let biaId;
let carlosToken;

const admins = (token) => call(`${panelUrl}/api/platform/admins`, { headers: authHeaders(token) });

const conceder = (token, body) => call(`${panelUrl}/api/platform/admins`, {
  method: 'POST',
  headers: authHeaders(token),
  body
});

const revogar = (token, userId) => call(`${panelUrl}/api/platform/admins/${userId}`, {
  method: 'DELETE',
  headers: authHeaders(token)
});

/** O cadastro lido do banco, que é o que decide — não o que a rota disse. */
const cadastro = () => getDb()('platform_admins').orderBy('user_id', 'asc');

const trilha = (action) => getDb()('platform_audit').where({ action }).orderBy('id', 'asc');

async function criarPessoa(pessoa, role) {
  const criada = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { ...pessoa, role }
  });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  return criada.body.data.user.id;
}

async function entrar(pessoa) {
  const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: pessoa });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.token;
}

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;
  // A instalação de um deploy SaaS é o único caminho que põe alguém no cadastro
  // sem que já haja alguém nele. Sem isto, nada abaixo teria por onde começar.
  assert.ok(await getDb()('platform_admins').where({ user_id: ownerId }).first());

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  anaId = await criarPessoa(ANA, 'admin');
  biaId = await criarPessoa(BIA, 'viewer');
  await criarPessoa(CARLOS, 'viewer');

  anaToken = await entrar(ANA);
  carlosToken = await entrar(CARLOS);
});

after(async () => {
  await stopTestServers();
});

describe('a lista de quem tem o plano de controle', () => {
  it('mostra quem está no cadastro, com o endereço e desde quando', async () => {
    const { status, body } = await admins(ownerToken);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.admins.length, 1);

    const [dono] = body.data.admins;
    assert.equal(Number(dono.userId), Number(ownerId));
    assert.equal(dono.username, 'owner');
    // O endereço e a data são o que a tela mostra embaixo do nome; sem eles a
    // linha não distingue dois operadores homônimos nem diz há quanto tempo
    // alguém tem essa chave.
    assert.equal(dono.email, OWNER.email);
    assert.ok(dono.grantedAt, 'a linha não diz desde quando');
  });

  it('não deixa sair hash de senha nenhum', async () => {
    // O join é com `users`, e a senha está a uma coluna de distância da
    // consulta que monta esta lista.
    const { body } = await admins(ownerToken);
    assert.ok(!JSON.stringify(body.data.admins).includes('$2'));
  });

  it('recusa quem não trouxe sessão nenhuma', async () => {
    const { status } = await call(`${panelUrl}/api/platform/admins`);
    assert.equal(status, 401);
  });
});

describe('conceder o plano de controle', () => {
  it('dá a chave pelo nome, e ela abre de verdade', async () => {
    // Antes: a mesma pessoa, com o mesmo token, não enxerga o console.
    assert.equal((await admins(anaToken)).status, 404);

    const { status, body } = await conceder(ownerToken, { username: ANA.username });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(Number(body.data.admin.userId), Number(anaId));
    assert.equal(body.data.admin.username, 'ana');
    assert.equal(body.data.admin.email, ANA.email);
    assert.ok(body.data.admin.grantedAt);

    // A afirmação que importa não é a resposta: é que a guarda, que relê o
    // cadastro a cada requisição, passa a deixar passar — com o MESMO token
    // que ela recusava três linhas acima. Uma concessão que só valesse no
    // próximo login seria outra coisa.
    const dela = await admins(anaToken);
    assert.equal(dela.status, 200);
    assert.deepEqual(
      dela.body.data.admins.map((a) => a.username),
      ['ana', 'owner']
    );
  });

  it('dá a chave pelo e-mail também', async () => {
    // Quem pede a promoção de um colega copia o que tem à mão, e desde que
    // `users.email` existe isso é tanto o endereço quanto o nome.
    const { status, body } = await conceder(ownerToken, { username: BIA.email });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(Number(body.data.admin.userId), Number(biaId));
    assert.equal(body.data.admin.username, 'bia');
    assert.equal(await PlatformAdmin.has(biaId), true);
  });

  it('conceder duas vezes não explode, e não duplica nem a linha nem a trilha', async () => {
    // Rodar de novo para conferir que pegou é o que quem opera faz. Punir isso
    // com violação de chave única seria punir a conferência.
    const linhasAntes = (await trilha('platform_admin.granted')).length;

    const { status, body } = await conceder(ownerToken, { username: BIA.username });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(Number(body.data.admin.userId), Number(biaId));

    const dela = await getDb()('platform_admins').where({ user_id: biaId });
    assert.equal(dela.length, 1, 'a segunda concessão deixou uma segunda linha');
    assert.equal(
      (await trilha('platform_admin.granted')).length,
      linhasAntes,
      'uma concessão que não mudou nada não é escrita a registrar'
    );
  });

  it('recusa um nome que não é de ninguém, e não cria ninguém', async () => {
    const pessoasAntes = await getDb()('users').count({ n: '*' }).first();
    const cadastroAntes = await cadastro();

    const { status } = await conceder(ownerToken, { username: 'fantasma' });
    // Criar gente é trabalho de `/api/users`, num provedor, onde o pedido traz
    // uma senha que alguém escolheu. Este pedido não tem campo de senha.
    assert.equal(status, 404);
    assert.deepEqual(await getDb()('users').count({ n: '*' }).first(), pessoasAntes);
    assert.deepEqual(await cadastro(), cadastroAntes);
  });

  it('recusa um pedido sem nome nenhum', async () => {
    const { status } = await conceder(ownerToken, {});
    assert.equal(status, 400);
  });
});

describe('revogar o plano de controle', () => {
  it('tira a chave, e ela para de abrir na requisição seguinte', async () => {
    const biaToken = await entrar(BIA);
    assert.equal((await admins(biaToken)).status, 200);

    const { status, body } = await revogar(ownerToken, biaId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(Number(body.data.userId), Number(biaId));
    assert.equal(await PlatformAdmin.has(biaId), false);

    // Mesmo token, requisição seguinte: a guarda relê o cadastro, então não há
    // sessão a derrubar e nem se derruba.
    assert.equal((await admins(biaToken)).status, 404);

    // E o emprego dela continua de pé. Tirar a chave do console não é demitir
    // ninguém do provedor onde a pessoa trabalha.
    const trabalhando = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(biaToken) });
    assert.equal(trabalhando.status, 200);
    assert.equal(Number(trabalhando.body.data.tenantId), Number(alfa));
    assert.ok(await getDb()('users').where({ id: biaId }).first(), 'a pessoa sobrevive');
  });

  it('responde 404 para quem não está no cadastro', async () => {
    const { status } = await revogar(ownerToken, biaId);
    assert.equal(status, 404);
  });

  it('recusa um id que não é id', async () => {
    const { status } = await call(`${panelUrl}/api/platform/admins/abacaxi`, {
      method: 'DELETE',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 400);
  });
});

describe('a trilha que a concessão deixa', () => {
  /**
   * Quem deu a chave do reino a quem.
   *
   * Diferente das ações de equipe, estas NÃO se espelham no `audit_log` de
   * provedor nenhum, e a ausência é a afirmação: a promoção não afeta um
   * provedor em particular, afeta todos, e escolher um em cujo histórico
   * escrevê-la seria mentir sobre o alcance do que foi dado.
   */
  it('registra a concessão com o ator, o alvo e nenhum provedor', async () => {
    const linhas = await trilha('platform_admin.granted');
    assert.ok(linhas.length >= 2, 'as concessões deste arquivo não foram registradas');

    const daAna = linhas.find((l) => JSON.parse(l.detail).username === 'ana');
    assert.ok(daAna, 'a promoção da ana não está na trilha');
    // O ator certo: quem deu, não quem recebeu.
    assert.equal(daAna.actor_username, 'owner');
    assert.equal(Number(daAna.actor_user_id), Number(ownerId));
    assert.equal(Number(JSON.parse(daAna.detail).userId), Number(anaId));
    // Sem provedor, e de propósito — ver o comentário acima.
    assert.equal(daAna.tenant_id, null);
    assert.equal(daAna.tenant_slug, null);
  });

  it('registra a revogação do mesmo jeito', async () => {
    const linhas = await trilha('platform_admin.revoked');
    const daBia = linhas.find((l) => JSON.parse(l.detail).username === 'bia');
    assert.ok(daBia, 'a revogação da bia não está na trilha');
    assert.equal(daBia.actor_username, 'owner');
    assert.equal(Number(JSON.parse(daBia.detail).userId), Number(biaId));
    // O nome é lido ANTES da remoção: depois dela não há mais linha de onde
    // tirá-lo, e `userId: 7` daqui a um ano não diz a ninguém de quem era a
    // chave.
    assert.equal(JSON.parse(daBia.detail).username, 'bia');
  });

  it('não leva segredo nenhum para a trilha', async () => {
    const pessoa = await getDb()('users').where({ id: anaId }).first();
    const tudo = JSON.stringify(await getDb()('platform_audit'));
    assert.ok(!tudo.includes(pessoa.password));
    assert.ok(!tudo.includes(ANA.password));
    assert.ok(!tudo.includes('$2'), 'hash bcrypt na trilha');
  });
});

describe('quem não está no cadastro', () => {
  it('recebe 404 nas três rotas, e nada é escrito', async () => {
    // Carlos trabalha no provedor e nunca teve a chave. O plano de controle
    // existe justamente para que trabalhar num ISP — inclusive administrá-lo —
    // não chegue perto dele.
    const antes = await cadastro();

    const lista = await admins(carlosToken);
    assert.equal(lista.status, 404, 'listando');

    const concessao = await conceder(carlosToken, { username: CARLOS.username });
    assert.equal(concessao.status, 404, 'concedendo');

    const revogacao = await revogar(carlosToken, ownerId);
    assert.equal(revogacao.status, 404, 'revogando');

    assert.deepEqual(await cadastro(), antes, 'alguma das três escreveu mesmo recusando');
  });

  it('recebe a MESMA resposta que uma rota que não existe', async () => {
    // O 404 da guarda é 404 e não 403 para que quem chegou nele não aprenda que
    // há um plano de controle ali. Se o corpo fosse próprio, a escolha do
    // status não teria comprado nada.
    const recusa = await admins(carlosToken);
    const semRota = await call(`${panelUrl}/api/nao-existe`, { headers: authHeaders(carlosToken) });
    assert.equal(semRota.status, 404);
    assert.deepEqual(recusa.body, semRota.body);
  });

  it('inclui uma personificação, mesmo sendo de quem tem a chave', async () => {
    // A personificação é cunhada por quem ESTÁ no cadastro, então a checagem de
    // cadastro passaria. O que não pode passar é a requisição: ela foi
    // re-escopada no provedor de um cliente, e uma rota do console rodando ali
    // agiria sobre o cliente errado — com uma sessão que existe para olhar.
    const dono = await getDb()('users').where({ id: ownerId }).first();
    const personificando = generateImpersonationToken(dono, beta);

    // Uma leitura, de propósito: o muro do método já recusaria POST e DELETE
    // com 403 antes da guarda, então é só no GET que dá para perguntar o que
    // `requirePlatformAdmin` responde a uma personificação.
    const { status, body } = await admins(personificando);
    assert.equal(status, 404);
    const semRota = await call(`${panelUrl}/api/nao-existe`, {
      headers: authHeaders(personificando)
    });
    assert.deepEqual(body, semRota.body);
  });
});

describe('o último administrador do console', () => {
  it('não sai nem quando dois pedidos simultâneos tentam tirar os dois últimos', async () => {
    // O cadastro está com dois: owner e ana. Os dois pedidos abaixo saem juntos
    // e cada um tira um deles — que é exatamente a corrida que uma contagem
    // escrita ANTES da remoção deixa passar: cada um lê "somos dois" antes de o
    // outro apagar, e o console fica sem dono.
    assert.equal((await cadastro()).length, 2);

    const [um, outro] = await Promise.all([
      revogar(ownerToken, ownerId),
      revogar(anaToken, anaId)
    ]);

    const restaram = await cadastro();
    assert.equal(restaram.length, 1, 'os dois pedidos passaram e o console ficou sem dono');

    // Exatamente um venceu. O perdedor é recusado pelo estado do cadastro (409)
    // ou, no SQLite, pelo lock de escritor do arquivo, que o faz falhar em vez
    // de apagar — errar para o lado do erro é aceitável, para o lado do
    // cadastro vazio não é.
    const vitorias = [um, outro].filter((r) => r.status === 200);
    assert.equal(vitorias.length, 1, `dois vencedores: ${um.status} e ${outro.status}`);
    const perdedor = [um, outro].find((r) => r.status !== 200);
    assert.ok([409, 500].includes(perdedor.status), `perdedor respondeu ${perdedor.status}`);
  });

  it('porque a contagem e a remoção são um ato só', async () => {
    // Normaliza: quem sobreviveu à corrida acima depende de quem chegou
    // primeiro, e este teste precisa de exatamente dois no cadastro.
    await getDb()('platform_admins').del();
    await PlatformAdmin.add(ownerId);
    await PlatformAdmin.add(anaId);

    // O teste acima prova a RECUSA, não a atomicidade, e vale dizer por quê:
    // dois pedidos HTTP disparados juntos não chegam a se cruzar no trecho que
    // importa — o servidor termina a parte síncrona de um antes de começar a do
    // outro, e a segunda leitura já enxerga o cadastro reduzido. A janela real
    // é a de duas remoções começando no MESMO tick, que é onde as duas leituras
    // acontecem antes de qualquer uma das remoções. Foi conferido de propósito:
    // trocando a transação por uma contagem seguida de uma remoção, as duas
    // chamadas abaixo devolvem 'removed' e o cadastro fica em ZERO.
    const resultados = await Promise.all([
      PlatformAdmin.removeUnlessLast(ownerId).catch((erro) => `erro: ${erro.message}`),
      PlatformAdmin.removeUnlessLast(anaId).catch((erro) => `erro: ${erro.message}`)
    ]);

    const restaram = await cadastro();
    assert.equal(restaram.length, 1, `o cadastro ficou com ${restaram.length}: ${resultados}`);
    assert.equal(
      resultados.filter((r) => r === 'removed').length,
      1,
      `as duas remoções passaram: ${resultados}`
    );
    // A perdedora ou é recusada pela contagem que enxergou o cadastro já
    // reduzido, ou morre no lock de escritor do SQLite. O que ela não pode ter
    // feito é apagar.
    assert.ok(
      resultados.some((r) => r === 'last' || String(r).startsWith('erro:')),
      `a perdedora não foi recusada: ${resultados}`
    );
  });

  it('recusa a saída do último com uma mensagem que diz por quê', async () => {
    // Quem sobreviveu à corrida acima depende de quem chegou primeiro, então o
    // cadastro é normalizado aqui pelo banco — que é onde os fixtures deste
    // arquivo moram — para que este teste peça sempre a mesma coisa.
    await getDb()('platform_admins').where({ user_id: anaId }).del();
    if (!(await PlatformAdmin.has(ownerId))) await PlatformAdmin.add(ownerId);
    assert.deepEqual((await cadastro()).map((l) => Number(l.user_id)), [Number(ownerId)]);

    const { status, body } = await revogar(ownerToken, ownerId);
    assert.equal(status, 409, JSON.stringify(body));
    // Não é falta de autoridade — quem pede tem toda —, é o estado do cadastro.
    // E a recusa tem que dizer isso: sem o motivo, ela parece defeito.
    assert.match(body.message, /administrator|administrador/i);
    assert.ok(body.message.length > 60, 'a recusa não explica nada');

    // O que ela protege: o cadastro continua de pé e o console continua aberto.
    assert.equal(await PlatformAdmin.has(ownerId), true);
    assert.equal((await admins(ownerToken)).status, 200);
  });

  it('e diz o porquê na língua de quem perguntou', async () => {
    // A recusa é a única resposta destas rotas que alguém vai LER com atenção,
    // porque é a única que contraria o que a pessoa queria fazer. Uma mensagem
    // fixa em inglês seria justamente a que não se entende na hora errada — daí
    // ela sair do dicionário, e daí esta conta.
    const emPortugues = await call(`${panelUrl}/api/platform/admins/${ownerId}`, {
      method: 'DELETE',
      headers: { ...authHeaders(ownerToken), 'Accept-Language': 'pt-BR' }
    });
    assert.equal(emPortugues.status, 409);
    assert.match(emPortugues.body.message, /administrador/);

    const emIngles = await call(`${panelUrl}/api/platform/admins/${ownerId}`, {
      method: 'DELETE',
      headers: { ...authHeaders(ownerToken), 'Accept-Language': 'en' }
    });
    assert.equal(emIngles.status, 409);
    assert.match(emIngles.body.message, /administrator/);
    assert.notEqual(emIngles.body.message, emPortugues.body.message);
  });

  it('não escreve na trilha o que recusou', async () => {
    const antes = (await trilha('platform_admin.revoked')).length;
    assert.equal((await revogar(ownerToken, ownerId)).status, 409);
    assert.equal((await trilha('platform_admin.revoked')).length, antes);
  });

  it('deixa de ser o último assim que outra pessoa recebe a chave', async () => {
    // A ordem que a recusa impõe, e a única que ela impõe: promove o
    // substituto, depois sai. Nada além disso fica proibido.
    assert.equal((await conceder(ownerToken, { username: CARLOS.username })).status, 201);
    const { status } = await revogar(ownerToken, ownerId);
    assert.equal(status, 200);
    assert.equal(await PlatformAdmin.has(ownerId), false);
    // E quem saiu saiu de verdade: o token que era do dono do console já não
    // alcança mais nada dele.
    assert.equal((await admins(ownerToken)).status, 404);
  });
});
