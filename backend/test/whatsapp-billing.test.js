import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaBroadcast } = await import('../src/models/WaBroadcast.js');

// Reached directly, with no request to resolve a provider — the routes that
// build and flush campaigns already carry theirs.
const campaign = {
  listRecipients: (id) => asTenant(() => WaBroadcast.listRecipients(id)),
  getById: (id) => asTenant(() => WaBroadcast.getById(id))
};
const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');

const APP = 'painel';
const TOKEN = 'token-secreto-cobranca';
const EVO_BASE = 'https://evo.provedor.test';

/**
 * The dunning body used by most tests. It cites `{{pix}}` and `{{dias_atraso}}`
 * on purpose: those are the two variables that make the renderer refuse, and
 * refusing is the behaviour under test.
 */
const COBRANCA = 'Olá {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias. PIX: {{pix}}';
const LEMBRETE = 'Olá {{nome}}, sua fatura de {{valor}} vence em {{dias_para_vencer}} dias.';
/** What an operator writes when trying to cover both cases with one text. */
const AMBOS = 'Olá {{nome}}: {{dias_atraso}} dias de atraso, {{dias_para_vencer}} dias para vencer.';

let panelUrl;
let token;
let sgpServer;
let sgpUrl;

/**
 * `YYYY-MM-DD`, N days from today. Negative is in the past.
 *
 * Call it WHEN THE SGP ANSWERS, never while building the fixtures. The fixtures
 * below are module constants, evaluated once at import; the panel counts
 * "overdue for N days" against the instant of each request. With the due dates
 * frozen at import, a run that crossed 00:00 UTC between the two counted one
 * day more than the fixture meant, and four assertions read 11 where they
 * expected 10. The fixtures declare an offset (`venceEmDias`) and the stub
 * resolves it per response, so seeding and measuring share the same instant.
 */
function dayOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Every subscriber the fixture knows, and what the SGP answers about each.
 *
 * One row per skip reason the campaign build has to be able to name, so a
 * single build can prove that the six counters are six different facts.
 */
const SUBSCRIBERS = [
  {
    contract: 'C-ATRASO-1',
    name: 'João da Silva',
    phone: '5593981110001',
    invoices: [{
      numerodocumento: '1',
      valor: '129,90',
      venceEmDias: -10,
      pix: 'pix-copia-e-cola-1',
      linhadigitavel: '34191790010104351004791020150008699999999999'
    }]
  },
  {
    contract: 'C-ATRASO-2',
    name: 'Maria Souza',
    phone: '5593981110002',
    invoices: [{
      numerodocumento: '2', valor: '89,90', venceEmDias: -3, pix: 'pix-copia-e-cola-2'
    }]
  },
  {
    contract: 'C-FUTURA',
    name: 'Carlos Lima',
    phone: '5593981110003',
    invoices: [{
      numerodocumento: '3', valor: '99,90', venceEmDias: 3, pix: 'pix-copia-e-cola-3'
    }]
  },
  {
    // Linked to an ONT, but the cadastre has no mobile.
    contract: 'C-SEM-FONE',
    name: 'Ana Prado',
    phone: null,
    invoices: [{ numerodocumento: '4', valor: '129,90', venceEmDias: -8, pix: 'pix-4' }]
  },
  {
    contract: 'C-OPTOUT',
    name: 'Pedro Alves',
    phone: '5593981110005',
    invoices: [{ numerodocumento: '5', valor: '129,90', venceEmDias: -6, pix: 'pix-5' }]
  },
  {
    contract: 'C-EM-DIA',
    name: 'Rita Nunes',
    phone: '5593981110006',
    invoices: []
  },
  {
    // The ERP answers `status: 0` for this one.
    contract: 'C-RECUSADO',
    name: 'Bruno Dias',
    phone: '5593981110007',
    invoices: null
  },
  {
    // Overdue, but the boleto carries no PIX code, so `{{pix}}` cannot be filled.
    contract: 'C-SEM-PIX',
    name: 'Lucia Melo',
    phone: '5593981110008',
    invoices: [{ numerodocumento: '8', valor: '129,90', venceEmDias: -4 }]
  }
];

const byContract = new Map(SUBSCRIBERS.map((row) => [row.contract, row]));

/** Minimal stand-in for a provider's SGP instance. */
function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) {
        return send({ status: 0, msg: 'Token inválido' });
      }
      if (req.url.startsWith('/api/ura/titulos')) {
        const subscriber = byContract.get(String(payload.contrato));
        if (!subscriber || subscriber.invoices === null) {
          return send({ status: 0, msg: 'Contrato inexistente' });
        }
        const titulos = subscriber.invoices.map(({ venceEmDias, ...titulo }) => ({
          ...titulo,
          vencimento: dayOffset(venceEmDias)
        }));
        return send({ status: 1, titulos });
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 0, msg: 'Endpoint inexistente' }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

/**
 * Builds a campaign through the route, after clearing the build ceiling.
 *
 * Every test but the ceiling's own one goes through here: the limit is three
 * builds per five minutes for the whole process, so without this the fourth
 * test in the file would start failing for a reason it is not about.
 */
function buildCampaign(body) {
  WaBillingService.buildWindows.clear();
  return call(`${panelUrl}/api/whatsapp/billing/campaign`, {
    method: 'POST',
    headers: authHeaders(token),
    body
  });
}

const queuedMessages = () => getDb()('wa_messages').where({ delivery_status: 'queued' });

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgpUrl = await startSgpStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe'
  }));
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-cobranca',
    purpose: 'billing',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));

  // One `sgp_links` row per subscriber: that table is where the panel keeps the
  // phone, so it is the campaign's address book.
  const now = new Date();
  await getDb()('sgp_links').insert(SUBSCRIBERS.map((subscriber, index) => ({
    device_id: `ont-${index}`,
    contract: subscriber.contract,
    client_name: subscriber.name,
    document: '12345678909',
    state: 'active',
    link_mode: 'auto',
    phone_e164: subscriber.phone,
    created_at: now,
    updated_at: now
  })));

  await asTenant(() => WaOptOut.record({ waPhone: byContract.get('C-OPTOUT').phone, origin: 'customer' }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('templates', () => {
  it('refuses a body citing a variable the dispatcher cannot fill', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/templates`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {
        name: 'inválido',
        body: 'Olá {{nome}}, veja {{fatura_anterior}} e {{saldo_devedor}}.',
        category: 'cobranca'
      }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'unknown_variable');
    // Named, not counted: the operator has to know which words to delete.
    assert.match(body.message, /fatura_anterior/);
    assert.match(body.message, /saldo_devedor/);
  });

  it('refuses a body citing both day mirrors, which could never be sent', async () => {
    // Both names are fillable, so the unknown-variable check passes and every
    // other check passes too — and the template still cannot render for
    // anybody, because one of the two mirrors is always empty and an empty
    // cited variable refuses the whole message. Left to the dispatcher it would
    // surface hours later as a `templateIncomplete` count on a campaign that
    // reached nobody.
    const { status, body } = await call(`${panelUrl}/api/whatsapp/templates`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {
        name: 'espelhos',
        body: 'Atraso de {{dias_atraso}} dias, vence em {{dias_para_vencer}} dias.',
        category: 'cobranca'
      }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'template_mirrors');

    // Either one alone is a normal template.
    for (const only of ['{{dias_atraso}}', '{{dias_para_vencer}}']) {
      const ok = await call(`${panelUrl}/api/whatsapp/templates`, {
        method: 'POST',
        headers: authHeaders(token),
        body: { name: `so ${only}`, body: `Sao ${only} dias.`, category: 'cobranca' }
      });
      assert.equal(ok.status, 201, only);
      await call(`${panelUrl}/api/whatsapp/templates/${ok.body.data.id}`, {
        method: 'DELETE',
        headers: authHeaders(token)
      });
    }
  });

  it('stores a body that only cites known variables', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/templates`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { name: 'cobranca-padrao', body: COBRANCA, category: 'cobranca' }
    });
    assert.equal(status, 201);
    assert.equal(body.data.name, 'cobranca-padrao');
    assert.equal(body.data.active, true);
  });

  it('lists, renames and deletes', async () => {
    const list = await call(`${panelUrl}/api/whatsapp/templates`, { headers: authHeaders(token) });
    assert.equal(list.body.data.length, 1);
    const { id } = list.body.data[0];

    const renamed = await call(`${panelUrl}/api/whatsapp/templates/${id}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { name: 'cobranca-2026' }
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.name, 'cobranca-2026');
    // A patch that omits the body keeps it rather than blanking it.
    assert.equal(renamed.body.data.body, COBRANCA);

    const rejected = await call(`${panelUrl}/api/whatsapp/templates/${id}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { body: 'Olá {{nome}}, {{codigo_pix_antigo}}' }
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'unknown_variable');

    const removed = await call(`${panelUrl}/api/whatsapp/templates/${id}`, {
      method: 'DELETE',
      headers: authHeaders(token)
    });
    assert.equal(removed.status, 200);
    const after2 = await call(`${panelUrl}/api/whatsapp/templates`, { headers: authHeaders(token) });
    assert.equal(after2.body.data.length, 0);
  });

  const criar = (payload) => call(`${panelUrl}/api/whatsapp/templates`, {
    method: 'POST', headers: authHeaders(token), body: payload
  });

  it('aceita uma resposta rápida de atendimento com as variáveis da conversa', async () => {
    const { status, body } = await criar({
      name: 'boas-vindas',
      body: 'Olá {{primeiro_nome}}, aqui é {{atendente}}. Contrato {{contrato}}, {{nome}}.',
      category: 'atendimento'
    });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.category, 'atendimento');
    const lista = await call(`${panelUrl}/api/whatsapp/templates?category=atendimento`, { headers: authHeaders(token) });
    assert.ok(lista.body.data.every((t) => t.category === 'atendimento'));
    assert.ok(lista.body.data.some((t) => t.name === 'boas-vindas'));
  });

  it('cada categoria só aceita as suas variáveis', async () => {
    const pix = await criar({ name: 'rapida-pix', body: 'Seu PIX: {{pix}}', category: 'atendimento' });
    assert.equal(pix.status, 400);
    assert.equal(pix.body.code, 'unknown_variable');
    const primeiro = await criar({ name: 'cobranca-primeiro', body: 'Oi {{primeiro_nome}}', category: 'cobranca' });
    assert.equal(primeiro.status, 400);
    assert.equal(primeiro.body.code, 'unknown_variable');
  });

  it('mudar só a categoria revalida o texto gravado', async () => {
    const criado = await criar({ name: 'rapida-atendente', body: 'Aqui é {{atendente}}.', category: 'atendimento' });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const mudou = await call(`${panelUrl}/api/whatsapp/templates/${criado.body.data.id}`, {
      method: 'PUT', headers: authHeaders(token), body: { category: 'cobranca' }
    });
    assert.equal(mudou.status, 400);
    assert.equal(mudou.body.code, 'unknown_variable');
  });

  it('requires an administrator session', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/templates`);
    assert.equal(status, 401);
  });
});

describe('the overdue listing', () => {
  it('defaults to invoices that have come due', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/billing/overdue`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    const contracts = body.data.map((row) => row.contract);
    assert.ok(contracts.includes('C-ATRASO-1'));
    assert.ok(contracts.includes('C-SEM-FONE'), 'a missing phone is shown, not hidden');
    // Not yet due, and nothing owed at all: neither belongs in a dunning list.
    assert.ok(!contracts.includes('C-FUTURA'));
    assert.ok(!contracts.includes('C-EM-DIA'));
    // The ERP refused this contract; one refusal does not end the listing.
    assert.ok(!contracts.includes('C-RECUSADO'));
    const atraso = body.data.find((row) => row.contract === 'C-ATRASO-1');
    assert.equal(atraso.daysOverdue, 10);
    assert.equal(atraso.amount, 129.9);
    assert.equal(atraso.phone, '5593981110001');
    assert.equal(atraso.phoneSource, 'sgp');
  });

  it('reads a negative daysMin as "due within N days"', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/whatsapp/billing/overdue?daysMin=-5`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200);
    const futura = body.data.find((row) => row.contract === 'C-FUTURA');
    assert.ok(futura, 'a subscriber due in three days is inside a -5 window');
    // The scale is one continuous line through zero, not two switches.
    assert.equal(futura.daysOverdue, -3);
  });

  it('filters by name', async () => {
    const { body } = await call(
      `${panelUrl}/api/whatsapp/billing/overdue?search=maria`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].contract, 'C-ATRASO-2');
  });
});

describe('building a campaign', () => {
  it('produces a draft, counts every skip by reason, and sends nothing', async () => {
    const before2 = await queuedMessages();
    const contracts = SUBSCRIBERS.map((row) => row.contract);
    const { status, body } = await buildCampaign({ template: COBRANCA, contracts });

    assert.equal(status, 201);
    // THE rule of this feature: a build is a draft. Nobody is messaged by
    // opening a listing screen.
    assert.equal(body.data.broadcast.status, 'draft');
    assert.equal(body.data.recipients, 2);
    assert.deepEqual(body.data.skipped, {
      noPhone: 1,
      optOut: 1,
      noInvoice: 1,
      futureOnly: 1,
      sgpRefused: 1,
      templateIncomplete: 1,
      // …and says WHICH variable the incomplete one lacked.
      missing: { pix: 1 }
    });

    // The counts explain the whole input, with nothing falling between them.
    const skippedTotal = Object.values(body.data.skipped)
      .filter((n) => typeof n === 'number')
      .reduce((a, b) => a + b, 0);
    assert.equal(body.data.recipients + skippedTotal, contracts.length);

    const after2 = await queuedMessages();
    assert.equal(after2.length, before2.length, 'building must not enqueue a single message');

    const recipients = await campaign.listRecipients(body.data.broadcast.id);
    assert.equal(recipients.length, 2);
    assert.ok(recipients.every((row) => row.status === 'pending'));
    // Rendered once, at build time, so what the operator reviews is what goes.
    assert.match(recipients[0].rendered_body, /João da Silva/);
    assert.match(recipients[0].rendered_body, /R\$ 129,90/);
    assert.match(recipients[0].rendered_body, /venceu há 10 dias/);
    assert.match(recipients[0].rendered_body, /PIX: pix-copia-e-cola-1/);
  });

  it('excludes a number that asked not to be contacted', async () => {
    const { body } = await buildCampaign({
      template: COBRANCA,
      contracts: ['C-ATRASO-1', 'C-OPTOUT']
    });
    assert.equal(body.data.recipients, 1);
    assert.equal(body.data.skipped.optOut, 1);
    const recipients = await campaign.listRecipients(body.data.broadcast.id);
    assert.deepEqual(recipients.map((row) => row.phone_e164), ['5593981110001']);
  });

  it('drops a not-yet-due subscriber whose body cites {{dias_atraso}}', async () => {
    // `AMBOS` is a reminder (it cites `{{dias_para_vencer}}`), so the future
    // invoice IS selected — and then the renderer refuses it, because rule 2
    // leaves `dias_atraso` empty for an invoice that has not come due. The
    // separation does not depend on anyone noticing.
    const { status, body } = await buildCampaign({ template: AMBOS, contracts: ['C-FUTURA'] });
    assert.equal(status, 409);
    assert.equal(body.code, 'no_recipients');
    // The refusal still carries the breakdown: "nobody left" is not an answer.
    assert.equal(body.skipped.templateIncomplete, 1);
    assert.equal(body.skipped.futureOnly, 0);
  });

  it('lets a reminder body include an invoice that has not come due', async () => {
    const { status, body } = await buildCampaign({
      template: LEMBRETE,
      contracts: ['C-FUTURA'],
      title: 'Lembrete de vencimento'
    });
    assert.equal(status, 201);
    assert.equal(body.data.recipients, 1);
    assert.equal(body.data.broadcast.title, 'Lembrete de vencimento');
    const [recipient] = await campaign.listRecipients(body.data.broadcast.id);
    assert.match(recipient.rendered_body, /vence em 3 dias/);
  });

  it('refuses a body citing a variable it cannot fill', async () => {
    const { status, body } = await buildCampaign({
      template: 'Olá {{nome}}, {{saldo_total}}',
      contracts: ['C-ATRASO-1']
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'unknown_variable');
  });

  it('caps a campaign at 300 recipients', async () => {
    const contracts = Array.from({ length: 301 }, (_, i) => `C-${i}`);
    const { status, body } = await buildCampaign({ template: COBRANCA, contracts });
    assert.equal(status, 400);
    assert.equal(body.code, 'too_many_recipients');
  });

  it('answers 429 after three builds in five minutes', async () => {
    WaBillingService.buildWindows.clear();
    const payload = {
      method: 'POST',
      headers: authHeaders(token),
      body: { template: COBRANCA, contracts: ['C-ATRASO-1'] }
    };
    const url = `${panelUrl}/api/whatsapp/billing/campaign`;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { status } = await call(url, payload);
      assert.equal(status, 201);
    }
    const fourth = await call(url, payload);
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.code, 'rate_limited');
    WaBillingService.buildWindows.clear();
  });
});

describe('the flush loop', () => {
  it('enqueues the running campaign and never sends from the build', async () => {
    const { body } = await buildCampaign({
      template: COBRANCA,
      contracts: ['C-ATRASO-1', 'C-ATRASO-2'],
      title: 'Disparo de teste'
    });
    const broadcastId = body.data.broadcast.id;

    // A draft is inert: the loop must not touch it.
    await WaBroadcastService.tick();
    assert.equal((await campaign.listRecipients(broadcastId))
      .filter((row) => row.status !== 'pending').length, 0);

    const started = await call(`${panelUrl}/api/whatsapp/broadcasts/${broadcastId}/status`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { status: 'running' }
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.data.status, 'running');
    assert.ok(started.body.data.startAt);

    await WaBroadcastService.tick();

    const recipients = await campaign.listRecipients(broadcastId);
    assert.ok(recipients.every((row) => row.status === 'sent'));
    assert.ok(recipients.every((row) => row.message_id));
    const messages = await getDb()('wa_messages').whereIn(
      'id', recipients.map((row) => row.message_id)
    );
    assert.equal(messages.length, 2);
    // Handed to the outbox as an ordinary outbound message; the campaign has no
    // transport of its own.
    assert.ok(messages.every((row) => row.delivery_status === 'queued'));
    assert.ok(messages.every((row) => row.body.includes('PIX: ')));
    // Named on the row, and it goes into the SUBSCRIBER's own thread: unnamed,
    // the self-service bot counted a dunning message as one of its own three
    // replies and went silent on the person it had just charged.
    assert.ok(messages.every((row) => row.source === 'campaign'));

    const finished = await campaign.getById(broadcastId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.sent_count, 2);
    assert.equal(finished.failed_count, 0);
  });

  it('retires a recipient that opted out between the build and the start', async () => {
    const { body } = await buildCampaign({
      template: COBRANCA,
      contracts: ['C-ATRASO-1', 'C-ATRASO-2']
    });
    const broadcastId = body.data.broadcast.id;

    // The build let this number through; the request arrives afterwards. The
    // loop has to honour it, and — the part that matters — has to move the row
    // to a terminal state rather than leaving it pending forever.
    await asTenant(() => WaOptOut.record({ waPhone: '5593981110002', origin: 'customer' }));

    await call(`${panelUrl}/api/whatsapp/broadcasts/${broadcastId}/status`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { status: 'running' }
    });
    await WaBroadcastService.tick();

    const recipients = await campaign.listRecipients(broadcastId);
    const skipped = recipients.find((row) => row.phone_e164 === '5593981110002');
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.error_msg, 'opt_out');
    assert.equal(recipients.find((row) => row.phone_e164 === '5593981110001').status, 'sent');

    const finished = await campaign.getById(broadcastId);
    // If the opt-out had been a filter on the pending query instead of a guard
    // inside the loop, this row would never have left 'pending' and the
    // campaign would still be 'running' with nothing left to do.
    assert.equal(finished.status, 'done');
    assert.equal(finished.sent_count, 1);
    assert.equal(finished.failed_count, 1);
  });

  it('walks the campaign state machine and refuses impossible moves', async () => {
    const { body } = await buildCampaign({ template: COBRANCA, contracts: ['C-ATRASO-1'] });
    const id = body.data.broadcast.id;
    const move = (status) => call(`${panelUrl}/api/whatsapp/broadcasts/${id}/status`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { status }
    });

    // Pausing something that never started is not a state.
    assert.equal((await move('paused')).status, 409);
    assert.equal((await move('running')).status, 200);
    assert.equal((await move('paused')).status, 200);

    // Paused means paused: the loop leaves it alone.
    await WaBroadcastService.tick();
    assert.ok((await campaign.listRecipients(id)).every((row) => row.status === 'pending'));

    assert.equal((await move('canceled')).status, 200);
    // A cancelled campaign is history; restarting it would re-send to whoever
    // it already reached.
    const reopened = await move('running');
    assert.equal(reopened.status, 409);
    assert.equal(reopened.body.code, 'invalid_status');
  });

  it('does not charge an invoice paid after the build, and sends when the SGP is down', async () => {
    // The test above left C-ATRASO-2 on the do-not-disturb list; take it off.
    await getDb()('wa_opt_outs').where({ wa_phone_e164: '5593981110002' }).update({ revoked_at: new Date() });
    const { body } = await buildCampaign({ template: COBRANCA, contracts: ['C-ATRASO-1', 'C-SEM-PIX', 'C-ATRASO-2'] });
    const broadcastId = body.data.broadcast.id;
    const built = await campaign.listRecipients(broadcastId);
    assert.deepEqual(built.map((row) => row.invoice_key).sort(), ['1', '2'], 'the invoice each message cites');

    // C-ATRASO-2 pays while the campaign sits in draft: the open list no
    // longer has its invoice. C-ATRASO-1's SGP refuses to answer.
    const pagou = byContract.get('C-ATRASO-2');
    const recusou = byContract.get('C-ATRASO-1');
    const [faturas2, faturas1] = [pagou.invoices, recusou.invoices];
    pagou.invoices = [];
    recusou.invoices = null;
    try {
      await asTenant(() => WaBroadcastService.setStatus(broadcastId, 'running'));
      await WaBroadcastService.tick();
    } finally {
      pagou.invoices = faturas2;
      recusou.invoices = faturas1;
    }

    const recipients = await campaign.listRecipients(broadcastId);
    const paid = recipients.find((row) => row.contract === 'C-ATRASO-2');
    assert.equal(paid.status, 'skipped');
    assert.equal(paid.error_msg, 'paid');
    assert.equal(paid.message_id, null, 'nothing was queued for the payer');
    const sent = recipients.find((row) => row.contract === 'C-ATRASO-1');
    assert.equal(sent.status, 'sent', 'an SGP that does not answer does not freeze the campaign');
  });

  it('lists campaigns newest first', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/broadcasts`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.ok(body.data.length >= 2);
    assert.ok(body.data[0].id > body.data[1].id);
    assert.ok('sentCount' in body.data[0] && 'rateLimitPerMin' in body.data[0]);
  });
});

describe('the do-not-disturb list', () => {
  it('adds a number, normalising what the operator typed', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/opt-outs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { phone: '(93) 98111-0099', reasonText: 'pediu por telefone' }
    });
    assert.equal(status, 201);
    // Stored in the form a campaign asks about, or it would match nothing.
    assert.equal(body.data.waPhoneE164, '5593981110099');
    assert.equal(body.data.origin, 'operator');
  });

  it('refuses something that is not a phone number', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/opt-outs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { phone: '123' }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'invalid_phone');
  });

  it('lists and revokes', async () => {
    const list = await call(`${panelUrl}/api/whatsapp/opt-outs`, { headers: authHeaders(token) });
    assert.equal(list.status, 200);
    const entry = list.body.data.find((row) => row.waPhoneE164 === '5593981110099');
    assert.ok(entry);

    const revoked = await call(`${panelUrl}/api/whatsapp/opt-outs/${entry.id}`, {
      method: 'DELETE',
      headers: authHeaders(token)
    });
    assert.equal(revoked.status, 200);
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: '5593981110099' })), false);

    const missing = await call(`${panelUrl}/api/whatsapp/opt-outs/999999`, {
      method: 'DELETE',
      headers: authHeaders(token)
    });
    assert.equal(missing.status, 404);
  });
});
