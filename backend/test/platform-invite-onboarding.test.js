import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * O primeiro acesso de um provedor criado pelo console, de ponta a ponta.
 *
 * Este arquivo existe por causa de um beco sem saída que estava completo, e a
 * primeira metade dele encena o beco exatamente como ele se apresentava na
 * tela: um provedor recém-criado, com zero operadores, e nenhuma porta que
 * levasse a primeira conta até lá.
 *
 *   1. `POST /tenants/:id/members` recusa 404 — ela vincula quem JÁ tem login e
 *      não tem campo de senha, por desenho;
 *   2. `POST /api/auth/setup` no host do provedor novo responde 409, porque o
 *      gate dele conta a tabela `users`, que é do DEPLOY inteiro e não do
 *      provedor — e `setup-status` responde `needsSetup: false`, então a tela de
 *      primeiro acesso nem aparece por lá;
 *   3. `POST /api/invites` é escopado: exige uma sessão DENTRO do provedor que
 *      ainda não tem ninguém para abrir sessão.
 *
 * A segunda metade prova a saída: o console cunha o convite no escopo daquele
 * provedor, o link aponta para o endereço DELE, e quem aceita nasce com a senha
 * que escolheu e já entra no painel dele — sem que a plataforma conheça essa
 * senha em nenhum momento.
 *
 * Por que arquivo próprio: o aceite exige que o convite seja aberto no host do
 * provedor (`usableInvite` compara o provedor do convite com o do escopo), e o
 * domínio-base é lido no carregamento do módulo. `node --test` dá um processo
 * por arquivo, então é aqui que ele pode ser declarado sem mudar a resolução por
 * host das outras suítes.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';

const { call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

const DONO = { username: 'dono', password: 'senha-do-dono-1', email: 'dono@exemplo.test' };
/** Quem o ISP vai indicar, e que ainda não tem conta nenhuma neste deploy. */
const SUPORTE = {
  username: 'suporte-inove',
  password: 'senha-do-suporte-1',
  email: 'suporte@inove.exemplo.test'
};

let panelUrl;
let alfa;
let inove;
let donoToken;
let consoleToken;

/**
 * Uma requisição com o `Host` escolhido.
 *
 * `fetch` não faz isto: `Host` é cabeçalho proibido lá e o undici o substitui em
 * silêncio — um teste escrito com `fetch` passaria provando nada. É a mesma
 * razão, e a mesma função, de `tenant-subdomain.test.js`.
 */
function callAs(host, path, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(`${panelUrl}${path}`);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const ALFA_HOST = 'alfa.painel.exemplo.com';
const INOVE_HOST = 'inove.painel.exemplo.com';
/** O endereço da plataforma, que é onde o console responde. */
const APEX_HOST = 'painel.exemplo.com';

const comoDono = (path, options = {}) => callAs(ALFA_HOST, path, {
  ...options,
  headers: { Authorization: `Bearer ${donoToken}`, ...(options.headers || {}) }
});

const noConsole = (path, options = {}) => callAs(APEX_HOST, path, {
  ...options,
  headers: { Authorization: `Bearer ${consoleToken}`, ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  // O provedor da própria instalação vira `alfa`: é dele que o administrador da
  // plataforma trabalha, e é o escopo que a sessão dele abre — que não é o
  // provedor sobre o qual o console age.
  const primeiro = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: primeiro.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  alfa = primeiro.id;

  const setup = await callAs(ALFA_HOST, '/api/auth/setup', { method: 'POST', body: DONO });
  assert.equal(setup.status, 201, 'o primeiro administrador do deploy não foi criado');
  donoToken = setup.body.data.token;

  // `platform_admins` nasce vazia e nenhuma migração promove ninguém, então o
  // cadastro é semeado como os scripts de bootstrap o semeiam — com a guarda que
  // `platform-tenants.test.js` também tem, porque o `/setup` da edição SaaS já
  // põe lá o primeiro administrador por conta própria.
  const donoId = setup.body.data.user.id;
  if (!(await db('platform_admins').where({ user_id: donoId }).first())) {
    await db('platform_admins').insert({ user_id: donoId });
  }

  // O console responde no ENDEREÇO DA PLATAFORMA, e com a sessão de lá: a do
  // setup nomeia o provedor alfa, e com ela o console não responde mais.
  const consoleEntrada = await callAs(APEX_HOST, '/api/auth/login', {
    method: 'POST', body: { username: DONO.username, password: DONO.password }
  });
  assert.equal(consoleEntrada.status, 200, JSON.stringify(consoleEntrada.body));
  consoleToken = consoleEntrada.body.data.token;

  const criado = await noConsole('/api/platform/tenants', {
    method: 'POST',
    body: { slug: 'inove', name: 'inove' }
  });
  assert.equal(criado.status, 201, 'o console não conseguiu criar o provedor');
  inove = criado.body.data.tenant.id;
  assert.equal(criado.body.data.tenant.operators, 0, 'o provedor nasceu com equipe');
});

after(async () => {
  await stopTestServers();
});

describe('um provedor recém-criado, antes do convite', () => {
  it('não tem ninguém, e vincular quem não existe é recusado com um código que a tela lê', async () => {
    const { status, body } = await noConsole(`/api/platform/tenants/${inove}/members`, {
      method: 'POST',
      body: { username: SUPORTE.email, role: 'owner' }
    });
    assert.equal(status, 404);
    // A tela troca esta recusa por uma frase traduzida que manda convidar; sem o
    // código ela teria que reconhecer a frase em inglês do plano de controle.
    assert.equal(body.code, 'person_not_found');
    assert.equal((await getDb()('tenant_users').where({ tenant_id: inove })).length, 0);
  });

  /**
   * E o `/setup` no endereço dele não é a saída, ao contrário do que o nome
   * sugere: o gate conta `users`, que é tabela do deploy, então a partir do
   * SEGUNDO provedor ele responde "já concluído" para sempre.
   *
   * Isto não é o conserto desta fatia — é a razão de o conserto ser o convite.
   * Abrir o setup por provedor deixaria `<slug>.painel/setup` aberto a quem
   * chegasse primeiro num endereço fácil de adivinhar, e quem chegasse primeiro
   * viraria dono do painel do cliente.
   */
  it('e o primeiro acesso no endereço dele não se abre', async () => {
    const status = await callAs(INOVE_HOST, '/api/auth/setup-status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.needsSetup, false,
      'se isto virar `true`, o setup por provedor passou a existir e este teste tem que ser relido junto');

    const tentativa = await callAs(INOVE_HOST, '/api/auth/setup', {
      method: 'POST',
      body: SUPORTE
    });
    assert.equal(tentativa.status, 409);
    assert.equal((await getDb()('users').where({ username: SUPORTE.username })).length, 0);
  });

  it('e o convite do próprio provedor exige uma sessão que ainda não existe lá dentro', async () => {
    // O token do administrador da plataforma vale em ALFA. Apresentado no host
    // de inove ele não abre sessão nenhuma — é a proteção contra token repetido
    // no host do vizinho, e é o que fecha a quarta parede do beco.
    const { status } = await callAs(INOVE_HOST, '/api/invites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${donoToken}` },
      body: { role: 'owner' }
    });
    assert.ok(status === 401 || status === 403, `respondeu ${status}`);
    assert.equal((await getDb()('tenant_invites').where({ tenant_id: inove })).length, 0);
  });
});

describe('o convite cunhado pelo console', () => {
  let token;

  it('aponta para o endereço do provedor convidado', async () => {
    const { status, body } = await noConsole(`/api/platform/tenants/${inove}/invites`, {
      method: 'POST',
      body: { role: 'owner' }
    });
    assert.equal(status, 201, `o convite não foi cunhado: ${JSON.stringify(body?.message)}`);
    token = body.data.token;
    assert.ok(token, 'o convite voltou sem token, e o token é o convite');
    // O host é o DELE, não o do console: é a única parte do link que o navegador
    // de quem convidou não tem como montar.
    assert.equal(body.data.url, `https://inove.painel.exemplo.com/invite#${token}`);
    assert.equal(body.data.invite.role, 'owner');

    const [convite] = await getDb()('tenant_invites').where({ tenant_id: inove });
    assert.ok(convite, 'o convite não nasceu no provedor nomeado');
    assert.equal((await getDb()('tenant_invites').where({ tenant_id: alfa })).length, 0,
      'o convite nasceu no provedor de quem convidou');
  });

  it('e o aceite no endereço dele dá ao ISP a primeira conta, com a senha que ele escolheu', async () => {
    // O token viaja no CORPO, não no caminho: as duas rotas do convite deixaram
    // de ser endereçadas por parâmetro para que ele não entre em log de acesso.
    const preview = await callAs(INOVE_HOST, '/api/invites/token/preview', {
      method: 'POST',
      body: { token }
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.tenant.slug, 'inove');
    assert.equal(preview.body.data.role, 'owner');

    const aceite = await callAs(INOVE_HOST, '/api/invites/token/accept', {
      method: 'POST',
      body: { ...SUPORTE, token }
    });
    // 201: o aceite CRIOU a pessoa — é a diferença entre este caminho e o do
    // consultor que já tinha conta e só ganhou mais um vínculo.
    assert.equal(aceite.status, 201, `o aceite falhou: ${JSON.stringify(aceite.body?.message)}`);
    assert.ok(aceite.body.data.token, 'o aceite não devolveu sessão');

    const pessoa = await getDb()('users').where({ username: SUPORTE.username }).first();
    assert.ok(pessoa, 'a pessoa convidada não existe');
    const vinculo = await getDb()('tenant_users')
      .where({ tenant_id: inove, user_id: pessoa.id })
      .first();
    assert.ok(vinculo, 'aceitou e não entrou na equipe');
    assert.equal(vinculo.role, 'owner', 'entrou com papel diferente do que o convite dizia');
    assert.equal((await getDb()('tenant_users').where({ tenant_id: alfa, user_id: pessoa.id })).length, 0,
      'o aceite pôs a pessoa também no provedor de quem convidou');
  });

  it('e a senha vale no painel dele, que é o beco de onde esta fatia partiu', async () => {
    const entrada = await callAs(INOVE_HOST, '/api/auth/login', {
      method: 'POST',
      body: { username: SUPORTE.username, password: SUPORTE.password }
    });
    assert.equal(entrada.status, 200, 'o ISP não consegue entrar no painel que recebeu');

    // E só no dele: a mesma credencial no host do vizinho não abre sessão.
    const noVizinho = await callAs(ALFA_HOST, '/api/auth/login', {
      method: 'POST',
      body: { username: SUPORTE.username, password: SUPORTE.password }
    });
    assert.ok(noVizinho.status >= 400, `entrou no provedor vizinho: ${noVizinho.status}`);
  });

  it('e o console passa a contar o operador na linha daquele provedor', async () => {
    const { status, body } = await noConsole('/api/platform/tenants');
    assert.equal(status, 200);
    const linha = body.data.tenants.find((t) => t.id === inove);
    assert.equal(linha.operators, 1, 'a linha do provedor continua dizendo que ninguém trabalha lá');
  });

  it('e o convite não serve duas vezes', async () => {
    const segundo = await callAs(INOVE_HOST, '/api/invites/token/accept', {
      method: 'POST',
      body: { token, username: 'outra-pessoa', password: 'senha-de-outra-1', email: 'outra@exemplo.test' }
    });
    assert.equal(segundo.status, 404, 'o convite aceito continua utilizável');
    assert.equal((await getDb()('users').where({ username: 'outra-pessoa' })).length, 0);
  });
});

/**
 * A outra porta: a conta criada PELO console, com link de primeira senha.
 *
 * O convite serve o ISP que vai se administrar. Esta serve o provedor
 * ADMINISTRADO — aquele que a plataforma opera em nome do cliente —, e a
 * diferença aparece inteira aqui: a conta já nasce com nome, endereço e papel
 * decididos por quem opera o console, e o que a pessoa faz é só escolher a
 * senha. Que ela escolhe no endereço DELA, numa tela que já existia para a
 * redefinição comum.
 */
describe('a conta criada pelo console, com link de primeira senha', () => {
  const GERENTE = { username: 'gerente-inove', email: 'gerente@inove.exemplo.test' };
  const SENHA = 'senha-escolhida-por-ela-1';
  let link;
  let bilhete;

  it('nasce com vínculo no provedor e devolve o link no endereço dele', async () => {
    const { status, body } = await noConsole(`/api/platform/tenants/${inove}/operators`, {
      method: 'POST',
      body: { ...GERENTE, role: 'admin' }
    });
    assert.equal(status, 201, `a conta não foi criada: ${JSON.stringify(body?.message)}`);
    bilhete = body.data.token;
    link = body.data.url;
    assert.equal(link, `https://inove.painel.exemplo.com/reset-password#${bilhete}`,
      'o link tem que abrir no endereço do provedor, não no do console');

    const pessoa = await getDb()('users').where({ username: GERENTE.username }).first();
    assert.ok(pessoa, 'a conta não existe');
    assert.equal(body.data.membership.userId, pessoa.id);
    const vinculo = await getDb()('tenant_users')
      .where({ tenant_id: inove, user_id: pessoa.id })
      .first();
    assert.ok(vinculo, 'a conta nasceu sem vínculo');
    assert.equal(vinculo.role, 'admin');
  });

  it('e a conta não entra em lugar nenhum antes de o link ser usado', async () => {
    // Não há senha a tentar: a que está gravada é aleatória e ninguém a viu. O
    // que se prova aqui é que o link é o ÚNICO caminho — inclusive contra os
    // palpites que alguém daria olhando o cadastro.
    for (const tentativa of [GERENTE.username, GERENTE.email, 'senha-escolhida-por-ela-1']) {
      const { status } = await callAs(INOVE_HOST, '/api/auth/login', {
        method: 'POST',
        body: { username: GERENTE.username, password: tentativa }
      });
      assert.ok(status >= 400, `entrou com ${JSON.stringify(tentativa)}`);
    }
  });

  it('o link vale no endereço do provedor, e só lá', async () => {
    // No apex a rota nem existe: `/api/auth/password-reset/*` não está na lista
    // do endereço da plataforma, e o bilhete é resgatado pelo provedor do host.
    const noApex = await callAs(APEX_HOST, '/api/auth/password-reset/confirm', {
      method: 'POST',
      body: { token: bilhete, password: SENHA }
    });
    assert.ok(noApex.status >= 400, `o apex aceitou o bilhete: ${noApex.status}`);

    const noProvedor = await callAs(INOVE_HOST, '/api/auth/password-reset/confirm', {
      method: 'POST',
      body: { token: bilhete, password: SENHA }
    });
    assert.equal(noProvedor.status, 200, JSON.stringify(noProvedor.body));
  });

  it('e aí a pessoa entra no painel dela, com a senha que ela escolheu', async () => {
    const entrada = await callAs(INOVE_HOST, '/api/auth/login', {
      method: 'POST',
      body: { username: GERENTE.username, password: SENHA }
    });
    assert.equal(entrada.status, 200, 'a senha escolhida no link não abre o painel');

    // E o bilhete morre no primeiro uso: um link que continua valendo é uma
    // credencial esquecida numa caixa de entrada.
    const denovo = await callAs(INOVE_HOST, '/api/auth/password-reset/confirm', {
      method: 'POST',
      body: { token: bilhete, password: 'outra-senha-qualquer-1' }
    });
    assert.ok(denovo.status >= 400, 'o link serviu duas vezes');
    const ainda = await callAs(INOVE_HOST, '/api/auth/login', {
      method: 'POST',
      body: { username: GERENTE.username, password: SENHA }
    });
    assert.equal(ainda.status, 200, 'a segunda tentativa trocou a senha mesmo recusando');
  });

  it('e o console passa a contar os dois operadores do provedor', async () => {
    const { status, body } = await noConsole('/api/platform/tenants');
    assert.equal(status, 200);
    const linha = body.data.tenants.find((t) => t.id === inove);
    assert.equal(linha.operators, 2, 'a linha do provedor não conta quem foi criado pelo console');
  });
});
