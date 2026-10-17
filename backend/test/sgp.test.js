import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: AppState } = await import('../src/models/AppState.js');

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: SgpService } = await import('../src/services/sgpService.js');

const DEVICE_ID = 'sgp-device-1';
const CUSTOMER_ID = 'CSG-SGPTST1-234567';
const PPPOE = 'joao@provedor';
const APP = 'painel';
const TOKEN = 'token-secreto-123';

let panelUrl;
let portalUrl;
let token;
let portalPassword;
let sgpUrl;
let sgpServer;
const requests = [];
/** What the stub's trust unlock answers with, so one test can make SGP refuse. */
let unlockRefused = false;

/** Minimal stand-in for a provider's SGP instance. */
function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      requests.push({ url: req.url, payload });
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (payload.app !== APP || payload.token !== TOKEN) {
        return send({ status: 0, msg: 'Token inválido' });
      }
      if (req.url.startsWith('/api/ura/consultacliente')) {
        const known = payload.login === PPPOE
          || String(payload.contrato) === '4321'
          || payload.cpfcnpj === '12345678909';
        if (!known) return send({ status: 0, msg: 'Cliente não encontrado' });
        return send({
          status: 1,
          contratos: [{
            contrato: 4321,
            clienteId: 57,
            contratoStatus: 1,
            contratoStatusDisplay: 'Ativo',
            planoInternet: 'Fibra 500MB',
            razaoSocial: 'João da Silva',
            cpfcnpj: '12345678909',
            login: PPPOE,
            bloqueado: false
          }]
        });
      }
      if (req.url.startsWith('/api/ura/titulos')) {
        return send({
          status: 1,
          titulos: [
            {
              numerodocumento: '900123',
              valor: '129,90',
              vencimento: '10/10/2026',
              status: 'Em aberto',
              linha_digitavel: '34191790010104351004791020150008699999999999',
              link: 'https://provedor.example/boleto/900123/'
            },
            {
              // Cancelled, unpaid, and sent anyway: SGP does not always honour
              // the "open only" flag. Never open — the device page still sees it.
              numerodocumento: '800001',
              valor: '99,90',
              vencimento: '2024-06-01',
              status: 'Cancelado'
            },
            {
              numerodocumento: '900122',
              valor: 129.9,
              vencimento: '2026-09-10',
              status: 'Pago',
              dataPagamento: '2026-09-08'
            }
          ]
        });
      }
      if (req.url.startsWith('/api/ura/liberacao')) {
        if (String(payload.contrato) !== '4321') return send({ status: 0, msg: 'Contrato inválido' });
        // SGP's own refusal: a status that is not one of the failure flags,
        // and `liberado: false` saying what actually happened.
        if (unlockRefused) return send({ status: 2, liberado: false, msg: 'Contrato não está suspenso' });
        return send({ status: 1, liberado: true, liberado_dias: 3, protocolo: '20260923001', msg: 'Liberação efetuada' });
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

async function portalSession() {
  const { response } = await call(`${portalUrl}/api/customer/login`, {
    method: 'POST',
    body: { customerId: CUSTOMER_ID, password: portalPassword }
  });
  const cookie = response.headers.getSetCookie()
    .find((entry) => entry.startsWith('skygp_portal_session='));
  return cookie.split(';')[0];
}

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  sgpUrl = await startSgpStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const { password, record } = await CustomerPortalPasswordService.createRecord();
  portalPassword = password;
  await getDb()('customer_accounts').insert({
    customer_id: CUSTOMER_ID,
    device_id: DEVICE_ID,
    identity_hash: 'sgp'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: PPPOE,
    active: true,
    ...record
  });
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('SGP configuration', () => {
  it('starts disabled', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/config`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.enabled, false);
    assert.equal(body.data.tokenConfigured, false);
    assert.equal(body.data.ready, false);
  });

  it('refuses to enable without a complete configuration', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true, baseUrl: sgpUrl, app: APP }
    });
    assert.equal(status, 400);
  });

  it('rejects a base URL that carries credentials', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { baseUrl: 'https://user:pass@provedor.example' }
    });
    assert.equal(status, 400);
  });

  it('stores the configuration without ever returning the token', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: {
        enabled: true,
        baseUrl: sgpUrl,
        app: APP,
        token: TOKEN,
        linkMode: 'pppoe',
        portalBilling: true,
        portalUnlock: true
      }
    });
    assert.equal(status, 200);
    assert.equal(body.data.ready, true);
    assert.equal(body.data.tokenConfigured, true);
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  });

  it('keeps the stored token in database at rest', async () => {
    const row = { value: await asTenant(() => AppState.get('sgp_integration_config')) };
    assert.ok(!row.value.includes(TOKEN));
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.token, TOKEN);
  });

  it('keeps the stored token when saved without one', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { invoiceLimit: 8 }
    });
    assert.equal(body.data.tokenConfigured, true);
    assert.equal(body.data.invoiceLimit, 8);
  });

  /**
   * This is also where the self-hosted half of the egress guard is pinned. The
   * stub above listens on 127.0.0.1, and `SgpService.request` now goes through
   * the same resolve-pin-and-cap transport the ACS path uses — which refuses
   * loopback on the SaaS edition and does not on this one, because there the
   * SGP really is on the operator's own LAN and the person who typed the URL
   * owns the install. `egress-guard.test.js` holds the other half: the same
   * probe, on the SaaS edition, refused with nothing reflected back.
   */
  it('confirms credentials even when no sample customer is given', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {}
    });
    assert.equal(status, 200);
    assert.equal(body.data.probe, 'anonymous');
  });

  it('reports a rejected token as an authentication failure', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { token: 'wrong-token' }
    });
    assert.equal(status, 502);
    assert.match(body.message, /credenciais/i);
  });

  it('requires an administrator session', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/config`);
    assert.equal(status, 401);
  });
});

/**
 * O token salvo nunca é exibido — e não pode sair por outra porta. Testar ou
 * salvar um endereço NOVO sem digitar o token mandaria o segredo guardado, no
 * corpo da requisição, para quem o endereço apontar.
 */
describe('the stored SGP token stays with the stored address', () => {
  let atacante;
  let atacanteUrl;
  const recebido = [];

  before(async () => {
    atacante = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        recebido.push(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 1, contratos: [] }));
      });
    });
    await new Promise((resolve) => atacante.listen(0, '127.0.0.1', resolve));
    atacanteUrl = `http://127.0.0.1:${atacante.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => atacante.close(resolve));
  });

  it('a connection test to another address does not carry it', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { baseUrl: atacanteUrl, app: APP }
    });
    assert.equal(status, 400);
    assert.equal(recebido.some((corpo) => corpo.includes(TOKEN)), false, 'o token salvo saiu para outro endereço');
  });

  it('saving another address without the token is refused, and nothing changes', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { baseUrl: atacanteUrl }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'token_required');
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.baseUrl, sgpUrl);
    assert.equal(config.token, TOKEN);
  });

  it('the same address keeps working with the stored token', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { baseUrl: sgpUrl }
    });
    assert.equal(status, 200);
  });

  it('a new address with a token typed along is accepted', async () => {
    const { status } = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { baseUrl: atacanteUrl, token: 'outro-token' }
    });
    assert.equal(status, 200);
    const volta = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { baseUrl: sgpUrl, token: TOKEN }
    });
    assert.equal(volta.status, 200);
  });
});

describe('device to contract resolution', () => {
  it('resolves an ONT through its PPPoE login and caches the link', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.link.contract, '4321');
    assert.equal(body.data.link.plan, 'Fibra 500MB');
    assert.equal(body.data.link.linkMode, 'auto');

    const row = await getDb()('sgp_links').where({ device_id: DEVICE_ID }).first();
    assert.equal(row.contract, '4321');
  });

  /**
   * A tela do aparelho DEPENDE deste campo desde que passou a pintar o selo de
   * situação por ele. Antes, ela re-derivava o estado com `/ativo/i` sobre o
   * rótulo — e "Inativo" contém "ativo", então contrato inativo saía verde.
   *
   * O campo já existia em `publicLink`; o que não existia era um teste que o
   * prendesse. Dependência sem teste é a que se perde no próximo refactor, e
   * esta se perderia em silêncio: a tela voltaria a pintar tudo de neutro, que
   * é para onde `sgpBadge` erra quando o estado não vem.
   */
  it('carries the derived contract state the device screen colours by', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}`, {
      headers: authHeaders(token)
    });
    assert.ok(
      ['active', 'blocked', 'cancelled', 'unknown'].includes(body.data.link.state),
      `state inesperado: ${body.data.link.state}`
    );
  });

  it('normalizes invoice amounts, dates and field spellings', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}`, {
      headers: authHeaders(token)
    });
    const invoice = body.data.invoices.find((entry) => entry.id === '900123');
    assert.equal(invoice.amount, 129.9);
    assert.equal(invoice.dueDate, '2026-10-10');
    assert.equal(invoice.digitableLine, '34191790010104351004791020150008699999999999');
  });

  it('links to the client page in the SGP web app from the client id SGP sent', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}`, {
      headers: authHeaders(token)
    });
    assert.equal(body.data.sgpUrl, `${sgpUrl}/admin/cliente/57/contratos/`);
  });

  it('drops invoices that are already settled', async () => {
    const { body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}`, {
      headers: authHeaders(token)
    });
    assert.ok(body.data.invoices.every((invoice) => !invoice.paid));
    // The cancelled one stays: the device page sorts titles into status tabs.
    assert.deepEqual(body.data.invoices.map((invoice) => invoice.id).sort(), ['800001', '900123']);
  });

  it('reports an unlinked device instead of guessing a contract', async () => {
    const { status, body } = await call(`${panelUrl}/api/sgp/devices/unknown-device`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
    assert.equal(body.code, 'unlinked');
  });

  it('links and unlinks a contract manually', async () => {
    const linked = await call(`${panelUrl}/api/sgp/devices/manual-device/link`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { contract: '4321' }
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.data.link.linkMode, 'manual');

    const removed = await call(`${panelUrl}/api/sgp/devices/manual-device/link`, {
      method: 'DELETE',
      headers: authHeaders(token)
    });
    assert.equal(removed.status, 200);
    const row = await getDb()('sgp_links').where({ device_id: 'manual-device' }).first();
    assert.equal(row, undefined);
  });

  it('requests a trust unlock for the linked contract', async () => {
    const before = requests.length;
    const { status, body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}/unlock`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.equal(body.data.contract, '4321');
    assert.match(body.message, /Liberação/);
    // The route SGP documents for the promise of payment, not `/liberacao/`.
    const sent = requests.slice(before).find((entry) => entry.url.includes('liberacao'));
    assert.equal(sent.url, '/api/ura/liberacaopromessa/');
  });

  it('reports a refused promise as a refusal, not as done', async () => {
    unlockRefused = true;
    try {
      const { status, body } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}/unlock`, {
        method: 'POST',
        headers: authHeaders(token)
      });
      assert.equal(status, 409);
      assert.equal(body.code, 'unlock_refused');
      assert.match(body.message, /não está suspenso/);
    } finally {
      unlockRefused = false;
    }
  });

  it('moves a provider off the old default path it saved without choosing', async () => {
    // Every Save wrote the defaults back, so the wrong one is stored verbatim.
    await asTenant(async () => {
      const stored = JSON.parse(await AppState.get('sgp_integration_config'));
      stored.endpoints = { ...stored.endpoints, unlock: '/api/ura/liberacao/' };
      await AppState.upsert('sgp_integration_config', JSON.stringify(stored));
      SgpService.invalidateConfigCache();
    });
    const before = requests.length;
    const { status } = await call(`${panelUrl}/api/sgp/devices/${DEVICE_ID}/unlock`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    const sent = requests.slice(before).find((entry) => entry.url.includes('liberacao'));
    assert.equal(sent.url, '/api/ura/liberacaopromessa/');
  });
});

describe('customer portal billing', () => {
  it('refuses without a portal session', async () => {
    const { status } = await call(`${portalUrl}/api/customer/billing`);
    assert.equal(status, 401);
  });

  it('returns the open invoices of the authenticated account only', async () => {
    const cookie = await portalSession();
    const { status, body } = await call(`${portalUrl}/api/customer/billing`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200);
    assert.equal(body.data.contract.contract, '4321');
    assert.equal(body.data.invoices.length, 1);
    assert.equal(body.data.trustUnlockAvailable, true);
  });

  it('masks the document it shows to the subscriber', async () => {
    const cookie = await portalSession();
    const { body } = await call(`${portalUrl}/api/customer/billing`, {
      headers: { Cookie: cookie }
    });
    assert.equal(body.data.contract.document, '*******8909');
    assert.ok(!JSON.stringify(body).includes('12345678909'));
  });

  it('sends the trust unlock for the session contract', async () => {
    const cookie = await portalSession();
    const before = requests.length;
    const { status } = await call(`${portalUrl}/api/customer/billing/trust-unlock`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200);
    const unlock = requests.slice(before).find((entry) => entry.url.includes('liberacao'));
    assert.equal(String(unlock.payload.contrato), '4321');
  });

  it('hides billing behind a machine-readable code when the option is off', async () => {
    await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { portalBilling: false, portalUnlock: false }
    });
    const cookie = await portalSession();
    const billing = await call(`${portalUrl}/api/customer/billing`, {
      headers: { Cookie: cookie }
    });
    assert.equal(billing.status, 404);
    assert.equal(billing.body.code, 'billing_disabled');

    const unlock = await call(`${portalUrl}/api/customer/billing/trust-unlock`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(unlock.status, 404);
    assert.equal(unlock.body.code, 'unlock_disabled');

    await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { portalBilling: true, portalUnlock: true }
    });
  });
});
