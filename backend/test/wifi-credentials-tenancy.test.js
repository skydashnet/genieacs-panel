import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  call,
  getDb,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: CustomerWifiCredential } = await import(
  '../src/models/CustomerWifiCredential.js'
);
const { default: CustomerWifiCredentialService, encryptPassword } = await import(
  '../src/services/customerWifiCredentialService.js'
);
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: Setting } = await import('../src/models/Setting.js');
const { tinsertReturningId } = await import('../src/config/database.js');

/**
 * The subscriber's SSID and their stored WiFi password, once the row belongs to
 * one provider at a time.
 *
 * Worth being exact about what this proves, because it is not a hole being
 * closed. Every reader here filters on `account_id`, and `customer_accounts`
 * has been scoped since 0010, so the parent already refused to hand one
 * provider another's account: there was no live path from Alfa's portal to
 * Beta's password. What 0027 changes is where the filter comes from. It is now
 * the credential row's own `tenant_id` rather than one inherited through a
 * join, which is what the tests below exercise directly — Alfa is handed Beta's
 * account id, a surrogate key it could never obtain in production, and still
 * reads nothing.
 *
 * Both accounts carry the same Customer ID on purpose. Since 0010 that value is
 * unique per provider rather than globally, so this is the shape a second
 * provider actually arrives in, and it keeps the portal login below honest: the
 * session it issues has to be Alfa's account, not whichever row sorted first.
 */
let alfa;
let beta;
let portalUrl;
let genie;

const CUSTOMER_ID = 'CSG-WIFITEN-234567';
const ALFA_DEVICE = 'ont-wifi-alfa';
const BETA_DEVICE = 'ont-wifi-beta';
const ALFA_PASSWORD = 'alfa-senha-wifi-1';
const BETA_PASSWORD = 'beta-senha-wifi-2';

const account = {
  alfa: { id: null, portalPassword: null },
  beta: { id: null, portalPassword: null }
};

async function createAccount(tenantId, deviceId, suffix) {
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  const id = await runInTenant(tenantId, () => tinsertReturningId('customer_accounts', {
    customer_id: CUSTOMER_ID,
    device_id: deviceId,
    identity_hash: `wifi-${suffix}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: `cliente-${suffix}@provedor`,
    active: true,
    ...record
  }));
  return { id, portalPassword: password };
}

function sessionCookie(response) {
  const cookie = response.headers.getSetCookie()
    .find((entry) => entry.startsWith('skygp_portal_session='));
  return cookie ? cookie.split(';')[0] : null;
}

/** The rows as the database holds them, provider column and all. */
const raw = (where) => getDb()('customer_wifi_credentials').where(where);

before(async () => {
  ({ portalUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [
      buildDevice({ id: ALFA_DEVICE, ssid: 'Rede-Alfa', pppoeUsername: 'cliente-alfa@provedor' }),
      buildDevice({ id: BETA_DEVICE, ssid: 'Rede-Beta', pppoeUsername: 'cliente-beta@provedor' })
    ]
  });

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // A portal request resolves to the installation's own provider, so the ACS
  // the portal reads has to be configured under Alfa.
  await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', genie.url));

  account.alfa = await createAccount(alfa, ALFA_DEVICE, 'alfa');
  account.beta = await createAccount(beta, BETA_DEVICE, 'beta');

  // Written through the service, so the encryption and the upsert inside a
  // provider's scope are themselves part of what these tests cover.
  await runInTenant(alfa, () => CustomerWifiCredentialService.save(
    account.alfa.id, 1, 'Rede-Alfa', ALFA_PASSWORD
  ));
  await runInTenant(beta, () => CustomerWifiCredentialService.save(
    account.beta.id, 1, 'Rede-Beta', BETA_PASSWORD
  ));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

describe('two providers holding WiFi credentials', () => {
  it('files each row under the provider that wrote it', async () => {
    const rows = await getDb()('customer_wifi_credentials').orderBy('id', 'asc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => Number(row.tenant_id)).sort(),
      [Number(alfa), Number(beta)].sort()
    );
  });

  it('shows each provider only its own', async () => {
    const mine = await runInTenant(alfa, () => CustomerWifiCredential.getByAccountId(account.alfa.id));
    const theirs = await runInTenant(beta, () => CustomerWifiCredential.getByAccountId(account.beta.id));

    assert.deepEqual(mine.map((row) => row.ssid), ['Rede-Alfa']);
    assert.deepEqual(theirs.map((row) => row.ssid), ['Rede-Beta']);
  });

  // The filter is direct now rather than inherited. Alfa is handed Beta's
  // account id — a surrogate key no request could ever put in its hands, since
  // `customer_accounts` has been scoped since 0010 — and the read still comes
  // back empty, because the credential row carries its own provider.
  it('returns nothing when one provider names the other provider\'s account', async () => {
    const seen = await runInTenant(alfa, async () => ({
      list: await CustomerWifiCredential.getByAccountId(account.beta.id),
      one: await CustomerWifiCredential.getByAccountAndIndex(account.beta.id, 1),
      status: await CustomerWifiCredentialService.getSavedPasswordStatus(account.beta.id)
    }));

    assert.deepEqual(seen.list, []);
    assert.equal(seen.one, null);
    assert.equal(seen.status.size, 0);
  });

  it('never hands one provider the other\'s stored password', async () => {
    const revealed = await runInTenant(
      alfa,
      () => CustomerWifiCredentialService.reveal(account.beta.id, 1)
    );
    assert.equal(revealed, null);

    // Not just the plaintext: the ciphertext, IV and tag are the material an
    // offline attempt would need, so none of them may cross either.
    const theirs = await raw({ tenant_id: beta }).first();
    const visible = await runInTenant(alfa, () => CustomerWifiCredential.getByAccountId(account.alfa.id));
    assert.ok(theirs.password_ciphertext);
    assert.ok(!JSON.stringify(visible).includes(theirs.password_ciphertext));
    assert.ok(!JSON.stringify(visible).includes(theirs.password_iv));
    assert.ok(!JSON.stringify(visible).includes(theirs.password_tag));
  });

  it('renames only its own provider\'s SSID', async () => {
    const affected = await runInTenant(
      alfa,
      () => CustomerWifiCredential.updateSsid(account.beta.id, 1, 'Sequestrada')
    );
    assert.equal(affected, 0);
    assert.equal((await raw({ tenant_id: beta }).first()).ssid, 'Rede-Beta');
  });

  it('refuses to write outside a provider', async () => {
    await assert.rejects(
      () => CustomerWifiCredential.upsert({
        account_id: account.alfa.id, wifi_index: 2, ssid: 'Sem Provedor'
      }),
      { name: 'TenantScopeError' }
    );
  });
});

/**
 * The conflict target and the unique have to name the same tuple. This is the
 * pair 0027 breaks if the model is left naming `['account_id', 'wifi_index']`:
 * SQLite and Postgres refuse the statement outright, MySQL ignores the target
 * and merges anyway, so only the first case fails everywhere.
 */
describe('the upsert, now that the unique is per provider', () => {
  it('inserts a row for an index that has none yet', async () => {
    const created = await runInTenant(alfa, () => CustomerWifiCredential.upsert({
      account_id: account.alfa.id,
      wifi_index: 5,
      ssid: 'Rede-Alfa-5G',
      ...encryptPassword('senha-do-5g-0')
    }));

    assert.equal(created.ssid, 'Rede-Alfa-5G');
    assert.equal(Number(created.tenant_id), Number(alfa));
    assert.equal((await raw({ account_id: account.alfa.id, wifi_index: 5 })).length, 1);
  });

  it('updates that row in place instead of inserting a second one', async () => {
    await runInTenant(alfa, () => CustomerWifiCredentialService.save(
      account.alfa.id, 5, 'Rede-Alfa-5G-Nova', 'senha-do-5g-1'
    ));

    const rows = await raw({ tenant_id: alfa, account_id: account.alfa.id, wifi_index: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ssid, 'Rede-Alfa-5G-Nova');
    assert.equal(
      await runInTenant(alfa, () => CustomerWifiCredentialService.reveal(account.alfa.id, 5)),
      'senha-do-5g-1'
    );
  });

  it('leaves the other provider\'s row untouched while doing it', async () => {
    await runInTenant(alfa, () => CustomerWifiCredentialService.save(
      account.alfa.id, 1, 'Rede-Alfa', 'senha-alfa-rodada'
    ));

    const theirs = await raw({ tenant_id: beta, wifi_index: 1 }).first();
    assert.equal(theirs.ssid, 'Rede-Beta');
    assert.equal(
      await runInTenant(beta, () => CustomerWifiCredentialService.reveal(account.beta.id, 1)),
      BETA_PASSWORD
    );
  });
});

/**
 * The portal is the path that matters: it is the only one a subscriber drives,
 * and it reaches the credential through a session rather than through an
 * operator's token. `resolveTenant` puts the installation's provider in scope
 * and `authenticatePortalCustomer` resolves the session with
 * `CustomerAccount.getById`, which is scoped — so the route has to keep working
 * end to end now that the credential is scoped underneath it.
 */
describe('a portal session, end to end', () => {
  let cookie;

  before(async () => {
    const { response, status } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: account.alfa.portalPassword }
    });
    assert.equal(status, 200);
    cookie = sessionCookie(response);
    assert.ok(cookie, 'expected a portal session cookie');
  });

  // The two providers share a Customer ID, so this is also what proves the
  // session resolved Alfa's account: the SSIDs come from the ONT that account
  // names, and Beta's ONT reports different ones.
  it('reads its own provider\'s ONT and its own saved-password flags', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/overview`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.customerId, CUSTOMER_ID);
    for (const network of body.data.wifi) {
      assert.match(network.ssid, /^Rede-Alfa/);
    }
    const first = body.data.wifi.find((network) => Number(network.index) === 1);
    assert.equal(first.hasSavedPassword, true);
  });

  it('reveals the password it stored for itself', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/wifi/1/password`, {
      headers: { Cookie: cookie }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.password, 'senha-alfa-rodada');
    assert.notEqual(body.data.password, BETA_PASSWORD);
  });

  it('rotates it through the route and reads the new one back', async () => {
    const rotated = await call(`${portalUrl}/api/customer/wifi`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: { index: 1, ssid: 'Rede-Alfa-Trocada', password: 'senha-alfa-nova-9' }
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));

    const { body } = await call(`${portalUrl}/api/customer/wifi/1/password`, {
      headers: { Cookie: cookie }
    });
    assert.equal(body.data.password, 'senha-alfa-nova-9');

    // One row still, under Alfa, and the write went to the ONT the session's
    // account names rather than to whichever device the browser might have sent.
    const rows = await raw({ account_id: account.alfa.id, wifi_index: 1 });
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].tenant_id), Number(alfa));
    assert.equal(rows[0].ssid, 'Rede-Alfa-Trocada');
  });

  it('leaves the other provider\'s subscriber exactly as it was', async () => {
    const theirs = await raw({ tenant_id: beta }).first();
    assert.equal(theirs.ssid, 'Rede-Beta');
    assert.equal(
      await runInTenant(beta, () => CustomerWifiCredentialService.reveal(account.beta.id, 1)),
      BETA_PASSWORD
    );
  });
});
