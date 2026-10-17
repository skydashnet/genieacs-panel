import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SelfBillingService } = await import('../src/services/selfBillingService.js');
const { ensureAsaasCustomer } = await import('../src/services/billing/asaasCustomerService.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');

/**
 * O provedor cuidando da própria conta: a lista de planos com preço, a troca
 * de plano e o "pagar agora".
 *
 * Self-hosted, pelo motivo de `asaas-gateway-lifecycle.test.js`: só fora da
 * SaaS o cliente do gateway aceita `127.0.0.1`, e o valor deste arquivo está
 * em asserir as requisições que SAEM — o DELETE da cobrança velha antes do
 * POST da nova, o cliente criado antes da primeira cobrança, e a ausência de
 * uma segunda cobrança no segundo clique. A porta da assinatura, que só existe
 * na SaaS, é conferida em `tenant-charges.test.js`.
 *
 * As três coisas que não podem dar errado:
 *
 * 1. **Duas faturas do mesmo mês.** Trocar de plano com uma cobrança emitida
 *    tem que cancelar a velha no gateway antes de a nova sair — e, se o
 *    cancelamento falha, o plano não muda.
 * 2. **Um segundo clique virar uma segunda cobrança** (ou um segundo cliente
 *    no gateway).
 * 3. **Quem não pode, poder**: o `viewer`, o suspenso, o plano fora de linha,
 *    o uso que não cabe.
 */
const CHAVE = 'chave-do-autoatendimento';

let gateway;
let recebidas = [];
let proximoId = 0;
/** Chamado pelo gateway de mentira antes de responder — é por ele que se encena uma corrida. */
let aoReceber = null;
/** Quando verdadeiro, o gateway de mentira recusa todo cancelamento (500). */
let recusarCancelamento = false;
let panelUrl;
let alfa;
let donoToken;
let viewerToken;
const planos = {};

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', async () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      recebidas.push({ method: req.method, path: caminho, payload });
      if (aoReceber) await aoReceber(req.method, caminho, payload);
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'POST' && caminho === '/customers') {
        return responder(200, { id: 'cus_autoatendido', name: payload?.name });
      }
      if (req.method === 'POST' && caminho === '/payments') {
        if (payload?.value === 999.99) {
          return responder(400, { errors: [{ description: 'valor recusado pelo gateway' }] });
        }
        proximoId += 1;
        const id = `pay_auto_${proximoId}`;
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      if (req.method === 'DELETE' && caminho.startsWith('/payments/')) {
        const id = decodeURIComponent(caminho.slice('/payments/'.length));
        if (recusarCancelamento) return responder(500, { errors: [{ description: 'cancelamento recusado' }] });
        if (id === 'pay_que_nao_cancela') return responder(500, { errors: [{ description: 'fora do ar' }] });
        if (id === 'pay_que_sumiu') return responder(404, {});
        return responder(200, { deleted: true, id });
      }
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

const CADASTRO = {
  billing_legal_name: 'Alfa Telecom Ltda',
  billing_tax_id: '12345678000195',
  billing_email: 'financeiro@alfa.test',
  billing_postal_code: '01310100',
  billing_address_line: 'Av. Paulista',
  billing_address_number: '1000',
  billing_district: 'Bela Vista'
};

before(async () => {
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;

  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  donoToken = setup.body.data.token;
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

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

  const criar = (row) => Plan.create({ currency: 'BRL', period_days: 30, trial_days: 0, active: true, ...row });
  planos.basico = await criar({ code: 'auto-basico', name: 'Básico', price_cents: 9990, max_operators: 5 });
  planos.pro = await criar({ code: 'auto-pro', name: 'Pro', price_cents: 19990 });
  planos.mini = await criar({ code: 'auto-mini', name: 'Mini', price_cents: 4990, max_operators: 1 });
  planos.antigo = await criar({ code: 'auto-antigo', name: 'Antigo', price_cents: 5000, active: false });
  planos.extinto = await criar({ code: 'auto-extinto', name: 'Extinto', price_cents: 7000, active: false });
  planos.gratis = await criar({ code: 'auto-gratis', name: 'Grátis', price_cents: 0 });
  planos.recusado = await criar({ code: 'auto-recusado', name: 'Recusado', price_cents: 99999 });
  planos.leve = await criar({ code: 'auto-leve', name: 'Leve', price_cents: 6990 });
  planos.gemeo = await criar({ code: 'auto-gemeo', name: 'Gêmeo', price_cents: 9990 });
  // Duas pessoas cabem — a dona e quem só olha — até o teto baixar no teste.
  planos.poucas = await criar({ code: 'auto-poucas', name: 'Poucas', price_cents: 5990, max_devices: 10 });
  planos.enxuto = await criar({ code: 'auto-enxuto', name: 'Enxuto', price_cents: 4990, max_operators: 2 });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

/**
 * Um instante relativo a agora, sem milissegundos: o `TIMESTAMP` do MySQL
 * guarda segundos, e as comparações exatas de data abaixo (a da descida
 * agendada, a do período estendido) não podem depender do banco.
 */
const daquiA = (dias) => {
  const quando = new Date(Date.now() + dias * 86_400_000);
  quando.setMilliseconds(0);
  return quando;
};

async function assinar({ plan = planos.basico, status = 'active', renewsAt = daquiA(2), trialEndsAt = null } = {}) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: plan.id,
    status,
    renews_at: renewsAt,
    trial_ends_at: trialEndsAt,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null
  });
  await SubscriptionService.invalidate(alfa);
}

const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');

const pedir = (caminho, { method = 'GET', body, token = donoToken } = {}) => call(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(token), ...(body === undefined ? {} : { body })
});
const trocar = (planId, token) => pedir('/subscription/plan', { method: 'PUT', body: { planId }, token });
const pagar = (token) => pedir('/charges/pay', { method: 'POST', token });

beforeEach(async () => {
  recebidas = [];
  aoReceber = null;
  recusarCancelamento = false;
  await getDb()('billing_charges').where({ tenant_id: alfa }).del();
  await getDb()('tenants').where({ id: alfa })
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa', ...CADASTRO });
  await assinar();
});

describe('a lista de planos', () => {
  it('traz os ativos com preço, e o atual mesmo fora de linha', async () => {
    await assinar({ plan: planos.antigo });
    const res = await pedir('/plans');
    assert.equal(res.status, 200);
    const lista = res.body.data;
    assert.ok(Array.isArray(lista));

    const codigos = lista.map((p) => p.code);
    assert.ok(codigos.includes('auto-basico'));
    assert.ok(codigos.includes('auto-antigo'), 'o plano atual fica na lista mesmo inativo');
    assert.equal(codigos.includes('auto-extinto'), false, 'inativo que não é o atual não aparece');
    assert.equal(codigos.includes('auto-gratis'), false, 'plano de graça não é escolha do provedor');
    assert.equal(codigos.includes('unlimited'), false, 'nem o `unlimited` que a 0035 semeia');

    const antigo = lista.find((p) => p.code === 'auto-antigo');
    assert.equal(antigo.current, true);
    const { proration: previa, overagePriceCents: excedente, ...basico } = lista.find((p) => p.code === 'auto-basico');
    // Sem preço de excedente (0105): o teto barra, como sempre.
    assert.deepEqual(excedente, { operators: null, subscribers: null, devices: null });
    // Do Antigo (R$ 50,00) ao Básico com dois dias por correr: a diferença
    // proporcional não chega ao mínimo, e a prévia diz isso (0101).
    assert.equal(previa.skipped, 'below_minimum');
    assert.equal(previa.amountCents, 0);
    assert.equal(previa.remainingDays, 2);
    assert.equal(lista.find((p) => p.code === 'auto-antigo').proration, null, 'o atual não tem prévia');
    assert.deepEqual(basico, {
      id: planos.basico.id,
      code: 'auto-basico',
      name: 'Básico',
      priceCents: 9990,
      currency: 'BRL',
      periodDays: 30,
      // Sem preço anual, sem ciclo anual (0104).
      priceYearlyCents: null,
      annualAvailable: false,
      annualSavingsPercent: null,
      limits: { operators: 5, subscribers: null, devices: null },
      current: false
    });
    assert.equal(lista.filter((p) => p.current).length, 1);
  });

  it('mas o de graça em que o provedor JÁ está aparece, como o dele', async () => {
    const unlimited = await Plan.findByCode('unlimited');
    assert.ok(unlimited, 'a 0035 semeia o unlimited');
    await assinar({ plan: unlimited });
    const lista = (await pedir('/plans')).body.data;
    const dele = lista.find((p) => p.code === 'unlimited');
    assert.ok(dele);
    assert.equal(dele.current, true);
    assert.equal(dele.priceCents, 0);
    assert.equal(lista.some((p) => p.code === 'auto-gratis'), false);
  });

  it('e o viewer não lê', async () => {
    assert.equal((await pedir('/plans', { token: viewerToken })).status, 403);
  });
});

describe('a troca de plano', () => {
  it('troca na hora, devolve a tela de assinatura e grava as duas trilhas', async () => {
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.subscription.plan.code, 'auto-pro');
    assert.equal(res.body.data.subscription.status, 'active', 'trocar de plano não é pagamento');
    assert.ok(res.body.data.usage, 'o mesmo corpo de GET /subscription');
    assert.ok('billing' in res.body.data);

    const linha = await Subscription.forTenant(alfa);
    assert.equal(linha.plan_id, planos.pro.id);

    const dele = await getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'subscription.changed' }).orderBy('id', 'desc').first();
    assert.ok(dele, 'a trilha do provedor');
    const detalhe = JSON.parse(dele.detail);
    assert.equal(detalhe.from, planos.basico.id);
    assert.equal(detalhe.to, planos.pro.id);
    assert.equal(detalhe.selfService, true);
    assert.equal(dele.actor_kind, 'operator');

    const nossa = await getDb()('platform_audit')
      .where({ tenant_id: alfa, action: 'subscription.plan_changed' }).orderBy('id', 'desc').first();
    assert.ok(nossa, 'e a da plataforma');
    assert.equal(JSON.parse(nossa.detail).selfService, true);
  });

  it('o mesmo plano é 200 e não muda nada', async () => {
    const antes = await getDb()('billing_events').where({ tenant_id: alfa }).count({ n: '*' }).first();
    const res = await trocar(planos.basico.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscription.plan.code, 'auto-basico');
    const depois = await getDb()('billing_events').where({ tenant_id: alfa }).count({ n: '*' }).first();
    assert.equal(Number(depois.n), Number(antes.n), 'nenhum evento de troca no extrato');
  });

  it('409 over_limit quando o uso não cabe, com o recurso e os números', async () => {
    // A dona e quem só olha: duas pessoas, e o mini aceita uma. Em atraso,
    // porque é a descida que vale NA HORA que confere o uso — a agendada
    // confere na renovação (ver "a descida agendada").
    await assinar({ status: 'past_due', renewsAt: daquiA(-3) });
    const res = await trocar(planos.mini.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'over_limit');
    assert.equal(res.body.resource, 'operators');
    assert.equal(res.body.used, 2);
    assert.equal(res.body.limit, 1);
    assert.equal((await Subscription.forTenant(alfa)).plan_id, planos.basico.id);
  });

  it('409 not_changeable para suspenso e cancelado', async () => {
    for (const status of ['suspended', 'canceled']) {
      await assinar({ status });
      const res = await trocar(planos.pro.id);
      assert.equal(res.status, 409, status);
      assert.equal(res.body.code, 'not_changeable');
      assert.equal((await Subscription.forTenant(alfa)).plan_id, planos.basico.id);
    }
  });

  it('mas past_due troca — descer de plano é uma das saídas de quem deve', async () => {
    await assinar({ status: 'past_due', renewsAt: daquiA(-3) });
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('404 plan_not_found para plano inativo, de graça ou que não existe', async () => {
    const unlimited = await Plan.findByCode('unlimited');
    for (const planId of [planos.extinto.id, planos.gratis.id, unlimited.id, 999999, 'abc']) {
      const res = await trocar(planId);
      assert.equal(res.status, 404, String(planId));
      assert.equal(res.body.code, 'plan_not_found');
    }
  });

  it('403 para o viewer', async () => {
    assert.equal((await trocar(planos.pro.id, viewerToken)).status, 403);
    assert.equal((await Subscription.forTenant(alfa)).plan_id, planos.basico.id);
  });
});

describe('a cobrança em aberto na troca de plano', () => {
  it('cancela a emitida no gateway e reemite com o preço novo', async () => {
    const primeira = await pagar();
    assert.equal(primeira.status, 201, JSON.stringify(primeira.body));
    const [velha] = await cobrancas();
    assert.equal(velha.amount_cents, 9990);
    const idVelho = velha.gateway_charge_id;
    recebidas = [];

    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
      `DELETE /payments/${idVelho}`,
      'POST /payments',
      'POST /payments'
    ], 'a velha sai antes de a nova entrar — e depois, a pró-rata da subida (0101)');
    assert.equal(recebidas[1].payload.value, 199.9);
    assert.match(recebidas[2].payload.externalReference, new RegExp(`^tenant:${alfa}:proration:\\d+$`));

    const linhas = (await cobrancas()).filter((l) => l.kind === 'renewal');
    assert.equal(linhas.length, 1, 'a mesma linha do período, e não uma segunda');
    assert.equal(linhas[0].amount_cents, 19990);
    assert.equal(linhas[0].status, 'pending');
    assert.notEqual(linhas[0].gateway_charge_id, idVelho);
    assert.equal(linhas[0].invoice_url, `https://gateway.exemplo.test/i/${linhas[0].gateway_charge_id}`);
    assert.equal(linhas[0].attempts, 0);

    const dele = await getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'subscription.changed' }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(dele.detail).openCharge, 'reissued');
  });

  it('se o gateway não cancela, 502 e o plano não muda', async () => {
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey((await Subscription.forTenant(alfa)).renews_at),
        amountCents: 9990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_que_nao_cancela', invoiceUrl: 'https://g.test/x' });
    });

    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    assert.equal((await Subscription.forTenant(alfa)).plan_id, planos.basico.id);
    const [linha] = await cobrancas();
    assert.equal(linha.gateway_charge_id, 'pay_que_nao_cancela', 'a linha fica como estava');
    assert.equal(linha.amount_cents, 9990);
    assert.equal(recebidas.some((r) => r.method === 'POST'), false);
  });

  it('a que já sumiu do gateway (404) não trava a troca', async () => {
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey((await Subscription.forTenant(alfa)).renews_at),
        amountCents: 9990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_que_sumiu' });
    });
    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [linha] = await cobrancas();
    assert.equal(linha.amount_cents, 19990);
  });

  it('trocar para um plano de graça é 404 e não toca a cobrança', async () => {
    await pagar();
    const [antes] = await cobrancas();
    recebidas = [];
    const res = await trocar(planos.gratis.id);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'plan_not_found');
    assert.deepEqual(recebidas, [], 'nada foi cancelado no gateway');
    const [depois] = await cobrancas();
    assert.equal(depois.gateway_charge_id, antes.gateway_charge_id);
    assert.equal(depois.status, 'pending');
  });

  it('409 busy quando a cobrança está sendo emitida por outro, sem cancelar nada', async () => {
    await pagar();
    const [linha] = await cobrancas();
    await getDb()('billing_charges').where({ id: linha.id }).update({ issuing_until: daquiA(1) });
    recebidas = [];

    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'busy');
    assert.ok(res.body.message);
    assert.deepEqual(recebidas, []);
    assert.equal((await Subscription.forTenant(alfa)).plan_id, planos.basico.id);
    const [depois] = await cobrancas();
    assert.equal(depois.gateway_charge_id, linha.gateway_charge_id);
  });

  it('duas trocas ao mesmo tempo: uma cancela e reemite, a outra ouve busy', async () => {
    await pagar();
    recebidas = [];
    const [a, b] = await Promise.all([trocar(planos.pro.id), trocar(planos.pro.id)]);
    const status = [a.status, b.status].sort();
    // A segunda pode chegar depois de a primeira terminar (e aí é o mesmo
    // plano, 200 sem nada) ou no meio (409 busy). Nunca duas reemissões.
    assert.ok(status[0] === 200, JSON.stringify([a.body, b.body]));
    assert.ok([200, 409].includes(status[1]));
    assert.equal(recebidas.filter((r) => r.method === 'DELETE').length, 1);
    const posts = recebidas.filter((r) => r.method === 'POST');
    const prorata = posts.filter((r) => /:proration:/.test(r.payload?.externalReference ?? ''));
    assert.equal(posts.length - prorata.length, 1, 'uma reemissão da renovação');
    assert.equal(prorata.length, 1, 'e uma pró-rata só: a segunda troca já não é subida');
  });

  it('o pagamento atrasado da cobrança trocada é conferido pelo valor DELA', async () => {
    await pagar();
    const [velha] = await cobrancas();
    const idVelho = velha.gateway_charge_id;
    assert.equal((await trocar(planos.pro.id)).status, 200);

    const achada = await runInTenant(alfa, () => BillingCharge.bySupersededGatewayId(idVelho));
    assert.ok(achada, 'o id velho continua achável');
    assert.equal(achada.superseded.amountCents, 9990);
    assert.equal(achada.row.id, velha.id);
    assert.equal(await runInTenant(alfa, () => BillingCharge.byGatewayId(idVelho)), null,
      'mas não como a cobrança da linha — um PAYMENT_DELETED dele não cancela a nova');

    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 9990, provider: 'asaas', externalId: idVelho
    }));
    assert.equal(pago.underpaid, false, 'pagou exatamente o que a cobrança velha pedia');
    assert.equal(pago.expectedCents, 9990);
  });
});

describe('a garra da emissão', () => {
  const abrirSemId = () => runInTenant(alfa, async () => BillingCharge.open({
    periodEnd: ChargeIssuingService.periodKey((await Subscription.forTenant(alfa)).renews_at),
    amountCents: 9990, currency: 'BRL', provider: 'asaas'
  }));

  it('linha garrada por outro não é emitida de novo pelo agendador', async () => {
    const id = await abrirSemId();
    await getDb()('billing_charges').where({ id }).update({ issuing_until: daquiA(1) });
    const res = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(res.reason, 'raced');
    assert.equal(res.charge.id, id);
    assert.deepEqual(recebidas, []);
  });

  it('mas a garra vencida (quem a tinha morreu) é retomada', async () => {
    const id = await abrirSemId();
    await getDb()('billing_charges').where({ id }).update({ issuing_until: daquiA(-1) });
    const res = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(res.issued, true, JSON.stringify(res));
    const [linha] = await cobrancas();
    assert.equal(linha.issuing_until, null, 'emitida, a garra é solta');
  });

  it('se outro gravou primeiro, a cobrança que sobrou é cancelada no gateway', async () => {
    const id = await abrirSemId();
    // O outro grava enquanto esta passada ainda espera a resposta do gateway —
    // o caso da garra que venceu no meio de uma chamada lenta.
    aoReceber = async (method, caminho) => {
      if (method === 'POST' && caminho === '/payments') {
        await getDb()('billing_charges').where({ id }).update({ gateway_charge_id: 'pay_do_outro' });
      }
    };
    const res = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(res.issued, false);
    assert.equal(res.reason, 'raced');
    assert.equal(res.charge.gateway_charge_id, 'pay_do_outro', 'a linha fica com quem gravou primeiro');
    const criada = recebidas.find((r) => r.method === 'POST');
    assert.ok(criada);
    assert.deepEqual(
      recebidas.filter((r) => r.method === 'DELETE').map((r) => r.path),
      [`/payments/pay_auto_${proximoId}`],
      'a cobrança desta passada foi cancelada'
    );
  });

  it('markIssued não sobrescreve uma linha já emitida', async () => {
    const id = await abrirSemId();
    await runInTenant(alfa, async () => {
      assert.equal(await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_primeiro' }), true);
      assert.equal(await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_segundo' }), false);
    });
    const [linha] = await cobrancas();
    assert.equal(linha.gateway_charge_id, 'pay_primeiro');
  });

  it('pagar agora espera a emissão do outro e devolve a cobrança dele', async () => {
    const id = await abrirSemId();
    await getDb()('billing_charges').where({ id }).update({ issuing_until: daquiA(1) });
    setTimeout(() => {
      runInTenant(alfa, () => BillingCharge.markIssued(id, {
        gatewayChargeId: 'pay_do_agendador', invoiceUrl: 'https://gateway.exemplo.test/i/pay_do_agendador'
      })).catch(() => {});
    }, 400);
    const res = await pagar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.charge.id, id);
    assert.equal(res.body.data.charge.invoiceUrl, 'https://gateway.exemplo.test/i/pay_do_agendador');
    assert.deepEqual(recebidas, [], 'nenhuma segunda cobrança no gateway');
  });

  it('e, se ela não sai a tempo, 409 busy', async () => {
    const espera = SelfBillingService.RACE_WAIT_MS;
    SelfBillingService.RACE_WAIT_MS = 300;
    try {
      const id = await abrirSemId();
      await getDb()('billing_charges').where({ id }).update({ issuing_until: daquiA(1) });
      const res = await pagar();
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'busy');
      assert.deepEqual(recebidas, []);
    } finally {
      SelfBillingService.RACE_WAIT_MS = espera;
    }
  });
});

describe('pagar agora', () => {
  it('cria o cliente no gateway quando falta e emite antes da janela', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: null, billing_customer_ref: null });
    // Vinte dias: longe da janela de cinco do agendador.
    await assinar({ renewsAt: daquiA(20) });

    const res = await pagar();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), ['POST /customers', 'POST /payments']);
    assert.equal(recebidas[0].payload.cpfCnpj, '12345678000195');
    assert.equal(recebidas[1].payload.customer, 'cus_autoatendido');
    assert.equal(recebidas[1].payload.value, 99.9);

    const provedor = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(provedor.billing_gateway, 'asaas');
    assert.equal(provedor.billing_customer_ref, 'cus_autoatendido');

    const { charge } = res.body.data;
    assert.equal(charge.amountCents, 9990);
    assert.equal(charge.status, 'pending');
    assert.match(charge.invoiceUrl, /^https:\/\/gateway\.exemplo\.test\/i\/pay_auto_/);
    assert.equal(charge.gatewayChargeId, undefined, 'a mesma leitura de /charges, sem a mecânica');

    const trilha = await getDb()('platform_audit')
      .where({ tenant_id: alfa, action: 'tenant.gateway_customer_created' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.deepEqual(JSON.parse(trilha.detail), { gateway: 'asaas', linked: true, selfService: true });
  });

  it('o vínculo com o gateway é condicional: quem perde a corrida usa o do vencedor', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: null, billing_customer_ref: null });
    aoReceber = async (method, caminho) => {
      if (method === 'POST' && caminho === '/customers') {
        await getDb()('tenants').where({ id: alfa })
          .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_ganhador' });
      }
    };
    const ligado = await ensureAsaasCustomer(alfa);
    assert.equal(ligado.created, false);
    assert.equal(ligado.customerRef, 'cus_ganhador');
    const provedor = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(provedor.billing_customer_ref, 'cus_ganhador', 'o vínculo do vencedor não foi trocado');

    assert.equal(await Tenant.linkGatewayIfUnlinked(alfa, { gateway: 'asaas', customerRef: 'cus_outro' }), false);
  });

  it('o segundo clique devolve a mesma cobrança, sem outra no gateway', async () => {
    const primeira = await pagar();
    assert.equal(primeira.status, 201);
    const segunda = await pagar();
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.data.charge.id, primeira.body.data.charge.id);
    assert.equal(segunda.body.data.charge.invoiceUrl, primeira.body.data.charge.invoiceUrl);
    assert.equal(recebidas.filter((r) => r.method === 'POST').length, 1);
    assert.equal((await cobrancas()).length, 1);
  });

  it('insiste mesmo depois de o agendador ter desistido', async () => {
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey((await Subscription.forTenant(alfa)).renews_at),
        amountCents: 9990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.update(id, {
        status: 'failed', attempts: ChargeIssuingService.MAX_ATTEMPTS, next_attempt_at: daquiA(1)
      });
    });
    assert.equal((await runInTenant(alfa, () => ChargeIssuingService.issueCurrent())).reason, 'gave_up');

    const res = await pagar();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [linha] = await cobrancas();
    assert.equal(linha.status, 'pending');
    assert.ok(linha.gateway_charge_id);
  });

  it('assinatura sem prazo nenhum é cobrada, e o clique seguinte acha a mesma', async () => {
    await assinar({ renewsAt: null });
    const primeira = await pagar();
    assert.equal(primeira.status, 201, JSON.stringify(primeira.body));
    const segunda = await pagar();
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.data.charge.id, primeira.body.data.charge.id);
    assert.equal((await cobrancas()).length, 1);
  });

  it('400 com o cadastro fiscal incompleto, sem falar com o gateway', async () => {
    const casos = [
      [{ billing_tax_id: null }, 'missing_tax_id'],
      [{ billing_tax_id: '123456' }, 'invalid_tax_id'],
      [{ billing_legal_name: null, name: '' }, 'missing_name']
    ];
    for (const [patch, codigo] of casos) {
      const nome = (await getDb()('tenants').where({ id: alfa }).first()).name;
      await getDb()('tenants').where({ id: alfa })
        .update({ billing_gateway: null, billing_customer_ref: null, ...CADASTRO, ...patch });
      try {
        const res = await pagar();
        assert.equal(res.status, 400, codigo);
        assert.equal(res.body.code, codigo);
      } finally {
        await getDb()('tenants').where({ id: alfa }).update({ name: nome });
      }
    }
    assert.equal(recebidas.length, 0);
    assert.deepEqual(await cobrancas(), []);
  });

  it('409 para plano de graça e para quem foi parado por gente', async () => {
    await assinar({ plan: planos.gratis });
    const gratis = await pagar();
    assert.equal(gratis.status, 409);
    assert.equal(gratis.body.code, 'free_plan');

    for (const status of ['suspended', 'canceled']) {
      await assinar({ status });
      const res = await pagar();
      assert.equal(res.status, 409, status);
      assert.equal(res.body.code, 'not_billable');
    }
    await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: 'manual', billing_customer_ref: 'x' });
    await assinar();
    const manual = await pagar();
    assert.equal(manual.status, 409);
    assert.equal(manual.body.code, 'not_billable');
    assert.equal(recebidas.length, 0);
  });

  it('502 com a mensagem do gateway quando ele recusa', async () => {
    await assinar({ plan: planos.recusado });
    const res = await pagar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'gateway_failed');
    assert.match(res.body.message, /valor recusado pelo gateway/);
  });

  it('503 sem a chave do gateway', async () => {
    process.env.ASAAS_API_KEY = '';
    try {
      const res = await pagar();
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'gateway_not_configured');
    } finally {
      process.env.ASAAS_API_KEY = CHAVE;
    }
  });

  it('403 para o viewer', async () => {
    assert.equal((await pagar(viewerToken)).status, 403);
    assert.equal(recebidas.length, 0);
  });
});

describe('a descida agendada', () => {
  const linha = () => Subscription.forTenant(alfa);
  const ultimaTrilha = async () => {
    const row = await getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'subscription.changed' }).orderBy('id', 'desc').first();
    return row ? JSON.parse(row.detail) : null;
  };
  const trocasNoExtrato = () => getDb()('billing_events')
    .where({ tenant_id: alfa, type: 'plan.changed' }).orderBy('id', 'asc');

  it('subir vale na hora, e apaga a descida que estava agendada', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.leve.id)).status, 200);
    assert.equal((await linha()).pending_plan_id, planos.leve.id);

    const res = await trocar(planos.pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.subscription.plan.code, 'auto-pro');
    assert.equal(res.body.data.subscription.pendingPlan, null);
    const depois = await linha();
    assert.equal(depois.plan_id, planos.pro.id);
    assert.equal(depois.pending_plan_id, null);
    assert.equal(depois.pending_plan_at, null);
    assert.equal((await ultimaTrilha()).scheduled, false);
  });

  it('descer com o período pago correndo fica para a renovação, com plano e tetos de agora', async () => {
    const renova = daquiA(20);
    await assinar({ renewsAt: renova });
    const eventosAntes = (await trocasNoExtrato()).length;

    const res = await trocar(planos.leve.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /agendad|scheduled/i);
    const { subscription, limits } = res.body.data;
    assert.equal(subscription.plan.code, 'auto-basico', 'o plano continua o que foi pago');
    assert.equal(limits.operators, 5, 'e os tetos também');
    assert.deepEqual(subscription.pendingPlan, {
      id: planos.leve.id,
      name: 'Leve',
      priceCents: 6990,
      billingCycle: 'monthly',
      effectiveAt: renova.toISOString(),
      locked: false,
      blockedBy: null
    });

    const depois = await linha();
    assert.equal(depois.plan_id, planos.basico.id);
    assert.equal(depois.pending_plan_id, planos.leve.id);
    assert.equal(new Date(depois.pending_plan_at).getTime(), renova.getTime());
    assert.equal((await trocasNoExtrato()).length, eventosAntes, 'nada trocou ainda: nada no extrato');

    const trilha = await ultimaTrilha();
    assert.equal(trilha.scheduled, true);
    assert.equal(trilha.to, planos.leve.id);
    assert.equal(trilha.effectiveAt, renova.toISOString());

    // O GET diz o mesmo.
    const lido = await pedir('/subscription');
    assert.equal(lido.body.data.subscription.pendingPlan.id, planos.leve.id);

    // E pedir de novo a mesma descida não mexe em nada.
    const antes = (await getDb()('audit_log').where({ tenant_id: alfa }).count({ n: '*' }).first()).n;
    const repetida = await trocar(planos.leve.id);
    assert.equal(repetida.status, 200);
    assert.match(repetida.body.message, /agendad|scheduled/i);
    const depoisN = (await getDb()('audit_log').where({ tenant_id: alfa }).count({ n: '*' }).first()).n;
    assert.equal(Number(depoisN), Number(antes));
  });

  it('a cobrança da renovação sai com o preço do plano agendado', async () => {
    // Dois dias: dentro da janela de cinco do agendador.
    await assinar({ renewsAt: daquiA(2) });
    const res = await trocar(planos.leve.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas, [], 'sem cobrança em aberto, nada a cancelar nem a emitir na troca');

    const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    assert.equal(emitida.amountCents, 6990);
    const post = recebidas.find((r) => r.method === 'POST');
    assert.equal(post.payload.value, 69.9);
    assert.match(post.payload.description, /Leve/);
    const [cobranca] = await cobrancas();
    assert.equal(cobranca.amount_cents, 6990);
    assert.equal((await linha()).plan_id, planos.basico.id, 'o plano só muda na renovação');
  });

  it('a cobrança da renovação já emitida é cancelada e reemitida com o preço menor', async () => {
    await pagar();
    const [velha] = await cobrancas();
    assert.equal(velha.amount_cents, 9990);
    recebidas = [];

    const res = await trocar(planos.leve.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
      `DELETE /payments/${velha.gateway_charge_id}`,
      'POST /payments'
    ]);
    assert.equal(recebidas[1].payload.value, 69.9);
    const [nova] = await cobrancas();
    assert.equal(nova.id, velha.id);
    assert.equal(nova.amount_cents, 6990);
    assert.equal((await linha()).plan_id, planos.basico.id);
    assert.equal((await ultimaTrilha()).openCharge, 'reissued');
  });

  it('escolher o plano atual desiste da descida e devolve o preço à cobrança reemitida', async () => {
    await pagar();
    assert.equal((await trocar(planos.leve.id)).status, 200);
    const [reemitida] = await cobrancas();
    assert.equal(reemitida.amount_cents, 6990);
    recebidas = [];

    const res = await trocar(planos.basico.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /cancel/i);
    assert.equal(res.body.data.subscription.pendingPlan, null);
    assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
      `DELETE /payments/${reemitida.gateway_charge_id}`,
      'POST /payments'
    ]);
    assert.equal(recebidas[1].payload.value, 99.9);
    const [cobranca] = await cobrancas();
    assert.equal(cobranca.amount_cents, 9990);

    const depois = await linha();
    assert.equal(depois.plan_id, planos.basico.id);
    assert.equal(depois.pending_plan_id, null);
    const trilha = await ultimaTrilha();
    assert.equal(trilha.pendingCanceled, true);
    assert.equal(trilha.canceledPlanId, planos.leve.id);
  });

  it('outro plano mais barato substitui o agendado', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.leve.id)).status, 200);
    const res = await trocar(planos.mini.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await linha()).pending_plan_id, planos.mini.id);
    assert.equal((await ultimaTrilha()).replacedPlanId, planos.leve.id);
  });

  it('o agendador aplica a descida quando a data chega', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.leve.id)).status, 200);
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ pending_plan_at: daquiA(-0.01) });
    const eventosAntes = (await trocasNoExtrato()).length;

    const tenant = await Tenant.findById(alfa);
    const resumo = await runInTenant(alfa, () => SchedulerService.runJobs({ tenant }));
    assert.equal(resumo.pendingPlan.applied, true, JSON.stringify(resumo.pendingPlan));

    const depois = await linha();
    assert.equal(depois.plan_id, planos.leve.id);
    assert.equal(depois.pending_plan_id, null);
    assert.equal(depois.pending_plan_at, null);
    const eventos = await trocasNoExtrato();
    assert.equal(eventos.length, eventosAntes + 1);
    const detalhe = JSON.parse(eventos.at(-1).detail);
    assert.equal(detalhe.scheduled, true);
    assert.equal(detalhe.from, planos.basico.id);
    assert.equal(detalhe.to, planos.leve.id);

    const lido = await pedir('/subscription');
    assert.equal(lido.body.data.subscription.plan.code, 'auto-leve', 'o cache foi esquecido');

    // A segunda passada não tem o que fazer.
    const outra = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan());
    assert.equal(outra.reason, 'none');
  });

  it('antes da data, a aplicação não faz nada', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.leve.id)).status, 200);
    const res = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan());
    assert.equal(res.reason, 'not_due');
    assert.equal((await linha()).plan_id, planos.basico.id);
  });

  it('o pagamento atrasado da renovação aplica a descida e compra o período do plano novo', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.leve.id)).status, 200);
    // A renovação passou sem o agendador rodar: o pagamento chega depois.
    const venceu = daquiA(-1);
    await getDb()('subscriptions').where({ tenant_id: alfa })
      .update({ renews_at: venceu, pending_plan_at: venceu });

    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 6990, provider: 'manual', externalId: 'pix-da-descida'
    }));
    assert.equal(pago.underpaid, false, 'pagou o preço do plano que o período novo tem');
    assert.equal(pago.expectedCents, 6990);
    assert.equal(pago.subscription.plan_id, planos.leve.id);
    assert.equal(pago.subscription.pending_plan_id, null);
    assert.equal(pago.subscription.status, 'active');
    const eventos = await trocasNoExtrato();
    const detalhe = JSON.parse(eventos.at(-1).detail);
    assert.equal(detalhe.scheduled, true);
    assert.equal(detalhe.byPayment, true);
  });

  it('o pagamento adiantado da renovação confere pelo plano novo, mas não troca antes da hora', async () => {
    const renova = daquiA(2);
    await assinar({ renewsAt: renova });
    assert.equal((await trocar(planos.leve.id)).status, 200);

    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 6990, provider: 'manual', externalId: 'pix-adiantado'
    }));
    assert.equal(pago.underpaid, false);
    assert.equal(pago.expectedCents, 6990);
    assert.equal(pago.subscription.plan_id, planos.basico.id, 'o período pago do plano caro vai até o fim');
    assert.equal(pago.subscription.pending_plan_id, planos.leve.id);
    assert.equal(new Date(pago.subscription.renews_at).getTime(), renova.getTime() + 30 * 86_400_000);

    // E na data, a troca acontece — mesmo com `renews_at` já no mês seguinte.
    const res = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: daquiA(3) }));
    assert.equal(res.applied, true);
    assert.equal((await linha()).plan_id, planos.leve.id);
  });

  it('com o uso acima do plano agendado, agenda, avisa e não aplica', async () => {
    // A dona e quem só olha: duas pessoas, e o mini aceita uma.
    await assinar({ renewsAt: daquiA(20) });
    const res = await trocar(planos.mini.id);
    assert.equal(res.status, 200, 'na descida agendada o uso não é conferido agora');
    assert.deepEqual(res.body.data.subscription.pendingPlan.blockedBy, { resource: 'operators', used: 2, limit: 1 });

    const avisos = [];
    const warn = console.warn;
    console.warn = (...args) => { avisos.push(args.join(' ')); };
    let aplicada;
    let segunda;
    try {
      aplicada = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: daquiA(21) }));
      segunda = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: daquiA(21) }));
    } finally {
      console.warn = warn;
    }
    assert.equal(aplicada.applied, false);
    assert.equal(aplicada.reason, 'over_limit');
    assert.deepEqual(aplicada.blockedBy, { resource: 'operators', used: 2, limit: 1 });
    assert.equal(segunda.reason, 'over_limit');
    assert.equal(avisos.filter((a) => /stays pending/.test(a)).length, 1, 'um aviso por agendamento, não por passada');
    const depois = await linha();
    assert.equal(depois.plan_id, planos.basico.id);
    assert.equal(depois.pending_plan_id, planos.mini.id, 'a agendada continua viva');
  });

  it('com o uso acima do plano agendado, a cobrança da renovação sai pelo preço do atual', async () => {
    await assinar({ renewsAt: daquiA(2) });
    assert.equal((await trocar(planos.mini.id)).status, 200);

    const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(emitida.issued, true, JSON.stringify(emitida));
    assert.equal(emitida.amountCents, 9990, 'a descida não vai se aplicar: o período é do plano atual');
    assert.equal(recebidas.find((r) => r.method === 'POST').payload.value, 99.9);

    // E o pagamento dela confere pelo mesmo preço — com ou sem a linha.
    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 4990, provider: 'manual', externalId: 'pix-do-bloqueado'
    }));
    assert.equal(pago.expectedCents, 9990);
    assert.equal(pago.underpaid, true);
  });

  it('bloqueada depois de a cobrança sair pelo preço menor, a cobrança volta ao preço do atual', async () => {
    await assinar({ renewsAt: daquiA(2) });
    try {
      assert.equal((await trocar(planos.enxuto.id)).status, 200);
      const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      assert.equal(emitida.amountCents, 4990, 'cabia: saiu pelo preço da descida');
      const [baixa] = await cobrancas();
      recebidas = [];

      // O uso deixa de caber (aqui, o teto baixa — dá no mesmo que contratar).
      await Plan.update(planos.enxuto.id, { max_operators: 1 });
      const passada = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      assert.equal(passada.issued, true, JSON.stringify(passada));
      assert.deepEqual(recebidas.map((r) => `${r.method} ${r.path}`), [
        `DELETE /payments/${baixa.gateway_charge_id}`,
        'POST /payments'
      ]);
      assert.equal(recebidas[1].payload.value, 99.9);
      const [cheia] = await cobrancas();
      assert.equal(cheia.id, baixa.id, 'a mesma linha do período');
      assert.equal(cheia.amount_cents, 9990);
      assert.equal((await linha()).pending_plan_id, planos.enxuto.id, 'a agendada continua viva');

      // A passada seguinte não mexe mais.
      recebidas = [];
      const outra = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      assert.equal(outra.reason, 'already_issued');
      assert.deepEqual(recebidas, []);
    } finally {
      await Plan.update(planos.enxuto.id, { max_operators: 2 });
    }
  });

  it('mas a cobrança já paga pelo preço menor não é tocada', async () => {
    await assinar({ renewsAt: daquiA(2) });
    try {
      assert.equal((await trocar(planos.enxuto.id)).status, 200);
      await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      const [baixa] = await cobrancas();
      await getDb()('billing_charges').where({ id: baixa.id }).update({ status: 'paid' });
      recebidas = [];

      await Plan.update(planos.enxuto.id, { max_operators: 1 });
      const passada = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      assert.equal(passada.reason, 'already_settled');
      assert.deepEqual(recebidas, []);
      const [depois] = await cobrancas();
      assert.equal(depois.amount_cents, 4990);
      assert.equal(depois.gateway_charge_id, baixa.gateway_charge_id);
    } finally {
      await Plan.update(planos.enxuto.id, { max_operators: 2 });
    }
  });

  it('em teste, em atraso ou sem data de renovação, descer vale na hora', async () => {
    const casos = [
      { status: 'trial', renewsAt: null, trialEndsAt: daquiA(5) },
      { status: 'past_due', renewsAt: daquiA(-3) },
      { status: 'active', renewsAt: daquiA(-1) },
      { status: 'active', renewsAt: null }
    ];
    for (const caso of casos) {
      await assinar(caso);
      const res = await trocar(planos.leve.id);
      const rotulo = JSON.stringify(caso);
      assert.equal(res.status, 200, `${rotulo} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.subscription.plan.code, 'auto-leve', rotulo);
      assert.equal(res.body.data.subscription.pendingPlan, null, rotulo);
      const depois = await linha();
      assert.equal(depois.plan_id, planos.leve.id, rotulo);
      assert.equal(depois.pending_plan_id, null, rotulo);
      assert.equal((await ultimaTrilha()).scheduled, false, rotulo);
    }
  });

  it('preço igual, outro plano: vale na hora', async () => {
    await assinar({ renewsAt: daquiA(20) });
    const res = await trocar(planos.gemeo.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await linha()).plan_id, planos.gemeo.id);
    assert.equal(res.body.data.subscription.pendingPlan, null);
  });

  it('a troca pelo console vale na hora e apaga a agendada', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.leve.id)).status, 200);
    await runInTenant(alfa, () => SubscriptionService.changePlan({ planId: planos.pro.id }));
    const depois = await linha();
    assert.equal(depois.plan_id, planos.pro.id);
    assert.equal(depois.pending_plan_id, null);
    assert.equal(depois.pending_plan_at, null);
    const eventos = await trocasNoExtrato();
    assert.equal(JSON.parse(eventos.at(-1).detail).pendingCleared, planos.leve.id);
  });
});

describe('as travas da descida agendada', () => {
  const linha = () => Subscription.forTenant(alfa);
  const DIA = 86_400_000;

  /** Agenda a descida, paga adiantado a cobrança da renovação pelo preço dela. */
  async function pagarBaratoAdiantado(plano) {
    const renova = daquiA(20);
    await assinar({ renewsAt: renova });
    assert.equal((await trocar(plano.id)).status, 200);
    const pago = await pagar();
    assert.equal(pago.status, 201, JSON.stringify(pago.body));
    assert.equal(pago.body.data.charge.amountCents, Number(plano.price_cents), 'o pagar agora já cobra o preço da descida');
    const [cobranca] = await cobrancas();
    const res = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: Number(plano.price_cents), provider: 'asaas', externalId: cobranca.gateway_charge_id
    }));
    assert.equal(res.underpaid, false);
    return { renova, cobranca };
  }

  it('paga pelo preço da descida, ela trava: não se cancela, não se troca, não se sobe', async () => {
    const { renova } = await pagarBaratoAdiantado(planos.leve);
    const depois = await linha();
    assert.ok(depois.pending_plan_locked_at, 'a trava foi gravada');
    assert.equal(new Date(depois.renews_at).getTime(), renova.getTime() + 30 * DIA);
    assert.equal(depois.plan_id, planos.basico.id, 'o plano de cima vale até a data');

    const lido = await pedir('/subscription');
    assert.equal(lido.body.data.subscription.pendingPlan.locked, true);
    assert.equal(lido.body.data.subscription.pendingPlan.blockedBy, null);

    recebidas = [];
    for (const plano of [planos.basico, planos.mini, planos.pro]) {
      const res = await trocar(plano.id);
      assert.equal(res.status, 409, plano.code);
      assert.equal(res.body.code, 'pending_locked', plano.code);
      assert.equal(res.body.pendingPlanId, planos.leve.id);
      assert.equal(res.body.effectiveAt, renova.toISOString());
    }
    const mesma = await trocar(planos.leve.id);
    assert.equal(mesma.status, 200, 'pedir a própria descida de novo não muda nada');
    assert.deepEqual(recebidas, [], 'nada foi cancelado nem emitido');
    const fim = await linha();
    assert.equal(fim.pending_plan_id, planos.leve.id);
    assert.equal(fim.plan_id, planos.basico.id);
  });

  it('travada, aplica-se na data mesmo com o uso acima dos tetos', async () => {
    await pagarBaratoAdiantado(planos.enxuto);
    try {
      await Plan.update(planos.enxuto.id, { max_operators: 1 });
      const res = await runInTenant(alfa, () => SubscriptionService.applyPendingPlan({ now: daquiA(21) }));
      assert.equal(res.applied, true, JSON.stringify(res));
      assert.equal(res.locked, true);
      const depois = await linha();
      assert.equal(depois.plan_id, planos.enxuto.id);
      assert.equal(depois.pending_plan_id, null);
      assert.equal(depois.pending_plan_locked_at, null);
    } finally {
      await Plan.update(planos.enxuto.id, { max_operators: 2 });
    }
  });

  it('a descida que limita ONTs trava pelo preço pago, sem contar ONT nenhuma no pagamento', async () => {
    await pagarBaratoAdiantado(planos.poucas);
    assert.ok((await linha()).pending_plan_locked_at);
  });

  it('a cobrança do período da descida paga barato também trava, mesmo sem a marca', async () => {
    const renova = daquiA(20);
    await assinar({ renewsAt: renova });
    await getDb()('subscriptions').where({ tenant_id: alfa })
      .update({ pending_plan_id: planos.leve.id, pending_plan_at: renova });
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey(renova), amountCents: 6990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, { gatewayChargeId: 'pay_pago_por_fora' });
      await BillingCharge.update(id, { status: 'paid' });
    });
    const res = await trocar(planos.basico.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'pending_locked');
    assert.ok((await linha()).pending_plan_locked_at, 'e a marca foi gravada');
  });

  it('bloqueada e paga pelo preço de cima, a descida vai para a renovação seguinte', async () => {
    const renova = daquiA(2);
    await assinar({ renewsAt: renova });
    // Duas pessoas, e o mini aceita uma: bloqueada.
    assert.equal((await trocar(planos.mini.id)).status, 200);
    const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(emitida.amountCents, 9990);
    const [cobranca] = await cobrancas();

    const avisos = [];
    const warn = console.warn;
    console.warn = (...args) => { avisos.push(args.join(' ')); };
    let pago;
    try {
      pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
        amountCents: 9990, provider: 'asaas', externalId: cobranca.gateway_charge_id
      }));
    } finally {
      console.warn = warn;
    }
    assert.equal(pago.underpaid, false);
    const depois = await linha();
    const novaRenovacao = renova.getTime() + 30 * DIA;
    assert.equal(new Date(depois.renews_at).getTime(), novaRenovacao);
    assert.equal(depois.plan_id, planos.basico.id);
    assert.equal(depois.pending_plan_id, planos.mini.id);
    assert.equal(new Date(depois.pending_plan_at).getTime(), novaRenovacao, 'tenta de novo na renovação seguinte');
    assert.equal(depois.pending_plan_locked_at, null, 'e não trava: foi pago o preço de cima');
    assert.ok(avisos.some((a) => /next renewal/.test(a)));
    // Destravada, a desistência continua possível.
    assert.equal((await trocar(planos.basico.id)).status, 200);
    assert.equal((await linha()).pending_plan_id, null);
  });

  it('subir no meio do período e descer em seguida: a descida vai para a renovação seguinte', async () => {
    const renova = daquiA(2);
    await assinar({ renewsAt: renova });
    const subiu = await trocar(planos.pro.id);
    assert.equal(subiu.status, 200);
    assert.ok((await linha()).upgraded_at, 'a subida no meio do período fica marcada');

    const desceu = await trocar(planos.basico.id);
    assert.equal(desceu.status, 200, JSON.stringify(desceu.body));
    const esperado = new Date(renova.getTime() + 30 * DIA).toISOString();
    assert.equal(desceu.body.data.subscription.pendingPlan.effectiveAt, esperado);
    assert.equal((await ultimaTrilhaDe('subscription.changed')).effectiveAt, esperado);

    // A cobrança desta renovação sai pelo plano de cima — é ela que paga a subida.
    const emitida = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
    assert.equal(emitida.amountCents, 19990);
    const [cobranca] = (await cobrancas()).filter((l) => l.kind === 'renewal');
    const pago = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 19990, provider: 'asaas', externalId: cobranca.gateway_charge_id
    }));
    assert.equal(pago.underpaid, false);
    const depois = await linha();
    assert.equal(depois.upgraded_at, null, 'a subida foi paga: a marca sai');
    assert.equal(depois.plan_id, planos.pro.id);
    assert.equal(depois.pending_plan_id, planos.basico.id);
    assert.equal(new Date(depois.pending_plan_at).toISOString(), esperado);
    assert.equal(depois.pending_plan_locked_at, null);
  });

  it('a subida paga não adia: descer depois de pagar o plano de cima vale na renovação', async () => {
    await assinar({ renewsAt: daquiA(20) });
    assert.equal((await trocar(planos.pro.id)).status, 200);
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ upgraded_at: null });
    const res = await trocar(planos.basico.id);
    const renova = (await linha()).renews_at;
    assert.equal(res.body.data.subscription.pendingPlan.effectiveAt, new Date(renova).toISOString());
  });

  it('a linha reprecificada fica com dono até o estado novo estar gravado', async () => {
    await pagar();
    const [velha] = await cobrancas();
    recebidas = [];
    const original = SubscriptionService.schedulePlanChange;
    let noMeio = null;
    SubscriptionService.schedulePlanChange = async function comPassadaNoMeio(args) {
      // O agendador (ou um pagar agora) chegando entre o reset e a gravação.
      noMeio = await ChargeIssuingService.issueCurrent({ now: new Date() });
      return original.call(this, args);
    };
    try {
      const res = await trocar(planos.leve.id);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    } finally {
      SubscriptionService.schedulePlanChange = original;
    }
    assert.equal(noMeio.issued, false);
    assert.equal(noMeio.reason, 'raced', 'a passada do meio não emite pelo preço velho');
    const posts = recebidas.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.value, 69.9);
    const [nova] = await cobrancas();
    assert.equal(nova.id, velha.id);
    assert.equal(nova.amount_cents, 6990);
    assert.equal(nova.issuing_until, null, 'e a garra foi solta no fim');
  });

  it('a reprecificação que falha no gateway espera antes de tentar de novo', async () => {
    await assinar({ renewsAt: daquiA(2) });
    try {
      assert.equal((await trocar(planos.enxuto.id)).status, 200);
      await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      await Plan.update(planos.enxuto.id, { max_operators: 1 });
      recusarCancelamento = true;
      recebidas = [];

      const warn = console.warn;
      console.warn = () => {};
      let primeira;
      let segunda;
      try {
        primeira = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
        segunda = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      } finally {
        console.warn = warn;
      }
      assert.equal(primeira.reason, 'reprice_failed');
      assert.equal(segunda.reason, 'backing_off');
      assert.equal(recebidas.filter((r) => r.method === 'DELETE').length, 1, 'um DELETE, não um por passada');
      const [cobranca] = await cobrancas();
      assert.match(cobranca.last_error, /cancelamento recusado/);
      assert.equal(cobranca.amount_cents, 4990);

      // Passada a espera e o gateway de volta, reprecifica.
      recusarCancelamento = false;
      await getDb()('billing_charges').where({ id: cobranca.id }).update({ next_attempt_at: daquiA(-1) });
      const terceira = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
      assert.equal(terceira.issued, true, JSON.stringify(terceira));
      const [cheia] = await cobrancas();
      assert.equal(cheia.amount_cents, 9990);
      assert.equal(cheia.next_attempt_at, null);
    } finally {
      await Plan.update(planos.enxuto.id, { max_operators: 2 });
    }
  });

  it('bloqueada por ONTs, a reemissão usa o veredito da reprecificação, sem recontar', async () => {
    await assinar({ renewsAt: daquiA(2) });
    assert.equal((await trocar(planos.poucas.id)).status, 200);
    const cabe = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent({ countDevices: async () => 5 }));
    assert.equal(cabe.amountCents, 5990);
    recebidas = [];

    // Cinquenta na primeira contagem, cinco daí em diante: a ONT que oscila.
    let contagens = 0;
    const oscila = async () => { contagens += 1; return contagens === 1 ? 50 : 5; };
    const warn = console.warn;
    console.warn = () => {};
    let passada;
    try {
      passada = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent({ countDevices: oscila }));
    } finally {
      console.warn = warn;
    }
    assert.equal(passada.issued, true, JSON.stringify(passada));
    assert.equal(contagens, 1, 'contou uma vez só');
    const posts = recebidas.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.value, 99.9, 'reemitida pelo preço de cima, como decidido');

    // E a passada seguinte, cabendo, não desce o preço de volta.
    recebidas = [];
    const seguinte = await runInTenant(alfa, () => ChargeIssuingService.issueCurrent({ countDevices: oscila }));
    assert.equal(seguinte.reason, 'already_issued');
    assert.deepEqual(recebidas, []);
  });
});

async function ultimaTrilhaDe(action) {
  const row = await getDb()('audit_log').where({ tenant_id: alfa, action }).orderBy('id', 'desc').first();
  return row ? JSON.parse(row.detail) : null;
}
