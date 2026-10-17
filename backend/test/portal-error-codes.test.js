import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

const CUSTOMER_ID = 'CSG-CODES01-234567';
let portalUrl;
let password;
let cookie;

before(async () => {
  ({ portalUrl } = await startTestServers());
  const created = await CustomerPortalPasswordService.createRecord();
  password = created.password;
  await getDb()('customer_accounts').insert({
    customer_id: CUSTOMER_ID,
    device_id: 'codes-device-1',
    identity_hash: 'codes'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'codes@isp',
    active: true,
    ...created.record
  });
});

after(async () => {
  await stopTestServers();
});

// The portal UI translates by code; a message alone cannot be localized because
// the backend emits it in a single fixed language.
describe('every portal answer carries a machine-readable code', () => {
  it('labels a rejected login', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: 'WRONGPASS1' }
    });
    assert.equal(status, 401);
    assert.equal(body.code, 'invalid_credentials');
  });

  it('labels a successful login', async () => {
    const { response, body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password }
    });
    assert.equal(body.code, 'login_ok');
    cookie = response.headers.getSetCookie()
      .find((entry) => entry.startsWith('skygp_portal_session='))
      .split(';')[0];
  });

  it('labels a missing session', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/session`);
    assert.equal(status, 401);
    assert.equal(body.code, 'customer_session_required');
  });

  it('labels an invalid session cookie', async () => {
    const { body } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: 'skygp_portal_session=not.a.jwt' }
    });
    assert.equal(body.code, 'customer_session_expired');
  });

  it('labels an active session', async () => {
    const { body } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookie }
    });
    assert.equal(body.code, 'session_active');
  });

  it('labels a rejected WiFi index', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/wifi`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: { index: 99, ssid: 'rede' }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'invalid_wifi_index');
  });

  it('labels a rejected SSID', async () => {
    const { body } = await call(`${portalUrl}/api/customer/wifi`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: { index: 1, ssid: '' }
    });
    assert.equal(body.code, 'invalid_ssid');
  });

  it('labels a rejected WiFi password', async () => {
    const { body } = await call(`${portalUrl}/api/customer/wifi`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: { index: 1, ssid: 'rede', password: 'curta' }
    });
    assert.equal(body.code, 'invalid_wifi_password');
  });

  it('labels a password that was never saved', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/wifi/1/password`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 404);
    assert.equal(body.code, 'wifi_password_not_saved');
  });

  it('labels a disabled billing section', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/billing`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 404);
    assert.equal(body.code, 'billing_disabled');
  });

  it('labels a logout', async () => {
    const { body } = await call(`${portalUrl}/api/customer/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(body.code, 'logout_ok');
  });
});

describe('internal error text', () => {
  it('is withheld unless the deployment asks for it', async () => {
    // APP_ENV is 'test' here, which is neither production nor development.
    const { body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'not-an-id', password: 'x' }
    });
    assert.equal(body.error, undefined);
  });
});
