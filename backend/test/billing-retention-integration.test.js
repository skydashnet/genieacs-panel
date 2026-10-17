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
const { default: TenantCredit } = await import('../src/models/TenantCredit.js');
const { default: UsagePeak } = await import('../src/models/UsagePeak.js');
const { retentionCyclesFor } = await import('../src/services/cancellationService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');
const { default: platformReportsRoutes } = await import('../src/routes/platformReports.js');

/**
 * A retenção no cancelamento (0107) cruzada com o plano anual (0104), o
 * excedente (0105) e os créditos de indicação (0106) — as regras que só
 * existem quando as quatro estão juntas:
 *
 *   - a pausa e o cancelamento agendado não emitem nada, e a reserva de
 *     crédito de uma fatura cancelada por eles volta ao saldo;
 *   - o tempo pausado não vira excedente (o pico não é medido na pausa), e o
 *     excedente do período usado antes da pausa vai para a fatura da volta;
 *   - a troca agendada (descida, ciclo anual) espera o fim da pausa;
 *   - no anual, o desconto de retenção vale uma fatura (um ciclo = um ano).
 *
 * (Cabeçalho herdado de cancellation-retention.test.js:)
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
const CHAVE = 'chave-da-integracao';
const DIA = 24 * 60 * 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const daquiA = (dias) => aoSegundo(Date.now() + dias * DIA);

let gateway;
let recebidas = [];
let proximoId = 0;
let recusarCancelamento = false;
/** Roda DURANTE a próxima criação de cobrança no gateway (a corrida com a retenção). */
let aoCriar = null;
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
        if (aoCriar) {
          const gancho = aoCriar;
          aoCriar = null;
          return Promise.resolve(gancho()).then(() => {
            proximoId += 1;
            const id = `pay_ret_${proximoId}`;
            responder(200, {
              id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
              invoiceUrl: `https://gateway.exemplo.test/i/${id}`
            });
          });
        }
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
    billing_cycle: 'monthly', pending_billing_cycle: null,
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
    code: 'int-pro', name: 'Pro', price_cents: 10000, price_yearly_cents: 100000, currency: 'BRL', period_days: 30, trial_days: 0, active: true,
    max_devices: 10, overage_price_cents_devices: 100
  });
  outroPlano = await Plan.create({
    code: 'int-max', name: 'Max', price_cents: 20000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
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
  aoCriar = null;
  const db = getDb();
  await db('billing_charges').where({ tenant_id: alfa }).del();
  await db('billing_events').where({ tenant_id: alfa }).del();
  await db('cancellation_requests').where({ tenant_id: alfa }).del();
  await db('credit_allocations').where({ tenant_id: alfa }).del();
  await db('tenant_credits').where({ tenant_id: alfa }).del();
  await db('usage_peaks').where({ tenant_id: alfa }).del();
  await db('coupons').where('code', 'like', 'RETENCAO-%').del();
  await db('subscription_reminder_sends').where({ tenant_id: alfa }).del();
  await db('platform_audit').del();
  await db('tenants').where({ id: alfa }).update({
    billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa', billing_tax_id: '12345678000195',
    billing_legal_name: 'Alfa Telecom Ltda', billing_email: 'financeiro@alfa.test'
  });
  await assinar();
});


const saldo = () => runInTenant(alfa, () => TenantCredit.balance());
const darCredito = (cents) => runInTenant(alfa, () => TenantCredit.add({ amountCents: cents, source: 'manual' }));
const medir = (devices, now) => runInTenant(alfa, () => SubscriptionService.recordUsagePeaks({
  countDevices: async () => devices, now
}));
const picos = (renova) => runInTenant(alfa, () => UsagePeak.forPeriod(ChargeIssuingService.periodKey(renova)));
const alocacoes = (chargeId) => getDb()('credit_allocations').where({ tenant_id: alfa, charge_id: chargeId });

describe('o crédito (0106) e a retenção', () => {
  it('a pausa cancela a renovação com crédito reservado, e a reserva volta ao saldo', async () => {
    await darCredito(3000);
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.creditCents, 3000);
    assert.equal(await saldo(), 0);

    await pedirCancelamento('temporary');
    const aceito = await aceitar('pause', 1);
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    const linha = (await cobrancas())[0];
    assert.equal(linha.status, 'canceled');
    assert.equal(linha.last_error, RETENTION_CANCEL_MARKER);
    assert.equal(linha.credit_reserved_cents, null);
    assert.deepEqual((await alocacoes(linha.id)).map((a) => a.status), ['released']);
    assert.equal(await saldo(), 3000, 'o crédito volta inteiro');
  });

  it('o cancelamento agendado também solta a reserva, e nada mais é emitido nem reservado', async () => {
    await darCredito(2000);
    assert.equal((await emitir()).issued, true);
    assert.equal(await saldo(), 0);
    await pedirCancelamento('too_expensive');
    const r = await confirmar();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cobrancas())[0].status, 'canceled');
    assert.equal(await saldo(), 2000);

    recebidas = [];
    const denovo = await emitir({ manual: true });
    assert.equal(denovo.reason, 'cancel_scheduled');
    assert.equal(criados().length, 0);
    assert.equal(await saldo(), 2000, 'a fatura que não sai não reserva');
  });

  it('desfeito o agendamento, a fatura reaberta reserva de novo pelo preço cheio', async () => {
    await darCredito(2000);
    assert.equal((await emitir()).issued, true);
    await pedirCancelamento('too_expensive');
    await confirmar();
    assert.equal(await saldo(), 2000);
    assert.equal((await desfazer()).status, 200);
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.creditCents, 2000);
    const linha = (await cobrancas())[0];
    assert.equal(Number(linha.amount_cents), 8000);
    assert.equal(BillingCharge.baseAmountOf(linha), 10000);
    assert.equal(await saldo(), 0);
  });

  it('a linha reservada que não vai ao gateway devolve a reserva e o preço sem crédito', async () => {
    await darCredito(1500);
    const id = await runInTenant(alfa, () => BillingCharge.open({
      periodEnd: '2099-01-01', amountCents: 10000, currency: 'BRL', provider: 'asaas', dueDate: '2099-01-01'
    }));
    const reserva = await runInTenant(alfa, () => TenantCredit.reserveForCharge(id, 10000));
    assert.equal(reserva.reservedCents, 1500);
    assert.equal(await saldo(), 0);
    await runInTenant(alfa, () => ChargeIssuingService.soltarCreditoNaoEmitido(id, reserva.reservedCents, 10000));
    const linha = await runInTenant(alfa, () => BillingCharge.findById(id));
    assert.equal(Number(linha.amount_cents), 10000);
    assert.equal(linha.credit_reserved_cents, null);
    assert.equal(await saldo(), 1500);
  });
});

describe('o excedente (0105) e a pausa', () => {
  it('o tempo pausado não vira excedente; o do período usado vai para a fatura da volta', async () => {
    const renova = daquiA(2);
    await assinar({ renews_at: renova });
    // O período pago: 13 ONTs num plano de 10 — 3 acima, R$ 1,00 cada.
    assert.equal((await medir(13, new Date())).recorded, true);
    assert.equal((await picos(renova)).devices, 13);

    await pedirCancelamento('temporary');
    assert.equal((await aceitar('pause', 1)).status, 200);
    const ate = aoSegundo(addMonths(renova, 1).getTime());

    // Antes da pausa começar, o período pago ainda conta.
    assert.equal((await medir(14, new Date())).recorded, true);
    // Na pausa, nada se mede — nem um pico maior.
    const durante = new Date(renova.getTime() + 5 * DIA);
    const r = await medir(50, durante);
    assert.deepEqual(r, { recorded: false, reason: 'paused' });
    assert.equal((await picos(renova)).devices, 14);

    // A volta leva os picos do período usado para a chave nova.
    const fim = new Date(ate.getTime() + 60 * 1000);
    assert.equal((await cumprir(fim)).action, 'resumed');
    assert.equal((await picos(ate)).devices, 14);
    recebidas = [];
    const emissao = await emitir({ now: fim });
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(criados().length, 1);
    assert.equal(criados()[0].payload.value, 104, 'R$ 100 do plano + 4 ONTs acima × R$ 1');
    // Rodar a volta de novo não soma nada.
    await runInTenant(alfa, () => CancellationService.levarPicosDaPausa(renova, ate));
    assert.equal((await picos(ate)).devices, 14);
  });

  it('o cancelamento agendado continua medindo: desfeito, a renovação cobra o período usado', async () => {
    await pedirCancelamento('too_expensive');
    await confirmar();
    assert.equal((await medir(12, new Date())).recorded, true);
    assert.equal((await desfazer()).status, 200);
    recebidas = [];
    const emissao = await emitir();
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(criados()[0].payload.value, 102);
  });
});

describe('o plano anual (0104) e a retenção', () => {
  it('a troca agendada espera o fim da pausa, e se aplica na volta', async () => {
    const renova = daquiA(2);
    await assinar({ renews_at: renova });
    await pedirCancelamento('temporary');
    assert.equal((await aceitar('pause', 1)).status, 200);
    // Uma descida que já estava agendada para a renovação (antes do pedido).
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({
      pending_plan_id: outroPlano.id, pending_plan_at: renova, pending_billing_cycle: 'monthly'
    });
    await SubscriptionService.invalidate(alfa);
    const ate = aoSegundo(addMonths(renova, 1).getTime());
    const durante = new Date(renova.getTime() + 3 * DIA);
    const aplicar = (now) => runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now, countDevices: async () => 0 }));
    assert.deepEqual(await aplicar(durante), { applied: false, reason: 'paused' });
    assert.equal(Number((await assinatura()).plan_id), Number(plano.id));

    const fim = new Date(ate.getTime() + 60 * 1000);
    assert.equal((await cumprir(fim)).action, 'resumed');
    const depois = await aplicar(fim);
    assert.equal(depois.applied, true, JSON.stringify(depois));
    assert.equal(Number((await assinatura()).plan_id), Number(outroPlano.id));
  });

  it('no anual, o desconto de retenção vale UMA fatura anual com o equivalente (20% × 3 ÷ 12 = 5%)', async () => {
    await assinar({ billing_cycle: 'annual', renews_at: daquiA(30) });
    const pedido = await pedirCancelamento('too_expensive');
    assert.equal(pedido.status, 201, JSON.stringify(pedido.body));
    const desconto = pedido.body.data.offers.discount;
    assert.equal(desconto.available, true, JSON.stringify(desconto));
    assert.equal(desconto.billingCycle, 'annual');
    assert.equal(desconto.months, 1);
    assert.equal(desconto.percent, 5);
    assert.equal(desconto.priceCents, 95000, '5% sobre a fatura anual de R$ 1.000');

    const aceito = await aceitar('discount');
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    assert.equal(aceito.body.data.coupon.months, 1);
    assert.equal(aceito.body.data.priceCents, 95000);
    const cupom = await Coupon.findByCode('RETENCAO-ANUAL-5');
    assert.equal(cupom.duration, 'once');
    assert.equal(cupom.kind, 'percent');
    assert.equal(Number(cupom.value), 5);
    assert.equal(cupom.system_kind, 'retention_annual');
    const sub = await assinatura();
    assert.equal(Number(sub.coupon_id), Number(cupom.id));
    assert.equal(SubscriptionService.priceFor(sub, plano, cupom), 95000);
    const [linha] = await pedidos();
    assert.equal(Number(linha.months), 3);
    assert.equal(linha.billing_cycle, 'annual');

    // A carência no anual: 12 meses descontados + 12 = 24 meses.
    await assinar({ billing_cycle: 'annual', renews_at: daquiA(30) });
    await getDb()('cancellation_requests').where({ tenant_id: alfa, outcome: 'retained_discount' })
      .update({ decided_at: aoSegundo(Date.now() - 400 * DIA) });
    const cedo = (await pedirCancelamento()).body.data.offers.discount;
    assert.equal(cedo.reason, 'used_recently', 'a renovação anual seguinte não ganha outro desconto');
    await getDb()('cancellation_requests').where({ tenant_id: alfa, outcome: 'retained_discount' })
      .update({ decided_at: aoSegundo(Date.now() - 740 * DIA) });
    assert.equal((await pedirCancelamento()).body.data.offers.discount.available, true);
  });

  it('o equivalente fracionado vira um valor fixo sobre a fatura anual', async () => {
    await saveProfile({ retentionDiscountPercent: 15, retentionDiscountMonths: 2 });
    invalidatePlatformProfile();
    try {
      await assinar({ billing_cycle: 'annual', renews_at: daquiA(30) });
      const desconto = (await pedirCancelamento()).body.data.offers.discount;
      assert.equal(desconto.percent, 2.5);
      assert.equal(desconto.priceCents, 97500);
      assert.equal((await aceitar('discount')).status, 200);
      const sub = await assinatura();
      const cupom = await Coupon.findById(sub.coupon_id);
      assert.equal(cupom.kind, 'fixed');
      assert.equal(Number(cupom.value), 2500);
      assert.equal(SubscriptionService.priceFor(sub, plano, cupom), 97500);
    } finally {
      await saveProfile({ retentionDiscountPercent: 20, retentionDiscountMonths: 3 });
      invalidatePlatformProfile();
    }
  });

  it('com a troca para o anual agendada, o desconto já é o do anual — e só desconta a fatura anual', async () => {
    const renova = daquiA(3);
    await assinar({
      renews_at: renova, pending_plan_id: plano.id, pending_plan_at: renova, pending_billing_cycle: 'annual'
    });
    const desconto = (await pedirCancelamento()).body.data.offers.discount;
    assert.equal(desconto.billingCycle, 'annual');
    assert.equal(desconto.priceCents, 95000);
    assert.equal((await aceitar('discount')).status, 200);
    const sub = await assinatura();
    const cupom = await Coupon.findById(sub.coupon_id);
    assert.equal(cupom.system_kind, 'retention_annual');
    assert.equal(SubscriptionService.priceFor(sub, plano, cupom), 10000, 'a fatura mensal não tem o desconto do anual');
    assert.equal(SubscriptionService.priceFor(SubscriptionService.scheduledView(sub), plano, cupom), 95000);
    await emitir({ manual: true });
    const [c] = await cobrancas();
    assert.equal(Number(c.amount_cents), 95000, 'a fatura anual da troca sai com o desconto');
    // Aplicada a troca, o cupom do anual fica.
    await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: new Date(renova.getTime() + 1000) }));
    const depois = await assinatura();
    assert.equal(depois.billing_cycle, 'annual');
    assert.equal(Number(depois.coupon_id), Number(cupom.id));
  });

  it('a pausa vale uma vez a cada doze meses (`pause_cooldown`)', async () => {
    await assinar({ renews_at: daquiA(10) });
    await pedirCancelamento('temporary');
    assert.equal((await aceitar('pause', 1)).status, 200);
    // Pagou e voltou; meses depois pede de novo.
    await assinar({ renews_at: daquiA(10) });
    const pausa = (await pedirCancelamento('temporary')).body.data.offers.pause;
    assert.equal(pausa.available, false);
    assert.equal(pausa.reason, 'pause_cooldown');
    assert.ok(pausa.availableAgainAt);
    const recusada = await aceitar('pause', 1);
    assert.equal(recusada.status, 409);
    assert.equal(recusada.body.reason, 'pause_cooldown');
    await getDb()('cancellation_requests').where({ tenant_id: alfa, outcome: 'retained_pause' })
      .update({ decided_at: aoSegundo(Date.now() - 370 * DIA) });
    assert.equal((await pedirCancelamento('temporary')).body.data.offers.pause.available, true);
  });

  it('no mensal, continua a configuração (3 faturas)', async () => {
    const pedido = await pedirCancelamento('too_expensive');
    const desconto = pedido.body.data.offers.discount;
    assert.equal(desconto.billingCycle, 'monthly');
    assert.equal(desconto.months, 3);
    assert.equal(desconto.priceCents, 8000);
    assert.equal(retentionCyclesFor({ billing_cycle: 'annual' }, plano, 3), 1);
    assert.equal(retentionCyclesFor({ billing_cycle: 'annual' }, plano, 0), 0);
    assert.equal(retentionCyclesFor({ billing_cycle: 'monthly' }, plano, 5), 5);
    // Plano sem anual: o ciclo é o mensal, sempre.
    assert.equal(retentionCyclesFor({ billing_cycle: 'annual' }, outroPlano, 3), 3);
  });
});

describe('as bordas da retenção', () => {
  it('a volta da pausa não encurta um prazo que já vai além dela', async () => {
    const fimDaPausa = aoSegundo(Date.now() - 60_000);
    const alem = daquiA(20);
    await assinar({ renews_at: alem, paused_until: fimDaPausa, pause_started_at: daquiA(-40) });
    const r = await cumprir(new Date());
    assert.equal(r.action, 'resumed');
    assert.equal(new Date((await assinatura()).renews_at).getTime(), alem.getTime());
    assert.equal((await assinatura()).paused_until, null);
  });

  it('o cancelamento agendado gravado durante a emissão cancela a cobrança recém-criada', async () => {
    await assinar({ renews_at: daquiA(2) });
    aoCriar = () => getDb()('subscriptions').where({ tenant_id: alfa }).update({ cancel_at: daquiA(2) });
    const r = await emitir();
    assert.equal(r.issued, false);
    assert.equal(r.canceledAfterIssue, true);
    const [c] = await cobrancas();
    assert.equal(c.status, 'canceled');
    assert.equal(c.last_error, RETENTION_CANCEL_MARKER);
    assert.equal(cancelados().length, 1, 'cancelada no gateway');
  });

  it('o estorno do pagamento que empurrou o cancelamento agendado devolve a data dele', async () => {
    const prazo = daquiA(2);
    await assinar({ renews_at: prazo, cancel_at: prazo });
    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 10000, provider: 'manual', externalId: 'pix-empurra'
    }));
    const empurrado = new Date(pago.subscription.cancel_at).getTime();
    assert.equal(empurrado, prazo.getTime() + 30 * DIA);
    const evento = (await eventos('payment.recorded'))[0];
    assert.equal(JSON.parse(evento.detail).cancelAtBefore, prazo.toISOString());
    await runInTenant(alfa, () => SubscriptionService.reversePayment({ externalId: 'pix-empurra' }));
    const depois = await assinatura();
    assert.equal(new Date(depois.cancel_at).getTime(), prazo.getTime(), 'o cancelamento volta à data de antes');
    assert.equal(new Date(depois.renews_at).getTime(), prazo.getTime());
  });
});
