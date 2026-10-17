import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * As cobranças que o provedor vê — e a única delas que importa de verdade: a
 * que ele consegue ver ESTANDO BLOQUEADO.
 *
 * `billing_charges` guarda `invoice_url`, a página do gateway onde se paga, e
 * até aqui esse endereço só saía pelo e-mail de aviso. Quem perdeu o e-mail
 * batia no muro do 402 sem ter, em tela nenhuma, onde pagar — e o 402 vem de
 * dentro da autenticação, então uma rota nova de cobranças nasceria do lado
 * errado da porta por default. É essa isenção que o arquivo fixa.
 *
 * SaaS, porque a porta da assinatura só é montada nessa edição.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant,
  startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { tinsertReturningId } = await import('../src/config/database.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');

let panelUrl;
let alfa;
let beta;
let token;

const PAGINA = 'https://gateway.exemplo.test/i/alfa-2026-03';
const PAGINA_DO_VIZINHO = 'https://gateway.exemplo.test/i/beta-2026-03';

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;

  beta = await Tenant.create({ slug: 'beta', name: 'Provedor Beta' });
});

after(async () => {
  await stopTestServers();
});

afterEach(async () => {
  await getDb()('billing_charges').del();
  await estado({ status: 'active' });
});

/** Põe o provedor da instalação no estado pedido, e faz a porta reler. */
async function estado(patch) {
  await Subscription.upsertForTenant(alfa, {
    status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

/** Uma cobrança de um provedor, escrita direto: o que está sob teste é a leitura. */
async function cobranca(tenantId, patch = {}) {
  return runInTenant(tenantId, () => tinsertReturningId('billing_charges', {
    period_end: '2026-03-31',
    amount_cents: 19900,
    currency: 'BRL',
    provider: 'asaas',
    status: 'pending',
    invoice_url: PAGINA,
    due_date: '2026-03-25',
    ...patch
  }));
}

const listar = (headers = authHeaders(token)) =>
  call(`${panelUrl}/api/tenant/charges`, { headers });

describe('o provedor vê o que foi cobrado dele', () => {
  it('devolve a cobrança com o período, o valor e o link de pagamento', async () => {
    await cobranca(alfa);
    const resposta = await listar();
    assert.equal(resposta.status, 200);
    const [linha] = resposta.body.data.charges;
    assert.equal(linha.periodEnd, '2026-03-31');
    assert.equal(linha.amountCents, 19900);
    assert.equal(linha.currency, 'BRL');
    assert.equal(linha.status, 'pending');
    assert.equal(linha.invoiceUrl, PAGINA);
  });

  /**
   * O link de uma cobrança já paga é um botão que leva o cliente a uma página
   * do gateway convidando a pagar de novo. A coluna continua no banco — é o
   * histórico —, o que sai da resposta é o endereço.
   */
  it('mas cala o link da cobrança que já foi paga', async () => {
    await cobranca(alfa, { status: 'paid' });
    const [linha] = (await listar()).body.data.charges;
    assert.equal(linha.status, 'paid');
    assert.equal(linha.invoiceUrl, null);
  });

  /**
   * `gateway_charge_id` é a correlação com a NOSSA conta no gateway e
   * `last_error` é texto cru que ele devolveu. Nenhum dos dois é endereço de
   * pagamento, e nenhum dos dois tem por que atravessar para a tela de um
   * cliente.
   */
  it('e não deixa vazar a mecânica da emissão', async () => {
    await cobranca(alfa, {
      gateway_charge_id: 'pay_0001', attempts: 3, last_error: 'conta suspensa no gateway'
    });
    const [linha] = (await listar()).body.data.charges;
    for (const campo of ['gatewayChargeId', 'gateway_charge_id', 'lastError', 'last_error', 'attempts']) {
      assert.equal(linha[campo], undefined, `${campo} não podia estar na resposta`);
    }
  });

  it('e o boleto do vizinho não entra na lista', async () => {
    await cobranca(alfa);
    await cobranca(beta, { invoice_url: PAGINA_DO_VIZINHO });

    const cobrancas = (await listar()).body.data.charges;
    assert.equal(cobrancas.length, 1);
    assert.equal(cobrancas[0].invoiceUrl, PAGINA);

    // E o outro lado da mesma afirmação, medido no model: a leitura do beta
    // enxerga a dele e só a dela.
    const doBeta = await runInTenant(beta, () => BillingCharge.listRecent());
    assert.equal(doBeta.length, 1);
    assert.equal(doBeta[0].invoice_url, PAGINA_DO_VIZINHO);
  });
});

/**
 * O caso que a isenção existe para garantir. Sem ela a rota responde 402 —
 * um muro mostrado justamente a quem está tentando derrubá-lo pagando.
 */
describe('e vê estando bloqueado, que é quando precisa', () => {
  for (const status of ['past_due', 'suspended', 'canceled']) {
    it(`responde a um provedor ${status}`, async () => {
      await cobranca(alfa);
      await estado({ status });

      // A prova de que o provedor está mesmo bloqueado, e não de que o teste
      // esqueceu de bloquear: uma rota comum recusa neste mesmo instante.
      const comum = await call(`${panelUrl}/api/users`, {
        method: 'POST',
        headers: authHeaders(token),
        body: { username: `alguem-${status}`, password: 'senha-de-alguem-1', role: 'viewer' }
      });
      assert.equal(comum.status, 402, 'o provedor precisava estar bloqueado');

      const resposta = await listar();
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.data.charges[0].invoiceUrl, PAGINA);
    });
  }
});

describe('e não é rota aberta', () => {
  it('sem sessão, 401', async () => {
    assert.equal((await call(`${panelUrl}/api/tenant/charges`)).status, 401);
  });
});

/**
 * O autoatendimento de cobrança — a lista de planos, a troca e o "pagar
 * agora" — do lado de dentro da porta, pelo mesmo motivo desta lista: quem
 * está em `past_due` é quem precisa deles. Aqui só se prova que a porta os
 * deixa passar; o que cada rota faz depois está em
 * `tenant-self-billing.test.js`, que roda no self-hosted para poder falar com
 * um gateway de mentira.
 */
describe('o autoatendimento também passa pela porta', () => {
  it('um provedor past_due chega ao "pagar agora" e à troca de plano, e não ao 402', async () => {
    const { default: Plan } = await import('../src/models/Plan.js');
    const pago = await Plan.create({
      code: 'porta-pago', name: 'Pago', price_cents: 9900, currency: 'BRL', active: true
    });
    const outro = await Plan.create({
      code: 'porta-outro', name: 'Outro', price_cents: 4900, currency: 'BRL', active: true
    });
    await estado({ status: 'past_due', plan_id: pago.id, renews_at: new Date(Date.now() - 86_400_000) });

    const comum = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { username: 'alguem-porta', password: 'senha-de-alguem-1', role: 'viewer' }
    });
    assert.equal(comum.status, 402, 'o provedor precisava estar bloqueado');

    // Sem chave do gateway neste arquivo: a resposta é a recusa do
    // CONTROLADOR (503), que só existe se a porta deixou passar.
    const pagar = await call(`${panelUrl}/api/tenant/charges/pay`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(pagar.status, 503, JSON.stringify(pagar.body));
    assert.equal(pagar.body.code, 'gateway_not_configured');

    const planos = await call(`${panelUrl}/api/tenant/plans`, { headers: authHeaders(token) });
    assert.equal(planos.status, 200);

    const troca = await call(`${panelUrl}/api/tenant/subscription/plan`, {
      method: 'PUT', headers: authHeaders(token), body: { planId: outro.id }
    });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));

    // O cartão recorrente (0100): desligar ou remover o cartão recusado é o
    // que devolve a fatura de quem está atrasado para Pix/boleto.
    const autopay = await call(`${panelUrl}/api/tenant/subscription/autopay`, {
      method: 'PUT', headers: authHeaders(token), body: { enabled: false }
    });
    assert.equal(autopay.status, 200, JSON.stringify(autopay.body));
    const cartao = await call(`${panelUrl}/api/tenant/subscription/card`, {
      method: 'DELETE', headers: authHeaders(token)
    });
    assert.equal(cartao.status, 200, JSON.stringify(cartao.body));
  });

  it('e o suspenso chega ao controlador, que recusa com 409 e não 402', async () => {
    await estado({ status: 'suspended' });
    const { default: Plan } = await import('../src/models/Plan.js');
    const outro = await Plan.findByCode('porta-pago');
    const troca = await call(`${panelUrl}/api/tenant/subscription/plan`, {
      method: 'PUT', headers: authHeaders(token), body: { planId: outro.id }
    });
    assert.equal(troca.status, 409);
    assert.equal(troca.body.code, 'not_changeable');
    const pagar = await call(`${panelUrl}/api/tenant/charges/pay`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(pagar.status, 409);
    assert.equal(pagar.body.code, 'not_billable');
  });
});
