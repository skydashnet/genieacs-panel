import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A régua de lembretes de cobrança (0092), que substituiu o aviso único.
 *
 * Até aqui o provedor descobria que o teste acabou — ou que o período pago
 * venceu — tomando 402 ao salvar. Agora são três lembretes por prazo:
 * `before` (até cinco dias antes), `due` (no vencimento, por três dias) e
 * `after` (de três a dez dias depois, enquanto ninguém pagou).
 *
 * O que este arquivo guarda são as maneiras de errar isto: não lembrar,
 * lembrar demais (o agendador roda de minuto em minuto), mandar atrasada a
 * etapa que passou, lembrar quem não deve nada, e marcar como mandado o que
 * não saiu.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: SubscriptionNoticeService } = await import(
  '../src/services/subscriptionNoticeService.js'
);
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: Coupon } = await import('../src/models/Coupon.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { subscriptionView } = await import('../src/controllers/platformBillingController.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');

const DIA = 24 * 60 * 60 * 1000;

let smtp;
let recebidas;
let alfa;
let pago;
let gratis;
let basico;

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();

  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  // O dono, que é a reserva quando não há e-mail de cobrança.
  const [donoId] = await getDb()('users')
    .insert({ username: 'a-dona', password: 'x', role: 'owner', email: 'a-dona@exemplo.test' })
    .returning('id')
    .then((rows) => rows.map((r) => (typeof r === 'object' ? r.id : r)));
  await getDb()('tenant_users').insert({ tenant_id: alfa, user_id: donoId, role: 'owner' });
  pago = await Plan.create({
    code: 'lembrete-pro', name: 'Pro', price_cents: 19990, currency: 'BRL', period_days: 30, trial_days: 7, active: true
  });
  gratis = await Plan.create({
    code: 'lembrete-free', name: 'Free', price_cents: 0, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  basico = await Plan.create({
    code: 'lembrete-basico', name: 'Básico', price_cents: 9990, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((done) => smtp.close(done));
});

/** Põe a assinatura do provedor no estado pedido (no plano pago) e esquece o cache. */
async function comAssinatura(patch) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: pago.id, status: 'active', trial_ends_at: null, renews_at: null, canceled_at: null,
    expiry_warned_for: null, billing_exempt_at: null, coupon_id: null, coupon_cycles_left: null,
    coupon_applied_at: null, pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

const avisar = (now) => runInTenant(alfa, () => SubscriptionNoticeService.notifyCurrent({ now }));

const ultima = () => decodificarQuotedPrintable(recebidas[recebidas.length - 1]);

const enviados = () => getDb()('subscription_reminder_sends').where({ tenant_id: alfa }).orderBy('id');

beforeEach(async () => {
  recebidas.length = 0;
  await getDb()('tenants').where({ id: alfa }).update({ billing_email: null, billing_phone: null });
  // A cobrança emitida decide o link e o valor da mensagem, e os lembretes
  // mandados decidem o que ainda sai: estado que atravessaria casos.
  await getDb()('billing_charges').del();
  await getDb()('subscription_reminder_sends').del();
});

describe('as três etapas da régua', () => {
  it('before: até cinco dias antes do prazo', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 3 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.sent, true, JSON.stringify(resultado));
    assert.equal(resultado.step, 'before');
    assert.equal(resultado.kind, 'renewal');
    assert.equal(recebidas.length, 1);
    const [linha] = await enviados();
    assert.equal(linha.step, 'before');
    assert.equal(linha.channels, 'email');
    assert.ok(linha.sent_at, 'a etapa ficou marcada como mandada');
  });

  it('due: do prazo até três dias depois', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() - 1 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.step, 'due');
    assert.equal(resultado.expired, true);
  });

  it('after: de três a dez dias depois, enquanto ninguém pagou', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() - 5 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.step, 'after');
  });

  it('e nada fora das janelas', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 6 * DIA) });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    await comAssinatura({ renews_at: new Date(Date.now() - 11 * DIA) });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    await comAssinatura({ renews_at: null });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    assert.equal(recebidas.length, 0);
  });

  it('cada etapa sai uma vez, e a régua inteira sai ao longo do prazo', async () => {
    const prazo = new Date(Date.now() + 2 * DIA);
    await comAssinatura({ renews_at: prazo });
    const em = (dias) => new Date(prazo.getTime() + dias * DIA);

    for (const [dias, etapa] of [[-4, 'before'], [1, 'due'], [4, 'after']]) {
      // eslint-disable-next-line no-await-in-loop
      const primeira = await avisar(em(dias));
      assert.equal(primeira.sent, true, etapa);
      assert.equal(primeira.step, etapa);
      // O agendador roda de minuto em minuto: as passadas seguintes são o teste.
      for (const minutos of [1, 2, 60]) {
        // eslint-disable-next-line no-await-in-loop
        const deNovo = await avisar(new Date(em(dias).getTime() + minutos * 60_000));
        assert.equal(deNovo.sent, false, `${etapa} repetiu`);
      }
    }
    assert.equal(recebidas.length, 3, 'um e-mail por etapa');
    assert.deepEqual((await enviados()).map((l) => l.step), ['before', 'due', 'after']);
  });

  /**
   * Uma etapa que passou sem sair (o agendador parado, o SMTP fora) não sai
   * atrasada: "vence em cinco dias" para quem já venceu seria pior que nada.
   */
  it('não manda atrasada a etapa que passou', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() - 5 * DIA) });
    assert.equal((await avisar(new Date())).step, 'after');
    assert.deepEqual((await enviados()).map((l) => l.step), ['after']);
    assert.equal(recebidas.length, 1);
  });

  it('no teste, o prazo é o fim do teste e o texto é o do teste', async () => {
    await comAssinatura({ status: 'trial', trial_ends_at: new Date(Date.now() + 2 * DIA) });
    const resultado = await avisar(new Date());
    assert.equal(resultado.kind, 'trial');
    assert.equal(resultado.step, 'before');
    assert.match(ultima(), /teste/i);
  });

  it('duas passadas ao mesmo tempo mandam uma mensagem só', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 2 * DIA) });
    const agora = new Date();
    const resultados = await Promise.all([avisar(agora), avisar(agora), avisar(agora)]);
    assert.equal(resultados.filter((r) => r.sent).length, 1, JSON.stringify(resultados));
    assert.equal(recebidas.length, 1);
    assert.equal((await enviados()).length, 1);
  });
});

describe('quem não recebe lembrete', () => {
  it('quem pagou: o prazo anda e a régua recomeça no prazo novo', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 2 * DIA) });
    assert.equal((await avisar(new Date())).sent, true);
    recebidas.length = 0;

    await runInTenant(alfa, () => SubscriptionService.recordPayment({ amountCents: 19990 }));
    await SubscriptionService.invalidate(alfa);
    // O prazo novo está a trinta e dois dias: nada sai agora...
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
    // ...nem no `after` do prazo VELHO, que já foi pago.
    assert.equal((await avisar(new Date(Date.now() + 6 * DIA))).reason, 'nothing_due');
    assert.equal(recebidas.length, 0);
    // E o `before` do prazo novo sai normalmente.
    assert.equal((await avisar(new Date(Date.now() + 29 * DIA))).step, 'before');
  });

  it('o isento de cobrança', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() - 1 * DIA), billing_exempt_at: new Date() });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
  });

  it('o plano de graça', async () => {
    await comAssinatura({ plan_id: gratis.id, renews_at: new Date(Date.now() + 2 * DIA) });
    assert.equal((await avisar(new Date())).reason, 'nothing_due');
  });

  it('quem já foi desligado à mão', async () => {
    for (const status of ['suspended', 'canceled']) {
      // eslint-disable-next-line no-await-in-loop
      await comAssinatura({ status, renews_at: new Date(Date.now() - 1 * DIA) });
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await avisar(new Date())).reason, 'nothing_due', status);
    }
    assert.equal(recebidas.length, 0);
  });
});

describe('o que a mensagem leva', () => {
  it('o link e o valor da cobrança em aberto', async () => {
    const prazo = new Date(Date.now() + 2 * DIA);
    await comAssinatura({ renews_at: prazo });
    await runInTenant(alfa, async () => {
      const id = await BillingCharge.open({
        periodEnd: ChargeIssuingService.periodKey(prazo), amountCents: 15050, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, {
        gatewayChargeId: 'pay_do_lembrete',
        invoiceUrl: 'https://gateway.exemplo.test/i/pay_do_lembrete'
      });
    });

    assert.equal((await avisar(new Date())).sent, true);
    const texto = ultima();
    assert.match(texto, /gateway\.exemplo\.test\/i\/pay_do_lembrete/, 'o lembrete saiu sem dizer onde pagar');
    assert.match(texto, /150,50/, 'o valor é o da cobrança, não o do plano');
  });

  it('sem cobrança, o preço do plano e o endereço do painel', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 3 * DIA) });
    assert.equal((await avisar(new Date())).sent, true);
    const texto = ultima();
    assert.equal(texto.includes('gateway.exemplo.test'), false);
    assert.match(texto, /199,90/);
    assert.match(texto, /painel\.test/);
  });

  it('sem cobrança, o preço que a emissão pediria: com o cupom, e o da descida agendada para o prazo', async () => {
    const cupom = await Coupon.create({
      code: 'LEMBRETE10', kind: 'percent', value: 10, duration: 'forever', redemptions: 1, active: true
    });
    const prazo = new Date(Date.now() + 3 * DIA);
    await comAssinatura({ renews_at: prazo, coupon_id: cupom.id, coupon_applied_at: new Date() });
    assert.equal((await avisar(new Date())).sent, true);
    assert.match(ultima(), /179,91/, 'o preço do plano com o cupom, não o de tabela');

    // A descida agendada para este prazo: a fatura dele é do plano novo.
    await getDb()('subscription_reminder_sends').del();
    await comAssinatura({
      renews_at: prazo, coupon_id: cupom.id, coupon_applied_at: new Date(), pending_plan_id: basico.id, pending_plan_at: prazo
    });
    assert.equal((await avisar(new Date())).sent, true);
    assert.match(ultima(), /89,91/, 'o básico com o cupom: 9990 − 999');

    // Agendada para outro prazo, não é desta fatura.
    await getDb()('subscription_reminder_sends').del();
    await comAssinatura({
      renews_at: prazo, pending_plan_id: basico.id, pending_plan_at: new Date(prazo.getTime() + 30 * DIA)
    });
    assert.equal((await avisar(new Date())).sent, true);
    assert.match(ultima(), /199,90/);
  });

  it('o provedor e a data, em ISO', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 1 * DIA) });
    await avisar(new Date());
    const texto = ultima();
    const tenant = await Tenant.findById(alfa);
    assert.ok(texto.includes(tenant.name), 'sem o nome do provedor a mensagem é anônima');
    assert.match(texto, /\d{4}-\d{2}-\d{2}/);
  });

  it('para o e-mail de cobrança, quando ele existe; senão para os donos', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 2 * DIA) });
    await avisar(new Date());
    assert.match(ultima(), /a-dona@exemplo\.test/);
    await getDb()('subscription_reminder_sends').del();
    await getDb()('tenants').where({ id: alfa }).update({ billing_email: 'financeiro@alfa.test' });
    await avisar(new Date());
    assert.match(ultima(), /financeiro@alfa\.test/);
  });
});

describe('só marca o que saiu', () => {
  /**
   * Marcar sem mandar deixaria o provedor sem lembrete no dia em que o SMTP
   * estivesse fora — e a marca é o que impediria a segunda tentativa.
   */
  it('nenhum canal funcionou: nada marcado, e a próxima passada tenta de novo', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 2 * DIA) });
    const antes = process.env.SMTP_URL;
    // Uma porta onde ninguém escuta: o envio falha de verdade.
    const fechado = smtpDeMentira().server;
    await new Promise((resolve) => fechado.listen(0, '127.0.0.1', resolve));
    const porta = fechado.address().port;
    await new Promise((done) => fechado.close(done));
    process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${porta}?ignoreTLS=true`;
    resetMailTransport();
    try {
      const resultado = await avisar(new Date());
      assert.equal(resultado.sent, false);
      assert.equal(resultado.reason, 'send_failed');
      assert.equal((await enviados()).length, 0, 'a garra foi solta');
      const linha = await getDb()('subscriptions').where({ tenant_id: alfa }).first();
      assert.equal(linha.expiry_warned_for, null);
    } finally {
      process.env.SMTP_URL = antes;
      resetMailTransport();
    }
    const segunda = await avisar(new Date());
    assert.equal(segunda.sent, true);
    assert.equal(recebidas.length, 1);
  });

  it('sem ninguém para receber, também não marca', async () => {
    await comAssinatura({ renews_at: new Date(Date.now() + 2 * DIA) });
    await getDb()('tenant_users').where({ tenant_id: alfa }).del();
    try {
      assert.equal((await avisar(new Date())).reason, 'no_recipient');
      assert.equal((await enviados()).length, 0);
    } finally {
      const dono = await getDb()('users').where({ username: 'a-dona' }).first();
      await getDb()('tenant_users').insert({ tenant_id: alfa, user_id: dono.id, role: 'owner' });
    }
  });

  it('e continua gravando expiry_warned_for, por compatibilidade', async () => {
    // No segundo inteiro: o MySQL arredonda (não trunca) os milissegundos, e
    // um prazo em .6s voltaria um segundo à frente.
    const prazo = new Date(Math.floor((Date.now() + 2 * DIA) / 1000) * 1000);
    await comAssinatura({ renews_at: prazo });
    await avisar(new Date());
    const linha = await getDb()('subscriptions').where({ tenant_id: alfa }).first();
    assert.equal(Math.floor(new Date(linha.expiry_warned_for).getTime() / 1000), Math.floor(prazo.getTime() / 1000));
  });
});

describe('o console vê os lembretes mandados', () => {
  it('em `reminders`, na visão da assinatura', async () => {
    const prazo = new Date(Date.now() + 2 * DIA);
    await comAssinatura({ renews_at: prazo });
    await avisar(new Date());
    const tenant = await Tenant.findById(alfa);
    const visao = await subscriptionView(tenant);
    assert.equal(visao.reminders.length, 1);
    const [lembrete] = visao.reminders;
    assert.equal(lembrete.step, 'before');
    assert.equal(lembrete.dueAt, ChargeIssuingService.periodKey(prazo));
    assert.deepEqual(lembrete.channels, ['email']);
    assert.ok(!Number.isNaN(new Date(lembrete.sentAt).getTime()));
  });
});

describe('a régua, como função pura', () => {
  const plano = { price_cents: 100 };
  const prazo = new Date('2026-10-10T15:00:00Z');
  const em = (horas) => new Date(prazo.getTime() + horas * 3_600_000);
  const etapa = (sub, now, p = plano) => SubscriptionService.pendingReminder(sub, now, p)?.step ?? null;
  const ativa = { status: 'active', renews_at: prazo };

  it('as bordas das janelas', () => {
    assert.equal(etapa(ativa, em(-5 * 24 - 1)), null);
    assert.equal(etapa(ativa, em(-5 * 24)), 'before');
    assert.equal(etapa(ativa, em(-0.01)), 'before');
    assert.equal(etapa(ativa, em(0)), 'due');
    assert.equal(etapa(ativa, em(3 * 24 - 0.01)), 'due');
    assert.equal(etapa(ativa, em(3 * 24)), 'after');
    assert.equal(etapa(ativa, em(10 * 24 - 0.01)), 'after');
    assert.equal(etapa(ativa, em(10 * 24)), null);
  });

  it('sem plano pago, sem lembrete', () => {
    assert.equal(etapa(ativa, em(-1), null), null);
    assert.equal(etapa(ativa, em(-1), { price_cents: 0 }), null);
  });
});
