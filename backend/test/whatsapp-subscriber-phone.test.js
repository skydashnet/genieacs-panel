import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');

const APP = 'painel';
const TOKEN = 'token-secreto-cadastro';

/**
 * Correcting a subscriber's number.
 *
 * `phone_manual` has existed since wave 2 and until this route nothing could
 * write it: the only way to fix a number the ERP has wrong was an UPDATE typed
 * against the database. A wrong number is silent — the subscriber lands in the
 * campaign's `noPhone` count, run after run — so the write and the guarantee
 * around it are what this file covers, and the guarantee is the last test:
 * a sync must never take the correction away again.
 */

const CONTRACT = 'C-FONE-1';
/** Two ONTs on one contract, because the write has to reach both. */
const DEVICES = ['ont-fone-a', 'ont-fone-b'];
/** What the ERP has on file, and what the operator knows is out of date. */
const SGP_PHONE = '5593981110001';

let panelUrl;
let token;
let sgpServer;
let sgpUrl;

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
      if (req.url.startsWith('/api/ura/consultacliente')) {
        return send({
          status: 1,
          contratos: [{
            contrato: CONTRACT,
            razaoSocial: 'João da Silva',
            cpfcnpj: '12345678909',
            contratoStatus: 'Ativo',
            planoInternet: '300 MEGA',
            login: 'joao@provedor',
            // The stale value the operator is correcting. A sync refreshes this
            // column and only this one.
            celular: SGP_PHONE
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

function setPhone(contract, phone) {
  return call(`${panelUrl}/api/whatsapp/subscribers/${encodeURIComponent(contract)}/phone`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { phone }
  });
}

const linkRows = (contract) => getDb()('sgp_links')
  .where({ contract })
  .orderBy('device_id', 'asc');

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgpUrl = await startSgpStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual'
  }));

  const now = new Date();
  await getDb()('sgp_links').insert(DEVICES.map((deviceId) => ({
    device_id: deviceId,
    contract: CONTRACT,
    client_name: 'João da Silva',
    document: '12345678909',
    state: 'active',
    link_mode: 'manual',
    phone_e164: SGP_PHONE,
    created_at: now,
    updated_at: now
  })));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe("correcting a subscriber's number", () => {
  it('stores what the operator typed, normalised, and prefers it over the ERP', async () => {
    // Typed the way a human writes it down, which is not the way a message is
    // addressed. Storing it verbatim would look right on screen and match
    // nothing at dispatch.
    const { status, body } = await setPhone(CONTRACT, '(93) 98222-0002');

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.contract, CONTRACT);
    assert.equal(body.data.phone, '5593982220002');
    // The provenance flips with the value: this is what the panel shows the
    // operator to say which of the two records answered.
    assert.equal(body.data.phoneSource, 'manual');

    const rows = await linkRows(CONTRACT);
    assert.equal(rows.length, 2);
    // Both ONTs, not one: the reader keeps a single row per contract and picks
    // whichever sorts first, so a half-written correction would show the old
    // number back again depending on which device_id won.
    assert.ok(rows.every((row) => row.phone_manual === '5593982220002'));
    // The ERP's own column is untouched. The correction sits beside it rather
    // than on top of it, which is what makes the clear below possible.
    assert.ok(rows.every((row) => row.phone_e164 === SGP_PHONE));
  });

  it('shows the correction on the billing listing, not the ERP number', async () => {
    // Reached through the service rather than the route so the assertion is
    // about the resolution rule, not about which invoices the stub happens to
    // owe: `listOverdue` needs a round trip per subscriber to say anything.
    const { default: WaBillingService } = await import('../src/services/waBillingService.js');
    const [subscriber] = WaBillingService.subscribersFrom(await linkRows(CONTRACT));
    assert.equal(subscriber.phone, '5593982220002');
    assert.equal(subscriber.phoneSource, 'manual');
  });

  it('takes an empty string as a clear, handing the contract back to the ERP', async () => {
    // Not a malformed request. An operator who mistyped a correction has to be
    // able to withdraw it without inventing a number to overwrite it with.
    const { status, body } = await setPhone(CONTRACT, '');

    assert.equal(status, 200);
    assert.equal(body.data.phone, SGP_PHONE);
    assert.equal(body.data.phoneSource, 'sgp');

    const rows = await linkRows(CONTRACT);
    assert.ok(rows.every((row) => row.phone_manual === null));
  });

  it('refuses a number that could not be dialled, and changes nothing', async () => {
    const before2 = await linkRows(CONTRACT);
    const { status, body } = await setPhone(CONTRACT, '12345');

    assert.equal(status, 400);
    assert.equal(body.success, false);
    // The machine code, which is what the screen translates. The message is the
    // server's language, not the operator's.
    assert.equal(body.code, 'invalid_phone');

    const after2 = await linkRows(CONTRACT);
    assert.deepEqual(
      after2.map((row) => row.phone_manual),
      before2.map((row) => row.phone_manual),
      'a refusal must not be a half-write'
    );
  });

  it('refuses a contract the panel has never seen', async () => {
    const { status, body } = await setPhone('C-INEXISTENTE', '5593982220003');
    assert.equal(status, 404);
    assert.equal(body.code, 'subscriber_not_found');
  });

  it('refuses an operator who is not an admin', async () => {
    // Every WhatsApp route is admin-only: this one decides which number the
    // cadence dials, which is the same power as choosing who gets messaged.
    const { status } = await call(
      `${panelUrl}/api/whatsapp/subscribers/${CONTRACT}/phone`,
      { method: 'PUT', body: { phone: '5593982220004' } }
    );
    assert.equal(status, 401);
  });

  // ── The guarantee ──────────────────────────────────────────────────

  it('keeps the correction when the ERP syncs the contract again', async () => {
    await setPhone(CONTRACT, '5593982220002');

    // A real sync, through the same path a device link takes: the ERP answers
    // with its own (stale) number and the row is rewritten from that answer.
    // `asTenant` because a sync reached outside a request has no provider of
    // its own — the harness's note, not this test's invention.
    const link = await asTenant(() => SgpService.linkDevice(DEVICES[0], { contract: CONTRACT }));
    assert.equal(link.contract, CONTRACT);

    const rows = await linkRows(CONTRACT);
    const synced = rows.find((row) => row.device_id === DEVICES[0]);
    // The sync did land — it refreshed what the ERP believes …
    assert.equal(synced.phone_e164, SGP_PHONE);
    assert.ok(synced.last_synced_at, 'the sync wrote the row it was meant to write');
    // … and did NOT touch the correction beside it. `contractToLinkRow` leaves
    // `phone_manual` out of the row on purpose, so the upsert's merge has
    // nothing to overwrite it with. This is the whole reason the override is a
    // separate column instead of an edit to `phone_e164`.
    assert.equal(synced.phone_manual, '5593982220002');

    const { default: WaBillingService } = await import('../src/services/waBillingService.js');
    const [subscriber] = WaBillingService.subscribersFrom(rows);
    assert.equal(subscriber.phone, '5593982220002', 'the operator still wins after a sync');
    assert.equal(subscriber.phoneSource, 'manual');
  });
});
