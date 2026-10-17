import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * O estorno de uma cobrança paga, pelo console e pelo gateway.
 *
 * A mesma montagem de `platform-subscriptions.test.js` (self-hosted, o
 * roteador do console de verdade num app mínimo, um gateway de mentira em
 * `127.0.0.1`), pelo mesmo motivo: o valor está em asserir o que SAI para o
 * gateway — o `refund` do Pix, o `undoReceivedInCash` da baixa em dinheiro, a
 * AUSÊNCIA de chamada quando o dinheiro volta por fora.
 *
 * As três coisas que não podem dar errado:
 *
 * 1. **Desfazer duas vezes.** O estorno do console faz a Asaas mandar o
 *    `PAYMENT_REFUNDED` do mesmo pagamento — e ele não pode tirar outro
 *    período.
 * 2. **Desfazer de um lado só.** O gateway recusou? Nada muda aqui.
 * 3. **Desfazer o que não foi feito.** O pagamento a menos que não estendeu
 *    nada não devolve dia nenhum.
 *
 * Nenhuma data é comparada contra o relógio ao milissegundo: o MySQL guarda
 * ao segundo. As comparações exatas são entre datas LIDAS do banco, ou contra
 * uma data redonda gravada pelo próprio teste.
 */
const CHAVE = 'chave-do-console-de-estornos';
const TOKEN = 'token-do-webhook-dos-estornos';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
/** O que o gateway de mentira diz de cada cobrança no `GET /payments/{id}` — RECEIVED quando não diz nada. */
const estadoNoGateway = new Map();
/** O que o gateway de mentira faz antes de responder ao `refund` de um id. */
const antesDoEstorno = new Map();
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let comumToken;
let beta;
let gama;
let caixa;
let plano;
let planoMini;

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
      const gesto = /^\/payments\/([^/]+)\/(refund|undoReceivedInCash|receiveInCash)$/.exec(caminho);
      if (req.method === 'POST' && gesto) {
        const id = decodeURIComponent(gesto[1]);
        if (id === 'pay_recusa') return responder(400, { errors: [{ description: 'saldo insuficiente para estorno' }] });
        const status = { refund: 'REFUNDED', undoReceivedInCash: 'PENDING', receiveInCash: 'RECEIVED_IN_CASH' }[gesto[2]];
        // A corrida de verdade: a Asaas avisa do estorno ANTES de responder
        // ao pedido dele — o webhook ganha do próprio console.
        const antesDeResponder = gesto[2] === 'refund' ? antesDoEstorno.get(id) : null;
        if (antesDeResponder) {
          antesDeResponder().then(() => responder(200, { id, status }), () => responder(500, {}));
          return undefined;
        }
        return responder(200, { id, status });
      }
      const umaCobranca = /^\/payments\/([^/]+)$/.exec(caminho);
      if (req.method === 'GET' && umaCobranca) {
        const id = decodeURIComponent(umaCobranca[1]);
        return responder(200, { id, status: estadoNoGateway.get(id) ?? 'RECEIVED', value: 100 });
      }
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

const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: corpo
});

const ms = (valor) => (valor === null || valor === undefined ? null : new Date(valor).getTime());
const assinaturaDe = (tenantId) => Subscription.forTenant(tenantId);
const cobrancaDe = (tenantId, id) => runInTenant(tenantId, () => BillingCharge.findById(id));
const eventosDe = (tenantId) => getDb()('billing_events').where({ tenant_id: tenantId }).orderBy('id', 'asc');
const estornosDe = async (tenantId) => (await eventosDe(tenantId)).filter((e) => e.type === 'payment.refunded');
const hoje = () => ChargeIssuingService.isoDate(new Date());
const estornar = (tenantId, id, body = {}, token = donoToken) => platform(
  `/tenants/${tenantId}/charges/${id}/refund`, { method: 'POST', body }, token
);

async function periodoAtual(tenantId) {
  const sub = await assinaturaDe(tenantId);
  return ChargeIssuingService.periodKey(new Date(sub.renews_at ?? sub.trial_ends_at));
}

/** Uma cobrança pronta para o caso, gravada no escopo do dono. */
async function abrirCobranca(tenantId, {
  periodEnd, amountCents = 10000, provider = 'asaas', gatewayChargeId = null, status = 'pending'
} = {}) {
  return runInTenant(tenantId, async () => {
    const id = await BillingCharge.open({
      periodEnd: periodEnd ?? await periodoAtual(tenantId),
      amountCents,
      currency: 'BRL',
      provider,
      dueDate: ChargeIssuingService.isoDate(Date.now() + 5 * DAY)
    });
    await BillingCharge.update(id, { status, gateway_charge_id: gatewayChargeId, issuing_until: null });
    return id;
  });
}

/** O Pix que o webhook creditou — o caminho de todo pagamento de verdade. */
async function pagaPeloGateway(tenantId, gatewayChargeId, { value = 100, amountCents = 10000 } = {}) {
  const periodo = await periodoAtual(tenantId);
  const id = await abrirCobranca(tenantId, { gatewayChargeId, amountCents });
  const aviso = await entregar({
    event: 'PAYMENT_RECEIVED',
    payment: { id: gatewayChargeId, value, externalReference: `tenant:${tenantId}:${periodo}` }
  });
  assert.equal(aviso.status, 200);
  return { id, periodo, aviso };
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN;

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
    body: { username: 'comum', password: 'senha-do-comum-1', role: 'admin', email: 'comum@exemplo.test' }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum', password: 'senha-do-comum-1' }
  });
  comumToken = entrou.body?.data?.token;
  assert.ok(comumToken);

  const db = getDb();
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

  await db('tenants').whereIn('id', [beta, gama])
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_qualquer' });
  plano = await Plan.create({
    code: 'estorno-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  planoMini = await Plan.create({
    code: 'estorno-mini', name: 'Mini', price_cents: 5000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
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
  estadoNoGateway.clear();
  antesDoEstorno.clear();
  const db = getDb();
  await db('billing_charges').whereIn('tenant_id', [beta, gama]).del();
  await db('billing_events').whereIn('tenant_id', [beta, gama]).del();
  await db('platform_audit').del();
  const agora = Date.now();
  for (const tenantId of [beta, gama]) {
    await Subscription.upsertForTenant(tenantId, {
      plan_id: plano.id, status: 'active', renews_at: new Date(agora + 10 * DAY), trial_ends_at: null,
      pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null
    });
    await SubscriptionService.invalidate(tenantId);
  }
});

describe('o estorno pelo console', () => {
  it('Pix: estorna no gateway, devolve o prazo, e o PAYMENT_REFUNDED depois não tira outro período', async () => {
    const antes = await assinaturaDe(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_pix');
    const pago = await assinaturaDe(beta);
    assert.equal(ms(pago.renews_at), ms(antes.renews_at) + 30 * DAY);
    assert.equal((await cobrancaDe(beta, id)).status, 'paid');
    recebidas = [];

    const res = await estornar(beta, id, { reason: 'cliente desistiu' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
      'GET /payments/pay_pix', 'POST /payments/pay_pix/refund'
    ]);
    assert.deepEqual(recebidas[1].payload, {}, 'o estorno inteiro: sem valor no corpo');

    const { data } = res.body;
    assert.equal(data.charge.status, 'refunded');
    assert.equal(data.alreadyRefunded, false);
    assert.equal(ms(data.renewsAtBefore), ms(pago.renews_at));
    assert.equal(ms(data.renewsAtAfter), ms(antes.renews_at));
    assert.equal(data.subscription.tenant.id, beta, 'o mesmo corpo do GET da assinatura');
    assert.equal(data.subscription.subscription.status, 'active');
    assert.ok(data.subscription.events.some((e) => e.type === 'payment.refunded'));

    const depois = await assinaturaDe(beta);
    assert.equal(ms(depois.renews_at), ms(antes.renews_at), 'o período comprado foi desfeito');
    assert.equal(depois.status, 'active');
    const linha = await cobrancaDe(beta, id);
    assert.equal(linha.status, 'refunded');
    assert.equal(linha.issuing_until, null, 'a garra saiu');

    const [estorno] = await estornosDe(beta);
    assert.equal(estorno.external_id, 'pay_pix:refund');
    assert.equal(Number(estorno.amount_cents), 10000);
    const detalhe = JSON.parse(estorno.detail);
    assert.equal(detalhe.source, 'console');
    assert.equal(detalhe.reason, 'cliente desistiu');
    assert.equal(detalhe.basis, 'restored', 'nada mexeu no prazo depois: volta exatamente ao de antes');
    assert.equal(detalhe.reversedDays, 30);

    const trilha = await getDb()('platform_audit').where({ action: 'charge.refunded', tenant_id: beta }).first();
    assert.ok(trilha);
    const auditado = JSON.parse(trilha.detail);
    assert.equal(auditado.amountCents, 10000);
    assert.equal(auditado.outsideGateway, false);
    assert.equal(auditado.reason, 'cliente desistiu');
    assert.equal(ms(auditado.renewsAtBefore), ms(pago.renews_at));
    assert.equal(ms(auditado.renewsAtAfter), ms(antes.renews_at));

    // A Asaas avisa do estorno que o próprio console pediu.
    const aviso = await entregar({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_pix', value: 100, externalReference: `tenant:${beta}` } });
    assert.equal(aviso.status, 200);
    assert.equal(aviso.body.reversal, 'duplicate');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at), 'nenhum período a menos');
    assert.equal((await estornosDe(beta)).length, 1);

    // E o botão apertado de novo: a linha já não está paga.
    const outra = await estornar(beta, id);
    assert.equal(outra.status, 409);
    assert.equal(outra.body.code, 'not_paid');
    assert.equal(outra.body.status, 'refunded');
  });

  it('baixa em dinheiro: desfaz o recebimento e CANCELA no gateway — e um pagamento depois não some calado', async () => {
    const antes = await assinaturaDe(beta);
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_dinheiro' });
    estadoNoGateway.set('pay_dinheiro', 'PENDING');
    const baixa = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(baixa.status, 200, JSON.stringify(baixa.body));
    estadoNoGateway.set('pay_dinheiro', 'RECEIVED_IN_CASH');
    recebidas = [];

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
      'GET /payments/pay_dinheiro', 'POST /payments/pay_dinheiro/undoReceivedInCash', 'DELETE /payments/pay_dinheiro'
    ]);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    assert.equal((await cobrancaDe(beta, id)).status, 'refunded');
    const trilha = await getDb()('platform_audit').where({ action: 'charge.refunded', tenant_id: beta }).first();
    assert.equal(JSON.parse(trilha.detail).atGateway, 'undo_received_in_cash');

    // Se mesmo assim um pagamento chegar com esse id, ele não vira `duplicate`
    // em silêncio: código próprio, nada creditado, nada marcado pago.
    const aviso = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_dinheiro', value: 100, externalReference: `tenant:${beta}` }
    });
    assert.equal(aviso.status, 200);
    assert.equal(aviso.body.code, 'refunded_reference');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    assert.equal((await cobrancaDe(beta, id)).status, 'refunded');
    assert.equal((await eventosDe(beta)).filter((e) => e.type === 'payment.recorded').length, 1);
  });

  it('baixa em dinheiro desfeita, mas o cancelamento no gateway falhou: 502, e nada muda aqui', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_nao_cancela' });
    estadoNoGateway.set('pay_nao_cancela', 'PENDING');
    const baixa = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(baixa.status, 200, JSON.stringify(baixa.body));
    const pago = await assinaturaDe(beta);
    estadoNoGateway.set('pay_nao_cancela', 'RECEIVED_IN_CASH');

    const res = await estornar(beta, id);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    assert.equal((await cobrancaDe(beta, id)).status, 'paid');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(pago.renews_at));
    assert.equal((await estornosDe(beta)).length, 0);
  });

  it('o webhook do próprio estorno chega antes da resposta: não é "já estornado", e as datas são as do registro', async () => {
    const antes = await assinaturaDe(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_corrida');
    const pago = await assinaturaDe(beta);
    let aviso;
    antesDoEstorno.set('pay_corrida', async () => {
      aviso = await entregar({
        event: 'PAYMENT_REFUNDED', payment: { id: 'pay_corrida', value: 100, externalReference: `tenant:${beta}` }
      });
    });

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(aviso.body.reversal, 'reversed', 'o webhook desfez primeiro');
    assert.equal(res.body.data.alreadyRefunded, false);
    assert.equal(ms(res.body.data.renewsAtBefore), ms(pago.renews_at));
    assert.equal(ms(res.body.data.renewsAtAfter), ms(antes.renews_at));
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at), 'uma vez só');
    assert.equal((await estornosDe(beta)).length, 1);
    const trilha = JSON.parse((await getDb()('platform_audit')
      .where({ action: 'charge.refunded', tenant_id: beta }).first()).detail);
    assert.equal(trilha.alreadyRefunded, false);
    assert.equal(ms(trilha.renewsAtBefore), ms(pago.renews_at));
    assert.equal(ms(trilha.renewsAtAfter), ms(antes.renews_at));
  });

  it('pago atrasado e o prazo mexido depois: desfaz só o período comprado, não os dias vencidos', async () => {
    // O prazo venceu há dez dias; o pagamento A chega atrasado e conta de
    // agora (+30); o B chega adiantado e soma mais 30. Estornar A tira os 30
    // que A comprou — e não os 40 entre o prazo vencido e o fim de A, que
    // comeriam dez dias do B.
    const vencido = new Date(Math.floor((Date.now() - 10 * DAY) / 1000) * 1000);
    await Subscription.upsertForTenant(beta, { renews_at: vencido });
    await SubscriptionService.invalidate(beta);
    const { id: cobrancaA } = await pagaPeloGateway(beta, 'pay_a_atrasado');
    const depoisDeA = await assinaturaDe(beta);
    await pagaPeloGateway(beta, 'pay_b_adiantado');
    const depoisDeB = await assinaturaDe(beta);
    assert.equal(ms(depoisDeB.renews_at), ms(depoisDeA.renews_at) + 30 * DAY);

    const res = await estornar(beta, cobrancaA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(depoisDeB.renews_at) - 30 * DAY);
    const [estorno] = await estornosDe(beta);
    assert.equal(JSON.parse(estorno.detail).basis, 'purchased');
    assert.equal(JSON.parse(estorno.detail).reversedDays, 30);
  });

  it('já estornada no painel da Asaas, sem o webhook: segue sem chamar o estorno e desfaz o lado de cá', async () => {
    const antes = await assinaturaDe(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_la_dentro');
    estadoNoGateway.set('pay_la_dentro', 'REFUNDED');
    recebidas = [];

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['GET /payments/pay_la_dentro']);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const trilha = await getDb()('platform_audit').where({ action: 'charge.refunded', tenant_id: beta }).first();
    assert.equal(JSON.parse(trilha.detail).atGateway, 'already_refunded');
  });

  it('com o estorno a caminho no gateway: segue, e a trilha diz que ele não é final', async () => {
    const antes = await assinaturaDe(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_a_caminho');
    estadoNoGateway.set('pay_a_caminho', 'REFUND_IN_PROGRESS');
    recebidas = [];

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['GET /payments/pay_a_caminho']);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const trilha = await getDb()('platform_audit').where({ action: 'charge.refunded', tenant_id: beta }).first();
    assert.equal(JSON.parse(trilha.detail).atGateway, 'refund_in_progress');
  });

  it('o gateway recusou: 502, e nada muda', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_recusa');
    const pago = await assinaturaDe(beta);

    const res = await estornar(beta, id);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    assert.match(res.body.detail, /saldo insuficiente/);
    const linha = await cobrancaDe(beta, id);
    assert.equal(linha.status, 'paid');
    assert.equal(linha.issuing_until, null, 'a garra é solta mesmo na falha');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(pago.renews_at));
    assert.equal((await estornosDe(beta)).length, 0);
    assert.equal(await getDb()('platform_audit').where({ action: 'charge.refunded' }).first(), undefined);
  });

  it('o gateway não tem o dinheiro que o painel diz ter recebido: 409, e por fora resolve', async () => {
    const antes = await assinaturaDe(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_desencontro');
    estadoNoGateway.set('pay_desencontro', 'PENDING');

    const res = await estornar(beta, id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'not_paid');
    assert.equal(res.body.status, 'paid');
    assert.equal(res.body.gatewayStatus, 'PENDING');
    assert.equal((await cobrancaDe(beta, id)).status, 'paid');

    recebidas = [];
    const porFora = await estornar(beta, id, { outsideGateway: true, reason: 'devolvido por transferência' });
    assert.equal(porFora.status, 200, JSON.stringify(porFora.body));
    assert.equal(recebidas.length, 0, 'outsideGateway não fala com a Asaas');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const trilha = await getDb()('platform_audit').where({ action: 'charge.refunded', tenant_id: beta }).first();
    assert.equal(JSON.parse(trilha.detail).outsideGateway, true);
  });

  it('a cobrança que nunca chegou ao gateway: desfaz só do lado de cá, pela referência da linha', async () => {
    const antes = await assinaturaDe(beta);
    const id = await abrirCobranca(beta, { provider: 'manual' });
    const baixa = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(baixa.status, 200, JSON.stringify(baixa.body));
    recebidas = [];

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(recebidas.length, 0);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const [estorno] = await estornosDe(beta);
    assert.equal(estorno.external_id, `charge:${id}:refund`);
  });

  it('o prazo que volta para o passado deixa o provedor past_due, sem gravar past_due', async () => {
    const vencido = new Date(Math.floor((Date.now() - 5 * DAY) / 1000) * 1000);
    await Subscription.upsertForTenant(beta, { renews_at: vencido });
    await SubscriptionService.invalidate(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_atrasado');
    assert.ok(ms((await assinaturaDe(beta)).renews_at) > Date.now(), 'pago atrasado, o período conta de agora');

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(beta);
    assert.equal(ms(depois.renews_at), vencido.getTime(), 'volta ao prazo vencido de antes do pagamento');
    assert.equal(depois.status, 'active', 'a coluna não muda');
    assert.equal(res.body.data.subscription.subscription.status, 'past_due');
    assert.equal(res.body.data.subscription.subscription.storedStatus, 'active');
    assert.equal(SubscriptionService.effectiveStatus(depois).status, 'past_due');
  });

  it('um evento de antes do estorno existir, sem o prazo de antes: volta o período do plano', async () => {
    const renova = new Date(Math.floor((Date.now() + 40 * DAY) / 1000) * 1000);
    await Subscription.upsertForTenant(beta, { renews_at: renova });
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_antigo', status: 'paid' });
    // O `detail` como `recordPayment` o gravava antes do estorno: sem
    // `renewsBefore`, sem `periodDays`.
    await getDb()('billing_events').insert({
      tenant_id: beta,
      subscription_id: (await assinaturaDe(beta)).id,
      type: 'payment.recorded',
      amount_cents: 10000,
      currency: 'BRL',
      provider: 'asaas',
      external_id: 'pay_antigo',
      detail: JSON.stringify({
        statusBefore: 'active', statusAfter: 'active', renewsAt: renova.toISOString(), expectedCents: 10000
      })
    });

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(ms((await assinaturaDe(beta)).renews_at), renova.getTime() - 30 * DAY);
    const [estorno] = await estornosDe(beta);
    assert.equal(JSON.parse(estorno.detail).basis, 'period_days');
  });

  it('o pagamento a menos aceito pelo console: o estorno desfaz o que o aceite estendeu', async () => {
    const antes = await assinaturaDe(beta);
    const { id, aviso } = await pagaPeloGateway(beta, 'pay_curto', { value: 90 });
    assert.equal(aviso.body.code, 'underpaid');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at), 'o curto não estendeu');
    const aceite = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 9000, allowUnderpayment: true }
    });
    assert.equal(aceite.status, 200, JSON.stringify(aceite.body));
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at) + 30 * DAY);

    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
  });

  it('recusa a cobrança que não está paga, e a tomada por outro', async () => {
    const aberta = await abrirCobranca(beta, { gatewayChargeId: 'pay_aberta' });
    const res = await estornar(beta, aberta);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'not_paid');
    assert.equal(res.body.status, 'pending');

    const paga = await abrirCobranca(beta, { periodEnd: '2027-01-01', gatewayChargeId: 'pay_tomada', status: 'paid' });
    await runInTenant(beta, () => BillingCharge.update(paga, { issuing_until: new Date(Date.now() + 60_000) }));
    const ocupada = await estornar(beta, paga);
    assert.equal(ocupada.status, 409);
    assert.equal(ocupada.body.code, 'busy');
    assert.equal(recebidas.length, 0);
  });

  it('a cobrança do vizinho não é alcançada, e quem não é da plataforma não chega', async () => {
    const doGama = await abrirCobranca(gama, { gatewayChargeId: 'pay_gama', status: 'paid' });
    const cruzada = await estornar(beta, doGama);
    assert.equal(cruzada.status, 404);
    assert.equal(cruzada.body.code, 'not_found');
    assert.equal((await estornar(beta, 999999)).status, 404);
    assert.equal((await estornar(caixa, doGama)).status, 404);
    assert.equal((await estornar(gama, doGama, {}, comumToken)).status, 404);
    assert.equal(recebidas.length, 0);
    assert.equal((await cobrancaDe(gama, doGama)).status, 'paid');
  });
});

describe('a trava da descida agendada', () => {
  /** A descida para o Mini na renovação, paga adiantada pelo preço dele — o que a trava. */
  async function descidaPaga(gatewayChargeId) {
    const sub = await assinaturaDe(beta);
    await Subscription.upsertForTenant(beta, { pending_plan_id: planoMini.id, pending_plan_at: sub.renews_at });
    await SubscriptionService.invalidate(beta);
    const { id } = await pagaPeloGateway(beta, gatewayChargeId, { value: 50, amountCents: 5000 });
    const travada = await assinaturaDe(beta);
    assert.ok(travada.pending_plan_locked_at, 'pagou o preço do Mini: a descida travou');
    return id;
  }

  it('sai com o estorno do pagamento que a pôs', async () => {
    const id = await descidaPaga('pay_trava');
    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(beta);
    assert.equal(depois.pending_plan_locked_at, null);
    assert.equal(Number(depois.pending_plan_id), planoMini.id, 'a descida continua agendada, só destravada');
    assert.equal(JSON.parse((await estornosDe(beta))[0].detail).pendingUnlocked, true);
  });

  it('e fica quando a trava de agora não é a que ele pôs', async () => {
    const id = await descidaPaga('pay_trava_outra');
    const outraTrava = new Date(Math.floor((Date.now() + 3600_000) / 1000) * 1000);
    await Subscription.upsertForTenant(beta, { pending_plan_locked_at: outraTrava });
    const res = await estornar(beta, id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(ms((await assinaturaDe(beta)).pending_plan_locked_at), outraTrava.getTime());
  });
});

describe('o estorno pelo painel da Asaas (webhook)', () => {
  it('desfaz o período, e o botão do console depois não tem o que estornar', async () => {
    const antes = await assinaturaDe(beta);
    const { id } = await pagaPeloGateway(beta, 'pay_so_webhook');

    const aviso = await entregar({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_so_webhook', value: 100, externalReference: `tenant:${beta}` } });
    assert.equal(aviso.status, 200);
    assert.equal(aviso.body.code, 'charge_updated');
    assert.equal(aviso.body.reversal, 'reversed');
    assert.equal((await cobrancaDe(beta, id)).status, 'refunded');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const [estorno] = await estornosDe(beta);
    assert.equal(JSON.parse(estorno.detail).source, 'webhook');

    const botao = await estornar(beta, id);
    assert.equal(botao.status, 409);
    assert.equal(botao.body.code, 'not_paid');
  });

  it('o pagamento a menos que não estendeu nada: o estorno não devolve dia nenhum', async () => {
    const antes = await assinaturaDe(beta);
    await pagaPeloGateway(beta, 'pay_curto_webhook', { value: 50 });
    const aviso = await entregar({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_curto_webhook', value: 50, externalReference: `tenant:${beta}` } });
    assert.equal(aviso.status, 200);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const [estorno] = await estornosDe(beta);
    assert.equal(JSON.parse(estorno.detail).basis, 'not_extended');
  });

  it('o estorno parcial não desfaz nada, nem a etiqueta', async () => {
    const pago = await (async () => { await pagaPeloGateway(beta, 'pay_parcial'); return assinaturaDe(beta); })();
    const aviso = await entregar({
      event: 'PAYMENT_REFUNDED',
      payment: {
        id: 'pay_parcial', value: 100, externalReference: `tenant:${beta}`,
        refunds: [{ status: 'DONE', value: 40 }]
      }
    });
    assert.equal(aviso.status, 200);
    assert.equal(aviso.body.code, 'partial_refund');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(pago.renews_at));
    const linha = await getDb()('billing_charges').where({ tenant_id: beta, gateway_charge_id: 'pay_parcial' }).first();
    assert.equal(linha.status, 'paid');
    assert.equal((await estornosDe(beta)).length, 0);
  });

  it('os outros eventos de estorno (negado, em andamento) só vão para o log', async () => {
    const pago = await (async () => { await pagaPeloGateway(beta, 'pay_negado'); return assinaturaDe(beta); })();
    for (const event of ['PAYMENT_REFUND_DENIED', 'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_PARTIALLY_REFUNDED']) {
      const aviso = await entregar({
        event, payment: { id: 'pay_negado', value: 100, externalReference: `tenant:${beta}` }
      });
      assert.equal(aviso.status, 200);
      assert.equal(aviso.body.code, 'refund_event_logged', event);
    }
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(pago.renews_at));
    const linha = await getDb()('billing_charges').where({ tenant_id: beta, gateway_charge_id: 'pay_negado' }).first();
    assert.equal(linha.status, 'paid');
  });

  it('o estorno de um pagamento que o extrato não conhece não mexe em nada', async () => {
    const antes = await assinaturaDe(beta);
    const aviso = await entregar({
      event: 'PAYMENT_REFUNDED', payment: { id: 'pay_desconhecido', value: 100, externalReference: `tenant:${beta}` }
    });
    assert.equal(aviso.status, 200);
    assert.equal(aviso.body.reversal, 'no_payment');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    assert.equal((await estornosDe(beta)).length, 0);
  });
});
