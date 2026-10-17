import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: BillingEvent, BILLING_EVENT_TYPES } = await import('../src/models/BillingEvent.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { toCsvWith } = await import('../src/utils/csv.js');
const {
  parseRange, aggregateRevenue, revenueCsvRows, instanteMs, precoEfetivo, REVENUE_CSV_COLUMNS,
  MAX_RANGE_MONTHS
} = await import('../src/services/revenueReportService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformReportsRoutes } = await import('../src/routes/platformReports.js');

/**
 * O relatório de receita do console.
 *
 * Duas metades. A soma (`aggregateRevenue`) é pura, e é nela que se fixam as
 * decisões: quem entra no MRR (só ativo de verdade, pagante, não isento), o
 * que é recebido e o que é estornado, e o que está em aberto. As rotas são
 * provadas montadas atrás das guardas de verdade, num app mínimo como em
 * `platform-subscriptions.test.js` — a edição self-hosted não monta o console.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-03T12:00:00Z');

describe('revenue report: period', () => {
  it('defaults to the last twelve calendar months, ending today', () => {
    const range = parseRange({}, NOW);
    assert.equal(range.from, '2025-11-01');
    assert.equal(range.to, '2026-10-03');
    assert.equal(range.months.length, 12);
    assert.equal(range.months[0], '2025-11');
    assert.equal(range.months[11], '2026-10');
    assert.equal(range.endMs, Date.UTC(2026, 9, 4));
  });

  it('refuses dates that do not exist, a reversed period and more than 36 months', () => {
    const codigo = (query) => {
      try { parseRange(query, NOW); } catch (error) { return error.code; }
      return null;
    };
    assert.equal(codigo({ from: '2026-02-30', to: '2026-03-10' }), 'invalid_date');
    assert.equal(codigo({ from: '01/02/2026' }), 'invalid_date');
    assert.equal(codigo({ from: '2026-05-01', to: '2026-04-30' }), 'invalid_range');
    assert.equal(codigo({ from: '2023-01-01', to: '2026-01-31' }), 'range_too_long');
    const teto = parseRange({ from: '2023-02-15', to: '2026-01-02' }, NOW);
    assert.equal(teto.months.length, MAX_RANGE_MONTHS);
    assert.equal(codigo({ from: '2026-04-10', to: '2026-04-10' }), null);
  });

  it('reads naive database timestamps as UTC', () => {
    assert.equal(instanteMs('2026-03-01 12:00:00'), Date.UTC(2026, 2, 1, 12));
    assert.equal(instanteMs(Date.UTC(2026, 2, 1)), Date.UTC(2026, 2, 1));
    assert.equal(instanteMs('2026-03-01'), Date.UTC(2026, 2, 1));
    assert.equal(instanteMs(null), null);
    assert.equal(instanteMs('lixo'), null);
  });
});

/** Um cenário inteiro, sem banco: planos, assinaturas, cobranças e o extrato. */
function cenario() {
  const plans = [
    { id: 1, name: 'Pro', price_cents: 10000, period_days: 30 },
    { id: 2, name: 'Anual', price_cents: 120000, period_days: 365 },
    { id: 3, name: 'Grátis', price_cents: 0, period_days: 30 }
  ];
  const futuro = new Date(NOW.getTime() + 20 * DAY);
  const tenants = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `Provedor ${id}` }));
  const subscriptions = [
    { id: 11, tenant_id: 1, plan_id: 1, status: 'active', renews_at: futuro },
    { id: 12, tenant_id: 2, plan_id: 2, status: 'active', renews_at: futuro },
    // Em teste: ainda não paga.
    { id: 13, tenant_id: 3, plan_id: 1, status: 'trial', trial_ends_at: futuro },
    // Isento: ativo e não paga.
    { id: 14, tenant_id: 4, plan_id: 1, status: 'active', renews_at: futuro, billing_exempt_at: NOW },
    // Plano grátis.
    { id: 15, tenant_id: 5, plan_id: 3, status: 'active', renews_at: futuro },
    // Ativo gravado, mas vencido: `past_due` pelo que vale.
    { id: 16, tenant_id: 6, plan_id: 1, status: 'active', renews_at: new Date(NOW.getTime() - DAY) },
    // Com desconto (o preço efetivo vem de fora).
    { id: 17, tenant_id: 7, plan_id: 1, status: 'active', renews_at: futuro }
  ];
  const prices = new Map([[11, 10000], [12, 120000], [13, 10000], [14, 10000], [15, 0], [16, 10000], [17, 8000]]);
  const base = { currency: 'BRL', superseded_charges: null, created_at: '2026-01-01 00:00:00' };
  const charges = [
    // Paga em março, com o evento do extrato (o `updated_at` é outro mês de propósito).
    { ...base, id: 101, tenant_id: 1, subscription_id: 11, amount_cents: 10000, status: 'paid', gateway_charge_id: 'pay_a', due_date: '2026-03-05', updated_at: '2026-07-01 00:00:00' },
    // Paga em janeiro, estornada em fevereiro.
    { ...base, id: 102, tenant_id: 1, subscription_id: 11, amount_cents: 10000, status: 'refunded', gateway_charge_id: 'pay_b', due_date: '2026-01-05', updated_at: '2026-02-20 00:00:00' },
    // Paga com desconto, por baixa sem gateway, sem evento: vale o `updated_at`.
    { ...base, id: 103, tenant_id: 7, subscription_id: 17, amount_cents: 8000, status: 'paid', gateway_charge_id: null, due_date: '2026-04-05', updated_at: '2026-04-06 10:00:00' },
    // Paga fora do período.
    { ...base, id: 104, tenant_id: 2, subscription_id: 12, amount_cents: 120000, status: 'paid', gateway_charge_id: 'pay_velho', due_date: '2024-05-01', updated_at: '2024-05-02 00:00:00' },
    // Em aberto, vence no futuro.
    { ...base, id: 105, tenant_id: 2, subscription_id: 12, amount_cents: 120000, status: 'pending', gateway_charge_id: 'pay_c', due_date: '2026-10-20', updated_at: NOW },
    // Atrasada pelo gateway.
    { ...base, id: 106, tenant_id: 6, subscription_id: 16, amount_cents: 10000, status: 'overdue', gateway_charge_id: 'pay_d', due_date: '2026-09-25', updated_at: NOW },
    // Pendente com o vencimento já passado — atrasada sem o aviso do gateway.
    { ...base, id: 107, tenant_id: 6, subscription_id: 16, amount_cents: 5000, status: 'pending', gateway_charge_id: 'pay_e', due_date: '2026-09-28', updated_at: NOW },
    // Cancelada: não conta em nada.
    { ...base, id: 108, tenant_id: 3, subscription_id: 13, amount_cents: 10000, status: 'canceled', gateway_charge_id: 'pay_f', due_date: '2026-06-01', updated_at: NOW },
    // De um provedor que não está na lista (a plataforma, ou um apagado).
    { ...base, id: 109, tenant_id: 99, subscription_id: null, amount_cents: 77700, status: 'paid', gateway_charge_id: 'pay_g', due_date: '2026-06-01', updated_at: '2026-06-01 00:00:00' }
  ];
  const pago = (tenantId, externalId, amount, createdAt, detail = null) => ({
    tenant_id: tenantId, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, external_id: externalId, amount_cents: amount,
    created_at: createdAt, detail: detail === null ? null : JSON.stringify(detail)
  });
  const events = [
    pago(1, 'pay_a', 10000, '2026-03-04 15:00:00', { planId: 1, expectedCents: 10000 }),
    pago(1, 'pay_b', 10000, '2026-01-04 09:00:00', { planId: 1, expectedCents: 10000 }),
    {
      tenant_id: 1, type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED, external_id: 'pay_b:refund', amount_cents: 10000,
      created_at: '2026-02-10 09:00:00', detail: JSON.stringify({ reference: 'pay_b' })
    },
    // A baixa sem gateway da cobrança 103, com desconto de cupom.
    pago(7, 'charge:103', 8000, '2026-04-06 10:00:00', { planId: 1, expectedCents: 8000 }),
    // A marca manual do console, sem cobrança nenhuma e sem referência — e de
    // um plano (Anual) que não é o de hoje da assinatura.
    pago(7, null, 100000, '2026-05-10 12:00:00', { planId: 2, expectedCents: 100000 }),
    // Paga no gateway por uma cobrança que nunca teve linha aqui.
    pago(2, 'pay_sem_linha', 120000, '2026-06-15 08:00:00', { planId: 2, expectedCents: 120000 }),
    // Paga a menos e depois aceita: o aceite é um evento de zero, não outro pagamento.
    pago(6, 'pay_curto', 6000, '2026-08-01 08:00:00', { expectedCents: 10000, underpaid: true, shortfallCents: 4000 }),
    pago(6, 'pay_curto:accepted', 0, '2026-08-02 08:00:00', { planId: 1, periodDays: 30, expectedCents: 10000 }),
    // Um evento de outro provedor com a mesma referência não data a cobrança deste.
    pago(2, 'pay_a', 99999, '2025-01-01 00:00:00'),
    pago(2, 'pay_velho', 120000, '2024-05-02 00:00:00'),
    // De um provedor que não está na lista.
    pago(99, 'pay_g', 77700, '2026-06-01 00:00:00')
  ];
  return { tenants, subscriptions, plans, prices, charges, events };
}

describe('revenue report: aggregation', () => {
  const range = parseRange({}, NOW);
  const relatorio = aggregateRevenue({ range, now: NOW, ...cenario() });

  it('counts MRR only for effectively active, paying, non-exempt subscriptions, normalised to 30 days', () => {
    // Pro 10000 + Anual 120000×30/365 (9863) + Pro com desconto 8000.
    assert.equal(relatorio.mrrCents, 10000 + 9863 + 8000);
    assert.equal(relatorio.activeCount, 3);
  });

  it('sums received and refunded from the billing events, each by its own date', () => {
    // pay_b + pay_a + charge:103 + a marca manual + o pagamento sem linha + o curto.
    assert.equal(relatorio.receivedCents, 10000 + 10000 + 8000 + 100000 + 120000 + 6000);
    assert.equal(relatorio.refundedCents, 10000);
    const mes = (m) => relatorio.monthly.find((linha) => linha.month === m);
    assert.deepEqual(mes('2026-01'), { month: '2026-01', receivedCents: 10000, refundedCents: 0, count: 1 });
    assert.deepEqual(mes('2026-02'), { month: '2026-02', receivedCents: 0, refundedCents: 10000, count: 0 });
    assert.deepEqual(mes('2026-03'), { month: '2026-03', receivedCents: 10000, refundedCents: 0, count: 1 });
    assert.deepEqual(mes('2026-04'), { month: '2026-04', receivedCents: 8000, refundedCents: 0, count: 1 });
    assert.deepEqual(mes('2026-05'), { month: '2026-05', receivedCents: 100000, refundedCents: 0, count: 1 });
    assert.deepEqual(mes('2026-06'), { month: '2026-06', receivedCents: 120000, refundedCents: 0, count: 1 });
    // O curto entra pelo que veio, uma vez; o aceite não é outro pagamento.
    assert.deepEqual(mes('2026-08'), { month: '2026-08', receivedCents: 6000, refundedCents: 0, count: 1 });
    // O `updated_at` de julho da cobrança 101 não conta: quem data é o extrato.
    assert.equal(mes('2026-07').receivedCents, 0);
    assert.equal(relatorio.monthly.length, 12);
  });

  it('sums every charge open now, and the overdue ones with the tenants behind them', () => {
    assert.equal(relatorio.openCents, 120000 + 10000 + 5000);
    assert.equal(relatorio.overdueCents, 10000 + 5000);
    assert.equal(relatorio.overdueTenants, 1);
  });

  it('estimates the discount from what each payment was asked against today\'s plan price', () => {
    // 103: Pro 10000 pedindo 8000. A marca manual: Anual 120000 pedindo 100000.
    // pay_b foi estornado: não conta. O curto pediu o preço cheio.
    assert.equal(relatorio.discountCents, 2000 + 20000);
    assert.equal(relatorio.discountApproximate, true);
  });

  it('compares the plan base price recorded in the payment, not the amount with overage or credit', () => {
    const extra = cenario();
    const pago = (tenantId, externalId, amount, createdAt, detail) => ({
      tenant_id: tenantId, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, external_id: externalId, amount_cents: amount,
      created_at: createdAt, detail: JSON.stringify(detail)
    });
    extra.events.push(
      // Pro 10000 cheio, pedido 12000 (com R$ 20 de excedente) e base 10000: sem desconto.
      pago(1, 'pay_excedente', 12000, '2026-09-01 10:00:00', { planId: 1, expectedCents: 12000, baseCents: 10000 }),
      // Pedido 5000 por causa de R$ 50 de crédito, base 10000: crédito não é desconto.
      pago(1, 'pay_credito', 5000, '2026-09-02 10:00:00', { planId: 1, expectedCents: 5000, baseCents: 10000 }),
      // Base 9000 (cupom de 10%), pedido 11000 com excedente: R$ 10 de desconto.
      pago(1, 'pay_cupom', 11000, '2026-09-03 10:00:00', { planId: 1, expectedCents: 11000, baseCents: 9000 })
    );
    const outro = aggregateRevenue({ range: parseRange({}, NOW), now: NOW, ...extra });
    assert.equal(outro.discountCents, 2000 + 20000 + 1000);
  });

  it('breaks MRR and received down by plan, without the free and exempt ones', () => {
    const pro = relatorio.byPlan.find((linha) => linha.planId === 1);
    const anual = relatorio.byPlan.find((linha) => linha.planId === 2);
    // Pro: pay_a, pay_b, 103 e o curto (pelo plano de hoje, sem `planId` no evento).
    assert.deepEqual(pro, { planId: 1, name: 'Pro', activeCount: 2, mrrCents: 18000, receivedCents: 34000 });
    // Anual: o plano que o evento diz, não o de hoje da assinatura 17.
    assert.deepEqual(anual, { planId: 2, name: 'Anual', activeCount: 1, mrrCents: 9863, receivedCents: 220000 });
    assert.equal(relatorio.byPlan.some((linha) => linha.planId === 3), false);
    assert.equal(relatorio.byPlan[0].planId, 1);
  });

  it('a range outside every payment reports zero received, not an error', () => {
    const vazio = aggregateRevenue({ range: parseRange({ from: '2020-01-01', to: '2020-03-31' }, NOW), now: NOW, ...cenario() });
    assert.equal(vazio.receivedCents, 0);
    assert.equal(vazio.refundedCents, 0);
    // Em aberto é de agora, não do período.
    assert.equal(vazio.openCents, 135000);
    assert.equal(vazio.monthly.length, 3);
  });
});

describe('revenue report: effective price', () => {
  it('uses SubscriptionService.effectivePriceCents when it exists, the plan price otherwise', async () => {
    const original = Object.getOwnPropertyDescriptor(SubscriptionService, 'effectivePriceCents');
    try {
      delete SubscriptionService.effectivePriceCents;
      assert.equal(await precoEfetivo({ id: 1 }, { price_cents: 9900 }), 9900);
      SubscriptionService.effectivePriceCents = async () => 4500;
      assert.equal(await precoEfetivo({ id: 1 }, { price_cents: 9900 }), 4500);
      SubscriptionService.effectivePriceCents = () => { throw new Error('quebrou'); };
      assert.equal(await precoEfetivo({ id: 1 }, { price_cents: 9900 }), 9900);
    } finally {
      delete SubscriptionService.effectivePriceCents;
      if (original) Object.defineProperty(SubscriptionService, 'effectivePriceCents', original);
    }
  });
});

describe('revenue report: CSV rows', () => {
  it('lists the period\'s charges, escaped for a spreadsheet', () => {
    const dados = cenario();
    dados.tenants[0].name = '=HYPERLINK("x";"y")';
    const linhas = revenueCsvRows({ range: parseRange({}, NOW), ...dados });
    // 101, 102, 103 pelo pagamento; 106, 107, 108 pelo vencimento. 104 (paga em
    // 2024), 105 (vence depois de `to`) e 109 (provedor fora da lista) ficam de fora.
    assert.deepEqual(linhas.map((l) => l.id).sort((a, b) => a - b), [101, 102, 103, 106, 107, 108]);
    const estornada = linhas.find((l) => l.id === 102);
    assert.equal(estornada.amount, '100,00');
    assert.equal(estornada.paidAt, '2026-01-04 09:00:00');
    assert.equal(estornada.refundedAt, '2026-02-10 09:00:00');
    assert.equal(linhas[0].id, 102);
    const csv = toCsvWith(REVENUE_CSV_COLUMNS, linhas);
    assert.ok(csv.startsWith('﻿Provedor;Plano;Valor;'));
    // A fórmula sai com apóstrofo, e as aspas e o `;` dela entre aspas.
    assert.ok(csv.includes('"\'=HYPERLINK(""x"";""y"")"'), csv);
    assert.ok(csv.includes(';100,00;BRL;refunded;2026-01-05;2026-01-04 09:00:00;pay_b;2026-02-10 09:00:00\r\n'), csv);
  });
});

describe('revenue report: routes', () => {
  let panelUrl;
  let consoleServer;
  let consoleUrl;
  let donoToken;
  let comumToken;
  let delta;
  let plano;

  const consulta = (caminho, token) => call(`${consoleUrl}/api/platform${caminho}`, {
    headers: token ? authHeaders(token) : {}
  });

  before(async () => {
    ({ panelUrl } = await startTestServers());
    const app = express();
    app.use(express.json());
    app.use(attachLocale);
    app.use('/api', resolveTenant);
    app.use('/api/platform', platformReportsRoutes);
    consoleUrl = await new Promise((resolve) => {
      consoleServer = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${consoleServer.address().port}`));
    });

    const setup = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
    });
    assert.equal(setup.status, 201);
    donoToken = setup.body.data.token;
    await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });
    const contratado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donoToken),
      body: { username: 'comum', password: 'senha-do-comum-1', role: 'admin', email: 'comum@exemplo.test' }
    });
    assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
    const entrou = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'comum', password: 'senha-do-comum-1' }
    });
    comumToken = entrou.body?.data?.token;
    assert.ok(comumToken);

    const db = getDb();
    await db('tenants').insert({ slug: 'delta', name: 'Provedor; "Delta"', status: 'active' });
    delta = (await db('tenants').where({ slug: 'delta' }).first()).id;
    resetDeploymentSharing();
    plano = await Plan.create({
      code: 'receita-pro', name: 'Receita Pro', price_cents: 20000, currency: 'BRL', period_days: 60, trial_days: 0, active: true
    });
    await Subscription.upsertForTenant(delta, {
      plan_id: plano.id, status: 'active', renews_at: new Date(Date.now() + 40 * DAY), trial_ends_at: null
    });
    const sub = await Subscription.forTenant(delta);
    // Uma paga e uma estornada, em 2021, longe de qualquer linha de outro teste.
    const [paga, estornada] = await runInTenant(delta, async () => {
      const ids = [];
      for (const [periodEnd, gatewayId] of [['2021-03-01', 'pay_rel_1'], ['2021-04-01', 'pay_rel_2']]) {
        const id = await BillingCharge.open({
          subscriptionId: sub.id, periodEnd, amountCents: 20000, currency: 'BRL', provider: 'asaas', dueDate: periodEnd
        });
        await BillingCharge.update(id, { gateway_charge_id: gatewayId });
        await BillingEvent.record({
          subscriptionId: sub.id, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, amountCents: 20000, currency: 'BRL',
          provider: 'asaas', externalId: gatewayId
        });
        ids.push(id);
      }
      await BillingCharge.update(ids[0], { status: 'paid' });
      await BillingCharge.update(ids[1], { status: 'refunded' });
      await BillingEvent.record({
        subscriptionId: sub.id, type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED, amountCents: 20000, currency: 'BRL',
        provider: 'asaas', externalId: 'pay_rel_2:refund'
      });
      // A marca manual do console, sem cobrança e sem referência.
      await BillingEvent.record({
        subscriptionId: sub.id, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, amountCents: 5000, currency: 'BRL',
        provider: 'manual'
      });
      return ids;
    });
    assert.ok(paga && estornada);
    await db('billing_events').where({ tenant_id: delta, amount_cents: 5000 }).whereNull('external_id')
      .update({ created_at: new Date(Date.UTC(2021, 5, 10, 10)) });
    // Os instantes do extrato, postos no período — ao segundo, pelo MySQL.
    await db('billing_events').where({ tenant_id: delta, external_id: 'pay_rel_1' })
      .update({ created_at: new Date(Date.UTC(2021, 2, 2, 10)) });
    await db('billing_events').where({ tenant_id: delta, external_id: 'pay_rel_2' })
      .update({ created_at: new Date(Date.UTC(2021, 3, 2, 10)) });
    await db('billing_events').where({ tenant_id: delta, external_id: 'pay_rel_2:refund' })
      .update({ created_at: new Date(Date.UTC(2021, 4, 3, 10)) });
  });

  after(async () => {
    await new Promise((r) => consoleServer.close(r));
    await stopTestServers();
  });

  it('answers the report for a platform admin', async () => {
    const resposta = await consulta('/reports/revenue?from=2021-01-01&to=2021-12-31', donoToken);
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const dados = resposta.body.data;
    assert.equal(dados.from, '2021-01-01');
    // As duas cobranças e a marca manual, que não tem cobrança.
    assert.equal(dados.receivedCents, 45000);
    assert.equal(dados.refundedCents, 20000);
    assert.equal(dados.monthly.length, 12);
    assert.equal(dados.monthly.find((m) => m.month === '2021-03').receivedCents, 20000);
    assert.equal(dados.monthly.find((m) => m.month === '2021-06').receivedCents, 5000);
    assert.equal(dados.monthly.find((m) => m.month === '2021-05').refundedCents, 20000);
    const linha = dados.byPlan.find((l) => l.planId === plano.id);
    // 20000 a cada 60 dias = 10000 por mês.
    assert.deepEqual(linha, { planId: plano.id, name: 'Receita Pro', activeCount: 1, mrrCents: 10000, receivedCents: 45000 });
    assert.ok(dados.mrrCents >= 10000);
  });

  it('defaults to the last twelve months', async () => {
    const resposta = await consulta('/reports/revenue', donoToken);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.data.monthly.length, 12);
    assert.equal(resposta.body.data.receivedCents, 0);
  });

  it('refuses a bad period with a code', async () => {
    const ruim = await consulta('/reports/revenue?from=2021-13-01', donoToken);
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_date');
    const longo = await consulta('/reports/revenue.csv?from=2018-01-01&to=2021-12-31', donoToken);
    assert.equal(longo.status, 400);
    assert.equal(longo.body.code, 'range_too_long');
  });

  it('exports the period\'s charges as a CSV attachment', async () => {
    const resposta = await fetch(`${consoleUrl}/api/platform/reports/revenue.csv?from=2021-01-01&to=2021-12-31`, {
      headers: authHeaders(donoToken)
    });
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.equal(resposta.headers.get('content-disposition'), 'attachment; filename="receita-2021-01-01-a-2021-12-31.csv"');
    const texto = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await resposta.arrayBuffer());
    assert.ok(texto.startsWith('﻿Provedor;'));
    const linhas = texto.trim().split('\r\n');
    assert.equal(linhas.length, 3, texto);
    assert.ok(linhas[1].startsWith('"Provedor; ""Delta""";Receita Pro;200,00;BRL;paid;2021-03-01;2021-03-02 10:00:00;pay_rel_1;'), linhas[1]);
    assert.ok(linhas[2].endsWith(';refunded;2021-04-01;2021-04-02 10:00:00;pay_rel_2;2021-05-03 10:00:00'), linhas[2]);
  });

  it('refuses whoever is not a platform admin, and whoever has no session', async () => {
    for (const caminho of ['/reports/revenue', '/reports/revenue.csv']) {
      // 404, e não 403: para quem não é do console, o console não existe.
      const comum = await consulta(caminho, comumToken);
      assert.equal(comum.status, 404, caminho);
      assert.equal(typeof comum.body?.data?.mrrCents, 'undefined');
      const anonimo = await consulta(caminho, null);
      assert.equal(anonimo.status, 401, caminho);
    }
  });
});
