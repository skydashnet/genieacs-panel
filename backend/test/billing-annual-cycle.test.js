import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Coupon } = await import('../src/models/Coupon.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { aggregateRevenue, parseRange } = await import('../src/services/revenueReportService.js');

/**
 * O ciclo anual com desconto (0104).
 *
 * Self-hosted, com o gateway de mentira em `127.0.0.1`, como
 * `billing-proration.test.js`. O que não pode dar errado, em dinheiro:
 *
 * 1. A fatura anual pedir o preço do ANO e o pagamento dela estender 365 dias
 *    — e o estorno devolver os mesmos 365.
 * 2. A troca do mensal para o anual não dar dia de graça: o mês pago vale até
 *    o fim, a fatura da renovação sai pelo preço do ano, e o ciclo só muda na
 *    renovação.
 * 3. Subida ou descida decidida pelo preço POR DIA.
 * 4. Plano sem preço anual não vira anual.
 */
const CHAVE = 'chave-do-anual';
const TOKEN = 'token-do-webhook-do-anual';
const DIA = 86_400_000;

let gateway;
let recebidas = [];
let proximoId = 0;
let panelUrl;
let alfa;
let donoToken;
const planos = {};
let sequencia = 0;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      recebidas.push({ method: req.method, path: caminho, payload });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'POST' && caminho === '/payments') {
        proximoId += 1;
        const id = `pay_an_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      if (req.method === 'DELETE' && caminho.startsWith('/payments/')) return responder(200, { deleted: true });
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN;

  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-anual', password: 'senha-da-dona-1', email: 'dona@anual.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  // Básico: R$ 100/mês ou R$ 1.000/ano. Pro: R$ 250/mês ou R$ 2.500/ano.
  planos.basico = await criar({ code: 'an-basico', name: 'Básico', price_cents: 10000, price_yearly_cents: 100000 });
  planos.pro = await criar({ code: 'an-pro', name: 'Pro', price_cents: 25000, price_yearly_cents: 250000 });
  // Sem preço anual: não oferece o anual.
  planos.mensal = await criar({ code: 'an-so-mensal', name: 'Só mensal', price_cents: 12000 });
  // Mais caro por fatura, mais barato por dia: R$ 120 por 60 dias (R$ 2/dia).
  planos.bimestral = await criar({ code: 'an-bimestral', name: 'Bimestral', price_cents: 12000, period_days: 60 });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

/** Um instante relativo a agora, já ao segundo (o MySQL arredonda os milissegundos). */
const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DIA) / 1000) * 1000);

async function assinar({
  plan = planos.basico, cycle = 'monthly', status = 'active', renewsAt = daquiA(15), coupon = null
} = {}) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: plan.id,
    billing_cycle: cycle,
    pending_billing_cycle: null,
    status,
    renews_at: renewsAt,
    trial_ends_at: null,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: null,
    proration_due_at: null,
    suspended_reason: null,
    coupon_id: coupon?.id ?? null,
    coupon_cycles_left: coupon ? 3 : null,
    coupon_applied_at: coupon ? new Date(Math.floor(Date.now() / 1000) * 1000) : null
  });
  await SubscriptionService.invalidate(alfa);
}

const linha = () => Subscription.forTenant(alfa);
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');
const renovacoes = async () => (await cobrancas()).filter((c) => (c.kind || 'renewal') === 'renewal');
const prorratas = async () => (await cobrancas()).filter((c) => c.kind === 'proration');

const pedir = (caminho, { method = 'GET', body } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(donoToken), ...(body === undefined ? {} : { body })
});
const trocar = (planId, cycle) => pedir('/subscription/plan', {
  method: 'PUT', body: cycle === undefined ? { planId } : { planId, cycle }
});
const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: corpo
});
const pagarRenovacao = (c) => entregar({
  event: 'PAYMENT_RECEIVED',
  payment: {
    id: c.gateway_charge_id,
    value: Number(c.amount_cents) / 100,
    customer: 'cus_alfa',
    externalReference: `tenant:${alfa}:${String(c.period_end).slice(0, 10)}`
  }
});
const emitir = () => runInTenant(alfa, () => ChargeIssuingService.issueCurrent({ manual: true }));

beforeEach(async () => {
  recebidas = [];
  await getDb()('billing_charges').where({ tenant_id: alfa }).del();
  await getDb()('billing_events').where({ tenant_id: alfa }).del();
  await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa' });
  await assinar();
});

describe('o ponto único de preço e prazo', () => {
  it('o anual cobra o preço do ano por 365 dias; o mensal, o do mês por period_days', () => {
    const anual = { billing_cycle: 'annual' };
    const mensal = { billing_cycle: 'monthly' };
    assert.equal(SubscriptionService.cyclePriceCents(anual, planos.basico), 100000);
    assert.equal(SubscriptionService.cyclePeriodDays(anual, planos.basico), 365);
    assert.equal(SubscriptionService.cyclePriceCents(mensal, planos.basico), 10000);
    assert.equal(SubscriptionService.cyclePeriodDays(mensal, planos.basico), 30);
    assert.equal(SubscriptionService.cyclePeriodDays(mensal, planos.bimestral), 60);
    // Sem ciclo gravado é o mensal, como toda assinatura de antes.
    assert.equal(SubscriptionService.cycleOf({}, planos.basico), 'monthly');
  });

  it('o anual num plano sem preço anual cai inteiro no mensal — preço E prazo', () => {
    const anual = { billing_cycle: 'annual' };
    assert.equal(SubscriptionService.cycleOf(anual, planos.mensal), 'monthly');
    assert.equal(SubscriptionService.cyclePriceCents(anual, planos.mensal), 12000);
    assert.equal(SubscriptionService.cyclePeriodDays(anual, planos.mensal), 30);
  });

  it('a economia do anual é sobre o mensal levado a 365 dias, para baixo', () => {
    // 10000 × 365 ÷ 30 = 121666,67; (121666,67 − 100000) ÷ 121666,67 = 17,8% → 17.
    assert.equal(SubscriptionService.annualSavingsPercent(planos.basico), 17);
    assert.equal(SubscriptionService.annualSavingsPercent(planos.mensal), null);
  });

  it('o preço por dia', () => {
    assert.equal(SubscriptionService.dailyPriceOf({ billing_cycle: 'monthly' }, planos.bimestral), 200);
    assert.ok(Math.abs(SubscriptionService.dailyPriceOf({ billing_cycle: 'annual' }, planos.basico) - 100000 / 365) < 1e-9);
  });
});

describe('a assinatura anual', () => {
  it('a fatura pede o preço do ano, com o ciclo gravado, e o pagamento estende 365 dias; o estorno os devolve', async () => {
    const renova = daquiA(3);
    await assinar({ cycle: 'annual', renewsAt: renova });
    const emitida = await emitir();
    assert.equal(emitida.issued, true);
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 100000);
    assert.equal(c.billing_cycle, 'annual');
    const post = recebidas.find((r) => r.method === 'POST' && r.path === '/payments');
    assert.equal(post.payload.value, 1000);
    assert.match(post.payload.description, /\(anual\)$/);

    const res = await pagarRenovacao(c);
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'recorded');
    const paga = await linha();
    assert.equal(new Date(paga.renews_at).getTime(), renova.getTime() + 365 * DIA, 'um ano a partir do prazo');

    const estorno = await runInTenant(alfa, () => SubscriptionService.reversePayment({ externalId: c.gateway_charge_id }));
    assert.equal(estorno.found, true);
    assert.equal(new Date((await linha()).renews_at).getTime(), renova.getTime(), 'o estorno devolve os 365 dias');
  });

  it('o cupom `repeating` desconta a fatura do ano e gasta UM ciclo por fatura', async () => {
    sequencia += 1;
    const cupom = await Coupon.create({
      code: `ANUAL${sequencia}`, kind: 'percent', value: 20, duration: 'repeating', duration_cycles: 3, redemptions: 0, active: true
    });
    await assinar({ cycle: 'annual', renewsAt: daquiA(3), coupon: cupom });
    await emitir();
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 80000, '20% sobre R$ 1.000,00');
    assert.equal(Number(c.coupon_id), Number(cupom.id));
    assert.equal((await pagarRenovacao(c)).body.code, 'recorded');
    assert.equal(Number((await linha()).coupon_cycles_left), 2, 'um ano é um ciclo do cupom');
  });

  it('subir no anual cobra a pró-rata pelo período de 365 dias', async () => {
    await assinar({ plan: planos.basico, cycle: 'annual', renewsAt: daquiA(100) });
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200);
    const depois = await linha();
    assert.equal(Number(depois.plan_id), Number(planos.pro.id), 'a subida vale na hora');
    assert.equal(depois.billing_cycle, 'annual', 'no mesmo ciclo');
    const [pr] = await prorratas();
    assert.ok(pr, 'saiu a fatura de pró-rata');
    const detalhe = JSON.parse(pr.proration_detail);
    const esperado = Math.ceil((150000 * detalhe.remainingSeconds) / (365 * 86_400));
    assert.equal(Number(pr.amount_cents), esperado);
    assert.equal(detalhe.periodSeconds, 365 * 86_400);
    assert.equal(pr.billing_cycle, 'annual');
  });
});

describe('a troca de ciclo', () => {
  it('do mensal para o anual: agendada para a renovação, sem pró-rata; a fatura do prazo sai pelo preço do ano', async () => {
    const renova = daquiA(3);
    await assinar({ renewsAt: renova });
    const res = await trocar(planos.basico.id, 'annual');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription.billingCycle, 'monthly', 'o mês pago vale até o fim');
    assert.equal(res.body.data.subscription.pendingPlan.billingCycle, 'annual');
    assert.equal(res.body.data.subscription.pendingPlan.priceCents, 100000);
    const agendada = await linha();
    assert.equal(agendada.billing_cycle, 'monthly');
    assert.equal(agendada.pending_billing_cycle, 'annual');
    assert.equal(Number(agendada.pending_plan_id), Number(planos.basico.id));
    assert.equal(new Date(agendada.pending_plan_at).getTime(), renova.getTime());
    assert.equal(new Date(agendada.renews_at).getTime(), renova.getTime(), 'nenhum dia a mais');
    assert.equal((await prorratas()).length, 0, 'sem pró-rata');

    await emitir();
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 100000, 'a fatura da renovação é a anual');
    assert.equal(c.billing_cycle, 'annual');

    // Paga adiantado: o prazo anda um ano a partir da renovação, a troca trava
    // e o agendador a aplica na data.
    assert.equal((await pagarRenovacao(c)).body.code, 'recorded');
    const paga = await linha();
    assert.equal(new Date(paga.renews_at).getTime(), renova.getTime() + 365 * DIA);
    assert.ok(paga.pending_plan_locked_at, 'paga pelo preço dela, a troca trava');
    assert.equal(paga.billing_cycle, 'monthly', 'antes da data, o ciclo ainda é o de agora');

    const aplicada = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: new Date(renova.getTime() + 1000) }));
    assert.equal(aplicada.applied, true);
    const anual = await linha();
    assert.equal(anual.billing_cycle, 'annual');
    assert.equal(anual.pending_billing_cycle, null);
    assert.equal(anual.pending_plan_id, null);

    // Travada: voltar ao mensal antes da data não se pode — e pedir de novo o anual é um clique sem efeito.
  });

  it('sem pagamento até a data, o agendador aplica o anual, e a fatura anual paga depois estende 365 dias', async () => {
    const renova = daquiA(3);
    await assinar({ renewsAt: renova });
    assert.equal((await trocar(planos.basico.id, 'annual')).status, 200);
    await emitir();
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 100000);
    // A data chega sem pagamento: a troca não está travada e se aplica.
    const aplicada = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: new Date(renova.getTime() + 1000) }));
    assert.equal(aplicada.applied, true);
    assert.equal((await linha()).billing_cycle, 'annual');
    // Pago (aqui, ainda antes do prazo de verdade): é a fatura do ano.
    assert.equal((await pagarRenovacao(c)).body.code, 'recorded');
    assert.equal(new Date((await linha()).renews_at).getTime(), renova.getTime() + 365 * DIA);
  });

  it('a troca para o anual travada não se desfaz pela tela', async () => {
    await assinar({ renewsAt: daquiA(3) });
    assert.equal((await trocar(planos.basico.id, 'annual')).status, 200);
    await emitir();
    const [c] = await renovacoes();
    await pagarRenovacao(c);
    const volta = await trocar(planos.basico.id, 'monthly');
    assert.equal(volta.status, 409);
    assert.equal(volta.body.code, 'pending_locked');
    const denovo = await trocar(planos.basico.id, 'annual');
    assert.equal(denovo.status, 200);
  });

  it('desistir do anual agendado antes de pagar volta a fatura ao preço do mês', async () => {
    await assinar({ renewsAt: daquiA(3) });
    await trocar(planos.basico.id, 'annual');
    await emitir();
    assert.equal(Number((await renovacoes())[0].amount_cents), 100000);
    const res = await trocar(planos.basico.id, 'monthly');
    assert.equal(res.status, 200);
    const depois = await linha();
    assert.equal(depois.pending_plan_id, null);
    assert.equal(depois.pending_billing_cycle, null);
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 10000, 'reemitida pelo mensal');
    assert.equal(c.billing_cycle, 'monthly');
  });

  it('do anual para o mensal: agendado para a renovação, e a fatura dela é a do mês', async () => {
    const renova = daquiA(3);
    await assinar({ cycle: 'annual', renewsAt: renova });
    const res = await trocar(planos.basico.id, 'monthly');
    assert.equal(res.status, 200);
    const agendada = await linha();
    assert.equal(agendada.billing_cycle, 'annual');
    assert.equal(agendada.pending_billing_cycle, 'monthly');
    await emitir();
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 10000);
    assert.equal(c.billing_cycle, 'monthly');
    assert.equal((await pagarRenovacao(c)).body.code, 'recorded');
    assert.equal(new Date((await linha()).renews_at).getTime(), renova.getTime() + 30 * DIA, 'um mês, e não um ano');
  });

  it('sem período pago correndo (teste), o anual vale na hora', async () => {
    await Subscription.upsertForTenant(alfa, {
      status: 'trial', renews_at: null, trial_ends_at: daquiA(3), billing_cycle: 'monthly'
    });
    const res = await trocar(planos.basico.id, 'annual');
    assert.equal(res.status, 200);
    const depois = await linha();
    assert.equal(depois.billing_cycle, 'annual');
    assert.equal(depois.pending_plan_id, null);
  });

  it('plano sem preço anual recusa o anual (409 cycle_unavailable), e ciclo inválido é 400', async () => {
    const res = await trocar(planos.mensal.id, 'annual');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'cycle_unavailable');
    // Quem já é anual e escolhe um plano sem anual, sem dizer o ciclo, também.
    await assinar({ cycle: 'annual', renewsAt: daquiA(20) });
    const herdado = await trocar(planos.mensal.id);
    assert.equal(herdado.status, 409);
    assert.equal(herdado.body.code, 'cycle_unavailable');
    const invalido = await trocar(planos.basico.id, 'weekly');
    assert.equal(invalido.status, 400);
    assert.equal(invalido.body.code, 'invalid_cycle');
    assert.equal((await linha()).billing_cycle, 'annual', 'nada mudou');
  });
});

describe('subida ou descida, pelo preço por dia', () => {
  it('mais caro na fatura e mais barato por dia é DESCIDA: agendada', async () => {
    // Só mensal R$ 120/30 dias = R$ 4/dia; Bimestral R$ 120/60 dias = R$ 2/dia.
    await assinar({ plan: planos.mensal, renewsAt: daquiA(10) });
    const res = await trocar(planos.bimestral.id);
    assert.equal(res.status, 200);
    const depois = await linha();
    assert.equal(Number(depois.plan_id), Number(planos.mensal.id), 'o plano continua o de agora');
    assert.equal(Number(depois.pending_plan_id), Number(planos.bimestral.id));
  });

  it('mais caro por dia é SUBIDA: vale na hora', async () => {
    await assinar({ plan: planos.basico, renewsAt: daquiA(10) });
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200);
    assert.equal(Number((await linha()).plan_id), Number(planos.pro.id));
  });

  it('mesma fatura e dia mais caro (60 → 30 dias): a subida cobra a diferença POR DIA', async () => {
    // Bimestral R$ 120/60 dias = R$ 2/dia → Só mensal R$ 120/30 dias = R$ 4/dia.
    await assinar({ plan: planos.bimestral, renewsAt: daquiA(10) });
    const res = await trocar(planos.mensal.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number((await linha()).plan_id), Number(planos.mensal.id), 'subida: vale na hora');
    const [pr] = await prorratas();
    assert.ok(pr, 'a subida não sai de graça');
    const detalhe = JSON.parse(pr.proration_detail);
    const esperado = Math.ceil(((12000 * 60 - 12000 * 30) * detalhe.remainingSeconds) / (60 * 30 * 86_400));
    assert.equal(Number(pr.amount_cents), esperado);
    assert.ok(Math.abs(Number(pr.amount_cents) - 2000) <= 1, 'R$ 2 por dia × 10 dias');
  });

  it('descer no anual (Pro anual → Básico anual) fica para a renovação', async () => {
    await assinar({ plan: planos.pro, cycle: 'annual', renewsAt: daquiA(200) });
    const res = await trocar(planos.basico.id);
    assert.equal(res.status, 200);
    const depois = await linha();
    assert.equal(Number(depois.plan_id), Number(planos.pro.id));
    assert.equal(Number(depois.pending_plan_id), Number(planos.basico.id));
    assert.equal(depois.pending_billing_cycle, null, 'no mesmo ciclo');
  });
});

describe('a lista de planos', () => {
  it('traz o preço anual, se há anual e a economia', async () => {
    const lista = (await pedir('/plans')).body.data;
    const basico = lista.find((p) => p.code === 'an-basico');
    assert.equal(basico.priceCents, 10000);
    assert.equal(basico.priceYearlyCents, 100000);
    assert.equal(basico.annualAvailable, true);
    assert.equal(basico.annualSavingsPercent, 17);
    const mensal = lista.find((p) => p.code === 'an-so-mensal');
    assert.equal(mensal.annualAvailable, false);
    assert.equal(mensal.priceYearlyCents, null);
  });
});

describe('o console', () => {
  it('conta quem está (ou vai estar) no anual de um plano — a pergunta antes de tirar o preço anual', async () => {
    await assinar({ plan: planos.basico, cycle: 'annual', renewsAt: daquiA(100) });
    assert.equal(await Subscription.countAnnualOnPlan(planos.basico.id), 1);
    assert.equal(await Subscription.countAnnualOnPlan(planos.pro.id), 0);
    // A troca agendada para o anual de outro plano conta também.
    await Subscription.upsertForTenant(alfa, {
      billing_cycle: 'monthly', pending_plan_id: planos.pro.id, pending_plan_at: daquiA(100), pending_billing_cycle: 'annual'
    });
    assert.equal(await Subscription.countAnnualOnPlan(planos.pro.id), 1);
    assert.equal(await Subscription.countAnnualOnPlan(planos.basico.id), 0);
  });
});

describe('a receita (MRR)', () => {
  it('o anual entra normalizado para trinta dias', () => {
    const NOW = new Date('2026-10-06T12:00:00Z');
    const range = parseRange({ from: '2026-10-01', to: '2026-10-31' }, NOW);
    const relatorio = aggregateRevenue({
      range,
      now: NOW,
      tenants: [{ id: 1 }, { id: 2 }],
      subscriptions: [
        { id: 11, tenant_id: 1, plan_id: planos.basico.id, status: 'active', billing_cycle: 'annual', renews_at: '2027-06-01T00:00:00Z' },
        { id: 12, tenant_id: 2, plan_id: planos.basico.id, status: 'active', billing_cycle: 'monthly', renews_at: '2026-11-01T00:00:00Z' }
      ],
      plans: [planos.basico],
      prices: new Map(),
      charges: [],
      events: []
    });
    // 100000 × 30 ÷ 365 = 8219,18 → 8219; mais o mensal, 10000.
    assert.equal(relatorio.mrrCents, 8219 + 10000);
    assert.equal(relatorio.activeCount, 2);
  });
});

describe('o prazo que o pagamento compra é o da cobrança paga', () => {
  const inserirCobranca = (linha) => getDb()('billing_charges').insert({
    tenant_id: alfa,
    period_end: '2099-01-01',
    currency: 'BRL',
    provider: 'asaas',
    status: 'pending',
    attempts: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...linha
  }).returning('id');

  it('a renovação MENSAL do plano atual, paga com descida + anual agendada que já cabe, compra um mês — e não um ano', async () => {
    const renova = daquiA(3);
    await assinar({ plan: planos.pro, renewsAt: renova });
    await Subscription.upsertForTenant(alfa, {
      pending_plan_id: planos.basico.id, pending_plan_at: renova, pending_billing_cycle: 'annual', pending_plan_locked_at: null
    });
    await SubscriptionService.invalidate(alfa);
    // A fatura saiu pelo Pro mensal (a descida estava bloqueada pelo uso quando ela foi emitida).
    await inserirCobranca({
      amount_cents: 25000, gateway_charge_id: 'pay_mensal_pro', plan_id: planos.pro.id, billing_cycle: 'monthly'
    });
    const r = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 25000, provider: 'asaas', externalId: 'pay_mensal_pro'
    }));
    assert.equal(r.underpaid, false);
    const dias = (new Date(r.subscription.renews_at).getTime() - renova.getTime()) / DIA;
    assert.equal(dias, 30, 'R$ 250 do mês compram 30 dias');
    assert.equal(r.subscription.billing_cycle, 'monthly');
    assert.equal(new Date(r.subscription.pending_plan_at).getTime(), renova.getTime() + 30 * DIA, 'a troca vai para a renovação seguinte');
    const evento = await getDb()('billing_events').where({ tenant_id: alfa, external_id: 'pay_mensal_pro' }).first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.periodDays, 30);
    assert.equal(Number(detalhe.planId), Number(planos.pro.id));
    assert.equal(detalhe.billingCycle, 'monthly');
  });

  it('a renovação ANUAL do plano atual, paga com descida + mensal agendada, compra um ano — e não um mês', async () => {
    const renova = daquiA(3);
    await assinar({ plan: planos.pro, cycle: 'annual', renewsAt: renova });
    await Subscription.upsertForTenant(alfa, {
      pending_plan_id: planos.basico.id, pending_plan_at: renova, pending_billing_cycle: 'monthly', pending_plan_locked_at: null
    });
    await SubscriptionService.invalidate(alfa);
    await inserirCobranca({
      amount_cents: 250000, gateway_charge_id: 'pay_anual_pro', plan_id: planos.pro.id, billing_cycle: 'annual'
    });
    const r = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 250000, provider: 'asaas', externalId: 'pay_anual_pro'
    }));
    assert.equal((new Date(r.subscription.renews_at).getTime() - renova.getTime()) / DIA, 365);
    const estorno = await runInTenant(alfa, () => SubscriptionService.reversePayment({ externalId: 'pay_anual_pro' }));
    assert.equal(new Date(estorno.subscription.renews_at).getTime(), renova.getTime(), 'o estorno devolve os mesmos 365');
  });

  it('o boleto VELHO (mensal) de uma cobrança reemitida no anual compra um mês', async () => {
    const renova = daquiA(3);
    await assinar({ plan: planos.basico, renewsAt: renova });
    await Subscription.upsertForTenant(alfa, {
      pending_plan_id: planos.basico.id, pending_plan_at: renova, pending_billing_cycle: 'annual', pending_plan_locked_at: null
    });
    await SubscriptionService.invalidate(alfa);
    const [id] = await inserirCobranca({
      amount_cents: 10000, gateway_charge_id: 'pay_velho_mensal', plan_id: planos.basico.id, billing_cycle: 'monthly'
    });
    const BillingCharge = (await import('../src/models/BillingCharge.js')).default;
    const idDaLinha = typeof id === 'object' ? id.id : id;
    await runInTenant(alfa, () => BillingCharge.resetForReissue(idDaLinha, {
      amountCents: 100000, currency: 'BRL', planId: planos.basico.id, couponId: null, billingCycle: 'annual'
    }));
    const velha = BillingCharge.supersededOf(await getDb()('billing_charges').where({ id: idDaLinha }).first());
    assert.equal(velha[0].billingCycle, 'monthly', 'a entrada guarda o ciclo da cobrança velha');
    assert.equal(Number(velha[0].planId), Number(planos.basico.id));
    const r = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 10000, provider: 'asaas', externalId: 'pay_velho_mensal'
    }));
    assert.equal(r.underpaid, false);
    assert.equal((new Date(r.subscription.renews_at).getTime() - renova.getTime()) / DIA, 30);
  });
});

describe('o cupom na troca para o anual', () => {
  const cupomDe = async (duration) => {
    sequencia += 1;
    return Coupon.create({
      code: `TROCA${sequencia}`, kind: 'percent', value: 20, duration,
      ...(duration === 'repeating' ? { duration_cycles: 3 } : {}), redemptions: 0, active: true
    });
  };
  const removidos = async () => (await getDb()('billing_events').where({ tenant_id: alfa, type: 'coupon.removed' }))
    .map((e) => JSON.parse(e.detail));

  it('o cupom de N faturas do mensal não desconta a fatura anual, e sai quando o anual vale', async () => {
    const cupom = await cupomDe('repeating');
    const renova = daquiA(3);
    await assinar({ renewsAt: renova, coupon: cupom });
    assert.equal((await trocar(planos.basico.id, 'annual')).status, 200);
    await emitir();
    const [c] = await renovacoes();
    assert.equal(Number(c.amount_cents), 100000, 'a fatura anual sai sem o cupom do mensal');
    assert.equal(c.coupon_id, null);
    assert.equal(Number((await linha()).coupon_id), Number(cupom.id), 'antes de o anual valer, o cupom continua');
    await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: new Date(renova.getTime() + 1000) }));
    const depois = await linha();
    assert.equal(depois.billing_cycle, 'annual');
    assert.equal(depois.coupon_id, null, 'o cupom sai');
    const [evento] = await removidos();
    assert.equal(evento.reason, 'cycle_change');
    assert.equal(Number(evento.coupon.id), Number(cupom.id));
  });

  it('pago atrasado, o anual aplicado pelo pagamento também tira o cupom', async () => {
    const cupom = await cupomDe('once');
    const renova = daquiA(3);
    await assinar({ renewsAt: renova, coupon: cupom });
    assert.equal((await trocar(planos.basico.id, 'annual')).status, 200);
    await emitir();
    const [c] = await renovacoes();
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: daquiA(-1), pending_plan_at: daquiA(-1) });
    await SubscriptionService.invalidate(alfa);
    assert.equal((await pagarRenovacao(c)).body.code, 'recorded');
    const depois = await linha();
    assert.equal(depois.billing_cycle, 'annual');
    assert.equal(depois.coupon_id, null);
    assert.equal((await removidos())[0]?.reason, 'cycle_change');
  });

  it('o cupom `forever` fica e desconta a fatura anual', async () => {
    const cupom = await cupomDe('forever');
    const renova = daquiA(3);
    await assinar({ renewsAt: renova, coupon: cupom });
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ coupon_cycles_left: null });
    assert.equal((await trocar(planos.basico.id, 'annual')).status, 200);
    await emitir();
    assert.equal(Number((await renovacoes())[0].amount_cents), 80000);
    await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: new Date(renova.getTime() + 1000) }));
    assert.equal(Number((await linha()).coupon_id), Number(cupom.id));
    assert.equal((await removidos()).length, 0);
  });

  it('a troca na hora para o anual (no teste) tira o cupom de N faturas', async () => {
    const cupom = await cupomDe('repeating');
    await assinar({ coupon: cupom });
    await Subscription.upsertForTenant(alfa, { status: 'trial', renews_at: null, trial_ends_at: daquiA(3) });
    await SubscriptionService.invalidate(alfa);
    assert.equal((await trocar(planos.basico.id, 'annual')).status, 200);
    const depois = await linha();
    assert.equal(depois.billing_cycle, 'annual');
    assert.equal(depois.coupon_id, null);
    assert.equal((await removidos())[0]?.reason, 'cycle_change');
  });
});
