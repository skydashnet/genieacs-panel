import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { AsaasBillingProvider } = await import('../src/services/billing/asaasBillingProvider.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');

/**
 * O dinheiro entrando sozinho.
 *
 * Até aqui pagamento era um botão no console — alguém conferindo extrato e
 * marcando à mão. Com dez clientes passa; com cinquenta é uma pessoa por dia, e
 * é uma pessoa que erra.
 *
 * As quatro maneiras de errar um webhook de cobrança, que é o que este arquivo
 * guarda:
 *
 * 1. **Creditar duas vezes.** O gateway reentrega por desenho, e no cartão ele
 *    manda DOIS eventos para o mesmo pagamento. Cada crédito a mais é um mês
 *    dado de graça, e ninguém percebe porque a tela mostra uma data que parece
 *    certa.
 * 2. **Creditar o provedor errado.** Aqui não há host para dizer de quem é: o
 *    provedor sai do corpo, e o corpo vem de fora.
 * 3. **Aceitar sem credencial.** É uma rota pública que mexe em assinatura.
 * 4. **Responder não-2xx para o que não é erro nosso.** O gateway reentrega em
 *    laço para sempre o que não foi aceito.
 */
const TOKEN = 'token-do-gateway-deste-deploy';

let panelUrl;
let alfa;
let beta;

const entregar = (corpo, token = TOKEN) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST',
  headers: token === null ? {} : { 'asaas-access-token': token },
  body: corpo
});

const pagamento = (extra = {}) => ({
  event: 'PAYMENT_RECEIVED',
  payment: { id: 'pay_001', value: 199.9, customer: 'cus_alfa', ...extra }
});

const assinaturaDe = (tenantId) => runInTenant(tenantId, () => Subscription.forTenant(tenantId));

before(async () => {
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN;
  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // O alfa é cliente do gateway; o beta não. É a correlação que o webhook usa
  // quando a cobrança foi emitida lá dentro, à mão.
  await db('tenants').where({ id: alfa })
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa' });
});

after(async () => {
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await stopTestServers();
});

/** Assinatura nova a cada caso: creditar é destrutivo, e o caso seguinte veria o rastro. */
beforeEach(async () => {
  const db = getDb();
  await db('billing_events').del();
  await db('subscriptions').del();
  const plano = await runInTenant(alfa, () => Plan.list()).then((lista) => lista[0]);
  for (const tenantId of [alfa, beta]) {
    await runInTenant(tenantId, () => Subscription.upsertForTenant(tenantId, {
      plan_id: plano.id,
      status: 'past_due',
      renews_at: new Date('2026-01-01T00:00:00Z'),
      trial_ends_at: null
    }));
  }
});

describe('a leitura do corpo, que é o único lugar que depende de um sistema de fora', () => {
  it('lê um pagamento recebido', () => {
    const lido = AsaasBillingProvider.interpretar(pagamento({ externalReference: 'tenant:7' }));
    assert.equal(lido.externalId, 'pay_001');
    assert.equal(lido.amountCents, 19990, 'reais viram centavos inteiros');
    assert.equal(lido.customerRef, 'cus_alfa');
    assert.equal(lido.reference, 'tenant:7');
  });

  /**
   * `19.99 * 100` vale 1998.9999999999998 em binário de ponto flutuante. Um
   * truncamento ali cobraria um centavo a menos de todo mundo, para sempre.
   */
  it('e o centavo não some no ponto flutuante', () => {
    assert.equal(AsaasBillingProvider.interpretar(pagamento({ value: 19.99 })).amountCents, 1999);
    assert.equal(AsaasBillingProvider.interpretar(pagamento({ value: 0.07 })).amountCents, 7);
  });

  /**
   * O que acontece quando um campo muda de nome do outro lado: a leitura
   * devolve nulo, e nulo é "não faço nada". O avesso — creditar por engano —
   * exigiria um campo novo com o nome certo e o sentido errado.
   */
  it('e um corpo que não reconhece não vira crédito nenhum', () => {
    assert.equal(AsaasBillingProvider.interpretar({ event: 'PAYMENT_CREATED', payment: { id: 'p', value: 1 } }), null);
    assert.equal(AsaasBillingProvider.interpretar({ event: 'PAYMENT_RECEIVED' }), null);
    assert.equal(AsaasBillingProvider.interpretar({ event: 'PAYMENT_RECEIVED', payment: { value: 10 } }), null);
    assert.equal(AsaasBillingProvider.interpretar({ event: 'PAYMENT_RECEIVED', payment: { id: 'p' } }), null);
    assert.equal(AsaasBillingProvider.interpretar({ payment: { id: 'p', value: 1 } }), null);
    assert.equal(AsaasBillingProvider.interpretar(null), null);
  });
});

describe('a entrega credita o provedor certo', () => {
  it('pela referência que fomos nós que escrevemos', async () => {
    const res = await entregar(pagamento({ externalReference: `tenant:${beta}` }));
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'recorded');

    const dele = await assinaturaDe(beta);
    assert.equal(dele.status, 'active', 'pagar tira do past_due');
    assert.ok(new Date(dele.renews_at).getTime() > Date.now(), 'e empurra a renovação para frente');

    // E não encostou no vizinho, mesmo sendo ele o dono do `customer` do corpo.
    assert.equal((await assinaturaDe(alfa)).status, 'past_due');
  });

  it('e pelo id do cliente no gateway, para a cobrança emitida lá dentro', async () => {
    const res = await entregar(pagamento());
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'recorded');
    assert.equal((await assinaturaDe(alfa)).status, 'active');
    assert.equal((await assinaturaDe(beta)).status, 'past_due');
  });

  it('e o extrato guarda o nome do gateway e a referência dele', async () => {
    await entregar(pagamento());
    const evento = await getDb()('billing_events').where({ tenant_id: alfa }).first();
    assert.equal(evento.provider, 'asaas');
    assert.equal(evento.external_id, 'pay_001');
    assert.equal(evento.amount_cents, 19990);
    // Ninguém apertou botão nenhum: o console grava quem apertou, aqui não há.
    assert.equal(evento.created_by, null);
  });
});

describe('a mesma referência credita uma vez só', () => {
  /**
   * O caso que o cartão produz sozinho: o gateway manda `PAYMENT_CONFIRMED`
   * quando a operadora aprova e `PAYMENT_RECEIVED` quando o dinheiro cai,
   * trinta dias depois — dois eventos, um pagamento. O que impede o segundo de
   * dar um mês de graça é a chave de idempotência ser o id do PAGAMENTO e não o
   * do evento.
   */
  it('mesmo quando o cartão manda confirmado e depois recebido', async () => {
    const confirmado = await entregar({ ...pagamento(), event: 'PAYMENT_CONFIRMED' });
    assert.equal(confirmado.body.code, 'recorded');
    const depoisDoPrimeiro = await assinaturaDe(alfa);

    const recebido = await entregar(pagamento());
    assert.equal(recebido.status, 200, 'um não-2xx faria o gateway reentregar para sempre');
    assert.equal(recebido.body.code, 'duplicate');

    const depoisDoSegundo = await assinaturaDe(alfa);
    assert.equal(
      new Date(depoisDoSegundo.renews_at).getTime(),
      new Date(depoisDoPrimeiro.renews_at).getTime(),
      'a segunda entrega empurrou a data: é um mês dado de graça'
    );
    const quantos = await getDb()('billing_events').where({ tenant_id: alfa }).count({ n: '*' });
    assert.equal(Number(quantos[0].n), 1);
  });

  /**
   * E a idempotência é POR PROVEDOR, porque o índice único é
   * `(tenant_id, external_id)`. Dois provedores com a mesma referência é o
   * caso que o índice NÃO cobre — aqui ele não aparece porque a atribuição
   * acerta, e este teste é o que garante que ela acerta.
   */
  it('e a referência de um provedor não bloqueia a do outro', async () => {
    await entregar(pagamento());
    const outro = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_001', value: 50, externalReference: `tenant:${beta}` }
    });
    assert.equal(outro.body.code, 'recorded');
    assert.equal((await assinaturaDe(beta)).status, 'active');
  });
});

describe('o que a rota recusa, e como', () => {
  it('credencial errada é 401, e a resposta não diz qual parte falhou', async () => {
    const res = await entregar(pagamento(), 'token-de-quem-tentou');
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'invalid_token');
    assert.equal((await assinaturaDe(alfa)).status, 'past_due');
  });

  it('sem credencial nenhuma, a mesma resposta', async () => {
    const res = await entregar(pagamento(), null);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'invalid_token');
  });

  it('e um deploy que não ligou gateway nenhum responde 404, não aceita', async () => {
    const guardado = process.env.BILLING_WEBHOOK_TOKEN;
    delete process.env.BILLING_WEBHOOK_TOKEN;
    try {
      const res = await entregar(pagamento(), 'qualquer-coisa');
      assert.equal(res.status, 404, 'uma rota de dinheiro aberta por variável esquecida');
      assert.equal((await assinaturaDe(alfa)).status, 'past_due');
    } finally {
      process.env.BILLING_WEBHOOK_TOKEN = guardado;
    }
  });
});

describe('o que a rota ignora, e responde 200 assim mesmo', () => {
  /**
   * Não-2xx fica para falha genuína deste lado, que é o único caso em que
   * reentregar ajuda. Tudo o mais que se escolhe não fazer sai 200, ou o
   * gateway reentrega em laço para sempre.
   */
  it('um evento que não é dinheiro entrando', async () => {
    const res = await entregar({ event: 'PAYMENT_CREATED', payment: { id: 'pay_x', value: 10 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'ignored');
    assert.equal((await assinaturaDe(alfa)).status, 'past_due');
  });

  it('e um pagamento que não resolve provedor nenhum', async () => {
    const res = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_orfao', value: 10, customer: 'cus_de_ninguem' }
    });
    assert.equal(res.status, 200, 'o gateway não é o lugar de guardar este problema');
    assert.equal(res.body.code, 'unattributed');
    assert.equal(await getDb()('billing_events').first(), undefined, 'e nada foi escrito');
  });

  it('nem por referência para um provedor que não existe', async () => {
    const res = await entregar(pagamento({ externalReference: 'tenant:99999', customer: null }));
    assert.equal(res.body.code, 'unattributed');
  });

  /**
   * Suspenso é decisão de gente. Um pagamento que chega depois dela não pode
   * reativar sozinho o que alguém desligou a dedo — e `recordPayment` já não
   * reativa `suspended`, mas o provedor nem chega lá: um provedor não-ativo não
   * resolve, porque creditar uma assinatura que ninguém vai ler é gravar no
   * escuro.
   */
  it('e um provedor suspenso não é creditado por pagamento', async () => {
    const db = getDb();
    await db('tenants').where({ id: alfa }).update({ status: 'suspended' });
    try {
      // Os DOIS caminhos de volta, porque são dois `where` diferentes e um
      // pode ficar para trás do outro: pelo id do cliente no gateway…
      const porCliente = await entregar(pagamento());
      assert.equal(porCliente.status, 200);
      assert.equal(porCliente.body.code, 'unattributed');
      // …e pela referência que fomos nós que escrevemos, que é o caminho
      // preferido e por isso o que passaria despercebido.
      const porReferencia = await entregar(
        pagamento({ id: 'pay_002', externalReference: `tenant:${alfa}`, customer: null })
      );
      assert.equal(porReferencia.body.code, 'unattributed');
      assert.equal((await assinaturaDe(alfa)).status, 'past_due');
    } finally {
      await db('tenants').where({ id: alfa }).update({ status: 'active' });
    }
  });
});

describe('o valor, que até aqui era enfeite do extrato', () => {
  /**
   * O buraco: um pagamento era um interruptor. Qualquer número ligava o período
   * inteiro, e a cobrança dos primeiros contratos é criada À MÃO no painel do
   * gateway — um valor digitado com um zero a menos passaria como mês pago para
   * sempre, e a única pista seria a conta bancária não bater.
   */
  const comPlanoPago = async (precoCents) => {
    // `plans` é compartilhada e o catálogo sobrevive ao `beforeEach`, que só
    // limpa assinatura e extrato. Reusar o plano do preço pedido é o que
    // mantém cada caso independente sem inventar um código por caso.
    const codigo = `pago-${precoCents}`;
    const existente = await getDb()('plans').where({ code: codigo }).first();
    const plano = existente || await runInTenant(alfa, () => Plan.create({
      code: codigo, name: 'Pago', price_cents: precoCents, currency: 'BRL'
    }));
    await runInTenant(alfa, () => Subscription.upsertForTenant(alfa, { plan_id: plano.id }));
    return plano;
  };

  it('paga menos que o plano: registra o dinheiro e NÃO estende o período', async () => {
    await comPlanoPago(19990);
    const antes = await assinaturaDe(alfa);

    // R$19,99 contra um plano de R$199,90 — o zero que faltou.
    const res = await entregar(pagamento({ id: 'pay_curto', value: 19.99 }));

    // 200, e não erro: o dinheiro chegou e foi registrado, e um não-2xx faria o
    // gateway reentregar em laço para sempre um pagamento que já está gravado.
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'underpaid');

    const depois = await assinaturaDe(alfa);
    assert.equal(String(depois.renews_at), String(antes.renews_at),
      'um décimo do preço comprou o período inteiro');
    assert.equal(depois.status, 'past_due');

    const evento = await runInTenant(alfa, () => getDb()('billing_events')
      .where({ tenant_id: alfa, external_id: 'pay_curto' }).first());
    assert.ok(evento, 'o dinheiro sumiu: nem creditou nem ficou no extrato');
    assert.equal(Number(evento.amount_cents), 1999);
    assert.equal(JSON.parse(evento.detail).shortfallCents, 19990 - 1999);
  });

  /**
   * O caso que decide qual das duas referências manda.
   *
   * A cobrança que o painel emitiu congela o valor no instante em que pediu. Se
   * o preço do plano subiu depois, quem pagou pagou o que viu — e conferir
   * contra o preço de hoje recusaria um pagamento correto. A cobrança vence o
   * catálogo, e é por isso que ela é procurada primeiro.
   */
  it('a cobrança emitida manda sobre o preço do plano', async () => {
    await comPlanoPago(19990);
    await runInTenant(alfa, () => BillingCharge.open({
      periodEnd: '2026-02-01', amountCents: 9990, currency: 'BRL', provider: 'asaas'
    }));
    const cobranca = await runInTenant(alfa, () => getDb()('billing_charges')
      .where({ tenant_id: alfa }).orderBy('id', 'desc').first());
    await runInTenant(alfa, () => BillingCharge.markIssued(cobranca.id, { gatewayChargeId: 'pay_emitida' }));

    // Paga os R$99,90 que a cobrança pediu — metade do preço de tabela.
    const res = await entregar(pagamento({ id: 'pay_emitida', value: 99.9 }));
    assert.equal(res.body.code, 'recorded', 'a cobrança que nós emitimos foi recusada pelo preço de tabela');
    assert.equal((await assinaturaDe(alfa)).status, 'active');

    const quitada = await runInTenant(alfa, () => getDb()('billing_charges')
      .where({ id: cobranca.id }).first());
    assert.equal(quitada.status, 'paid');
  });

  it('uma cobrança paga pela metade continua em aberto', async () => {
    await comPlanoPago(19990);
    await runInTenant(alfa, () => BillingCharge.open({
      periodEnd: '2026-03-01', amountCents: 19990, currency: 'BRL', provider: 'asaas'
    }));
    const cobranca = await runInTenant(alfa, () => getDb()('billing_charges')
      .where({ tenant_id: alfa }).orderBy('id', 'desc').first());
    await runInTenant(alfa, () => BillingCharge.markIssued(cobranca.id, { gatewayChargeId: 'pay_metade' }));

    await entregar(pagamento({ id: 'pay_metade', value: 100 }));

    const ainda = await runInTenant(alfa, () => getDb()('billing_charges')
      .where({ id: cobranca.id }).first());
    // Marcá-la paga apagaria da lista de contas a receber exatamente a linha
    // que alguém precisa olhar — e o período, que não andou, ficaria sem
    // explicação em lugar nenhum.
    assert.equal(ainda.status, 'pending', 'a cobrança foi dada como quitada com metade do valor');
  });

  /**
   * A armadilha da reentrega, que quase passou.
   *
   * O gateway reentrega por desenho, e `recordPayment` volta cedo por
   * `duplicate` sem reavaliar o valor — então o veredito de "pagou pouco" não
   * existe na segunda passada. Sem tratar isso, a PRIMEIRA entrega deixava a
   * cobrança em aberto e a SEGUNDA a quitava: o mecanismo inteiro desligado por
   * um reenvio, e desligado em silêncio.
   */
  it('a reentrega de um pagamento curto não quita a cobrança', async () => {
    await comPlanoPago(19990);
    await runInTenant(alfa, () => BillingCharge.open({
      periodEnd: '2026-04-01', amountCents: 19990, currency: 'BRL', provider: 'asaas'
    }));
    const cobranca = await runInTenant(alfa, () => getDb()('billing_charges')
      .where({ tenant_id: alfa }).orderBy('id', 'desc').first());
    await runInTenant(alfa, () => BillingCharge.markIssued(cobranca.id, { gatewayChargeId: 'pay_reentrega' }));

    const primeira = await entregar(pagamento({ id: 'pay_reentrega', value: 100 }));
    assert.equal(primeira.body.code, 'underpaid');

    const segunda = await entregar(pagamento({ id: 'pay_reentrega', value: 100 }));
    assert.equal(segunda.body.code, 'duplicate');

    const ainda = await runInTenant(alfa, () => getDb()('billing_charges')
      .where({ id: cobranca.id }).first());
    assert.equal(ainda.status, 'pending', 'a reentrega quitou a cobrança que a primeira deixou em aberto');
    assert.equal((await assinaturaDe(alfa)).status, 'past_due');
  });

  it('pagar a mais credita — boleto atrasado chega com juros', async () => {
    await comPlanoPago(19990);
    const res = await entregar(pagamento({ id: 'pay_juros', value: 205 }));
    assert.equal(res.body.code, 'recorded');
    assert.equal((await assinaturaDe(alfa)).status, 'active');
  });
});
