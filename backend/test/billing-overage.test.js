import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Coupon } = await import('../src/models/Coupon.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: UsagePeak } = await import('../src/models/UsagePeak.js');
const { BILLING_EVENT_TYPES } = await import('../src/models/BillingEvent.js');
const { default: SubscriptionService, PlanLimitError } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService, overageDescription } = await import('../src/services/chargeIssuingService.js');
const { default: CancellationService } = await import('../src/services/cancellationService.js');

/**
 * A cobrança por excedente (0105).
 *
 * Self-hosted, com o gateway de mentira em `127.0.0.1` de
 * `billing-proration.test.js`: o valor está no que SAI para o gateway.
 *
 * O que não pode dar errado, em dinheiro:
 *
 * 1. **O pico descer** — o maior uso do período é o que se cobra, e uma
 *    medição menor (ou a contagem de ONTs que falhou) não o apaga.
 * 2. **Cobrar duas vezes o mesmo período** — o excedente congela na linha, e
 *    toda reemissão do período (a cancelada reaberta, a troca de plano) dá o
 *    mesmo valor, mesmo que o pico tenha subido depois.
 * 3. **O cupom descontar o excedente** — ele vale só sobre o plano.
 * 4. **Bloquear quem paga** — com preço de excedente o teto não barra; sem
 *    preço, barra como sempre.
 */
const CHAVE = 'chave-do-excedente';
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
        const id = `pay_ex_${proximoId}`;
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

  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-excedente', password: 'senha-da-dona-1', email: 'dona@excedente.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  // Um operador de teto, R$ 10,00 por operador a mais; dois assinantes, R$ 2,00
  // cada um a mais; três ONTs, R$ 3,00 cada uma a mais.
  planos.medido = await criar({
    code: 'ex-medido', name: 'Medido', price_cents: 10000,
    max_operators: 1, max_subscribers: 2, max_devices: 3,
    overage_price_cents_operators: 1000, overage_price_cents_subscribers: 200, overage_price_cents_devices: 300
  });
  // Os mesmos tetos, sem preço nenhum: barra como sempre.
  planos.duro = await criar({
    code: 'ex-duro', name: 'Duro', price_cents: 8000, max_operators: 1, max_subscribers: 2, max_devices: 3
  });
  // Teto folgado, o mesmo preço por operador a mais: subir para ele não
  // apaga o excedente já medido no plano de teto 1.
  planos.folgado = await criar({
    code: 'ex-folgado', name: 'Folgado', price_cents: 30000, max_operators: 10, overage_price_cents_operators: 1000
  });
  // O anual (0104) com excedente: R$ 100/mês ou R$ 1.000/ano, R$ 10 por operador a mais.
  planos.anual = await criar({
    code: 'ex-anual', name: 'Anual', price_cents: 10000, price_yearly_cents: 100000,
    max_operators: 1, overage_price_cents_operators: 1000
  });
  planos.maior = await criar({
    code: 'ex-maior', name: 'Maior', price_cents: 20000,
    max_operators: 1, overage_price_cents_operators: 1000
  });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

/** Um instante relativo a agora, ao segundo (o MySQL guarda segundos). */
const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DIA) / 1000) * 1000);

async function assinar({
  plan = planos.medido, status = 'active', renewsAt = daquiA(3), trialEndsAt = null, coupon = null, cycle = 'monthly'
} = {}) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: plan.id,
    billing_cycle: cycle,
    pending_billing_cycle: null,
    cancel_at: null,
    paused_until: null,
    pause_started_at: null,
    status,
    renews_at: renewsAt,
    trial_ends_at: trialEndsAt,
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
const renovacoes = async () => (await getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id'))
  .filter((c) => c.kind !== 'proration');
const postsDeRenovacao = () => recebidas.filter((r) => r.method === 'POST' && r.path === '/payments'
  && !/:proration:/.test(r.payload?.externalReference ?? ''));
const chaveDe = (instante) => ChargeIssuingService.periodKey(instante);
const emitir = (opcoes = {}) => runInTenant(alfa, () => ChargeIssuingService.issueCurrent({ ...opcoes }));
const picar = (periodo, recurso, valor) => runInTenant(alfa, () => UsagePeak.record(periodo, recurso, valor));
const pedir = (caminho, { method = 'GET', body } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(donoToken), ...(body === undefined ? {} : { body })
});

beforeEach(async () => {
  recebidas = [];
  await getDb()('billing_charges').where({ tenant_id: alfa }).del();
  await getDb()('billing_events').where({ tenant_id: alfa }).del();
  await getDb()('usage_peaks').where({ tenant_id: alfa }).del();
  await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa' });
  await assinar();
});

describe('o pico de uso do período', () => {
  it('só sobe, e cada período tem o seu', async () => {
    assert.equal(await picar('2026-11-01', 'operators', 5), 5);
    assert.equal(await picar('2026-11-01', 'operators', 3), 5, 'uma medição menor não desce o pico');
    assert.equal(await picar('2026-11-01', 'operators', 7), 7);
    assert.equal(await picar('2026-12-01', 'operators', 2), 2, 'o período seguinte começa do zero');
    const novembro = await runInTenant(alfa, () => UsagePeak.forPeriod('2026-11-01'));
    assert.deepEqual(novembro, { operators: 7, subscribers: null, devices: null });
    const linhas = await getDb()('usage_peaks').where({ tenant_id: alfa, period_end: '2026-11-01' });
    assert.equal(linhas.length, 1, 'uma linha por período e recurso');
  });

  it('o passo do agendador grava o período corrente, com as contagens de agora', async () => {
    const assinatura = await linha();
    const periodo = chaveDe(assinatura.renews_at);
    const r = await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({ countDevices: async () => 9 }));
    assert.equal(r.recorded, true);
    assert.equal(r.periodEnd, periodo);
    const picos = await runInTenant(alfa, () => UsagePeak.forPeriod(periodo));
    assert.equal(picos.operators, 1, 'a dona');
    assert.equal(picos.devices, 9);
    // Menos ONTs agora: o pico fica.
    await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({ countDevices: async () => 4 }));
    assert.equal((await runInTenant(alfa, () => UsagePeak.forPeriod(periodo))).devices, 9);
  });

  it('a contagem de ONTs que falha não mexe no pico (nem o cria)', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({
      countDevices: async () => { throw new Error('ACS fora do ar'); }
    }));
    assert.equal((await runInTenant(alfa, () => UsagePeak.forPeriod(periodo))).devices, null);
    await picar(periodo, 'devices', 8);
    await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({
      countDevices: async () => { throw new Error('ACS fora do ar'); }
    }));
    await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({ countDevices: async () => null }));
    assert.equal((await runInTenant(alfa, () => UsagePeak.forPeriod(periodo))).devices, 8);
  });

  it('não mede sem período pago, nem plano sem preço de excedente', async () => {
    await assinar({ status: 'trial', renewsAt: null, trialEndsAt: daquiA(5) });
    assert.equal((await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks())).reason, 'no_period');
    await assinar({ plan: planos.duro });
    assert.equal((await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks())).reason, 'no_overage_price');
    assert.equal((await getDb()('usage_peaks').where({ tenant_id: alfa })).length, 0);
  });
});

describe('o excedente na renovação', () => {
  it('soma max(0, pico − teto) × preço ao preço do plano, e diz a conta', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await picar(periodo, 'operators', 4); // 3 a mais × R$ 10,00
    await picar(periodo, 'subscribers', 2); // no teto: nada
    await picar(periodo, 'devices', 8); // 5 a mais × R$ 3,00
    const r = await emitir();
    assert.equal(r.issued, true, JSON.stringify(r));
    assert.equal(r.amountCents, 10000 + 3000 + 1500);

    const [cobranca] = await renovacoes();
    assert.equal(Number(cobranca.amount_cents), 14500);
    assert.equal(cobranca.period_end, periodo);
    const conta = BillingCharge.pricingDetailOf(cobranca);
    assert.equal(conta.base, 10000);
    assert.deepEqual(conta.overage, [
      { resource: 'operators', peak: 4, limit: 1, unitCents: 1000, units: 3, cents: 3000, periodKey: periodo },
      { resource: 'devices', peak: 8, limit: 3, unitCents: 300, units: 5, cents: 1500, periodKey: periodo }
    ]);

    const [post] = postsDeRenovacao();
    assert.equal(post.payload.value, 145);
    assert.match(post.payload.description, /excedente R\$ 45,00 \(3 operadores × R\$ 10,00; 5 ONTs × R\$ 3,00\)/);

    // As telas leem a mesma conta.
    const vista = BillingCharge.present(cobranca);
    assert.equal(vista.pricing.baseCents, 10000);
    assert.equal(vista.pricing.overageCents, 4500);
    assert.equal(vista.pricing.overage.length, 2);
    const charges = await pedir('/charges');
    assert.equal(charges.status, 200);
    const lista = charges.body.data.charges ?? charges.body.data;
    assert.equal(lista[0].pricing.overageCents, 4500);
  });

  it('sem excedente, a conta tem só o plano e a descrição não muda', async () => {
    const r = await emitir();
    assert.equal(r.issued, true);
    assert.equal(r.amountCents, 10000);
    const [cobranca] = await renovacoes();
    assert.deepEqual(BillingCharge.pricingDetailOf(cobranca), { base: 10000, overage: [] });
    assert.doesNotMatch(postsDeRenovacao()[0].payload.description, /excedente/);
  });

  it('o cupom vale só sobre o plano, não sobre o excedente', async () => {
    sequencia += 1;
    const cupom = await Coupon.create({
      code: `EXCEDE${sequencia}`, kind: 'percent', value: 50, duration: 'repeating', duration_cycles: 3,
      redemptions: 0, active: true
    });
    await assinar({ coupon: cupom });
    const periodo = chaveDe((await linha()).renews_at);
    await picar(periodo, 'operators', 3); // 2 × R$ 10,00
    const r = await emitir();
    assert.equal(r.amountCents, 5000 + 2000, 'metade do plano, o excedente inteiro');
    const [cobranca] = await renovacoes();
    assert.equal(BillingCharge.pricingDetailOf(cobranca).base, 5000);
    assert.equal(Number(cobranca.coupon_id), cupom.id);
  });

  it('o teste não tem excedente: a primeira fatura é só o plano', async () => {
    await assinar({ status: 'trial', renewsAt: null, trialEndsAt: daquiA(3) });
    await picar(chaveDe(daquiA(3)), 'operators', 9);
    const r = await emitir();
    assert.equal(r.issued, true);
    assert.equal(r.amountCents, 10000);
  });

  it('plano sem preço de excedente: o pico não vira dinheiro', async () => {
    await assinar({ plan: planos.duro });
    await picar(chaveDe((await linha()).renews_at), 'operators', 9);
    assert.equal((await emitir()).amountCents, 8000);
  });

  it('reemitir o mesmo período dá o mesmo valor, mesmo com o pico maior depois', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await picar(periodo, 'operators', 3);
    assert.equal((await emitir()).amountCents, 12000);
    const [primeira] = await renovacoes();

    // O pico sobe depois de a fatura sair, e a cobrança é cancelada e
    // reaberta pelo clique: a conta congelada vale.
    await picar(periodo, 'operators', 10);
    await getDb()('billing_charges').where({ id: primeira.id }).update({ status: 'canceled' });
    const reaberta = await emitir({ manual: true });
    assert.equal(reaberta.issued, true, JSON.stringify(reaberta));
    assert.equal(reaberta.amountCents, 12000);

    // A passada seguinte do agendador não mexe na que já saiu.
    const de_novo = await emitir();
    assert.equal(de_novo.reason, 'already_issued');
    const [depois] = await renovacoes();
    assert.equal(Number(depois.amount_cents), 12000);
    assert.equal(BillingCharge.overageCentsOf(depois), 2000);
    assert.equal(postsDeRenovacao().length, 2, 'a primeira e a reemitida, nenhuma a mais');
  });

  it('a troca de plano reemite com o preço novo e o MESMO excedente', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await picar(periodo, 'operators', 3);
    assert.equal((await emitir()).amountCents, 12000);
    await picar(periodo, 'operators', 6);

    const troca = await pedir('/subscription/plan', { method: 'PUT', body: { planId: planos.maior.id } });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    const [cobranca] = await renovacoes();
    assert.equal(Number(cobranca.amount_cents), 20000 + 2000, 'o plano novo, o excedente congelado');
    const conta = BillingCharge.pricingDetailOf(cobranca);
    assert.equal(conta.base, 20000);
    assert.equal(BillingCharge.overageCentsOf(cobranca), 2000);
    // A pró-rata da subida não leva excedente nenhum.
    const prorata = (await getDb()('billing_charges').where({ tenant_id: alfa, kind: 'proration' }))[0];
    if (prorata) assert.equal(BillingCharge.overageCentsOf(prorata), 0);
  });

  it('o valor mudado à mão pelo console vence a conta', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await picar(periodo, 'operators', 3);
    const id = await runInTenant(alfa, () => BillingCharge.open({
      periodEnd: periodo, amountCents: 7777, currency: 'BRL', provider: 'asaas'
    }));
    await getDb()('billing_charges').where({ id }).update({ amount_overridden_at: new Date(), issuing_until: null });
    const r = await emitir();
    assert.equal(r.issued, true, JSON.stringify(r));
    assert.equal(r.amountCents, 7777);
    assert.doesNotMatch(postsDeRenovacao()[0].payload.description, /excedente/);
  });

  it('o pagamento confere contra o valor com excedente, e o estorno o desfaz como qualquer outro', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await picar(periodo, 'operators', 3);
    await emitir();
    const [cobranca] = await renovacoes();
    const antes = await linha();

    // Só o preço do plano é "pago a menos": o excedente faz parte do pedido.
    const menos = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 10000, provider: 'asaas', externalId: `${cobranca.gateway_charge_id}-parcial`, chargeId: cobranca.id
    }));
    assert.equal(menos.underpaid, true);
    assert.equal(menos.expectedCents, 12000);

    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 12000, provider: 'asaas', externalId: cobranca.gateway_charge_id
    }));
    assert.equal(pago.underpaid ?? false, false);
    // O preço do plano (sem o excedente) vai no evento, para a receita.
    const evento = await getDb()('billing_events')
      .where({ tenant_id: alfa, external_id: cobranca.gateway_charge_id }).first();
    assert.equal(JSON.parse(evento.detail).baseCents, 10000);
    assert.equal(JSON.parse(evento.detail).expectedCents, 12000);
    const depois = await linha();
    assert.ok(new Date(depois.renews_at).getTime() > new Date(antes.renews_at).getTime(), 'o período andou');

    const estorno = await runInTenant(alfa, () => SubscriptionService.reversePayment({
      externalId: cobranca.gateway_charge_id, source: 'webhook'
    }));
    assert.equal(estorno.found, true);
    const voltou = await linha();
    assert.equal(new Date(voltou.renews_at).getTime(), new Date(antes.renews_at).getTime(), 'o prazo voltou');
    const refund = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED }).first();
    assert.equal(Number(refund.amount_cents), 12000, 'devolve o valor inteiro, com o excedente');
  });

  it('a descrição resume as parcelas', () => {
    assert.equal(overageDescription([]), '');
    assert.equal(
      overageDescription([{ resource: 'subscribers', units: 1500, unitCents: 150, cents: 225000 }]),
      ' + excedente R$ 2.250,00 (1500 assinantes × R$ 1,50)'
    );
  });
});

describe('com preço não bloqueia; sem preço, bloqueia', () => {
  it('operador: o 402 só no plano sem preço', async () => {
    await assinar({ plan: planos.duro });
    await assert.rejects(
      runInTenant(alfa, () => SubscriptionService.assertCanAddOperator()),
      (error) => error instanceof PlanLimitError && error.code === 'plan_limit_operators'
    );
    const recusado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donoToken),
      body: { username: 'ex-recusado', password: 'senha-recusado-1', role: 'viewer', email: 'ex-recusado@exemplo.test' }
    });
    assert.equal(recusado.status, 402);
    assert.equal(recusado.body.code, 'plan_limit_operators');

    await assinar({ plan: planos.medido });
    await runInTenant(alfa, () => SubscriptionService.assertCanAddOperator());
    const aceito = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donoToken),
      body: { username: 'ex-aceito', password: 'senha-aceito-123', role: 'viewer', email: 'ex-aceito@exemplo.test' }
    });
    assert.equal(aceito.status, 201, JSON.stringify(aceito.body));

    // A tela diz quanto vai à próxima fatura.
    const tela = await pedir('/subscription');
    assert.equal(tela.status, 200);
    const { overage } = tela.body.data;
    assert.equal(overage.prices.operators, 1000);
    assert.deepEqual(overage.items.map((i) => [i.resource, i.units, i.cents]), [['operators', 1, 1000]]);
    assert.equal(overage.totalCents, 1000);
    await getDb()('tenant_users').where({ tenant_id: alfa })
      .whereIn('user_id', getDb()('users').select('id').where({ username: 'ex-aceito' })).del();
  });

  it('assinante: o teto brando só sem preço', async () => {
    await assinar({ plan: planos.duro });
    assert.equal(await runInTenant(alfa, () => SubscriptionService.remainingSubscribers()), 2);
    await assinar({ plan: planos.medido });
    assert.equal(await runInTenant(alfa, () => SubscriptionService.remainingSubscribers()), null);
  });

  it('troca de plano e descida agendada: o recurso com preço não barra', async () => {
    const usoAlto = { operators: 5, subscribers: 9, devices: 20 };
    assert.equal(SubscriptionService.overLimitFor(
      SubscriptionService.limitsOf(planos.medido), usoAlto, SubscriptionService.overagePricesOf(planos.medido)
    ), null);
    assert.deepEqual(SubscriptionService.overLimitFor(
      SubscriptionService.limitsOf(planos.duro), usoAlto, SubscriptionService.overagePricesOf(planos.duro)
    ), { resource: 'operators', used: 5, limit: 1 });
    // Só parte com preço: barra no que não tem.
    const parcial = { ...planos.duro, overage_price_cents_operators: 500 };
    assert.deepEqual(SubscriptionService.overLimitFor(
      SubscriptionService.limitsOf(parcial), usoAlto, SubscriptionService.overagePricesOf(parcial)
    ), { resource: 'subscribers', used: 9, limit: 2 });

    // Pela rota: dois operadores (a dona e mais um), descida na hora (atraso).
    await assinar({ plan: planos.maior });
    const contratado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donoToken),
      body: { username: 'ex-segundo', password: 'senha-segundo-123', role: 'viewer', email: 'ex-segundo@exemplo.test' }
    });
    assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
    try {
      await assinar({ plan: planos.maior, status: 'past_due', renewsAt: daquiA(-3) });
      const barrada = await pedir('/subscription/plan', { method: 'PUT', body: { planId: planos.duro.id } });
      assert.equal(barrada.status, 409);
      assert.equal(barrada.body.code, 'over_limit');
      const aceita = await pedir('/subscription/plan', { method: 'PUT', body: { planId: planos.medido.id } });
      assert.equal(aceita.status, 200, JSON.stringify(aceita.body));
      assert.equal((await linha()).plan_id, planos.medido.id);

      // A descida agendada aplica-se na data: com preço, o uso não a segura.
      await assinar({ plan: planos.maior });
      await Subscription.upsertForTenant(alfa, { pending_plan_id: planos.medido.id, pending_plan_at: daquiA(-1) });
      const aplicada = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan());
      assert.equal(aplicada.applied, true, JSON.stringify(aplicada));

      await assinar({ plan: planos.maior });
      await Subscription.upsertForTenant(alfa, { pending_plan_id: planos.duro.id, pending_plan_at: daquiA(-1) });
      const segura = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan());
      assert.equal(segura.applied, false);
      assert.equal(segura.reason, 'over_limit');
    } finally {
      await getDb()('tenant_users').where({ tenant_id: alfa })
        .whereIn('user_id', getDb()('users').select('id').where({ username: 'ex-segundo' })).del();
    }
  });
});

const fotografar = (periodo, recurso, valor, limit, unitCents) => runInTenant(alfa, () => UsagePeak.record(
  periodo, recurso, valor, { limit, unitCents }
));
const avulsas = async () => (await getDb()('billing_charges').where({ tenant_id: alfa, kind: 'overage' }).orderBy('id'));

describe('a fotografia do plano no pico (0105)', () => {
  it('subir de plano antes da fatura não apaga o excedente já medido', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await fotografar(periodo, 'operators', 3, 1, 1000); // 2 a mais × R$ 10 no plano de teto 1
    await assinar({ plan: planos.folgado });
    // No plano novo (teto 10) a mesma medição não deve nada: não troca a fotografia.
    await fotografar(periodo, 'operators', 4, 10, 1000);
    const r = await emitir();
    assert.equal(r.issued, true, JSON.stringify(r));
    assert.equal(r.amountCents, 30000 + 2000, 'o excedente do plano em que foi medido');
    const [c] = await renovacoes();
    const [parcela] = BillingCharge.frozenOverageOf(c);
    assert.equal(parcela.limit, 1);
    assert.equal(parcela.peak, 3);
    assert.equal(parcela.units, 2);
  });

  it('fica a fotografia que deve mais; a linha sem fotografia usa o plano de agora', async () => {
    const periodo = chaveDe((await linha()).renews_at);
    await fotografar(periodo, 'operators', 3, 1, 1000); // deve 2000
    await fotografar(periodo, 'operators', 2, 1, 1000); // deve 1000: fica a de cima
    let [linhaDoPico] = await getDb()('usage_peaks').where({ tenant_id: alfa, period_end: periodo });
    assert.equal(Number(linhaDoPico.overage_peak), 3);
    await fotografar(periodo, 'operators', 3, 0, 1000); // teto menor: deve 3000, troca
    [linhaDoPico] = await getDb()('usage_peaks').where({ tenant_id: alfa, period_end: periodo });
    assert.equal(Number(linhaDoPico.limit_value), 0);
    assert.equal(Number(linhaDoPico.peak), 3);
    // O passo do agendador grava a fotografia junto.
    await getDb()('usage_peaks').where({ tenant_id: alfa }).del();
    await runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({ countDevices: async () => 9 }));
    const gravadas = await getDb()('usage_peaks').where({ tenant_id: alfa, period_end: periodo, resource: 'devices' }).first();
    assert.equal(Number(gravadas.limit_value), 3);
    assert.equal(Number(gravadas.unit_cents), 300);
  });
});

describe('o acerto do período congelado cedo (true-up)', () => {
  it('o pico que subiu depois da fatura entra na seguinte, uma vez só', async () => {
    const renova = (await linha()).renews_at;
    const atual = chaveDe(renova);
    const anterior = chaveDe(new Date(new Date(renova).getTime() - 30 * DIA));
    // A fatura do período anterior congelou 2 operadores a mais (R$ 20)…
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: anterior, amountCents: 12000, currency: 'BRL', provider: 'asaas',
        pricingDetail: { base: 10000, overage: [{ resource: 'operators', peak: 3, limit: 1, unitCents: 1000, units: 2, cents: 2000, periodKey: anterior }] }
      });
      await BillingCharge.update(id, { status: 'paid', issuing_until: null, gateway_charge_id: 'pay_anterior' });
    });
    // …e o pico do período anterior subiu para 5 depois de ela sair.
    await fotografar(anterior, 'operators', 5, 1, 1000);
    const r = await emitir();
    assert.equal(r.issued, true, JSON.stringify(r));
    assert.equal(r.amountCents, 10000 + 2000, 'R$ 20 de acerto: 4 a mais agora, 2 já cobrados');
    const [, c] = await renovacoes();
    assert.equal(c.period_end, atual);
    const [acerto] = BillingCharge.frozenOverageOf(c);
    assert.equal(acerto.kind, 'true_up');
    assert.equal(acerto.periodKey, anterior);
    assert.equal(acerto.units, 2);
    // Reemitir não recalcula; e o período anterior não tem outro acerto.
    assert.deepEqual(await runInTenant(alfa, () => ChargeIssuingService.trueUpFor({ plan: planos.medido, periodo: atual })), []);
    await getDb()('billing_charges').where({ id: c.id }).update({ status: 'canceled' });
    await fotografar(anterior, 'operators', 9, 1, 1000);
    assert.equal((await emitir({ manual: true })).amountCents, 12000, 'a conta congelada vale');
  });

  it('a fatura de antes da conta (sem `pricing_detail`) não ganha acerto', async () => {
    const renova = (await linha()).renews_at;
    const anterior = chaveDe(new Date(new Date(renova).getTime() - 30 * DIA));
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({ periodEnd: anterior, amountCents: 10000, currency: 'BRL', provider: 'asaas' });
      await BillingCharge.update(id, { status: 'paid', issuing_until: null });
    });
    await fotografar(anterior, 'operators', 5, 1, 1000);
    assert.equal((await emitir()).amountCents, 10000);
  });
});

describe('o excedente do anual, em fatias mensais', () => {
  it('as fatias que terminaram viram uma fatura de só excedente, que não compra período', async () => {
    // O ano começou há 65 dias: duas fatias de 30 dias já terminaram.
    const renova = daquiA(300);
    await assinar({ plan: planos.anual, cycle: 'annual', renewsAt: renova });
    const assinatura = await linha();
    const fatias = SubscriptionService.overageSlices(assinatura, planos.anual);
    assert.equal(fatias.length, 12);
    assert.equal(fatias[11].key, chaveDe(renova), 'a última fatia é a do prazo');
    assert.equal(SubscriptionService.usagePeakKey(assinatura, planos.anual), fatias[2].key, 'mede na fatia corrente');
    await fotografar(fatias[0].key, 'operators', 4, 1, 1000); // R$ 30
    await fotografar(fatias[1].key, 'operators', 2, 1, 1000); // R$ 10

    const r = await runInTenant(alfa, () => ChargeIssuingService.issueOverageSlices());
    assert.equal(r.issued, true, JSON.stringify(r));
    const [avulsa] = await avulsas();
    assert.equal(Number(avulsa.amount_cents), 4000);
    assert.equal(avulsa.period_end, BillingCharge.overageKey(fatias[1].key));
    const post = recebidas.find((x) => x.method === 'POST' && /:overage:/.test(x.payload?.externalReference ?? ''));
    assert.ok(post, 'foi ao gateway');
    assert.match(post.payload.description, /excedente/);
    // A seguinte passada não cobra de novo.
    assert.equal((await runInTenant(alfa, () => ChargeIssuingService.issueOverageSlices())).reason, 'covered');

    // Paga: não move o prazo.
    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 4000, provider: 'asaas', externalId: avulsa.gateway_charge_id
    }));
    assert.equal(pago.proration, true);
    assert.equal(new Date((await linha()).renews_at).getTime(), renova.getTime());
  });

  it('abaixo do mínimo, as fatias esperam — e a renovação anual soma as que sobraram, sem cobrar duas vezes', async () => {
    const renova = daquiA(3);
    await assinar({ plan: planos.anual, cycle: 'annual', renewsAt: renova });
    const fatias = SubscriptionService.overageSlices(await linha(), planos.anual);
    await fotografar(fatias[3].key, 'operators', 2, 1, 300); // R$ 3: abaixo do mínimo
    await fotografar(fatias[11].key, 'operators', 3, 1, 1000); // R$ 20 na última fatia
    // Uma fatia já cobrada por uma avulsa não volta.
    await fotografar(fatias[0].key, 'operators', 9, 1, 1000);
    await runInTenant(alfa, () => BillingCharge.openProration({
      key: BillingCharge.overageKey(fatias[0].key), kind: 'overage', amountCents: 8000, currency: 'BRL', provider: 'asaas',
      detail: { slices: [fatias[0].key], periodEnd: fatias[0].key }
    }));
    const r = await runInTenant(alfa, () => ChargeIssuingService.issueOverageSlices());
    assert.equal(r.reason, 'below_minimum');
    const emitida = await emitir();
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    assert.equal(emitida.amountCents, 100000 + 300 + 2000);
    const renovacao = (await getDb()('billing_charges').where({ tenant_id: alfa, kind: 'renewal' }))[0];
    const chaves = BillingCharge.frozenOverageOf(renovacao).map((i) => i.periodKey);
    assert.deepEqual(chaves, [fatias[3].key, fatias[11].key]);
    // Depois da renovação congelar a fatia, a avulsa não a cobra.
    const depois = await runInTenant(alfa, () => ChargeIssuingService.issueOverageSlices());
    assert.equal(depois.issued, false);
    assert.equal(depois.reason, 'no_overage', 'as fatias que sobram não devem nada');
    assert.equal((await avulsas()).length, 1, 'só a que já existia');
  });
});

describe('o excedente final de quem cancela', () => {
  it('o cancelamento agendado que chega emite a fatura final de só excedente', async () => {
    const prazo = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    await assinar({ renewsAt: prazo });
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ cancel_at: prazo });
    await SubscriptionService.invalidate(alfa);
    await fotografar(chaveDe(prazo), 'operators', 4, 1, 1000); // R$ 30
    const r = await runInTenant(alfa, () => CancellationService.processDue({}));
    assert.equal(r.action, 'canceled');
    assert.equal((await linha()).status, 'canceled');
    const [final] = await avulsas();
    assert.ok(final, 'saiu a fatura final');
    assert.equal(Number(final.amount_cents), 3000);
    assert.equal(final.period_end, BillingCharge.overageKey(chaveDe(prazo), { final: true }));
    assert.ok(final.gateway_charge_id, 'foi ao gateway mesmo cancelada');
    // Paga: o cancelado continua cancelado, nada de prazo.
    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 3000, provider: 'asaas', externalId: final.gateway_charge_id
    }));
    assert.equal(pago.underpaid, false);
    assert.equal((await linha()).status, 'canceled');
  });

  it('sem excedente, nada sai', async () => {
    const prazo = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    await assinar({ renewsAt: prazo });
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ cancel_at: prazo });
    await SubscriptionService.invalidate(alfa);
    await runInTenant(alfa, () => CancellationService.processDue({}));
    assert.equal((await avulsas()).length, 0);
  });
});
