import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpLink } = await import('../src/models/SgpLink.js');

const DEVICE_ID = 'ticket-device-1';
const CONTRACT = '4321';
const APP = 'painel';
const TOKEN = 'token-secreto-123';

let panelUrl;
let token;
let sgpUrl;
let sgpServer;

/** What the stub answers with, so one test can make it unrecognisable. */
let ticketResponse = { status: 1, msg: 'Chamado aberto', chamado: 90210 };
const requests = [];

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      requests.push({ url: req.url, payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/api/ura/chamado')) {
        return res.end(JSON.stringify(ticketResponse));
      }
      return res.end(JSON.stringify({ status: 0, msg: 'Endpoint inexistente' }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${sgpServer.address().port}`);
    });
  });
}

const configure = (patch) => call(`${panelUrl}/api/sgp/config`, {
  method: 'PUT',
  headers: authHeaders(token),
  body: patch
});

const openTicket = (body) => call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}/ticket`, {
  method: 'POST',
  headers: authHeaders(token),
  body
});

/** The last body the stub saw on the ticket route. */
function lastTicketPayload() {
  return [...requests].reverse().find((entry) => entry.url.startsWith('/api/ura/chamado'))?.payload;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgpUrl = await startSgpStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await configure({
    enabled: true,
    baseUrl: sgpUrl,
    app: APP,
    token: TOKEN,
    ticketEnabled: true
  });

  // A stored link, so the contract resolves without a customer lookup — the
  // same path the trust unlock takes.
  await asTenant(() => SgpLink.upsert({
    device_id: DEVICE_ID,
    contract: CONTRACT,
    link_mode: 'manual'
  }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

beforeEach(() => {
  requests.length = 0;
  ticketResponse = { status: 1, msg: 'Chamado aberto', chamado: 90210 };
});

describe('opening a ticket', () => {
  it('sends the contract, the text and the occurrence type', async () => {
    const { status, body } = await openTicket({ content: 'ONT com sinal em -29 dBm' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.contract, CONTRACT);
    assert.equal(body.data.ticket, '90210');

    const payload = lastTicketPayload();
    assert.equal(String(payload.contrato), CONTRACT);
    assert.equal(payload.conteudo, 'ONT com sinal em -29 dBm');
    assert.equal(payload.app, APP);
    assert.equal(payload.token, TOKEN);
  });

  it('sends no field SGP does not document for this route', async () => {
    // `setor` belongs to the subscriber's own /api/ura/central/chamado/, which
    // authenticates with cpfcnpj+senha; `conteudolimpo` is spelled two ways
    // across the references. Neither is guessed at here, and this test is what
    // stops one being added later on a hunch.
    await openTicket({ content: 'teste' });
    const payload = lastTicketPayload();

    assert.equal('setor' in payload, false);
    assert.equal('conteudolimpo' in payload, false);
    assert.equal('conteudolimp' in payload, false);
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['app', 'conteudo', 'contrato', 'ocorrenciatipo', 'token']
    );
  });

  it('adds the note only when there is one', async () => {
    await openTicket({ content: 'teste' });
    assert.equal('observacao' in lastTicketPayload(), false);

    await openTicket({ content: 'teste', note: 'cliente pediu retorno à tarde' });
    assert.equal(lastTicketPayload().observacao, 'cliente pediu retorno à tarde');
  });

  it('falls back to the configured occurrence type, and lets the request override it', async () => {
    await openTicket({ content: 'teste' });
    assert.equal(lastTicketPayload().ocorrenciatipo, 5, 'the documented default');

    await configure({ ticketOccurrenceType: 30 });
    await openTicket({ content: 'teste' });
    assert.equal(lastTicketPayload().ocorrenciatipo, 30);

    await openTicket({ content: 'teste', occurrenceType: 12 });
    assert.equal(lastTicketPayload().ocorrenciatipo, 12);

    await configure({ ticketOccurrenceType: 5 });
  });

  it('refuses before calling SGP when there is nothing to say', async () => {
    const { status } = await openTicket({ content: '   ' });
    assert.equal(status, 400);
    assert.equal(lastTicketPayload(), undefined, 'nothing should have been sent');
  });

  it('refuses while the feature is off', async () => {
    await configure({ ticketEnabled: false });
    const { status } = await openTicket({ content: 'teste' });
    assert.equal(status, 409);
    assert.equal(lastTicketPayload(), undefined);
    await configure({ ticketEnabled: true });
  });

  it('requires an admin session', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}/ticket`, {
      method: 'POST',
      body: { content: 'teste' }
    });
    assert.equal(status, 401);
  });
});

describe('reading back what SGP answered', () => {
  it('finds the protocol number under the other spellings', async () => {
    ticketResponse = { status: 1, protocolo: 'OS-4455' };
    const { body } = await openTicket({ content: 'teste' });
    assert.equal(body.data.ticket, 'OS-4455');
  });

  it('is a success with our own wording when the body is unrecognisable', async () => {
    // The response shape is the half of this route nobody documents. An install
    // answering something we have never seen has still opened the ticket, and
    // reporting a failure would have the operator open a second one by phone.
    ticketResponse = { ok: true, alguma_coisa: 'sim' };
    const { status, body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}/ticket`, {
      method: 'POST',
      // Asked for in English so the assertion is about which key the controller
      // reached for, not about which locale the panel defaults to.
      headers: { ...authHeaders(token), 'Accept-Language': 'en' },
      body: { content: 'teste' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.ticket, null);
    assert.equal(body.message, 'Ticket opened in SGP');
  });
});

describe('the endpoint path', () => {
  it('defaults to the documented one and stays configurable', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/config`, { headers: authHeaders(token) });
    assert.equal(body.data.endpoints.ticket, '/api/ura/chamado/');

    await configure({ endpoints: { ticket: '/api/ura/chamado-alternativo/' } });
    const changed = await call(`${panelUrl}/api/sgp/config`, { headers: authHeaders(token) });
    assert.equal(changed.body.data.endpoints.ticket, '/api/ura/chamado-alternativo/');

    // The other three must not have moved with it.
    assert.equal(changed.body.data.endpoints.unlock, '/api/ura/liberacaopromessa/');
    await configure({ endpoints: { ticket: '/api/ura/chamado/' } });
  });
});
