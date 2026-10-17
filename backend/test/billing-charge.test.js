import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');

/**
 * A emissão da cobrança: o painel pedindo dinheiro, e não só recebendo a
 * notícia de que ele entrou.
 *
 * O gateway é um servidor de mentira em `127.0.0.1`, e é ele que dá a este
 * arquivo o seu valor: **o que se assere é a requisição que SAIU** — método,
 * caminho, cabeçalho da credencial e cada campo do corpo —, com socket de
 * verdade aberto. O que continua não-verificável sem conta no gateway é se ele
 * ACEITA esse corpo, e essa é a mesma fronteira que a metade que recebe já
 * declarou.
 *
 * As quatro maneiras de errar uma emissão:
 *
 * 1. **Emitir duas vezes.** Custa uma cobrança a mais na mão de um cliente
 *    pagante — pior que o aviso repetido, que custa um e-mail.
 * 2. **Não emitir.** O silêncio é o mesmo de "ninguém tentou", e os consertos
 *    são opostos.
 * 3. **Emitir para quem não deve** — plano de graça, provedor suspenso, quem
 *    não está ligado a gateway nenhum.
 * 4. **Emitir e não saber que emitiu**: perder o id do gateway é perder o
 *    caminho de volta do pagamento.
 */
const CHAVE = 'chave-da-api-deste-deploy';

let gateway;
let recebidas = [];
let panelUrl;
let alfa;
let planoPago;

function subirGateway() {
  gateway = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(bruto || '{}'); } catch { payload = {}; }
      recebidas.push({
        method: req.method,
        path: req.url.split('?')[0],
        accessToken: req.headers.access_token,
        userAgent: req.headers['user-agent'],
        payload
      });
      if (payload.value === 999.99) {
        // O caso de recusa: o gateway responde 400 com o corpo dele.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ errors: [{ description: 'CPF/CNPJ inválido' }] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'pay_emitida_1',
        status: 'PENDING',
        value: payload.value,
        dueDate: payload.dueDate,
        invoiceUrl: 'https://gateway.exemplo.test/i/pay_emitida_1'
      }));
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
}

before(async () => {
  const base = await subirGateway();
  process.env.ASAAS_API_KEY = CHAVE;
  process.env.ASAAS_BASE_URL = base;

  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').where({ id: alfa })
    .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_do_alfa', name: 'Provedor Alfa' });

  planoPago = await runInTenant(alfa, () => Plan.create({
    code: 'pago', name: 'Pago', price_cents: 19990, currency: 'BRL', period_days: 30, active: true
  }));
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

/** O prazo daqui a `dias`, que é o que decide se há o que emitir. */
const daquiA = (dias) => new Date(Date.now() + dias * 86_400_000);

async function assinar({ status = 'active', renewsAt = daquiA(2), planId = null } = {}) {
  // O `invalidate` do cache também precisa de provedor em escopo: ele é por
  // provedor, e sem escopo não sabe qual esvaziar.
  await runInTenant(alfa, async () => {
    await Subscription.upsertForTenant(alfa, {
      plan_id: planId ?? planoPago.id, status, renews_at: renewsAt, trial_ends_at: null
    });
    SubscriptionService.cache.invalidate();
  });
}

const emitir = () => runInTenant(alfa, () => ChargeIssuingService.issueCurrent());
const cobrancas = () => getDb()('billing_charges').where({ tenant_id: alfa }).orderBy('id');

beforeEach(async () => {
  recebidas = [];
  await getDb()('billing_charges').del();
});

describe('a requisição que sai para o gateway', () => {
  it('leva o método, o caminho, a credencial e o corpo exatos', async () => {
    await assinar();
    const res = await emitir();
    assert.equal(res.issued, true, JSON.stringify(res));
    assert.equal(recebidas.length, 1, 'uma cobrança, uma chamada');

    const pedido = recebidas[0];
    assert.equal(pedido.method, 'POST');
    assert.equal(pedido.path, '/payments');
    // A credencial de SAÍDA é `access_token`. A da entrega é
    // `asaas-access-token` — dois cabeçalhos de nomes parecidos, e trocá-los dá
    // 401 numa direção só, a que só se exercita cobrando de verdade.
    assert.equal(pedido.accessToken, CHAVE);
    assert.equal(pedido.userAgent, 'TR69-Controle');

    // O corpo é EXATAMENTE este conjunto. O `deepEqual` sobre as chaves é o que
    // impede um campo chutado de entrar depois numa integração que ninguém
    // consegue testar contra o sistema de verdade.
    assert.deepEqual(Object.keys(pedido.payload).sort(), [
      'billingType', 'customer', 'description', 'dueDate', 'externalReference', 'value'
    ]);
    assert.equal(pedido.payload.customer, 'cus_do_alfa');
    // Reais, e não centavos: é o gateway que fala em reais, e a conversão mora
    // num ponto só.
    assert.equal(pedido.payload.value, 199.9);
    // `UNDEFINED` devolve uma página onde quem paga escolhe Pix ou boleto.
    // Pedir `PIX` fecharia a porta do boleto, que é como metade deste mercado paga.
    assert.equal(pedido.payload.billingType, 'UNDEFINED');
    assert.match(pedido.payload.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    // A referência é o contrato com a outra metade: é por ela que o webhook
    // acha o provedor sem depender do cadastro no gateway.
    assert.match(pedido.payload.externalReference, new RegExp(`^tenant:${alfa}:\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('e guarda o que só o gateway sabe: o id e o link de pagamento', async () => {
    await assinar();
    await emitir();
    const [cobranca] = await cobrancas();
    assert.equal(cobranca.gateway_charge_id, 'pay_emitida_1');
    assert.equal(cobranca.invoice_url, 'https://gateway.exemplo.test/i/pay_emitida_1');
    assert.equal(cobranca.status, 'pending');
    assert.equal(cobranca.amount_cents, 19990, 'o valor é copiado do plano, não lido dele depois');
    assert.equal(cobranca.provider, 'asaas');
  });
});

describe('uma cobrança por período', () => {
  it('a segunda passada do agendador não emite de novo', async () => {
    await assinar();
    assert.equal((await emitir()).issued, true);
    const segunda = await emitir();
    assert.equal(segunda.issued, false);
    assert.equal(segunda.reason, 'already_issued');
    assert.equal(recebidas.length, 1, 'a segunda passada falou com o gateway');
    assert.equal((await cobrancas()).length, 1);
  });

  /**
   * O ciclo se renova sozinho, pelo mesmo motivo que a marca do aviso se
   * renova: um pagamento empurra `renews_at`, o período seguinte tem outra
   * chave, e ninguém precisa lembrar de limpar nada.
   */
  it('mas o período seguinte emite, porque a chave mudou', async () => {
    await assinar();
    await emitir();
    await assinar({ renewsAt: daquiA(32) });
    assert.equal((await emitir()).issued, false, 'o prazo novo ainda está longe');

    await assinar({ renewsAt: daquiA(1) });
    assert.equal((await emitir()).issued, true);
    assert.equal((await cobrancas()).length, 2);
  });
});

describe('a quem o painel NÃO cobra', () => {
  const recusa = async (motivo) => {
    const res = await emitir();
    assert.equal(res.issued, false);
    assert.equal(res.reason, motivo);
    assert.equal(recebidas.length, 0, 'não podia ter falado com o gateway');
    assert.deepEqual(await cobrancas(), [], 'nem gravado linha');
  };

  it('quem tem plano de graça — uma cobrança de R$ 0,00 o gateway recusaria', async () => {
    const gratis = await runInTenant(alfa, () => Plan.create({
      code: 'gratis', name: 'Grátis', price_cents: 0, currency: 'BRL', active: true
    }));
    await assinar({ planId: gratis.id });
    await recusa('free_plan');
  });

  it('quem foi suspenso ou cancelado por decisão de gente', async () => {
    await assinar({ status: 'suspended' });
    await recusa('not_billable');
    await assinar({ status: 'canceled' });
    await recusa('not_billable');
  });

  it('quem ainda está longe do vencimento', async () => {
    await assinar({ renewsAt: daquiA(20) });
    await recusa('not_due_yet');
  });

  it('e quem não está ligado a gateway nenhum', async () => {
    await assinar();
    const db = getDb();
    await db('tenants').where({ id: alfa }).update({ billing_gateway: null, billing_customer_ref: null });
    try {
      await recusa('not_linked');
    } finally {
      await db('tenants').where({ id: alfa })
        .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_do_alfa' });
    }
  });
});

describe('quando o gateway recusa', () => {
  it('a linha fica, com o motivo — e o silêncio não vira "ninguém tentou"', async () => {
    const caro = await runInTenant(alfa, () => Plan.create({
      code: 'caro', name: 'Caro', price_cents: 99999, currency: 'BRL', active: true
    }));
    await assinar({ planId: caro.id });

    const res = await emitir();
    assert.equal(res.issued, false);
    assert.equal(res.reason, 'gateway_failed');

    const [cobranca] = await cobrancas();
    assert.ok(cobranca, 'sem esta linha, "não recebeu a cobrança" e "ninguém tentou" são o mesmo silêncio');
    assert.equal(cobranca.status, 'failed');
    assert.equal(cobranca.attempts, 1);
    assert.match(cobranca.last_error, /CPF\/CNPJ inválido/, 'o motivo do gateway é o que resolve o chamado');
    assert.equal(cobranca.gateway_charge_id, null);
  });

  /**
   * A espera entre tentativas, que é o que separa "insistir" de "cobrar cinco
   * vezes". O agendador passa a cada minuto: sem ela, uma resposta perdida no
   * meio viraria cinco cobranças de verdade em cinco minutos na mão de um
   * cliente pagante.
   */
  it('e não insiste no minuto seguinte', async () => {
    const caro = await runInTenant(alfa, () => Plan.findByCode('caro'));
    await assinar({ planId: caro.id });
    await emitir();
    recebidas = [];

    const logo = await emitir();
    assert.equal(logo.reason, 'backing_off');
    assert.equal(recebidas.length, 0, 'falou com o gateway um minuto depois de falhar');
  });

  it('insiste depois da espera, e desiste no teto', async () => {
    const caro = await runInTenant(alfa, () => Plan.findByCode('caro'));
    await assinar({ planId: caro.id });

    /** O relógio andando: a espera vence e a passada seguinte tenta de novo. */
    const esperaVenceu = () => getDb()('billing_charges')
      .where({ tenant_id: alfa }).update({ next_attempt_at: null });

    for (let i = 0; i < ChargeIssuingService.MAX_ATTEMPTS; i += 1) {
      await emitir();
      await esperaVenceu();
    }
    const [cobranca] = await cobrancas();
    assert.equal(cobranca.attempts, ChargeIssuingService.MAX_ATTEMPTS, 'cada tentativa conta uma vez');

    const desistiu = await emitir();
    assert.equal(desistiu.reason, 'gave_up', 'a centésima tentativa recusa igual; o que resolve é alguém olhar');
  });
});

describe('os casos que o desenho inteiro existe para não errar', () => {
  /**
   * O provedor JÁ vencido — que é a população que a emissão existe para
   * resolver, e a que um desenho ingênuo deixa de fora em silêncio.
   *
   * O prazo dele está no passado; um gateway recusa cobrança que nasce vencida.
   * Sem o vencimento adiado, ele falharia cinco vezes, desistiria, e — como
   * `renews_at` só se move com pagamento — a chave do período nunca mudaria e
   * ele nunca mais seria cobrado.
   */
  it('quem já venceu é cobrado, com vencimento que dá para pagar', async () => {
    await assinar({ status: 'past_due', renewsAt: daquiA(-40) });
    const res = await emitir();
    assert.equal(res.issued, true, JSON.stringify(res));

    const hoje = ChargeIssuingService.isoDate(new Date());
    const enviado = recebidas[0].payload.dueDate;
    assert.ok(enviado >= hoje, `venceria em ${enviado}, que já passou`);

    // Mas a CHAVE continua sendo o período, e não o vencimento: é o que impede
    // a mesma dívida de virar duas cobranças na passada seguinte.
    const [cobranca] = await cobrancas();
    assert.equal(cobranca.period_end, ChargeIssuingService.periodKey(daquiA(-40)));
    assert.equal((await emitir()).reason, 'already_issued');
  });

  /**
   * A data é lida no fuso do Brasil, que é onde o gateway está. Um `renews_at`
   * às 02:00Z é o dia ANTERIOR em São Paulo, e a chave única errada por um dia
   * é a que emite duas vezes.
   */
  it('a data do período é a do fuso da cobrança, não a de Greenwich', () => {
    const meiaNoiteEMeiaZ = new Date('2026-10-15T02:00:00Z');
    assert.equal(ChargeIssuingService.periodKey(meiaNoiteEMeiaZ), '2026-10-14');
    assert.equal(new Date(meiaNoiteEMeiaZ).toISOString().slice(0, 10), '2026-10-15',
      'é justamente a divergência que a conta em UTC produziria');
  });

  /**
   * A cobrança de um período que passou sem ser paga POR AQUI — o provedor
   * acertou por fora, pelo botão do console. Sem isto ela ficaria `pending`
   * para sempre e "o que está em aberto" responderia errado a cada ciclo.
   */
  it('a cobrança de um período superado é cancelada, não abandonada', async () => {
    await assinar({ renewsAt: daquiA(1) });
    await emitir();
    const [velha] = await cobrancas();
    assert.equal(velha.status, 'pending');

    // O pagamento veio por fora: `renews_at` andou sem quitar a cobrança.
    await assinar({ renewsAt: daquiA(31) });
    await emitir();
    assert.equal((await getDb()('billing_charges').where({ id: velha.id }).first()).status, 'canceled');
  });

  it('e um deploy sem a chave da API adia, em vez de queimar as tentativas', async () => {
    const guardada = process.env.ASAAS_API_KEY;
    delete process.env.ASAAS_API_KEY;
    try {
      await assinar();
      const res = await emitir();
      assert.equal(res.reason, 'gateway_not_configured');
      assert.deepEqual(await cobrancas(), [], 'nem gravou linha para gastar tentativa');
    } finally {
      process.env.ASAAS_API_KEY = guardada;
    }
  });
});

describe('as garantias que não são do código, e sim do banco', () => {
  /**
   * A corrida: duas passadas do agendador que se cruzam. A leitura de
   * `forPeriod` resolve o caso comum; quem decide o caso raro é o índice único
   * `(tenant_id, period_end)` — e o serviço depende disso, tratando a violação
   * como "perdi a corrida" em vez de erro.
   *
   * Testado no modelo e não pelo serviço de propósito: forçar duas passadas
   * simultâneas de verdade provaria o escalonador do Node, não a garantia. O
   * que precisa ser verdade é que o BANCO recusa a segunda linha.
   */
  it('o banco recusa a segunda cobrança do mesmo período', async () => {
    const { isUniqueViolation } = await import('../src/config/database.js');
    const abrir = () => runInTenant(alfa, () => BillingCharge.open({
      periodEnd: '2026-11-30', amountCents: 19990, currency: 'BRL', provider: 'asaas'
    }));
    await abrir();
    await assert.rejects(abrir, (erro) => {
      assert.ok(isUniqueViolation(erro), `o banco recusou por outro motivo: ${erro.message}`);
      return true;
    });
  });
});

describe('a ida e a volta se encontram', () => {
  /**
   * O par inteiro, em processo: o painel emite, o gateway avisa que foi pago
   * com o MESMO id, e a cobrança deixa de estar em aberto. É o teste que prova
   * que as duas metades falam a mesma língua — o id que a emissão guardou é o
   * mesmo que a entrega traz.
   */
  it('o pagamento da cobrança emitida a quita, e credita o período', async () => {
    process.env.BILLING_WEBHOOK_TOKEN = 'token-da-entrega';
    try {
      await assinar({ status: 'past_due', renewsAt: daquiA(1) });
      const emitida = await emitir();
      assert.equal(emitida.issued, true);
      const [antes] = await cobrancas();
      assert.equal(antes.status, 'pending');

      const entrega = await call(`${panelUrl}/api/billing-webhook`, {
        method: 'POST',
        headers: { 'asaas-access-token': 'token-da-entrega' },
        body: {
          event: 'PAYMENT_RECEIVED',
          payment: {
            id: antes.gateway_charge_id,
            value: 199.9,
            externalReference: `tenant:${alfa}:${antes.period_end}`
          }
        }
      });
      assert.equal(entrega.status, 200);
      assert.equal(entrega.body.code, 'recorded');

      const [depois] = await cobrancas();
      assert.equal(depois.status, 'paid', 'a cobrança emitida continua em aberto depois de paga');

      const assinatura = await runInTenant(alfa, () => Subscription.forTenant(alfa));
      assert.equal(assinatura.status, 'active', 'e o pagamento creditou o período');
    } finally {
      delete process.env.BILLING_WEBHOOK_TOKEN;
    }
  });
});
