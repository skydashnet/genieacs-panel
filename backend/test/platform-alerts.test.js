import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Os alertas para quem opera a plataforma (0112): a configuração no perfil, a
 * fila idempotente, o envio com novas tentativas, o resumo diário, o botão de
 * teste e os ganchos nos serviços que já existem.
 *
 * Os canais são trocados por funções que só anotam (`PlatformAlertService.senders`):
 * o que se prova aqui é QUEM manda O QUÊ e QUANDO, não o transporte — esse já
 * tem testes próprios (`PlatformNotifyService`, `mailTransport`).
 *
 * As datas são todas ao segundo: o MySQL guarda ao segundo e ARREDONDA os
 * milissegundos.
 */
// SaaS: o console (`/api/platform`) só existe nessa edição.
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: PlatformAlertService, MAX_ATTEMPTS, sanitizePayload, saoPauloClock } = await import('../src/services/platformAlertService.js');
const { saveProfile, invalidatePlatformProfile, alertsConfig } = await import('../src/services/platformProfileService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: SubscriptionNoticeService } = await import('../src/services/subscriptionNoticeService.js');
const { default: CancellationService } = await import('../src/services/cancellationService.js');
const { default: CardAutopayService } = await import('../src/services/billing/cardAutopayService.js');
const { default: BillingInvoice } = await import('../src/models/BillingInvoice.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');

const DIA = 24 * 60 * 60 * 1000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let panelUrl;
let token;
let alfa;
let pago;
let enviados = [];
let falhar = { whatsapp: false, email: false };
const sendersOriginais = PlatformAlertService.senders;

const alertas = () => getDb()('platform_alerts').orderBy('id');
const doEvento = (evento) => getDb()('platform_alerts').where({ event: evento }).orderBy('id');

async function ligar(eventos, extra = {}) {
  const events = {};
  for (const [evento, channels] of Object.entries(eventos)) events[evento] = { enabled: true, channels };
  await saveProfile({ alerts: { events, ...extra } });
  invalidatePlatformProfile();
}

async function desligarTudo() {
  const events = {};
  for (const evento of PlatformAlertService.EVENTS) events[evento] = { enabled: false, channels: ['whatsapp', 'email'] };
  await saveProfile({ alerts: { events, dailyDigest: { enabled: false, hour: 8 }, bigOverdueCents: null } });
}

async function comAssinatura(patch = {}) {
  await Subscription.upsertForTenant(alfa, {
    plan_id: pago.id, status: 'active', trial_ends_at: null, renews_at: aoSegundo(Date.now() + 10 * DIA), canceled_at: null,
    expiry_warned_for: null, billing_exempt_at: null, coupon_id: null, coupon_cycles_left: null,
    coupon_applied_at: null, pending_plan_id: null, pending_plan_at: null, pending_plan_locked_at: null,
    suspended_reason: null, cancel_at: null, paused_until: null, pause_started_at: null, ...patch
  });
  await SubscriptionService.invalidate(alfa);
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformProfile();
  await saveProfile({ notifyWhatsapp: '93991935695', notifyEmail: 'ops@plataforma.test' });
  pago = await Plan.create({
    code: 'alertas-pro', name: 'Pro', price_cents: 19990, currency: 'BRL', period_days: 30, trial_days: 0, active: true
  });
  PlatformAlertService.senders = {
    whatsapp: async (to, msg) => { enviados.push({ canal: 'whatsapp', to, ...msg }); return !falhar.whatsapp; },
    email: async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return !falhar.email; }
  };
});

after(async () => {
  PlatformAlertService.senders = sendersOriginais;
  await stopTestServers();
});

beforeEach(async () => {
  enviados = [];
  falhar = { whatsapp: false, email: false };
  await getDb()('platform_alerts').del();
  await desligarTudo();
  await saveProfile({ notifyWhatsapp: '93991935695', notifyEmail: 'ops@plataforma.test' });
  invalidatePlatformProfile();
});

describe('a configuração', () => {
  const perfil = (options = {}) => call(`${panelUrl}/api/platform/settings/profile`, {
    ...options, headers: { ...authHeaders(token), ...(options.headers || {}) }
  });

  it('vem no perfil, tudo desligado por padrão, e grava pelo mesmo PUT', async () => {
    const lido = await perfil();
    assert.equal(lido.status, 200);
    const { alerts } = lido.body.data;
    assert.deepEqual(Object.keys(alerts.events).sort(), [...PlatformAlertService.EVENTS].sort());
    assert.equal(alerts.events.payment_received.enabled, false);
    assert.deepEqual(alerts.events.payment_received.channels, ['whatsapp', 'email']);
    assert.equal(alerts.dailyDigest.hour, 8);

    const put = await perfil({
      method: 'PUT',
      body: { alerts: { events: { card_refused: { enabled: true, channels: ['email'] } }, bigOverdueCents: 123400 } }
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.data.changed, ['alerts']);
    assert.deepEqual(put.body.data.alerts.events.card_refused, { enabled: true, channels: ['email'] });
    // O que não veio fica como estava.
    assert.equal(put.body.data.alerts.events.payment_received.enabled, false);
    assert.equal(put.body.data.alerts.bigOverdueCents, 123400);
    const trilha = await getDb()('platform_audit').where({ action: 'platform.profile_changed' }).orderBy('id', 'desc').first();
    assert.deepEqual(JSON.parse(trilha.detail).fields, ['alerts']);
  });

  it('recusa evento, canal, limite e hora inválidos', async () => {
    for (const alerts of [
      { events: { nao_existe: { enabled: true } } },
      { events: { card_refused: { channels: ['sms'] } } },
      { events: { card_refused: { enabled: 'sim' } } },
      { bigOverdueCents: -1 },
      { bigOverdueCents: 10.5 },
      { dailyDigest: { hour: 24 } },
      'texto'
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await perfil({ method: 'PUT', body: { alerts } });
      assert.equal(res.status, 400, JSON.stringify(alerts));
    }
  });
});

describe('a fila', () => {
  it('evento desligado não entra', async () => {
    const r = await PlatformAlertService.enqueue('payment_received', { tenantId: alfa, dedupeKey: 'x', payload: { amountCents: 100 } });
    assert.deepEqual(r, { enqueued: false, reason: 'disabled' });
    assert.equal((await alertas()).length, 0);
  });

  it('o mesmo fato entra uma vez só, com o nome do provedor junto', async () => {
    await ligar({ payment_received: ['whatsapp'] });
    const a = await PlatformAlertService.enqueue('payment_received', { tenantId: alfa, dedupeKey: 'pay_1', payload: { amountCents: 100 } });
    const b = await PlatformAlertService.enqueue('payment_received', { tenantId: alfa, dedupeKey: 'pay_1', payload: { amountCents: 100 } });
    assert.deepEqual(a, { enqueued: true });
    assert.deepEqual(b, { enqueued: false, reason: 'duplicate' });
    const linhas = await alertas();
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].status, 'pending');
    assert.equal(Number(linhas[0].tenant_id), alfa);
    const payload = JSON.parse(linhas[0].payload);
    assert.equal(payload.amountCents, 100);
    assert.ok(payload.provider);
    assert.ok(payload.slug);
  });

  it('não guarda segredo no payload, e corta texto longo', async () => {
    await ligar({ nfse_error: ['email'] });
    await PlatformAlertService.enqueue('nfse_error', {
      tenantId: alfa,
      dedupeKey: 'segredo',
      payload: {
        error: 'x'.repeat(1000),
        apiKey: 'chave-da-asaas',
        webhookToken: 'tok',
        password: 'senha',
        cardToken: 'tok_cartao',
        card_token_ciphertext: 'cifra',
        nested: { apiKey: 'chave' }
      }
    });
    const [linha] = await alertas();
    const texto = linha.payload;
    for (const segredo of ['chave-da-asaas', 'tok', 'senha', 'tok_cartao', 'cifra', 'chave']) {
      assert.equal(texto.includes(segredo), false, segredo);
    }
    assert.equal(JSON.parse(texto).error.length, 200);
    assert.deepEqual(sanitizePayload({ token: 'a', secret: 'b', ok: 1 }), { ok: 1 });
  });

  it('a chave longa demais vira um hash, e continua idempotente', async () => {
    await ligar({ payment_received: ['email'] });
    const longa = 'p'.repeat(400);
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: longa });
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: longa });
    const linhas = await alertas();
    assert.equal(linhas.length, 1);
    assert.ok(linhas[0].dedupe_key.length <= 191);
  });
});

describe('o envio', () => {
  it('manda pelos canais do evento, e só por eles', async () => {
    await ligar({ payment_received: ['email'], card_refused: ['whatsapp', 'email'] });
    await PlatformAlertService.enqueue('payment_received', { tenantId: alfa, dedupeKey: 'p1', payload: { amountCents: 19990 } });
    await PlatformAlertService.enqueue('card_refused', { tenantId: alfa, dedupeKey: 'c1', payload: { reason: 'refused' } });
    const r = await PlatformAlertService.processDue({ now: new Date() });
    assert.equal(r.sent, 2);
    const doPagamento = enviados.filter((e) => e.subject.startsWith('Pagamento recebido'));
    assert.deepEqual(doPagamento.map((e) => e.canal), ['email']);
    assert.equal(doPagamento[0].to, 'ops@plataforma.test');
    assert.match(doPagamento[0].subject, /R\$\s?199,90/);
    const doCartao = enviados.filter((e) => e.subject.startsWith('Cartão recusado'));
    assert.deepEqual(doCartao.map((e) => e.canal).sort(), ['email', 'whatsapp']);
    assert.equal(doCartao.find((e) => e.canal === 'whatsapp').to, '5593991935695');
    for (const linha of await alertas()) {
      assert.equal(linha.status, 'sent');
      assert.ok(linha.sent_at);
    }
    // Enviado não sai de novo.
    enviados = [];
    await PlatformAlertService.processDue({ now: new Date() });
    assert.equal(enviados.length, 0);
  });

  it('tenta de novo com espera crescente, e desiste depois de cinco', async () => {
    await ligar({ payment_received: ['whatsapp'] });
    falhar.whatsapp = true;
    const t0 = aoSegundo(Date.now());
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'retry', now: t0 });
    let agora = t0;
    const esperas = [];
    for (let tentativa = 1; tentativa <= MAX_ATTEMPTS; tentativa += 1) {
      enviados = [];
      // eslint-disable-next-line no-await-in-loop
      await PlatformAlertService.processDue({ now: agora });
      assert.equal(enviados.length, 1, `tentativa ${tentativa}`);
      // eslint-disable-next-line no-await-in-loop
      const [linha] = await alertas();
      assert.equal(Number(linha.attempts), tentativa);
      if (tentativa < MAX_ATTEMPTS) {
        assert.equal(linha.status, 'pending');
        const proxima = new Date(linha.next_attempt_at).getTime();
        esperas.push(proxima - agora.getTime());
        // Antes da hora, nada sai.
        enviados = [];
        // eslint-disable-next-line no-await-in-loop
        await PlatformAlertService.processDue({ now: new Date(proxima - 1000) });
        assert.equal(enviados.length, 0);
        agora = new Date(proxima);
      } else {
        assert.equal(linha.status, 'failed');
        assert.equal(linha.next_attempt_at, null);
      }
    }
    assert.deepEqual(esperas, [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
    enviados = [];
    await PlatformAlertService.processDue({ now: new Date(agora.getTime() + DIA) });
    assert.equal(enviados.length, 0, 'falhou de vez, não tenta mais');
  });

  it('um canal que saiu basta: não repete o que já foi', async () => {
    await ligar({ payment_received: ['whatsapp', 'email'] });
    falhar.email = true;
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'parcial' });
    await PlatformAlertService.processDue({ now: new Date() });
    const [linha] = await alertas();
    assert.equal(linha.status, 'sent');
    assert.match(linha.last_error, /email/);
  });

  it('o passo do agendador manda o pendente e não lança', async () => {
    await ligar({ payment_received: ['email'] });
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'agendador' });
    const resumo = await PlatformAlertService.schedulerPass({ now: new Date() });
    assert.equal(resumo.send.sent, 1);
    assert.equal(enviados.length, 1);
  });

  it('sem destino, ou com o evento desligado depois, vira skipped', async () => {
    await ligar({ payment_received: ['whatsapp'], card_refused: ['email'] });
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'sem-destino' });
    await PlatformAlertService.enqueue('card_refused', { dedupeKey: 'desligado' });
    await saveProfile({ notifyWhatsapp: '' });
    await saveProfile({ alerts: { events: { card_refused: { enabled: false } } } });
    await PlatformAlertService.processDue({ now: new Date() });
    assert.equal(enviados.length, 0);
    const [semDestino, desligado] = await alertas();
    assert.equal(semDestino.status, 'skipped');
    assert.equal(semDestino.last_error, 'no_destination');
    assert.equal(desligado.status, 'skipped');
    assert.equal(desligado.last_error, 'disabled');
  });
});

describe('o resumo diário', () => {
  // 8h em Brasília (UTC−3) é 11h UTC.
  const dia = (iso, horaSp) => new Date(`${iso}T${String(horaSp + 3).padStart(2, '0')}:00:00Z`);

  it('junta tudo numa mensagem por canal, à hora escolhida, uma vez por dia', async () => {
    await ligar({ payment_received: ['whatsapp', 'email'], card_refused: ['email'] }, { dailyDigest: { enabled: true, hour: 8 } });
    const cedo = dia('2030-03-10', 6);
    await PlatformAlertService.enqueue('payment_received', { tenantId: alfa, dedupeKey: 'd1', payload: { amountCents: 100 }, now: cedo });
    await PlatformAlertService.enqueue('payment_received', { tenantId: alfa, dedupeKey: 'd2', payload: { amountCents: 200 }, now: cedo });
    await PlatformAlertService.enqueue('card_refused', { tenantId: alfa, dedupeKey: 'd3', now: cedo });
    assert.deepEqual(saoPauloClock(dia('2030-03-10', 8)), { day: '2030-03-10', hour: 8 });

    // Antes da hora: nada, nem um a um.
    await PlatformAlertService.processDue({ now: dia('2030-03-10', 7) });
    assert.equal(enviados.length, 0);

    await PlatformAlertService.processDue({ now: dia('2030-03-10', 8) });
    assert.equal(enviados.length, 2, JSON.stringify(enviados));
    const whats = enviados.find((e) => e.canal === 'whatsapp');
    const email = enviados.find((e) => e.canal === 'email');
    assert.match(whats.subject, /2 alerta/);
    assert.match(email.subject, /3 alerta/);
    assert.match(email.text, /10\/03\/2030/);
    assert.equal((email.text.match(/Pagamento recebido/g) || []).length, 2);
    assert.equal((email.text.match(/Cartão recusado/g) || []).length, 1);
    assert.equal((whats.text.match(/Cartão recusado/g) || []).length, 0);
    const linhas = await getDb()('platform_alerts').whereNot('event', 'digest');
    assert.ok(linhas.every((l) => l.status === 'sent'));

    // Um alerta novo depois do resumo espera o de amanhã.
    enviados = [];
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'd4', now: dia('2030-03-10', 9) });
    await PlatformAlertService.processDue({ now: dia('2030-03-10', 10) });
    assert.equal(enviados.length, 0);
    await PlatformAlertService.processDue({ now: dia('2030-03-11', 8) });
    assert.equal(enviados.length, 2);
    assert.match(enviados[0].subject, /1 alerta/);
  });

  it('o resumo que falha tenta de novo, sem duplicar o que saiu', async () => {
    await ligar({ payment_received: ['email'] }, { dailyDigest: { enabled: true, hour: 8 } });
    falhar.email = true;
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'df', now: dia('2030-04-01', 5) });
    await PlatformAlertService.processDue({ now: dia('2030-04-01', 8) });
    assert.equal(enviados.length, 1);
    const resumo = await getDb()('platform_alerts').where({ event: 'digest' }).first();
    assert.equal(resumo.status, 'pending');
    assert.equal(Number(resumo.attempts), 1);
    // Na mesma passada de um minuto depois, ainda esperando.
    enviados = [];
    await PlatformAlertService.processDue({ now: new Date(dia('2030-04-01', 8).getTime() + 30_000) });
    assert.equal(enviados.length, 0);
    falhar.email = false;
    await PlatformAlertService.processDue({ now: new Date(dia('2030-04-01', 8).getTime() + 61_000) });
    assert.equal(enviados.length, 1);
    assert.equal((await getDb()('platform_alerts').where({ event: 'digest' }).first()).status, 'sent');
    assert.equal((await doEvento('payment_received'))[0].status, 'sent');
  });
});

describe('os limites do resumo e da passada', () => {
  const dia = (iso, horaSp) => new Date(`${iso}T${String(horaSp + 3).padStart(2, '0')}:00:00Z`);
  const linhaFalsa = (i, extra = {}) => ({
    id: i, event: 'payment_received', payload: JSON.stringify({ provider: `Provedor ${i}`, amountCents: 100 * i, ...extra })
  });

  it('o resumo lista no máximo 50, e conta o resto em "+N mais"', () => {
    const linhas = Array.from({ length: 120 }, (_, i) => linhaFalsa(i + 1));
    const { subject, text } = PlatformAlertService.renderDigest(linhas, '2030-03-10');
    assert.match(subject, /120 alerta/);
    assert.equal((text.match(/^• /gm) || []).length, 50);
    assert.match(text, /\+70 mais$/);
    assert.ok(text.length <= 3500);
  });

  it('o texto do resumo nunca passa de 3500 caracteres', () => {
    const longo = 'x'.repeat(190);
    const linhas = Array.from({ length: 50 }, (_, i) => linhaFalsa(i + 1, { provider: `${longo}${i}` }));
    const { text } = PlatformAlertService.renderDigest(linhas, '2030-03-10');
    assert.ok(text.length <= 3500, String(text.length));
    const listados = (text.match(/^• /gm) || []).length;
    assert.ok(listados < 50);
    assert.match(text, new RegExp(`\\+${50 - listados} mais$`));
  });

  it('poucos itens: sem a linha "+N mais"', () => {
    const { text } = PlatformAlertService.renderDigest([linhaFalsa(1), linhaFalsa(2)], '2030-03-10');
    assert.equal((text.match(/^• /gm) || []).length, 2);
    assert.doesNotMatch(text, /mais$/);
  });

  it('o resumo pendente de um dia que passou é descartado, e os itens vão no de hoje', async () => {
    await ligar({ payment_received: ['email'] }, { dailyDigest: { enabled: true, hour: 8 } });
    falhar.email = true;
    await PlatformAlertService.enqueue('payment_received', { dedupeKey: 'ontem', now: dia('2030-06-01', 5) });
    await PlatformAlertService.processDue({ now: dia('2030-06-01', 8) });
    const ontem = await getDb()('platform_alerts').where({ dedupe_key: 'digest:2030-06-01' }).first();
    assert.equal(ontem.status, 'pending');
    falhar.email = false;
    enviados = [];
    await PlatformAlertService.processDue({ now: dia('2030-06-02', 8) });
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].subject, /1 alerta/);
    const velho = await getDb()('platform_alerts').where({ dedupe_key: 'digest:2030-06-01' }).first();
    assert.equal(velho.status, 'skipped');
    assert.equal(velho.last_error, 'superseded');
    assert.equal((await getDb()('platform_alerts').where({ dedupe_key: 'digest:2030-06-02' }).first()).status, 'sent');
    // E não volta a tentar o de ontem.
    enviados = [];
    await PlatformAlertService.processDue({ now: dia('2030-06-02', 12) });
    assert.equal(enviados.length, 0);
  });

  it('a passada para no prazo e deixa o resto para a próxima', async () => {
    await ligar({ payment_received: ['email'] });
    for (const k of ['p1', 'p2', 'p3']) {
      // eslint-disable-next-line no-await-in-loop
      await PlatformAlertService.enqueue('payment_received', { dedupeKey: k });
    }
    let relogio = 0;
    // Cada envio "leva" 15 s: o segundo já começa fora do prazo de 20 s.
    PlatformAlertService.senders = {
      ...PlatformAlertService.senders,
      email: async (to, msg) => { relogio += 15_000; enviados.push({ canal: 'email', to, ...msg }); return true; }
    };
    try {
      const r = await PlatformAlertService.processDue({ now: new Date(), clock: () => relogio });
      assert.equal(r.sent, 2);
      assert.equal(r.deferred, 1);
      const pendentes = await getDb()('platform_alerts').where({ event: 'payment_received', status: 'pending' });
      assert.equal(pendentes.length, 1);
      // Sem garra nem tentativa gasta: a próxima passada manda.
      assert.equal(pendentes[0].next_attempt_at, null);
      assert.equal(Number(pendentes[0].attempts), 0);
    } finally {
      PlatformAlertService.senders.email = async (to, msg) => { enviados.push({ canal: 'email', to, ...msg }); return !falhar.email; };
    }
  });

  it('alertsConfig lê o banco sem derrubar o cache do perfil', async () => {
    const { readProfile, CONFIG_KEY } = await import('../src/services/platformProfileService.js');
    const { default: AppState } = await import('../src/models/AppState.js');
    invalidatePlatformProfile();
    const antes = await readProfile();
    assert.equal(antes.alerts.events.card_refused.enabled, false);
    // Uma gravação por fora do saveProfile: o cache não sabe dela.
    const caixa = await getDb()('tenants').where({ kind: 'platform' }).first();
    const bruto = JSON.parse(await runInTenant(caixa.id, () => AppState.get(CONFIG_KEY)));
    bruto.alerts.events.card_refused = { enabled: true, channels: ['email'] };
    await runInTenant(caixa.id, () => AppState.upsert(CONFIG_KEY, JSON.stringify(bruto)));
    // O serviço de alertas vê o novo na hora...
    assert.equal((await alertsConfig()).events.card_refused.enabled, true);
    // ...e o cache de quinze segundos do perfil continua de pé.
    assert.equal((await readProfile()).alerts.events.card_refused.enabled, false);
    invalidatePlatformProfile();
    assert.equal((await readProfile()).alerts.events.card_refused.enabled, true);
  });
});

describe('o alerta de teste', () => {
  const testar = (body) => call(`${panelUrl}/api/platform/alerts/test`, {
    method: 'POST', body, headers: authHeaders(token)
  });

  it('manda agora pelos dois canais, mesmo com tudo desligado, e registra na trilha', async () => {
    const res = await testar({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.channels, { whatsapp: true, email: true });
    assert.deepEqual(enviados.map((e) => e.canal).sort(), ['email', 'whatsapp']);
    assert.equal(enviados[0].subject, 'Alerta de teste');
    const [linha] = await doEvento('test');
    assert.equal(linha.status, 'sent');
    const trilha = await getDb()('platform_audit').where({ action: 'platform.alert_test' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.equal(trilha.detail.includes('ops@plataforma.test'), false, 'o destino não vai para a trilha');
    // A passada do agendador não o manda de novo.
    enviados = [];
    await PlatformAlertService.processDue({ now: new Date(Date.now() + DIA) });
    assert.equal(enviados.length, 0);
  });

  it('respeita o canal pedido', async () => {
    const res = await testar({ channels: ['email'] });
    assert.equal(res.status, 200);
    assert.deepEqual(enviados.map((e) => e.canal), ['email']);
  });

  it('sem destino é 409; canal inválido é 400; falha é 502', async () => {
    await saveProfile({ notifyWhatsapp: '', notifyEmail: '' });
    assert.equal((await testar({})).status, 409);
    await saveProfile({ notifyWhatsapp: '93991935695', notifyEmail: 'ops@plataforma.test' });
    assert.equal((await testar({ channels: ['sms'] })).status, 400);
    falhar = { whatsapp: true, email: true };
    const res = await testar({});
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'send_failed');
  });

  it('não existe para quem não é do console', async () => {
    const res = await call(`${panelUrl}/api/platform/alerts/test`, { method: 'POST', body: {} });
    assert.equal(res.status, 401);
  });
});

describe('os ganchos', () => {
  it('payment_received: depois do pagamento, uma vez por referência', async () => {
    await ligar({ payment_received: ['whatsapp'] });
    await comAssinatura();
    const pagar = () => runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 19990, provider: 'asaas', externalId: 'pay_alerta_1'
    }));
    const primeiro = await pagar();
    assert.equal(primeiro.duplicate, false);
    const segundo = await pagar();
    assert.equal(segundo.duplicate, true);
    const linhas = await doEvento('payment_received');
    assert.equal(linhas.length, 1);
    assert.equal(JSON.parse(linhas[0].payload).amountCents, 19990);
    assert.equal(Number(linhas[0].tenant_id), alfa);
  });

  it('payment_received desligado não grava nada, e o pagamento passa igual', async () => {
    await comAssinatura();
    const r = await runInTenant(alfa, () => SubscriptionService.recordPayment({
      amountCents: 19990, provider: 'asaas', externalId: 'pay_alerta_off'
    }));
    assert.equal(r.duplicate, false);
    assert.equal((await alertas()).length, 0);
  });

  it('card_refused: uma vez por recusa', async () => {
    await ligar({ card_refused: ['email'] });
    await comAssinatura({
      card_token_ciphertext: 'cifra-de-teste', card_failed_at: aoSegundo(Date.now() - 1000),
      card_failure: 'charge_refused', card_failure_notified_at: null
    });
    await runInTenant(alfa, () => CardAutopayService.notifyRefusal({}));
    // A memória do aviso devolvida (o envio falhou): a passada seguinte tenta
    // o aviso de novo, mas o alerta da mesma recusa não repete.
    await getDb()('subscriptions').where({ tenant_id: alfa }).update({ card_failure_notified_at: null });
    await runInTenant(alfa, () => CardAutopayService.notifyRefusal({}));
    const linhas = await doEvento('card_refused');
    assert.equal(linhas.length, 1);
    const payload = JSON.parse(linhas[0].payload);
    assert.equal(payload.reason, 'charge_refused');
    assert.equal(linhas[0].payload.includes('cifra-de-teste'), false);
    await comAssinatura({ card_token_ciphertext: null, card_failed_at: null, card_failure: null, card_failure_notified_at: null });
  });

  it('cancellation_requested e cancellation_scheduled: um por pedido', async () => {
    await ligar({ cancellation_requested: ['email'], cancellation_scheduled: ['email'] });
    await comAssinatura();
    await getDb()('cancellation_requests').where({ tenant_id: alfa }).del();
    await runInTenant(alfa, () => CancellationService.request({ reason: 'too_expensive' }));
    await runInTenant(alfa, () => CancellationService.request({ reason: 'not_using' }));
    const pedidos = await doEvento('cancellation_requested');
    assert.equal(pedidos.length, 1);
    assert.equal(JSON.parse(pedidos[0].payload).reason, 'too_expensive');

    await runInTenant(alfa, () => CancellationService.confirm({}));
    const agendados = await doEvento('cancellation_scheduled');
    assert.equal(agendados.length, 1);
    const payload = JSON.parse(agendados[0].payload);
    assert.equal(payload.immediate, false);
    assert.ok(payload.date);
    await comAssinatura();
    await getDb()('cancellation_requests').where({ tenant_id: alfa }).del();
  });

  it('nfse_error: a transição para erro avisa, uma vez por nota por dia', async () => {
    await ligar({ nfse_error: ['email'] });
    const db = getDb();
    const chargeId = await insertReturningId('billing_charges', {
      tenant_id: alfa, period_end: '2031-01-01', amount_cents: 19990, currency: 'BRL', provider: 'asaas', status: 'paid'
    });
    await db('billing_invoices').insert({ tenant_id: alfa, charge_id: chargeId, status: 'pending' });
    const nota = await db('billing_invoices').where({ charge_id: chargeId }).first();
    await runInTenant(alfa, () => BillingInvoice.updateIf(nota.id, { status: 'pending' }, { status: 'error', error: 'Prefeitura recusou' }));
    // A mesma nota reaberta e com erro de novo no mesmo dia: não repete.
    await runInTenant(alfa, () => BillingInvoice.reopen(nota.id, 'error'));
    await runInTenant(alfa, () => BillingInvoice.updateIf(nota.id, { status: 'pending' }, { status: 'error', error: 'De novo' }));
    // Uma gravação que não é transição para erro não avisa.
    await runInTenant(alfa, () => BillingInvoice.updateIf(nota.id, { status: 'error' }, { status: 'error', error: 'mesmo' }));
    const linhas = await doEvento('nfse_error');
    assert.equal(linhas.length, 1);
    assert.equal(JSON.parse(linhas[0].payload).error, 'Prefeitura recusou');
    await db('billing_invoices').where({ charge_id: chargeId }).del();
    await db('billing_charges').where({ id: chargeId }).del();
  });

  it('auto_suspended: a suspensão automática avisa uma vez', async () => {
    await ligar({ auto_suspended: ['whatsapp'] });
    const vencimento = aoSegundo(Date.now() - 40 * DIA);
    const em = (dias) => new Date(vencimento.getTime() + dias * DIA);
    await comAssinatura({ renews_at: vencimento });
    await getDb()('subscription_reminder_sends').del();
    await getDb()('billing_charges').where({ tenant_id: alfa }).del();
    const passada = (now) => runInTenant(alfa, () => SubscriptionNoticeService.autoSuspendCurrent({ now }));
    await passada(em(12));
    const r = await passada(em(15));
    assert.equal(r.action, 'suspended', JSON.stringify(r));
    await passada(em(16));
    const linhas = await doEvento('auto_suspended');
    assert.equal(linhas.length, 1);
    assert.equal(JSON.parse(linhas[0].payload).date, vencimento.toISOString().slice(0, 10));
    await comAssinatura();
  });

  it('big_overdue: acima do limite, uma vez por período de atraso', async () => {
    await ligar({ big_overdue: ['email'] }, { bigOverdueCents: 30000 });
    const db = getDb();
    await db('billing_charges').where({ tenant_id: alfa }).del();
    await db('billing_charges').insert([
      { tenant_id: alfa, period_end: '2030-01-10', amount_cents: 19990, currency: 'BRL', provider: 'asaas', status: 'pending', due_date: '2030-01-10', gateway_charge_id: 'pay_bo_1' },
      { tenant_id: alfa, period_end: '2030-02-10', amount_cents: 19990, currency: 'BRL', provider: 'asaas', status: 'overdue', due_date: '2030-02-10', gateway_charge_id: 'pay_bo_2' },
      // Nunca chegaram ao gateway: não são dívida que o provedor pague.
      { tenant_id: alfa, period_end: '2029-12-10', amount_cents: 90000, currency: 'BRL', provider: 'asaas', status: 'failed', due_date: '2029-12-10', gateway_charge_id: null },
      { tenant_id: alfa, period_end: '2029-11-10', amount_cents: 90000, currency: 'BRL', provider: 'asaas', status: 'pending', due_date: '2029-11-10', gateway_charge_id: null }
    ]);
    // Abaixo do limite (só a primeira vencida): nada.
    await PlatformAlertService.checkBigOverdue({ now: new Date('2030-01-20T12:00:00Z') });
    assert.equal((await doEvento('big_overdue')).length, 0);
    // As duas vencidas passam do limite.
    await PlatformAlertService.checkBigOverdue({ now: new Date('2030-02-20T12:00:00Z') });
    await PlatformAlertService.checkBigOverdue({ now: new Date('2030-02-21T12:00:00Z') });
    const linhas = await doEvento('big_overdue');
    assert.equal(linhas.length, 1);
    const payload = JSON.parse(linhas[0].payload);
    assert.equal(payload.amountCents, 39980);
    assert.equal(payload.thresholdCents, 30000);
    assert.equal(payload.date, '2030-01-10');
    await PlatformAlertService.processDue({ now: new Date() });
    assert.match(enviados[0].text, /R\$\s?399,80/);
    assert.match(enviados[0].text, /10\/01\/2030/);
    await db('billing_charges').where({ tenant_id: alfa }).del();
  });

  it('big_overdue: a assinatura cancelada ou isenta não avisa', async () => {
    await ligar({ big_overdue: ['email'] }, { bigOverdueCents: 10000 });
    const db = getDb();
    await db('billing_charges').where({ tenant_id: alfa }).del();
    await db('billing_charges').insert({
      tenant_id: alfa, period_end: '2030-05-10', amount_cents: 19990, currency: 'BRL', provider: 'asaas',
      status: 'overdue', due_date: '2030-05-10', gateway_charge_id: 'pay_bo_3'
    });
    const now = new Date('2030-05-20T12:00:00Z');
    await comAssinatura({ status: 'canceled', canceled_at: aoSegundo(Date.now()) });
    assert.equal((await PlatformAlertService.checkBigOverdue({ now })).enqueued, 0);
    await comAssinatura({ billing_exempt_at: aoSegundo(Date.now()) });
    assert.equal((await PlatformAlertService.checkBigOverdue({ now })).enqueued, 0);
    // Ainda não vencida (o vencimento é amanhã): também não.
    await comAssinatura();
    assert.equal((await PlatformAlertService.checkBigOverdue({ now: new Date('2030-05-09T12:00:00Z') })).enqueued, 0);
    assert.equal((await PlatformAlertService.checkBigOverdue({ now })).enqueued, 1);
    await db('billing_charges').where({ tenant_id: alfa }).del();
  });

  it('nfse_error: o dia da deduplicação é o de Brasília', async () => {
    await ligar({ nfse_error: ['email'] });
    const db = getDb();
    const chargeId = await insertReturningId('billing_charges', {
      tenant_id: alfa, period_end: '2031-02-01', amount_cents: 19990, currency: 'BRL', provider: 'asaas', status: 'paid'
    });
    await db('billing_invoices').insert({ tenant_id: alfa, charge_id: chargeId, status: 'pending' });
    const nota = await db('billing_invoices').where({ charge_id: chargeId }).first();
    await runInTenant(alfa, () => BillingInvoice.updateIf(nota.id, { status: 'pending' }, { status: 'error', error: 'x' }));
    const [linha] = await doEvento('nfse_error');
    assert.equal(linha.dedupe_key, `nfse_error:${alfa}:${nota.id}:${saoPauloClock().day}`);
    await db('billing_invoices').where({ charge_id: chargeId }).del();
    await db('billing_charges').where({ id: chargeId }).del();
  });

  it('big_overdue desligado nem consulta', async () => {
    const r = await PlatformAlertService.checkBigOverdue({ now: new Date() });
    assert.deepEqual(r, { checked: false, reason: 'disabled' });
    assert.equal((await alertsConfig()).events.big_overdue.enabled, false);
  });
});
