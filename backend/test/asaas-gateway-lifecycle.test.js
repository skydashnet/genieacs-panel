import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { AsaasBillingProvider } = await import('../src/services/billing/asaasBillingProvider.js');
const { testConnection, createCustomer, AsaasError } = await import('../src/services/billing/asaasClient.js');
const { default: PlatformIntegrationsController } = await import(
  '../src/controllers/platformIntegrationsController.js'
);
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');

/**
 * As duas chamadas novas que saem para o gateway, e os eventos do ciclo de
 * vida de uma cobrança que chegam dele.
 *
 * Self-hosted, e é por isso que este arquivo existe à parte de
 * `platform-integrations.test.js`: só fora da SaaS o cliente aceita falar com
 * `127.0.0.1`, e é contra um servidor de mentira ali que se assere a
 * requisição que SAI — caminho, credencial e cada campo do corpo. A rota do
 * console não existe nesta edição, então a criação do cliente é exercida pelo
 * controlador direto, com a mesma requisição que a rota lhe daria.
 */
const CHAVE = 'chave-do-deploy-para-o-ciclo';
const TOKEN = 'token-do-webhook-do-ciclo';

let gateway;
let recebidas = [];
let semCommercialInfo = false;
let panelUrl;
let alfa;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      recebidas.push({ method: req.method, path: caminho, accessToken: req.headers.access_token, payload });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== CHAVE) return responder(401, { errors: [{ code: 'invalid_access_token' }] });
      if (req.method === 'GET' && caminho === '/myAccount/commercialInfo') {
        return semCommercialInfo ? responder(404, {}) : responder(200, { companyName: 'Plataforma SA', name: 'Fulano' });
      }
      if (req.method === 'GET' && caminho === '/finance/balance') return responder(200, { balance: 10 });
      if (req.method === 'POST' && caminho === '/customers') {
        if (payload?.cpfCnpj === '00000000000') return responder(400, { errors: [{ description: 'CPF inválido' }] });
        return responder(200, { id: 'cus_criado_1', name: payload?.name });
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
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(() => {
  recebidas = [];
  semCommercialInfo = false;
});

describe('o teste de conexão', () => {
  it('lê o nome da conta com a credencial de saída', async () => {
    const res = await testConnection();
    assert.deepEqual(res, { accountName: 'Plataforma SA' });
    assert.equal(recebidas.length, 1);
    assert.equal(recebidas[0].method, 'GET');
    assert.equal(recebidas[0].path, '/myAccount/commercialInfo');
    assert.equal(recebidas[0].accessToken, CHAVE);
  });

  it('e cai para o saldo quando o gateway não conhece o caminho', async () => {
    semCommercialInfo = true;
    const res = await testConnection();
    assert.deepEqual(res, { accountName: null });
    assert.deepEqual(recebidas.map((r) => r.path), ['/myAccount/commercialInfo', '/finance/balance']);
  });

  it('e a chave recusada sobe como `unauthorized`', async () => {
    process.env.ASAAS_API_KEY = 'outra-chave';
    try {
      await assert.rejects(testConnection(), (error) => {
        assert.ok(error instanceof AsaasError);
        assert.equal(error.code, 'unauthorized');
        return true;
      });
    } finally {
      process.env.ASAAS_API_KEY = CHAVE;
    }
  });
});

/** O que o controlador precisa de uma requisição e de uma resposta. */
function chamarControlador(handler, { params = {}, body = {} } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(codigo) { this.statusCode = codigo; return this; },
    json(corpo) { this.body = corpo; return this; }
  };
  const req = { params, body, user: { userId: 1, username: 'a-dona' }, ip: '127.0.0.1' };
  return Promise.resolve(handler(req, res)).then(() => res);
}

describe('o provedor criado como cliente no gateway', () => {
  beforeEach(async () => {
    await getDb()('tenants').where({ id: alfa }).update({
      billing_gateway: null,
      billing_customer_ref: null,
      billing_legal_name: 'Alfa Telecom Ltda',
      billing_tax_id: '12.345.678/0001-95',
      billing_email: 'financeiro@alfa.test',
      billing_phone: '(11) 98765-4321',
      billing_postal_code: '01310100',
      billing_address_line: 'Av. Paulista',
      billing_address_number: '1000',
      billing_address_extra: 'sala 12',
      billing_district: 'Bela Vista'
    });
  });

  it('manda o cadastro fiscal nos nomes do gateway e liga o provedor', async () => {
    const res = await chamarControlador(PlatformIntegrationsController.createAsaasCustomer, {
      params: { id: String(alfa) }
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, {
      id: alfa, gateway: { gateway: 'asaas', customerRef: 'cus_criado_1' }
    });

    assert.equal(recebidas.length, 1);
    const pedido = recebidas[0];
    assert.equal(pedido.method, 'POST');
    assert.equal(pedido.path, '/customers');
    assert.equal(pedido.accessToken, CHAVE);
    assert.deepEqual(pedido.payload, {
      name: 'Alfa Telecom Ltda',
      cpfCnpj: '12345678000195',
      externalReference: `tenant:${alfa}`,
      notificationDisabled: true,
      email: 'financeiro@alfa.test',
      mobilePhone: '11987654321',
      postalCode: '01310100',
      address: 'Av. Paulista',
      addressNumber: '1000',
      complement: 'sala 12',
      province: 'Bela Vista'
    });

    const linha = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(linha.billing_gateway, 'asaas');
    assert.equal(linha.billing_customer_ref, 'cus_criado_1');

    const trilha = await getDb()('platform_audit')
      .where({ action: 'tenant.gateway_customer_created', tenant_id: alfa }).first();
    assert.ok(trilha);
    assert.deepEqual(JSON.parse(trilha.detail), { gateway: 'asaas', linked: true });
    assert.equal(trilha.detail.includes('cus_criado_1'), false, 'o id do cliente não vai para a trilha');
  });

  it('e a recusa do gateway responde 422 e não liga nada', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_tax_id: '000.000.000-00' });
    const res = await chamarControlador(PlatformIntegrationsController.createAsaasCustomer, {
      params: { id: String(alfa) }
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, 'refused');
    const linha = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(linha.billing_customer_ref, null);
  });

  it('e um cliente sem id na volta é erro, não vínculo vazio', async () => {
    // Pela função do cliente direto: o gateway de mentira sempre devolve id,
    // então aqui se confere só que o contrato do retorno é o id.
    const { customerId } = await createCustomer({ name: 'X', cpfCnpj: '12345678909' });
    assert.equal(customerId, 'cus_criado_1');
  });
});

describe('a leitura dos eventos do ciclo, pura', () => {
  const corpo = (event, extra = {}) => ({
    event, payment: { id: 'pay_c', customer: 'cus_x', externalReference: 'tenant:3:2026-10-01', ...extra }
  });

  it('traduz os três eventos para os estados do painel', () => {
    assert.equal(AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_OVERDUE')).status, 'overdue');
    assert.equal(AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_DELETED')).status, 'canceled');
    const estorno = AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_REFUNDED'));
    assert.deepEqual(estorno, {
      event: 'PAYMENT_REFUNDED', status: 'refunded', externalId: 'pay_c',
      customerRef: 'cus_x', reference: 'tenant:3:2026-10-01',
      partial: false, refundedCents: null, valueCents: null
    });
  });

  it('e só chama de parcial o estorno que o corpo PROVA que é', () => {
    const ler = (extra) => AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_REFUNDED', extra));
    const parcial = ler({ value: 100, refunds: [{ status: 'DONE', value: 40 }, { status: 'CANCELLED', value: 60 }] });
    assert.equal(parcial.partial, true);
    assert.equal(parcial.refundedCents, 4000);
    assert.equal(parcial.valueCents, 10000);
    assert.equal(ler({ value: 100, refunds: [{ status: 'DONE', value: 100 }] }).partial, false);
    assert.equal(ler({ value: 100, refundedValue: 30 }).partial, true);
    assert.equal(ler({ value: 100 }).partial, false, 'sem como saber, é o inteiro que o nome diz');
    assert.equal(AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_OVERDUE', { value: 100 })).partial, undefined);
  });

  it('e nunca lê um evento de crédito, nem um corpo sem id', () => {
    assert.equal(AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_RECEIVED')), null);
    assert.equal(AsaasBillingProvider.interpretarCiclo(corpo('PAYMENT_CONFIRMED')), null);
    assert.equal(AsaasBillingProvider.interpretarCiclo({ event: 'PAYMENT_OVERDUE' }), null);
    assert.equal(AsaasBillingProvider.interpretarCiclo({ event: 'PAYMENT_OVERDUE', payment: {} }), null);
    // E o inverso: o crédito não lê evento de ciclo.
    assert.equal(AsaasBillingProvider.interpretar(corpo('PAYMENT_REFUNDED', { value: 10 })), null);
  });
});

describe('os eventos do ciclo chegando pela rota', () => {
  let periodo = 0;
  const RENOVA = new Date('2026-01-01T00:00:00Z');

  const entregar = (corpo) => call(`${panelUrl}/api/billing-webhook`, {
    method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: corpo
  });
  const evento = (event, id, extra = {}) => ({
    event, payment: { id, value: 199.9, customer: 'cus_alfa', ...extra }
  });
  const estadoDe = async (gatewayId) =>
    (await getDb()('billing_charges').where({ gateway_charge_id: gatewayId }).first())?.status;

  /** Uma cobrança emitida, com id no gateway, num período próprio. */
  async function emitida(gatewayId) {
    periodo += 1;
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: `2027-${String(periodo).padStart(2, '0')}-01`,
        amountCents: 19990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, { gatewayChargeId: gatewayId, invoiceUrl: `https://g.test/${gatewayId}` });
    });
  }

  beforeEach(async () => {
    const db = getDb();
    await db('tenants').where({ id: alfa }).update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_alfa' });
    await db('billing_events').del();
    await db('subscriptions').del();
    const plano = await runInTenant(alfa, () => Plan.list()).then((lista) => lista[0]);
    await runInTenant(alfa, () => Subscription.upsertForTenant(alfa, {
      plan_id: plano.id, status: 'past_due', renews_at: RENOVA, trial_ends_at: null
    }));
  });

  it('PAYMENT_OVERDUE marca `overdue`, e ela continua em aberto', async () => {
    await emitida('pay_atrasada');
    const res = await entregar(evento('PAYMENT_OVERDUE', 'pay_atrasada'));
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'charge_updated');
    assert.equal(await estadoDe('pay_atrasada'), 'overdue');

    const aberta = await runInTenant(alfa, () => BillingCharge.currentOpen());
    assert.equal(aberta?.gateway_charge_id, 'pay_atrasada', 'o aviso continua mandando o link dela');
    const vista = BillingCharge.present(aberta);
    assert.equal(vista.invoiceUrl, 'https://g.test/pay_atrasada');
  });

  it('e o pagamento que chega depois a quita; um OVERDUE atrasado não a reabre', async () => {
    await emitida('pay_tarde');
    await entregar(evento('PAYMENT_OVERDUE', 'pay_tarde'));
    const pago = await entregar(evento('PAYMENT_RECEIVED', 'pay_tarde'));
    assert.equal(pago.body.code, 'recorded');
    assert.equal(await estadoDe('pay_tarde'), 'paid');

    const atrasado = await entregar(evento('PAYMENT_OVERDUE', 'pay_tarde'));
    assert.equal(atrasado.status, 200);
    assert.equal(atrasado.body.code, 'unchanged');
    assert.equal(await estadoDe('pay_tarde'), 'paid');
  });

  it('PAYMENT_DELETED cancela', async () => {
    await emitida('pay_apagada');
    const res = await entregar(evento('PAYMENT_DELETED', 'pay_apagada'));
    assert.equal(res.status, 200);
    assert.equal(await estadoDe('pay_apagada'), 'canceled');
  });

  it('PAYMENT_REFUNDED marca `refunded` e desfaz o período que o pagamento comprou — uma vez', async () => {
    await emitida('pay_estornada');
    await entregar(evento('PAYMENT_RECEIVED', 'pay_estornada'));
    const depoisDoPagamento = await runInTenant(alfa, () => Subscription.forTenant(alfa));
    assert.ok(new Date(depoisDoPagamento.renews_at) > RENOVA, 'o pagamento creditou');

    const res = await entregar(evento('PAYMENT_REFUNDED', 'pay_estornada'));
    assert.equal(res.status, 200);
    assert.equal(res.body.reversal, 'reversed');
    assert.equal(await estadoDe('pay_estornada'), 'refunded');

    // Pago atrasado, o período contou de agora; desfeito, o prazo volta ao
    // vencido de antes do pagamento — e o provedor volta a dever.
    const depoisDoEstorno = await runInTenant(alfa, () => Subscription.forTenant(alfa));
    assert.equal(new Date(depoisDoEstorno.renews_at).getTime(), RENOVA.getTime());
    const eventos = await getDb()('billing_events').where({ tenant_id: alfa }).orderBy('id', 'asc');
    assert.deepEqual(eventos.map((e) => e.type), ['payment.recorded', 'payment.refunded'],
      'o estorno vira linha própria, e não de crédito');
    assert.equal(eventos[1].external_id, 'pay_estornada:refund');

    const reentrega = await entregar(evento('PAYMENT_REFUNDED', 'pay_estornada'));
    assert.equal(reentrega.status, 200);
    assert.equal(reentrega.body.reversal, 'duplicate');
    const depoisDaReentrega = await runInTenant(alfa, () => Subscription.forTenant(alfa));
    assert.equal(new Date(depoisDaReentrega.renews_at).getTime(), RENOVA.getTime(), 'nenhum período a menos');
  });

  it('200 para cobrança que o painel não emitiu e para quem não resolve provedor', async () => {
    const semCobranca = await entregar(evento('PAYMENT_OVERDUE', 'pay_de_fora'));
    assert.equal(semCobranca.status, 200);
    assert.equal(semCobranca.body.code, 'no_charge');

    const orfa = await entregar(evento('PAYMENT_DELETED', 'pay_orfa', { customer: 'cus_de_ninguem' }));
    assert.equal(orfa.status, 200);
    assert.equal(orfa.body.code, 'unattributed');
  });

  it('e sem a credencial, nada disso acontece', async () => {
    await emitida('pay_protegida');
    const res = await call(`${panelUrl}/api/billing-webhook`, {
      method: 'POST', headers: { 'asaas-access-token': 'errado' }, body: evento('PAYMENT_DELETED', 'pay_protegida')
    });
    assert.equal(res.status, 401);
    assert.equal(await estadoDe('pay_protegida'), 'pending');
  });
});
