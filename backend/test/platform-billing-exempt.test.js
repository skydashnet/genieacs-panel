import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge, EXEMPT_CANCEL_MARKER } = await import('../src/models/BillingCharge.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: SelfBillingService, SelfBillingError } = await import('../src/services/selfBillingService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');
const { BILLING_EXEMPT_EXPIRED_REASON } = await import('../src/services/subscriptionService.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');

/**
 * O "isento de cobrança": o console marca um provedor para ficar ativo sem
 * gerar fatura, até alguém desligar.
 *
 * A mesma montagem de `platform-charge-refund.test.js` (o roteador do console
 * de verdade num app mínimo, um gateway de mentira em `127.0.0.1`), porque o
 * que importa asserir é o que SAI para o gateway: o `DELETE` de cada cobrança
 * em aberto ao ligar, e NENHUMA emissão enquanto está ligado.
 *
 * As datas são comparadas ao segundo: o MySQL guarda ao segundo, e o prazo
 * que o desligar grava é truncado de propósito.
 */
const CHAVE = 'chave-do-console-de-isencao';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
/** Enquanto verdadeiro, o gateway recusa o DELETE de `pay_nao_cancela` — a queda que depois volta. */
let naoCancelaFalha = true;
let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let comumToken;
let beta;
let gama;
let caixa;
let plano;

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
        return responder(200, {
          id: `pay_emitida_${recebidas.length}`,
          invoiceUrl: 'https://asaas.test/i/nova',
          dueDate: payload?.dueDate ?? null,
          status: 'PENDING'
        });
      }
      const umaCobranca = /^\/payments\/([^/]+)$/.exec(caminho);
      if (req.method === 'DELETE' && umaCobranca) {
        const id = decodeURIComponent(umaCobranca[1]);
        if (id === 'pay_nao_cancela' && naoCancelaFalha) return responder(500, { errors: [{ description: 'fora do ar' }] });
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

const isentar = (tenantId, body, token = donoToken) => platform(
  `/tenants/${tenantId}/subscription/billing-exempt`, { method: 'PUT', body }, token
);

/** Ao segundo — a precisão do MySQL. */
const seg = (valor) => (valor === null || valor === undefined ? null : Math.floor(new Date(valor).getTime() / 1000));
const assinaturaDe = (tenantId) => Subscription.forTenant(tenantId);
const cobrancaDe = (tenantId, id) => runInTenant(tenantId, () => BillingCharge.findById(id));
const eventosDe = (tenantId) => getDb()('billing_events').where({ tenant_id: tenantId }).orderBy('id', 'asc');
const trilhaDe = (tenantId) => getDb()('platform_audit')
  .where({ action: 'subscription.billing_exempt_changed', tenant_id: tenantId }).orderBy('id', 'asc');

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
    code: 'isento-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
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
  naoCancelaFalha = true;
  const db = getDb();
  await db('billing_charges').whereIn('tenant_id', [beta, gama]).del();
  await db('billing_events').whereIn('tenant_id', [beta, gama]).del();
  await db('platform_audit').del();
  const agora = Date.now();
  for (const tenantId of [beta, gama]) {
    await Subscription.upsertForTenant(tenantId, {
      plan_id: plano.id, status: 'active', renews_at: new Date(agora + 10 * DAY), trial_ends_at: null,
      canceled_at: null, pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null,
      billing_exempt_at: null, billing_exempt_reason: null, billing_exempt_until: null
    });
    await SubscriptionService.invalidate(tenantId);
  }
});

describe('ligar a isenção', () => {
  it('o provedor vencido fica ativo, o gate libera a escrita e as cobranças em aberto saem no gateway', async () => {
    // Vencido pelo prazo (`active` com a renovação no passado) E gravado
    // `past_due` à mão pelo console: as duas formas de estar atrasado.
    await Subscription.upsertForTenant(beta, { status: 'past_due', renews_at: new Date(Date.now() - 3 * DAY) });
    const vencida = await abrirCobranca(beta, { gatewayChargeId: 'pay_vencida', status: 'overdue' });
    const velha = await abrirCobranca(beta, { periodEnd: '2020-01-01', gatewayChargeId: 'pay_velha' });
    const semGateway = await abrirCobranca(beta, { periodEnd: '2020-02-01', status: 'failed' });
    const doVizinho = await abrirCobranca(gama, { gatewayChargeId: 'pay_do_gama' });
    const antes = await assinaturaDe(beta);
    assert.equal(SubscriptionService.decide(antes, { method: 'POST' }).allowed, false, 'bloqueado antes');

    const inicio = Date.now();
    const res = await isentar(beta, { exempt: true, reason: '  parceria comercial  ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { data } = res.body;
    assert.equal(data.alreadyInState, false);
    assert.equal(data.canceledCharges, 3);
    assert.equal(data.subscription.tenant.id, beta, 'o mesmo corpo do GET da assinatura');
    assert.equal(data.subscription.subscription.status, 'active');
    assert.equal(data.subscription.subscription.billingExempt, true);
    assert.equal(data.subscription.subscription.billingExemptReason, 'parceria comercial');
    assert.ok(seg(data.subscription.subscription.billingExemptSince) >= Math.floor(inicio / 1000) - 1);
    assert.ok(data.subscription.events.some((e) => e.type === 'billing_exempt.enabled'));

    const deletes = recebidas.filter((r) => r.method === 'DELETE').map((r) => r.path).sort();
    assert.deepEqual(deletes, ['/payments/pay_velha', '/payments/pay_vencida'], 'as duas com id lá; a do vizinho não');
    for (const id of [vencida, velha, semGateway]) {
      const linha = await cobrancaDe(beta, id);
      assert.equal(linha.status, 'canceled');
      assert.equal(linha.issuing_until, null, 'a garra saiu');
    }
    assert.equal((await cobrancaDe(gama, doVizinho)).status, 'pending', 'o vizinho não é tocado');

    const depois = await assinaturaDe(beta);
    assert.equal(depois.status, 'active', 'o past_due gravado vira active');
    assert.equal(seg(depois.renews_at), seg(antes.renews_at), 'o prazo não se move');
    assert.equal(depois.billing_exempt_reason, 'parceria comercial');
    assert.equal(SubscriptionService.effectiveStatus(depois).status, 'active');
    assert.equal(SubscriptionService.decide(depois, { method: 'POST' }).allowed, true, 'o gate libera');
    assert.equal(SubscriptionService.pendingReminder(depois, new Date(), plano), null, 'nenhum lembrete de cobrança');

    const eventos = (await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.enabled');
    assert.equal(eventos.length, 1);
    const detalhe = JSON.parse(eventos[0].detail);
    assert.equal(detalhe.statusBefore, 'past_due');
    assert.equal(detalhe.statusAfter, 'active');
    assert.equal(detalhe.reason, 'parceria comercial');
    assert.equal(eventos[0].external_id, null);

    const [trilha, ...outras] = await trilhaDe(beta);
    assert.ok(trilha);
    assert.equal(outras.length, 0);
    const auditado = JSON.parse(trilha.detail);
    assert.equal(auditado.exempt, true);
    assert.equal(auditado.canceledCharges, 3);
    assert.equal(auditado.statusBefore, 'past_due');
    const doProvedor = await getDb()('audit_log').where({ tenant_id: beta, action: 'subscription.changed' })
      .orderBy('id', 'desc').first();
    assert.ok(doProvedor, 'a trilha do provedor também');
    assert.equal(JSON.parse(doProvedor.detail).platformAction, 'subscription.billing_exempt_changed');
    assert.equal(auditado.reason, 'parceria comercial', 'a trilha da plataforma guarda o motivo');
    assert.equal(data.failedCharges, 0);
    for (const id of [vencida, velha, semGateway]) {
      assert.equal((await cobrancaDe(beta, id)).last_error, EXEMPT_CANCEL_MARKER, 'marcada como cancelada pela isenção');
    }
  });

  it('o motivo não chega ao provedor: nem na tela dele, nem no 402, nem na trilha dele', async () => {
    assert.equal((await isentar(beta, { exempt: true, reason: 'acordo interno' })).status, 200);

    const doProvedor = await getDb()('audit_log').where({ tenant_id: beta, action: 'subscription.changed' })
      .orderBy('id', 'desc').first();
    const detalhe = JSON.parse(doProvedor.detail);
    assert.equal(detalhe.exempt, true);
    assert.equal('reason' in detalhe, false, 'a trilha do provedor não leva o motivo');
    assert.equal(JSON.stringify(detalhe).includes('acordo interno'), false);

    const uso = await runInTenant(beta, () => SubscriptionService.usage());
    assert.equal(uso.subscription.billingExempt, true);
    assert.equal(uso.subscription.billingExemptReason, null, 'GET /api/tenant/subscription');
    const estado = await runInTenant(beta, () => SubscriptionService.current());
    assert.equal(SubscriptionService.present(estado).billingExemptReason, null, 'o padrão, que o 402 usa');
    assert.equal(SubscriptionService.present(estado, { withExemptReason: true }).billingExemptReason, 'acordo interno');

    const detalheConsole = await platform(`/tenants/${beta}/subscription`);
    assert.equal(detalheConsole.status, 200);
    assert.equal(detalheConsole.body.data.subscription.billingExemptReason, 'acordo interno', 'o console vê');
  });

  it('o gateway que recusa o cancelamento deixa aquela cobrança em aberto, e a isenção vale mesmo assim', async () => {
    const recusada = await abrirCobranca(beta, { gatewayChargeId: 'pay_nao_cancela' });
    const res = await isentar(beta, { exempt: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.canceledCharges, 0);
    assert.equal(res.body.data.failedCharges, 1, 'a tela avisa das que ficaram');
    assert.equal(res.body.data.subscription.subscription.billingExempt, true);
    assert.equal(res.body.data.subscription.subscription.billingExemptReason, null);
    const linha = await cobrancaDe(beta, recusada);
    assert.equal(linha.status, 'pending', 'viva no gateway, viva aqui');
    assert.match(linha.last_error, /fora do ar/);
    assert.equal(linha.issuing_until, null);
    assert.ok(linha.next_attempt_at, 'a próxima tentativa espera');
    const [trilha] = await trilhaDe(beta);
    assert.deepEqual(JSON.parse(trilha.detail).chargesLeftOpen, [recusada]);
  });

  it('a que ficou em aberto a varredura do agendador cancela depois da espera, quando o gateway volta', async () => {
    const recusada = await abrirCobranca(beta, { gatewayChargeId: 'pay_nao_cancela' });
    const res = await isentar(beta, { exempt: true });
    assert.equal(res.body.data.failedCharges, 1);
    naoCancelaFalha = false;

    // Dentro da espera: a passada do agendador não martela o gateway.
    recebidas = [];
    const cedo = await runInTenant(beta, () => ChargeIssuingService.issueCurrent());
    assert.equal(cedo.reason, 'billing_exempt');
    assert.equal(recebidas.length, 0, 'respeita next_attempt_at');
    assert.equal((await cobrancaDe(beta, recusada)).status, 'pending');

    // O clique não varre: a varredura é do agendador.
    const depois = new Date(Date.now() + ChargeIssuingService.RETRY_AFTER_MS + 60_000);
    const clique = await runInTenant(beta, () => ChargeIssuingService.issueCurrent({ manual: true, now: depois }));
    assert.equal(clique.reason, 'billing_exempt');
    assert.equal(recebidas.length, 0);

    const tarde = await runInTenant(beta, () => ChargeIssuingService.issueCurrent({ now: depois }));
    assert.equal(tarde.reason, 'billing_exempt');
    assert.equal(tarde.canceledCharges, 1);
    assert.deepEqual(recebidas.filter((r) => r.method === 'DELETE').map((r) => r.path), ['/payments/pay_nao_cancela']);
    assert.equal(recebidas.filter((r) => r.method === 'POST').length, 0, 'nada emitido');
    const linha = await cobrancaDe(beta, recusada);
    assert.equal(linha.status, 'canceled');
    assert.equal(linha.last_error, EXEMPT_CANCEL_MARKER);
    assert.equal(linha.next_attempt_at, null);
  });

  it('é idempotente: pedir de novo não grava nada nem fala com o gateway', async () => {
    assert.equal((await isentar(beta, { exempt: true, reason: 'primeira' })).status, 200);
    await abrirCobranca(beta, { gatewayChargeId: 'pay_depois' });
    recebidas = [];
    const res = await isentar(beta, { exempt: true, reason: 'segunda' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.alreadyInState, true);
    assert.equal(res.body.data.canceledCharges, 0);
    assert.equal(recebidas.length, 0);
    assert.equal((await assinaturaDe(beta)).billing_exempt_reason, 'primeira', 'o motivo não muda');
    assert.equal((await eventosDe(beta)).filter((e) => e.type.startsWith('billing_exempt.')).length, 1);
    assert.equal((await trilhaDe(beta)).length, 1);

    const desligado = await isentar(gama, { exempt: false });
    assert.equal(desligado.status, 200);
    assert.equal(desligado.body.data.alreadyInState, true, 'desligar quem não está isento também');
    assert.equal((await trilhaDe(gama)).length, 0);
  });

  it('recusa a assinatura cancelada com 409 not_billable', async () => {
    await Subscription.upsertForTenant(beta, { status: 'canceled', canceled_at: new Date() });
    const res = await isentar(beta, { exempt: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'not_billable');
    assert.equal((await assinaturaDe(beta)).billing_exempt_at, null);
    assert.equal((await trilhaDe(beta)).length, 0);
  });

  it('isenta o suspenso, e o canceled continua valendo por cima da isenção', async () => {
    await Subscription.upsertForTenant(beta, { status: 'suspended' });
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    assert.equal((await assinaturaDe(beta)).status, 'active');
    // Suspender depois de isentar é bloquear de propósito: vale por cima.
    await Subscription.upsertForTenant(beta, { status: 'suspended' });
    assert.equal(SubscriptionService.effectiveStatus(await assinaturaDe(beta)).status, 'suspended');
    await Subscription.upsertForTenant(beta, { status: 'canceled' });
    assert.equal(SubscriptionService.effectiveStatus(await assinaturaDe(beta)).status, 'canceled');
  });
});

describe('enquanto está isento', () => {
  it('a emissão não gera fatura — nem a do agendador, nem a do clique', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 2 * DAY) });
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    recebidas = [];
    for (const manual of [false, true]) {
      const resultado = await runInTenant(beta, () => ChargeIssuingService.issueCurrent({ manual }));
      assert.equal(resultado.issued, false);
      assert.equal(resultado.reason, 'billing_exempt');
    }
    assert.equal(recebidas.length, 0, 'nada saiu para o gateway');
    assert.equal(await getDb()('billing_charges').where({ tenant_id: beta }).count({ n: '*' }).first()
      .then((r) => Number(r.n)), 0);
  });

  it('"Reemitir" do console responde 409 billing_exempt', async () => {
    const id = await abrirCobranca(beta, { status: 'canceled' });
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    const res = await platform(`/tenants/${beta}/charges/${id}/reissue`, { method: 'POST', body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'billing_exempt');
  });

  it('"Pagar agora" do provedor responde 409 billing_exempt', async () => {
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    await assert.rejects(
      () => runInTenant(beta, () => SelfBillingService.payNow()),
      (error) => error instanceof SelfBillingError && error.code === 'billing_exempt' && error.status === 409
    );
    assert.equal(recebidas.filter((r) => r.method === 'POST').length, 0);
  });

  it('a lista de Assinaturas mostra o selo, conta os isentos e filtra por eles', async () => {
    assert.equal((await isentar(beta, { exempt: true, reason: 'cortesia' })).status, 200);
    const todos = await platform('/subscriptions');
    assert.equal(todos.status, 200);
    const linhaBeta = todos.body.data.rows.find((r) => r.tenant.id === beta);
    const linhaGama = todos.body.data.rows.find((r) => r.tenant.id === gama);
    assert.equal(linhaBeta.subscription.billingExempt, true);
    assert.equal(linhaBeta.subscription.billingExemptReason, 'cortesia');
    assert.ok(linhaBeta.subscription.billingExemptSince);
    assert.equal(linhaGama.subscription.billingExempt, false);
    assert.equal(linhaGama.subscription.billingExemptSince, null);
    assert.equal(linhaGama.subscription.billingExemptReason, null);
    assert.equal(todos.body.data.summary.exempt, 1);

    const filtrados = await platform('/subscriptions?status=exempt');
    assert.equal(filtrados.status, 200);
    assert.deepEqual(filtrados.body.data.rows.map((r) => r.tenant.id), [beta]);
    assert.equal(filtrados.body.data.summary.exempt, 1, 'o resumo é sempre de todos');
  });
});

describe('a isenção ligada no meio de uma emissão', () => {
  it('relida logo antes do gateway: a linha sai cancelada com a marca, e nada é emitido', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 2 * DAY) });
    // A isenção entra entre a leitura da assinatura e a chamada ao gateway —
    // exatamente quando a emissão abre a linha dela.
    const abrir = BillingCharge.open;
    BillingCharge.open = async (...args) => {
      const id = await abrir.apply(BillingCharge, args);
      await Subscription.upsertForTenant(beta, { billing_exempt_at: new Date(Math.floor(Date.now() / 1000) * 1000) });
      return id;
    };
    let resultado;
    try {
      resultado = await runInTenant(beta, () => ChargeIssuingService.issueCurrent());
    } finally {
      BillingCharge.open = abrir;
    }
    assert.equal(resultado.issued, false);
    assert.equal(resultado.reason, 'billing_exempt');
    assert.equal(recebidas.filter((r) => r.method === 'POST').length, 0, 'nenhuma cobrança viva no gateway');
    const [linha] = await getDb()('billing_charges').where({ tenant_id: beta });
    assert.equal(linha.status, 'canceled');
    assert.equal(linha.last_error, EXEMPT_CANCEL_MARKER);
    assert.equal(linha.issuing_until, null);
  });
});

describe('desligar a isenção', () => {
  it('com o prazo no futuro, a cobrança do período que a isenção cancelou volta e o agendador a emite', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 3 * DAY) });
    const emitida = await abrirCobranca(beta, { gatewayChargeId: 'pay_emitida_antes' });
    const ligou = await isentar(beta, { exempt: true });
    assert.equal(ligou.body.data.canceledCharges, 1);
    assert.equal((await cobrancaDe(beta, emitida)).status, 'canceled');

    const desligou = await isentar(beta, { exempt: false });
    assert.equal(desligou.status, 200, JSON.stringify(desligou.body));
    const reaberta = await cobrancaDe(beta, emitida);
    assert.equal(reaberta.status, 'pending', 'de volta à emissão');
    assert.equal(reaberta.gateway_charge_id, null);
    assert.equal(reaberta.last_error, null);
    assert.ok(BillingCharge.supersededOf(reaberta).some((item) => String(item.id) === 'pay_emitida_antes'),
      'o id velho fica como já-foi');
    const [trilha] = (await trilhaDe(beta)).slice(-1);
    assert.equal(JSON.parse(trilha.detail).reopenedCharge, true);

    recebidas = [];
    const emissao = await runInTenant(beta, () => ChargeIssuingService.issueCurrent());
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(emissao.charge.id, emitida, 'a mesma linha do período');
    assert.equal(recebidas.filter((r) => r.method === 'POST' && r.path === '/payments').length, 1);
    assert.notEqual(emissao.chargeId, 'pay_emitida_antes');
  });

  it('a cancelada a dedo pelo console continua cancelada', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 3 * DAY) });
    const cancelada = await abrirCobranca(beta, { gatewayChargeId: 'pay_do_console', status: 'canceled' });
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    assert.equal((await isentar(beta, { exempt: false })).status, 200);
    assert.equal((await cobrancaDe(beta, cancelada)).status, 'canceled');
    const emissao = await runInTenant(beta, () => ChargeIssuingService.issueCurrent());
    assert.equal(emissao.reason, 'already_settled');
  });

  it('o past_due gravado com o prazo no futuro volta a active', async () => {
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    await Subscription.upsertForTenant(beta, { status: 'past_due' });
    const res = await isentar(beta, { exempt: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await assinaturaDe(beta);
    assert.equal(depois.status, 'active');
    assert.equal(res.body.data.subscription.subscription.status, 'active');
    const [evento] = (await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.disabled');
    assert.equal(JSON.parse(evento.detail).statusAfter, 'active');
  });

  it('o past_due gravado com o prazo vencido ganha LEAD_DAYS e volta a active', async () => {
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    await Subscription.upsertForTenant(beta, { status: 'past_due', renews_at: new Date(Date.now() - 2 * DAY) });
    assert.equal((await isentar(beta, { exempt: false })).status, 200);
    const depois = await assinaturaDe(beta);
    assert.equal(depois.status, 'active');
    assert.ok(new Date(depois.renews_at).getTime() > Date.now());
  });

  it('com o prazo vencido, ganha LEAD_DAYS a partir de agora, e a emissão volta', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() - 20 * DAY) });
    assert.equal((await isentar(beta, { exempt: true })).status, 200);

    const inicio = Date.now();
    const res = await isentar(beta, { exempt: false });
    const fim = Date.now();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.alreadyInState, false);
    assert.equal(res.body.data.canceledCharges, 0);
    assert.equal(res.body.data.subscription.subscription.billingExempt, false);
    assert.equal(res.body.data.subscription.subscription.billingExemptSince, null);
    assert.equal(res.body.data.subscription.subscription.status, 'active', 'não vence no mesmo segundo');

    const depois = await assinaturaDe(beta);
    assert.equal(depois.billing_exempt_at, null);
    assert.equal(depois.billing_exempt_reason, null);
    const lead = ChargeIssuingService.LEAD_DAYS * DAY;
    const prazo = seg(depois.renews_at);
    assert.ok(prazo >= Math.floor((inicio + lead) / 1000) - 1 && prazo <= Math.floor((fim + lead) / 1000),
      `renews_at ≈ agora + ${ChargeIssuingService.LEAD_DAYS} dias`);
    assert.equal(new Date(depois.renews_at).getTime() % 1000, 0, 'truncado ao segundo');

    const [evento] = (await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.disabled');
    assert.ok(evento);
    assert.equal(seg(JSON.parse(evento.detail).deadlineTo), prazo);
    const trilhas = await trilhaDe(beta);
    assert.equal(trilhas.length, 2);
    assert.equal(JSON.parse(trilhas[1].detail).exempt, false);

    recebidas = [];
    const emissao = await runInTenant(beta, () => ChargeIssuingService.issueCurrent());
    assert.equal(emissao.issued, true, JSON.stringify(emissao));
    assert.equal(recebidas.filter((r) => r.method === 'POST' && r.path === '/payments').length, 1);
    assert.equal(Number(emissao.charge.amount_cents), 10000, 'pelo plano atual');
  });

  it('com o prazo no futuro, o prazo fica como está', async () => {
    const antes = await assinaturaDe(beta);
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    assert.equal((await isentar(beta, { exempt: false })).status, 200);
    assert.equal(seg((await assinaturaDe(beta)).renews_at), seg(antes.renews_at));
  });

  it('num plano pago sem prazo nenhum, ganha um', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: null });
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    assert.equal((await isentar(beta, { exempt: false })).status, 200);
    const depois = await assinaturaDe(beta);
    assert.ok(depois.renews_at, 'o prazo que põe a assinatura num ciclo');
    assert.ok(seg(depois.renews_at) > Math.floor(Date.now() / 1000));
  });
});

describe('a porta', () => {
  it('valida o corpo com 400', async () => {
    for (const body of [{}, { exempt: 'sim' }, { exempt: 1 }, { exempt: true, reason: 5 }, { exempt: true, reason: 'x'.repeat(256) }]) {
      const res = await isentar(beta, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await assinaturaDe(beta)).billing_exempt_at, null);
  });

  it('404 para provedor desconhecido e para a caixa da plataforma', async () => {
    assert.equal((await isentar(999999, { exempt: true })).status, 404);
    assert.equal((await isentar(caixa, { exempt: true })).status, 404);
  });

  it('só o plano de controle: quem não é da plataforma não passa', async () => {
    const res = await isentar(beta, { exempt: true }, comumToken);
    assert.ok(res.status === 403 || res.status === 404, String(res.status));
    assert.equal((await assinaturaDe(beta)).billing_exempt_at, null);
  });

  it('só o provedor da URL: o vizinho não é isentado', async () => {
    assert.equal((await isentar(beta, { exempt: true })).status, 200);
    assert.equal((await assinaturaDe(gama)).billing_exempt_at, null);
  });
});

describe('isenção com data de fim', () => {
  const futuro = (dias) => new Date(Date.now() + dias * DAY);

  it('liga com `until`, e as visões (console, lista e provedor) mostram a data', async () => {
    const ate = futuro(30);
    const res = await isentar(beta, { exempt: true, reason: 'cortesia', until: ate.toISOString() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(seg(res.body.data.subscription.subscription.billingExemptUntil), seg(ate));
    assert.equal(seg((await assinaturaDe(beta)).billing_exempt_until), seg(ate));

    const [evento] = (await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.enabled');
    assert.equal(seg(JSON.parse(evento.detail).until), seg(ate));
    const [trilha] = await trilhaDe(beta);
    assert.equal(seg(JSON.parse(trilha.detail).until), seg(ate));

    const lista = await platform('/subscriptions');
    const linhaBeta = lista.body.data.rows.find((r) => r.tenant.id === beta);
    const linhaGama = lista.body.data.rows.find((r) => r.tenant.id === gama);
    assert.equal(seg(linhaBeta.subscription.billingExemptUntil), seg(ate));
    assert.equal(linhaGama.subscription.billingExemptUntil, null);

    const uso = await runInTenant(beta, () => SubscriptionService.usage());
    assert.equal(seg(uso.subscription.billingExemptUntil), seg(ate), 'o provedor vê até quando');
    assert.equal(uso.subscription.billingExemptReason, null);
  });

  it('sem `until`, a isenção não tem fim e a visão diz nulo', async () => {
    const res = await isentar(beta, { exempt: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription.subscription.billingExemptUntil, null);
    assert.equal((await assinaturaDe(beta)).billing_exempt_until, null);
  });

  it('recusa com 400 a data passada, a inválida e a data ao desligar', async () => {
    const casos = [
      { exempt: true, until: new Date(Date.now() - 60_000).toISOString() },
      { exempt: true, until: 'amanhã' },
      { exempt: true, until: 5 },
      { exempt: true, until: '' },
      { exempt: false, until: futuro(3).toISOString() }
    ];
    for (const body of casos) {
      const res = await isentar(beta, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const passada = await isentar(beta, { exempt: true, until: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(passada.body.code, 'invalid_until');
    const desligando = await isentar(beta, { exempt: false, until: futuro(3).toISOString() });
    assert.equal(desligando.body.code, 'until_requires_exempt');
    assert.equal((await assinaturaDe(beta)).billing_exempt_at, null);
    assert.equal((await trilhaDe(beta)).length, 0);
  });

  it('já isento, outro `until` muda só a data; o mesmo, ou nenhum, não grava nada', async () => {
    const primeira = futuro(10);
    assert.equal((await isentar(beta, { exempt: true, reason: 'primeira', until: primeira.toISOString() })).status, 200);
    const desde = (await assinaturaDe(beta)).billing_exempt_at;

    const segunda = futuro(40);
    const res = await isentar(beta, { exempt: true, reason: 'ignorado', until: segunda.toISOString() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.alreadyInState, false);
    assert.equal(res.body.data.untilChanged, true);
    assert.equal(seg(res.body.data.subscription.subscription.billingExemptUntil), seg(segunda));
    const depois = await assinaturaDe(beta);
    assert.equal(seg(depois.billing_exempt_until), seg(segunda));
    assert.equal(seg(depois.billing_exempt_at), seg(desde), 'desde quando não muda');
    assert.equal(depois.billing_exempt_reason, 'primeira', 'o motivo não muda');
    const [atualizada] = (await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.updated');
    assert.ok(atualizada);
    assert.equal(seg(JSON.parse(atualizada.detail).untilFrom), seg(primeira));
    assert.equal(seg(JSON.parse(atualizada.detail).untilTo), seg(segunda));
    const trilhas = await trilhaDe(beta);
    assert.equal(trilhas.length, 2);
    assert.equal(JSON.parse(trilhas[1].detail).untilChanged, true);

    for (const body of [{ exempt: true, until: segunda.toISOString() }, { exempt: true }]) {
      const igual = await isentar(beta, body);
      assert.equal(igual.body.data.alreadyInState, true, JSON.stringify(body));
    }
    assert.equal((await trilhaDe(beta)).length, 2);

    // Nulo explícito tira a data: "até alguém desligar".
    const semFim = await isentar(beta, { exempt: true, until: null });
    assert.equal(semFim.body.data.untilChanged, true);
    const final = await assinaturaDe(beta);
    assert.equal(final.billing_exempt_until, null);
    assert.ok(final.billing_exempt_at, 'continua isento');
  });

  it('desligar à mão limpa a data', async () => {
    assert.equal((await isentar(beta, { exempt: true, until: futuro(5).toISOString() })).status, 200);
    const res = await isentar(beta, { exempt: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription.subscription.billingExemptUntil, null);
    assert.equal((await assinaturaDe(beta)).billing_exempt_until, null);
  });

  it('o fim automático desliga como o console: prazo +LEAD_DAYS, extrato e trilhas sem ator', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 3 * DAY) });
    assert.equal((await isentar(beta, { exempt: true, reason: 'por um mês', until: futuro(1).toISOString() })).status, 200);

    // Antes da data: nada.
    const cedo = await SubscriptionService.endExpiredBillingExempt({ tenantId: beta });
    assert.equal(cedo.ended, false);
    assert.equal(cedo.reason, 'not_yet');

    // A data passou, e o prazo também (a isenção durou mais que o ciclo).
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() - 2 * DAY) });
    const depoisDaData = new Date(Math.floor((Date.now() + 2 * DAY) / 1000) * 1000);
    const fim = await SubscriptionService.endExpiredBillingExempt({ tenantId: beta, now: depoisDaData });
    assert.equal(fim.ended, true, JSON.stringify(fim));

    const depois = await assinaturaDe(beta);
    assert.equal(depois.billing_exempt_at, null);
    assert.equal(depois.billing_exempt_until, null);
    assert.equal(depois.billing_exempt_reason, null);
    const lead = ChargeIssuingService.LEAD_DAYS * DAY;
    assert.equal(seg(depois.renews_at), seg(depoisDaData.getTime() + lead), 'o prazo ganha LEAD_DAYS a partir de agora');

    const [evento] = (await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.disabled');
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.source, 'scheduler');
    assert.equal(detalhe.reason, BILLING_EXEMPT_EXPIRED_REASON);
    assert.ok(detalhe.exemptUntil);
    assert.equal(evento.created_by, null, 'sem ator');

    const trilhas = await trilhaDe(beta);
    assert.equal(trilhas.length, 2);
    const auto = JSON.parse(trilhas[1].detail);
    assert.equal(trilhas[1].actor_user_id, null);
    assert.equal(auto.exempt, false);
    assert.equal(auto.source, 'scheduler');
    assert.equal(auto.reason, BILLING_EXEMPT_EXPIRED_REASON);
    const doProvedor = await getDb()('audit_log').where({ tenant_id: beta, action: 'subscription.changed' })
      .orderBy('id', 'desc').first();
    assert.equal(doProvedor.actor_kind, 'system');
    assert.equal(JSON.parse(doProvedor.detail).source, 'scheduler');

    recebidas = [];
    const emissao = await runInTenant(beta, () => ChargeIssuingService.issueCurrent({ now: depoisDaData }));
    assert.equal(emissao.issued, true, JSON.stringify(emissao));

    // Idempotente: outra volta não faz nada.
    const deNovo = await SubscriptionService.endExpiredBillingExempt({ tenantId: beta, now: depoisDaData });
    assert.equal(deNovo.ended, false);
    assert.equal((await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.disabled').length, 1);
    assert.equal((await trilhaDe(beta)).length, 2);
  });

  it('o fim automático reabre a cobrança do período que a isenção cancelou', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 3 * DAY) });
    const emitida = await abrirCobranca(beta, { gatewayChargeId: 'pay_reaberta' });
    assert.equal((await isentar(beta, { exempt: true, until: futuro(1).toISOString() })).status, 200);
    assert.equal((await cobrancaDe(beta, emitida)).status, 'canceled');

    const depoisDaData = new Date(Date.now() + DAY + 60_000);
    const fim = await SubscriptionService.endExpiredBillingExempt({ tenantId: beta, now: depoisDaData });
    assert.equal(fim.ended, true);
    assert.equal(fim.reopenedCharge, true);
    const reaberta = await cobrancaDe(beta, emitida);
    assert.equal(reaberta.status, 'pending');
    assert.equal(reaberta.gateway_charge_id, null);
    assert.equal(JSON.parse((await trilhaDe(beta)).slice(-1)[0].detail).reopenedCharge, true);
  });

  it('duas voltas sobrepostas desligam uma vez só', async () => {
    assert.equal((await isentar(beta, { exempt: true, until: futuro(1).toISOString() })).status, 200);
    const depoisDaData = new Date(Date.now() + 2 * DAY);
    const resultados = await Promise.all([
      SubscriptionService.endExpiredBillingExempt({ tenantId: beta, now: depoisDaData }),
      SubscriptionService.endExpiredBillingExempt({ tenantId: beta, now: depoisDaData })
    ]);
    assert.equal(resultados.filter((r) => r.ended).length, 1, JSON.stringify(resultados));
    assert.equal((await eventosDe(beta)).filter((e) => e.type === 'billing_exempt.disabled').length, 1);
    assert.equal((await trilhaDe(beta)).length, 2, 'a ligação e um fim');
  });

  it('a data que o console estendeu no meio do caminho não é encerrada pela leitura velha', async () => {
    assert.equal((await isentar(beta, { exempt: true, until: futuro(1).toISOString() })).status, 200);
    const depoisDaData = new Date(Date.now() + 2 * DAY);
    // A condição da gravação (`billing_exempt_until <= agora`) é o que segura
    // a data estendida entre a leitura do agendador e a escrita.
    const lida = await assinaturaDe(beta);
    await Subscription.upsertForTenant(beta, { billing_exempt_until: new Date(Date.now() + 10 * DAY) });
    const mudou = await Subscription.changeBillingExemptIf(
      beta, { wasExempt: true, expiredBy: depoisDaData }, { billing_exempt_at: null, billing_exempt_until: null }
    );
    assert.equal(mudou, false);
    assert.ok(lida.billing_exempt_at);
    assert.ok((await assinaturaDe(beta)).billing_exempt_at, 'continua isento');
    const r = await SubscriptionService.endExpiredBillingExempt({ tenantId: beta, now: depoisDaData });
    assert.equal(r.ended, false);
  });

  it('o agendador encerra a isenção vencida antes de emitir, na mesma volta', async () => {
    await Subscription.upsertForTenant(beta, { renews_at: new Date(Date.now() + 2 * DAY) });
    assert.equal((await isentar(beta, { exempt: true, until: futuro(1).toISOString() })).status, 200);
    // Vencida: a data de fim já passou (gravada à mão no passado).
    await Subscription.upsertForTenant(beta, {
      billing_exempt_until: new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    });
    const linha = await getDb()('tenants').where({ id: beta }).first();
    recebidas = [];
    const resumo = await runInTenant(beta, () => SchedulerService.runJobs({ tenant: linha }));
    assert.equal(resumo.billingExemptEnded.ended, true, JSON.stringify(resumo.billingExemptEnded));
    assert.equal(resumo.chargeIssued.issued, true, JSON.stringify(resumo.chargeIssued));
    assert.equal((await assinaturaDe(beta)).billing_exempt_at, null);
    assert.equal(recebidas.filter((r) => r.method === 'POST' && r.path === '/payments').length, 1);
  });
});
