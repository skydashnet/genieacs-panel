import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Coupon } = await import('../src/models/Coupon.js');
const { default: BillingCharge, RETENTION_CANCEL_MARKER } = await import('../src/models/BillingCharge.js');
const {
  default: SubscriptionService, GATE_CODES, overdueSince
} = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const {
  default: CancellationService, addMonths, retentionCouponCode
} = await import('../src/services/cancellationService.js');
const {
  saveProfile, retentionConfig, invalidatePlatformProfile
} = await import('../src/services/platformProfileService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');
const { default: platformReportsRoutes } = await import('../src/routes/platformReports.js');

/**
 * A retenção no cancelamento (0107).
 *
 * O dono pede para cancelar, diz o motivo, e recebe as ofertas: desconto
 * (cupom de retenção, uma vez a cada doze meses) ou pausa (sem cobrança até
 * `paused_until`). Recusando, o cancelamento é agendado para o fim do período
 * pago e o agendador o cumpre na data. O que este arquivo garante, acima de
 * tudo, é o dinheiro: nenhuma fatura sai durante a pausa nem depois do
 * cancelamento agendado, a fatura que já tinha saído é cancelada no gateway
 * ANTES de a decisão ser gravada (e a recusa do gateway não muda nada), e a
 * cobrança volta sozinha no fim da pausa.
 *
 * Self-hosted, pelo motivo de `tenant-self-billing.test.js`: o Asaas de
 * mentira mora no loopback. A porta da assinatura (só SaaS) é conferida pela
 * decisão pura (`SubscriptionService.decide`).
 *
 * As datas são ao segundo: o MySQL guarda ao segundo e ARREDONDA.
 */
const CHAVE = 'chave-da-retencao';
const DIA = 24 * 60 * 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const daquiA = (dias) => aoSegundo(Date.now() + dias * DIA);

let gateway;
let recebidas = [];
let proximoId = 0;
let recusarCancelamento = false;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let adminToken;
let viewerToken;
let alfa;
let caixa;
let plano;
let outroPlano;

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
      if (req.method === 'POST' && caminho === '/customers') return responder(200, { id: 'cus_alfa' });
      if (req.method === 'POST' && caminho === '/payments') {
        proximoId += 1;
        const id = `pay_ret_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      const umaCobranca = /^\/payments\/([^/]+)$/.exec(caminho);
      if (req.method === 'DELETE' && umaCobranca) {
        if (recusarCancelamento) return responder(500, { errors: [{ description: 'cancelamento recusado' }] });
        return responder(200, { deleted: true, id: decodeURIComponent(umaCobranca[1]) });
      }
      if (req.method === 'GET' && umaCobranca) return responder(200, { id: umaCobranca[1], status: 'PENDING' });
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

/** O roteador do console de verdade, num app mínimo — como em platform-subscriptions.test.js. */
function subirConsole() {
  const app = express();
  app.use(express.json());
  app.use(attachLocale);
  app.use('/api', resolveTenant);
  app.use('/api/platform', platformBillingRoutes);
  app.use('/api/platform', platformReportsRoutes);
  return new Promise((resolve) => {
    consoleServer = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${consoleServer.address().port}`));
  });
}

const pedir = (caminho, { method = 'GET', body, token = donoToken } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(token), ...(body === undefined ? {} : { body })
});
const plataforma = (caminho, { method = 'GET', token = donoToken } = {}) => call(`${consoleUrl}/api/platform${caminho}`, {
  method, headers: authHeaders(token)
});
const pedirCancelamento = (reason = 'too_expensive', comment = 'caro demais para nós') => pedir(
  '/subscription/cancellation', { method: 'POST', body: { reason, comment } }
);
const aceitar = (offer, months) => pedir('/subscription/cancellation/accept', {
  method: 'POST', body: { offer, ...(months === undefined ? {} : { months }) }
});
const confirmar = () => pedir('/subscription/cancellation/confirm', { method: 'POST' });
const desfazer = () => pedir('/subscription/cancellation', { method: 'DELETE' });

const assinatura = () => Subscription.forTenant(alfa);
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');
const pedidos = () => getDb()('cancellation_requests').where({ tenant_id: alfa }).orderBy('id');
const eventos = (tipo) => getDb()('billing_events').where({ tenant_id: alfa, type: tipo }).orderBy('id');
const criados = () => recebidas.filter((r) => r.method === 'POST' && r.path === '/payments');
const cancelados = () => recebidas.filter((r) => r.method === 'DELETE');
const emitir = (opcoes = {}) => runInTenant(alfa, () => ChargeIssuingService.issueCurrent(opcoes));
const cumprir = (now) => runInTenant(alfa, () => CancellationService.processDue({ now }));

async function assinar(patch = {}) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: plano.id, status: 'active', renews_at: daquiA(2), trial_ends_at: null, canceled_at: null,
    pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null, upgraded_at: null,
    coupon_id: null, coupon_cycles_left: null, coupon_applied_at: null, billing_exempt_at: null,
    suspended_reason: null, cancel_at: null, paused_until: null, pause_started_at: null, proration_due_at: null,
    ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

/** Uma cobrança de renovação já emitida no gateway para o prazo vivo. */
async function cobrancaEmitida({ gatewayChargeId = 'pay_existente', amountCents = 10000 } = {}) {
  const sub = await assinatura();
  const prazo = new Date(sub.renews_at ?? sub.trial_ends_at);
  return runInTenant(alfa, async () => {
    const id = await BillingCharge.open({
      periodEnd: ChargeIssuingService.periodKey(prazo),
      amountCents,
      currency: 'BRL',
      provider: 'asaas',
      dueDate: ChargeIssuingService.isoDate(prazo)
    });
    await BillingCharge.update(id, {
      gateway_charge_id: gatewayChargeId, invoice_url: `https://gateway.exemplo.test/i/${gatewayChargeId}`
    });
    return id;
  });
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });

  for (const [username, role] of [['o-admin', 'admin'], ['so-olha', 'viewer']]) {
    // eslint-disable-next-line no-await-in-loop
    const criado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donoToken),
      body: { username, password: `senha-de-${username}-1`, role, email: `${username}@exemplo.test` }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
  }
  const entrar = async (username) => (await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username, password: `senha-de-${username}-1` }
  })).body?.data?.token;
  adminToken = await entrar('o-admin');
  viewerToken = await entrar('so-olha');
  assert.ok(adminToken && viewerToken);

  const db = getDb();
  alfa = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  resetDeploymentSharing();
  plano = await Plan.create({
    code: 'ret-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  outroPlano = await Plan.create({
    code: 'ret-max', name: 'Max', price_cents: 20000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => consoleServer.close(r));
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  recusarCancelamento = false;
  const db = getDb();
  await db('billing_charges').where({ tenant_id: alfa }).del();
  await db('billing_events').where({ tenant_id: alfa }).del();
  await db('cancellation_requests').where({ tenant_id: alfa }).del();
  await db('subscription_reminder_sends').where({ tenant_id: alfa }).del();
  await db('platform_audit').del();
  await db('tenants').where({ id: alfa }).update({
    billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa', billing_tax_id: '12345678000195',
    billing_legal_name: 'Alfa Telecom Ltda', billing_email: 'financeiro@alfa.test'
  });
  await assinar();
});

describe('quem pode', () => {
  it('só o dono: o admin contratado e quem só olha recebem 403', async () => {
    for (const token of [adminToken, viewerToken]) {
      // eslint-disable-next-line no-await-in-loop
      const lido = await pedir('/subscription/cancellation', { token });
      assert.equal(lido.status, 403, JSON.stringify(lido.body));
      // eslint-disable-next-line no-await-in-loop
      const pedido = await pedir('/subscription/cancellation', { method: 'POST', body: { reason: 'other' }, token });
      assert.equal(pedido.status, 403);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await pedir('/subscription/cancellation/confirm', { method: 'POST', token })).status, 403);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await pedir('/subscription/cancellation', { method: 'DELETE', token })).status, 403);
    }
    assert.equal((await pedidos()).length, 0);
    assert.equal((await assinatura()).cancel_at, null);

    const dono = await pedir('/subscription/cancellation');
    assert.equal(dono.status, 200, JSON.stringify(dono.body));
    assert.ok(dono.body.data.reasons.includes('too_expensive'));
    assert.equal(dono.body.data.canCancel, true);
  });
});

describe('o pedido', () => {
  it('exige um motivo da lista, e devolve as ofertas', async () => {
    const ruim = await pedir('/subscription/cancellation', { method: 'POST', body: { reason: 'porque sim' } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_reason');

    const feito = await pedirCancelamento();
    assert.equal(feito.status, 201, JSON.stringify(feito.body));
    const { offers, request } = feito.body.data;
    assert.equal(offers.discount.available, true);
    assert.equal(offers.discount.percent, 20);
    assert.equal(offers.discount.months, 3);
    assert.equal(offers.discount.priceCents, 8000);
    assert.equal(offers.pause.available, true);
    assert.equal(offers.pause.maxMonths, 2);
    assert.deepEqual(request.offersPresented, ['discount', 'pause']);
    assert.equal(request.comment, 'caro demais para nós');

    // Voltar à tela e escolher outro motivo não abre outro pedido.
    await pedirCancelamento('not_using');
    const linhas = await pedidos();
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].reason, 'not_using');
    assert.equal(linhas[0].outcome, null);
  });

  it('aceitar ou confirmar sem pedido é 409', async () => {
    assert.equal((await aceitar('discount')).body.code, 'no_request');
    assert.equal((await confirmar()).body.code, 'no_request');
  });

  it('as configurações mandam: zero desliga a oferta', async () => {
    assert.deepEqual(await retentionConfig(), { discountPercent: 20, discountMonths: 3, pauseMaxMonths: 2 });
    await saveProfile({ retentionDiscountPercent: 0, retentionPauseMaxMonths: 0 });
    try {
      const { offers } = (await pedirCancelamento()).body.data;
      assert.equal(offers.discount.available, false);
      assert.equal(offers.discount.reason, 'disabled');
      assert.equal(offers.pause.reason, 'disabled');
      assert.equal((await aceitar('pause', 1)).body.code, 'offer_unavailable');
      await assert.rejects(saveProfile({ retentionDiscountPercent: 95 }), { field: 'retentionDiscountPercent' });
    } finally {
      await saveProfile({ retentionDiscountPercent: null, retentionPauseMaxMonths: null });
      invalidatePlatformProfile();
    }
  });
});

describe('o desconto', () => {
  it('aplica o cupom de retenção e reprecifica a fatura em aberto no gateway', async () => {
    await cobrancaEmitida({ gatewayChargeId: 'pay_cheia' });
    await pedirCancelamento();
    const aceito = await aceitar('discount');
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    assert.equal(aceito.body.data.priceCents, 8000);

    const sub = await assinatura();
    const cupom = await Coupon.findById(sub.coupon_id);
    assert.equal(cupom.code, retentionCouponCode(20, 3));
    assert.equal(cupom.system_kind, 'retention');
    assert.equal(Number(sub.coupon_cycles_left), 3);

    // A fatura cheia foi cancelada no gateway, e a nova saiu com o desconto.
    assert.deepEqual(cancelados().map((r) => r.path), ['/payments/pay_cheia']);
    assert.deepEqual(criados().map((r) => r.payload.value), [80]);

    const [pedido] = await pedidos();
    assert.equal(pedido.outcome, 'retained_discount');
    assert.equal(pedido.offer, 'discount');
    assert.equal(Number(pedido.discount_percent), 20);
    assert.ok((await getDb()('platform_audit').where({ action: 'subscription.cancellation_changed', tenant_id: alfa })).length >= 1);
  });

  it('uma vez a cada doze meses', async () => {
    await pedirCancelamento();
    assert.equal((await aceitar('discount')).status, 200);
    await assinar();

    const denovo = (await pedirCancelamento()).body.data.offers.discount;
    assert.equal(denovo.available, false);
    assert.equal(denovo.reason, 'used_recently');
    assert.ok(denovo.availableAgainAt);
    const recusado = await aceitar('discount');
    assert.equal(recusado.status, 409);
    assert.equal(recusado.body.code, 'offer_unavailable');
    assert.equal(recusado.body.reason, 'used_recently');

    // A carência é de doze meses DEPOIS do período descontado (3 meses):
    // treze meses depois ainda não vale; dezesseis meses depois, volta.
    await getDb()('cancellation_requests').where({ tenant_id: alfa, outcome: 'retained_discount' })
      .update({ decided_at: aoSegundo(Date.now() - 395 * DIA) });
    assert.equal((await pedirCancelamento()).body.data.offers.discount.reason, 'used_recently');
    await getDb()('cancellation_requests').where({ tenant_id: alfa, outcome: 'retained_discount' })
      .update({ decided_at: aoSegundo(Date.now() - 490 * DIA) });
    assert.equal((await pedirCancelamento()).body.data.offers.discount.available, true);
  });

  it('só substitui um cupom mais fraco, e nunca soma', async () => {
    const forte = await Coupon.create({ code: 'RET-FORTE30', kind: 'percent', value: 30, duration: 'forever', active: true });
    const fraco = await Coupon.create({ code: 'RET-FRACO10', kind: 'percent', value: 10, duration: 'forever', active: true });

    await assinar({ coupon_id: forte.id, coupon_cycles_left: null, coupon_applied_at: daquiA(-1) });
    const comForte = (await pedirCancelamento()).body.data.offers.discount;
    assert.equal(comForte.available, false);
    assert.equal(comForte.reason, 'better_coupon');

    await getDb()('cancellation_requests').where({ tenant_id: alfa }).del();
    await assinar({ coupon_id: fraco.id, coupon_cycles_left: null, coupon_applied_at: daquiA(-1) });
    assert.equal((await pedirCancelamento()).body.data.offers.discount.available, true);
    const aceito = await aceitar('discount');
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    assert.equal(aceito.body.data.replacedCouponId, fraco.id);
    const sub = await assinatura();
    assert.equal((await Coupon.findById(sub.coupon_id)).system_kind, 'retention');
    assert.equal(SubscriptionService.priceFor(sub, plano, await Coupon.findById(sub.coupon_id)), 8000);
  });

  it('o código do cupom de retenção não vale digitado', async () => {
    await pedirCancelamento();
    await aceitar('discount');
    await assinar();
    const digitado = await pedir('/subscription/coupon', { method: 'POST', body: { code: retentionCouponCode(20, 3) } });
    assert.equal(digitado.status, 409);
    assert.equal(digitado.body.code, 'coupon_invalid');
  });
});

describe('a pausa', () => {
  it('cancela a fatura no gateway, para de cobrar, e volta sozinha no fim', async () => {
    const renova = daquiA(2);
    await assinar({ renews_at: renova });
    const emitida = await cobrancaEmitida({ gatewayChargeId: 'pay_da_renovacao' });
    await pedirCancelamento('temporary');

    const aceito = await aceitar('pause', 2);
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    const ate = aoSegundo(addMonths(renova, 2).getTime());
    assert.equal(aceito.body.data.pausedUntil, ate.toISOString());
    assert.equal(aceito.body.data.subscription.pausedUntil, ate.toISOString());

    // A fatura que já tinha saído: cancelada no gateway e aqui, com a marca.
    assert.deepEqual(cancelados().map((r) => r.path), ['/payments/pay_da_renovacao']);
    const linha = await runInTenant(alfa, () => BillingCharge.findById(emitida));
    assert.equal(linha.status, 'canceled');
    assert.equal(linha.last_error, RETENTION_CANCEL_MARKER);
    const sub = await assinatura();
    assert.equal(new Date(sub.renews_at).getTime(), renova.getTime(), 'o fim do período pago fica onde estava');
    assert.equal(new Date(sub.paused_until).getTime(), ate.getTime());
    assert.equal((await pedidos())[0].outcome, 'retained_pause');
    assert.equal((await eventos('subscription.paused')).length, 1);

    // Antes da pausa começar, o período pago vale inteiro.
    assert.equal(SubscriptionService.effectiveStatus(sub, new Date()).status, 'active');

    // Durante: só ler, com o código próprio — e nada de cobrança, lembrete
    // ou suspensão automática.
    const durante = new Date(renova.getTime() + 10 * DIA);
    assert.deepEqual(SubscriptionService.effectiveStatus(sub, durante), { status: 'past_due', reason: 'paused' });
    assert.equal(SubscriptionService.decide(sub, { method: 'GET', now: durante }).allowed, true);
    assert.deepEqual(SubscriptionService.decide(sub, { method: 'POST', now: durante }), { allowed: false, code: GATE_CODES.PAUSED });
    assert.equal(SubscriptionService.pendingReminder(sub, durante, plano), null);
    assert.equal(SubscriptionService.pendingReminder(sub, new Date(renova.getTime() - DIA), plano), null);
    assert.equal(overdueSince(sub, durante), null);
    assert.equal(SubscriptionService.autoSuspensionStep(
      sub, new Date(renova.getTime() + 50 * DIA), plano, { days: 15, warnDays: 3 }
    ), null);

    recebidas = [];
    for (const quando of [new Date(), durante, new Date(ate.getTime() - DIA)]) {
      // eslint-disable-next-line no-await-in-loop
      const resultado = await emitir({ now: quando });
      assert.equal(resultado.issued, false);
      assert.equal(resultado.reason, 'paused');
    }
    assert.equal(criados().length, 0, 'nenhuma fatura durante a pausa');

    // Na data, o agendador devolve a cobrança: o prazo é o fim da pausa, e a
    // emissão da mesma volta abre a fatura.
    assert.equal((await cumprir(new Date(ate.getTime() - 1000))).action, 'none');
    const fim = new Date(ate.getTime() + 60 * 1000);
    const retomada = await cumprir(fim);
    assert.equal(retomada.action, 'resumed');
    assert.equal((await cumprir(fim)).action, 'none', 'uma vez só');
    const depois = await assinatura();
    assert.equal(depois.paused_until, null);
    assert.equal(depois.pause_started_at, null);
    assert.equal(new Date(depois.renews_at).getTime(), ate.getTime());
    assert.equal((await eventos('subscription.resumed')).length, 1);

    const emissao = await emitir({ now: fim });
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.periodEnd, ChargeIssuingService.periodKey(ate));
    assert.equal(criados().length, 1);
  });

  it('meses fora do limite são 400', async () => {
    await pedirCancelamento();
    for (const meses of [0, 3, 1.5, 'dois']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await aceitar('pause', meses);
      assert.equal(r.status, 400, `${meses}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'invalid_months');
    }
    assert.equal((await assinatura()).paused_until, null);
  });

  it('o gateway recusando o cancelamento da fatura não pausa nada', async () => {
    await cobrancaEmitida({ gatewayChargeId: 'pay_teimosa' });
    await pedirCancelamento();
    recusarCancelamento = true;
    const r = await aceitar('pause', 1);
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(r.body.code, 'gateway_failed');
    assert.equal((await assinatura()).paused_until, null);
    assert.equal((await pedidos())[0].outcome, null, 'o pedido continua aberto');
    assert.equal((await cobrancas())[0].status, 'pending');
  });

  it('só com o período pago correndo: quem deve, paga', async () => {
    await assinar({ renews_at: daquiA(-3) });
    const { offers } = (await pedirCancelamento()).body.data;
    assert.equal(offers.pause.available, false);
    assert.equal(offers.pause.reason, 'not_eligible');
  });

  it('pagar durante a pausa retoma na hora, com o período contando do pagamento', async () => {
    // A pausa já correndo: o período pago acabou há cinco dias.
    const renova = daquiA(-5);
    await assinar({ renews_at: renova, paused_until: daquiA(50), pause_started_at: daquiA(-10) });
    const pago = await pedir('/charges/pay', { method: 'POST' });
    assert.ok([200, 201].includes(pago.status), JSON.stringify(pago.body));
    assert.equal(criados().length, 1, 'o "pagar agora" é a exceção: abre a fatura');
    const [linha] = await cobrancas();

    const antes = Date.now();
    const resultado = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: Number(linha.amount_cents), currency: 'BRL', provider: 'asaas', externalId: linha.gateway_charge_id
    }));
    assert.equal(resultado.underpaid, false);
    const depois = await assinatura();
    assert.equal(depois.paused_until, null);
    assert.equal(depois.status, 'active');
    const renovaAgora = new Date(depois.renews_at).getTime();
    assert.ok(renovaAgora >= antes + 30 * DIA - 2000 && renovaAgora <= Date.now() + 30 * DIA + 2000);
    const [evento] = await eventos('payment.recorded');
    assert.equal(JSON.parse(evento.detail).pauseEnded, true);
  });

  it('pagar antes de a pausa começar a desfaz, sem perder o período pago', async () => {
    const renova = daquiA(2);
    await assinar({ renews_at: renova, paused_until: aoSegundo(addMonths(renova, 1).getTime()), pause_started_at: daquiA(0) });
    const id = await cobrancaEmitida({ gatewayChargeId: 'pay_antecipado' });
    await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 10000, currency: 'BRL', provider: 'asaas', externalId: 'pay_antecipado'
    }));
    const depois = await assinatura();
    assert.equal(depois.paused_until, null);
    assert.equal(new Date(depois.renews_at).getTime(), renova.getTime() + 30 * DIA);
    assert.ok(id);
  });

  it('a pró-rata e a troca de plano esperam a pausa', async () => {
    await assinar({ paused_until: daquiA(60), pause_started_at: daquiA(0) });
    const troca = await pedir('/subscription/plan', { method: 'PUT', body: { planId: outroPlano.id } });
    assert.equal(troca.status, 409);
    assert.equal(troca.body.code, 'subscription_paused');
    await runInTenant(alfa, () => BillingCharge.openProration({
      key: `${ChargeIssuingService.isoDate(Date.now())}-p0`, amountCents: 1000, currency: 'BRL', provider: 'asaas',
      dueDate: ChargeIssuingService.isoDate(Date.now() + 3 * DIA)
    }));
    const tentativa = await runInTenant(alfa, () => ChargeIssuingService.retryProrations({}));
    assert.equal(tentativa.reason, 'retention_hold');
    assert.equal(criados().length, 0);
    assert.equal((await cobrancas()).find((l) => l.kind === 'proration').status, 'pending', 'espera, sem ser cancelada');
  });
});

describe('o cancelamento agendado', () => {
  it('agenda para o fim do período pago, cancela a fatura seguinte e não cobra mais nada', async () => {
    const renova = daquiA(3);
    await assinar({ renews_at: renova });
    await cobrancaEmitida({ gatewayChargeId: 'pay_seguinte' });
    await pedirCancelamento('switching_provider');

    const confirmado = await confirmar();
    assert.equal(confirmado.status, 200, JSON.stringify(confirmado.body));
    assert.equal(confirmado.body.data.immediate, false);
    assert.equal(confirmado.body.data.cancelAt, renova.toISOString());
    assert.equal(confirmado.body.data.subscription.cancelAt, renova.toISOString());
    assert.deepEqual(cancelados().map((r) => r.path), ['/payments/pay_seguinte']);
    const sub = await assinatura();
    assert.equal(sub.status, 'active', 'até lá, tudo funciona');
    assert.equal(new Date(sub.cancel_at).getTime(), renova.getTime());
    assert.equal((await pedidos())[0].outcome, 'canceled');
    assert.equal((await pedidos())[0].offer, 'none');
    assert.equal((await eventos('cancellation.scheduled')).length, 1);

    // Nenhuma fatura nova: nem a do agendador, nem o clique.
    recebidas = [];
    assert.equal((await emitir({ now: new Date(renova.getTime() - DIA) })).reason, 'cancel_scheduled');
    assert.equal((await emitir({ manual: true })).reason, 'cancel_scheduled');
    const pagar = await pedir('/charges/pay', { method: 'POST' });
    assert.equal(pagar.status, 409);
    assert.equal(pagar.body.code, 'cancel_scheduled');
    const troca = await pedir('/subscription/plan', { method: 'PUT', body: { planId: outroPlano.id } });
    assert.equal(troca.body.code, 'cancel_scheduled');
    assert.equal(criados().length, 0);
    assert.equal(SubscriptionService.pendingReminder(sub, new Date(renova.getTime() - DIA), plano), null);
    assert.equal(overdueSince(sub, new Date(renova.getTime() + 20 * DIA)), null);

    // Pedir de novo: já está agendado.
    assert.equal((await pedirCancelamento()).body.code, 'cancel_scheduled');

    // Na data, o agendador cancela — uma vez só, mesmo com voltas sobrepostas.
    assert.equal((await cumprir(new Date(renova.getTime() - 1000))).action, 'none');
    const naData = new Date(renova.getTime() + 1000);
    const voltas = await Promise.all([cumprir(naData), cumprir(naData), cumprir(naData)]);
    assert.equal(voltas.filter((v) => v.action === 'canceled').length, 1, JSON.stringify(voltas));
    const cancelada = await assinatura();
    assert.equal(cancelada.status, 'canceled');
    assert.ok(cancelada.canceled_at);
    const mudancas = await eventos('status.changed');
    assert.equal(mudancas.length, 1);
    assert.equal(JSON.parse(mudancas[0].detail).reason, 'self_cancel');
    assert.equal((await emitir({ now: naData })).reason, 'not_billable');
  });

  it('desfazer antes da data devolve a fatura à emissão', async () => {
    const renova = daquiA(3);
    await assinar({ renews_at: renova });
    await cobrancaEmitida({ gatewayChargeId: 'pay_volta' });
    await pedirCancelamento();
    await confirmar();

    const desfeito = await desfazer();
    assert.equal(desfeito.status, 200, JSON.stringify(desfeito.body));
    assert.equal(desfeito.body.data.reopenedCharge, true);
    assert.equal((await assinatura()).cancel_at, null);
    const [pedido] = await pedidos();
    assert.equal(pedido.outcome, 'reverted');
    assert.equal(pedido.reverted_by, 'provider');

    recebidas = [];
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(criados().length, 1);

    const outra = await desfazer();
    assert.equal(outra.status, 409);
    assert.equal(outra.body.code, 'not_scheduled');
  });

  it('o pagamento da fatura que escapou empurra a data junto com o período', async () => {
    const renova = daquiA(3);
    await assinar({ renews_at: renova, cancel_at: renova });
    await runInTenant(alfa, () => SubscriptionService.recordPayment({ amountCents: 10000, currency: 'BRL', provider: 'manual' }));
    const depois = await assinatura();
    assert.equal(new Date(depois.renews_at).getTime(), renova.getTime() + 30 * DIA);
    assert.equal(new Date(depois.cancel_at).getTime(), depois.renews_at instanceof Date
      ? depois.renews_at.getTime() : new Date(depois.renews_at).getTime());
  });

  it('sem período pago correndo, cancela na hora', async () => {
    await assinar({ renews_at: daquiA(-4) });
    await cobrancaEmitida({ gatewayChargeId: 'pay_atrasada' });
    await pedirCancelamento('business_closed');
    const r = await confirmar();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.immediate, true);
    assert.equal((await assinatura()).status, 'canceled');
    assert.deepEqual(cancelados().map((x) => x.path), ['/payments/pay_atrasada']);
    assert.equal(JSON.parse((await eventos('status.changed'))[0].detail).reason, 'self_cancel');
  });

  it('o console desfaz o agendado — só o do provedor da URL', async () => {
    await pedirCancelamento();
    await confirmar();
    assert.equal((await plataforma(`/tenants/${caixa}/subscription/cancellation`, { method: 'DELETE' })).status, 404);
    const r = await plataforma(`/tenants/${alfa}/subscription/cancellation`, { method: 'DELETE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await assinatura()).cancel_at, null);
    assert.equal((await pedidos())[0].reverted_by, 'console');
    const denovo = await plataforma(`/tenants/${alfa}/subscription/cancellation`, { method: 'DELETE' });
    assert.equal(denovo.status, 409);
    assert.equal(denovo.body.code, 'not_scheduled');
    // Quem não é da plataforma não chega.
    assert.notEqual((await plataforma(`/tenants/${alfa}/subscription/cancellation`, { method: 'DELETE', token: adminToken })).status, 200);
  });
});

describe('o relatório do console', () => {
  it('conta motivos, ofertas aceitas e a taxa de retenção', async () => {
    await pedirCancelamento('too_expensive');
    await aceitar('discount');
    await assinar({ renews_at: daquiA(5) });
    await pedirCancelamento('temporary');
    await aceitar('pause', 1);
    await assinar({ renews_at: daquiA(5) });
    await pedirCancelamento('switching_provider');
    await confirmar();
    await assinar({ renews_at: daquiA(5) });
    await pedirCancelamento('other');

    const r = await plataforma('/reports/cancellations');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rel = r.body.data;
    assert.equal(rel.total, 4);
    assert.equal(rel.byReason.too_expensive, 1);
    assert.equal(rel.byReason.temporary, 1);
    assert.equal(rel.byReason.switching_provider, 1);
    assert.equal(rel.byOutcome.retained_discount, 1);
    assert.equal(rel.byOutcome.retained_pause, 1);
    assert.equal(rel.byOutcome.canceled, 1);
    assert.equal(rel.byOutcome.pending, 1);
    assert.equal(rel.offers.discount.accepted, 1);
    assert.equal(rel.offers.pause.accepted, 1);
    assert.ok(rel.offers.pause.presented >= 2);
    assert.equal(rel.retentionRate, Math.round((2 / 3) * 1000) / 1000);
    assert.equal(rel.requests[0].tenant.id, alfa);

    assert.equal((await plataforma('/reports/cancellations?from=ontem')).status, 400);
    assert.notEqual((await plataforma('/reports/cancellations', { token: adminToken })).status, 200);
  });
});
