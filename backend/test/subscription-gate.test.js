import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A porta da assinatura: o que cada estado deixa passar, provado por HTTP.
 *
 * SaaS, porque a porta só é montada nessa edição — e é a edição em que um
 * provedor pode estar devendo. O que se prova aqui é o contrato de
 * `SubscriptionService.decide` visto de fora: `trial` e `active` passam,
 * `past_due` passa só para ler, `suspended`/`canceled` respondem 402 — e as
 * três portas que ficam de fora (login, o nome do provedor, o console)
 * continuam abertas num provedor bloqueado, porque são o que permite sair do
 * bloqueio.
 *
 * Os estados são escritos direto na linha da assinatura do provedor da
 * instalação e o cache do gate é invalidado à mão: o que está sob teste é a
 * leitura, não o console que muda o estado (esse tem a própria suíte).
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, insertReturningId, runInTenant,
  startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: SubscriptionService, GATE_CODES } = await import('../src/services/subscriptionService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

let panelUrl;
let portalUrl;
let alfa;
let ownerToken;
let ownerId;
const assinante = { customerId: 'CSG-PORTAL1-330011', password: null };

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: ownerId }).first())) {
    await getDb()('platform_admins').insert({ user_id: ownerId });
  }

  // Um assinante de verdade: sem ele, o portal só podia ser provado por uma
  // tentativa de login anônima — que é justamente o que não pode mais revelar
  // nada.
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  assinante.password = password;
  await insertReturningId('customer_accounts', {
    customer_id: assinante.customerId,
    device_id: 'ont-do-portal',
    identity_hash: 'hash-do-portal'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'assinante-do-portao',
    active: true,
    ...record
  });
});

/** Uma sessão do portal, em cookie, tirada com o provedor em dia. */
async function sessaoDoPortal() {
  await setState({ status: 'active' });
  const resposta = await call(`${portalUrl}/api/customer/login`, {
    method: 'POST',
    body: { customerId: assinante.customerId, password: assinante.password }
  });
  const cookie = resposta.response.headers.getSetCookie()
    .find((c) => c.startsWith('skygp_portal_session='));
  return cookie ? cookie.split(';')[0] : null;
}

after(async () => {
  await stopTestServers();
});

/** Põe o provedor da instalação no estado pedido, e faz o gate ler de novo. */
async function setState(patch) {
  await Subscription.upsertForTenant(alfa, {
    status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

afterEach(async () => {
  await setState({ status: 'active' });
});

const read = () => call(`${panelUrl}/api/users`, { headers: authHeaders(ownerToken) });
/**
 * A escrita guardada pela porta. O nome é parâmetro e não constante porque um
 * caso que ESPERA 402 não limpa nada atrás de si: no dia em que ele passar a
 * receber 201 — que é exatamente o dia em que a porta quebrou —, um nome fixo
 * faria os casos seguintes falharem por colisão de usuário, e o relatório
 * apontaria para os inocentes. Foi o que uma reversão mostrou.
 */
const write = (username = 'alguem') => call(`${panelUrl}/api/users`, {
  method: 'POST',
  headers: authHeaders(ownerToken),
  body: {
    username,
    password: `senha-de-${username}-1`,
    role: 'viewer',
    email: `${username}@exemplo.test`
  }
});

/** Apaga o operador que um caso criou, para o próximo achar o banco como deixou. */
async function apagarOperador(resposta) {
  const id = resposta?.body?.data?.user?.id;
  if (!id) return;
  await getDb()('tenant_users').where({ user_id: id }).del();
  await getDb()('users').where({ id }).del();
}

describe('the states that pass', () => {
  it('active: reads and writes', async () => {
    await setState({ status: 'active' });
    assert.equal((await read()).status, 200);
    const created = await write('ativo-escreve');
    assert.equal(created.status, 201);
    await apagarOperador(created);
  });

  it('trial, while it lasts: reads and writes', async () => {
    await setState({ status: 'trial', trial_ends_at: new Date(Date.now() + 3 * DAY) });
    assert.equal((await read()).status, 200);
    const attempt = await write('teste-corrente');
    assert.notEqual(attempt.status, 402);
    await apagarOperador(attempt);
  });
});

describe('past due: look, but do not touch', () => {
  it('lets a read through and refuses a write with the code the screen expects', async () => {
    await setState({ status: 'past_due' });
    assert.equal((await read()).status, 200);
    const refused = await write();
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, GATE_CODES.PAST_DUE);
    // A placa que o muro mostra: o estado vem junto, para a tela não ter que
    // perguntar de novo a uma rota que talvez também responda 402.
    assert.equal(refused.body.subscription.status, 'past_due');
    assert.ok(refused.body.message);
  });

  it('a trial whose date passed is past due from that second, without any job running', async () => {
    await setState({ status: 'trial', trial_ends_at: new Date(Date.now() - 1000) });
    assert.equal((await read()).status, 200);
    const refused = await write();
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, GATE_CODES.TRIAL_EXPIRED);
    assert.equal(refused.body.subscription.status, 'past_due');
    assert.equal(refused.body.subscription.storedStatus, 'trial');
  });

  /**
   * O irmão do de cima, e o que ele guarda é receita e não prazo: até esta
   * fatia, `renews_at` era escrito pelo pagamento, mostrado em quatro telas e
   * lido por decisão nenhuma. Quem pagou uma vez ficava `active` para sempre,
   * em silêncio, com a data certa na tela.
   */
  it('um período pago que venceu é past_due, pela mesma mecânica do teste', async () => {
    await setState({ status: 'active', renews_at: new Date(Date.now() - 1000) });
    assert.equal((await read()).status, 200);
    const refused = await write('periodo-vencido');
    assert.equal(refused.status, 402);
    // PAST_DUE e não TRIAL_EXPIRED: quem venceu aqui pagou e parou de pagar,
    // e a tela de bloqueio escolhe a frase por este código.
    assert.equal(refused.body.code, GATE_CODES.PAST_DUE);
    assert.equal(refused.body.subscription.status, 'past_due');
    assert.equal(refused.body.subscription.storedStatus, 'active');
  });

  it('e enquanto ele não venceu, escreve normalmente', async () => {
    await setState({ status: 'active', renews_at: new Date(Date.now() + 3 * DAY) });
    assert.equal((await read()).status, 200);
    const created = await write('dentro-do-periodo');
    assert.equal(created.status, 201);
    await apagarOperador(created);
  });

  /**
   * A linha que separa consertar uma perda de receita de derrubar todo mundo.
   *
   * `renews_at` nulo é assinatura que nunca foi posta num ciclo — o provedor
   * que o console pôs num plano sem registrar pagamento, a instalação
   * self-hosted, e todo provedor que já está no banco. Se nulo vencesse, o
   * primeiro deploy desta mudança seria uma parada geral.
   */
  it('mas uma assinatura sem data de renovação não vence nunca', async () => {
    await setState({ status: 'active', renews_at: null });
    assert.equal((await read()).status, 200);
    const created = await write('sem-ciclo');
    assert.equal(created.status, 201);
    await apagarOperador(created);
  });

  /**
   * Vencer não reescreve a coluna, e isso importa: o caminho de volta é o
   * pagamento, que estende `renews_at` a partir de hoje e devolve `active`. Um
   * job que gravasse `past_due` teria que ter um segundo caminho para desfazer.
   */
  it('e vencer não muda o que está gravado — só o que vale', async () => {
    await setState({ status: 'active', renews_at: new Date(Date.now() - 1000) });
    await write('nao-deve-nascer');
    const gravado = await getDb()('subscriptions').where({ tenant_id: alfa }).first();
    assert.equal(gravado.status, 'active');
  });

  it('lets an inbound webhook through: the ERP event is not the operator writing', async () => {
    await setState({ status: 'past_due' });
    const delivery = await call(`${panelUrl}/api/sgp/events/webhook`, { method: 'POST', body: {} });
    // O que o webhook responde com a integração desligada não importa aqui;
    // o que importa é que a resposta não veio da porta da assinatura.
    assert.notEqual(delivery.status, 402);
  });

  it('keeps the subscriber portal fully up: the subscriber is not the one who owes', async () => {
    await setState({ status: 'past_due' });
    const attempt = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'NAO-EXISTE', password: 'ABCDEF' }
    });
    assert.notEqual(attempt.status, 402);
  });
});

describe('suspended and canceled: a wall', () => {
  for (const [status, code] of [['suspended', GATE_CODES.SUSPENDED], ['canceled', GATE_CODES.CANCELED]]) {
    it(`${status}: refuses even a read, with its own code`, async () => {
      await setState({ status });
      const refused = await read();
      assert.equal(refused.status, 402);
      assert.equal(refused.body.code, code);
    });

    it(`${status}: takes the subscriber portal down too`, async () => {
      // Provado com uma sessão de verdade, e não por uma tentativa de login
      // anônima. O login em si não pode mais responder diferente conforme a
      // fatura: o portal é a superfície mais pública que existe aqui, e um 402
      // ali diria a qualquer assinante — e a qualquer estranho — que o ISP dele
      // parou de pagar. O muro continua de pé; só fica um passo adiante.
      const cookie = await sessaoDoPortal();
      assert.ok(cookie, 'o assinante precisa conseguir entrar para o caso valer');
      await setState({ status });
      const bloqueado = await call(`${portalUrl}/api/customer/session`, {
        headers: { Cookie: cookie }
      });
      assert.equal(bloqueado.status, 402);
    });

    it(`${status}: e o login do portal não denuncia a fatura do provedor`, async () => {
      await setState({ status: 'active' });
      const emDia = await call(`${portalUrl}/api/customer/login`, {
        method: 'POST', body: { customerId: 'NAO-EXISTE', password: 'ABCDEF' }
      });
      await setState({ status });
      const bloqueado = await call(`${portalUrl}/api/customer/login`, {
        method: 'POST', body: { customerId: 'NAO-EXISTE', password: 'ABCDEF' }
      });
      assert.equal(
        bloqueado.status, emDia.status,
        `em dia respondeu ${emDia.status} e ${status} respondeu ${bloqueado.status}`
      );
    });
  }

  it('a provider with no subscription at all is refused, not let through', async () => {
    const saved = await Subscription.forTenant(alfa);
    await getDb()('subscriptions').where({ tenant_id: alfa }).del();
    await SubscriptionService.invalidate(alfa);
    try {
      const refused = await read();
      assert.equal(refused.status, 402);
      assert.equal(refused.body.code, GATE_CODES.MISSING);
    } finally {
      const { id, ...row } = saved;
      await getDb()('subscriptions').insert(row);
      await SubscriptionService.invalidate(alfa);
    }
  });
});

describe('what stays open on a blocked provider', () => {
  it('signing in, the provider name, the subscription itself and the console', async () => {
    await setState({ status: 'suspended' });

    const signIn = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
    });
    assert.equal(signIn.status, 200, 'entrar é como se vê o aviso');

    const name = await call(`${panelUrl}/api/tenant/public`);
    assert.equal(name.status, 200);

    const mine = await call(`${panelUrl}/api/tenant/subscription`, { headers: authHeaders(ownerToken) });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.subscription.status, 'suspended');

    const console_ = await call(`${panelUrl}/api/platform/tenants`, { headers: authHeaders(ownerToken) });
    assert.equal(console_.status, 200, 'o console é como se sai do bloqueio');
    const row = console_.body.data.tenants.find((t) => Number(t.id) === Number(alfa));
    assert.equal(row.subscription.status, 'suspended');
  });
});

describe('the cache', () => {
  it('reads the change once the console has invalidated it, and not before', async () => {
    await setState({ status: 'active' });
    assert.equal((await read()).status, 200);
    // Escrito na linha sem invalidar: o gate continua confiando na leitura
    // anterior — é o custo aceito para não ler a assinatura a cada request.
    await Subscription.upsertForTenant(alfa, { status: 'suspended' });
    assert.equal((await read()).status, 200);
    await SubscriptionService.invalidate(alfa);
    assert.equal((await read()).status, 402);
  });

  it('every change the service makes invalidates on its own', async () => {
    await setState({ status: 'active' });
    assert.equal((await read()).status, 200);
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'suspended' }));
    assert.equal((await read()).status, 402);
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'active' }));
    assert.equal((await read()).status, 200);
  });
});

/**
 * A ordem 401-antes-de-402, que é o que separa "bloqueado" de "publicado".
 *
 * A porta responde antes da autenticação, o que é deliberado — o comentário
 * dela diz que a tela de bloqueio precisa aparecer também para quem ainda nem
 * entrou. O efeito colateral é que a resposta a um request SEM TOKEN passa a
 * variar com a fatura do provedor: 401 num em dia, 402 num inadimplente. Isso
 * é exatamente o que `tenantController.getPublicProfile` proíbe, com estas
 * palavras: não distinguir "não existe" de "existe e está suspenso", «um fato
 * sobre o negócio de outra pessoa que estaríamos publicando».
 *
 * Um estranho que alcance o host — e o host é público — varre e descobre quais
 * ISPs estão atrasados. Com o corpo do 402 ainda por cima, descobre o plano.
 */
describe('a fatura de um provedor não é fato público', () => {
  afterEach(async () => {
    await setState({ status: 'active' });
  });

  for (const status of ['suspended', 'canceled']) {
    it(`sem token, um provedor ${status} responde igual a um em dia`, async () => {
      await setState({ status: 'active' });
      const emDia = await call(`${panelUrl}/api/devices`);
      await setState({ status });
      const bloqueado = await call(`${panelUrl}/api/devices`);
      assert.equal(emDia.status, 401, 'o caso de controle precisa ser 401');
      assert.equal(
        bloqueado.status, emDia.status,
        `em dia respondeu ${emDia.status} e ${status} respondeu ${bloqueado.status}`
      );
    });
  }

  it('e um token qualquer não revela mais do que a ausência dele', async () => {
    // Um sondador não precisa de token válido, só de algo com formato de
    // token — então a resposta a um token inventado também não pode variar.
    const forjado = { Authorization: 'Bearer nao-e-um-token' };
    await setState({ status: 'active' });
    const emDia = await call(`${panelUrl}/api/devices`, { headers: forjado });
    await setState({ status: 'suspended' });
    const bloqueado = await call(`${panelUrl}/api/devices`, { headers: forjado });
    assert.equal(
      bloqueado.status, emDia.status,
      `em dia respondeu ${emDia.status} e suspenso ${bloqueado.status}`
    );
  });

  it('nem o corpo entrega o plano a quem não entrou', async () => {
    // O par que dá sentido aos de cima: mesmo que o código de status voltasse a
    // divergir um dia, o CORPO não pode carregar a assinatura para um anônimo.
    await setState({ status: 'suspended' });
    const { body } = await call(`${panelUrl}/api/devices`);
    assert.equal(body?.subscription, undefined, JSON.stringify(body));
  });

  it('mas quem ENTROU vê o bloqueio, que é como se sai dele', async () => {
    // A metade que a correção não pode quebrar: o operador do provedor
    // bloqueado precisa ver a placa do muro, com o código que a tela lê.
    await setState({ status: 'suspended' });
    const { status, body } = await call(`${panelUrl}/api/devices`, {
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 402);
    assert.equal(body.code, GATE_CODES.SUSPENDED);
  });

  it('e o login continua aberto num provedor bloqueado', async () => {
    await setState({ status: 'suspended' });
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'owner', password: 'owner-senha-1' }
    });
    assert.equal(status, 200, 'entrar é como o operador vê o aviso');
  });
});
