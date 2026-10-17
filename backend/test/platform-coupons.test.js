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
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionService, COUPON_FLOOR_CENTS } = await import('../src/services/subscriptionService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * O cupom de desconto da assinatura (0093).
 *
 * A montagem de `platform-billing-exempt.test.js` — o roteador do console de
 * verdade num app mínimo e um gateway de mentira em `127.0.0.1` —, mais o
 * painel para a rota do provedor e o webhook. O que importa asserir é o
 * dinheiro:
 *
 * 1. **Todo ponto de preço** pede o preço com desconto: a emissão, o preço da
 *    descida agendada, a reprecificação da fatura em aberto, o "pagar agora"
 *    e a conferência do pagamento. Nunca abaixo do piso de R$ 5,00.
 * 2. **O valor mudado à mão** pelo console continua vencendo.
 * 3. **O consumo**: um ciclo por pagamento que estende o período, uma vez só
 *    por pagamento (o webhook reentrega), devolvido pelo estorno.
 * 4. **O resgate** respeita o teto mesmo sob corrida, e as recusas têm o
 *    código que a tela lê.
 *
 * As datas são comparadas ao segundo, como em todo teste de cobrança: o MySQL
 * guarda ao segundo.
 */
const CHAVE = 'chave-do-console-de-cupons';
const TOKEN_WEBHOOK = 'token-do-webhook-dos-cupons';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
let proximoId = 0;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let viewerToken;
let alfa;
let beta;
let gama;
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
          id: `pay_cupom_${proximoId}`,
          invoiceUrl: `https://asaas.test/i/${proximoId}`,
          dueDate: payload?.dueDate ?? null,
          value: payload?.value,
          status: 'PENDING'
        });
      }
      const umaCobranca = /^\/payments\/([^/]+)$/.exec(caminho);
      if (req.method === 'DELETE' && umaCobranca) {
        const id = decodeURIComponent(umaCobranca[1]);
        if (id === 'pay_nao_cancela') return responder(500, { errors: [{ description: 'fora do ar' }] });
        return responder(200, { deleted: true, id });
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

const platform = (caminho, options = {}, token = donoToken) => call(`${consoleUrl}/api/platform${caminho}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});
const provedor = (caminho, { method = 'GET', body, token = donoToken } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(token), ...(body === undefined ? {} : { body })
});
const aplicarConsole = (tenantId, code) => platform(
  `/tenants/${tenantId}/subscription/coupon`, { method: 'PUT', body: { code } }
);
const aplicarProvedor = (code, token = donoToken) => provedor('/subscription/coupon', {
  method: 'POST', body: { code }, token
});
const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN_WEBHOOK }, body: corpo
});

const seg = (valor) => (valor === null || valor === undefined ? null : Math.floor(new Date(valor).getTime() / 1000));
const daquiA = (dias) => {
  const quando = new Date(Date.now() + dias * DAY);
  quando.setMilliseconds(0);
  return quando;
};
const assinaturaDe = (tenantId) => Subscription.forTenant(tenantId);
const cobrancaDe = (tenantId, id) => runInTenant(tenantId, () => BillingCharge.findById(id));
const cobrancasDe = (tenantId) => getDb()('billing_charges').where({ tenant_id: tenantId }).orderBy('id', 'asc');
const eventosDe = (tenantId, type) => getDb()('billing_events').where({ tenant_id: tenantId, type }).orderBy('id', 'asc');

/** Um cupom novo, com código único por caso. */
async function cupom(row = {}) {
  sequencia += 1;
  return Coupon.create({
    code: `TESTE${sequencia}`, kind: 'percent', value: 10, duration: 'forever', redemptions: 0, active: true, ...row
  });
}

async function assinar(tenantId, {
  plan = planos.pro, status = 'active', renewsAt = daquiA(2), coupon = null, cyclesLeft = null,
  pendingPlan = null, pendingAt = null
} = {}) {
  await Subscription.upsertForTenant(tenantId, {
    plan_id: plan.id,
    status,
    renews_at: renewsAt,
    trial_ends_at: null,
    canceled_at: null,
    pending_plan_id: pendingPlan?.id ?? null,
    pending_plan_at: pendingAt,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: null,
    billing_exempt_reason: null,
    coupon_id: coupon?.id ?? null,
    coupon_cycles_left: coupon ? cyclesLeft : null,
    coupon_applied_at: coupon ? new Date(Math.floor(Date.now() / 1000) * 1000) : null
  });
  await SubscriptionService.invalidate(tenantId);
}

async function periodoAtual(tenantId) {
  const sub = await assinaturaDe(tenantId);
  return ChargeIssuingService.periodKey(new Date(sub.renews_at ?? sub.trial_ends_at));
}

/** Uma cobrança do período atual, já emitida no gateway. */
async function abrirCobranca(tenantId, { amountCents = 19990, gatewayChargeId = 'pay_aberta', overridden = false } = {}) {
  return runInTenant(tenantId, async () => {
    const id = await BillingCharge.open({
      periodEnd: await periodoAtual(tenantId),
      amountCents,
      currency: 'BRL',
      provider: 'asaas',
      dueDate: ChargeIssuingService.isoDate(Date.now() + 2 * DAY)
    });
    await BillingCharge.update(id, {
      status: 'pending',
      gateway_charge_id: gatewayChargeId,
      invoice_url: 'https://asaas.test/i/velha',
      issuing_until: null,
      ...(overridden ? { amount_overridden_at: new Date() } : {})
    });
    return id;
  });
}

const emitir = (tenantId, opcoes = {}) => runInTenant(tenantId, () => ChargeIssuingService.issueCurrent(opcoes));
const pagar = (tenantId, opcoes) => runInTenant(tenantId, () => SubscriptionService.recordPayment(opcoes));

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN_WEBHOOK;

  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });

  const contratado = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(donoToken),
    body: { username: 'so-olha', password: 'senha-de-quem-olha-1', role: 'viewer', email: 'so-olha@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'so-olha', password: 'senha-de-quem-olha-1' }
  });
  viewerToken = entrou.body?.data?.token;
  assert.ok(viewerToken);

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  await db('tenants').insert({ slug: 'gama', name: 'Provedor Gama', status: 'active' });
  gama = (await db('tenants').where({ slug: 'gama' }).first()).id;
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  resetDeploymentSharing();
  await db('tenants').whereIn('id', [alfa, beta, gama])
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_qualquer' });

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.pro = await criar({ code: 'cupom-pro', name: 'Pro', price_cents: 19990 });
  planos.basico = await criar({ code: 'cupom-basico', name: 'Básico', price_cents: 9990 });
  planos.barato = await criar({ code: 'cupom-barato', name: 'Barato', price_cents: 600 });
  planos.mini = await criar({ code: 'cupom-mini', name: 'Mini', price_cents: 400 });
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
  const db = getDb();
  await db('billing_charges').whereIn('tenant_id', [alfa, beta, gama]).del();
  await db('billing_events').whereIn('tenant_id', [alfa, beta, gama]).del();
  await db('platform_audit').del();
  for (const tenantId of [alfa, beta, gama]) await assinar(tenantId);
});

describe('a conta do preço', () => {
  const sub = (coupon, extra = {}) => ({ coupon_id: coupon.id, coupon_cycles_left: null, ...extra });

  it('percentual e fixo, com o desconto arredondado para baixo', () => {
    const dez = { id: 1, kind: 'percent', value: 10, duration: 'forever', plan_ids: null };
    const fixo = { id: 2, kind: 'fixed', value: 2500, duration: 'forever', plan_ids: null };
    assert.equal(SubscriptionService.priceFor(sub(dez), planos.pro, dez), 17991, '19990 − 1999');
    assert.equal(SubscriptionService.priceFor(sub(fixo), planos.pro, fixo), 17490);
    assert.equal(SubscriptionService.priceFor({ coupon_id: null }, planos.pro, null), 19990, 'sem cupom, o plano');
  });

  it('nunca abaixo do piso do Asaas, e o plano que já custa menos fica como está', () => {
    assert.equal(COUPON_FLOOR_CENTS, 500);
    const grande = { id: 3, kind: 'fixed', value: 100000, duration: 'forever', plan_ids: null };
    const quase = { id: 4, kind: 'percent', value: 99, duration: 'forever', plan_ids: null };
    assert.equal(SubscriptionService.priceFor(sub(grande), planos.pro, grande), 500);
    assert.equal(SubscriptionService.priceFor(sub(quase), planos.barato, quase), 500);
    assert.equal(SubscriptionService.priceFor(sub(grande), planos.mini, grande), 400, 'o cupom não sobe preço');
  });

  it('vale só no plano da lista, só com ciclo, só sendo o cupom da assinatura', () => {
    const restrito = { id: 5, kind: 'percent', value: 50, duration: 'repeating', plan_ids: JSON.stringify([planos.pro.id]) };
    assert.equal(SubscriptionService.priceFor(sub(restrito, { coupon_cycles_left: 2 }), planos.pro, restrito), 9995);
    assert.equal(SubscriptionService.priceFor(sub(restrito, { coupon_cycles_left: 2 }), planos.basico, restrito), 9990,
      'fora da lista, o preço cheio');
    assert.equal(SubscriptionService.priceFor(sub(restrito, { coupon_cycles_left: 0 }), planos.pro, restrito), 19990,
      'sem ciclo, o preço cheio');
    assert.equal(SubscriptionService.priceFor({ coupon_id: 999, coupon_cycles_left: 2 }, planos.pro, restrito), 19990);
  });

  it('effectivePriceCents lê o cupom da assinatura', async () => {
    const c = await cupom({ kind: 'fixed', value: 1990 });
    await assinar(beta, { coupon: c });
    assert.equal(await SubscriptionService.effectivePriceCents(await assinaturaDe(beta), planos.pro), 18000);
    assert.equal(await SubscriptionService.effectivePriceCents(await assinaturaDe(gama), planos.pro), 19990);
  });
});

describe('o catálogo de cupons no console', () => {
  it('cria em maiúsculas, recusa o de 100%, o código repetido e o que não sabe ler', async () => {
    const criado = await platform('/coupons', {
      method: 'POST',
      body: { code: ' bemvindo10 ', kind: 'percent', value: 10, duration: 'repeating', durationCycles: 3, maxRedemptions: 5 }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.equal(criado.body.data.coupon.code, 'BEMVINDO10');
    assert.equal(criado.body.data.coupon.durationCycles, 3);
    assert.equal(criado.body.data.coupon.redemptions, 0);

    const cem = await platform('/coupons', { method: 'POST', body: { code: 'TUDO', kind: 'percent', value: 100, duration: 'once' } });
    assert.equal(cem.status, 400);
    assert.equal(cem.body.code, 'coupon_full_discount');

    const repetido = await platform('/coupons', { method: 'POST', body: { code: 'BemVindo10', kind: 'fixed', value: 100, duration: 'once' } });
    assert.equal(repetido.status, 409);
    assert.equal(repetido.body.code, 'coupon_code_taken');

    for (const body of [
      { code: 'X1', kind: 'percent', value: 0, duration: 'once' },
      { code: 'X2', kind: 'gratis', value: 10, duration: 'once' },
      { code: 'X3', kind: 'percent', value: 10, duration: 'repeating' },
      { code: 'X4', kind: 'percent', value: 10, duration: 'once', validUntil: new Date(Date.now() - DAY).toISOString() },
      { code: 'X5', kind: 'percent', value: 10, duration: 'once', planIds: [987654] },
      { code: 'a', kind: 'percent', value: 10, duration: 'once' }
    ]) {
      const res = await platform('/coupons', { method: 'POST', body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`);
    }
    const trilha = await getDb()('platform_audit').where({ action: 'coupon.created' });
    assert.equal(trilha.length, 1);
  });

  it('lista com o uso, muda só as portas do resgate, e apaga só o que nunca foi usado', async () => {
    const usado = await cupom();
    const novo = await cupom();
    assert.equal((await aplicarConsole(beta, usado.code)).status, 200);

    const lista = await platform('/coupons');
    assert.equal(lista.status, 200);
    const linha = lista.body.data.coupons.find((c) => c.id === usado.id);
    assert.equal(linha.redemptions, 1);
    assert.equal(linha.inUse, 1);

    const imutavel = await platform(`/coupons/${usado.id}`, { method: 'PATCH', body: { value: 50 } });
    assert.equal(imutavel.status, 400);
    assert.equal(imutavel.body.code, 'coupon_immutable');
    const mudou = await platform(`/coupons/${usado.id}`, { method: 'PATCH', body: { maxRedemptions: 7, active: false } });
    assert.equal(mudou.status, 200, JSON.stringify(mudou.body));
    assert.equal(mudou.body.data.coupon.maxRedemptions, 7);
    assert.equal(mudou.body.data.coupon.active, false);

    const apagaNovo = await platform(`/coupons/${novo.id}`, { method: 'DELETE' });
    assert.equal(apagaNovo.status, 200);
    assert.equal(apagaNovo.body.data.deleted, true);
    assert.equal(await Coupon.findById(novo.id), null);

    await platform(`/coupons/${usado.id}`, { method: 'PATCH', body: { active: true } });
    const apagaUsado = await platform(`/coupons/${usado.id}`, { method: 'DELETE' });
    assert.equal(apagaUsado.status, 200);
    assert.equal(apagaUsado.body.data.deleted, false);
    assert.equal(apagaUsado.body.data.deactivated, true);
    const ficou = await Coupon.findById(usado.id);
    assert.ok(ficou, 'o resgatado não some');
    assert.equal(Boolean(ficou.active), false);
    // Desativar fecha a porta dos próximos, mas quem já tem continua com o desconto.
    const beta1 = await assinaturaDe(beta);
    assert.equal(Number(beta1.coupon_id), usado.id);
    assert.equal(await SubscriptionService.effectivePriceCents(beta1, planos.pro), 17991);

    assert.equal((await platform('/coupons/999999', { method: 'DELETE' })).status, 404);
  });
});

describe('aplicar pelo console', () => {
  it('aplica, reprecifica a fatura em aberto no gateway e grava extrato e trilhas', async () => {
    const c = await cupom({ value: 20 });
    const aberta = await abrirCobranca(beta);
    const res = await aplicarConsole(beta, c.code.toLowerCase());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge, 'reissued');
    const visto = res.body.data.subscription.subscription.coupon;
    assert.equal(visto.code, c.code);
    assert.equal(visto.priceCents, 15992);
    assert.equal(visto.cyclesLeft, null);
    assert.equal(visto.appliesToPlan, true);

    assert.deepEqual(recebidas.filter((r) => r.method === 'DELETE').map((r) => r.path), ['/payments/pay_aberta']);
    const emitida = recebidas.find((r) => r.method === 'POST' && r.path === '/payments');
    assert.ok(emitida, 'reemitida');
    assert.equal(emitida.payload.value, 159.92);
    const linha = await cobrancaDe(beta, aberta);
    assert.equal(Number(linha.amount_cents), 15992);
    assert.match(linha.gateway_charge_id, /^pay_cupom_/);

    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 1);
    const [evento] = await eventosDe(beta, 'coupon.applied');
    assert.equal(JSON.parse(evento.detail).coupon.code, c.code);
    const trilha = await getDb()('platform_audit').where({ action: 'subscription.coupon_changed', tenant_id: beta });
    assert.equal(trilha.length, 1);
    const doProvedor = await getDb()('audit_log').where({ tenant_id: beta, action: 'subscription.changed' }).first();
    assert.equal(JSON.parse(doProvedor.detail).platformAction, 'subscription.coupon_changed');

    // A lista de Assinaturas mostra o selo e o preço com desconto.
    const lista = await platform('/subscriptions');
    const linhaBeta = lista.body.data.rows.find((r) => r.tenant.id === beta);
    assert.equal(linhaBeta.subscription.coupon.code, c.code);
    assert.equal(linhaBeta.subscription.coupon.priceCents, 15992);
    assert.equal(lista.body.data.rows.find((r) => r.tenant.id === gama).subscription.coupon, null);
  });

  it('o valor mudado à mão pelo console vence: a fatura não é tocada', async () => {
    const c = await cupom({ value: 20 });
    const aberta = await abrirCobranca(beta, { amountCents: 12345, overridden: true });
    const res = await aplicarConsole(beta, c.code);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge, 'none');
    assert.equal(recebidas.length, 0, 'nada vai ao gateway');
    const linha = await cobrancaDe(beta, aberta);
    assert.equal(Number(linha.amount_cents), 12345);
    assert.equal(linha.gateway_charge_id, 'pay_aberta');

    // E a emissão continua cobrando o valor mudado à mão.
    await getDb()('billing_charges').where({ id: aberta }).update({ gateway_charge_id: null, status: 'failed' });
    const emitida = await emitir(beta, { manual: true });
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    assert.equal(Number((await cobrancaDe(beta, aberta)).amount_cents), 12345);
  });

  it('o gateway que recusa o cancelamento: 502, nada muda e o resgate volta', async () => {
    const c = await cupom();
    await abrirCobranca(beta, { gatewayChargeId: 'pay_nao_cancela' });
    const res = await aplicarConsole(beta, c.code);
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.code, 'gateway_failed');
    assert.equal((await assinaturaDe(beta)).coupon_id, null);
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 0);
  });

  it('substitui o cupom que havia, e `null` tira — com a fatura de volta ao preço cheio', async () => {
    const primeiro = await cupom({ value: 10 });
    const segundo = await cupom({ kind: 'fixed', value: 5000 });
    assert.equal((await aplicarConsole(beta, primeiro.code)).status, 200);
    const troca = await aplicarConsole(beta, segundo.code);
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    assert.equal(troca.body.data.subscription.subscription.coupon.code, segundo.code);
    assert.equal(Number((await Coupon.findById(primeiro.id)).redemptions), 1, 'o resgate do velho continua contado');

    const aberta = await abrirCobranca(beta, { amountCents: 14990 });
    const tirou = await aplicarConsole(beta, null);
    assert.equal(tirou.status, 200, JSON.stringify(tirou.body));
    assert.equal(tirou.body.data.subscription.subscription.coupon, null);
    assert.equal(Number((await cobrancaDe(beta, aberta)).amount_cents), 19990);
    assert.equal((await eventosDe(beta, 'coupon.removed')).length, 1);
    const deNovo = await aplicarConsole(beta, null);
    assert.equal(deNovo.body.data.changed, false);
  });

  it('a caixa da plataforma e um provedor desconhecido respondem 404, e só o provedor da URL muda', async () => {
    const c = await cupom();
    assert.equal((await aplicarConsole(caixa, c.code)).status, 404);
    assert.equal((await aplicarConsole(999999, c.code)).status, 404);
    assert.equal((await platform(`/tenants/${beta}/subscription/coupon`, { method: 'PUT', body: {} })).status, 400);
    assert.equal((await aplicarConsole(beta, c.code)).status, 200);
    assert.equal((await assinaturaDe(gama)).coupon_id, null);
    assert.equal((await assinaturaDe(alfa)).coupon_id, null);
  });
});

describe('as recusas', () => {
  it('código inexistente ou inativo, vencido, esgotado, de outro plano, e já aplicado', async () => {
    const recusa = async (tenantId, code, esperado) => {
      const res = await aplicarConsole(tenantId, code);
      assert.equal(res.status, 409, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, esperado);
    };
    await recusa(beta, 'NAOEXISTE', 'coupon_invalid');
    await recusa(beta, (await cupom({ active: false })).code, 'coupon_invalid');
    await recusa(beta, (await cupom({ valid_until: new Date(Date.now() - DAY) })).code, 'coupon_expired');
    await recusa(beta, (await cupom({ max_redemptions: 1, redemptions: 1 })).code, 'coupon_exhausted');
    await recusa(beta, (await cupom({ plan_ids: JSON.stringify([planos.basico.id]) })).code, 'coupon_plan_mismatch');

    const c = await cupom();
    assert.equal((await aplicarConsole(beta, c.code)).status, 200);
    await recusa(beta, c.code, 'coupon_already_applied');
    // O provedor não troca o cupom que já tem — o console sim (acima).
    const outro = await cupom();
    await aplicarConsole(alfa, c.code);
    const res = await aplicarProvedor(outro.code);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'coupon_already_applied');
    assert.equal(Number((await Coupon.findById(outro.id)).redemptions), 0, 'a recusa não gasta resgate');
  });

  it('o teto de resgates segura a corrida: dois provedores, uma vaga, um só leva', async () => {
    const c = await cupom({ max_redemptions: 1 });
    const [um, dois] = await Promise.all([aplicarConsole(beta, c.code), aplicarConsole(gama, c.code)]);
    const status = [um.status, dois.status].sort();
    assert.deepEqual(status, [200, 409]);
    const perdeu = um.status === 409 ? um : dois;
    assert.equal(perdeu.body.code, 'coupon_exhausted');
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 1);
    const comCupom = [await assinaturaDe(beta), await assinaturaDe(gama)].filter((s) => s.coupon_id);
    assert.equal(comCupom.length, 1);

    // E a atualização condicional, crua: cinco resgates simultâneos, teto três.
    const tres = await cupom({ max_redemptions: 3 });
    const resgates = await Promise.all(Array.from({ length: 5 }, () => Coupon.redeem(tres.id)));
    assert.equal(resgates.filter(Boolean).length, 3);
    assert.equal(Number((await Coupon.findById(tres.id)).redemptions), 3);
  });
});

describe('o provedor aplica na tela de Plano', () => {
  it('owner aplica e a tela volta com o preço com desconto; viewer não pode', async () => {
    const c = await cupom({ kind: 'fixed', value: 4990, duration: 'repeating', duration_cycles: 2 });
    assert.equal((await aplicarProvedor(c.code, viewerToken)).status, 403);
    const res = await aplicarProvedor(c.code.toLowerCase());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const visto = res.body.data.subscription.coupon;
    assert.equal(visto.code, c.code);
    assert.equal(visto.priceCents, 15000);
    assert.equal(visto.cyclesLeft, 2);
    assert.equal(visto.duration, 'repeating');
    assert.equal((await provedor('/subscription')).body.data.subscription.coupon.priceCents, 15000);

    const trilha = await getDb()('platform_audit').where({ action: 'subscription.coupon_changed', tenant_id: alfa }).first();
    assert.equal(JSON.parse(trilha.detail).selfService, true);
    assert.equal((await aplicarProvedor('')).body.code, 'coupon_invalid');
  });

  it('o "pagar agora" emite pelo preço com desconto', async () => {
    const c = await cupom({ value: 50 });
    assert.equal((await aplicarProvedor(c.code)).status, 200);
    const res = await provedor('/charges/pay', { method: 'POST', body: {} });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    assert.equal(res.body.data.charge.amountCents, 9995);
    const emitida = recebidas.find((r) => r.method === 'POST' && r.path === '/payments');
    assert.equal(emitida.payload.value, 99.95);
  });
});

describe('a emissão em todo ponto de preço', () => {
  it('a renovação sai com o desconto', async () => {
    const c = await cupom({ value: 10 });
    await assinar(beta, { coupon: c });
    const res = await emitir(beta);
    assert.equal(res.issued, true, JSON.stringify(res));
    const [linha] = await cobrancasDe(beta);
    assert.equal(Number(linha.amount_cents), 17991);
  });

  it('a descida agendada: o cupom da lista vale no plano novo; o de fora, não', async () => {
    const soPro = await cupom({ value: 10, plan_ids: JSON.stringify([planos.pro.id]) });
    const renovacao = daquiA(2);
    await assinar(beta, { coupon: soPro, renewsAt: renovacao, pendingPlan: planos.basico, pendingAt: renovacao });
    assert.equal((await emitir(beta)).issued, true);
    assert.equal(Number((await cobrancasDe(beta))[0].amount_cents), 9990, 'o básico não está na lista do cupom');

    const qualquer = await cupom({ value: 10 });
    await assinar(gama, { coupon: qualquer, renewsAt: renovacao, pendingPlan: planos.basico, pendingAt: renovacao });
    assert.equal((await emitir(gama)).issued, true);
    assert.equal(Number((await cobrancasDe(gama))[0].amount_cents), 8991, '9990 − 999');
  });

  it('a subida reprecifica a fatura em aberto pelo plano novo com o cupom', async () => {
    const c = await cupom({ value: 10 });
    await assinar(alfa, { plan: planos.basico, coupon: c, renewsAt: daquiA(2) });
    const aberta = await abrirCobranca(alfa, { amountCents: 8991 });
    const res = await provedor('/subscription/plan', { method: 'PUT', body: { planId: planos.pro.id } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number((await cobrancaDe(alfa, aberta)).amount_cents), 17991);
  });

  it('o piso vale também na emissão', async () => {
    const c = await cupom({ kind: 'fixed', value: 50000 });
    await assinar(beta, { plan: planos.barato, coupon: c });
    assert.equal((await emitir(beta)).issued, true);
    assert.equal(Number((await cobrancasDe(beta))[0].amount_cents), 500);
  });
});

describe('o consumo dos ciclos', () => {
  it('cada pagamento que estende gasta um; no zero o cupom sai', async () => {
    const c = await cupom({ kind: 'fixed', value: 1990, duration: 'repeating', duration_cycles: 2 });
    await assinar(beta, { coupon: c, cyclesLeft: 2 });
    const um = await pagar(beta, { amountCents: 18000, externalId: 'pay_c1' });
    assert.equal(um.underpaid, false, 'o valor com desconto, sem cobrança, confere');
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 1);
    const detalhe = JSON.parse((await eventosDe(beta, 'payment.recorded'))[0].detail);
    assert.deepEqual(
      { id: detalhe.coupon.id, before: detalhe.coupon.cyclesBefore, after: detalhe.coupon.cyclesAfter, cleared: detalhe.coupon.cleared },
      { id: c.id, before: 2, after: 1, cleared: false }
    );

    await pagar(beta, { amountCents: 18000, externalId: 'pay_c2' });
    const depois = await assinaturaDe(beta);
    assert.equal(depois.coupon_id, null, 'gastou o último ciclo');
    assert.equal(depois.coupon_cycles_left, null);
    assert.equal(depois.coupon_applied_at, null);
    // E a próxima fatura sai pelo preço cheio.
    assert.equal(await SubscriptionService.effectivePriceCents(depois, planos.pro), 19990);
  });

  it('o "só a primeira fatura" e o "para sempre"', async () => {
    const uma = await cupom({ duration: 'once' });
    assert.equal((await aplicarConsole(beta, uma.code)).status, 200);
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 1);
    await pagar(beta, { amountCents: 17991, externalId: 'pay_once' });
    assert.equal((await assinaturaDe(beta)).coupon_id, null);

    const sempre = await cupom({ duration: 'forever' });
    await assinar(gama, { coupon: sempre });
    await pagar(gama, { amountCents: 17991, externalId: 'pay_sempre_1' });
    await pagar(gama, { amountCents: 17991, externalId: 'pay_sempre_2' });
    assert.equal(Number((await assinaturaDe(gama)).coupon_id), sempre.id);
  });

  it('o pagamento que não estende não gasta: pago a menos, ou assinatura suspensa', async () => {
    const c = await cupom({ duration: 'repeating', duration_cycles: 3 });
    await assinar(beta, { coupon: c, cyclesLeft: 3 });
    const curto = await pagar(beta, { amountCents: 100, externalId: 'pay_curto' });
    assert.equal(curto.underpaid, true);
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 3);

    await assinar(gama, { coupon: c, cyclesLeft: 3, status: 'suspended' });
    await pagar(gama, { amountCents: 17991, externalId: 'pay_suspenso' });
    assert.equal(Number((await assinaturaDe(gama)).coupon_cycles_left), 3);
  });

  it('o webhook reentregue gasta um ciclo só', async () => {
    const c = await cupom({ duration: 'repeating', duration_cycles: 3 });
    await assinar(beta, { coupon: c, cyclesLeft: 3 });
    const corpo = {
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_webhook_cupom', value: 179.91, customer: 'cus_ninguem', externalReference: `tenant:${beta}` }
    };
    const primeira = await entregar(corpo);
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    assert.equal(primeira.body.code, 'recorded');
    const segunda = await entregar(corpo);
    assert.equal(segunda.status, 200);
    assert.notEqual(segunda.body.code, 'recorded');
    // E a corrida, pelo serviço: as duas ao mesmo tempo.
    await Promise.all([
      pagar(beta, { amountCents: 17991, externalId: 'pay_corrida' }),
      pagar(beta, { amountCents: 17991, externalId: 'pay_corrida' })
    ]);
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 1, '3 − 1 (webhook) − 1 (corrida)');
    assert.equal((await eventosDe(beta, 'payment.recorded')).length, 2);
  });

  it('o estorno devolve o ciclo — e o cupom inteiro, quando foi ele que o tirou — uma vez só', async () => {
    const c = await cupom({ duration: 'repeating', duration_cycles: 2 });
    await assinar(beta, { coupon: c, cyclesLeft: 2 });
    const aplicado = (await assinaturaDe(beta)).coupon_applied_at;
    await pagar(beta, { amountCents: 17991, externalId: 'pay_r1' });
    await pagar(beta, { amountCents: 17991, externalId: 'pay_r2' });
    assert.equal((await assinaturaDe(beta)).coupon_id, null);

    const estorno = await runInTenant(beta, () => SubscriptionService.reversePayment({ externalId: 'pay_r2' }));
    assert.equal(estorno.duplicate, false);
    const voltou = await assinaturaDe(beta);
    assert.equal(Number(voltou.coupon_id), c.id, 'o cupom volta');
    assert.equal(Number(voltou.coupon_cycles_left), 1);
    assert.equal(seg(voltou.coupon_applied_at), seg(aplicado));
    const [marca] = await eventosDe(beta, 'payment.refunded');
    assert.deepEqual(JSON.parse(marca.detail).couponRestored.reattached, true);

    const outra = await runInTenant(beta, () => SubscriptionService.reversePayment({ externalId: 'pay_r2', source: 'webhook' }));
    assert.equal(outra.duplicate, true);
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 1, 'o segundo estorno não devolve outro');

    await runInTenant(beta, () => SubscriptionService.reversePayment({ externalId: 'pay_r1' }));
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 2, 'com o cupom no lugar, um ciclo a mais');
  });
});

describe('um resgate por provedor', () => {
  const resgatesDe = (couponId, tenantId) => getDb()('coupon_redemptions').where({ coupon_id: couponId, tenant_id: tenantId });

  it('o provedor não reaplica o cupom que já gastou; o console pode, sem contar outro resgate', async () => {
    const c = await cupom({ duration: 'once' });
    assert.equal((await aplicarProvedor(c.code)).status, 200);
    assert.equal((await resgatesDe(c.id, alfa)).length, 1);
    await pagar(alfa, { amountCents: 17991, externalId: 'pay_gastou_once' });
    assert.equal((await assinaturaDe(alfa)).coupon_id, null, 'o ciclo único foi gasto');

    const deNovo = await aplicarProvedor(c.code);
    assert.equal(deNovo.status, 409, JSON.stringify(deNovo.body));
    assert.equal(deNovo.body.code, 'coupon_already_used');
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 1);

    // O console passa por cima — e o provedor já ocupa a vaga dele.
    const peloConsole = await aplicarConsole(alfa, c.code);
    assert.equal(peloConsole.status, 200, JSON.stringify(peloConsole.body));
    assert.equal(Number((await assinaturaDe(alfa)).coupon_id), c.id);
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 1, 'reaplicar não conta outro resgate');
    assert.equal((await resgatesDe(c.id, alfa)).length, 1);

    // Outro provedor resgata normalmente.
    assert.equal((await aplicarConsole(beta, c.code)).status, 200);
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 2);
    assert.equal((await resgatesDe(c.id, beta)).length, 1);
  });

  it('o console reaplica a quem já resgatou mesmo com o teto cheio', async () => {
    const c = await cupom({ max_redemptions: 1 });
    assert.equal((await aplicarConsole(beta, c.code)).status, 200);
    assert.equal((await aplicarConsole(beta, null)).status, 200);
    const outro = await aplicarConsole(gama, c.code);
    assert.equal(outro.body.code, 'coupon_exhausted');
    assert.equal((await aplicarConsole(beta, c.code)).status, 200, 'a vaga já é dele');
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 1);
  });

  it('a aplicação que falha devolve a vaga e a linha do resgate juntas', async () => {
    const c = await cupom();
    await abrirCobranca(alfa, { gatewayChargeId: 'pay_nao_cancela' });
    const res = await aplicarProvedor(c.code);
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(Number((await Coupon.findById(c.id)).redemptions), 0);
    assert.equal((await resgatesDe(c.id, alfa)).length, 0);
    // E, sem a fatura presa, o provedor consegue aplicar depois.
    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    assert.equal((await aplicarProvedor(c.code)).status, 200);
  });

  it('a rota do provedor não diz por que o cupom não vale; o console diz', async () => {
    const casos = [
      [await cupom({ valid_until: new Date(Date.now() - DAY) }), 'coupon_expired'],
      [await cupom({ max_redemptions: 1, redemptions: 1 }), 'coupon_exhausted'],
      [await cupom({ plan_ids: JSON.stringify([planos.basico.id]) }), 'coupon_plan_mismatch'],
      [await cupom({ active: false }), 'coupon_invalid']
    ];
    for (const [c, doConsole] of casos) {
      const prov = await aplicarProvedor(c.code);
      assert.equal(prov.status, 409);
      assert.equal(prov.body.code, 'coupon_invalid', `${c.code}: ${JSON.stringify(prov.body)}`);
      assert.equal((await aplicarConsole(beta, c.code)).body.code, doConsole);
    }
  });
});

describe('o ciclo só é gasto pela fatura que levou o desconto', () => {
  it('a emissão grava o plano e o cupom na cobrança, e pagá-la gasta o ciclo', async () => {
    const c = await cupom({ duration: 'once' });
    await assinar(beta, { coupon: c, cyclesLeft: 1 });
    const emitida = await emitir(beta);
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    const [linha] = await cobrancasDe(beta);
    assert.equal(Number(linha.plan_id), planos.pro.id);
    assert.equal(Number(linha.coupon_id), c.id);
    await pagar(beta, { amountCents: 17991, externalId: linha.gateway_charge_id });
    assert.equal((await assinaturaDe(beta)).coupon_id, null);
  });

  it('a cobrança com valor mudado à mão não gasta o "só a primeira fatura"', async () => {
    const c = await cupom({ duration: 'once' });
    await assinar(beta, { coupon: c, cyclesLeft: 1 });
    await abrirCobranca(beta, { amountCents: 12345, gatewayChargeId: 'pay_mao', overridden: true });
    const pago = await pagar(beta, { amountCents: 12345, externalId: 'pay_mao' });
    assert.equal(pago.underpaid, false);
    const depois = await assinaturaDe(beta);
    assert.equal(Number(depois.coupon_id), c.id);
    assert.equal(Number(depois.coupon_cycles_left), 1);
  });

  it('suspenso, cupom pelo console, e a fatura velha de preço cheio paga: o ciclo fica', async () => {
    const c = await cupom({ duration: 'once' });
    await assinar(gama, { status: 'suspended' });
    await abrirCobranca(gama, { amountCents: 19990, gatewayChargeId: 'pay_velha_cheia' });
    const aplicado = await aplicarConsole(gama, c.code);
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.body));
    assert.equal(aplicado.body.data.charge, 'none', 'o suspenso não tem a fatura reprecificada');
    await Subscription.upsertForTenant(gama, { status: 'active' });
    await SubscriptionService.invalidate(gama);
    await pagar(gama, { amountCents: 19990, externalId: 'pay_velha_cheia' });
    const depois = await assinaturaDe(gama);
    assert.equal(Number(depois.coupon_id), c.id, 'a fatura paga não tinha o desconto');
    assert.equal(Number(depois.coupon_cycles_left), 1);
  });

  it('a cobrança emitida sem o cupom (plano fora da lista) não gasta, mesmo com o valor igual', async () => {
    const c = await cupom({ duration: 'once', plan_ids: JSON.stringify([planos.basico.id]) });
    await assinar(beta, { coupon: c, cyclesLeft: 1 });
    assert.equal((await emitir(beta)).issued, true);
    const [linha] = await cobrancasDe(beta);
    assert.equal(linha.coupon_id, null);
    await pagar(beta, { amountCents: 19990, externalId: linha.gateway_charge_id });
    assert.equal(Number((await assinaturaDe(beta)).coupon_cycles_left), 1);
  });
});

describe('a descida agendada paga, com o cupom no meio', () => {
  async function pagarDescida(tenantId, c) {
    const renovacao = daquiA(2);
    await assinar(tenantId, { coupon: c, renewsAt: renovacao, pendingPlan: planos.basico, pendingAt: renovacao });
    const emitida = await emitir(tenantId);
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    const [linha] = await cobrancasDe(tenantId);
    assert.equal(Number(linha.plan_id), planos.basico.id, 'a cobrança diz que é do plano agendado');
    await pagar(tenantId, { amountCents: Number(linha.amount_cents), externalId: linha.gateway_charge_id });
    return { renovacao, linha, depois: await assinaturaDe(tenantId) };
  }

  it('A: cupom só no Pro, que fica mais barato que o Básico — pagar o Básico trava a descida', async () => {
    const c = await cupom({ kind: 'fixed', value: 15000, plan_ids: JSON.stringify([planos.pro.id]) });
    const { renovacao, linha, depois } = await pagarDescida(beta, c);
    assert.equal(Number(linha.amount_cents), 9990);
    assert.ok(depois.pending_plan_locked_at, 'travada, e não adiada');
    assert.equal(seg(depois.pending_plan_at), seg(renovacao), 'a data da descida não andou');
    assert.equal(Number(depois.pending_plan_id), planos.basico.id);
  });

  it('B: os dois planos no piso — pagar a descida trava, em vez de adiar para sempre', async () => {
    const c = await cupom({ kind: 'fixed', value: 50000 });
    const { renovacao, linha, depois } = await pagarDescida(gama, c);
    assert.equal(Number(linha.amount_cents), 500);
    assert.ok(depois.pending_plan_locked_at);
    assert.equal(seg(depois.pending_plan_at), seg(renovacao));
  });

  it('e a tela do provedor lê a mesma trava pela cobrança paga do período', async () => {
    const c = await cupom({ kind: 'fixed', value: 50000 });
    const renovacao = daquiA(2);
    await assinar(alfa, { coupon: c, renewsAt: renovacao, pendingPlan: planos.basico, pendingAt: renovacao });
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey(renovacao),
        amountCents: 500,
        currency: 'BRL',
        provider: 'asaas',
        planId: planos.basico.id,
        couponId: c.id
      });
      await BillingCharge.update(id, { status: 'paid', gateway_charge_id: 'pay_descida_paga', issuing_until: null });
    });
    const res = await provedor('/subscription/plan', { method: 'PUT', body: { planId: planos.barato.id } });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'pending_locked');
    assert.ok((await assinaturaDe(alfa)).pending_plan_locked_at);
  });
});
