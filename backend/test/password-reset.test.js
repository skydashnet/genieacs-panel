import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * "Esqueci minha senha" — e a prova de endereço que ela obriga a existir.
 *
 * O que este arquivo guarda não é que a redefinição funcione. É o cerco dela,
 * porque ela é um caminho novo que entrega o controle de uma conta a quem lê
 * uma caixa de entrada:
 *
 * - o pedido responde a MESMA coisa exista a conta ou não, e não manda nada
 *   para endereço que ninguém provou;
 * - o bilhete serve uma vez, no host onde foi cunhado, e morre se o endereço
 *   da conta mudar depois de ele sair;
 * - concluir derruba toda sessão antiga — inclusive a de quem invadiu;
 * - e um bilhete de verificação não vira um bilhete de senha.
 *
 * SaaS com subdomínio porque metade das provas é sobre o host: o bilhete é
 * cunhado no painel de um provedor e não pode ser gasto no de outro. `Host` é
 * header proibido no `fetch`, daí o `http.request` cru. O SMTP é de mentira e
 * em processo — o link É a credencial, e nada sai desta máquina.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: AuthTicket } = await import('../src/models/AuthTicket.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const {
  authLimiter, authTicketRedeemLimiter, emailChangeLimiter, passwordResetLimiter
} = await import('../src/middleware/rateLimit.js');

function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
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
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
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

let panelUrl;
let smtp;
let recebidas;
let alfa;
let beta;
let donaToken;
let donaId;
/**
 * A senha que a `dona` tem AGORA.
 *
 * Metade das provas daqui troca a senha dela, e trocar a senha derruba a sessão
 * — é o mecanismo, não efeito colateral. Guardar a senha corrente numa variável
 * e reentrar antes de cada prova é o que impede um teste de falhar por causa do
 * token que o teste anterior invalidou, em vez de por causa do que ele mede.
 */
let senhaDaDona = 'senha-da-dona-1';
let soDoBetaId;

const CASA = 'default.painel.test';
const BETA = 'beta.painel.test';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const naCasa = (path, options) => callAs(CASA, `${panelUrl}${path}`, options);
const noBeta = (path, options) => callAs(BETA, `${panelUrl}${path}`, options);

/**
 * Esvazia, entre um teste e outro, os três baldes que este caminho atravessa.
 *
 * Os limitadores são apertados de propósito — cinco pedidos de redefinição por
 * quarto de hora, porque cada um aceito manda uma mensagem para a caixa de
 * entrada de uma pessoa real — e uma suíte que exercita o caminho inteiro
 * estoura isso na terceira prova. Zerar é o que deixa cada teste provar a SUA
 * coisa em vez de morrer no balde do teste anterior; que os baldes existem e
 * mordem tem prova própria, no fim deste arquivo.
 *
 * `resetKey` devolve promessa — a loja pode ser remota —, e sem o `await` a
 * limpeza chega depois da requisição seguinte.
 */
async function esvaziarBaldes() {
  for (const slug of ['default', 'beta']) {
    const chave = `${slug}|127.0.0.1`;
    await authLimiter.resetKey(chave);
    await passwordResetLimiter.resetKey(chave);
    await emailChangeLimiter.resetKey(chave);
    await authTicketRedeemLimiter.resetKey(chave);
  }
}

beforeEach(esvaziarBaldes);

/** Entra como `dona` com a senha corrente e guarda o token. */
async function entrar() {
  // O balde do login também é zerado aqui: esta suíte reentra a cada prova,
  // porque é o que a troca de senha obriga, e vinte tentativas por quarto de
  // hora acabam antes das provas.
  await esvaziarBaldes();
  const { status, body } = await naCasa('/api/auth/login', {
    method: 'POST', body: { username: 'dona', password: senhaDaDona }
  });
  assert.equal(status, 200, JSON.stringify(body));
  donaToken = body.data.token;
}

/** A última mensagem recebida, já legível. */
function ultimaMensagem() {
  assert.ok(recebidas.length > 0, 'nenhuma mensagem chegou ao SMTP');
  return decodificarQuotedPrintable(recebidas[recebidas.length - 1]);
}

/** O token que está no fragmento do link de uma mensagem. */
function bilheteDaMensagem(rota) {
  const achado = ultimaMensagem().match(new RegExp(`${rota}#([0-9a-f]{64})`));
  assert.ok(achado, `a mensagem não traz um link de ${rota}:\n${ultimaMensagem()}`);
  return achado[1];
}

/**
 * Tira o carimbo do endereço da `dona`, direto no banco.
 *
 * É fixture, não atalho: pedir a prova de um endereço JÁ provado não manda
 * mensagem nenhuma — de propósito, porque reprovar o que já foi provado é
 * ruído —, então uma prova nova precisa de um endereço sem carimbo. Fazer isso
 * pela API custaria uma troca de endereço e de volta a cada teste, e o que
 * estaria sendo montado ficaria escondido atrás de duas chamadas.
 */
const desverificar = () => getDb()('users').where({ id: donaId }).update({ email_verified_at: null });

/** Cunha uma prova nova para a `dona` e devolve o bilhete que chegou. */
async function bilheteDeVerificacao() {
  await entrar();
  await desverificar();
  recebidas.length = 0;
  const pedido = await naCasa('/api/auth/email/verify', {
    method: 'POST', headers: bearer(donaToken)
  });
  assert.equal(pedido.status, 200, JSON.stringify(pedido.body));
  return bilheteDaMensagem('/verify-email');
}

/** Deixa `dona` com o endereço provado, que é o pré-requisito de tudo aqui. */
async function verificarEnderecoDaDona() {
  const confirmado = await naCasa('/api/auth/email/verify/confirm', {
    method: 'POST', body: { token: await bilheteDeVerificacao() }
  });
  assert.equal(confirmado.status, 200, JSON.stringify(confirmado.body));
}

/** Pede a redefinição para `dona` e devolve o bilhete que chegou. */
async function pedirRedefinicao(identifier = 'dona') {
  recebidas.length = 0;
  const { status, body } = await naCasa('/api/auth/password-reset', {
    method: 'POST', body: { identifier }
  });
  assert.equal(status, 200, JSON.stringify(body));
  return bilheteDaMensagem('/reset-password');
}

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();

  ({ panelUrl } = await startTestServers());
  const db = getDb();

  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  const setup = await naCasa('/api/auth/setup', {
    method: 'POST',
    body: { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donaToken = setup.body.data.token;
  donaId = setup.body.data.user.id;

  // Alguém que trabalha SÓ no beta, com o endereço já provado. É a fixture da
  // prova de que o painel da casa não manda mensagem para quem não é daqui.
  const bcrypt = (await import('bcryptjs')).default;
  soDoBetaId = await runInTenant(beta, () => User.create({
    username: 'so-do-beta',
    email: 'so-do-beta@exemplo.test',
    password: bcrypt.hashSync('senha-do-beta-1', 10),
    role: 'admin'
  }));
  await runInTenant(beta, () => TenantUser.create({ tenantId: beta, userId: soDoBetaId, role: 'admin' }));
  await User.markEmailVerified(soDoBetaId, 'so-do-beta@exemplo.test');
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((resolve) => smtp.close(resolve));
});

describe('provar o endereço', () => {
  it('um endereço recém-cadastrado nasce NÃO provado', async () => {
    const { status, body } = await naCasa('/api/auth/user', { headers: bearer(donaToken) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.email, 'dona@exemplo.test');
    // Cadastrar prova que se controla a conta, não o endereço. A instalação
    // escolheu este endereço e ninguém abriu nada nele.
    assert.equal(body.data.emailVerified, false);
  });

  it('o login diz a mesma coisa que `/api/auth/user` sobre o endereço', async () => {
    // As duas respostas alimentam a MESMA tela: a do login logo depois de
    // entrar, a outra depois de um F5. Se divergissem, o aviso de endereço não
    // confirmado apareceria e sumiria conforme a página fosse recarregada.
    await entrar();
    const entrada = await naCasa('/api/auth/login', {
      method: 'POST', body: { username: 'dona', password: senhaDaDona }
    });
    const relido = await naCasa('/api/auth/user', {
      headers: bearer(entrada.body.data.token)
    });
    assert.equal(entrada.body.data.user.email, relido.body.data.email);
    assert.equal(entrada.body.data.user.emailVerified, relido.body.data.emailVerified);

    // E acompanha a verdade: depois de provar, as duas viram `true`.
    await verificarEnderecoDaDona();
    const depois = await naCasa('/api/auth/login', {
      method: 'POST', body: { username: 'dona', password: senhaDaDona }
    });
    assert.equal(depois.body.data.user.emailVerified, true);
  });

  it('a mensagem leva o link, e o banco guarda só o hash dele', async () => {
    const bilhete = await bilheteDeVerificacao();
    assert.equal(recebidas.length, 1);
    const linha = await getDb()('auth_tickets')
      .where({ token_hash: AuthTicket.hash(bilhete) }).first();
    assert.ok(linha, 'o bilhete tem que existir na tabela, pelo hash');
    assert.equal(linha.purpose, 'email_verification');
    assert.equal(Number(linha.user_id), donaId);
    assert.equal(Number(linha.tenant_id), alfa);
    assert.equal(linha.email, 'dona@exemplo.test');

    // E o valor em claro não está em lugar nenhum da tabela.
    const emClaro = await getDb()('auth_tickets').where({ token_hash: bilhete }).first();
    assert.equal(emClaro, undefined);
  });

  it('o link carimba o endereço, e serve uma vez só', async () => {
    const bilhete = await bilheteDeVerificacao();

    const primeira = await naCasa('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilhete }
    });
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));

    const agora = await naCasa('/api/auth/user', { headers: bearer(donaToken) });
    assert.equal(agora.body.data.emailVerified, true);

    const segunda = await naCasa('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilhete }
    });
    assert.equal(segunda.status, 404, 'um bilhete gasto não pode ser gasto de novo');
  });

  it('um link cunhado na casa não vale no painel do vizinho', async () => {
    const bilhete = await bilheteDeVerificacao();

    const noVizinho = await noBeta('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilhete }
    });
    assert.equal(noVizinho.status, 404, 'o host tem que mandar');

    // E a tentativa pela porta errada não gastou o bilhete: quem o recebeu
    // continua podendo usá-lo onde ele vale.
    const naPorta = await naCasa('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilhete }
    });
    assert.equal(naPorta.status, 200, JSON.stringify(naPorta.body));
  });

  it('trocar de endereço desfaz a prova e manda outra', async () => {
    await verificarEnderecoDaDona();
    recebidas.length = 0;

    const troca = await naCasa('/api/auth/email', {
      method: 'POST',
      headers: bearer(donaToken),
      body: { currentPassword: 'senha-da-dona-1', email: 'dona-nova@exemplo.test' }
    });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    assert.equal(troca.body.data.verified, false);
    assert.equal(troca.body.data.verificationSent, true);

    const agora = await naCasa('/api/auth/user', { headers: bearer(donaToken) });
    assert.equal(agora.body.data.email, 'dona-nova@exemplo.test');
    assert.equal(agora.body.data.emailVerified, false, 'endereço novo é endereço não provado');

    // E a prova nova foi para o endereço NOVO, não para o antigo.
    assert.match(ultimaMensagem(), /dona-nova@exemplo\.test/);

    // Volta ao endereço de sempre para as provas seguintes.
    const volta = await naCasa('/api/auth/email', {
      method: 'POST',
      headers: bearer(donaToken),
      body: { currentPassword: 'senha-da-dona-1', email: 'dona@exemplo.test' }
    });
    assert.equal(volta.status, 200, JSON.stringify(volta.body));
  });

  it('o carimbo cai no endereço que o bilhete nomeia, e em nenhum outro', async () => {
    // Segunda linha de defesa, e é por isso que este teste mexe no banco: pelo
    // caminho normal o bilhete velho já morreu antes de chegar aqui, porque
    // trocar de endereço cunha um bilhete novo e cunhar invalida os abertos. A
    // condição em `markEmailVerified` existe para o dia em que um endereço
    // mudar por um caminho que NÃO passe por lá — uma rota nova, uma correção
    // feita à mão — e o que este teste monta é exatamente esse dia.
    const bilhete = await bilheteDeVerificacao();
    await getDb()('users').where({ id: donaId }).update({ email: 'dona-por-fora@exemplo.test' });

    const tentativa = await naCasa('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilhete }
    });
    assert.equal(tentativa.status, 404, 'o bilhete nomeia um endereço que não é mais o da conta');

    const linha = await getDb()('users').where({ id: donaId }).first();
    assert.equal(linha.email_verified_at, null, 'e nada foi carimbado');

    await getDb()('users').where({ id: donaId }).update({ email: 'dona@exemplo.test' });
  });

  it('um link antigo não carimba um endereço novo', async () => {
    const bilheteDoAntigo = await bilheteDeVerificacao();

    await naCasa('/api/auth/email', {
      method: 'POST',
      headers: bearer(donaToken),
      body: { currentPassword: 'senha-da-dona-1', email: 'dona-outra@exemplo.test' }
    });

    const tentativa = await naCasa('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilheteDoAntigo }
    });
    assert.equal(tentativa.status, 404, 'o bilhete nomeia um endereço que não é mais o da conta');

    const agora = await naCasa('/api/auth/user', { headers: bearer(donaToken) });
    assert.equal(agora.body.data.emailVerified, false);

    await naCasa('/api/auth/email', {
      method: 'POST',
      headers: bearer(donaToken),
      body: { currentPassword: 'senha-da-dona-1', email: 'dona@exemplo.test' }
    });
  });
});

describe('pedir a redefinição', () => {
  it('responde a MESMA coisa para conta que existe e para conta que não existe', async () => {
    await verificarEnderecoDaDona();

    recebidas.length = 0;
    const existe = await naCasa('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'dona' }
    });
    const enviadasDepoisDaReal = recebidas.length;

    recebidas.length = 0;
    const naoExiste = await naCasa('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'ninguem-com-esse-nome' }
    });

    assert.equal(existe.status, 200);
    assert.equal(naoExiste.status, naoExiste.status);
    assert.equal(naoExiste.status, 200);
    // Byte a byte: é a resposta inteira que não pode variar, não só o código.
    assert.deepEqual(naoExiste.body, existe.body);
    assert.equal(enviadasDepoisDaReal, 1, 'a conta real recebe');
    assert.equal(recebidas.length, 0, 'a inexistente não gera mensagem nenhuma');
  });

  it('não manda nada para endereço que ninguém provou', async () => {
    await desverificar();
    recebidas.length = 0;

    const { status, body } = await naCasa('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'dona' }
    });
    assert.equal(status, 200);
    assert.ok(body.success, 'a resposta continua sendo a de sempre');
    assert.equal(recebidas.length, 0, 'endereço não provado não recebe senha nova');

    await verificarEnderecoDaDona();
  });

  it('não manda para quem não trabalha neste provedor', async () => {
    recebidas.length = 0;
    // `so-do-beta` existe, tem endereço e o endereço é provado — só não é
    // gente desta casa. O link apontaria para este painel, que não é o dela.
    const { status } = await naCasa('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'so-do-beta@exemplo.test' }
    });
    assert.equal(status, 200);
    assert.equal(recebidas.length, 0);

    // E no painel dela, recebe.
    const noDela = await noBeta('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'so-do-beta@exemplo.test' }
    });
    assert.equal(noDela.status, 200);
    assert.equal(recebidas.length, 1);
    assert.match(ultimaMensagem(), /beta\.painel\.test\/reset-password/);
  });

  it('um pedido novo mata o bilhete do pedido anterior', async () => {
    const primeiro = await pedirRedefinicao();
    const segundo = await pedirRedefinicao();
    assert.notEqual(primeiro, segundo);

    const velho = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: primeiro, password: 'nao-vai-valer-1' }
    });
    assert.equal(velho.status, 404, 'o anterior tem que estar queimado');

    const novo = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: segundo, password: 'senha-da-dona-1' }
    });
    assert.equal(novo.status, 200, JSON.stringify(novo.body));
    senhaDaDona = 'senha-da-dona-1';
  });
});

describe('gastar o bilhete', () => {
  it('troca a senha e derruba as sessões que já existiam', async () => {
    await verificarEnderecoDaDona();
    await entrar();
    const tokenAntigo = donaToken;
    assert.equal((await naCasa('/api/auth/user', { headers: bearer(tokenAntigo) })).status, 200);

    const anterior = senhaDaDona;
    const bilhete = await pedirRedefinicao();
    const { status, body } = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-nova-da-dona-1' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    // Não emite sessão: quem redefiniu entra com a senha nova, e é ali que se
    // descobre que ela foi digitada errada.
    assert.equal(body.data?.token, undefined);
    senhaDaDona = 'senha-nova-da-dona-1';

    const velha = await naCasa('/api/auth/login', {
      method: 'POST', body: { username: 'dona', password: anterior }
    });
    assert.equal(velha.status, 401, 'a senha antiga tem que morrer');

    await entrar();

    // E a sessão de antes morreu junto: se a redefinição foi de quem invadiu,
    // ela derruba o invasor. 403 e não 401 porque o token foi APRESENTADO e é
    // bem formado — o que não vale mais é a versão dele.
    const comTokenAntigo = await naCasa('/api/auth/user', { headers: bearer(tokenAntigo) });
    assert.equal(comTokenAntigo.status, 403);
    assert.equal(comTokenAntigo.body.code, 'invalid_token');
  });

  it('serve uma vez só', async () => {
    await verificarEnderecoDaDona();
    const bilhete = await pedirRedefinicao();
    const primeira = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-da-dona-2' }
    });
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    senhaDaDona = 'senha-da-dona-2';

    const segunda = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'outra-senha-qualquer-1' }
    });
    assert.equal(segunda.status, 404);

    // A segunda tentativa não pode ter trocado nada: a senha corrente ainda é a
    // que a primeira escreveu.
    await entrar();
  });

  it('um bilhete da casa não vale no painel do vizinho', async () => {
    await verificarEnderecoDaDona();
    const bilhete = await pedirRedefinicao();
    const noVizinho = await noBeta('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-pelo-host-errado-1' }
    });
    assert.equal(noVizinho.status, 404, 'o host tem que mandar');

    // E continua valendo no host certo: o que falhou foi a porta, não o bilhete.
    const naPorta = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-da-dona-3' }
    });
    assert.equal(naPorta.status, 200, JSON.stringify(naPorta.body));
    senhaDaDona = 'senha-da-dona-3';
    await entrar();
  });

  it('morre se o endereço da conta mudar depois de ele sair', async () => {
    await verificarEnderecoDaDona();
    const bilhete = await pedirRedefinicao();

    await entrar();
    const troca = await naCasa('/api/auth/email', {
      method: 'POST',
      headers: bearer(donaToken),
      body: { currentPassword: senhaDaDona, email: 'dona-mudou@exemplo.test' }
    });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));

    const tentativa = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-pela-caixa-antiga-1' }
    });
    assert.equal(tentativa.status, 404,
      'o link mandado para a caixa antiga tem que morrer com a troca de endereço');

    // E a senha não pode ter mudado: `entrar()` usa a corrente e tem que passar.
    await entrar();

    const volta = await naCasa('/api/auth/email', {
      method: 'POST',
      headers: bearer(donaToken),
      body: { currentPassword: senhaDaDona, email: 'dona@exemplo.test' }
    });
    assert.equal(volta.status, 200, JSON.stringify(volta.body));
  });

  it('uma senha curta é recusada e NÃO gasta o bilhete', async () => {
    await verificarEnderecoDaDona();
    const bilhete = await pedirRedefinicao();

    const curta = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'curta' }
    });
    assert.equal(curta.status, 400);

    // Quem digitou uma senha curta não perdeu o link: a conferência de tamanho
    // vem ANTES do resgate, de propósito.
    const outra = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-da-dona-4' }
    });
    assert.equal(outra.status, 200, JSON.stringify(outra.body));
    senhaDaDona = 'senha-da-dona-4';
    await entrar();
  });

  it('um bilhete de prova de endereço não troca senha nenhuma', async () => {
    const deVerificacao = await bilheteDeVerificacao();

    const tentativa = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: deVerificacao, password: 'senha-pelo-bilhete-errado-1' }
    });
    assert.equal(tentativa.status, 404, 'o uso do bilhete faz parte de o que ele é');

    // A senha corrente continua entrando, então nada foi trocado.
    await entrar();
  });
});

describe('a trilha do provedor', () => {
  it('registra o pedido e a conclusão, com a conta como sujeito', async () => {
    await verificarEnderecoDaDona();
    const antes = await runInTenant(alfa, () => getDb()('audit_log')
      .whereIn('action', ['password_reset.requested', 'password_reset.completed'])
      .count({ n: '*' }).first());

    const bilhete = await pedirRedefinicao();
    const concluido = await naCasa('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-da-dona-5' }
    });
    assert.equal(concluido.status, 200, JSON.stringify(concluido.body));
    senhaDaDona = 'senha-da-dona-5';

    const linhas = await runInTenant(alfa, () => getDb()('audit_log')
      .whereIn('action', ['password_reset.requested', 'password_reset.completed'])
      .orderBy('id', 'asc'));
    assert.equal(linhas.length, Number(antes.n) + 2, 'as duas linhas, não uma');

    const duas = linhas.slice(-2);
    assert.equal(duas[0].action, 'password_reset.requested');
    assert.equal(duas[1].action, 'password_reset.completed');
    for (const linha of duas) {
      assert.equal(Number(linha.tenant_id), alfa, 'a trilha é do provedor do host');
      assert.equal(Number(linha.subject_id), donaId);
      assert.equal(linha.actor_username, 'dona');
      // Nada de segredo na trilha: nem a senha nova, nem o bilhete em claro.
      assert.doesNotMatch(String(linha.detail ?? ''), /senha-da-dona-5|[0-9a-f]{64}/);
    }

    await entrar();
  });
});

describe('o balde do pedido', () => {
  it('morde no sexto pedido do mesmo host', async () => {
    recebidas.length = 0;

    // Cinco passam — e não precisam ser de conta que existe: o balde conta
    // pedidos, que é justamente o que protege a caixa de entrada alheia e o que
    // impede alguém de medir o tempo de resposta dez mil vezes.
    for (let i = 0; i < 5; i += 1) {
      const { status } = await naCasa('/api/auth/password-reset', {
        method: 'POST', body: { identifier: `sondagem-${i}` }
      });
      assert.equal(status, 200, `o pedido ${i + 1} deveria passar`);
    }

    const sexto = await naCasa('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'sondagem-6' }
    });
    assert.equal(sexto.status, 429);
    assert.equal(sexto.body.code, 'rate_limited');

    // E o balde é POR provedor: o vizinho não é derrubado junto.
    const noVizinho = await noBeta('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'sondagem-6' }
    });
    assert.equal(noVizinho.status, 200);

  });
});
