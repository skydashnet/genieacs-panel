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
const { BILLING_EVENT_TYPES } = await import('../src/models/BillingEvent.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { aggregateRevenue, parseRange } = await import('../src/services/revenueReportService.js');
const { invoicePayload } = await import('../src/services/billing/billingInvoiceService.js');

/**
 * A pró-rata da subida no meio do período (0101).
 *
 * Self-hosted, pelo motivo de `tenant-self-billing.test.js`: o gateway de
 * mentira em `127.0.0.1` e as requisições que SAEM asseridas uma a uma.
 *
 * O que não pode dar errado, em dinheiro:
 *
 * 1. **Cobrar a mais ou duas vezes** — a conta com o cupom, o mínimo, a
 *    retentativa com a mesma referência e sem duplicar, duas subidas no mesmo
 *    período com uma fatura cada pela sua diferença.
 * 2. **O pagamento dela comprar período** — não estende `renews_at`, não gasta
 *    ciclo de cupom, não é "pagamento a menos" da renovação; o estorno só
 *    devolve o dinheiro.
 * 3. **Ficar de graça** — a vencida deixa o provedor `past_due`.
 * 4. **O gateway fora derrubar a troca** — a troca vale, a linha fica para o
 *    agendador.
 */
const CHAVE = 'chave-da-prorata';
const TOKEN = 'token-do-webhook-da-prorata';
const DIA = 86_400_000;

let gateway;
let recebidas = [];
let proximoId = 0;
/** Quando verdadeiro, o gateway de mentira recusa toda criação de cobrança (500). */
let recusarCriacao = false;
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
        if (recusarCriacao) return responder(500, { errors: [{ description: 'gateway fora do ar' }] });
        proximoId += 1;
        const id = `pay_pr_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      if (req.method === 'DELETE' && caminho.startsWith('/payments/')) {
        return responder(200, { deleted: true });
      }
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
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN;

  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-prorata', password: 'senha-da-dona-1', email: 'dona@prorata.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.basico = await criar({ code: 'pr-basico', name: 'Básico', price_cents: 10000 });
  planos.medio = await criar({ code: 'pr-medio', name: 'Médio', price_cents: 16000 });
  planos.pro = await criar({ code: 'pr-pro', name: 'Pro', price_cents: 25000 });
  planos.vizinho = await criar({ code: 'pr-vizinho', name: 'Vizinho', price_cents: 10300 });
  planos.mini = await criar({ code: 'pr-mini', name: 'Mini', price_cents: 5000 });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

/** Um instante relativo a agora, ao segundo (o MySQL guarda segundos). */
const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * DIA) / 1000) * 1000);

async function assinar({ plan = planos.basico, status = 'active', renewsAt = daquiA(15), coupon = null } = {}) {
  await Subscription.upsertForTenant(alfa, {
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
    proration_due_at: null,
    suspended_reason: null,
    coupon_id: coupon?.id ?? null,
    coupon_cycles_left: coupon ? 3 : null,
    coupon_applied_at: coupon ? new Date(Math.floor(Date.now() / 1000) * 1000) : null
  });
  await SubscriptionService.invalidate(alfa);
}

const linha = () => Subscription.forTenant(alfa);
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');
const prorratas = async () => (await cobrancas()).filter((c) => c.kind === 'proration');
const postsDeProrata = () => recebidas.filter((r) => r.method === 'POST'
  && /:proration:/.test(r.payload?.externalReference ?? ''));

const pedir = (caminho, { method = 'GET', body } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(donoToken), ...(body === undefined ? {} : { body })
});
const trocar = (planId) => pedir('/subscription/plan', { method: 'PUT', body: { planId } });
const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: corpo
});

/** O valor esperado pela fórmula, com os segundos que a linha tinha na hora. */
const formula = (de, para, segundos, periodo = 30 * 86_400) => Math.ceil(((para - de) * segundos) / periodo);

beforeEach(async () => {
  recebidas = [];
  recusarCriacao = false;
  await getDb()('billing_charges').where({ tenant_id: alfa }).del();
  await getDb()('billing_events').where({ tenant_id: alfa }).del();
  await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa' });
  await assinar();
});

describe('a conta (prorationQuote)', () => {
  it('é a diferença proporcional ao que falta, arredondada para cima', () => {
    const agora = new Date('2026-10-06T12:00:00Z');
    const sub = { status: 'active', renews_at: new Date(agora.getTime() + 10 * DIA + 1000) };
    const q = SubscriptionService.prorationQuote(sub, planos.basico, planos.pro, null, agora);
    const segundos = 10 * 86_400 + 1;
    assert.equal(q.eligible, true);
    assert.equal(q.remainingSeconds, segundos);
    assert.equal(q.amountCents, formula(10000, 25000, segundos));
    assert.equal(q.amountCents, 5001, '15000 × 864001 ÷ 2592000 = 5000,0058 → 5001');
    assert.equal(q.remainingDays, 11);
    assert.equal(q.skipped, undefined);
  });

  it('com o cupom, nos dois preços', async () => {
    sequencia += 1;
    const cupom = await Coupon.create({
      code: `PRORATA${sequencia}`, kind: 'percent', value: 20, duration: 'repeating', duration_cycles: 3, redemptions: 0, active: true
    });
    const agora = new Date('2026-10-06T12:00:00Z');
    const sub = {
      status: 'active', renews_at: new Date(agora.getTime() + 15 * DIA), coupon_id: cupom.id, coupon_cycles_left: 2
    };
    const q = SubscriptionService.prorationQuote(sub, planos.basico, planos.pro, cupom, agora);
    assert.equal(q.fromPriceCents, 8000);
    assert.equal(q.toPriceCents, 20000);
    assert.equal(q.amountCents, 6000, '(20000 − 8000) × 15 ÷ 30');
  });

  it('nada a cobrar: descida, teste, período vencido, isento', () => {
    const agora = new Date('2026-10-06T12:00:00Z');
    const vivo = { status: 'active', renews_at: new Date(agora.getTime() + 5 * DIA) };
    assert.equal(SubscriptionService.prorationQuote(vivo, planos.pro, planos.basico, null, agora).eligible, false);
    assert.equal(SubscriptionService.prorationQuote({ ...vivo, status: 'trial' }, planos.basico, planos.pro, null, agora).eligible, false);
    assert.equal(SubscriptionService.prorationQuote(
      { ...vivo, renews_at: new Date(agora.getTime() - DIA) }, planos.basico, planos.pro, null, agora
    ).eligible, false);
    assert.equal(SubscriptionService.prorationQuote(
      { ...vivo, billing_exempt_at: agora }, planos.basico, planos.pro, null, agora
    ).eligible, false);
  });

  it('abaixo de R$ 5,00, `skipped`', () => {
    const agora = new Date('2026-10-06T12:00:00Z');
    const sub = { status: 'active', renews_at: new Date(agora.getTime() + 15 * DIA) };
    const q = SubscriptionService.prorationQuote(sub, planos.basico, planos.vizinho, null, agora);
    assert.equal(q.amountCents, 150);
    assert.equal(q.skipped, 'below_minimum');
  });
});

describe('a subida', () => {
  it('abre a fatura avulsa da diferença, com vencimento em três dias, e o plano vale na hora', async () => {
    const renova = (await linha()).renews_at;
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const depois = await linha();
    assert.equal(depois.plan_id, planos.pro.id, 'o plano novo vale já');
    assert.equal(new Date(depois.renews_at).getTime(), new Date(renova).getTime(), 'o prazo não muda');

    const [pr] = await prorratas();
    assert.ok(pr, 'a linha de pró-rata existe');
    assert.equal(pr.kind, 'proration');
    assert.match(pr.period_end, /^p[0-9a-f]{9}$/);
    const detalhe = JSON.parse(pr.proration_detail);
    assert.equal(Number(pr.amount_cents), formula(10000, 25000, detalhe.remainingSeconds));
    assert.ok(Number(pr.amount_cents) >= 7400 && Number(pr.amount_cents) <= 7500, String(pr.amount_cents));
    assert.equal(detalhe.periodEnd, ChargeIssuingService.periodKey(renova));
    assert.equal(detalhe.fromPlanId, planos.basico.id);
    assert.equal(detalhe.toPlanId, planos.pro.id);
    assert.equal(pr.status, 'pending');
    assert.ok(pr.gateway_charge_id);
    assert.equal(isoDia(pr.due_date), ChargeIssuingService.isoDate(Date.now() + 3 * DIA));

    const [post] = postsDeProrata();
    assert.equal(post.payload.externalReference, `tenant:${alfa}:proration:${pr.id}`);
    assert.equal(post.payload.value, Number(pr.amount_cents) / 100);
    assert.equal(post.payload.dueDate, isoDia(pr.due_date));

    // A resposta traz a fatura, com o link, para a tela levar ao pagamento.
    assert.equal(res.body.data.proration.issued, true);
    assert.equal(res.body.data.proration.amountCents, Number(pr.amount_cents));
    assert.equal(res.body.data.proration.charge.kind, 'proration');
    assert.ok(res.body.data.proration.charge.invoiceUrl);

    // O extrato da troca diz quanto.
    const evento = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PLAN_CHANGED }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(evento.detail).proration.amountCents, Number(pr.amount_cents));

    // A prévia da lista de planos é a mesma conta (antes da troca).
    // E a fatura aparece no extrato do provedor com o tipo.
    const lista = await pedir('/charges');
    const naTela = lista.body.data.charges.find((c) => c.id === pr.id);
    assert.equal(naTela.kind, 'proration');
    assert.equal(naTela.periodEnd, detalhe.periodEnd);
  });

  it('a prévia da lista de planos bate com o que a troca cobra', async () => {
    const lista = (await pedir('/plans')).body.data;
    const previa = lista.find((p) => p.id === planos.pro.id).proration;
    assert.ok(previa.amountCents > 0);
    assert.equal(previa.remainingDays, 15);
    assert.equal(lista.find((p) => p.id === planos.mini.id).proration, null, 'descida não cobra');
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    // Os segundos andaram entre as duas leituras: no máximo um centavo.
    assert.ok(Math.abs(Number(pr.amount_cents) - previa.amountCents) <= 1);
  });

  it('abaixo do mínimo não sai fatura, e o extrato registra', async () => {
    const res = await trocar(planos.vizinho.id);
    assert.equal(res.status, 200);
    assert.deepEqual(await prorratas(), []);
    assert.deepEqual(postsDeProrata(), []);
    assert.equal(res.body.data.proration.skipped, 'below_minimum');
    const evento = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PLAN_CHANGED }).orderBy('id', 'desc').first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.proration.skipped, 'below_minimum');
    assert.ok(detalhe.proration.amountCents > 0 && detalhe.proration.amountCents < 500);
  });

  it('descer (agendado) ou desistir da descida não cobra nada', async () => {
    assert.equal((await trocar(planos.mini.id)).status, 200);
    assert.equal((await linha()).pending_plan_id, planos.mini.id);
    assert.equal((await trocar(planos.basico.id)).status, 200, 'desiste da descida');
    assert.equal((await linha()).pending_plan_id, null);
    assert.deepEqual(await prorratas(), []);
  });

  it('dois cliques ao mesmo tempo: uma fatura só', async () => {
    const [a, b] = await Promise.all([trocar(planos.pro.id), trocar(planos.pro.id)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal((await prorratas()).length, 1);
    assert.equal(postsDeProrata().length, 1);
  });

  it('em teste ou sem período correndo, nada', async () => {
    await assinar({ status: 'trial' });
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ trial_ends_at: daquiA(5) });
    assert.equal((await trocar(planos.pro.id)).status, 200);
    assert.deepEqual(await prorratas(), []);
  });

  it('duas subidas no mesmo período: duas faturas, cada uma pela sua diferença', async () => {
    assert.equal((await trocar(planos.medio.id)).status, 200);
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [primeira, segunda] = await prorratas();
    assert.ok(primeira && segunda);
    assert.notEqual(primeira.period_end, segunda.period_end);
    const d1 = JSON.parse(primeira.proration_detail);
    const d2 = JSON.parse(segunda.proration_detail);
    assert.equal(Number(primeira.amount_cents), formula(10000, 16000, d1.remainingSeconds));
    assert.equal(Number(segunda.amount_cents), formula(16000, 25000, d2.remainingSeconds));
    assert.equal(d2.fromPlanId, planos.medio.id);
    const refs = postsDeProrata().map((p) => p.payload.externalReference);
    assert.deepEqual(refs, [`tenant:${alfa}:proration:${primeira.id}`, `tenant:${alfa}:proration:${segunda.id}`]);
  });
});

describe('o gateway fora', () => {
  it('não desfaz a troca; o agendador retoma com a mesma referência, sem duplicar', async () => {
    recusarCriacao = true;
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await linha()).plan_id, planos.pro.id, 'a troca vale');
    assert.equal(res.body.data.proration.issued, false);
    assert.equal(res.body.data.proration.reason, 'gateway_failed');
    let [pr] = await prorratas();
    assert.equal(pr.status, 'failed');
    assert.equal(pr.gateway_charge_id, null);
    assert.equal(Number(pr.attempts), 1);
    assert.ok(pr.next_attempt_at, 'espera antes da próxima');
    // Sem link de pagamento, não bloqueia ninguém.
    assert.equal((await linha()).proration_due_at, null);

    // A passada do agendador respeita a espera...
    recusarCriacao = false;
    recebidas = [];
    await runInTenant(alfa, () => ChargeIssuingService.retryProrations());
    assert.deepEqual(postsDeProrata(), []);

    // ...e, vencida a espera, emite — uma vez.
    await getDb()('billing_charges').where({ id: pr.id }).update({ next_attempt_at: null });
    const passada = await runInTenant(alfa, () => ChargeIssuingService.retryProrations());
    assert.equal(passada.issued, 1);
    await runInTenant(alfa, () => ChargeIssuingService.retryProrations());
    const posts = postsDeProrata();
    assert.equal(posts.length, 1, 'a segunda passada não emite de novo');
    assert.equal(posts[0].payload.externalReference, `tenant:${alfa}:proration:${pr.id}`);
    [pr] = await prorratas();
    assert.equal(pr.status, 'pending');
    assert.ok(pr.gateway_charge_id);
    assert.equal((await prorratas()).length, 1, 'a mesma linha, e não outra');
    assert.ok((await linha()).proration_due_at, 'emitida, passa a contar para o vencimento');
  });

  it('o teto de tentativas para o agendador', async () => {
    recusarCriacao = true;
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    await getDb()('billing_charges').where({ id: pr.id })
      .update({ attempts: ChargeIssuingService.MAX_ATTEMPTS, next_attempt_at: null });
    recusarCriacao = false;
    recebidas = [];
    await runInTenant(alfa, () => ChargeIssuingService.retryProrations());
    assert.deepEqual(postsDeProrata(), []);
  });
});

describe('a pró-rata de quem deixou de ser cobrável (revisão)', () => {
  const falhada = async () => {
    recusarCriacao = true;
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    assert.equal(pr.status, 'failed');
    recusarCriacao = false;
    recebidas = [];
    await getDb()('billing_charges').where({ id: pr.id }).update({ next_attempt_at: null });
    return pr;
  };

  it('cancelar pelo console cancela a pró-rata que não chegou ao gateway', async () => {
    const pr = await falhada();
    await runInTenant(alfa, () => SubscriptionService.setStatus({ status: 'canceled', reason: 'teste' }));
    const [depois] = await prorratas();
    assert.equal(depois.id, pr.id);
    assert.equal(depois.status, 'canceled');
    await runInTenant(alfa, () => ChargeIssuingService.retryProrations({ manual: true }));
    assert.deepEqual(postsDeProrata(), [], 'nada vai ao gateway depois do cancelamento');
  });

  it('suspender à mão também; a retentativa do agendador não a emite', async () => {
    const pr = await falhada();
    // Gravado direto, como um caminho que não passe por `setStatus`.
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ status: 'suspended', suspended_reason: 'manual' });
    await SubscriptionService.invalidate(alfa);
    const passada = await runInTenant(alfa, () => ChargeIssuingService.retryProrations());
    assert.equal(passada.reason, 'not_billable');
    assert.deepEqual(postsDeProrata(), []);
    const [depois] = await prorratas();
    assert.equal(depois.id, pr.id);
    assert.equal(depois.status, 'canceled');
    assert.equal((await linha()).proration_due_at, null);
  });

  it('emitProration relê a assinatura e não emite para quem foi cancelado no meio', async () => {
    const pr = await falhada();
    assert.equal(await runInTenant(alfa, () => BillingCharge.claim(pr.id, { until: new Date(Date.now() + 60_000) })), true);
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ status: 'canceled' });
    const resultado = await runInTenant(alfa, async () => ChargeIssuingService.emitProration({
      tenant: await getDb()('tenants').where({ id: alfa }).first(),
      provider: (await import('../src/services/billing/registry.js')).providerFor('asaas'),
      chargeId: pr.id
    }));
    assert.equal(resultado.reason, 'not_billable');
    assert.deepEqual(postsDeProrata(), []);
    assert.equal((await prorratas())[0].status, 'canceled');
  });

  it('a suspensão automática continua cobrável: a pró-rata sai', async () => {
    await falhada();
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ status: 'suspended', suspended_reason: 'auto_nonpayment' });
    await SubscriptionService.invalidate(alfa);
    const passada = await runInTenant(alfa, () => ChargeIssuingService.retryProrations());
    assert.equal(passada.issued, 1, JSON.stringify(passada));
    assert.equal(postsDeProrata().length, 1);
  });
});

describe('a subida e a pró-rata (revisão C/D)', () => {
  const pagarPorWebhook = (pr, id = pr.gateway_charge_id) => entregar({
    event: 'PAYMENT_RECEIVED',
    payment: {
      id, value: Number(pr.amount_cents) / 100, customer: 'cus_alfa', externalReference: `tenant:${alfa}:proration:${pr.id}`
    }
  });

  it('a pró-rata paga tira a marca da subida (a descida não fica adiada à toa)', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    assert.ok((await linha()).upgraded_at, 'a subida marcou');
    const [pr] = await prorratas();
    assert.equal((await pagarPorWebhook(pr)).body.code, 'recorded');
    assert.equal((await linha()).upgraded_at, null, 'paga a diferença, a marca sai');
  });

  it('o pagamento no id VELHO de uma pró-rata reemitida continua sendo pró-rata', async () => {
    const antes = await linha();
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    const velho = pr.gateway_charge_id;
    await runInTenant(alfa, async () => {
      assert.ok(await BillingCharge.resetForReissue(pr.id, { amountCents: Number(pr.amount_cents), currency: 'BRL' }));
      await BillingCharge.markIssued(pr.id, { gatewayChargeId: 'pay_pr_novo', dueDate: pr.due_date });
    });
    const res = await pagarPorWebhook(pr, velho);
    assert.equal(res.body.code, 'recorded', JSON.stringify(res.body));
    const depois = await linha();
    assert.equal(new Date(depois.renews_at).getTime(), new Date(antes.renews_at).getTime(), 'não compra período');
    const evento = await getDb()('billing_events').where({ tenant_id: alfa, external_id: velho }).first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.proration, true);
    assert.equal(detalhe.chargeId, pr.id);
  });

  it('a mesma subida de novo no período, depois de a primeira fechar, ganha fatura própria', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [primeira] = await prorratas();
    assert.equal((await pagarPorWebhook(primeira)).body.code, 'recorded');
    // O console devolve o plano de antes…
    await Subscription.upsertForTenant(alfa, { plan_id: planos.basico.id });
    await SubscriptionService.invalidate(alfa);
    // …e o provedor sobe de novo: outra diferença, outra fatura.
    const de_novo = await trocar(planos.pro.id);
    assert.equal(de_novo.status, 200, JSON.stringify(de_novo.body));
    assert.equal(de_novo.body.data.proration.issued, true, JSON.stringify(de_novo.body.data.proration));
    const todas = await prorratas();
    assert.equal(todas.length, 2);
    assert.notEqual(todas[0].period_end, todas[1].period_end);
  });

  it('o provedor sem gateway: a troca registra por que a diferença não foi cobrada', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: null, billing_customer_ref: null });
    assert.equal((await trocar(planos.pro.id)).status, 200);
    assert.deepEqual(await prorratas(), []);
    const evento = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PLAN_CHANGED }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(evento.detail).proration.notCharged, 'not_linked');
  });
});

describe('o pagamento da pró-rata', () => {
  it('pelo webhook: quita a fatura, não estende o prazo nem gasta ciclo de cupom', async () => {
    sequencia += 1;
    const cupom = await Coupon.create({
      code: `PAGO${sequencia}`, kind: 'percent', value: 10, duration: 'repeating', duration_cycles: 3, redemptions: 1, active: true
    });
    await assinar({ coupon: cupom });
    const antes = await linha();
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    assert.equal(Number(pr.coupon_id), cupom.id, 'o cupom vale no plano novo e entrou na conta');

    const res = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: pr.gateway_charge_id,
        value: Number(pr.amount_cents) / 100,
        customer: 'cus_alfa',
        externalReference: `tenant:${alfa}:proration:${pr.id}`
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'recorded');

    const depois = await linha();
    assert.equal(new Date(depois.renews_at).getTime(), new Date(antes.renews_at).getTime(), 'o prazo não anda');
    assert.equal(depois.coupon_cycles_left, 3, 'nenhum ciclo de cupom gasto');
    assert.equal(depois.status, 'active');
    assert.equal(depois.proration_due_at, null);
    const [paga] = await prorratas();
    assert.equal(paga.status, 'paid');

    const evento = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED }).first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.proration, true);
    assert.equal(detalhe.underpaid, undefined, 'não é pagamento a menos da renovação');
    assert.equal(detalhe.expectedCents, Number(pr.amount_cents));
    assert.equal(detalhe.periodDays, undefined);
    assert.equal(Number(evento.amount_cents), Number(pr.amount_cents), 'o dinheiro entra no extrato');
  });

  it('o suspenso pela inadimplência (0102) que paga a pró-rata volta a ativo, sem estender o prazo', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    await getDb()('subscriptions').where({ tenant_id: alfa })
      .update({ status: 'suspended', suspended_reason: 'auto_nonpayment' });
    await SubscriptionService.invalidate(alfa);
    const antes = await linha();

    const res = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: pr.gateway_charge_id,
        value: Number(pr.amount_cents) / 100,
        customer: 'cus_alfa',
        externalReference: `tenant:${alfa}:proration:${pr.id}`
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'recorded');

    const depois = await linha();
    assert.equal(depois.status, 'active');
    assert.equal(depois.suspended_reason, null);
    assert.equal(new Date(depois.renews_at).getTime(), new Date(antes.renews_at).getTime(), 'a pró-rata não compra período');
    assert.equal((await prorratas())[0].status, 'paid');
    const evento = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED }).first();
    const detalhe = JSON.parse(evento.detail);
    assert.equal(detalhe.proration, true);
    assert.equal(detalhe.reactivated, true);
    assert.equal(detalhe.suspendedReason, 'auto_nonpayment');
    assert.equal(detalhe.periodDays, undefined);
  });

  it('o suspenso a dedo que paga a pró-rata continua suspenso', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    await getDb()('subscriptions').where({ tenant_id: alfa })
      .update({ status: 'suspended', suspended_reason: 'manual' });
    await SubscriptionService.invalidate(alfa);
    await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: Number(pr.amount_cents), provider: 'asaas', externalId: pr.gateway_charge_id
    }));
    const depois = await linha();
    assert.equal(depois.status, 'suspended');
    assert.equal(depois.suspended_reason, 'manual');
  });

  it('pago a menos fica em aberto, conferido pelo valor DELA', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: Number(pr.amount_cents) - 100, provider: 'asaas', externalId: pr.gateway_charge_id
    }));
    assert.equal(pago.underpaid, true);
    assert.equal(pago.expectedCents, Number(pr.amount_cents));
  });

  it('o estorno desfaz só o dinheiro, não o prazo', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    const antes = await linha();
    await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: Number(pr.amount_cents), provider: 'asaas', externalId: pr.gateway_charge_id
    }));
    const estorno = await runInTenant(alfa, () => SubscriptionService.reversePayment({
      externalId: pr.gateway_charge_id, source: 'webhook'
    }));
    assert.equal(estorno.found, true);
    assert.equal(estorno.basis, 'not_extended');
    const depois = await linha();
    assert.equal(new Date(depois.renews_at).getTime(), new Date(antes.renews_at).getTime());
    const refund = await getDb()('billing_events')
      .where({ tenant_id: alfa, type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED }).first();
    assert.equal(Number(refund.amount_cents), Number(pr.amount_cents));
    assert.equal(JSON.parse(refund.detail).reversedDays, 0);
  });
});

describe('a pró-rata vencida', () => {
  it('deixa o provedor past_due (proration_overdue) até pagar', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    let sub = await linha();
    assert.equal(SubscriptionService.effectiveStatus(sub).status, 'active', 'dentro do prazo, ativo');
    assert.ok(sub.proration_due_at);
    // Vence no dia seguinte ao vencimento, no fuso da cobrança.
    assert.equal(
      new Date(sub.proration_due_at).getTime(),
      new Date(`${isoDia(pr.due_date)}T00:00:00-03:00`).getTime() + DIA
    );

    // Venceu: o vencimento no passado, como o gateway deixaria.
    await runInTenant(alfa, () => BillingCharge.update(pr.id, { due_date: ChargeIssuingService.isoDate(Date.now() - 2 * DIA) }));
    sub = await linha();
    assert.deepEqual(SubscriptionService.effectiveStatus(sub), { status: 'past_due', reason: 'proration_overdue' });
    const tela = await pedir('/subscription');
    assert.equal(tela.body.data.subscription.status, 'past_due');
    assert.equal(tela.body.data.subscription.reason, 'proration_overdue');

    // O "pagar agora" entrega a fatura que bloqueia — a pró-rata —, e não
    // emite a da renovação.
    recebidas = [];
    const pago = await pedir('/charges/pay', { method: 'POST' });
    assert.equal(pago.status, 200, JSON.stringify(pago.body));
    assert.equal(pago.body.data.charge.id, pr.id);
    assert.equal(pago.body.data.charge.kind, 'proration');
    assert.deepEqual(recebidas.filter((r) => r.method === 'POST'), []);

    // A renovação vencida tem precedência no motivo.
    assert.equal(SubscriptionService.effectiveStatus({ ...sub, renews_at: daquiA(-1) }).reason, 'renewal_expired');

    // Paga (o webhook a quita): volta a ativo.
    await runInTenant(alfa, () => BillingCharge.update(pr.id, { status: 'paid' }));
    sub = await linha();
    assert.equal(sub.proration_due_at, null);
    assert.equal(SubscriptionService.effectiveStatus(sub).status, 'active');
  });

  it('a cancelada pelo console também libera', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    await runInTenant(alfa, () => BillingCharge.update(pr.id, { due_date: ChargeIssuingService.isoDate(Date.now() - 2 * DIA) }));
    assert.equal(SubscriptionService.effectiveStatus(await linha()).reason, 'proration_overdue');
    await runInTenant(alfa, () => BillingCharge.update(pr.id, { status: 'canceled' }));
    assert.equal(SubscriptionService.effectiveStatus(await linha()).status, 'active');
  });
});

describe('a renovação não confunde as duas', () => {
  it('a faxina não cancela a pró-rata; a cobrança "do período" e a "em aberto" são a renovação', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const [pr] = await prorratas();
    await runInTenant(alfa, async () => {
      // Um período bem à frente: tudo o que é "antes" dele seria faxinado.
      assert.equal(await ChargeIssuingService.cancelStale('2999-12-31'), 0);
      assert.equal(await BillingCharge.currentOpen(), null, 'só há a pró-rata, e ela não é a do aviso');
      assert.equal(await BillingCharge.forPeriod(JSON.parse(pr.proration_detail).periodEnd), null);
    });
    assert.equal((await prorratas())[0].status, 'pending');

    // E a emissão da renovação sai normalmente, ao lado dela.
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: daquiA(2) });
    const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    assert.equal(emitida.amountCents, 25000);
    assert.equal((await cobrancas()).length, 2);
  });

  it('a isenção ligada cancela a pró-rata em aberto junto', async () => {
    assert.equal((await trocar(planos.pro.id)).status, 200);
    const resultado = await runInTenant(alfa, () => ChargeIssuingService.cancelOpenCharges());
    assert.equal(resultado.canceled, 1);
    assert.equal((await prorratas())[0].status, 'canceled');
    assert.equal((await linha()).proration_due_at, null);
  });
});

describe('a receita e a NFS-e', () => {
  it('o pagamento da pró-rata conta como recebido e não como desconto', () => {
    const range = parseRange({ from: '2026-10-01', to: '2026-10-31' });
    const plano = { id: 1, name: 'Pro', price_cents: 25000, period_days: 30, currency: 'BRL' };
    const relatorio = aggregateRevenue({
      range,
      now: new Date('2026-10-20T12:00:00Z'),
      tenants: [{ id: 7 }],
      subscriptions: [{ id: 70, tenant_id: 7, plan_id: 1, status: 'active', renews_at: '2026-11-15T00:00:00Z' }],
      plans: [plano],
      prices: new Map([[70, 25000]]),
      charges: [],
      events: [{
        tenant_id: 7, subscription_id: 70, type: BILLING_EVENT_TYPES.PAYMENT_RECORDED, external_id: 'pay_x',
        amount_cents: 7500, detail: JSON.stringify({ proration: true, expectedCents: 7500 }),
        created_at: '2026-10-10T12:00:00Z'
      }]
    });
    assert.equal(relatorio.receivedCents, 7500);
    assert.equal(relatorio.discountCents, 0);
  });

  it('a observação da nota diz que é pró-rata, com o período de verdade', () => {
    const charge = {
      id: 9, gateway_charge_id: 'pay_9', amount_cents: 7500, period_end: 'pabc123456', kind: 'proration',
      proration_detail: JSON.stringify({ periodEnd: '2026-10-21' })
    };
    const corpo = invoicePayload({ serviceDescription: 'SaaS' }, charge, new Date('2026-10-10T12:00:00Z'));
    assert.equal(corpo.observations, 'Pró-rata da troca de plano, período até 2026-10-21');
    assert.equal(corpo.valueCents, 7500);
  });
});

/** `due_date` como `YYYY-MM-DD`, venha como vier do banco. */
function isoDia(valor) {
  if (valor instanceof Date) {
    return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, '0')}-${String(valor.getDate()).padStart(2, '0')}`;
  }
  return String(valor).slice(0, 10);
}
