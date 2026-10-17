import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: BillingInvoice, safeInvoiceUrl } = await import('../src/models/BillingInvoice.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const {
  default: BillingInvoiceService, backoffMs, effectiveDateOf, invoicePayload, MAX_CANCEL_ATTEMPTS
} = await import('../src/services/billing/billingInvoiceService.js');
const { default: BillingWebhookController } = await import('../src/controllers/billingWebhookController.js');
const { save, invalidateAsaasSettings } = await import('../src/services/billing/asaasSettingsService.js');
const { resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');
const { billingWebhookLimiter, ipKey } = await import('../src/middleware/rateLimit.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { default: platformBillingRoutes } = await import('../src/routes/platformBilling.js');
const { default: platformIntegrationsRoutes } = await import('../src/routes/platformIntegrations.js');

/**
 * A NFS-e das cobranças pagas, pela Asaas — com um gateway de mentira em
 * `127.0.0.1` que responde `/payments` e `/invoices`, como em
 * `platform-charge-refund.test.js`.
 *
 * O que não pode dar errado, e é o que se prova:
 *
 * 1. **O webhook não fala com a Asaas.** O pagamento só enfileira.
 * 2. **Uma nota por cobrança.** Reentrega, baixa e clique repetido chegam à
 *    mesma linha; a falha com resposta perdida não cria a segunda.
 * 3. **Falha não corrompe nada.** A nota espera e tenta de novo; o estorno
 *    segue mesmo quando o cancelamento da nota é recusado.
 *
 * Datas comparadas ao segundo, pelo MySQL.
 */
const CHAVE = 'chave-das-notas';
const TOKEN = 'token-do-webhook-das-notas';
const DAY = 24 * 60 * 60 * 1000;

let gateway;
let recebidas = [];
/** O que o gateway faz com o próximo `POST /invoices`: `ok`, `falha` ou `perde` (cria e responde 500). */
let modoCriacao = 'ok';
/** As notas que o gateway de mentira conhece, por id. */
const notas = new Map();
let seq = 0;
let recusarCancelamento = false;
/** Chamados (e esperados) antes de o gateway responder a criação / a autorização — a corrida com o estorno. */
let aoCriar = null;
let aoAutorizar = null;

let panelUrl;
let consoleServer;
let consoleUrl;
let donoToken;
let alfa;
let beta;
let plano;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', async () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const [caminho, query = ''] = req.url.split('?');
      recebidas.push({ method: req.method, path: caminho, query, payload });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});

      if (req.method === 'POST' && caminho === '/invoices') {
        if (modoCriacao === 'falha') return responder(500, { errors: [{ description: 'fora do ar' }] });
        seq += 1;
        const id = `inv_${seq}`;
        notas.set(id, { id, status: 'SCHEDULED', payment: payload.payment });
        if (aoCriar) await aoCriar(id);
        if (modoCriacao === 'perde') return responder(500, { errors: [{ description: 'tempo esgotado' }] });
        return responder(200, notas.get(id));
      }
      if (req.method === 'GET' && caminho === '/invoices') {
        const pagamento = new URLSearchParams(query).get('payment');
        return responder(200, { data: [...notas.values()].filter((n) => n.payment === pagamento) });
      }
      const gesto = /^\/invoices\/([^/]+)(?:\/(authorize|cancel))?$/.exec(caminho);
      if (gesto) {
        const nota = notas.get(decodeURIComponent(gesto[1]));
        if (!nota) return responder(404, {});
        if (gesto[2] === 'authorize') {
          if (aoAutorizar) await aoAutorizar(nota.id);
          return responder(200, nota);
        }
        if (gesto[2] === 'cancel') {
          if (recusarCancelamento) return responder(400, { errors: [{ description: 'prazo de cancelamento expirado' }] });
          nota.status = 'CANCELED';
          return responder(200, nota);
        }
        return responder(200, nota);
      }

      const pagamento = /^\/payments\/([^/]+)(?:\/(refund|receiveInCash))?$/.exec(caminho);
      if (pagamento) {
        const id = decodeURIComponent(pagamento[1]);
        if (req.method === 'GET') return responder(200, { id, status: id.startsWith('pay_pendente') ? 'PENDING' : 'RECEIVED', value: 100 });
        if (pagamento[2] === 'refund') return responder(200, { id, status: 'REFUNDED' });
        if (pagamento[2] === 'receiveInCash') return responder(200, { id, status: 'RECEIVED_IN_CASH' });
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
  app.use('/api/platform', platformIntegrationsRoutes);
  return new Promise((resolve) => {
    consoleServer = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${consoleServer.address().port}`);
    });
  });
}

const platform = (caminho, options = {}) => call(`${consoleUrl}/api/platform${caminho}`, {
  ...options,
  headers: { ...authHeaders(donoToken), ...(options.headers || {}) }
});

const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: corpo
});

const chamadasDeNota = () => recebidas.filter((r) => r.path.startsWith('/invoices'));
const notaDe = (tenantId, chargeId) => runInTenant(tenantId, () => BillingInvoice.forCharge(chargeId));
const processar = (tenantId, now = new Date()) => runInTenant(tenantId, () => BillingInvoiceService.processDue({ now }));

async function periodoAtual(tenantId) {
  const sub = await Subscription.forTenant(tenantId);
  return ChargeIssuingService.periodKey(new Date(sub.renews_at ?? sub.trial_ends_at));
}

async function abrirCobranca(tenantId, { gatewayChargeId = null, status = 'pending', periodEnd = null } = {}) {
  return runInTenant(tenantId, async () => {
    const id = await BillingCharge.open({
      periodEnd: periodEnd ?? await periodoAtual(tenantId),
      amountCents: 10000,
      currency: 'BRL',
      provider: 'asaas',
      dueDate: ChargeIssuingService.isoDate(Date.now() + 5 * DAY)
    });
    await BillingCharge.update(id, { status, gateway_charge_id: gatewayChargeId, issuing_until: null });
    return id;
  });
}

/** O Pix que o webhook credita — e devolve a cobrança e a resposta. */
async function pagaPeloGateway(tenantId, gatewayChargeId) {
  const periodo = await periodoAtual(tenantId);
  const id = await abrirCobranca(tenantId, { gatewayChargeId });
  const aviso = await entregar({
    event: 'PAYMENT_RECEIVED',
    payment: { id: gatewayChargeId, value: 100, externalReference: `tenant:${tenantId}:${periodo}` }
  });
  assert.equal(aviso.status, 200, JSON.stringify(aviso.body));
  return { id, aviso };
}

async function ligarNota(ligada = true) {
  await save({
    nfseEnabled: ligada,
    serviceDescription: 'Licença de uso do painel',
    municipalServiceCode: '01.07',
    municipalServiceName: 'Suporte técnico em informática',
    issPercent: 2,
    retainIss: false,
    observations: null
  });
}

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = TOKEN;

  ({ panelUrl } = await startTestServers());
  consoleUrl = await subirConsole();
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });

  const db = getDb();
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  resetDeploymentSharing();
  await db('tenants').whereIn('id', [alfa, beta])
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_qualquer' });
  plano = await Plan.create({
    code: 'nota-pro', name: 'Pro', price_cents: 10000, currency: 'BRL', period_days: 30, trial_days: 0, active: true
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
  modoCriacao = 'ok';
  recusarCancelamento = false;
  aoCriar = null;
  aoAutorizar = null;
  notas.clear();
  // O balde do webhook (30 por minuto) é do endereço, e esta suíte entrega
  // mais que isso em um minuto: cada teste começa com ele vazio.
  await billingWebhookLimiter.resetKey(ipKey({ ip: '127.0.0.1' }));
  seq = 0;
  const db = getDb();
  await db('billing_invoices').whereIn('tenant_id', [alfa, beta]).del();
  await db('billing_charges').whereIn('tenant_id', [alfa, beta]).del();
  await db('billing_events').whereIn('tenant_id', [alfa, beta]).del();
  for (const tenantId of [alfa, beta]) {
    await Subscription.upsertForTenant(tenantId, {
      plan_id: plano.id, status: 'active', renews_at: new Date(Date.now() + 10 * DAY), trial_ends_at: null,
      pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null
    });
    await SubscriptionService.invalidate(tenantId);
  }
  await ligarNota(true);
  invalidateAsaasSettings();
});

describe('a fila', () => {
  it('o pagamento pelo webhook enfileira a nota sem falar com a Asaas', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_fila');
    const nota = await notaDe(beta, id);
    assert.ok(nota);
    assert.equal(nota.status, 'pending');
    assert.equal(Number(nota.tenant_id), beta);
    assert.equal(chamadasDeNota().length, 0, 'nenhuma chamada a /invoices dentro da entrega');
  });

  it('é idempotente: a reentrega não abre outra nota', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_dupla');
    const periodo = await periodoAtual(beta);
    const segunda = await entregar({
      event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_dupla', value: 100, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(segunda.body.code, 'duplicate');
    const linhas = await getDb()('billing_invoices').where({ charge_id: id });
    assert.equal(linhas.length, 1);
    assert.deepEqual(await runInTenant(beta, () => BillingInvoiceService.enqueueForCharge({ id, gateway_charge_id: 'pay_dupla' })),
      { enqueued: false, reason: 'exists' });
  });

  it('com a nota desligada, nada acontece', async () => {
    await ligarNota(false);
    const { id } = await pagaPeloGateway(beta, 'pay_desligada');
    assert.equal(await notaDe(beta, id), null);
    // E uma linha pendente de antes também espera: a passada não pede nada.
    await runInTenant(beta, () => BillingInvoice.enqueue(id));
    await processar(beta);
    assert.equal(chamadasDeNota().length, 0);
    assert.equal((await notaDe(beta, id)).status, 'pending');
  });

  it('a baixa do console enfileira só a cobrança que tem pagamento no gateway', async () => {
    const doGateway = await abrirCobranca(beta, { gatewayChargeId: 'pay_pendente_baixa' });
    const res = await platform(`/tenants/${beta}/charges/${doGateway}/settle`, {
      method: 'POST', body: { paidAt: ChargeIssuingService.isoDate(new Date()), amountCents: 10000 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge.invoice.status, 'pending');
    assert.equal(chamadasDeNota().length, 0);

    // Sem id no gateway: baixa por fora, sem nota.
    const anterior = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10);
    const local = await abrirCobranca(beta, { periodEnd: anterior });
    const baixa = await platform(`/tenants/${beta}/charges/${local}/settle`, {
      method: 'POST', body: { paidAt: ChargeIssuingService.isoDate(new Date()), amountCents: 10000 }
    });
    assert.equal(baixa.status, 200, JSON.stringify(baixa.body));
    assert.equal(await notaDe(beta, local), null);
    assert.equal(baixa.body.data.charge.invoice, null);
  });
});

describe('a passada do agendador', () => {
  it('cria, autoriza e depois consulta até a nota sair', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_emite');
    const resumo = await processar(beta);
    assert.equal(resumo.issued, 1);
    // Pergunta SEMPRE antes de criar, mesmo na primeira tentativa.
    assert.deepEqual(chamadasDeNota().map((r) => `${r.method} ${r.path}`), [
      'GET /invoices', 'POST /invoices', 'POST /invoices/inv_1/authorize'
    ]);
    const corpo = chamadasDeNota().find((r) => r.method === 'POST' && r.path === '/invoices').payload;
    assert.equal(corpo.effectiveDate, effectiveDateOf(new Date()));
    assert.equal(corpo.payment, 'pay_emite');
    assert.equal(corpo.value, 100, 'em reais');
    assert.equal(corpo.serviceDescription, 'Licença de uso do painel');
    assert.equal(corpo.municipalServiceCode, '01.07');
    assert.equal(corpo.taxes.iss, 2);
    assert.equal(corpo.taxes.retainIss, false);

    let nota = await notaDe(beta, id);
    assert.equal(nota.status, 'scheduled');
    assert.equal(nota.external_id, 'inv_1');
    assert.equal(Number(nota.attempts), 1);

    // A próxima passada imediata não consulta: espera o intervalo.
    recebidas = [];
    await processar(beta);
    assert.equal(chamadasDeNota().length, 0);

    Object.assign(notas.get('inv_1'), {
      status: 'AUTHORIZED', number: '2026/123', pdfUrl: 'https://asaas.test/nota.pdf', xmlUrl: 'https://asaas.test/nota.xml'
    });
    const resumo2 = await processar(beta, new Date(Date.now() + 11 * 60 * 1000));
    assert.equal(resumo2.polled, 1);
    nota = await notaDe(beta, id);
    assert.equal(nota.status, 'authorized');
    assert.equal(nota.number, '2026/123');
    assert.equal(nota.pdf_url, 'https://asaas.test/nota.pdf');
    assert.ok(nota.issued_at);
  });

  it('falhou: espera crescente, e a nova tentativa não cria a segunda nota da resposta perdida', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_falha');
    modoCriacao = 'perde';
    const antes = Date.now();
    const resumo = await processar(beta);
    assert.equal(resumo.failed, 1);
    let nota = await notaDe(beta, id);
    assert.equal(nota.status, 'pending');
    assert.equal(Number(nota.attempts), 1);
    assert.equal(nota.external_id, null);
    assert.match(nota.error, /500/);
    const espera = new Date(nota.next_attempt_at).getTime();
    assert.ok(espera >= Math.floor((antes + backoffMs(1)) / 1000) * 1000 - 1000, 'espera a primeira janela');

    // Antes da janela, nada.
    recebidas = [];
    modoCriacao = 'ok';
    await processar(beta);
    assert.equal(chamadasDeNota().length, 0);

    // Depois dela: pergunta antes de criar, e adota a nota que a resposta perdida criou.
    await processar(beta, new Date(espera + 1000));
    assert.deepEqual(chamadasDeNota().map((r) => `${r.method} ${r.path}`), [
      'GET /invoices', 'POST /invoices/inv_1/authorize'
    ]);
    nota = await notaDe(beta, id);
    assert.equal(nota.external_id, 'inv_1');
    assert.equal(nota.status, 'scheduled');
    assert.equal(notas.size, 1, 'uma nota só no gateway');
  });

  it('a nota de uma cobrança estornada antes da passada não é emitida', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_volta');
    await runInTenant(beta, () => BillingCharge.update(id, { status: 'refunded' }));
    await processar(beta);
    assert.equal(chamadasDeNota().length, 0);
    assert.equal((await notaDe(beta, id)).status, 'canceled');
  });
});

describe('o webhook da nota', () => {
  it('INVOICE_AUTHORIZED grava número e PDF; nota desconhecida é ignorada', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_wh');
    await processar(beta);
    const res = await entregar({
      event: 'INVOICE_AUTHORIZED',
      invoice: {
        id: 'inv_1', status: 'AUTHORIZED', payment: 'pay_wh', number: '77', pdfUrl: 'https://asaas.test/77.pdf', xmlUrl: 'https://asaas.test/77.xml'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'invoice_updated');
    const nota = await notaDe(beta, id);
    assert.equal(nota.status, 'authorized');
    assert.equal(nota.number, '77');
    assert.equal(nota.pdf_url, 'https://asaas.test/77.pdf');

    const estranha = await entregar({ event: 'INVOICE_AUTHORIZED', invoice: { id: 'inv_de_ninguem', status: 'AUTHORIZED' } });
    assert.equal(estranha.status, 200);
    assert.equal(estranha.body.code, 'unknown_invoice');

    // Fora de ordem: um SCHEDULED atrasado não desfaz a autorizada.
    const atrasada = await entregar({ event: 'INVOICE_UPDATED', invoice: { id: 'inv_1', status: 'SCHEDULED', payment: 'pay_wh' } });
    assert.equal(atrasada.status, 200);
    assert.equal((await notaDe(beta, id)).status, 'authorized');
  });

  it('INVOICE_ERROR guarda o motivo', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_erro');
    await processar(beta);
    await entregar({
      event: 'INVOICE_ERROR', invoice: { id: 'inv_1', status: 'ERROR', payment: 'pay_erro', statusDescription: 'Código de serviço inválido' }
    });
    const nota = await notaDe(beta, id);
    assert.equal(nota.status, 'error');
    assert.equal(nota.error, 'Código de serviço inválido');
  });
});

describe('o estorno', () => {
  it('pelo console cancela a nota emitida', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_estorno');
    await processar(beta);
    recebidas = [];
    const res = await platform(`/tenants/${beta}/charges/${id}/refund`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(chamadasDeNota().some((r) => r.method === 'POST' && r.path === '/invoices/inv_1/cancel'));
    assert.equal((await notaDe(beta, id)).status, 'canceled');
    assert.equal(res.body.data.charge.invoice.status, 'canceled');
  });

  it('a recusa do cancelamento não bloqueia o estorno', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_nao_cancela');
    await processar(beta);
    recusarCancelamento = true;
    const res = await platform(`/tenants/${beta}/charges/${id}/refund`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await runInTenant(beta, () => BillingCharge.findById(id))).status, 'refunded');
    let nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceling', 'fica pedindo o cancelamento');
    assert.match(nota.error, /Cancellation failed/);
    assert.equal(nota.external_id, 'inv_1');
    const espera = new Date(nota.next_attempt_at).getTime();
    assert.ok(espera > Date.now(), 'com espera');

    // O agendador insiste — antes da espera, nada; depois dela, cancela.
    recebidas = [];
    await processar(beta);
    assert.equal(chamadasDeNota().filter((r) => r.path.endsWith('/cancel')).length, 0);
    recusarCancelamento = false;
    const resumo = await processar(beta, new Date(espera + 1000));
    assert.equal(resumo.canceled, 1);
    assert.ok(chamadasDeNota().some((r) => r.method === 'POST' && r.path === '/invoices/inv_1/cancel'));
    nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceled');
    assert.equal(nota.next_attempt_at, null);
    assert.equal(notas.get('inv_1').status, 'CANCELED');
  });

  it('pelo gateway (PAYMENT_REFUNDED) também cancela, fora da entrega', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_estorno_wh');
    await processar(beta);
    const periodo = await periodoAtual(beta);
    const res = await entregar({
      event: 'PAYMENT_REFUNDED',
      payment: { id: 'pay_estorno_wh', value: 100, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(res.status, 200);
    await BillingWebhookController.pendingInvoiceWork;
    assert.equal((await notaDe(beta, id)).status, 'canceled');
  });
});

describe('o console', () => {
  it('reemite a nota com erro, recusa a viva e não alcança a cobrança do vizinho', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_reemite');
    await processar(beta);
    notas.get('inv_1').status = 'ERROR';
    await entregar({ event: 'INVOICE_ERROR', invoice: { id: 'inv_1', status: 'ERROR', payment: 'pay_reemite' } });

    const res = await platform(`/tenants/${beta}/charges/${id}/invoice`, { method: 'POST' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.data.invoice.status, 'pending');
    let nota = await notaDe(beta, id);
    assert.equal(nota.status, 'pending');
    assert.equal(nota.external_id, null);
    assert.equal(Number(nota.attempts), 0);
    assert.equal((await getDb()('billing_invoices').where({ charge_id: id })).length, 1);
    assert.ok(await getDb()('platform_audit').where({ action: 'charge.invoice_requested', tenant_id: beta }).first());

    // A fila leva adiante: uma nota nova no gateway.
    await processar(beta);
    nota = await notaDe(beta, id);
    assert.equal(nota.external_id, 'inv_2');

    const viva = await platform(`/tenants/${beta}/charges/${id}/invoice`, { method: 'POST' });
    assert.equal(viva.status, 409);
    assert.equal(viva.body.code, 'invoice_exists');

    // A cobrança de beta pela URL de alfa: não existe ali.
    const vizinho = await platform(`/tenants/${alfa}/charges/${id}/invoice`, { method: 'POST' });
    assert.equal(vizinho.status, 404);
  });

  it('recusa a cobrança em aberto, a baixa sem gateway e a nota desligada', async () => {
    const aberta = await abrirCobranca(beta, { gatewayChargeId: 'pay_aberta' });
    const r1 = await platform(`/tenants/${beta}/charges/${aberta}/invoice`, { method: 'POST' });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.code, 'not_paid');

    const anterior = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10);
    const local = await abrirCobranca(beta, { status: 'paid', periodEnd: anterior });
    const r2 = await platform(`/tenants/${beta}/charges/${local}/invoice`, { method: 'POST' });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.code, 'no_gateway_payment');

    await ligarNota(false);
    await runInTenant(beta, () => BillingCharge.update(aberta, { status: 'paid' }));
    const r3 = await platform(`/tenants/${beta}/charges/${aberta}/invoice`, { method: 'POST' });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.code, 'nfse_disabled');
  });

  it('a lista de cobranças e o extrato trazem a nota', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_lista');
    await processar(beta);
    await entregar({
      event: 'INVOICE_AUTHORIZED',
      invoice: { id: 'inv_1', status: 'AUTHORIZED', payment: 'pay_lista', number: '9', pdfUrl: 'https://asaas.test/9.pdf' }
    });
    const lista = await platform(`/tenants/${beta}/charges`);
    assert.equal(lista.status, 200);
    const linha = lista.body.data.charges.find((c) => c.id === id);
    assert.deepEqual(
      { status: linha.invoice.status, number: linha.invoice.number, pdfUrl: linha.invoice.pdfUrl, error: linha.invoice.error },
      { status: 'authorized', number: '9', pdfUrl: 'https://asaas.test/9.pdf', error: null }
    );

    const extrato = await platform(`/tenants/${beta}/subscription`);
    assert.equal(extrato.status, 200);
    const pagamento = extrato.body.data.events.find((e) => e.type === 'payment.recorded');
    assert.equal(pagamento.chargeId, id);
    assert.equal(pagamento.invoice.number, '9');
  });

  it('valida a configuração da nota na gravação', async () => {
    const res = await platform('/integrations/asaas', {
      method: 'PUT', body: { nfseEnabled: true, serviceDescription: '', municipalServiceCode: '01.07' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_nfse');
    const iss = await platform('/integrations/asaas', { method: 'PUT', body: { issPercent: 120 } });
    assert.equal(iss.status, 400);
    const ok = await platform('/integrations/asaas', {
      method: 'PUT', body: { nfseEnabled: true, serviceDescription: 'Serviço', municipalServiceId: '123', issPercent: '3.5' }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.nfseEnabled, true);
    assert.equal(ok.body.data.municipalServiceId, '123');
    assert.equal(ok.body.data.issPercent, 3.5);
    // O que não veio fica como estava.
    assert.equal(ok.body.data.municipalServiceCode, '01.07');
  });
});

describe('o provedor', () => {
  it('vê a nota das próprias cobranças, sem o erro e só com link quando emitida', async () => {
    const { id } = await pagaPeloGateway(alfa, 'pay_do_alfa');
    await processar(alfa);
    const vizinha = await pagaPeloGateway(beta, 'pay_do_beta');
    await processar(beta);
    await entregar({
      event: 'INVOICE_AUTHORIZED',
      invoice: { id: 'inv_1', status: 'AUTHORIZED', payment: 'pay_do_alfa', number: '1', pdfUrl: 'https://asaas.test/1.pdf' }
    });
    const res = await call(`${panelUrl}/api/tenant/charges`, { headers: authHeaders(donoToken) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.data.charges.map((c) => c.id);
    assert.ok(ids.includes(id));
    assert.equal(ids.includes(vizinha.id), false, 'a cobrança do vizinho não aparece');
    const minha = res.body.data.charges.find((c) => c.id === id);
    assert.deepEqual(minha.invoice, {
      status: 'authorized', number: '1', pdfUrl: 'https://asaas.test/1.pdf', xmlUrl: null, issuedAt: minha.invoice.issuedAt
    });
    assert.ok(minha.invoice.issuedAt);
    assert.equal('error' in minha.invoice, false);
  });
});

describe('nota duplicada, corrida com o estorno, valor e endereços', () => {
  it('pergunta à Asaas antes de criar mesmo na primeira tentativa, e adota a viva', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_ja_tem');
    notas.set('inv_98', { id: 'inv_98', status: 'CANCELED', payment: 'pay_ja_tem' });
    notas.set('inv_99', {
      id: 'inv_99', status: 'AUTHORIZED', payment: 'pay_ja_tem', number: '5', pdfUrl: 'https://asaas.test/5.pdf'
    });
    const resumo = await processar(beta);
    assert.equal(resumo.issued, 1);
    // A cancelada não serve; a autorizada é adotada — sem criar, sem autorizar de novo.
    assert.deepEqual(chamadasDeNota().map((r) => `${r.method} ${r.path}`), ['GET /invoices']);
    const nota = await notaDe(beta, id);
    assert.equal(nota.external_id, 'inv_99');
    assert.equal(nota.status, 'authorized');
    assert.equal(nota.number, '5');
    assert.equal(notas.size, 2);
  });

  it('a reemissão adota a nota que a Asaas ainda tem viva, em vez de pedir outra', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_viva');
    await processar(beta);
    // O painel viu erro; a Asaas, depois de corrigida lá, autorizou.
    await entregar({ event: 'INVOICE_ERROR', invoice: { id: 'inv_1', status: 'ERROR', payment: 'pay_viva' } });
    Object.assign(notas.get('inv_1'), { status: 'AUTHORIZED', number: '31', pdfUrl: 'https://asaas.test/31.pdf' });
    recebidas = [];
    const res = await platform(`/tenants/${beta}/charges/${id}/invoice`, { method: 'POST' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'invoice_exists');
    assert.equal(res.body.adopted, true);
    assert.equal(res.body.invoiceStatus, 'authorized');
    assert.deepEqual(chamadasDeNota().map((r) => `${r.method} ${r.path}`), ['GET /invoices/inv_1']);
    const nota = await notaDe(beta, id);
    assert.equal(nota.status, 'authorized');
    assert.equal(nota.external_id, 'inv_1');
    assert.equal(nota.number, '31');
    assert.equal(nota.error, null);
    assert.ok(nota.issued_at);

    // E a passada seguinte não cria nada.
    recebidas = [];
    await processar(beta, new Date(Date.now() + 60 * 60 * 1000));
    assert.equal(chamadasDeNota().filter((r) => r.method === 'POST').length, 0);
    assert.equal(notas.size, 1);
  });

  it('o estorno no meio da criação: a passada não grava por cima e cancela a nota que criou', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_corrida');
    aoCriar = async () => {
      aoCriar = null;
      await runInTenant(beta, async () => {
        await BillingCharge.update(id, { status: 'refunded' });
        assert.deepEqual(await BillingInvoiceService.cancelForCharge(id), { canceled: true, reason: 'not_issued' });
      });
    };
    const resumo = await processar(beta);
    assert.equal(resumo.issued, 0);
    assert.deepEqual(chamadasDeNota().map((r) => `${r.method} ${r.path}`), [
      'GET /invoices', 'POST /invoices', 'POST /invoices/inv_1/cancel'
    ]);
    const nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceled');
    assert.equal(nota.external_id, 'inv_1');
    assert.equal(notas.get('inv_1').status, 'CANCELED');
  });

  it('o estorno no meio da autorização: cancela na Asaas e a passada respeita', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_corrida_2');
    aoAutorizar = async () => {
      aoAutorizar = null;
      await runInTenant(beta, async () => {
        await BillingCharge.update(id, { status: 'refunded' });
        assert.deepEqual(await BillingInvoiceService.cancelForCharge(id), { canceled: true });
      });
    };
    await processar(beta);
    const nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceled', 'a passada não devolveu a linha a agendada');
    assert.equal(nota.external_id, 'inv_1');
    assert.equal(notas.get('inv_1').status, 'CANCELED');
  });

  it('a nota com erro e id na Asaas é cancelada lá no estorno', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_erro_estorno');
    await processar(beta);
    await entregar({ event: 'INVOICE_ERROR', invoice: { id: 'inv_1', status: 'ERROR', payment: 'pay_erro_estorno' } });
    recebidas = [];
    const res = await platform(`/tenants/${beta}/charges/${id}/refund`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(chamadasDeNota().some((r) => r.method === 'POST' && r.path === '/invoices/inv_1/cancel'));
    assert.equal((await notaDe(beta, id)).status, 'canceled');
  });

  it('a passada que acha a cobrança estornada com nota na Asaas a cancela lá — e insiste se falhar', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_pend_com_id');
    await processar(beta);
    // A autorização falhou: pendente, com o id gravado. E o dinheiro voltou por fora.
    await runInTenant(beta, async () => {
      const linha = await BillingInvoice.forCharge(id);
      await BillingInvoice.update(linha.id, { status: 'pending', next_attempt_at: null });
      await BillingCharge.update(id, { status: 'refunded' });
    });
    recusarCancelamento = true;
    recebidas = [];
    await processar(beta);
    assert.deepEqual(chamadasDeNota().map((r) => `${r.method} ${r.path}`), [
      'POST /invoices/inv_1/cancel', 'GET /invoices/inv_1'
    ]);
    let nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceling');
    assert.equal(Number(nota.attempts), 1);

    recusarCancelamento = false;
    await processar(beta, new Date(new Date(nota.next_attempt_at).getTime() + 1000));
    nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceled');
    assert.equal(notas.get('inv_1').status, 'CANCELED');
  });

  it('o cancelamento que falha mas a Asaas já tem a nota morta fica cancelado', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_ja_morta');
    await processar(beta);
    notas.get('inv_1').status = 'CANCELED';
    recusarCancelamento = true;
    const resultado = await runInTenant(beta, () => BillingInvoiceService.cancelForCharge(id));
    assert.deepEqual(resultado, { canceled: true, reason: 'already_dead_at_gateway' });
    assert.equal((await notaDe(beta, id)).status, 'canceled');
  });

  it('a baixa que aceita um pagamento a menos enfileira a nota, do valor que entrou', async () => {
    const periodo = await periodoAtual(beta);
    const id = await abrirCobranca(beta, { gatewayChargeId: 'pay_curto' });
    const aviso = await entregar({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_curto', value: 60, externalReference: `tenant:${beta}:${periodo}` }
    });
    assert.equal(aviso.body.code, 'underpaid', JSON.stringify(aviso.body));
    assert.equal(await notaDe(beta, id), null, 'a cobrança não está paga: sem nota');

    const res = await platform(`/tenants/${beta}/charges/${id}/settle`, {
      method: 'POST', body: { paidAt: ChargeIssuingService.isoDate(new Date()), amountCents: 6000, allowUnderpayment: true }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.acceptedUnderpayment, true);
    assert.equal((await notaDe(beta, id)).status, 'pending');

    await processar(beta);
    const corpo = chamadasDeNota().find((r) => r.method === 'POST' && r.path === '/invoices').payload;
    assert.equal(corpo.value, 60, 'o que entrou, não os 100 da cobrança');
  });

  it('o corpo da nota: valor recebido e a data de competência em São Paulo', () => {
    const config = { serviceDescription: 'x', issPercent: 2 };
    const charge = { id: 7, gateway_charge_id: 'pay_x', amount_cents: 10000, period_end: '2026-10-10' };
    // 01:30 UTC do dia 4 ainda é dia 3 em São Paulo.
    const tarde = new Date('2026-10-04T01:30:00Z');
    assert.equal(effectiveDateOf(tarde), '2026-10-03');
    assert.equal(effectiveDateOf(new Date('2026-10-04T03:30:00Z')), '2026-10-04');
    assert.equal(invoicePayload(config, charge, tarde).effectiveDate, '2026-10-03');
    assert.equal(invoicePayload(config, charge, tarde).valueCents, 10000);
    assert.equal(invoicePayload(config, charge, tarde, 6000).valueCents, 6000);
  });

  it('só guarda e só mostra endereço https da nota', async () => {
    assert.equal(safeInvoiceUrl('https://asaas.test/a.pdf'), 'https://asaas.test/a.pdf');
    assert.equal(safeInvoiceUrl('http://asaas.test/a.pdf'), null);
    assert.equal(safeInvoiceUrl('javascript:alert(1)'), null);
    assert.equal(safeInvoiceUrl('  '), null);
    assert.equal(safeInvoiceUrl('não é url'), null);

    const { id } = await pagaPeloGateway(beta, 'pay_url');
    await processar(beta);
    await entregar({
      event: 'INVOICE_AUTHORIZED',
      invoice: {
        id: 'inv_1', status: 'AUTHORIZED', payment: 'pay_url', number: '8',
        pdfUrl: 'javascript:alert(document.cookie)', xmlUrl: 'http://asaas.test/8.xml'
      }
    });
    const nota = await notaDe(beta, id);
    assert.equal(nota.status, 'authorized');
    assert.equal(nota.pdf_url, null);
    assert.equal(nota.xml_url, null);

    // Uma linha gravada antes da regra também não sai com o link.
    await runInTenant(beta, () => BillingInvoice.update(nota.id, { pdf_url: 'javascript:alert(1)' }));
    const lida = await notaDe(beta, id);
    assert.equal(BillingInvoice.present(lida).pdfUrl, null);
    assert.equal(BillingInvoice.presentForConsole(lida).pdfUrl, null);
  });

  it('desiste do cancelamento depois do teto: erro com o recado, e a reemissão não cria outra nota', async () => {
    const { id } = await pagaPeloGateway(beta, 'pay_teimosa');
    await processar(beta);
    recusarCancelamento = true;
    const res = await platform(`/tenants/${beta}/charges/${id}/refund`, { method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let nota = await notaDe(beta, id);
    assert.equal(nota.status, 'canceling');
    assert.equal(Number(nota.attempts), 1);

    // O agendador insiste até o teto, cada vez depois da espera.
    for (let i = 2; i <= MAX_CANCEL_ATTEMPTS; i += 1) {
      await processar(beta, new Date(new Date(nota.next_attempt_at).getTime() + 1000));
      nota = await notaDe(beta, id);
      assert.equal(Number(nota.attempts), i);
    }
    assert.equal(nota.status, 'error');
    assert.equal(nota.next_attempt_at, null);
    assert.match(nota.error, /cancele manualmente no painel do Asaas/);
    assert.match(nota.error, /prazo de cancelamento expirado/);
    assert.equal(notas.get('inv_1').status, 'SCHEDULED', 'continua viva lá: é o que o recado pede');

    // Parou: a passada seguinte não pede mais nada.
    recebidas = [];
    await processar(beta, new Date(Date.now() + 2 * DAY));
    assert.equal(chamadasDeNota().length, 0);

    // O console vê o recado na nota da cobrança.
    const lista = await platform(`/tenants/${beta}/charges`);
    const linha = lista.body.data.charges.find((c) => c.id === id);
    assert.equal(linha.invoice.status, 'error');
    assert.match(linha.invoice.error, /cancele manualmente/);

    // A reemissão recusa: a cobrança estornada não está paga.
    recebidas = [];
    const reemite = await platform(`/tenants/${beta}/charges/${id}/invoice`, { method: 'POST' });
    assert.equal(reemite.status, 409);
    assert.equal(reemite.body.code, 'not_paid');
    assert.equal(chamadasDeNota().length, 0);
    assert.equal(notas.size, 1);
  });
});
