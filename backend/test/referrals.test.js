import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: TenantCredit } = await import('../src/models/TenantCredit.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: ReferralService } = await import('../src/services/referralService.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * A indicação de provedores e os créditos (0106) — o dinheiro. O cadastro com
 * `?ref=` está em `referrals-signup.test.js`, que precisa do SaaS.
 *
 * A montagem de `platform-coupons.test.js`: o roteador do console de verdade
 * num app mínimo, o painel para a rota do provedor e o webhook, e um gateway
 * de mentira em `127.0.0.1`. A casa (o provedor da instalação) é quem indica;
 * os indicados são criados direto na tabela, com a linha `pending` que o
 * cadastro grava.
 *
 * O que não pode dar errado, em dinheiro:
 *
 * 1. **A recompensa duas vezes** — o webhook reentrega, dois pagamentos
 *    correm, e um segundo pagamento do mesmo indicado não paga outra.
 * 2. **A recompensa sem dinheiro** — a pró-rata e o pago a menos não contam;
 *    o estorno cancela o crédito que ainda não foi usado.
 * 3. **O crédito gasto duas vezes, ou perdido** — reservado na emissão (nunca
 *    abaixo do piso de R$ 5,00), gasto no pagamento, devolvido no
 *    cancelamento, na reemissão e no estorno.
 * 4. **O crédito de um provedor no outro.**
 *
 * As datas são gravadas ao segundo: o MySQL guarda ao segundo.
 */
const CHAVE = 'chave-da-indicacao';
const TOKEN_WEBHOOK = 'token-do-webhook-da-indicacao';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
let proximoId = 0;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let casa;
let caixa;
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
        return responder(200, {
          id: `pay_ind_${proximoId}`,
          invoiceUrl: `https://asaas.test/i/${proximoId}`,
          dueDate: payload?.dueDate ?? null,
          value: payload?.value,
          status: 'PENDING'
        });
      }
      if (req.method === 'GET' && caminho === '/payments') return responder(200, { data: [] });
      if (req.method === 'DELETE' && /^\/payments\/[^/]+$/.test(caminho)) return responder(200, { deleted: true });
      if (req.method === 'PUT' && /^\/payments\/[^/]+$/.test(caminho)) {
        return responder(200, { id: caminho.split('/')[2], value: payload?.value, dueDate: payload?.dueDate, status: 'PENDING' });
      }
      if (req.method === 'POST' && /^\/payments\/[^/]+$/.test(caminho)) {
        return responder(200, { id: caminho.split('/')[2], value: payload?.value, dueDate: payload?.dueDate, status: 'PENDING' });
      }
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

function subirConsole() {
  const app = express();
  app.use(express.json());
  app.use(attachLocale);
  app.use('/api', resolveTenant);
  app.use('/api/platform', platformBillingRoutes);
  return new Promise((resolve) => {
    consoleServer = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${consoleServer.address().port}`);
    });
  });
}

const naCasa = (caminho, { method = 'GET', body } = {}) => call(`${panelUrl}${caminho}`, {
  method, headers: authHeaders(donoToken), ...(body === undefined ? {} : { body })
});
const noConsole = (caminho, { method = 'GET', body } = {}) => call(`${consoleUrl}${caminho}`, {
  method, headers: authHeaders(donoToken), ...(body === undefined ? {} : { body })
});
const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN_WEBHOOK }, body: corpo
});

const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DAY) / 1000) * 1000);
const pagar = (tenantId, opcoes) => runInTenant(tenantId, () => SubscriptionService.recordPayment(opcoes));
const estornar = (tenantId, externalId) => runInTenant(tenantId, () => SubscriptionService.reversePayment({ externalId }));
const emitir = (tenantId, opcoes = {}) => runInTenant(tenantId, () => ChargeIssuingService.issueCurrent({ manual: true, ...opcoes }));
const saldo = (tenantId) => runInTenant(tenantId, () => TenantCredit.balance());
const creditosDe = (tenantId) => getDb()('tenant_credits').where({ tenant_id: tenantId }).orderBy('id');
const alocacoesDe = (tenantId) => getDb()('credit_allocations').where({ tenant_id: tenantId }).orderBy('id');
const recompensaDe = (tenantId) => getDb()('referral_rewards').where({ referred_tenant_id: tenantId }).first();
const cobranca = (tenantId, id) => runInTenant(tenantId, () => BillingCharge.findById(id));
const darCredito = (tenantId, cents) => runInTenant(tenantId, () => TenantCredit.add({ amountCents: cents, source: 'manual', reference: 'teste' }));
const recompensaConfigurada = async (cents) => {
  await saveProfile({ referralRewardCents: cents });
  invalidatePlatformProfile();
};

async function assinar(tenantId, { plan = planos.pro, status = 'active', renewsAt = daquiA(2) } = {}) {
  await Subscription.upsertForTenant(tenantId, {
    plan_id: plan.id,
    status,
    renews_at: renewsAt,
    trial_ends_at: null,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: null,
    suspended_reason: null,
    proration_due_at: null,
    coupon_id: null,
    coupon_cycles_left: null,
    coupon_applied_at: null
  });
  SubscriptionService.invalidate(tenantId);
}

/** Um provedor indicado pela casa, sem passar pelo cadastro (o cadastro tem os casos dele). */
async function indicado({ semLinha = false } = {}) {
  sequencia += 1;
  const slug = `ind${sequencia}`;
  const db = getDb();
  await db('tenants').insert({
    slug, name: `Indicado ${sequencia}`, status: 'active', kind: 'provider',
    billing_gateway: 'asaas', billing_customer_ref: `cus_${slug}`, referred_by_tenant_id: casa
  });
  const id = (await db('tenants').where({ slug }).first()).id;
  if (!semLinha) {
    await db('referral_rewards').insert({
      referrer_tenant_id: casa, referred_tenant_id: id, amount_cents: 0, status: 'pending', created_at: new Date()
    });
  }
  await assinar(id, { plan: planos.pro });
  return id;
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN_WEBHOOK;
  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();
  const db = getDb();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-da-casa', password: 'senha-da-casa-1', email: 'dona@casa.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donoToken = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  casa = (await db('tenants').orderBy('id', 'asc').first()).id;

  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  await db('tenants').where({ id: casa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_casa' });

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.pro = await criar({ code: 'ind-pro', name: 'Pro', price_cents: 19990 });
  planos.barato = await criar({ code: 'ind-barato', name: 'Barato', price_cents: 600 });
  planos.mini = await criar({ code: 'ind-mini', name: 'Mini', price_cents: 400 });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => consoleServer.close(r));
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  // A casa vê o primeiro provedor que surgiu como "compartilhado" e passa a
  // recusar loopback na saída; o gateway de mentira mora em 127.0.0.1.
  resetDeploymentSharing();
  const db = getDb();
  await db('credit_allocations').where({ tenant_id: casa }).del();
  await db('tenant_credits').where({ tenant_id: casa }).del();
  await db('billing_charges').where({ tenant_id: casa }).del();
  await db('billing_events').where({ tenant_id: casa }).del();
  await assinar(casa);
  await recompensaConfigurada(5000);
});

describe('a recompensa', () => {
  it('uma vez só, no primeiro pagamento que estende — o webhook reentregue não paga outra', async () => {
    const id = await indicado();
    const corpo = {
      event: 'PAYMENT_RECEIVED',
      payment: { id: `pay_primeiro_${id}`, value: 199.9, customer: 'cus_x', externalReference: `tenant:${id}` }
    };
    const primeira = await entregar(corpo);
    assert.equal(primeira.body.code, 'recorded', JSON.stringify(primeira.body));
    const segunda = await entregar(corpo);
    assert.equal(segunda.body.code, 'duplicate');

    const recompensa = await recompensaDe(id);
    assert.equal(recompensa.status, 'credited');
    assert.equal(Number(recompensa.amount_cents), 5000);
    assert.equal(recompensa.payment_external_id, `pay_primeiro_${id}`);
    const creditos = await creditosDe(casa);
    assert.equal(creditos.length, 1);
    assert.equal(creditos[0].source, 'referral');
    assert.equal(Number(creditos[0].remaining_cents), 5000);
    assert.equal(Number(recompensa.credit_id), creditos[0].id);
    assert.equal(await saldo(casa), 5000);
    // O crédito é de QUEM INDICOU: o indicado não ganha nada.
    assert.equal((await creditosDe(id)).length, 0);

    // Um segundo pagamento do indicado não paga outra indicação.
    await pagar(id, { amountCents: 19990, externalId: `pay_segundo_${id}` });
    assert.equal((await creditosDe(casa)).length, 1);
    assert.equal(await saldo(casa), 5000);

    // O extrato do pagamento diz que ele pagou a indicação.
    const evento = await getDb()('billing_events').where({ tenant_id: id, external_id: `pay_primeiro_${id}` }).first();
    assert.equal(JSON.parse(evento.detail).referralReward.amountCents, 5000);
  });

  it('a corrida de dois pagamentos diferentes paga uma recompensa', async () => {
    const id = await indicado({ semLinha: true });
    await Promise.all([
      pagar(id, { amountCents: 19990, externalId: `pay_a_${id}` }),
      pagar(id, { amountCents: 19990, externalId: `pay_b_${id}` })
    ]);
    assert.equal((await creditosDe(casa)).length, 1);
    assert.equal((await recompensaDe(id)).status, 'credited');
    assert.equal((await getDb()('billing_events').where({ tenant_id: id, type: 'payment.recorded' })).length, 2);
  });

  it('não no pago a menos, nem na pró-rata', async () => {
    const id = await indicado();
    const curto = await pagar(id, { amountCents: 100, externalId: `pay_curto_${id}` });
    assert.equal(curto.underpaid, true);
    assert.equal((await recompensaDe(id)).status, 'pending');

    const prorata = await runInTenant(id, async () => {
      const linha = await BillingCharge.openProration({
        key: BillingCharge.prorationKey({ fromPlanId: 1, toPlanId: 2, periodEnd: '2099-01-01' }),
        amountCents: 3000, currency: 'BRL', provider: 'asaas', dueDate: ChargeIssuingService.isoDate(Date.now() + DAY)
      });
      await BillingCharge.markIssued(linha, { gatewayChargeId: `pay_pr_${id}` });
      return linha;
    });
    const pago = await pagar(id, { amountCents: 3000, externalId: `pay_pr_${id}` });
    assert.equal(pago.proration, true);
    assert.ok(prorata);
    assert.equal((await recompensaDe(id)).status, 'pending');
    assert.equal((await creditosDe(casa)).length, 0);

    await pagar(id, { amountCents: 19990, externalId: `pay_cheio_${id}` });
    assert.equal((await recompensaDe(id)).status, 'credited');
  });

  it('com o programa desligado no primeiro pagamento, a indicação não paga nunca', async () => {
    await recompensaConfigurada(0);
    const id = await indicado();
    await pagar(id, { amountCents: 19990, externalId: `pay_off_${id}` });
    assert.equal((await recompensaDe(id)).status, 'canceled');
    await recompensaConfigurada(5000);
    await pagar(id, { amountCents: 19990, externalId: `pay_on_${id}` });
    assert.equal((await recompensaDe(id)).status, 'canceled');
    assert.equal((await creditosDe(casa)).length, 0);
  });

  it('o estorno daquele pagamento cancela o crédito ainda não usado — uma vez só', async () => {
    const id = await indicado();
    await pagar(id, { amountCents: 19990, externalId: `pay_volta_${id}` });
    assert.equal(await saldo(casa), 5000);
    const estorno = await estornar(id, `pay_volta_${id}`);
    assert.equal(estorno.duplicate, false);
    assert.equal((await recompensaDe(id)).status, 'canceled');
    const [credito] = await creditosDe(casa);
    assert.ok(credito.canceled_at);
    assert.equal(Number(credito.remaining_cents), 0);
    assert.equal(await saldo(casa), 0);
    const marca = await getDb()('billing_events').where({ tenant_id: id, external_id: `pay_volta_${id}:refund` }).first();
    assert.equal(JSON.parse(marca.detail).referralRewardCanceled.canceledCents, 5000);
    const outra = await estornar(id, `pay_volta_${id}`);
    assert.equal(outra.duplicate, true);
    // E o estorno de outro pagamento do indicado não mexe em nada.
    await pagar(id, { amountCents: 19990, externalId: `pay_outro_${id}` });
    await estornar(id, `pay_outro_${id}`);
    assert.equal((await recompensaDe(id)).status, 'canceled');
  });
});

describe('o crédito cancelado pelo estorno', () => {
  it('a fatura aberta de quem indicou que reservava esse crédito volta ao preço sem ele', async () => {
    const id = await indicado();
    await pagar(id, { amountCents: 19990, externalId: `pay_reserva_${id}` });
    assert.equal(await saldo(casa), 5000);
    const emissao = await emitir(casa);
    assert.equal(emissao.amountCents, 14990, 'a fatura de quem indicou reservou o crédito');
    const antiga = emissao.charge;
    recebidas = [];
    await estornar(id, `pay_reserva_${id}`);
    const depois = await cobranca(casa, antiga.id);
    assert.equal(Number(depois.amount_cents), 19990, 'reemitida pelo preço cheio');
    assert.equal(depois.credit_reserved_cents, null);
    assert.ok(depois.gateway_charge_id && depois.gateway_charge_id !== antiga.gateway_charge_id, 'reemitida no gateway');
    assert.ok(recebidas.some((r) => r.method === 'DELETE'), 'a velha cancelada no gateway');
    const [alocacao] = await alocacoesDe(casa);
    assert.equal(alocacao.status, 'released');
    assert.equal(await saldo(casa), 0, 'o crédito cancelado não volta ao saldo');
  });
});

describe('o crédito na fatura de quem indicou', () => {
  it('abate o preço na emissão, reserva na cobrança e vai ao gateway com o desconto', async () => {
    await darCredito(casa, 5000);
    const emissao = await emitir(casa);
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.amountCents, 14990);
    assert.equal(emissao.creditCents, 5000);
    const linha = emissao.charge;
    assert.equal(Number(linha.amount_cents), 14990);
    assert.equal(Number(linha.credit_reserved_cents), 5000);
    const [post] = recebidas.filter((r) => r.method === 'POST' && r.path === '/payments');
    assert.equal(post.payload.value, 149.9);
    assert.equal(await saldo(casa), 0);
    const [alocacao] = await alocacoesDe(casa);
    assert.equal(alocacao.status, 'reserved');
    assert.equal(Number(alocacao.amount_cents), 5000);
    // O provedor vê o crédito na cobrança.
    const lista = await naCasa('/api/tenant/charges');
    assert.equal(lista.body.data.charges.find((c) => c.id === linha.id).creditCents, 5000);
    // Emitir de novo não reserva outra vez.
    const de_novo = await emitir(casa);
    assert.equal(de_novo.reason, 'already_issued');
    assert.equal((await alocacoesDe(casa)).length, 1);
  });

  it('nunca abaixo de R$ 5,00, e o que sobra fica no saldo', async () => {
    await assinar(casa, { plan: planos.barato });
    await darCredito(casa, 5000);
    const emissao = await emitir(casa);
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.amountCents, 500);
    assert.equal(Number(emissao.charge.credit_reserved_cents), 100);
    assert.equal(await saldo(casa), 4900);
  });

  it('plano abaixo do piso não usa crédito nenhum', async () => {
    await assinar(casa, { plan: planos.mini });
    await darCredito(casa, 5000);
    const emissao = await emitir(casa);
    assert.equal(emissao.amountCents, 400);
    assert.equal(emissao.charge.credit_reserved_cents, null);
    assert.equal(await saldo(casa), 5000);
    assert.equal((await alocacoesDe(casa)).length, 0);
  });

  it('paga: a reserva vira gasto; estornada: o crédito volta', async () => {
    await darCredito(casa, 5000);
    const { charge } = await emitir(casa);
    const corpo = {
      event: 'PAYMENT_RECEIVED',
      payment: { id: charge.gateway_charge_id, value: 149.9, customer: 'cus_casa', externalReference: `tenant:${casa}:${charge.period_end}` }
    };
    const pago = await entregar(corpo);
    assert.equal(pago.body.code, 'recorded', JSON.stringify(pago.body));
    assert.equal((await entregar(corpo)).body.code, 'duplicate');
    assert.equal((await cobranca(casa, charge.id)).status, 'paid');
    const [alocacao] = await alocacoesDe(casa);
    assert.equal(alocacao.status, 'consumed');
    assert.equal(await saldo(casa), 0);
    const evento = await getDb()('billing_events').where({ tenant_id: casa, external_id: charge.gateway_charge_id }).first();
    assert.deepEqual(JSON.parse(evento.detail).creditConsumed, { chargeId: charge.id, cents: 5000 });
    assert.equal(JSON.parse(evento.detail).underpaid, undefined, 'o valor com o desconto é o inteiro');

    const estorno = await estornar(casa, charge.gateway_charge_id);
    assert.equal(estorno.found, true);
    assert.equal((await alocacoesDe(casa))[0].status, 'released');
    assert.equal(await saldo(casa), 5000);
    // O PAYMENT_REFUNDED que o gateway manda depois não devolve outra vez.
    const aviso = await entregar({ event: 'PAYMENT_REFUNDED', payment: { id: charge.gateway_charge_id, value: 149.9, externalReference: `tenant:${casa}` } });
    assert.equal(aviso.status, 200);
    assert.equal((await cobranca(casa, charge.id)).status, 'refunded');
    assert.equal(await saldo(casa), 5000);
  });

  it('o pago a menos deixa a reserva onde está', async () => {
    await darCredito(casa, 5000);
    const { charge } = await emitir(casa);
    const curto = await pagar(casa, { amountCents: 1000, externalId: charge.gateway_charge_id, provider: 'asaas' });
    assert.equal(curto.underpaid, true);
    assert.equal((await alocacoesDe(casa))[0].status, 'reserved');
  });

  it('cancelada, a reserva volta; reemitida, reserva de novo', async () => {
    await darCredito(casa, 5000);
    const { charge } = await emitir(casa);
    assert.equal(await saldo(casa), 0);
    await runInTenant(casa, () => BillingCharge.update(charge.id, { status: 'canceled' }));
    assert.equal(await saldo(casa), 5000);
    assert.equal((await alocacoesDe(casa))[0].status, 'released');
    assert.equal((await cobranca(casa, charge.id)).credit_reserved_cents, null);
    // Cancelar de novo (o webhook do gateway depois do console) não devolve outra vez.
    await runInTenant(casa, () => BillingCharge.update(charge.id, { status: 'canceled' }));
    assert.equal(await saldo(casa), 5000);

    const reemissao = await emitir(casa);
    assert.equal(reemissao.issued, true, JSON.stringify(reemissao));
    assert.equal(reemissao.amountCents, 14990);
    assert.equal(await saldo(casa), 0);
    const alocacoes = await alocacoesDe(casa);
    assert.deepEqual(alocacoes.map((a) => a.status), ['released', 'reserved']);
  });

  it('a reemissão pela troca de preço (resetForReissue) solta e reserva pelo preço novo', async () => {
    await darCredito(casa, 3000);
    const { charge } = await emitir(casa);
    assert.equal(Number(charge.amount_cents), 16990);
    await runInTenant(casa, async () => {
      assert.equal(await BillingCharge.claim(charge.id, { until: new Date(Date.now() + 60_000), unissued: false }), true);
      assert.equal(await BillingCharge.resetForReissue(charge.id, { amountCents: 19990, currency: 'BRL' }), true);
    });
    assert.equal(await saldo(casa), 3000, 'a reserva voltou');
    await assinar(casa, { plan: planos.barato, renewsAt: (await Subscription.forTenant(casa)).renews_at });
    const reemissao = await emitir(casa);
    assert.equal(reemissao.issued, true, JSON.stringify(reemissao));
    assert.equal(reemissao.amountCents, 500);
    assert.equal(reemissao.creditCents, 100);
    assert.equal(await saldo(casa), 2900);
  });

  it('o valor digitado pelo console devolve a reserva ao saldo', async () => {
    await darCredito(casa, 5000);
    const { charge } = await emitir(casa);
    const res = await noConsole(`/api/platform/tenants/${casa}/charges/${charge.id}`, {
      method: 'PATCH', body: { amountCents: 10000 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await saldo(casa), 5000);
    const linha = await cobranca(casa, charge.id);
    assert.equal(Number(linha.amount_cents), 10000);
    assert.equal(linha.credit_reserved_cents, null);
  });
});

describe('o console', () => {
  it('lista indicações e créditos com o nome inteiro, e a caixa da plataforma é 404', async () => {
    const id = await indicado();
    await pagar(id, { amountCents: 19990, externalId: `pay_console_${id}` });
    const res = await noConsole(`/api/platform/tenants/${casa}/referrals`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const linha = res.body.data.referrals.find((r) => r.tenantId === id);
    assert.equal(linha.name, (await getDb()('tenants').where({ id }).first()).name);
    assert.equal(linha.status, 'credited');
    assert.equal(res.body.data.balanceCents, 5000);
    assert.equal(res.body.data.credits.length, 1);
    const dele = await noConsole(`/api/platform/tenants/${id}/referrals`);
    assert.equal(dele.body.data.referredBy.tenantId, casa);
    assert.equal(dele.body.data.credits.length, 0);
    assert.equal((await noConsole(`/api/platform/tenants/${caixa}/referrals`)).status, 404);
    assert.equal((await noConsole('/api/platform/tenants/999999/referrals')).status, 404);
  });

  it('o ajuste manual é auditado nas duas trilhas, e não deixa saldo negativo', async () => {
    const semMotivo = await noConsole(`/api/platform/tenants/${casa}/credits`, { method: 'POST', body: { amountCents: 1000 } });
    assert.equal(semMotivo.status, 400);
    assert.equal(semMotivo.body.code, 'reason_required');
    const zero = await noConsole(`/api/platform/tenants/${casa}/credits`, { method: 'POST', body: { amountCents: 0, reason: 'x' } });
    assert.equal(zero.body.code, 'invalid_amount');

    const da = await noConsole(`/api/platform/tenants/${casa}/credits`, {
      method: 'POST', body: { amountCents: 3000, reason: 'cortesia pelo atraso' }
    });
    assert.equal(da.status, 201, JSON.stringify(da.body));
    assert.equal(da.body.data.balanceAfter, 3000);
    const demais = await noConsole(`/api/platform/tenants/${casa}/credits`, {
      method: 'POST', body: { amountCents: -4000, reason: 'erro' }
    });
    assert.equal(demais.status, 409);
    assert.equal(demais.body.code, 'insufficient_credit');
    assert.equal(demais.body.balanceCents, 3000);
    const tira = await noConsole(`/api/platform/tenants/${casa}/credits`, {
      method: 'POST', body: { amountCents: -1000, reason: 'ajuste' }
    });
    assert.equal(tira.status, 201, JSON.stringify(tira.body));
    assert.equal(await saldo(casa), 2000);

    const trilha = await getDb()('platform_audit').where({ action: 'tenant.credit_adjusted', tenant_id: casa }).orderBy('id');
    assert.equal(trilha.length, 2);
    assert.equal(JSON.parse(trilha[0].detail).reason, 'cortesia pelo atraso');
    const doProvedor = await getDb()('audit_log').where({ tenant_id: casa }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(doProvedor.detail).platformAction, 'tenant.credit_adjusted');
    assert.equal((await noConsole(`/api/platform/tenants/${caixa}/credits`, {
      method: 'POST', body: { amountCents: 100, reason: 'x' }
    })).status, 404);
  });
});

describe('um provedor não alcança o crédito do outro', () => {
  it('o crédito do vizinho não abate a fatura nem aparece na tela', async () => {
    const vizinho = await indicado();
    await getDb()('tenants').where({ id: vizinho }).update({ billing_customer_ref: 'cus_vizinho' });
    await darCredito(vizinho, 7000);
    const emissao = await emitir(casa);
    assert.equal(emissao.amountCents, 19990, 'sem crédito da casa, preço cheio');
    assert.equal(await saldo(vizinho), 7000);
    assert.equal(await saldo(casa), 0);
    const tela = await naCasa('/api/tenant/referrals');
    assert.equal(tela.body.data.balanceCents, 0);
    assert.ok(tela.body.data.credits.every((c) => c.amountCents !== 7000));
    // Pelo serviço, no escopo da casa, o crédito do vizinho não existe.
    const [creditoDoVizinho] = await creditosDe(vizinho);
    assert.equal(await runInTenant(casa, () => TenantCredit.findById(creditoDoVizinho.id)), null);
    assert.equal(await ReferralService.codeFor(caixa), null, 'a caixa da plataforma não indica');
  });
});
