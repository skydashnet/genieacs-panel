import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { smtpDeMentira } = await import('./helpers/fakeSmtp.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { bucketOf } = await import('../src/services/delinquencyService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');

/**
 * O painel de inadimplência do console: a lista de quem deve (o valor por
 * tipo de cobrança, a faixa de atraso, quem fica de fora) e as quatro ações
 * em massa — cada provedor por si, com o resultado dele e a trilha dele.
 *
 * Self-hosted com o roteador de verdade num app mínimo, pelo motivo de
 * `platform-subscriptions.test.js`: o gateway de mentira em `127.0.0.1` só é
 * aceito fora da SaaS, e é ele que faz a cortesia falhar num provedor só.
 */
const CHAVE = 'chave-do-painel-de-inadimplencia';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let smtp;
let emails;
let consoleServer;
let consoleUrl;
let donoToken;
let comumToken;
let alfa;
let beta;
let gama;
let delta;
let eps;
let caixa;
let plano;

/** Instantes em segundos inteiros: o MySQL arredonda os milissegundos. */
const segundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const diasAtras = (dias) => segundo(Date.now() - dias * DAY);
const dia = (ms) => ChargeIssuingService.isoDate(ms);

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      const uma = /^\/payments\/([^/]+)$/.exec(caminho);
      if (uma) {
        const id = decodeURIComponent(uma[1]);
        if (req.method === 'GET') return responder(200, { id, status: 'PENDING', value: 100 });
        if (req.method === 'POST') {
          if (id === 'pay_recusa') return responder(400, { errors: [{ description: 'não pode mudar' }] });
          return responder(200, { id, status: 'PENDING', value: payload?.value, dueDate: payload?.dueDate });
        }
        if (req.method === 'DELETE') return responder(200, { deleted: true, id });
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
    consoleServer = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${consoleServer.address().port}`));
  });
}

const platform = (caminho, options = {}, token = donoToken) => call(`${consoleUrl}/api/platform${caminho}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

const agir = (body, token = donoToken) => platform('/delinquency/actions', { method: 'POST', body }, token);

/** Uma cobrança em aberto do tipo e vencimento pedidos, no escopo do dono. */
async function cobranca(tenantId, {
  kind = 'renewal', amountCents, dueDate, status = 'pending', periodEnd = null, gatewayChargeId = null
}) {
  return runInTenant(tenantId, async () => {
    let id;
    if (kind === 'renewal') {
      id = await BillingCharge.open({
        periodEnd: periodEnd ?? dueDate, amountCents, currency: 'BRL', provider: gatewayChargeId ? 'asaas' : 'manual', dueDate
      });
    } else {
      id = await BillingCharge.openProration({
        key: `p${Math.random().toString(36).slice(2, 11)}`,
        amountCents,
        currency: 'BRL',
        provider: 'manual',
        dueDate,
        kind
      });
    }
    await BillingCharge.update(id, {
      status,
      gateway_charge_id: gatewayChargeId,
      invoice_url: gatewayChargeId ? `https://gateway.exemplo.test/i/${gatewayChargeId}` : null
    });
    return id;
  });
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  ({ server: smtp, recebidas: emails } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'Painel <nao-responda@exemplo.test>';
  resetMailTransport();

  const { panelUrl } = await startTestServers();
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
  alfa = (await db('tenants').where({ kind: 'provider' }).orderBy('id', 'asc').first()).id;
  for (const slug of ['beta', 'gama', 'delta', 'eps']) {
    // eslint-disable-next-line no-await-in-loop -- quatro linhas de cenário
    await db('tenants').insert({ slug, name: `Provedor ${slug}`, status: 'active', billing_email: `${slug}@exemplo.test` });
  }
  const porSlug = async (slug) => (await db('tenants').where({ slug }).first()).id;
  beta = await porSlug('beta');
  gama = await porSlug('gama');
  delta = await porSlug('delta');
  eps = await porSlug('eps');
  caixa = (await db('tenants').where({ kind: 'platform' }).first())?.id;
  if (!caixa) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    caixa = (await db('tenants').where({ kind: 'platform' }).first()).id;
  }
  resetDeploymentSharing();
  await db('tenants').where({ id: delta }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_delta' });
  plano = await Plan.create({
    code: 'inad-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  resetMailTransport();
  await new Promise((r) => consoleServer.close(r));
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => smtp.close(r));
  await stopTestServers();
});

const LIMPA = {
  plan_id: null, status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
  billing_exempt_at: null, billing_exempt_until: null, suspended_reason: null,
  paused_until: null, pause_started_at: null, cancel_at: null, proration_due_at: null
};

async function assinatura(tenantId, patch) {
  await Subscription.upsertForTenant(tenantId, { ...LIMPA, plan_id: plano.id, ...patch });
  await SubscriptionService.invalidate(tenantId);
}

/**
 * O cenário de todo caso:
 *   alfa  em dia (renova daqui a 10 dias) — fora;
 *   beta  renovação vencida há 20 dias, com a renovação e uma pró-rata vencidas;
 *   gama  suspenso automaticamente, vencido há 40 dias, com excedente vencido;
 *   delta vencido há 3 dias, sem cobrança vencida (a renovação vence amanhã);
 *   eps   isento — fora, mesmo com cobrança vencida.
 */
beforeEach(async () => {
  emails.length = 0;
  const db = getDb();
  const todos = [alfa, beta, gama, delta, eps];
  await db('billing_charges').whereIn('tenant_id', todos).del();
  await db('billing_events').whereIn('tenant_id', todos).del();
  await db('subscription_reminder_sends').whereIn('tenant_id', todos).del();
  await db('platform_audit').del();
  await assinatura(alfa, { renews_at: segundo(Date.now() + 10 * DAY) });
  await assinatura(beta, { renews_at: diasAtras(20) });
  await assinatura(gama, { renews_at: diasAtras(40), status: 'suspended', suspended_reason: 'auto_nonpayment' });
  const prazoDelta = diasAtras(3);
  await assinatura(delta, { renews_at: prazoDelta });
  await assinatura(eps, { renews_at: segundo(Date.now() + 10 * DAY), billing_exempt_at: diasAtras(1) });

  await cobranca(beta, { amountCents: 10000, dueDate: dia(Date.now() - 20 * DAY), status: 'overdue' });
  await cobranca(beta, { kind: 'proration', amountCents: 2500, dueDate: dia(Date.now() - 5 * DAY) });
  // A que ainda vai vencer entra em "em aberto", não em "devido".
  await cobranca(beta, { amountCents: 10000, dueDate: dia(Date.now() + 5 * DAY), periodEnd: dia(Date.now() + 10 * DAY) });
  await cobranca(gama, { amountCents: 10000, dueDate: dia(Date.now() - 40 * DAY), status: 'overdue' });
  await cobranca(gama, { kind: 'overage', amountCents: 1234, dueDate: dia(Date.now() - 10 * DAY), status: 'overdue' });
  // A do período que venceu, com o vencimento empurrado para amanhã.
  await cobranca(delta, {
    amountCents: 10000, dueDate: dia(Date.now() + 1 * DAY), periodEnd: ChargeIssuingService.periodKey(prazoDelta),
    gatewayChargeId: 'pay_delta'
  });
  await cobranca(eps, { amountCents: 999, dueDate: dia(Date.now() - 2 * DAY), status: 'overdue' });
});

describe('a lista de quem deve', () => {
  it('soma as vencidas por tipo, diz a faixa, e deixa de fora quem não deve', async () => {
    const res = await platform('/delinquency');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows, summary } = res.body.data;
    const ids = rows.map((row) => row.tenant.id);
    assert.equal(ids.includes(alfa), false, 'em dia');
    assert.equal(ids.includes(eps), false, 'isento');
    assert.equal(ids.includes(caixa), false, 'a caixa da plataforma');
    assert.ok(ids.includes(beta) && ids.includes(gama) && ids.includes(delta));

    const b = rows.find((row) => row.tenant.id === beta);
    assert.equal(b.status, 'past_due');
    assert.equal(b.amountCents, 12500);
    assert.deepEqual(b.amountByKind, { renewal: 10000, proration: 2500, overage: 0 });
    assert.equal(b.openCents, 22500);
    assert.equal(b.overdueCharges, 2);
    assert.equal(b.daysOverdue, 20);
    assert.equal(b.bucket, '16-30');
    assert.equal(b.currency, 'BRL');
    // Padrão: suspende 15 dias depois de vencer — já passou, a etapa empurra
    // para três dias depois do aviso (que não saiu).
    assert.ok(b.autoSuspendAt);
    assert.equal(b.autoSuspendWarned, false);
    assert.equal(b.card.saved, false);
    assert.equal(b.lastReminder, null);

    const g = rows.find((row) => row.tenant.id === gama);
    assert.equal(g.status, 'suspended');
    assert.equal(g.suspendedReason, 'auto_nonpayment');
    assert.deepEqual(g.amountByKind, { renewal: 10000, proration: 0, overage: 1234 });
    assert.equal(g.daysOverdue, 40, 'desde o prazo que venceu, mesmo já suspenso');
    assert.equal(g.bucket, '30+');
    assert.equal(g.autoSuspendAt, null, 'já suspenso');

    const d = rows.find((row) => row.tenant.id === delta);
    assert.equal(d.amountCents, 0, 'a cobrança dele ainda não venceu');
    assert.equal(d.openCents, 10000);
    assert.equal(d.bucket, '1-7');
    assert.deepEqual(d.gateway, { gateway: 'asaas', linked: true });

    assert.equal(summary.count, 3);
    assert.equal(summary.totalOverdueCents, 12500 + 11234);
    assert.deepEqual(summary.totalsByCurrency, [{ currency: 'BRL', cents: 23734 }]);
    assert.deepEqual(summary.byBucket, { '1-7': 1, '8-15': 0, '16-30': 1, '30+': 1 });
  });

  it('deixa de fora o cancelado e o pausado, e o vencido de plano de graça sem cobrança', async () => {
    await assinatura(beta, { renews_at: diasAtras(20), status: 'canceled', canceled_at: diasAtras(1) });
    await assinatura(delta, { renews_at: diasAtras(3), paused_until: segundo(Date.now() + 20 * DAY), pause_started_at: diasAtras(3) });
    const gratis = await Plan.create({
      code: 'inad-free', name: 'Free', price_cents: 0, currency: 'BRL', period_days: 30, trial_days: 0, active: true
    });
    await assinatura(alfa, { plan_id: gratis.id, renews_at: diasAtras(9) });
    const res = await platform('/delinquency');
    assert.deepEqual(res.body.data.rows.map((row) => row.tenant.id), [gama]);
  });

  it('filtra por faixa, estado e busca, e ordena por valor ou dias', async () => {
    const porDias = await platform('/delinquency');
    assert.deepEqual(porDias.body.data.rows.map((r) => r.tenant.id), [gama, beta, delta]);
    const porValorCrescente = await platform('/delinquency?sort=amount&order=asc');
    assert.deepEqual(porValorCrescente.body.data.rows.map((r) => r.tenant.id), [delta, gama, beta]);
    const faixa = await platform('/delinquency?bucket=16-30');
    assert.deepEqual(faixa.body.data.rows.map((r) => r.tenant.id), [beta]);
    assert.equal(faixa.body.data.summary.count, 3, 'o resumo é sempre de todos');
    const suspensos = await platform('/delinquency?status=auto_suspended');
    assert.deepEqual(suspensos.body.data.rows.map((r) => r.tenant.id), [gama]);
    const busca = await platform('/delinquency?q=DELT');
    assert.deepEqual(busca.body.data.rows.map((r) => r.tenant.id), [delta]);
    assert.equal((await platform('/delinquency?bucket=2-3')).status, 400);
    assert.equal((await platform('/delinquency?sort=name')).status, 400);
    assert.equal((await platform('/delinquency?status=qualquer')).status, 400);
  });

  it('as faixas', () => {
    assert.deepEqual([0, 1, 7, 8, 15, 16, 30, 31].map(bucketOf), ['1-7', '1-7', '1-7', '8-15', '8-15', '16-30', '16-30', '30+']);
  });
});

describe('quem pode', () => {
  it('quem não é da plataforma recebe 404, e sem sessão 401', async () => {
    assert.equal((await platform('/delinquency', {}, comumToken)).status, 404);
    assert.equal((await agir({ tenantIds: [beta], action: 'suspend' }, comumToken)).status, 404);
    assert.equal((await call(`${consoleUrl}/api/platform/delinquency`)).status, 401);
    assert.equal((await call(`${consoleUrl}/api/platform/delinquency/actions`, {
      method: 'POST', body: { tenantIds: [beta], action: 'suspend' }
    })).status, 401);
    assert.equal((await Subscription.forTenant(beta)).status, 'active', 'nada mudou');
  });
});

describe('o pedido de ação', () => {
  it('recusa ação, lista e parâmetros inválidos antes de tocar em qualquer provedor', async () => {
    const casos = [
      [{ tenantIds: [beta], action: 'apagar' }, 'invalid_action'],
      [{ tenantIds: [], action: 'suspend' }, 'invalid_tenant_ids'],
      [{ tenantIds: ['x'], action: 'suspend' }, 'invalid_tenant_ids'],
      [{ tenantIds: Array.from({ length: 201 }, (_, i) => i + 1), action: 'suspend' }, 'too_many_tenants'],
      [{ tenantIds: [beta], action: 'extend', params: { days: 61 } }, 'invalid_days'],
      [{ tenantIds: [beta], action: 'extend', params: { days: 0 } }, 'invalid_days'],
      [{ tenantIds: [beta], action: 'exempt', params: { until: '2020-01-01T00:00:00Z' } }, 'invalid_until'],
      [{ tenantIds: [beta], action: 'exempt', params: { until: 'amanhã' } }, 'invalid_until']
    ];
    for (const [body, code] of casos) {
      // eslint-disable-next-line no-await-in-loop -- casos em sequência
      const res = await agir(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, code);
    }
    assert.equal((await Subscription.forTenant(beta)).status, 'active');
  });
});

describe('as ações em massa', () => {
  it('suspend: suspende à mão cada um, recusa o que não dá, e audita cada um', async () => {
    const res = await agir({ tenantIds: [beta, gama, caixa, 999999, beta], action: 'suspend', params: { reason: 'inadimplência' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { results, okCount, failedCount } = res.body.data;
    assert.deepEqual(results.map((r) => [r.tenantId, r.ok, r.code]), [
      [beta, true, 'suspended'],
      [gama, false, 'already_suspended'],
      [caixa, false, 'not_found'],
      [999999, false, 'not_found']
    ], 'repetidos contam uma vez');
    assert.equal(okCount, 1);
    assert.equal(failedCount, 3);
    const depois = await Subscription.forTenant(beta);
    assert.equal(depois.status, 'suspended');
    assert.equal(depois.suspended_reason, 'manual');
    const trilha = await getDb()('platform_audit').where({ action: 'subscription.status_changed' });
    assert.deepEqual(trilha.map((t) => t.tenant_id), [beta]);
    assert.equal(JSON.parse(trilha[0].detail).bulk, true);
    const doProvedor = await getDb()('audit_log').where({ tenant_id: beta }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(doProvedor.detail).platformAction, 'subscription.status_changed');
  });

  it('exempt: isenta com a data de fim, cancela as cobranças em aberto, e o cancelado falha sozinho', async () => {
    await assinatura(delta, { renews_at: diasAtras(3), status: 'canceled', canceled_at: diasAtras(1) });
    const ate = new Date(Date.now() + 30 * DAY).toISOString();
    const res = await agir({ tenantIds: [beta, delta, eps], action: 'exempt', params: { until: ate, reason: 'acordo' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.results.map((r) => [r.tenantId, r.ok, r.code]), [
      [beta, true, 'exempted'],
      [delta, false, 'subscription_canceled'],
      [eps, false, 'already_exempt']
    ]);
    const b = await Subscription.forTenant(beta);
    assert.ok(b.billing_exempt_at);
    assert.equal(Math.abs(new Date(b.billing_exempt_until).getTime() - new Date(ate).getTime()) < 2000, true);
    const abertas = await getDb()('billing_charges').where({ tenant_id: beta }).whereIn('status', ['pending', 'failed', 'overdue']);
    assert.equal(abertas.length, 0);
    const trilha = await getDb()('platform_audit').where({ action: 'subscription.billing_exempt_changed' });
    assert.deepEqual(trilha.map((t) => t.tenant_id), [beta]);
    assert.equal(JSON.parse(trilha[0].detail).reason, 'acordo');
    // A lista deixa de mostrá-lo.
    const lista = await platform('/delinquency');
    assert.equal(lista.body.data.rows.some((r) => r.tenant.id === beta), false);
  });

  it('extend: dá o prazo a cada um, e o gateway que recusa derruba só aquele', async () => {
    await getDb()('billing_charges').where({ tenant_id: delta }).update({ gateway_charge_id: 'pay_recusa' });
    const antesDelta = await Subscription.forTenant(delta);
    const res = await agir({ tenantIds: [beta, delta], action: 'extend', params: { days: 30 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [rb, rd] = res.body.data.results;
    assert.equal(rb.ok, true);
    assert.equal(rb.code, 'extended');
    assert.equal(rd.ok, false);
    assert.equal(rd.code, 'gateway_failed');
    const b = await Subscription.forTenant(beta);
    // Vencida há 20 dias: a cortesia conta a partir de agora.
    assert.ok(new Date(b.renews_at).getTime() > Date.now() + 29 * DAY);
    assert.equal(new Date((await Subscription.forTenant(delta)).renews_at).getTime(), new Date(antesDelta.renews_at).getTime(),
      'o prazo do recusado não se moveu');
    const trilha = await getDb()('platform_audit').where({ action: 'subscription.deadline_changed' });
    assert.deepEqual(trilha.map((t) => t.tenant_id), [beta]);
    assert.equal(JSON.parse(trilha[0].detail).extendDays, 30);
  });

  it('extend: o mesmo pedido repetido (mesmo requestId) não dá o prazo duas vezes', async () => {
    const requestId = 'pedido-1234-abcd';
    const primeiro = await agir({ tenantIds: [beta], action: 'extend', params: { days: 10, requestId } });
    assert.equal(primeiro.status, 200, JSON.stringify(primeiro.body));
    assert.equal(primeiro.body.data.results[0].code, 'extended');
    const depois1 = new Date((await Subscription.forTenant(beta)).renews_at).getTime();
    const repetido = await agir({ tenantIds: [beta], action: 'extend', params: { days: 10, requestId } });
    assert.equal(repetido.status, 200);
    assert.equal(repetido.body.data.results[0].ok, true);
    assert.equal(repetido.body.data.results[0].duplicate, true);
    assert.equal(new Date((await Subscription.forTenant(beta)).renews_at).getTime(), depois1, 'o prazo não andou de novo');
    const trilha = await getDb()('platform_audit').where({ action: 'subscription.deadline_changed', tenant_id: beta });
    assert.equal(trilha.length, 1, 'uma trilha só');
    // Outro pedido é outra cortesia.
    await agir({ tenantIds: [beta], action: 'extend', params: { days: 10, requestId: 'pedido-5678-efgh' } });
    assert.ok(new Date((await Subscription.forTenant(beta)).renews_at).getTime() > depois1);
    // A chave malformada é recusada antes de tocar em alguém.
    const ruim = await agir({ tenantIds: [beta], action: 'extend', params: { days: 10, requestId: 'x' } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_request_id');
  });

  it('a trilha que falha não transforma em erro a ação que já foi feita', async () => {
    const { default: PlatformAudit } = await import('../src/models/PlatformAudit.js');
    const original = PlatformAudit.fromRequest;
    PlatformAudit.fromRequest = async () => { throw new Error('banco da trilha fora'); };
    try {
      const res = await agir({ tenantIds: [beta], action: 'suspend' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.results.map((r) => [r.ok, r.code]), [[true, 'suspended']]);
    } finally {
      PlatformAudit.fromRequest = original;
    }
    assert.equal((await Subscription.forTenant(beta)).status, 'suspended');
  });

  it('remind: manda o lembrete com o link a quem deve, e uma vez só a cada 24 h', async () => {
    const res = await agir({ tenantIds: [beta, gama, alfa], action: 'remind' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.results.map((r) => [r.tenantId, r.ok, r.code]), [
      [beta, true, 'sent'],
      [gama, true, 'sent'],
      [alfa, false, 'not_overdue']
    ]);
    assert.equal(emails.length, 2);
    assert.ok(emails.some((m) => m.includes('beta@exemplo.test')));
    const linhas = await getDb()('subscription_reminder_sends').whereIn('tenant_id', [beta, gama]).where({ step: 'manual' });
    assert.equal(linhas.length, 2);
    assert.ok(linhas.every((l) => l.sent_at));
    const trilha = await getDb()('platform_audit').where({ action: 'subscription.reminder_sent' });
    assert.deepEqual(trilha.map((t) => t.tenant_id).sort(), [beta, gama].sort());

    // De novo, logo em seguida: a janela fecha, e nada sai.
    const outra = await agir({ tenantIds: [beta], action: 'remind' });
    assert.deepEqual(outra.body.data.results.map((r) => [r.ok, r.code]), [[false, 'rate_limited']]);
    assert.ok(outra.body.data.results[0].retryAt);
    assert.equal(emails.length, 2);

    // A régua não é afetada: a etapa manual é outra linha.
    const lista = await platform('/delinquency');
    const b = lista.body.data.rows.find((r) => r.tenant.id === beta);
    assert.equal(b.lastReminder.step, 'manual');
    assert.ok(b.lastReminder.sentAt);
  });

  it('remind: a janela de 24 h atravessa a meia-noite, e reabre depois dela', async () => {
    // O último manual saiu há 20 horas, num dia que pode ser ontem.
    const ontem = segundo(Date.now() - 20 * 60 * 60 * 1000);
    await runInTenant(beta, () => getDb()('subscription_reminder_sends').insert({
      tenant_id: beta, due_at: dia(ontem.getTime() - DAY), step: 'manual', channels: 'email', sent_at: ontem, created_at: ontem
    }));
    const fechado = await agir({ tenantIds: [beta], action: 'remind' });
    assert.equal(fechado.body.data.results[0].code, 'rate_limited');
    await getDb()('subscription_reminder_sends').where({ tenant_id: beta, step: 'manual' })
      .update({ sent_at: segundo(Date.now() - 25 * 60 * 60 * 1000) });
    const aberto = await agir({ tenantIds: [beta], action: 'remind' });
    assert.equal(aberto.body.data.results[0].code, 'sent');
    assert.equal(emails.length, 1);
  });
});
