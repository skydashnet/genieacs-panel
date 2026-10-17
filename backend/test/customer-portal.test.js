import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

let portalUrl;
const alice = { customerId: 'CSG-ABCDEFG-234567', password: null, id: null };
const bob = { customerId: 'CSG-HJKLMNP-234568', password: null, id: null };

async function createAccount(account, index) {
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  const id = await insertReturningId('customer_accounts', {
    customer_id: account.customerId,
    device_id: `test-device-${index}`,
    identity_hash: `hash-${index}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: `customer-${index}`,
    active: true,
    ...record
  });
  account.id = id;
  account.password = password;
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.startsWith('skygp_portal_session='));
  return session || null;
}

function cookieHeader(setCookie) {
  return setCookie.split(';')[0];
}

before(async () => {
  ({ portalUrl } = await startTestServers());
  await createAccount(alice, 1);
  await createAccount(bob, 2);
});

after(async () => {
  await stopTestServers();
});

describe('portal credentials', () => {
  it('generates a password that is not derived from the Customer ID', () => {
    assert.notEqual(alice.password, alice.customerId.slice(-6));
    assert.equal(alice.password.length, CustomerPortalPasswordService.passwordLength);
    assert.match(alice.password, /^[A-Z0-9]+$/);
    assert.notEqual(alice.password, bob.password);
  });

  it('stores a hash rather than the password itself', async () => {
    const row = await getDb()('customer_accounts').where({ id: alice.id }).first();
    assert.ok(row.password_hash.startsWith('$2'));
    assert.ok(!JSON.stringify(row).includes(alice.password));
  });
});

describe('portal login', () => {
  it('rejects the legacy password derived from the Customer ID', async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.customerId.slice(-6) }
    });
    assert.equal(status, 401);
  });

  it('rejects an unknown Customer ID', async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-ZZZZZZZ-999999', password: alice.password }
    });
    assert.equal(status, 401);
  });

  it("rejects another customer's password", async () => {
    const { status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: bob.password }
    });
    assert.equal(status, 401);
  });

  it('accepts the generated password and sets a hardened session cookie', async () => {
    const { status, response, body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.password }
    });
    assert.equal(status, 200);
    assert.equal(body.data.customerId, alice.customerId);

    const cookie = sessionCookie(response);
    assert.ok(cookie, 'expected a portal session cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });
});

describe('portal session', () => {
  let cookie;

  before(async () => {
    const { response } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: alice.customerId, password: alice.password }
    });
    cookie = cookieHeader(sessionCookie(response));
  });

  it('refuses an unauthenticated request', async () => {
    const { status } = await call(`${portalUrl}/api/customer/session`);
    assert.equal(status, 401);
  });

  it('refuses a forged session cookie', async () => {
    const { status } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: 'skygp_portal_session=not.a.jwt' }
    });
    assert.equal(status, 401);
  });

  it('accepts the issued cookie', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200);
    assert.equal(body.data.customerId, alice.customerId);
  });

  it('blocks a cross-site mutation even with a valid cookie', async () => {
    const { status } = await call(`${portalUrl}/api/customer/wifi`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' },
      body: { index: 1, ssid: 'attacker' }
    });
    assert.equal(status, 403);
  });

  it('ends the session on logout', async () => {
    const loggedOut = await call(`${portalUrl}/api/customer/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(loggedOut.status, 200);
    assert.match(sessionCookie(loggedOut.response) || '', /skygp_portal_session=;/);
  });
});

describe('operator password reset', () => {
  it('replaces the password so the previous one stops working', async () => {
    const previous = bob.password;
    const next = await asTenant(() => CustomerPortalPasswordService.reset(bob.id));
    assert.notEqual(next, previous);

    const stale = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: previous }
    });
    assert.equal(stale.status, 401);

    const fresh = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: next }
    });
    assert.equal(fresh.status, 200);
    bob.password = next;
  });

  // O operador redefine a senha do portal justamente quando alguém que não
  // devia a tem. Sem isto, quem já estava dentro seguia dentro pelos 30 minutos
  // do cookie: a guarda só relia `active` e `customer_id`.
  it('ends a portal session that was opened with the previous password', async () => {
    const login = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: bob.password }
    });
    assert.equal(login.status, 200);
    const stale = cookieHeader(sessionCookie(login.response));
    const before = await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: stale } });
    assert.equal(before.status, 200);

    // No mesmo segundo do login, de propósito: é o caso que uma comparação de
    // relógio com a resolução do `iat` deixaria passar.
    bob.password = await asTenant(() => CustomerPortalPasswordService.reset(bob.id));

    const after = await call(`${portalUrl}/api/customer/session`, { headers: { Cookie: stale } });
    assert.equal(after.status, 401, 'the session survived the password reset');
    assert.equal(after.body.code, 'customer_session_invalid');

    const relogin = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: bob.customerId, password: bob.password }
    });
    assert.equal(relogin.status, 200);
    const fresh = await call(`${portalUrl}/api/customer/session`, {
      headers: { Cookie: cookieHeader(sessionCookie(relogin.response)) }
    });
    assert.equal(fresh.status, 200);
  });

  it('reveals the stored password to an operator', async () => {
    const row = await getDb()('customer_accounts').where({ id: bob.id }).first();
    assert.equal(CustomerPortalPasswordService.reveal(row), bob.password);
  });
});
