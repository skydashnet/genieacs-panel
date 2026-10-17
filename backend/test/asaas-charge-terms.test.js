import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { createCharge, updateCharge, chargeTermsFor } = await import('../src/services/billing/asaasClient.js');
const { AsaasBillingProvider } = await import('../src/services/billing/asaasBillingProvider.js');
const {
  save, invalidateAsaasSettings, earlyDiscountFor, CHARGES_DEFAULTS
} = await import('../src/services/billing/asaasSettingsService.js');

/**
 * Multa, juros e desconto por antecipação — os termos que a plataforma põe em
 * cada cobrança que emite no Asaas, e o que eles mudam na conferência do
 * pagamento.
 *
 * Self-hosted, pelo mesmo motivo de `billing-charge.test.js`: só fora da SaaS o
 * cliente fala com o gateway de mentira em `127.0.0.1`, e o que se assere aqui
 * é o corpo que SAI.
 *
 * O que não pode dar errado:
 *
 * 1. **Mandar termo desligado**, ou mandar termo numa cobrança de cartão.
 * 2. **O desconto levar a fatura abaixo de R$ 5,00.**
 * 3. **Chamar de "pago a menos" quem pagou com o desconto combinado**, dentro
 *    do prazo — e chamar de inteiro quem pagou com desconto FORA dele.
 * 4. **Chamar de erro a multa e os juros**, que chegam como pagamento a mais.
 */
const CHAVE = 'chave-dos-termos-da-cobranca';
const TOKEN = 'token-do-webhook-dos-termos';

let gateway;
let recebidas = [];
let panelUrl;
let alfa;
let planoPago;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(bruto || '{}'); } catch { payload = {}; }
      recebidas.push({ method: req.method, path: req.url.split('?')[0], payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'pay_termos_1',
        status: 'PENDING',
        value: payload.value,
        dueDate: payload.dueDate,
        invoiceUrl: 'https://gateway.exemplo.test/i/pay_termos_1'
      }));
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
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').where({ id: alfa })
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_termos', name: 'Provedor Alfa' });
  // A caixa da plataforma: é nela que os termos moram.
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  invalidateAsaasSettings();

  planoPago = await runInTenant(alfa, () => Plan.create({
    code: 'pago-termos', name: 'Pago', price_cents: 19990, currency: 'BRL', period_days: 30, active: true
  }));
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

/** Os termos, gravados do zero: o que não vem fica desligado. */
async function termos(campos = {}) {
  await save({ ...CHARGES_DEFAULTS, ...campos });
}

beforeEach(async () => {
  recebidas = [];
  await getDb()('billing_charges').del();
  await getDb()('billing_events').del();
  await termos();
});

const daquiA = (dias) => new Date(Date.now() + dias * 86_400_000);

async function assinar({ renewsAt = daquiA(2), status = 'active' } = {}) {
  await runInTenant(alfa, async () => {
    await Subscription.upsertForTenant(alfa, {
      plan_id: planoPago.id, status, renews_at: renewsAt, trial_ends_at: null
    });
    SubscriptionService.cache.invalidate();
  });
}

describe('o corpo que sai para o gateway', () => {
  it('sem termos ligados, nenhum campo a mais', async () => {
    await assinar();
    const res = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(res.issued, true, JSON.stringify(res));
    assert.deepEqual(Object.keys(recebidas[0].payload).sort(), [
      'billingType', 'customer', 'description', 'dueDate', 'externalReference', 'value'
    ]);
  });

  it('com multa, juros e desconto percentual, os três nos nomes do gateway', async () => {
    await termos({ finePercent: 2, interestMonthlyPercent: 1, discountKind: 'percent', discountValue: 10, discountDaysBefore: 5 });
    await assinar();
    const res = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(res.issued, true, JSON.stringify(res));
    const { payload } = recebidas[0];
    assert.deepEqual(payload.fine, { value: 2, type: 'PERCENTAGE' });
    assert.deepEqual(payload.interest, { value: 1 });
    assert.deepEqual(payload.discount, { value: 10, dueDateLimitDays: 5, type: 'PERCENTAGE' });
    assert.equal(payload.value, 199.9, 'o valor continua o cheio: o desconto é do gateway');
  });

  it('o desconto fixo vai em reais', async () => {
    await termos({ discountKind: 'fixed', discountValue: 2000 });
    await createCharge({
      customerRef: 'cus_termos', amountCents: 19990, dueDate: '2027-01-10', description: 'x', reference: 'r'
    });
    const { payload } = recebidas[0];
    assert.deepEqual(payload.discount, { value: 20, dueDateLimitDays: 0, type: 'FIXED' });
    assert.equal(payload.fine, undefined, 'multa desligada não vai');
    assert.equal(payload.interest, undefined);
  });

  it('e cobrança de cartão não leva nenhum dos três', async () => {
    await termos({ finePercent: 2, interestMonthlyPercent: 1, discountValue: 10 });
    assert.deepEqual(await chargeTermsFor(19990, { billingType: 'CREDIT_CARD' }), {});
    await createCharge({
      customerRef: 'cus_termos', amountCents: 19990, dueDate: '2027-01-10', description: 'x', reference: 'r',
      billingType: 'CREDIT_CARD', creditCardToken: 'tok_termos', remoteIp: '203.0.113.7'
    });
    const { payload } = recebidas[0];
    assert.equal(payload.billingType, 'CREDIT_CARD');
    assert.equal(payload.creditCardToken, 'tok_termos');
    assert.equal(payload.fine, undefined);
    assert.equal(payload.interest, undefined);
    assert.equal(payload.discount, undefined);
  });

  it('a atualização leva os termos; o desconto só quando o valor é conhecido', async () => {
    await termos({ finePercent: 2, discountValue: 10, discountDaysBefore: 2 });
    await updateCharge('pay_termos_1', { dueDate: '2027-02-10' });
    assert.deepEqual(recebidas[0].payload, {
      billingType: 'UNDEFINED', dueDate: '2027-02-10', fine: { value: 2, type: 'PERCENTAGE' }
    });

    await updateCharge('pay_termos_1', { value: 10000 });
    assert.deepEqual(recebidas[1].payload.discount, { value: 10, dueDateLimitDays: 2, type: 'PERCENTAGE' });

    await updateCharge('pay_termos_1', { dueDate: '2027-02-11', amountCents: 10000 });
    assert.deepEqual(recebidas[2].payload.discount, { value: 10, dueDateLimitDays: 2, type: 'PERCENTAGE' });

    await updateCharge('pay_termos_1', { value: 10000, billingType: 'CREDIT_CARD' });
    assert.equal(recebidas[3].payload.fine, undefined);
    assert.equal(recebidas[3].payload.discount, undefined);
  });
});

describe('a fatura de pró-rata (0101)', () => {
  it('sai pela mesma porta, com multa, juros e desconto', async () => {
    await termos({ finePercent: 2, interestMonthlyPercent: 1, discountKind: 'fixed', discountValue: 500, discountDaysBefore: 0 });
    await assinar({ renewsAt: daquiA(15) });
    const res = await runInTenant(alfa, async () => ChargeIssuingService.createProration({
      tenant: await Tenant.findById(alfa),
      subscription: await Subscription.forTenant(alfa),
      quote: {
        eligible: true, amountCents: 7500, currency: 'BRL', renewsAt: daquiA(15).toISOString(),
        fromPlanId: planoPago.id, toPlanId: planoPago.id + 1000, fromPriceCents: 10000, toPriceCents: 25000,
        remainingSeconds: 15 * 86_400, periodSeconds: 30 * 86_400, remainingDays: 15
      }
    }));
    assert.equal(res.issued, true, JSON.stringify(res));
    assert.equal(res.billingType, 'UNDEFINED');
    assert.equal(res.charge.billing_type, 'UNDEFINED');
    const { payload } = recebidas[0];
    assert.match(payload.externalReference, /:proration:/);
    assert.equal(payload.billingType, 'UNDEFINED');
    assert.deepEqual(payload.fine, { value: 2, type: 'PERCENTAGE' });
    assert.deepEqual(payload.interest, { value: 1 });
    assert.deepEqual(payload.discount, { value: 5, dueDateLimitDays: 0, type: 'FIXED' });
  });
});

describe('o piso de R$ 5,00', () => {
  it('a porcentagem que furaria o piso vira o fixo que para nele', async () => {
    const percent = { ...CHARGES_DEFAULTS, discountKind: 'percent', discountValue: 50, discountDaysBefore: 1 };
    assert.deepEqual(earlyDiscountFor(600, percent), {
      cents: 100, kind: 'fixed', percent: null, daysBefore: 1, clamped: true
    });
    await termos(percent);
    assert.deepEqual(
      (await chargeTermsFor(600)).discount,
      { value: 1, dueDateLimitDays: 1, type: 'FIXED' }
    );
  });

  it('o fixo maior que a folga é cortado no piso', async () => {
    const fixo = { ...CHARGES_DEFAULTS, discountKind: 'fixed', discountValue: 1000 };
    assert.equal(earlyDiscountFor(800, fixo).cents, 300);
    assert.equal(earlyDiscountFor(800, fixo).clamped, true);
    await termos(fixo);
    assert.deepEqual((await chargeTermsFor(800)).discount, { value: 3, dueDateLimitDays: 0, type: 'FIXED' });
  });

  it('a fatura no piso, ou abaixo, não tem desconto nenhum', async () => {
    const percent = { ...CHARGES_DEFAULTS, discountValue: 10 };
    assert.equal(earlyDiscountFor(500, percent), null);
    assert.equal(earlyDiscountFor(300, percent), null);
    await termos(percent);
    assert.equal((await chargeTermsFor(500)).discount, undefined);
  });

  it('e o desconto que cabe vai inteiro', () => {
    const percent = { ...CHARGES_DEFAULTS, discountValue: 10 };
    assert.deepEqual(earlyDiscountFor(19990, percent), {
      cents: 1999, kind: 'percent', percent: 10, daysBefore: 0, clamped: false
    });
    assert.equal(earlyDiscountFor(19990, CHARGES_DEFAULTS), null, 'desligado é nada');
  });
});

describe('a conferência do pagamento', () => {
  const VENCE = '2027-03-20';
  let periodo = 0;

  /** Uma cobrança emitida no Asaas, de 199,90, vencendo em `VENCE`. */
  async function emitida(gatewayId, { provider = 'asaas' } = {}) {
    periodo += 1;
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: `2028-${String(periodo).padStart(2, '0')}-01`,
        amountCents: 19990, currency: 'BRL', provider
      });
      await BillingCharge.markIssued(id, { gatewayChargeId: gatewayId, dueDate: VENCE });
    });
  }

  const pagar = (externalId, amountCents, extra = {}) => runInTenant(alfa, () => SubscriptionService.recordPayment({
    amountCents, currency: 'BRL', provider: 'asaas', externalId, now: new Date('2027-03-01T12:00:00Z'), ...extra
  }));
  const detalheDe = async (externalId) => {
    const linha = await getDb()('billing_events').where({ external_id: externalId }).first();
    return typeof linha.detail === 'string' ? JSON.parse(linha.detail) : linha.detail;
  };

  beforeEach(async () => {
    await termos({ finePercent: 2, interestMonthlyPercent: 1, discountKind: 'percent', discountValue: 10, discountDaysBefore: 5 });
    await assinar({ renewsAt: new Date('2027-03-20T15:00:00Z') });
  });

  it('o valor com desconto, pago até o limite, é pagamento inteiro', async () => {
    await emitida('pay_desc_ok');
    const res = await pagar('pay_desc_ok', 17991, { paidOn: '2027-03-15' });
    assert.equal(res.underpaid, false);
    assert.equal(res.duplicate, false);
    const detalhe = await detalheDe('pay_desc_ok');
    assert.equal(detalhe.underpaid, undefined);
    assert.equal(detalhe.expectedCents, 19990);
    assert.deepEqual(detalhe.earlyPaymentDiscount, {
      discountCents: 1999, discountedCents: 17991, paidOn: '2027-03-15', limitDate: '2027-03-15'
    });
    assert.ok(new Date(res.subscription.renews_at) > new Date('2027-04-01'), 'o período andou');
  });

  it('sem o dia do gateway, vale o dia de hoje no fuso da cobrança', async () => {
    await emitida('pay_desc_hoje');
    const res = await pagar('pay_desc_hoje', 17991);
    assert.equal(res.underpaid, false);
    assert.equal((await detalheDe('pay_desc_hoje')).earlyPaymentDiscount.paidOn, '2027-03-01');
  });

  it('pago depois do limite, o desconto não vale: é a menos', async () => {
    await emitida('pay_desc_tarde');
    const res = await pagar('pay_desc_tarde', 17991, { paidOn: '2027-03-16' });
    assert.equal(res.underpaid, true);
    const detalhe = await detalheDe('pay_desc_tarde');
    assert.equal(detalhe.underpaid, true);
    assert.equal(detalhe.shortfallCents, 1999);
    assert.equal(detalhe.earlyPaymentDiscount, undefined);
  });

  it('menos do que o valor com desconto continua a menos', async () => {
    await emitida('pay_desc_curto');
    const res = await pagar('pay_desc_curto', 17000, { paidOn: '2027-03-10' });
    assert.equal(res.underpaid, true);
  });

  it('com o desconto desligado, o mesmo valor é a menos', async () => {
    await termos({ finePercent: 2 });
    await emitida('pay_sem_desc');
    const res = await pagar('pay_sem_desc', 17991, { paidOn: '2027-03-10' });
    assert.equal(res.underpaid, true);
  });

  it('cobrança que não foi emitida no Asaas não ganha desconto', async () => {
    await emitida('pay_manual_desc', { provider: 'manual' });
    const res = await pagar('pay_manual_desc', 17991, { paidOn: '2027-03-10' });
    assert.equal(res.underpaid, true);
  });

  it('multa e juros chegam como pagamento a mais, sem alarme', async () => {
    await emitida('pay_com_juros');
    const res = await pagar('pay_com_juros', 20590, { paidOn: '2027-03-25' });
    assert.equal(res.underpaid, false);
    const detalhe = await detalheDe('pay_com_juros');
    assert.equal(detalhe.underpaid, undefined);
    assert.equal(detalhe.underpaymentAccepted, undefined);
    assert.equal(detalhe.earlyPaymentDiscount, undefined);
    assert.equal(detalhe.expectedCents, 19990);
  });
});

describe('os termos com que a cobrança saiu (revisão)', () => {
  const emitir = () => runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
    tenant: await Tenant.findById(alfa), manual: true
  }));
  const pagar = (amountCents) => runInTenant(alfa, () => SubscriptionService.recordPayment({
    amountCents, currency: 'BRL', provider: 'asaas', externalId: 'pay_termos_1',
    paidOn: ChargeIssuingService.isoDate(new Date())
  }));

  it('a configuração mudada depois da emissão não tira o desconto que a fatura levou', async () => {
    await assinar({ renewsAt: daquiA(2) });
    await termos({ discountKind: 'percent', discountValue: 10, discountDaysBefore: 0 });
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    const [linha] = await getDb()('billing_charges').where({ tenant_id: alfa });
    assert.deepEqual(JSON.parse(linha.discount_terms), {
      discount: { cents: 1999, kind: 'percent', percent: 10, daysBefore: 0 }
    });

    // O console desliga o desconto depois de a fatura sair…
    await termos();
    // …e quem pagou o valor com desconto que estava na fatura pagou o inteiro.
    const res = await pagar(17991);
    assert.equal(res.underpaid, false, JSON.stringify(res));
  });

  it('e o desconto ligado depois não vale para a fatura que saiu sem ele', async () => {
    await assinar({ renewsAt: daquiA(2) });
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    const [linha] = await getDb()('billing_charges').where({ tenant_id: alfa });
    assert.deepEqual(JSON.parse(linha.discount_terms), { discount: null });
    await termos({ discountKind: 'percent', discountValue: 10, discountDaysBefore: 0 });
    const res = await pagar(17991);
    assert.equal(res.underpaid, true);
  });

  it('a linha de antes da coluna continua conferida pela configuração de hoje', async () => {
    await assinar({ renewsAt: daquiA(2) });
    await emitir();
    await getDb()('billing_charges').where({ tenant_id: alfa }).update({ discount_terms: null });
    await termos({ discountKind: 'percent', discountValue: 10, discountDaysBefore: 0 });
    const res = await pagar(17991);
    assert.equal(res.underpaid, false);
  });
});

describe('pela rota do webhook', () => {
  const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
    method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: corpo
  });

  beforeEach(async () => {
    await termos({ discountKind: 'fixed', discountValue: 1990, discountDaysBefore: 0 });
    await assinar({ renewsAt: daquiA(10) });
  });

  it('lê o dia do pagamento do corpo', () => {
    const lido = AsaasBillingProvider.interpretar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'p', value: 10, clientPaymentDate: '2027-01-02', paymentDate: '2027-01-04' }
    });
    assert.equal(lido.paidOn, '2027-01-02');
    assert.equal(AsaasBillingProvider.interpretar({
      event: 'PAYMENT_RECEIVED', payment: { id: 'p', value: 10, paymentDate: 'ontem' }
    }).paidOn, null);
  });

  it('o pagamento com desconto no prazo quita a cobrança e estende o período', async () => {
    const vence = ChargeIssuingService.isoDate(daquiA(10));
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({ periodEnd: vence, amountCents: 19990, currency: 'BRL', provider: 'asaas' });
      await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_rota_desc', dueDate: vence });
    });
    const res = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_rota_desc', value: 180, originalValue: 199.9, customer: 'cus_termos',
        clientPaymentDate: ChargeIssuingService.isoDate(new Date())
      }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const cobranca = await getDb()('billing_charges').where({ gateway_charge_id: 'pay_rota_desc' }).first();
    assert.equal(cobranca.status, 'paid');
    const evento = await getDb()('billing_events').where({ external_id: 'pay_rota_desc' }).first();
    const detalhe = typeof evento.detail === 'string' ? JSON.parse(evento.detail) : evento.detail;
    assert.equal(detalhe.earlyPaymentDiscount.discountCents, 1990);
    assert.equal(detalhe.underpaid, undefined);
  });
});
