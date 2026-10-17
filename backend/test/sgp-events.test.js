import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AppState } = await import('../src/models/AppState.js');
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: SgpService } = await import('../src/services/sgpService.js');

// Reached directly, with no request behind it, so nothing has resolved a
// provider. The routes that call this are already inside one.
const resolveDeviceContract = (...args) => asTenant(() => SgpService.resolveDeviceContract(...args));

const DEVICE_ID = 'stub-device-1';
const PPPOE = 'joao@provedor';
const APP = 'painel';
const TOKEN = 'token-secreto-123';

let panelUrl;
let token;
let sgpUrl;
let sgpServer;
let genie;
let webhookSecret;
const contractState = { blocked: false, statusDisplay: 'Ativo', plan: 'Fibra 500MB' };

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        payload = {};
      }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) {
        return send({ status: 0, msg: 'Token inválido' });
      }
      if (req.url.startsWith('/api/ura/consultacliente')) {
        return send({
          status: 1,
          contratos: [{
            contrato: 4321,
            contratoStatusDisplay: contractState.statusDisplay,
            planoInternet: contractState.plan,
            razaoSocial: 'João da Silva',
            cpfcnpj: '12345678909',
            login: PPPOE,
            bloqueado: contractState.blocked
          }]
        });
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

function sign(body, secret = webhookSecret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Posts a pre-serialized body so the signature covers the exact bytes sent. */
async function postWebhook(body, headers = {}) {
  const response = await fetch(`${panelUrl}/api/sgp/events/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * Waits for the pass the webhook route starts to finish with one event.
 *
 * The route answers 202 and then processes pending events in the background,
 * so a test that runs `processPending` itself races that pass: both read the
 * same pending row, and each refreshes the link from SGP before acting on it.
 * A cancellation can then interleave as refresh, unlink, refresh, unlink, and a
 * read between the second refresh and the second unlink finds a link that is
 * about to go away. Waiting for the route's own pass leaves exactly one
 * processor, which is also how the event is handled outside a test.
 */
async function settled(eventId, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = await getDb()('sgp_events').where({ id: eventId }).first();
    if (event && event.status !== 'pending') return event;
    assert.ok(Date.now() < deadline, `event ${eventId} was still pending after ${timeoutMs}ms`);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgpUrl = await startSgpStub();
  genie = await startGenieAcsStub({ devices: [buildDevice()] });

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await call(`${panelUrl}/api/settings/genieAcsUrl`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { value: genie.url }
  });
  await call(`${panelUrl}/api/sgp/config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe' }
  });
  await getDb()('customer_accounts').insert({
    customer_id: 'CSG-EVT0001-234567',
    device_id: DEVICE_ID,
    identity_hash: 'evt'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: PPPOE,
    active: true
  });
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await genie.close();
  await stopTestServers();
});

describe('webhook secret', () => {
  it('requires an administrator to rotate', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/events/secret/rotate`, { method: 'POST' });
    assert.equal(status, 401);
  });

  it('returns the new secret once and never again', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/events/secret/rotate`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.ok(body.data.secret.length >= 32);
    webhookSecret = body.data.secret;

    const config = await call(`${panelUrl}/api/sgp/config`, { headers: authHeaders(token) });
    assert.ok(!JSON.stringify(config.body).includes(webhookSecret));
    assert.equal(config.body.data.webhookSecretConfigured, true);
  });

  it('keeps the secret encrypted at rest', async () => {
    const row = { value: await asTenant(() => AppState.get('sgp_integration_config')) };
    assert.ok(!row.value.includes(webhookSecret));
  });
});

describe('webhook delivery', () => {
  it('answers 404 while event delivery is disabled', async () => {
    const body = JSON.stringify({ evento: 'pagamento_confirmado', contrato: '4321' });
    const { status } = await postWebhook(body, { 'X-SGP-Signature': `sha256=${sign(body)}` });
    assert.equal(status, 404);
  });

  it('rejects a delivery that is not signed with the shared secret', async () => {
    await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { webhookEnabled: true }
    });
    const body = JSON.stringify({ evento: 'pagamento_confirmado', contrato: '4321' });
    assert.equal((await postWebhook(body)).status, 401);
    assert.equal(
      (await postWebhook(body, { 'X-SGP-Signature': sign(body, 'segredo-errado') })).status,
      401
    );
  });

  it('verifies the exact bytes that were signed, not a re-serialization', async () => {
    // Unusual whitespace and key order: a handler that parsed and re-encoded
    // before hashing would compute a different digest and reject this.
    const body = '{\n  "contrato" : "4321",\n  "evento":"pagamento_confirmado"\n}';
    const { status } = await postWebhook(body, { 'X-SGP-Signature': `sha256=${sign(body)}` });
    assert.equal(status, 202);
  });

  it('treats a redelivery as success instead of an error', async () => {
    const body = JSON.stringify({ id: 'evt-1', evento: 'liberado', contrato: '4321' });
    const first = await postWebhook(body, { 'X-SGP-Signature': sign(body) });
    assert.equal(first.status, 202);
    const second = await postWebhook(body, { 'X-SGP-Signature': sign(body) });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);

    const rows = await getDb()('sgp_events').where({ contract: '4321', type: 'unblocked' });
    assert.equal(rows.length, 1);
  });

  it('rejects a stale timestamp when one is required', async () => {
    await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { webhookRequireTimestamp: true }
    });
    const stale = String(Math.trunc(Date.now() / 1000) - 4000);
    const body = JSON.stringify({ id: 'evt-stale', evento: 'liberado', contrato: '4321' });
    const { status } = await postWebhook(body, {
      'X-SGP-Signature': sign(`${stale}.${body}`),
      'X-SGP-Timestamp': stale
    });
    assert.equal(status, 401);

    const fresh = String(Math.trunc(Date.now() / 1000));
    const ok = await postWebhook(body, {
      'X-SGP-Signature': sign(`${fresh}.${body}`),
      'X-SGP-Timestamp': fresh
    });
    assert.equal(ok.status, 202);
    await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { webhookRequireTimestamp: false }
    });
  });

  it('stores an event it cannot classify instead of dropping it', async () => {
    const body = JSON.stringify({ id: 'evt-mystery', evento: 'coisa_nova', contrato: '4321' });
    assert.equal((await postWebhook(body, { 'X-SGP-Signature': sign(body) })).status, 202);

    const { body: listed } = await call(`${panelUrl}/api/sgp/events?status=ignored`, {
      headers: authHeaders(token)
    });
    const stored = listed.data.events.find((event) => event.rawType === 'coisa_nova');
    assert.ok(stored, 'an unmapped event is kept so the map can be extended');
    assert.equal(stored.type, 'unknown');
    assert.ok(stored.payload.includes('coisa_nova'));
  });

  it('redacts anything secret-looking from the stored payload', async () => {
    const body = JSON.stringify({
      id: 'evt-secret', evento: 'liberado', contrato: '4321', token: 'nao-guarde-isto'
    });
    await postWebhook(body, { 'X-SGP-Signature': sign(body) });
    const row = await getDb()('sgp_events').where({ dedupe_key: 'like' }).first();
    const rows = await getDb()('sgp_events').select('payload');
    assert.ok(!JSON.stringify(rows).includes('nao-guarde-isto'));
    assert.equal(row, undefined);
  });
});

describe('event dispatch', () => {
  before(async () => {
    await resolveDeviceContract(DEVICE_ID, { refresh: true });
  });

  it('refreshes the cached link on a payment', async () => {
    await getDb()('sgp_links').where({ device_id: DEVICE_ID }).update({
      status_label: 'Desatualizado',
      // Not `new Date(0)`: MySQL's TIMESTAMP range begins a second after the
      // epoch, so that value is unstorable rather than merely stale.
      last_synced_at: new Date('2000-01-01T00:00:00Z')
    });
    const body = JSON.stringify({ id: 'evt-pay', evento: 'pagamento_confirmado', contrato: '4321' });
    const { body: accepted } = await postWebhook(body, { 'X-SGP-Signature': sign(body) });
    const event = await settled(accepted.id);
    assert.equal(event.status, 'processed', event.error);

    const link = await getDb()('sgp_links').where({ device_id: DEVICE_ID }).first();
    assert.equal(link.status_label, 'Ativo');
  });

  it('unlinks the CPE when the contract is cancelled', async () => {
    const body = JSON.stringify({ id: 'evt-cancel', evento: 'cancelado', contrato: '4321' });
    const { body: accepted } = await postWebhook(body, { 'X-SGP-Signature': sign(body) });
    const event = await settled(accepted.id);
    assert.equal(event.status, 'processed', event.error);

    const link = await getDb()('sgp_links').where({ device_id: DEVICE_ID }).first();
    assert.equal(link, undefined);
  });
});

describe('reconciliation', () => {
  before(async () => {
    contractState.blocked = false;
    contractState.statusDisplay = 'Ativo';
    await resolveDeviceContract(DEVICE_ID, { refresh: true });
  });

  it('turns a status change in SGP into an event and updates the link', async () => {
    contractState.blocked = true;
    contractState.statusDisplay = 'Bloqueado';

    const { status, body } = await call(`${panelUrl}/api/sgp/reconcile`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.changed, 1);

    const link = await getDb()('sgp_links').where({ device_id: DEVICE_ID }).first();
    assert.equal(link.state, 'blocked');

    const events = await getDb()('sgp_events').where({ source: 'reconcile', type: 'blocked' });
    assert.equal(events.length, 1);
  });

  it('does not raise the same transition twice', async () => {
    await call(`${panelUrl}/api/sgp/reconcile`, { method: 'POST', headers: authHeaders(token) });
    const events = await getDb()('sgp_events').where({ source: 'reconcile', type: 'blocked' });
    assert.equal(events.length, 1);
  });

  it('requires an administrator', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/reconcile`, { method: 'POST' });
    assert.equal(status, 401);
  });
});
