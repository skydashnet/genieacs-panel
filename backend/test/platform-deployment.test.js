import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Os fatos do deploy, no console — e a única regra que esta rota tem: ela diz
 * o que está CONFIGURADO, nunca o valor.
 *
 * A tela existe porque hoje nada disso se descobre sem ssh. Um convite que não
 * chega, um coletor de métricas que recebe 401, um webhook de pagamento que
 * responde 404: os três sintomas não se parecem com "falta uma variável de
 * ambiente", e os três são exatamente isso.
 *
 * O caso que dá nome ao arquivo é o último: as variáveis abaixo entram no
 * processo com valores-sentinela, e o corpo inteiro da resposta é varrido atrás
 * deles. É a forma de afirmar "nenhum segredo atravessa" que não depende de
 * alguém lembrar de conferir campo por campo — um campo novo acrescentado
 * amanhã cai no mesmo laço.
 */
process.env.EDITION = 'saas';

/** Valores-sentinela, escolhidos para não colidirem com nada do corpo. */
const SEGREDOS = {
  METRICS_TOKEN: 'sentinela-de-metricas-0123456789abcdef',
  BILLING_WEBHOOK_TOKEN: 'sentinela-do-webhook-de-cobranca',
  ASAAS_API_KEY: 'sentinela-da-chave-da-asaas',
  SMTP_URL: 'smtps://sentinela-do-usuario:sentinela-da-senha@smtp.exemplo.test:465',
  MAIL_FROM: 'TR69 Controle <nao-responda@exemplo.test>'
};
Object.assign(process.env, SEGREDOS);

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');

let panelUrl;
let token;
let tokenSemChave;

before(async () => {
  ({ panelUrl } = await startTestServers());
  // O transporte é resolvido uma vez e guardado; as variáveis acima entraram
  // depois de algum outro arquivo já o ter resolvido como "nenhum".
  resetMailTransport();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;

  // Um operador comum do mesmo provedor: administrador do ISP dele, e de
  // plataforma coisa nenhuma.
  const criado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      username: 'so-do-provedor', password: 'senha-do-operador-1',
      role: 'admin', email: 'so-do-provedor@exemplo.test'
    }
  });
  assert.equal(criado.status, 201);
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'so-do-provedor', password: 'senha-do-operador-1' }
  });
  tokenSemChave = entrou.body.data.token;
});

after(async () => {
  await stopTestServers();
  for (const chave of Object.keys(SEGREDOS)) delete process.env[chave];
  resetMailTransport();
});

const ler = (comToken = token) =>
  call(`${panelUrl}/api/platform/deployment`, { headers: authHeaders(comToken) });

describe('os fatos do deploy', () => {
  it('diz a edição, o dialeto do banco e de onde a conexão veio', async () => {
    const resposta = await ler();
    assert.equal(resposta.status, 200);
    const { edition, database } = resposta.body.data;
    assert.equal(edition, 'saas');
    assert.ok(['better-sqlite3', 'mysql2', 'pg'].includes(database.client), database.client);
    assert.equal(database.source, process.env.DATABASE_URL ? 'env' : 'file');
  });

  it('e os endereços em que atende', async () => {
    const { addressing } = (await ler()).body.data;
    // Num deploy de host único os três são nulos, e `null` é resposta: é o que
    // diz "aqui não há subdomínio por provedor" a quem procura por que um
    // endereço não resolve.
    assert.ok('panelBaseDomain' in addressing);
    assert.ok('portalBaseDomain' in addressing);
    assert.ok('publicBaseUrl' in addressing);
    assert.equal(addressing.tenantSubdomains, false);
  });

  it('e o que está configurado, como sim ou não', async () => {
    const { configured, database } = (await ler()).body.data;
    for (const chave of ['mail', 'metricsToken', 'billingWebhookToken', 'billingGateway', 'rls']) {
      assert.equal(typeof configured[chave], 'boolean', `${chave} tinha que ser booleano`);
    }
    // As quatro primeiras entraram com valor no ambiente deste arquivo, então
    // aqui elas provam que a leitura chega até a variável — e não que o campo
    // existe com `false` dentro.
    assert.equal(configured.mail, true);
    assert.equal(configured.metricsToken, true);
    assert.equal(configured.billingWebhookToken, true);
    assert.equal(configured.billingGateway, true);
    /**
     * O RLS é o único que depende de DUAS coisas, e é por isso que ele está
     * aqui: `RLS_ENABLED=true` num deploy em SQLite não liga nada, porque a
     * política é do Postgres. A tela tem que dizer o que VALE, não o que foi
     * pedido — e essa diferença é hoje invisível de qualquer lugar.
     */
    const valeRls = process.env.RLS_ENABLED === 'true' && database.client === 'pg';
    assert.equal(configured.rls, valeRls);
  });
});

/**
 * A afirmação que dá nome ao arquivo.
 *
 * Varre o corpo inteiro serializado, e não campo por campo: um campo novo
 * acrescentado amanhã — outra chave de API, outra credencial — cai neste mesmo
 * laço sem ninguém precisar lembrar de acrescentar um caso aqui.
 */
describe('e nenhum segredo atravessa', () => {
  it('o corpo não contém o valor de nenhuma variável sensível', async () => {
    const corpo = JSON.stringify((await ler()).body);

    for (const [nome, valor] of Object.entries(SEGREDOS)) {
      assert.equal(corpo.includes(valor), false, `${nome} vazou inteiro na resposta`);
    }

    // E os pedaços de dentro da URL de SMTP, que é onde um vazamento parcial
    // se esconderia: o corpo poderia trazer só o host, ou só o usuário, sem
    // casar com a string inteira acima.
    for (const pedaco of ['sentinela-do-usuario', 'sentinela-da-senha', 'smtp.exemplo.test']) {
      assert.equal(corpo.includes(pedaco), false, `"${pedaco}" vazou na resposta`);
    }
  });
});

describe('e a rota é do plano de controle', () => {
  it('sem sessão, 401', async () => {
    assert.equal((await call(`${panelUrl}/api/platform/deployment`)).status, 401);
  });

  /**
   * O caso que a guarda existe para pegar: administrador do PRÓPRIO provedor,
   * com sessão válida e boa, e sem a chave do plano de controle.
   *
   * **404 e não 403**, e essa escolha é de `requirePlatformAdmin`, que a
   * explica: um 403 contaria a ele que o plano de controle existe neste deploy
   * e que ele apenas não está nele — que é justamente o fato que não vale
   * confirmar, porque nomeia a forma de conta que vale a pena phishar. Com
   * 404, o token dele não distingue um deploy hospedado de um self-hosted que
   * não tem console nenhum.
   *
   * O caso está aqui e não só na suíte da guarda porque é a rota NOVA que
   * precisa provar que entrou atrás dela — montar uma rota de console fora dos
   * dois guardas é o erro que a lista em `routes/platform.js` existe para
   * evitar, e ele não daria erro nenhum em teste que não olhasse.
   */
  it('e um administrador de provedor não descobre que o console existe', async () => {
    const resposta = await ler(tokenSemChave);
    assert.equal(resposta.status, 404);
    assert.equal(resposta.body?.data?.edition, undefined);
  });

  it('e quem está no cadastro da plataforma entra', async () => {
    const dona = await getDb()('users').where({ username: 'a-dona' }).first('id');
    assert.ok(await getDb()('platform_admins').where({ user_id: dona.id }).first());
    assert.equal((await ler()).status, 200);
  });
});
