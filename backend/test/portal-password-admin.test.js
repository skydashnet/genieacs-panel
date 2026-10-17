import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

const DEVICE_ID = 'admin-device-1';
const CUSTOMER_ID = 'CSG-ADMIN01-234567';

let panelUrl;
let portalUrl;
let token;
let issuedPassword;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const { password, record } = await CustomerPortalPasswordService.createRecord();
  issuedPassword = password;
  await getDb()('customer_accounts').insert({
    customer_id: CUSTOMER_ID,
    device_id: DEVICE_ID,
    identity_hash: 'admin'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'admin-customer',
    active: true,
    ...record
  });
});

after(async () => {
  await stopTestServers();
});

describe('operator portal password endpoints', () => {
  const path = `/api/devices/${DEVICE_ID}/portal-password`;

  it('requires authentication to reveal a password', async () => {
    const { status } = await call(`${panelUrl}${path}`);
    assert.equal(status, 401);
  });

  it('requires authentication to regenerate a password', async () => {
    const { status } = await call(`${panelUrl}${path}/reset`, { method: 'POST' });
    assert.equal(status, 401);
  });

  it('reveals the password an account was created with', async () => {
    const { status, body } = await call(`${panelUrl}${path}`, { headers: authHeaders(token) });
    assert.equal(status, 200);
    assert.equal(body.data.customerId, CUSTOMER_ID);
    assert.equal(body.data.password, issuedPassword);
  });

  it('reports a device that has no customer account', async () => {
    const { status } = await call(`${panelUrl}/api/devices/unknown-device/portal-password`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
  });

  it('regenerates a password the customer can immediately use', async () => {
    const reset = await call(`${panelUrl}${path}/reset`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(reset.status, 200);
    assert.notEqual(reset.body.data.password, issuedPassword);

    const stale = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: issuedPassword }
    });
    assert.equal(stale.status, 401);

    const fresh = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: reset.body.data.password }
    });
    assert.equal(fresh.status, 200);
  });
});
