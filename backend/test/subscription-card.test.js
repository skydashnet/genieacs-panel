import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: CardAutopayService } = await import('../src/services/billing/cardAutopayService.js');
const { default: BillingWebhookController } = await import('../src/controllers/billingWebhookController.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');
const { default: SubscriptionNoticeService } = await import('../src/services/subscriptionNoticeService.js');
const { subscriptionView } = await import('../src/controllers/platformBillingController.js');

/**
 * O cartão recorrente (0100): o provedor paga uma fatura com cartão na página
 * do Asaas, e as renovações seguintes saem no cartão salvo.
 *
 * Self-hosted, pelo motivo de `tenant-self-billing.test.js`: só fora da SaaS o
 * cliente do gateway aceita `127.0.0.1`, e o que este arquivo assere são as
 * requisições que SAEM — o `GET` que lê o token, a cobrança com
 * `creditCardToken` e `remoteIp`, o `DELETE` da cobrança recusada antes da
 * reemissão como Pix/boleto. A porta da assinatura (SaaS) é conferida em
 * `tenant-charges.test.js`.
 *
 * As maneiras de errar, que é o que se guarda aqui:
 *
 * 1. **O token vazar** — em resposta, trilha, `last_error` ou log. É uma
 *    credencial de cobrança: quem a tem cobra o cartão de alguém.
 * 2. **Cobrar duas vezes no cartão** — uma resposta perdida no meio, e a
 *    retentativa criando outra cobrança que o gateway cobra sozinho.
 * 3. **O provedor ficar sem como pagar** — o cartão recusado e nenhuma fatura
 *    de Pix/boleto no lugar.
 * 4. **Insistir no cartão recusado** antes de um pagamento novo com cartão.
 */
const CHAVE = 'chave-do-cartao-recorrente';
const WEBHOOK = 'token-do-webhook-do-cartao';
const TOKEN = 'tok_SEGREDO_do_cartao_9f8e7d6c5b4a';
const TOKEN_NOVO = 'tok_OUTRO_cartao_1a2b3c4d5e6f';

let gateway;
let recebidas = [];
let proximoId = 0;
/**
 * `ok`, `recusar` (400 do cartão, com o token ecoado), `rejeitar` (400 que não
 * é do cartão), `limite` (429) ou `cair` (cria e responde 502).
 */
let modoCartao = 'ok';
/** Os pagamentos que o gateway de mentira conhece como pagos com cartão. */
const pagosComCartao = new Map();
/** As cobranças criadas, para o `GET /payments?externalReference=`. */
let criadas = [];
let panelUrl;
let alfa;
let donoToken;
let viewerToken;
let basico;
let pro;
let smtp;
let emails;
const respostas = [];
const linhasDeLog = [];

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const [caminho, consulta = ''] = req.url.split('?');
      recebidas.push({ method: req.method, path: caminho, query: consulta, payload });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, {});
      if (req.method === 'POST' && caminho === '/payments') {
        if (payload?.billingType === 'CREDIT_CARD' && modoCartao === 'recusar') {
          return responder(400, {
            errors: [{ code: 'invalid_creditCard', description: `Transação não autorizada para ${payload.creditCardToken}` }]
          });
        }
        if (payload?.billingType === 'CREDIT_CARD' && modoCartao === 'rejeitar') {
          return responder(400, { errors: [{ code: 'invalid_object', description: 'O campo externalReference é inválido.' }] });
        }
        if (payload?.billingType === 'CREDIT_CARD' && modoCartao === 'limite') {
          return responder(429, { errors: [{ code: 'too_many_requests', description: 'Limite de requisições atingido.' }] });
        }
        proximoId += 1;
        const id = `pay_card_${proximoId}`;
        criadas.push({
          id, billingType: payload.billingType, externalReference: payload.externalReference, value: payload.value,
          status: 'PENDING', invoiceUrl: `https://gateway.exemplo.test/i/${id}`, dueDate: payload.dueDate
        });
        if (payload?.billingType === 'CREDIT_CARD' && modoCartao === 'cair') {
          return responder(502, { errors: [{ description: 'gateway caiu no meio' }] });
        }
        return responder(200, {
          id, status: 'PENDING', value: payload.value, dueDate: payload.dueDate, billingType: payload.billingType,
          invoiceUrl: `https://gateway.exemplo.test/i/${id}`
        });
      }
      if (req.method === 'POST' && caminho.startsWith('/payments/')) {
        return responder(200, { status: 'PENDING', dueDate: payload?.dueDate, billingType: payload?.billingType });
      }
      if (req.method === 'GET' && caminho === '/payments') {
        const ref = new URLSearchParams(consulta).get('externalReference');
        return responder(200, { data: criadas.filter((item) => item.externalReference === ref) });
      }
      if (req.method === 'GET' && caminho.startsWith('/payments/')) {
        const id = decodeURIComponent(caminho.slice('/payments/'.length));
        const cartao = pagosComCartao.get(id);
        const criada = criadas.find((item) => item.id === id);
        if (!cartao && criada) {
          return responder(200, {
            id,
            billingType: criada.billingType,
            status: criada.status,
            value: criada.value,
            paymentDate: criada.status === 'PENDING' ? null : new Date().toISOString().slice(0, 10)
          });
        }
        if (!cartao) return responder(200, { id, billingType: 'PIX', status: 'RECEIVED' });
        return responder(200, {
          id,
          billingType: 'CREDIT_CARD',
          status: 'CONFIRMED',
          creditCard: { creditCardNumber: cartao.number, creditCardBrand: cartao.brand, creditCardToken: cartao.token }
        });
      }
      if (req.method === 'DELETE' && caminho.startsWith('/payments/')) {
        const id = decodeURIComponent(caminho.slice('/payments/'.length));
        return responder(200, { deleted: true, id });
      }
      return responder(404, {});
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

/** Tudo que o processo escreve no log, para provar que o token não está lá. */
function escutarLog() {
  for (const nivel of ['log', 'info', 'warn', 'error']) {
    const original = console[nivel].bind(console);
    console[nivel] = (...args) => {
      linhasDeLog.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
      original(...args);
    };
  }
}

/** `call`, guardando o corpo de cada resposta para a varredura do token. */
async function chamar(url, options) {
  const resposta = await call(url, options);
  respostas.push(JSON.stringify(resposta.body));
  return resposta;
}

const pedir = (caminho, { method = 'GET', body, token = donoToken } = {}) => chamar(`${panelUrl}/api/tenant${caminho}`, {
  method, headers: authHeaders(token), ...(body === undefined ? {} : { body })
});
const autopay = (enabled, token) => pedir('/subscription/autopay', { method: 'PUT', body: { enabled }, token });
const removerCartao = (token) => pedir('/subscription/card', { method: 'DELETE', token });

const entregar = (corpo) => chamar(`${panelUrl}/api/billing-webhook`, {
  method: 'POST', headers: { 'asaas-access-token': WEBHOOK }, body: corpo
});

const pagamentoComCartao = (id, { event = 'PAYMENT_CONFIRMED', value = 99.9 } = {}) => ({
  event,
  payment: {
    id, value, customer: 'cus_alfa', billingType: 'CREDIT_CARD', externalReference: `tenant:${alfa}`
  }
});

const daquiA = (dias) => new Date(Math.floor((Date.now() + dias * 86_400_000) / 1000) * 1000);

const assinatura = () => Subscription.forTenant(alfa);
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');
/** O "pagar agora" do provedor: o clique explícito, que cobra o cartão já (`cardNow`). */
const emitir = () => runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
  tenant: await Tenant.findById(alfa), manual: true, cardNow: true
}));
const posts = () => recebidas.filter((r) => r.method === 'POST' && r.path === '/payments');

/** Põe o cartão salvo direto pela captura, como um webhook de cartão faria. */
async function salvarCartao(id = 'pay_salvar', token = TOKEN, numero = '4242', bandeira = 'VISA') {
  pagosComCartao.set(id, { token, number: numero, brand: bandeira });
  await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_capture_payment_id: id });
  return runInTenant(alfa, () => CardAutopayService.captureToken());
}

before(async () => {
  escutarLog();
  ({ server: smtp, recebidas: emails } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();
  process.env.ASAAS_BASE_URL = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.BILLING_WEBHOOK_TOKEN = WEBHOOK;

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
  viewerToken = (await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'so-olha', password: 'senha-de-quem-olha-1' }
  })).body?.data?.token;
  assert.ok(viewerToken);

  basico = await Plan.create({
    code: 'cartao-basico', name: 'Básico', price_cents: 9990, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  pro = await Plan.create({
    code: 'cartao-pro', name: 'Pro', price_cents: 39990, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  resetMailTransport();
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => smtp.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas = [];
  criadas = [];
  modoCartao = 'ok';
  pagosComCartao.clear();
  emails.length = 0;
  await getDb()('billing_charges').where({ tenant_id: alfa }).del();
  await getDb()('billing_events').where({ tenant_id: alfa }).del();
  await getDb()('tenants').where({ id: alfa }).update({
    billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa', billing_email: 'financeiro@alfa.test', billing_phone: null
  });
  await Subscription.upsertForTenant(alfa, {
    plan_id: basico.id,
    status: 'active',
    renews_at: daquiA(2),
    trial_ends_at: null,
    canceled_at: null,
    pending_plan_id: null,
    pending_plan_at: null,
    pending_plan_locked_at: null,
    upgraded_at: null,
    billing_exempt_at: null,
    suspended_reason: null,
    proration_due_at: null,
    card_autopay_at: null,
    card_remote_ip: null,
    ...CardAutopayService.CLEARED_CARD
  });
  await SubscriptionService.invalidate(alfa);
});

describe('ligar a cobrança automática', () => {
  it('o dono liga, e o IP de quem pediu fica guardado para o gateway', async () => {
    const resposta = await autopay(true);
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const cartao = resposta.body.data.subscription.card;
    assert.equal(cartao.autopayEnabled, true);
    assert.equal(cartao.saved, false, 'nada salvo até a primeira fatura paga com cartão');
    const linha = await assinatura();
    assert.ok(linha.card_autopay_at);
    assert.equal(linha.card_remote_ip, '127.0.0.1');
    assert.equal('remoteIp' in cartao, false, 'o IP não volta para a tela');

    const trilha = await getDb()('audit_log').where({ tenant_id: alfa }).orderBy('id', 'desc').first();
    assert.equal(JSON.parse(trilha.detail).cardAutopay, true);
  });

  it('quem só olha não liga; o corpo errado é 400; o suspenso é 409', async () => {
    assert.equal((await autopay(true, viewerToken)).status, 403);
    const errado = await pedir('/subscription/autopay', { method: 'PUT', body: { enabled: 'sim' } });
    assert.equal(errado.status, 400);
    assert.equal(errado.body.code, 'invalid');
    await Subscription.upsertForTenant(alfa, { status: 'suspended' });
    await SubscriptionService.invalidate(alfa);
    const suspenso = await autopay(true);
    assert.equal(suspenso.status, 409);
    assert.equal(suspenso.body.code, 'not_changeable');
    assert.equal((await assinatura()).card_autopay_at, null);
  });

  it('o provedor cobrado por outro gateway não liga', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_gateway: 'manual' });
    const resposta = await autopay(true);
    assert.equal(resposta.status, 409);
    assert.equal(resposta.body.code, 'not_billable');
  });
});

describe('o token, salvo depois de um pagamento com cartão', () => {
  it('é lido do gateway fora do webhook, cifrado, e uma vez só', async () => {
    await autopay(true);
    pagosComCartao.set('pay_cartao_1', { token: TOKEN, number: '4242', brand: 'VISA' });

    const entrega = await entregar(pagamentoComCartao('pay_cartao_1'));
    assert.equal(entrega.status, 200);
    assert.equal(entrega.body.code, 'recorded');
    await BillingWebhookController.pendingCardWork;

    const leituras = () => recebidas.filter((r) => r.method === 'GET' && r.path === '/payments/pay_cartao_1');
    assert.equal(leituras().length, 1, 'o token é lido pelo GET do pagamento');
    const linha = await assinatura();
    assert.equal(linha.card_brand, 'VISA');
    assert.equal(linha.card_last4, '4242');
    assert.ok(linha.card_saved_at);
    assert.equal(linha.card_capture_payment_id, null, 'a anotação foi consumida');
    assert.ok(linha.card_token_ciphertext);
    assert.equal(String(linha.card_token_ciphertext).includes(TOKEN), false, 'cifrado no banco');
    assert.equal(CardAutopayService.chargeOptions(linha).creditCardToken, TOKEN, 'e abre de volta');

    // A reentrega e o `RECEIVED` de trinta dias depois: `duplicate`, e nada
    // de ler o gateway de novo nem de reescrever o cartão.
    const salvoEm = String(linha.card_saved_at);
    const reentrega = await entregar(pagamentoComCartao('pay_cartao_1', { event: 'PAYMENT_RECEIVED' }));
    assert.equal(reentrega.body.code, 'duplicate');
    await BillingWebhookController.pendingCardWork;
    assert.equal(leituras().length, 1);
    assert.equal(String((await assinatura()).card_saved_at), salvoEm);

    const tela = await pedir('/subscription');
    assert.deepEqual(
      { ...tela.body.data.subscription.card, autopaySince: null, savedAt: null },
      {
        autopayEnabled: true, autopaySince: null, saved: true, brand: 'VISA', last4: '4242',
        savedAt: null, failedAt: null, failure: null
      }
    );
  });

  it('o mesmo cartão num pagamento novo não duplica nada; outro cartão troca o token', async () => {
    await autopay(true);
    await salvarCartao('pay_a', TOKEN);
    const antes = await assinatura();
    const repetido = await salvarCartao('pay_b', TOKEN);
    assert.equal(repetido.replaced, false);
    const depois = await assinatura();
    assert.equal(depois.card_token_ciphertext, antes.card_token_ciphertext, 'o mesmo token não é reescrito');
    assert.equal(String(depois.card_saved_at), String(antes.card_saved_at));

    const trocado = await salvarCartao('pay_c', TOKEN_NOVO, '1111', 'MASTERCARD');
    assert.equal(trocado.replaced, true);
    const novo = await assinatura();
    assert.equal(novo.card_brand, 'MASTERCARD');
    assert.equal(novo.card_last4, '1111');
    assert.equal(CardAutopayService.chargeOptions(novo).creditCardToken, TOKEN_NOVO);
  });

  it('sem a cobrança automática ligada, o pagamento com cartão não salva nada', async () => {
    pagosComCartao.set('pay_sem_optin', { token: TOKEN, number: '4242', brand: 'VISA' });
    const entrega = await entregar(pagamentoComCartao('pay_sem_optin'));
    assert.equal(entrega.body.code, 'recorded');
    await BillingWebhookController.pendingCardWork;
    assert.equal(recebidas.filter((r) => r.method === 'GET').length, 0);
    assert.equal((await assinatura()).card_token_ciphertext, null);
  });

  it('o gateway fora do ar deixa a anotação, e o agendador termina o serviço', async () => {
    await autopay(true);
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_capture_payment_id: 'pay_tarde' });
    const chave = process.env.ASAAS_API_KEY;
    process.env.ASAAS_API_KEY = 'chave-errada';
    try {
      const falhou = await runInTenant(alfa, () => CardAutopayService.captureToken());
      assert.equal(falhou.captured, false);
      assert.equal((await assinatura()).card_capture_payment_id, 'pay_tarde');
    } finally {
      process.env.ASAAS_API_KEY = chave;
    }
    pagosComCartao.set('pay_tarde', { token: TOKEN, number: '4242', brand: 'VISA' });
    await runInTenant(alfa, async () => SchedulerService.runJobs({ tenant: await Tenant.findById(alfa) }));
    const linha = await assinatura();
    assert.equal(linha.card_capture_payment_id, null);
    assert.equal(linha.card_last4, '4242');
  });
});

describe('a renovação', () => {
  it('sai no cartão salvo, com o token e o IP; sem cartão, pela página de sempre', async () => {
    const semCartao = await emitir();
    assert.equal(semCartao.issued, true, JSON.stringify(semCartao));
    assert.equal(posts()[0].payload.billingType, 'UNDEFINED');
    assert.equal('creditCardToken' in posts()[0].payload, false);
    assert.equal((await cobrancas())[0].billing_type, 'UNDEFINED');

    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    recebidas = [];
    await autopay(true);
    await salvarCartao();
    const comCartao = await emitir();
    assert.equal(comCartao.issued, true, JSON.stringify(comCartao));
    const [pedido] = posts();
    assert.equal(pedido.payload.billingType, 'CREDIT_CARD');
    assert.equal(pedido.payload.creditCardToken, TOKEN);
    assert.equal(pedido.payload.remoteIp, '127.0.0.1');
    const [linha] = await cobrancas();
    assert.equal(linha.billing_type, 'CREDIT_CARD');
    assert.equal((await pedir('/charges')).body.data.charges[0].billingType, 'CREDIT_CARD');
  });

  it('mudar o vencimento de uma cobrança de cartão a mantém de cartão no gateway', async () => {
    await autopay(true);
    await salvarCartao();
    await emitir();
    recebidas = [];
    const [linha] = await cobrancas();
    const de = new Date(`${linha.period_end}T12:00:00-03:00`);
    const para = new Date(de.getTime() + 10 * 86_400_000);
    const movida = await runInTenant(alfa, () => ChargeIssuingService.followDeadline({ from: de, to: para }));
    assert.equal(movida.moved, true, JSON.stringify(movida));
    const atualizacao = recebidas.find((r) => r.method === 'POST' && r.path === `/payments/${linha.gateway_charge_id}`);
    assert.equal(atualizacao.payload.billingType, 'CREDIT_CARD');
  });

  it('a resposta perdida numa cobrança de cartão: a retentativa pergunta ao gateway e adota a que existe', async () => {
    await autopay(true);
    await salvarCartao();
    modoCartao = 'cair';
    const caiu = await emitir();
    assert.equal(caiu.issued, false);
    assert.equal(caiu.reason, 'gateway_failed');
    let [linha] = await cobrancas();
    assert.equal(linha.billing_type, 'CREDIT_CARD', 'fica marcada como tentativa no cartão');
    assert.equal(linha.gateway_charge_id, null);

    modoCartao = 'ok';
    recebidas = [];
    const retentativa = await emitir();
    assert.equal(retentativa.reason, 'already_issued', JSON.stringify(retentativa));
    assert.equal(retentativa.adopted, true);
    assert.equal(posts().length, 0, 'nenhuma segunda cobrança no cartão');
    assert.ok(recebidas.some((r) => r.method === 'GET' && r.path === '/payments' && r.query.includes('externalReference')));
    [linha] = await cobrancas();
    assert.equal(linha.gateway_charge_id, criadas[0].id);
  });
});


describe('a cobrança de cartão sem resposta (revisão)', () => {
  it('o processo morre depois de o gateway criar e antes de gravar: a próxima passada adota, um POST só', async () => {
    await autopay(true);
    await salvarCartao();
    const original = BillingCharge.markIssued;
    BillingCharge.markIssued = async () => { throw new Error('o processo caiu aqui'); };
    try {
      await assert.rejects(emitir(), /o processo caiu/);
    } finally {
      BillingCharge.markIssued = original;
    }
    let [linha] = await cobrancas();
    assert.equal(linha.billing_type, 'CREDIT_CARD');
    assert.equal(linha.gateway_charge_id, null);
    assert.equal(Number(linha.attempts), 0, 'nenhuma tentativa contada: o processo morreu');
    assert.equal(posts().length, 1);
    // A garra vence sozinha.
    await getDb()('billing_charges').where({ id: linha.id }).update({ issuing_until: new Date(Date.now() - 1000) });

    const depois = await runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
      tenant: await Tenant.findById(alfa), now: new Date(Date.now() + 3 * 86_400_000)
    }));
    assert.equal(depois.reason, 'already_issued', JSON.stringify(depois));
    assert.equal(depois.adopted, true);
    assert.equal(posts().length, 1, 'o gateway recebeu um POST só: o cartão foi cobrado uma vez');
    [linha] = await cobrancas();
    assert.equal(linha.gateway_charge_id, criadas[0].id);
  });

  it('a adotada que o gateway já tem como paga é quitada pelo caminho do webhook', async () => {
    await autopay(true);
    await salvarCartao();
    const antes = new Date((await assinatura()).renews_at).getTime();
    modoCartao = 'cair';
    await emitir();
    criadas[0].status = 'CONFIRMED';
    modoCartao = 'ok';
    const retentativa = await emitir();
    assert.equal(retentativa.adopted, true, JSON.stringify(retentativa));
    assert.equal(retentativa.settled, 'recorded');
    const [linha] = await cobrancas();
    assert.equal(linha.status, 'paid');
    const evento = await getDb()('billing_events').where({ tenant_id: alfa, external_id: criadas[0].id }).first();
    assert.ok(evento, 'o pagamento entrou no extrato');
    assert.ok(new Date((await assinatura()).renews_at).getTime() > antes, 'o período andou');

    // O webhook que chega depois é a reentrega: nada de crédito duplo.
    const entrega = await entregar({
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: criadas[0].id, value: 99.9, customer: 'cus_alfa', billingType: 'CREDIT_CARD', externalReference: `tenant:${alfa}:${linha.period_end}`
      }
    });
    assert.equal(entrega.body.code, 'duplicate');
    await BillingWebhookController.pendingCardWork;
  });

  it('a pró-rata de cartão paga lá cujo webhook chegou antes da adoção: reconciliada, sem estender o prazo', async () => {
    await autopay(true);
    await salvarCartao();
    const antes = await assinatura();
    modoCartao = 'cair';
    const quote = {
      eligible: true, renewsAt: new Date(antes.renews_at).toISOString(), fromPlanId: basico.id, toPlanId: pro.id,
      amountCents: 3000, currency: 'BRL', fromPriceCents: 9990, toPriceCents: 39990,
      remainingSeconds: 86_400, periodSeconds: 30 * 86_400, remainingDays: 1
    };
    const criada = await runInTenant(alfa, async () => ChargeIssuingService.createProration({
      tenant: await Tenant.findById(alfa), subscription: antes, quote
    }));
    assert.equal(criada.reason, 'gateway_failed', JSON.stringify(criada));
    let [pr] = (await cobrancas()).filter((c) => c.kind === 'proration');
    assert.equal(pr.billing_type, 'CREDIT_CARD');
    assert.equal(pr.gateway_charge_id, null);

    // O cartão foi cobrado lá, e o webhook chega ANTES de a linha conhecer o
    // id: é conferido contra o preço do plano, e fica "a menos".
    criadas[0].status = 'CONFIRMED';
    const entrega = await entregar({
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: criadas[0].id, value: 30, customer: 'cus_alfa', billingType: 'CREDIT_CARD', externalReference: `tenant:${alfa}:proration:${pr.id}`
      }
    });
    assert.equal(entrega.body.code, 'underpaid');
    await BillingWebhookController.pendingCardWork;

    modoCartao = 'ok';
    recebidas = [];
    const retentativa = await runInTenant(alfa, async () => ChargeIssuingService.retryProrations({
      tenant: await Tenant.findById(alfa), manual: true, chargeId: pr.id
    }));
    assert.equal(retentativa.result.adopted, true, JSON.stringify(retentativa));
    assert.equal(retentativa.result.settled, 'reconciled');
    assert.equal(posts().length, 0, 'nenhuma segunda cobrança no cartão');
    [pr] = (await cobrancas()).filter((c) => c.kind === 'proration');
    assert.equal(pr.status, 'paid');
    assert.equal(pr.gateway_charge_id, criadas[0].id);
    const depois = await assinatura();
    assert.equal(depois.proration_due_at, null);
    assert.equal(String(depois.renews_at), String(antes.renews_at), 'a pró-rata não compra período');
    const aceite = await getDb()('billing_events').where({ tenant_id: alfa, external_id: `${criadas[0].id}:accepted` }).first();
    assert.ok(aceite, 'a diferença conferida contra o plano foi aceita pela linha');
  });

  it('desligar a cobrança automática no meio da emissão: a cobrança sai como Pix/boleto', async () => {
    await autopay(true);
    await salvarCartao();
    const original = BillingCharge.open;
    BillingCharge.open = async (args) => {
      const id = await original.call(BillingCharge, args);
      await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_autopay_at: null });
      return id;
    };
    let resultado;
    try {
      resultado = await emitir();
    } finally {
      BillingCharge.open = original;
    }
    assert.equal(resultado.issued, true, JSON.stringify(resultado));
    assert.equal(resultado.billingType, 'UNDEFINED');
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].payload.billingType, 'UNDEFINED');
    assert.equal('creditCardToken' in posts()[0].payload, false);
    assert.equal((await cobrancas())[0].billing_type, 'UNDEFINED');
  });
});

describe('o erro do gateway na cobrança de cartão (revisão)', () => {
  it('classifyError: só a recusa que fala do cartão é do cartão', () => {
    const erro = (status, errors, code = status === 401 ? 'unauthorized' : status < 500 ? 'refused' : 'gateway_error') => ({
      status, code, errors, message: `gateway answered ${status}`
    });
    assert.equal(CardAutopayService.classifyError(erro(400, [{ code: 'invalid_creditCard', description: 'x' }])), 'refused');
    assert.equal(CardAutopayService.classifyError(erro(400, [{ code: 'invalid_action', description: 'Cartão recusado pela operadora' }])), 'refused');
    assert.equal(CardAutopayService.classifyError(erro(400, [{ code: 'invalid_customer', description: 'Cliente inexistente' }])), 'rejected');
    assert.equal(CardAutopayService.classifyError(erro(429, [])), 'safe');
    assert.equal(CardAutopayService.classifyError(erro(503, [])), 'ambiguous');
    assert.equal(CardAutopayService.classifyError({ code: 'unreachable' }), 'ambiguous');
    assert.equal(CardAutopayService.classifyError({ code: 'not_configured' }), 'safe');
  });

  it('a recusa que não é do cartão sai como Pix/boleto sem marcar o cartão nem avisar', async () => {
    await autopay(true);
    await salvarCartao();
    modoCartao = 'rejeitar';
    const resultado = await emitir();
    assert.equal(resultado.issued, true, JSON.stringify(resultado));
    assert.equal(resultado.billingType, 'UNDEFINED');
    assert.equal(resultado.cardRefused, undefined);
    const sub = await assinatura();
    assert.equal(sub.card_failed_at, null, 'o cartão não é marcado');
    assert.equal(emails.length, 0, 'nada de "cartão recusado"');
    assert.equal(CardAutopayService.usable(sub), true);
  });

  it('429 é tentar de novo depois, com o cartão', async () => {
    await autopay(true);
    await salvarCartao();
    modoCartao = 'limite';
    const resultado = await emitir();
    assert.equal(resultado.issued, false);
    assert.equal(resultado.reason, 'gateway_failed');
    const [linha] = await cobrancas();
    assert.equal(linha.billing_type, null, 'nada foi processado: a próxima tentativa pode usar o cartão');
    assert.equal((await assinatura()).card_failed_at, null);
    assert.equal(emails.length, 0);
  });
});

describe('a recusa', () => {
  it('na criação: o cartão fica marcado, a fatura sai como Pix/boleto na hora e o provedor é avisado', async () => {
    await autopay(true);
    await salvarCartao();
    modoCartao = 'recusar';
    const resultado = await emitir();
    assert.equal(resultado.issued, true, JSON.stringify(resultado));
    assert.equal(resultado.cardRefused, true);
    const [primeiro, segundo] = posts();
    assert.equal(primeiro.payload.billingType, 'CREDIT_CARD');
    assert.equal(segundo.payload.billingType, 'UNDEFINED');
    assert.equal('creditCardToken' in segundo.payload, false);

    const [linha] = await cobrancas();
    assert.equal(linha.billing_type, 'UNDEFINED');
    assert.ok(linha.invoice_url);
    const sub = await assinatura();
    assert.ok(sub.card_failed_at);
    assert.equal(sub.card_failure, 'charge_refused');
    assert.ok(sub.card_failure_notified_at, 'o aviso saiu');
    assert.equal(emails.length, 1);
    const mensagem = decodificarQuotedPrintable(emails[0]);
    assert.ok(mensagem.includes(linha.invoice_url), 'o aviso leva o link da fatura nova');

    // A próxima fatura não tenta o cartão.
    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    recebidas = [];
    modoCartao = 'ok';
    await emitir();
    assert.equal(posts()[0].payload.billingType, 'UNDEFINED');

    const tela = (await pedir('/subscription')).body.data.subscription.card;
    assert.equal(tela.failure, 'charge_refused');
    assert.ok(tela.failedAt);

    // Até um pagamento novo com cartão, que troca o token e limpa a falha.
    await salvarCartao('pay_de_novo', TOKEN_NOVO, '5555', 'ELO');
    const limpo = await assinatura();
    assert.equal(limpo.card_failed_at, null);
    assert.equal(CardAutopayService.usable(limpo), true);
  });

  it('na captura (webhook): reemite como Pix/boleto fora da entrega, avisa uma vez, e a reentrega não repete', async () => {
    await autopay(true);
    await salvarCartao();
    await emitir();
    const [deCartao] = await cobrancas();
    assert.equal(deCartao.billing_type, 'CREDIT_CARD');
    recebidas = [];

    const recusa = {
      event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
      payment: {
        id: deCartao.gateway_charge_id, value: 99.9, customer: 'cus_alfa', billingType: 'CREDIT_CARD',
        externalReference: `tenant:${alfa}:${deCartao.period_end}`
      }
    };
    const entrega = await entregar(recusa);
    assert.equal(entrega.status, 200);
    assert.equal(entrega.body.code, 'card_refused');
    await BillingWebhookController.pendingCardWork;

    assert.ok(recebidas.some((r) => r.method === 'DELETE' && r.path === `/payments/${deCartao.gateway_charge_id}`),
      'a cobrança de cartão é cancelada no gateway');
    const [nova] = posts();
    assert.equal(nova.payload.billingType, 'UNDEFINED');
    const [linha] = await cobrancas();
    assert.equal(linha.id, deCartao.id, 'a mesma linha, reemitida');
    assert.equal(linha.billing_type, 'UNDEFINED');
    assert.notEqual(linha.gateway_charge_id, deCartao.gateway_charge_id);
    assert.ok(JSON.parse(linha.superseded_charges).some((item) => item.id === deCartao.gateway_charge_id));
    const sub = await assinatura();
    assert.equal(sub.card_failure, 'capture_refused');
    assert.equal(emails.length, 1);

    const reentrega = await entregar(recusa);
    assert.equal(reentrega.body.code, 'no_charge', 'o id velho não é mais desta linha');
    await runInTenant(alfa, () => CardAutopayService.processDue());
    assert.equal(emails.length, 1, 'o aviso não se repete');
    assert.equal(posts().length, 1);
  });

  it('a recusa de um cartão digitado numa fatura de Pix/boleto não mexe no cartão salvo', async () => {
    await autopay(true);
    await salvarCartao();
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_autopay_at: null });
    await emitir();
    const [linha] = await cobrancas();
    assert.equal(linha.billing_type, 'UNDEFINED');
    const entrega = await entregar({
      event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
      payment: { id: linha.gateway_charge_id, value: 99.9, customer: 'cus_alfa', externalReference: `tenant:${alfa}` }
    });
    assert.equal(entrega.body.code, 'unchanged');
    assert.equal((await assinatura()).card_failed_at, null);
  });
});

describe('remover o cartão e desligar', () => {
  it('remover apaga o token e devolve a cobrança de cartão em aberto para Pix/boleto', async () => {
    await autopay(true);
    await salvarCartao();
    await emitir();
    const [deCartao] = await cobrancas();
    recebidas = [];

    assert.equal((await removerCartao(viewerToken)).status, 403);
    const resposta = await removerCartao();
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const cartao = resposta.body.data.subscription.card;
    assert.equal(cartao.saved, false);
    assert.equal(cartao.last4, null);
    assert.equal(cartao.autopayEnabled, true, 'a intenção fica: o próximo pagamento com cartão salva o novo');

    const sub = await assinatura();
    for (const coluna of ['card_token_ciphertext', 'card_token_iv', 'card_token_tag', 'card_brand', 'card_last4', 'card_saved_at']) {
      assert.equal(sub[coluna], null, coluna);
    }
    assert.ok(recebidas.some((r) => r.method === 'DELETE' && r.path === `/payments/${deCartao.gateway_charge_id}`));
    assert.equal(posts()[0].payload.billingType, 'UNDEFINED');
    assert.equal((await cobrancas())[0].billing_type, 'UNDEFINED');

    const trilha = await getDb()('audit_log').where({ tenant_id: alfa }).orderBy('id', 'desc').first();
    const detalhe = JSON.parse(trilha.detail);
    assert.equal(detalhe.cardRemoved, true);
    assert.equal(detalhe.last4, '4242');

    const deNovo = await removerCartao();
    assert.equal(deNovo.status, 200, 'sem cartão, nada muda e não é erro');
  });

  it('desligar mantém o cartão, mas a cobrança de cartão em aberto vira Pix/boleto', async () => {
    await autopay(true);
    await salvarCartao();
    await emitir();
    recebidas = [];
    const resposta = await autopay(false);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.data.subscription.card.autopayEnabled, false);
    assert.equal(resposta.body.data.subscription.card.saved, true);
    assert.equal(posts()[0].payload.billingType, 'UNDEFINED');
    assert.equal((await cobrancas())[0].billing_type, 'UNDEFINED');
  });
});

describe('o token nunca aparece', () => {
  it('em resposta nenhuma, na trilha, nas cobranças, no console ou no log', async () => {
    // Um ciclo inteiro: ligar, salvar pelo webhook, cobrar, recusar, ver.
    await autopay(true);
    pagosComCartao.set('pay_vazamento', { token: TOKEN, number: '4242', brand: 'VISA' });
    await entregar(pagamentoComCartao('pay_vazamento'));
    await BillingWebhookController.pendingCardWork;
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: daquiA(2) });
    modoCartao = 'recusar';
    await emitir();
    await pedir('/subscription');
    await pedir('/charges');
    await removerCartao();

    const vista = await runInTenant(alfa, async () => subscriptionView(await Tenant.findById(alfa)));
    respostas.push(JSON.stringify(vista));

    const procurar = (onde, texto) => {
      assert.equal(String(texto).includes(TOKEN), false, `o token apareceu em ${onde}`);
      assert.equal(String(texto).includes(TOKEN_NOVO), false, `o token apareceu em ${onde}`);
    };
    for (const corpo of respostas) procurar('uma resposta', corpo);
    for (const linha of await getDb()('audit_log')) procurar('audit_log', JSON.stringify(linha));
    for (const linha of await getDb()('platform_audit')) procurar('platform_audit', JSON.stringify(linha));
    for (const linha of await getDb()('billing_charges')) procurar('billing_charges', JSON.stringify(linha));
    for (const linha of await getDb()('billing_events')) procurar('billing_events', JSON.stringify(linha));
    for (const linha of linhasDeLog) procurar('o log', linha);
    for (const mensagem of emails) procurar('um e-mail', mensagem);
    // A varredura vale alguma coisa: o token de fato viajou até o gateway...
    assert.ok(recebidas.some((r) => JSON.stringify(r.payload ?? {}).includes(TOKEN)), 'o token foi ao gateway');
    // ...e o gateway o ecoou na recusa, que chegou ao log sem ele.
    assert.ok(linhasDeLog.some((linha) => linha.includes('was refused') && linha.includes('[redacted]')),
      'a recusa foi registrada, com o token tirado');
  });
});

/** Os POSTs de criação de uma fatura de pró-rata (0101). */
const postsDeProrata = () => posts().filter((r) => /:proration:/.test(r.payload?.externalReference ?? ''));
const prorratas = async () => (await cobrancas()).filter((c) => c.kind === 'proration');
const trocar = (planId) => pedir('/subscription/plan', { method: 'PUT', body: { planId } });

describe('a pró-rata da subida (0101) no cartão salvo', () => {
  beforeEach(async () => {
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: daquiA(15) });
    await SubscriptionService.invalidate(alfa);
  });

  it('com a cobrança automática utilizável, sai no cartão — sem multa, juros nem desconto', async () => {
    await autopay(true);
    await salvarCartao();
    const res = await trocar(pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.proration.issued, true, JSON.stringify(res.body.data.proration));
    const [pedido] = postsDeProrata();
    assert.equal(pedido.payload.billingType, 'CREDIT_CARD');
    assert.equal(pedido.payload.creditCardToken, TOKEN);
    assert.equal(pedido.payload.remoteIp, '127.0.0.1');
    for (const campo of ['fine', 'interest', 'discount']) assert.equal(pedido.payload[campo], undefined, campo);
    const [linha] = await prorratas();
    assert.equal(linha.billing_type, 'CREDIT_CARD');
    assert.ok(linha.gateway_charge_id);
  });

  it('sem cartão, pela página de sempre', async () => {
    const res = await trocar(pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [pedido] = postsDeProrata();
    assert.equal(pedido.payload.billingType, 'UNDEFINED');
    assert.equal('creditCardToken' in pedido.payload, false);
    assert.equal((await prorratas())[0].billing_type, 'UNDEFINED');
  });

  it('o cartão recusado: marca a falha, reemite como Pix/boleto na hora e avisa com o link DELA', async () => {
    await autopay(true);
    await salvarCartao();
    modoCartao = 'recusar';
    const res = await trocar(pro.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.proration.issued, true);
    const [primeiro, segundo] = postsDeProrata();
    assert.equal(primeiro.payload.billingType, 'CREDIT_CARD');
    assert.equal(segundo.payload.billingType, 'UNDEFINED');
    assert.equal(primeiro.payload.externalReference, segundo.payload.externalReference, 'a mesma linha, a mesma referência');
    assert.equal('creditCardToken' in segundo.payload, false);

    const [linha] = await prorratas();
    assert.equal(linha.billing_type, 'UNDEFINED');
    assert.ok(linha.invoice_url);
    const sub = await assinatura();
    assert.ok(sub.card_failed_at);
    assert.equal(sub.card_failure, 'charge_refused');
    assert.ok(sub.card_failure_notified_at);
    assert.equal(emails.length, 1);
    assert.ok(decodificarQuotedPrintable(emails[0]).includes(linha.invoice_url), 'o aviso leva o link da pró-rata');
  });

  it('a resposta perdida: a retentativa pergunta ao gateway e adota a que existe', async () => {
    await autopay(true);
    await salvarCartao();
    modoCartao = 'cair';
    assert.equal((await trocar(pro.id)).status, 200);
    let [linha] = await prorratas();
    assert.equal(linha.billing_type, 'CREDIT_CARD');
    assert.equal(linha.gateway_charge_id, null);

    modoCartao = 'ok';
    recebidas = [];
    const passada = await runInTenant(alfa, async () => ChargeIssuingService.retryProrations({
      tenant: await Tenant.findById(alfa), manual: true
    }));
    assert.equal(passada.retried, 1);
    assert.equal(posts().length, 0, 'nenhuma segunda cobrança no cartão');
    [linha] = await prorratas();
    assert.equal(linha.gateway_charge_id, criadas[0].id);
  });

  it('a recusa na captura (webhook) reemite a pró-rata sem o cartão', async () => {
    await autopay(true);
    await salvarCartao();
    assert.equal((await trocar(pro.id)).status, 200);
    const [deCartao] = await prorratas();
    assert.equal(deCartao.billing_type, 'CREDIT_CARD');
    recebidas = [];

    const entrega = await entregar({
      event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
      payment: {
        id: deCartao.gateway_charge_id, value: Number(deCartao.amount_cents) / 100, customer: 'cus_alfa',
        billingType: 'CREDIT_CARD', externalReference: `tenant:${alfa}:proration:${deCartao.id}`
      }
    });
    assert.equal(entrega.body.code, 'card_refused');
    await BillingWebhookController.pendingCardWork;

    assert.ok(recebidas.some((r) => r.method === 'DELETE' && r.path === `/payments/${deCartao.gateway_charge_id}`));
    const [nova] = postsDeProrata();
    assert.equal(nova.payload.billingType, 'UNDEFINED');
    const [linha] = await prorratas();
    assert.equal(linha.id, deCartao.id);
    assert.equal(linha.billing_type, 'UNDEFINED');
    assert.ok(linha.gateway_charge_id && linha.gateway_charge_id !== deCartao.gateway_charge_id);
  });
});

describe('a antecedência da renovação no cartão', () => {
  /** Um prazo às 15h (São Paulo) daqui a alguns dias, e instantes relativos a ele. */
  const prazo = () => new Date(`${ChargeIssuingService.isoDate(daquiA(4))}T15:00:00-03:00`);
  const horasAntes = (h) => new Date(prazo().getTime() - h * 3_600_000);
  const agendador = (now) => runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
    tenant: await Tenant.findById(alfa), now
  }));

  beforeEach(async () => {
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: prazo() });
    await SubscriptionService.invalidate(alfa);
  });

  it('Pix/boleto sai LEAD_DAYS antes; o cartão, só no dia do vencimento', async () => {
    // Sem cartão: três dias antes já está na janela.
    const semCartao = await agendador(horasAntes(72));
    assert.equal(semCartao.issued, true, JSON.stringify(semCartao));
    assert.equal(semCartao.billingType, 'UNDEFINED');

    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    recebidas = [];
    await autopay(true);
    await salvarCartao();
    for (const h of [72, 24]) {
      // eslint-disable-next-line no-await-in-loop
      const cedo = await agendador(horasAntes(h));
      assert.equal(cedo.reason, 'not_due_yet', `${h}h antes não cobra o cartão`);
    }
    assert.equal(posts().length, 0);

    // No dia, desde a manhã: sai no cartão, vencendo no dia.
    const noDia = await agendador(horasAntes(6));
    assert.equal(noDia.issued, true, JSON.stringify(noDia));
    assert.equal(noDia.billingType, 'CREDIT_CARD');
    assert.equal(posts()[0].payload.dueDate, ChargeIssuingService.isoDate(prazo()));
  });

  it('o "pagar agora" (cardNow) emite no cartão antes do dia', async () => {
    await autopay(true);
    await salvarCartao();
    const clique = await runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
      tenant: await Tenant.findById(alfa), now: horasAntes(72), manual: true, cardNow: true
    }));
    assert.equal(clique.issued, true, JSON.stringify(clique));
    assert.equal(clique.billingType, 'CREDIT_CARD');
  });

  it('a reemissão por clique que não é "pagar agora" não cobra o cartão antes do dia', async () => {
    await autopay(true);
    await salvarCartao();
    const reemissao = await runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
      tenant: await Tenant.findById(alfa), now: horasAntes(72), manual: true
    }));
    assert.equal(reemissao.issued, false, JSON.stringify(reemissao));
    assert.equal(reemissao.reason, 'card_deferred');
    assert.equal(posts().length, 0, 'nada vai ao gateway antes do vencimento');

    // A linha reaberta (a cancelada pela troca de plano, o console) fica sem
    // id, e o agendador a emite no cartão no dia.
    await getDb()('billing_charges').insert({
      tenant_id: alfa, period_end: ChargeIssuingService.periodKey(prazo()), amount_cents: 9990, currency: 'BRL',
      provider: 'asaas', status: 'canceled', attempts: 5, created_at: new Date(), updated_at: new Date()
    });
    const console = await runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({
      tenant: await Tenant.findById(alfa), now: horasAntes(72), manual: true
    }));
    assert.equal(console.reason, 'card_deferred', JSON.stringify(console));
    assert.equal(console.charge.status, 'pending');
    assert.equal(console.charge.gateway_charge_id, null);
    assert.equal(Number(console.charge.attempts), 0, 'a paciência do agendador volta a zero');
    assert.equal(posts().length, 0);

    const noDia = await agendador(horasAntes(1));
    assert.equal(noDia.issued, true, JSON.stringify(noDia));
    assert.equal(noDia.billingType, 'CREDIT_CARD');
    assert.equal(posts().length, 1);
  });

  it('a troca de plano e o cupom não cobram o cartão antes do dia', async () => {
    await autopay(true);
    await salvarCartao();
    const ate = daquiA(20);
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: ate });
    await SubscriptionService.invalidate(alfa);
    // A cobrança do período já saiu no cartão pelo "pagar agora"…
    const paga = await emitir();
    assert.equal(paga.issued, true, JSON.stringify(paga));
    recebidas = [];
    // …e a subida cancela e reemite pela porta da troca: sem cartão agora.
    const troca = await pedir('/subscription/plan', { method: 'PUT', body: { planId: pro.id } });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    const novas = posts().filter((p) => !String(p.payload.externalReference).includes(':proration:'));
    assert.equal(novas.length, 0, 'a renovação reemitida espera o vencimento');
    const [linha] = (await cobrancas()).filter((c) => c.kind !== 'proration');
    assert.equal(linha.gateway_charge_id, null);
    assert.equal(linha.status, 'pending');
  });

  it('o cartão recusado volta à antecedência de Pix/boleto', async () => {
    await autopay(true);
    await salvarCartao();
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_failed_at: new Date(), card_failure: 'charge_refused' });
    const res = await agendador(horasAntes(72));
    assert.equal(res.issued, true, JSON.stringify(res));
    assert.equal(res.billingType, 'UNDEFINED');
  });
});

describe('os lembretes com a cobrança automática no cartão', () => {
  const lembrar = () => runInTenant(alfa, async () => SubscriptionNoticeService.notifyCurrent({
    tenant: await Tenant.findById(alfa)
  }));
  const prazoEm = async (dias) => {
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ renews_at: daquiA(dias) });
    await SubscriptionService.invalidate(alfa);
  };

  beforeEach(async () => {
    await getDb()('subscription_reminder_sends').where({ tenant_id: alfa }).del();
  });

  it('`before` não sai para quem paga no cartão; sem o cartão, sai', async () => {
    await autopay(true);
    await salvarCartao();
    await prazoEm(2);
    const pulado = await lembrar();
    assert.equal(pulado.sent, false);
    assert.equal(pulado.reason, 'card_autopay');
    assert.equal(emails.length, 0);

    await autopay(false);
    await SubscriptionService.invalidate(alfa);
    const enviado = await lembrar();
    assert.equal(enviado.sent, true, JSON.stringify(enviado));
    assert.equal(enviado.step, 'before');
    assert.equal(emails.length, 1);
  });

  it('`due` espera a cobrança do cartão; recusado o cartão, sai', async () => {
    await autopay(true);
    await salvarCartao();
    await prazoEm(-1);
    assert.equal((await emitir()).billingType, 'CREDIT_CARD');
    const pulado = await lembrar();
    assert.equal(pulado.reason, 'card_autopay');
    assert.equal(pulado.step, 'due');
    assert.equal(emails.length, 0);

    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_failed_at: new Date(), card_failure: 'capture_refused' });
    await SubscriptionService.invalidate(alfa);
    const enviado = await lembrar();
    assert.equal(enviado.sent, true, JSON.stringify(enviado));
    assert.equal(enviado.step, 'due');
  });

  it('`after` — ainda sem pagamento dias depois — sai mesmo com o cartão', async () => {
    await autopay(true);
    await salvarCartao();
    await prazoEm(-4);
    await emitir();
    const enviado = await lembrar();
    assert.equal(enviado.sent, true, JSON.stringify(enviado));
    assert.equal(enviado.step, 'after');
  });
});

describe('o suspenso pela inadimplência (0102) com o cartão salvo', () => {
  beforeEach(async () => {
    await autopay(true);
    await salvarCartao();
    await getDb()('subscriptions').where({ tenant_id: alfa })
      .update({ status: 'suspended', suspended_reason: 'auto_nonpayment', renews_at: daquiA(-20) });
    await SubscriptionService.invalidate(alfa);
  });

  it('a emissão do agendador continua e sai no cartão', async () => {
    const res = await runInTenant(alfa, async () => ChargeIssuingService.issueCurrent({ tenant: await Tenant.findById(alfa) }));
    assert.equal(res.issued, true, JSON.stringify(res));
    assert.equal(res.billingType, 'CREDIT_CARD');
    assert.equal(posts()[0].payload.creditCardToken, TOKEN);
  });

  it('o cartão que deixa de valer: a cobrança de cartão volta a Pix/boleto também para ele', async () => {
    await emitir();
    const [deCartao] = await cobrancas();
    assert.equal(deCartao.billing_type, 'CREDIT_CARD');
    recebidas = [];
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_failed_at: new Date(), card_failure: 'capture_refused' });
    const res = await runInTenant(alfa, async () => CardAutopayService.reissueIneligible({ tenant: await Tenant.findById(alfa) }));
    assert.equal(res.reissued, 1, JSON.stringify(res));
    assert.equal(posts()[0].payload.billingType, 'UNDEFINED');
    assert.equal((await cobrancas())[0].billing_type, 'UNDEFINED');
  });

  it('o suspenso a dedo continua sem reemissão', async () => {
    await emitir();
    await getDb()('subscriptions').where({ tenant_id: alfa })
      .update({ suspended_reason: 'manual', card_failed_at: new Date(), card_failure: 'capture_refused' });
    recebidas = [];
    const res = await runInTenant(alfa, async () => CardAutopayService.reissueIneligible({ tenant: await Tenant.findById(alfa) }));
    assert.equal(res.reissued, 0);
    assert.equal(posts().length, 0);
  });
});
