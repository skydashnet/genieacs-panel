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
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * A tela de Assinaturas do console: a lista de todos, as cobranças de um, o
 * prazo mexido à mão, e os quatro gestos sobre uma cobrança — baixa,
 * cancelamento, mudança e reemissão.
 *
 * Self-hosted, pelo motivo de `asaas-gateway-lifecycle.test.js`: só fora da
 * SaaS o cliente do gateway aceita `127.0.0.1`, e o valor deste arquivo está
 * em asserir o que SAI para o gateway — o `receiveInCash` antes do crédito, a
 * AUSÊNCIA dele quando o valor é curto, o `POST /payments/{id}` da mudança. A
 * edição self-hosted não monta o console, então o roteador de verdade
 * (`routes/platformBilling.js`, com as guardas de verdade) é montado aqui num
 * app mínimo, atrás do mesmo resolvedor e do mesmo `attachLocale` do painel.
 * É o roteador e as guardas que se testam, não um atalho para o controlador.
 *
 * As três coisas que não podem dar errado:
 *
 * 1. **Creditar duas vezes.** A baixa manual no gateway faz a Asaas mandar o
 *    `PAYMENT_RECEIVED` do mesmo pagamento — e ele tem de cair como
 *    `duplicate`, sem esticar o período de novo.
 * 2. **Gravar de um lado só.** O gateway recusou? Nada é registrado aqui. O
 *    valor é curto? O gateway nem é chamado.
 * 3. **A cobrança do vizinho.** O `:chargeId` é linha escopada; pela URL de
 *    um provedor, a de outro não existe.
 */
const CHAVE = 'chave-do-console-de-assinaturas';
const TOKEN = 'token-do-webhook-das-assinaturas';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
let proximoId = 0;
/** O que o gateway de mentira diz de cada cobrança no `GET /payments/{id}` — PENDING quando não diz nada. */
const estadoNoGateway = new Map();
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let comumToken;
let alfa;
let beta;
let gama;
let caixa;
let plano;
let planoMini;
let donoId;

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
      const recebimento = /^\/payments\/([^/]+)\/receiveInCash$/.exec(caminho);
      if (req.method === 'POST' && recebimento) {
        const id = decodeURIComponent(recebimento[1]);
        if (id === 'pay_recusa') return responder(400, { errors: [{ description: 'cobrança não pode ser recebida' }] });
        return responder(200, { id, status: 'RECEIVED_IN_CASH', value: payload?.value });
      }
      if (req.method === 'POST' && caminho === '/payments') {
        proximoId += 1;
        const id = `pay_novo_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      const umaCobranca = /^\/payments\/([^/]+)$/.exec(caminho);
      if (req.method === 'GET' && umaCobranca) {
        const id = decodeURIComponent(umaCobranca[1]);
        return responder(200, { id, status: estadoNoGateway.get(id) ?? 'PENDING', value: 100 });
      }
      if (req.method === 'POST' && umaCobranca) {
        const id = decodeURIComponent(umaCobranca[1]);
        if (id === 'pay_recusa') return responder(400, { errors: [{ description: 'não pode mudar' }] });
        return responder(200, { id, status: 'PENDING', value: payload?.value, dueDate: payload?.dueDate });
      }
      if (req.method === 'DELETE' && umaCobranca) {
        const id = decodeURIComponent(umaCobranca[1]);
        if (id === 'pay_recusa') return responder(500, { errors: [{ description: 'fora do ar' }] });
        return responder(200, { deleted: true, id });
      }
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

/** O roteador do console de verdade, num app mínimo — ver o topo do arquivo. */
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

/** A chave do período vivo, como a emissão a calcula. */
async function periodoAtual(tenantId) {
  const sub = await assinaturaDe(tenantId);
  return ChargeIssuingService.periodKey(new Date(sub.renews_at ?? sub.trial_ends_at));
}

/** Uma cobrança pronta para o caso, gravada no escopo do dono. */
async function abrirCobranca(tenantId, {
  periodEnd, amountCents = 10000, provider = 'asaas', gatewayChargeId = null, status = 'pending',
  dueDate = null, superseded = null
} = {}) {
  return runInTenant(tenantId, async () => {
    const id = await BillingCharge.open({
      periodEnd: periodEnd ?? await periodoAtual(tenantId),
      amountCents,
      currency: 'BRL',
      provider,
      dueDate: dueDate ?? ChargeIssuingService.isoDate(Date.now() + 5 * DAY)
    });
    await BillingCharge.update(id, {
      status,
      gateway_charge_id: gatewayChargeId,
      invoice_url: gatewayChargeId ? `https://gateway.exemplo.test/i/${gatewayChargeId}` : null,
      superseded_charges: superseded ? JSON.stringify(superseded) : null
    });
    return id;
  });
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
  donoId = setup.body.data.user.id;
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
  alfa = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  await db('tenants').insert({ slug: 'gama', name: 'Provedor Gama', status: 'active' });
  gama = (await db('tenants').where({ slug: 'gama' }).first()).id;
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  // Três provedores na tabela fechariam a guarda de egresso na próxima
  // passada do agendador; este processo testa contra `127.0.0.1` de
  // propósito, e o que aprendeu sobre o deploy é desfeito aqui.
  resetDeploymentSharing();

  await db('tenants').whereIn('id', [beta, gama])
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_qualquer' });
  plano = await Plan.create({
    code: 'assin-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  // O plano de baixo, que não comporta operador nenhum: com uma pessoa na
  // equipe do beta, a descida para ele fica BLOQUEADA pelo uso.
  planoMini = await Plan.create({
    code: 'assin-mini', name: 'Mini', price_cents: 5000, currency: 'BRL', period_days: 30, trial_days: 0,
    active: true, max_operators: 0
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

/** Estado limpo a cada caso: cobrar é destrutivo, e o caso seguinte veria o rastro. */
beforeEach(async () => {
  recebidas = [];
  estadoNoGateway.clear();
  const db = getDb();
  await db('billing_charges').whereIn('tenant_id', [beta, gama]).del();
  await db('billing_events').whereIn('tenant_id', [beta, gama]).del();
  await db('platform_audit').del();
  await db('tenant_users').where({ tenant_id: beta }).del();
  const agora = Date.now();
  await Subscription.upsertForTenant(beta, {
    plan_id: plano.id, status: 'active', renews_at: new Date(agora + 10 * DAY), trial_ends_at: null,
    pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null
  });
  await Subscription.upsertForTenant(gama, {
    plan_id: plano.id, status: 'trial', trial_ends_at: new Date(agora + 5 * DAY), renews_at: null,
    pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null
  });
  // O cache de 15 s da assinatura foi escrito por outro caso; a leitura da
  // resposta tem de ver a linha que acabou de ser gravada.
  const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
  await SubscriptionService.invalidate(beta);
  await SubscriptionService.invalidate(gama);
});

describe('a lista de todos', () => {
  it('traz cada provedor com a assinatura, o vínculo e a cobrança em aberto — e não a caixa da plataforma', async () => {
    const velha = await abrirCobranca(beta, {
      periodEnd: '2026-01-10', amountCents: 5000, status: 'overdue', gatewayChargeId: 'pay_velha',
      dueDate: '2026-01-10'
    });
    const daBeta = await abrirCobranca(beta, { gatewayChargeId: 'pay_beta_atual' });
    const daGama = await abrirCobranca(gama, { amountCents: 7000, status: 'failed' });
    await abrirCobranca(gama, { periodEnd: '2025-12-01', status: 'paid', gatewayChargeId: 'pay_paga' });

    const res = await platform('/subscriptions');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows, summary } = res.body.data;
    const ids = rows.map((row) => row.tenant.id);
    assert.ok(ids.includes(alfa) && ids.includes(beta) && ids.includes(gama));
    assert.equal(ids.includes(caixa), false, 'a caixa da plataforma não é cliente');

    const linhaBeta = rows.find((row) => row.tenant.id === beta);
    assert.deepEqual(linhaBeta.tenant, { id: beta, name: 'Provedor Beta', slug: 'beta', status: 'active' });
    assert.equal(linhaBeta.subscription.status, 'active');
    assert.equal(linhaBeta.subscription.storedStatus, 'active');
    assert.equal(linhaBeta.subscription.planId, plano.id);
    assert.equal(linhaBeta.subscription.planCode, 'assin-pro');
    assert.equal(linhaBeta.subscription.planName, 'Pro');
    assert.equal(linhaBeta.subscription.priceCents, 10000);
    assert.equal(linhaBeta.subscription.currency, 'BRL');
    assert.equal(linhaBeta.subscription.pendingPlan, null);
    assert.deepEqual(linhaBeta.gateway, { gateway: 'asaas', linked: true });
    assert.equal(linhaBeta.openCharge.id, daBeta, 'a mais recente em aberto, e não a velha');
    assert.equal(linhaBeta.openCharge.gatewayChargeId, 'pay_beta_atual');
    assert.deepEqual(Object.keys(linhaBeta.openCharge).sort(), [
      'amountCents', 'amountOverriddenAt', 'attempts', 'billingType', 'createdAt', 'creditCents', 'currency', 'dueDate', 'gatewayChargeId', 'id', 'invoice', 'invoiceUrl', 'kind', 'lastError', 'periodEnd', 'pricing', 'proration', 'provider', 'status', 'superseded', 'updatedAt'
    ]);

    // Sem vazamento cruzado: a cobrança de cada linha é a do dono dela.
    const linhaGama = rows.find((row) => row.tenant.id === gama);
    assert.equal(linhaGama.subscription.status, 'trial');
    assert.equal(linhaGama.openCharge.id, daGama);
    assert.equal(linhaGama.openCharge.amountCents, 7000);
    const linhaAlfa = rows.find((row) => row.tenant.id === alfa);
    assert.equal(linhaAlfa.openCharge, null);
    assert.deepEqual(linhaAlfa.gateway, { gateway: null, linked: false });

    assert.equal(summary.byStatus.active, rows.filter((r) => r.subscription?.status === 'active').length);
    assert.ok(summary.byStatus.active >= 2, 'alfa e beta');
    assert.equal(summary.byStatus.trial, 1);
    assert.equal(summary.byStatus.none, 0);
    assert.equal(summary.openTotalCents, 5000 + 10000 + 7000, 'todas as em aberto, a velha inclusive');
    assert.equal(summary.overdueCount, 1);
    assert.ok(velha);
  });

  it('e quem não é da plataforma não a vê', async () => {
    const res = await platform('/subscriptions', {}, comumToken);
    assert.equal(res.status, 404);
    const semToken = await call(`${consoleUrl}/api/platform/subscriptions`);
    assert.equal(semToken.status, 401);
  });
});

describe('as cobranças de um provedor', () => {
  it('traz as dele, com o que o console precisa ler, e nenhuma do vizinho', async () => {
    const minha = await abrirCobranca(beta, {
      gatewayChargeId: 'pay_b1', superseded: [{ id: 'pay_b0', amountCents: 9000, currency: 'BRL', at: 'x' }]
    });
    await abrirCobranca(gama, { gatewayChargeId: 'pay_g1' });

    const res = await platform(`/tenants/${beta}/charges`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.charges.map((c) => c.id), [minha]);
    const [cobranca] = res.body.data.charges;
    assert.equal(cobranca.gatewayChargeId, 'pay_b1');
    assert.equal(cobranca.provider, 'asaas');
    assert.equal(cobranca.attempts, 0);
    assert.match(cobranca.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(cobranca.superseded, [{ gatewayChargeId: 'pay_b0', amountCents: 9000 }]);
  });

  it('e a caixa da plataforma, um id que não existe e quem não é da plataforma recebem 404', async () => {
    assert.equal((await platform(`/tenants/${caixa}/charges`)).status, 404);
    assert.equal((await platform('/tenants/999999/charges')).status, 404);
    assert.equal((await platform(`/tenants/${beta}/charges`, {}, comumToken)).status, 404);
  });
});

describe('os prazos mexidos à mão', () => {
  it('estende a renovação a partir do prazo, sem mudar o estado, e deixa rastro', async () => {
    const antes = await assinaturaDe(beta);
    const res = await platform(`/tenants/${beta}/subscription/deadlines`, {
      method: 'PATCH', body: { extendDays: 7, reason: 'cortesia pela queda' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.tenant.id, beta);
    assert.ok(Array.isArray(res.body.data.events), 'o mesmo corpo do GET da assinatura');
    assert.equal(res.body.data.subscription.status, 'active');

    const depois = await assinaturaDe(beta);
    assert.equal(depois.status, 'active');
    assert.equal(ms(depois.renews_at), ms(antes.renews_at) + 7 * DAY);

    const [evento] = (await eventosDe(beta)).filter((e) => e.type === 'deadline.changed');
    assert.ok(evento);
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.courtesy, true);
    assert.equal(detalhe.extendDays, 7);
    assert.equal(detalhe.reason, 'cortesia pela queda');
    assert.ok(await getDb()('platform_audit').where({ action: 'subscription.deadline_changed', tenant_id: beta }).first());
  });

  it('em teste, estende o fim do teste; vencido, conta a partir de agora', async () => {
    await Subscription.upsertForTenant(gama, { trial_ends_at: new Date(Date.now() - 3 * DAY) });
    const res = await platform(`/tenants/${gama}/subscription/deadlines`, { method: 'PATCH', body: { extendDays: 5 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(gama);
    assert.equal(depois.status, 'trial');
    assert.equal(depois.renews_at, null);
    const esperado = Date.now() + 5 * DAY;
    assert.ok(Math.abs(ms(depois.trial_ends_at) - esperado) < 60_000, 'cinco dias a partir de agora, não do prazo vencido');
    assert.equal(res.body.data.subscription.status, 'trial', 'e o teste volta a valer');
  });

  it('aceita as datas exatas, e recusa as duas formas ao mesmo tempo', async () => {
    const res = await platform(`/tenants/${beta}/subscription/deadlines`, {
      method: 'PATCH', body: { renewsAt: '2027-03-01T15:00:00.000Z', trialEndsAt: null }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(beta);
    assert.equal(ms(depois.renews_at), ms('2027-03-01T15:00:00.000Z'));
    assert.equal(depois.trial_ends_at, null);
    assert.equal(depois.status, 'active');

    const ambas = await platform(`/tenants/${beta}/subscription/deadlines`, {
      method: 'PATCH', body: { renewsAt: '2027-03-01T15:00:00.000Z', extendDays: 3 }
    });
    assert.equal(ambas.status, 400);
    const demais = await platform(`/tenants/${beta}/subscription/deadlines`, { method: 'PATCH', body: { extendDays: 366 } });
    assert.equal(demais.status, 400);
    const nulo = await platform(`/tenants/${beta}/subscription/deadlines`, { method: 'PATCH', body: { renewsAt: null } });
    assert.equal(nulo.status, 400);
    assert.equal((await platform(`/tenants/${caixa}/subscription/deadlines`, {
      method: 'PATCH', body: { extendDays: 3 }
    })).status, 404);
  });
});

describe('a baixa manual de uma cobrança', () => {
  const hoje = () => ChargeIssuingService.isoDate(new Date());

  it('recebe no gateway, credita uma vez, e o aviso do gateway depois cai como duplicado', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_beta_1' });
    const periodo = await periodoAtual(beta);
    const antes = await assinaturaDe(beta);

    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000, note: 'transferência' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.duplicate, false);
    assert.equal(res.body.data.charge.status, 'paid');
    assert.equal(res.body.data.subscription.status, 'active');

    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
      'GET /payments/pay_beta_1', 'POST /payments/pay_beta_1/receiveInCash'
    ]);
    assert.deepEqual(recebidas[1].payload, { paymentDate: hoje(), value: 100, notifyCustomer: false });
    assert.equal(res.body.data.acceptedUnderpayment, false);

    const depois = await assinaturaDe(beta);
    assert.equal(ms(depois.renews_at), ms(antes.renews_at) + 30 * DAY, 'um período, contado do prazo');
    const pagamentos = (await eventosDe(beta)).filter((e) => e.type === 'payment.recorded');
    assert.equal(pagamentos.length, 1);
    assert.equal(pagamentos[0].external_id, 'pay_beta_1', 'a referência é o id do gateway');

    const aviso = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_beta_1', value: 100, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(aviso.status, 200);
    assert.equal(aviso.body.code, 'duplicate');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(depois.renews_at), 'nenhum período a mais');
    assert.equal((await eventosDe(beta)).filter((e) => e.type === 'payment.recorded').length, 1);

    const trilha = await getDb()('platform_audit').where({ action: 'charge.settled', tenant_id: beta }).first();
    assert.ok(trilha);
    assert.equal(JSON.parse(trilha.detail).note, 'transferência');
    assert.equal((await cobrancaDe(beta, id)).issuing_until, null, 'a garra saiu');
  });

  it('sem id no gateway, credita só do lado de cá, pela referência da linha', async () => {
    const id = await abrirCobranca(beta, { provider: 'manual', amountCents: 8000 });
    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 8000 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(recebidas.length, 0, 'nada sai para o gateway');
    assert.equal((await cobrancaDe(beta, id)).status, 'paid');
    const [pagamento] = (await eventosDe(beta)).filter((e) => e.type === 'payment.recorded');
    assert.equal(pagamento.external_id, `charge:${id}`);
    // Conferido contra os 8000 DA COBRANÇA, e não contra os 10000 do plano:
    // não é "pago a menos", e o período andou.
    assert.equal(JSON.parse(pagamento.detail).expectedCents, 8000);
    assert.equal(JSON.parse(pagamento.detail).underpaid, undefined);
  });

  it('pago a menos: 409 sem chamar o gateway nem gravar nada — a menos que se aceite', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_curta' });
    const antes = await assinaturaDe(beta);
    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 9000 }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'underpaid');
    assert.equal(res.body.paidCents, 9000);
    assert.equal(res.body.expectedCents, 10000);
    assert.equal(recebidas.length, 0, 'o gateway não pode ter a cobrança como recebida');
    assert.equal((await cobrancaDe(beta, id)).status, 'pending');
    assert.equal((await eventosDe(beta)).length, 0);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));

    const aceito = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 9000, allowUnderpayment: true }
    });
    assert.equal(aceito.status, 200, JSON.stringify(aceito.body));
    assert.deepEqual(recebidas.map((r) => r.path), ['/payments/pay_curta', '/payments/pay_curta/receiveInCash']);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at) + 30 * DAY);
  });

  it('o gateway recusou: 502 e nada registrado', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_recusa' });
    const antes = await assinaturaDe(beta);
    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    const linha = await cobrancaDe(beta, id);
    assert.equal(linha.status, 'pending');
    assert.equal(linha.issuing_until, null, 'a garra é solta mesmo na falha');
    assert.equal((await eventosDe(beta)).length, 0);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    assert.equal(await getDb()('platform_audit').where({ action: 'charge.settled' }).first(), undefined);
  });

  it('recusa o que não está em aberto, a data no futuro e a linha tomada por outro', async () => {
    const paga = await abrirCobranca(beta, { status: 'paid', gatewayChargeId: 'pay_ja_paga' });
    const fechada = await platform(`/tenants/${beta}/charges/${paga}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(fechada.status, 409);
    assert.equal(fechada.body.code, 'not_open');

    const aberta = await abrirCobranca(beta, { periodEnd: '2027-01-01', gatewayChargeId: 'pay_tomada' });
    const futuro = await platform(`/tenants/${beta}/charges/${aberta}/settle`, {
      method: 'POST', body: { paidAt: '2099-01-01', amountCents: 10000 }
    });
    assert.equal(futuro.status, 400);

    await runInTenant(beta, () => BillingCharge.update(aberta, { issuing_until: new Date(Date.now() + 60_000) }));
    const ocupada = await platform(`/tenants/${beta}/charges/${aberta}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(ocupada.status, 409);
    assert.equal(ocupada.body.code, 'busy');
    assert.equal(recebidas.length, 0);
  });
});

describe('cancelar uma cobrança', () => {
  it('apaga no gateway e fecha aqui; a segunda vez não tem o que cancelar', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_cancela' });
    const res = await platform(`/tenants/${beta}/charges/${id}/cancel`, {
      method: 'POST', body: { reason: 'acordo comercial' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge.status, 'canceled');
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['DELETE /payments/pay_cancela']);
    assert.equal((await cobrancaDe(beta, id)).status, 'canceled');
    const trilha = await getDb()('platform_audit').where({ action: 'charge.canceled', tenant_id: beta }).first();
    assert.equal(JSON.parse(trilha.detail).reason, 'acordo comercial');

    const outra = await platform(`/tenants/${beta}/charges/${id}/cancel`, { method: 'POST', body: {} });
    assert.equal(outra.status, 409);
    assert.equal(outra.body.code, 'not_open');
  });

  it('e o gateway que recusa deixa a cobrança como estava', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_recusa' });
    const res = await platform(`/tenants/${beta}/charges/${id}/cancel`, { method: 'POST', body: {} });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    assert.equal((await cobrancaDe(beta, id)).status, 'pending');
  });
});

describe('mudar vencimento e valor', () => {
  it('muda no gateway e aqui, e o pagamento seguinte é conferido contra o valor novo', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_muda', status: 'overdue' });
    const periodo = await periodoAtual(beta);
    const novoVencimento = ChargeIssuingService.isoDate(Date.now() + 12 * DAY);
    const res = await platform(`/tenants/${beta}/charges/${id}`, {
      method: 'PATCH', body: { dueDate: novoVencimento, amountCents: 8000 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge.amountCents, 8000);
    assert.equal(res.body.data.charge.dueDate, novoVencimento);
    assert.equal(res.body.data.charge.status, 'pending', 'com vencimento novo, não está mais atrasada');
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['POST /payments/pay_muda']);
    assert.deepEqual(recebidas[0].payload, { billingType: 'UNDEFINED', dueDate: novoVencimento, value: 80 });

    const trilha = await getDb()('platform_audit').where({ action: 'charge.updated', tenant_id: beta }).first();
    const detalhe = JSON.parse(trilha.detail);
    assert.equal(detalhe.before.amountCents, 10000);
    assert.equal(detalhe.after.amountCents, 8000);
    assert.equal(detalhe.after.dueDate, novoVencimento);

    // R$ 80,00 contra os 100,00 do plano seria "pago a menos"; contra a
    // cobrança, que agora pede 80,00, é o pagamento certo.
    const aviso = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_muda', value: 80, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(aviso.body.code, 'recorded');
    assert.equal((await cobrancaDe(beta, id)).status, 'paid');
  });

  it('recusa vencimento no passado, pedido vazio e a cobrança que nunca saiu', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_data' });
    const passado = await platform(`/tenants/${beta}/charges/${id}`, {
      method: 'PATCH', body: { dueDate: '2020-01-01' }
    });
    assert.equal(passado.status, 400);
    assert.equal((await platform(`/tenants/${beta}/charges/${id}`, { method: 'PATCH', body: {} })).status, 400);

    const falhou = await abrirCobranca(beta, { periodEnd: '2027-02-01', status: 'failed' });
    const naoSaiu = await platform(`/tenants/${beta}/charges/${falhou}`, {
      method: 'PATCH', body: { amountCents: 5000 }
    });
    assert.equal(naoSaiu.status, 409);
    assert.equal(naoSaiu.body.code, 'not_issued');
    assert.equal(recebidas.length, 0);
  });
});

describe('reemitir a cobrança do período', () => {
  it('reabre a cancelada do período atual pela emissão de sempre', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_cancelada', status: 'canceled' });
    const res = await platform(`/tenants/${beta}/charges/${id}/reissue`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge.id, id, 'a mesma linha — o período tem uma cobrança só');
    assert.equal(res.body.data.charge.status, 'pending');
    assert.match(res.body.data.charge.gatewayChargeId, /^pay_novo_/);
    assert.deepEqual(res.body.data.charge.superseded, [{ gatewayChargeId: 'pay_cancelada', amountCents: 10000 }]);
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['POST /payments']);
    assert.ok(await getDb()('platform_audit').where({ action: 'charge.reissued', tenant_id: beta }).first());
  });

  it('recusa a de outro período e a que ainda está em aberto', async () => {
    const velha = await abrirCobranca(beta, { periodEnd: '2025-06-01', status: 'canceled' });
    const outroPeriodo = await platform(`/tenants/${beta}/charges/${velha}/reissue`, { method: 'POST', body: {} });
    assert.equal(outroPeriodo.status, 409);
    assert.equal(outroPeriodo.body.code, 'not_current_period');

    const aberta = await abrirCobranca(beta, { gatewayChargeId: 'pay_aberta' });
    const emAberto = await platform(`/tenants/${beta}/charges/${aberta}/reissue`, { method: 'POST', body: {} });
    assert.equal(emAberto.status, 409);
    assert.equal(emAberto.body.code, 'not_reissuable');
    assert.equal(recebidas.length, 0);
  });
});

describe('a cobrança do vizinho', () => {
  it('não é alcançada pela URL de outro provedor, em gesto nenhum', async () => {
    const daGama = await abrirCobranca(gama, { gatewayChargeId: 'pay_da_gama' });
    const hoje = ChargeIssuingService.isoDate(new Date());
    const tentativas = [
      platform(`/tenants/${beta}/charges/${daGama}/settle`, { method: 'POST', body: { paidAt: hoje, amountCents: 10000 } }),
      platform(`/tenants/${beta}/charges/${daGama}/cancel`, { method: 'POST', body: {} }),
      platform(`/tenants/${beta}/charges/${daGama}`, { method: 'PATCH', body: { amountCents: 1 } }),
      platform(`/tenants/${beta}/charges/${daGama}/reissue`, { method: 'POST', body: {} })
    ];
    for (const res of await Promise.all(tentativas)) assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(recebidas.length, 0);
    const linha = await cobrancaDe(gama, daGama);
    assert.equal(linha.status, 'pending');
    assert.equal(Number(linha.amount_cents), 10000);
    assert.equal((await eventosDe(gama)).length, 0);
  });

  it('e quem não é da plataforma não chega a gesto nenhum', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_protegida' });
    const res = await platform(`/tenants/${beta}/charges/${id}/cancel`, { method: 'POST', body: {} }, comumToken);
    assert.equal(res.status, 404);
    assert.equal((await cobrancaDe(beta, id)).status, 'pending');
    assert.equal(recebidas.length, 0);
  });
});

describe('o prazo que se move leva a cobrança em aberto junto', () => {
  const chaveDe = (instante) => ChargeIssuingService.periodKey(new Date(instante));

  it('a cortesia muda o vencimento no gateway e a chave da linha — e a emissão não abre outra', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_segue', status: 'overdue' });
    const res = await platform(`/tenants/${beta}/subscription/deadlines`, { method: 'PATCH', body: { extendDays: 10 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(beta);
    const chaveNova = chaveDe(depois.renews_at);

    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['POST /payments/pay_segue']);
    assert.deepEqual(recebidas[0].payload, { billingType: 'UNDEFINED', dueDate: chaveNova });
    const linha = await cobrancaDe(beta, id);
    assert.equal(linha.period_end, chaveNova);
    assert.equal(linha.status, 'pending', 'com vencimento novo, não está mais atrasada');
    assert.equal(linha.issuing_until, null);

    // A emissão do período novo acha ESTA linha, já emitida: nenhuma fatura a mais.
    recebidas = [];
    const emissao = await runInTenant(beta, () => ChargeIssuingService.issueCurrent({ manual: true }));
    assert.equal(emissao.reason, 'already_issued');
    assert.equal(emissao.charge.id, id);
    assert.equal(recebidas.length, 0);
  });

  it('o gateway recusou: 502, e nem o prazo nem a linha se movem', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_recusa' });
    const antes = await assinaturaDe(beta);
    const chaveVelha = chaveDe(antes.renews_at);
    const res = await platform(`/tenants/${beta}/subscription/deadlines`, { method: 'PATCH', body: { extendDays: 10 } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at));
    const linha = await cobrancaDe(beta, id);
    assert.equal(linha.period_end, chaveVelha);
    assert.equal(linha.issuing_until, null, 'a garra é solta');
    assert.equal((await eventosDe(beta)).filter((e) => e.type === 'deadline.changed').length, 0);
  });

  it('pelo PUT da assinatura com data também, e um prazo que já tem cobrança cancela a velha', async () => {
    const velha = await abrirCobranca(beta, { gatewayChargeId: 'pay_do_prazo_velho' });
    // Sem milissegundos: o MySQL grava o timestamp arredondado ao segundo.
    const destino = new Date(Math.floor((Date.now() + 40 * DAY) / 1000) * 1000);
    const jaTem = await abrirCobranca(beta, { periodEnd: chaveDe(destino), gatewayChargeId: 'pay_do_prazo_novo' });
    const res = await platform(`/tenants/${beta}/subscription`, {
      method: 'PUT', body: { status: 'active', renewsAt: destino.toISOString() }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['DELETE /payments/pay_do_prazo_velho']);
    assert.equal((await cobrancaDe(beta, velha)).status, 'canceled');
    assert.equal((await cobrancaDe(beta, jaTem)).status, 'pending');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), destino.getTime());
  });

  it('a cortesia a quem está past_due gravado o destrava', async () => {
    await Subscription.upsertForTenant(beta, { status: 'past_due', renews_at: new Date(Date.now() - 2 * DAY) });
    const res = await platform(`/tenants/${beta}/subscription/deadlines`, { method: 'PATCH', body: { extendDays: 5 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(beta);
    assert.equal(depois.status, 'active');
    assert.ok(Math.abs(ms(depois.renews_at) - (Date.now() + 5 * DAY)) < 60_000);
    assert.equal(res.body.data.subscription.status, 'active');
  });
});

describe('a faxina de períodos vencidos fala com o gateway', () => {
  it('cancela lá antes de cancelar aqui', async () => {
    const id = await abrirCobranca(beta, { periodEnd: '2026-01-01', gatewayChargeId: 'pay_esquecida' });
    const n = await runInTenant(beta, () => ChargeIssuingService.cancelStale('2026-06-01'));
    assert.equal(n, 1);
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['DELETE /payments/pay_esquecida']);
    assert.equal((await cobrancaDe(beta, id)).status, 'canceled');
  });

  it('e a recusa deixa a linha em aberto, com espera — sem um DELETE por passada', async () => {
    const id = await abrirCobranca(beta, { periodEnd: '2026-01-01', gatewayChargeId: 'pay_recusa' });
    assert.equal(await runInTenant(beta, () => ChargeIssuingService.cancelStale('2026-06-01')), 0);
    const linha = await cobrancaDe(beta, id);
    assert.equal(linha.status, 'pending', 'pode ter sido paga lá: não se esconde');
    assert.ok(linha.last_error);
    assert.ok(ms(linha.next_attempt_at) > Date.now());
    assert.equal(linha.issuing_until, null);

    await runInTenant(beta, () => ChargeIssuingService.cancelStale('2026-06-01'));
    assert.equal(recebidas.filter((r) => r.method === 'DELETE').length, 1, 'a segunda passada espera');
  });
});

describe('a baixa quando o gateway ou o extrato já sabem do pagamento', () => {
  const hoje = () => ChargeIssuingService.isoDate(new Date());

  it('o webhook se perdeu e a Asaas já recebeu: a baixa segue sem receiveInCash, e credita uma vez', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_perdida' });
    const periodo = await periodoAtual(beta);
    estadoNoGateway.set('pay_perdida', 'RECEIVED');
    const antes = await assinaturaDe(beta);
    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['GET /payments/pay_perdida']);
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at) + 30 * DAY);

    const reentrega = await entregar({
      event: 'PAYMENT_RECEIVED', payment: { id: 'pay_perdida', value: 100, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(reentrega.body.code, 'duplicate');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(antes.renews_at) + 30 * DAY);
    const trilha = await getDb()('platform_audit').where({ action: 'charge.settled', tenant_id: beta }).first();
    assert.equal(JSON.parse(trilha.detail).alreadyReceivedAtGateway, true);
  });

  it('o webhook registrou a menos: a baixa recusa, e só o aceite explícito estende — uma vez', async () => {
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_curtinha' });
    const periodo = await periodoAtual(beta);
    const antes = await assinaturaDe(beta);
    const curto = await entregar({
      event: 'PAYMENT_RECEIVED', payment: { id: 'pay_curtinha', value: 90, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(curto.body.code, 'underpaid');
    assert.equal((await cobrancaDe(beta, id)).status, 'pending');

    const recusa = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(recusa.status, 409);
    assert.equal(recusa.body.code, 'already_recorded_underpaid');
    assert.equal(recusa.body.paidCents, 9000);
    assert.equal(recusa.body.expectedCents, 10000);
    assert.equal((await cobrancaDe(beta, id)).status, 'pending', 'não fecha o que ninguém pagou inteiro');
    assert.equal(recebidas.length, 0, 'e nem pergunta ao gateway');

    const aceite = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 9000, allowUnderpayment: true }
    });
    assert.equal(aceite.status, 200, JSON.stringify(aceite.body));
    assert.equal(aceite.body.data.acceptedUnderpayment, true);
    assert.equal(aceite.body.data.charge.status, 'paid');
    const depois = await assinaturaDe(beta);
    assert.equal(ms(depois.renews_at), ms(antes.renews_at) + 30 * DAY);

    const eventos = (await eventosDe(beta)).filter((e) => e.type === 'payment.recorded');
    assert.deepEqual(eventos.map((e) => e.external_id), ['pay_curtinha', 'pay_curtinha:accepted']);
    assert.equal(eventos[1].amount_cents, 0, 'o dinheiro já está no extrato; o aceite não o soma de novo');

    // O mesmo aceite outra vez não estende nada: a cobrança já está paga, e a
    // referência do aceite já existe.
    const deNovo = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 9000, allowUnderpayment: true }
    });
    assert.equal(deNovo.status, 409);
    assert.equal(deNovo.body.code, 'not_open');
    const reentrega = await entregar({
      event: 'PAYMENT_RECEIVED', payment: { id: 'pay_curtinha', value: 90, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(reentrega.body.code, 'duplicate');
    assert.equal(ms((await assinaturaDe(beta)).renews_at), ms(depois.renews_at));
  });

  it('assinatura suspensa: 409 subscription_inactive, a menos que se force', async () => {
    await Subscription.upsertForTenant(beta, { status: 'suspended' });
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_suspensa' });
    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000 }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'subscription_inactive');
    assert.equal(res.body.subscriptionStatus, 'suspended');
    assert.equal(recebidas.length, 0);

    const forcado = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: hoje(), amountCents: 10000, force: true }
    });
    assert.equal(forcado.status, 200, JSON.stringify(forcado.body));
    assert.equal((await cobrancaDe(beta, id)).status, 'paid');
    assert.equal((await assinaturaDe(beta)).status, 'suspended', 'pagamento não reativa quem alguém desligou');
  });

  it('a garra do console só toma linha em aberto', async () => {
    const paga = await abrirCobranca(beta, { status: 'paid', gatewayChargeId: 'pay_garra' });
    const tomou = await runInTenant(beta, () => BillingCharge.claim(paga, {
      until: new Date(Date.now() + 60_000), unissued: false, openOnly: true
    }));
    assert.equal(tomou, false);
  });
});

describe('o valor mudado à mão pelo console', () => {
  /**
   * O cenário do dano: o beta pediu a descida para o Mini, mas tem uma pessoa
   * na equipe e o Mini não comporta nenhuma — a descida está bloqueada, e a
   * cobrança da renovação sai pelo Pro. O console dá um desconto nela.
   */
  async function descidaBloqueadaComDesconto() {
    const sub = await assinaturaDe(beta);
    await Subscription.upsertForTenant(beta, { pending_plan_id: planoMini.id, pending_plan_at: sub.renews_at });
    await getDb()('tenant_users').insert({ tenant_id: beta, user_id: donoId, role: 'admin' });
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_com_desconto' });
    const res = await platform(`/tenants/${beta}/charges/${id}`, { method: 'PATCH', body: { amountCents: 7000 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.charge.amountOverriddenAt, 'a linha fica marcada');
    recebidas = [];
    return id;
  }

  it('a emissão não reprecifica a cobrança com desconto', async () => {
    const id = await descidaBloqueadaComDesconto();
    const emissao = await runInTenant(beta, () => ChargeIssuingService.issueCurrent({ manual: true }));
    assert.equal(emissao.reason, 'already_issued');
    assert.equal(recebidas.length, 0, 'nem DELETE nem POST: o desconto fica');
    assert.equal(Number((await cobrancaDe(beta, id)).amount_cents), 7000);
  });

  it('e o pagamento com desconto não trava a descida bloqueada como se fosse o preço do barato', async () => {
    await descidaBloqueadaComDesconto();
    const periodo = await periodoAtual(beta);
    const aviso = await entregar({
      event: 'PAYMENT_RECEIVED', payment: { id: 'pay_com_desconto', value: 70, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(aviso.body.code, 'recorded');
    const depois = await assinaturaDe(beta);
    assert.equal(depois.plan_id, plano.id);
    assert.equal(depois.pending_plan_id, planoMini.id);
    assert.equal(depois.pending_plan_locked_at, null, 'pagou o Pro com desconto — não o Mini');
    assert.equal(ms(depois.pending_plan_at), ms(depois.renews_at), 'a descida vai para a renovação seguinte');
  });
});
