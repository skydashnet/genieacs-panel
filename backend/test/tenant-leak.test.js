import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asTenant,
  authHeaders,
  call,
  getDb,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaAlertState } = await import('../src/models/WaAlertState.js');
const { default: WaTemplate } = await import('../src/models/WaTemplate.js');
const { default: WaBroadcast } = await import('../src/models/WaBroadcast.js');
const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: BillingEvent } = await import('../src/models/BillingEvent.js');
const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');

/**
 * The phase's actual proof.
 *
 * Two providers holding the SAME `customer_id`, `device_id` and
 * `identity_hash` — the three values that collide in the real world, because
 * `identity_hash` is sha256(softwareId, pppoe_username) and two ISPs deploying
 * the same ONT firmware to a subscriber of the same name produce the same
 * digest. Nothing may return or alter the other provider's row.
 *
 * Where a route is involved the answer must be 404, never 403: a 403 confirms
 * the record exists, which is itself the leak.
 */
let panelUrl;
let portalUrl;
let token;
let alfa;
let beta;

// The same subscriber identity on both sides. Identical on purpose.
const SOFTWARE_ID = 'V3.2.1-BUILD9';
const PPPOE = 'joao.silva';
const DEVICE_ID = 'ONT-COLLIDE-0001';
const CUSTOMER_ID = 'CSG-2026-000042';

const identityHash = () => CustomerService.identityHash(SOFTWARE_ID, PPPOE);

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

async function reset() {
  await getDb()('customer_accounts').del();
}

/** The row as the database holds it, provider and all — never through a model. */
const raw = (where) => getDb()('customer_accounts').where(where);

describe('two providers holding the same subscriber identity', () => {
  it('lets both keep a row with the same customer, device and identity', async () => {
    await reset();
    const row = {
      customer_id: CUSTOMER_ID,
      device_id: DEVICE_ID,
      identity_hash: identityHash(),
      software_id: SOFTWARE_ID,
      pppoe_username: PPPOE,
      active: true
    };
    await runInTenant(alfa, () => CustomerAccount.create(row));
    await runInTenant(beta, () => CustomerAccount.create(row));

    assert.equal((await raw({ customer_id: CUSTOMER_ID })).length, 2);
  });

  it('shows each provider only its own', async () => {
    const mine = await runInTenant(alfa, () => CustomerAccount.getByDeviceId(DEVICE_ID));
    const theirs = await runInTenant(beta, () => CustomerAccount.getByDeviceId(DEVICE_ID));

    assert.equal(Number(mine.tenant_id), Number(alfa));
    assert.equal(Number(theirs.tenant_id), Number(beta));
    assert.notEqual(mine.id, theirs.id);

    for (const [tenant, expected] of [[alfa, alfa], [beta, beta]]) {
      const byCustomer = await runInTenant(tenant, () => CustomerAccount.getByCustomerId(CUSTOMER_ID));
      const byIdentity = await runInTenant(tenant, () => CustomerAccount.getByIdentityHash(identityHash()));
      const byPppoe = await runInTenant(tenant, () => CustomerAccount.getActiveByPppoe(PPPOE));
      for (const found of [byCustomer, byIdentity, byPppoe]) {
        assert.equal(Number(found.tenant_id), Number(expected));
      }
    }
  });

  it('counts and lists only its own', async () => {
    const mine = await runInTenant(alfa, () => CustomerAccount.getAll());
    assert.equal(mine.length, 1);
    assert.equal(Number(mine[0].tenant_id), Number(alfa));

    const targets = await runInTenant(beta, () => CustomerAccount.getSyncTargets());
    assert.equal(targets.length, 1);

    const found = await runInTenant(beta, () => CustomerAccount.getIdsByDeviceIds([DEVICE_ID]));
    assert.equal(found.length, 1);
  });
});

describe('the account takeover this table exists to prevent', () => {
  // `identity_hash` is how an ONT swap keeps a subscriber's portal login:
  // within one provider, matching on it and re-pointing the account at the new
  // device is exactly right. Across providers it hands the account over —
  // the second provider's sync adopts the first's subscriber, portal password
  // and saved WiFi credentials included.
  it('does not let one provider adopt the other provider\'s account', async () => {
    await reset();

    const theirs = await runInTenant(alfa, () => CustomerService.ensureAccount({
      _id: 'ONT-DO-PRIMEIRO', softwareId: SOFTWARE_ID, pppoe: PPPOE
    }, { enabled: true }));
    assert.ok(theirs, 'the first provider has an account for this subscriber');

    // Same firmware, same subscriber name, different ONT: the exact collision.
    const mine = await runInTenant(beta, () => CustomerService.ensureAccount({
      _id: 'ONT-DO-SEGUNDO', softwareId: SOFTWARE_ID, pppoe: PPPOE
    }, { enabled: true }));

    assert.ok(mine, 'the second provider gets an account of its own');
    assert.notEqual(mine.id, theirs.id, 'it must be a new row, not the other provider\'s');
    assert.equal(Number(mine.tenant_id), Number(beta));

    // The giveaway, had it gone wrong: the first provider's account would now
    // be pointing at the second provider's ONT.
    const after = await raw({ id: theirs.id }).first();
    assert.equal(after.device_id, 'ONT-DO-PRIMEIRO', 'the other provider\'s ONT is untouched');
    assert.equal(Boolean(after.active), true, 'and it was not retired out from under them');
  });

  it('does not retire the other provider\'s account', async () => {
    const theirs = await runInTenant(alfa, () => CustomerAccount.getByDeviceId('ONT-DO-PRIMEIRO'));
    const changed = await runInTenant(beta, () => CustomerAccount.retire(theirs.id));
    assert.equal(changed, null, 'nothing to retire under this provider');

    const after = await raw({ id: theirs.id }).first();
    assert.equal(Boolean(after.active), true);
    assert.equal(after.device_id, 'ONT-DO-PRIMEIRO');
  });

  it('does not reset the other provider\'s portal password', async () => {
    const theirs = await runInTenant(alfa, () => CustomerAccount.getByDeviceId('ONT-DO-PRIMEIRO'));
    const before = (await raw({ id: theirs.id }).first()).password_hash;

    // It does not throw — the update simply matches no row under this
    // provider. Silence is fine here; changing nothing is the guarantee.
    await runInTenant(beta, () => CustomerPortalPasswordService.reset(theirs.id));

    assert.equal((await raw({ id: theirs.id }).first()).password_hash, before,
      'the other provider\'s stored password is untouched');
  });
});

describe('a route asked for another provider\'s record', () => {
  // Every request resolves the installation's provider today; the second
  // provider is reachable only once providers get their own subdomain. What
  // has to hold already is that asking for a record that belongs to somebody
  // else answers as though it does not exist.
  it('answers 404, not 403 — a 403 would confirm the record is there', async () => {
    await reset();
    await runInTenant(beta, () => CustomerAccount.create({
      customer_id: CUSTOMER_ID,
      device_id: DEVICE_ID,
      identity_hash: identityHash(),
      software_id: SOFTWARE_ID,
      pppoe_username: PPPOE,
      active: true
    }));

    const { status } = await call(`${panelUrl}/api/devices/${DEVICE_ID}/portal-password`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
    assert.notEqual(status, 403);
  });

  it('refuses a portal login for a Customer ID that belongs to another provider', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, password: 'ABC123' }
    });
    assert.equal(status, 401);
    assert.equal(body.code, 'invalid_credentials');
  });
});

describe('the WhatsApp queue and the do-not-disturb list', () => {
  const PHONE = '5593999998888';
  let accountOf;

  before(async () => {
    accountOf = {};
    for (const [name, tenant] of [['alfa', alfa], ['beta', beta]]) {
      const account = await runInTenant(tenant, () => WhatsAppAccount.create({
        name: `skygp_leak_${name}`,
        purpose: 'support',
        flavor: 'v2',
        base_url: 'https://evo.example',
        status: 'connected'
      }));
      accountOf[name] = account.id;
    }
  });

  // The plan flagged this one: unqualified, `isActive` matched on the phone
  // alone, so one ISP's opt-out silenced every other ISP's number for that
  // person. The reverse is just as bad — the list says who asked whom to stop.
  it('does not let one provider\'s opt-out silence the other', async () => {
    await runInTenant(alfa, () => WaOptOut.record({ waPhone: PHONE, origin: 'customer' }));

    assert.equal(await runInTenant(alfa, () => WaOptOut.isActive({ waPhone: PHONE })), true);
    assert.equal(await runInTenant(beta, () => WaOptOut.isActive({ waPhone: PHONE })), false,
      'the other provider never asked this person for anything');

    const blocked = await runInTenant(beta, () => WaOptOut.activePhones([PHONE]));
    assert.equal(blocked.has(PHONE), false);
  });

  it('does not show one provider the other\'s opt-out list', async () => {
    const theirs = await runInTenant(alfa, () => WaOptOut.listActive());
    const mine = await runInTenant(beta, () => WaOptOut.listActive());
    assert.equal(theirs.length, 1);
    assert.equal(mine.length, 0);
  });

  // The outbox reads this. Unscoped it drained the deployment, which is why
  // the worker had to run once for everyone; scoped, a pass per provider
  // divides the queue instead of repeating it.
  it('gives each provider only its own sendable messages', async () => {
    const queue = async (tenant, name, body) => {
      const conversation = await WaConversation.ensure({
        accountId: accountOf[name],
        externalThreadId: `${PHONE}-${name}@s.whatsapp.net`,
        waPhone: PHONE,
        pushName: 'Cliente'
      });
      return WaMessage.create({
        conversation_id: conversation.id, direction: 'out', body, delivery_status: 'queued'
      });
    };

    const theirs = await runInTenant(alfa, () => queue(alfa, 'alfa', 'do alfa'));
    const mine = await runInTenant(beta, () => queue(beta, 'beta', 'do beta'));

    const alfaQueue = await runInTenant(alfa, () => WaMessage.listSendable(50));
    const betaQueue = await runInTenant(beta, () => WaMessage.listSendable(50));

    assert.deepEqual(alfaQueue, [theirs.id]);
    assert.deepEqual(betaQueue, [mine.id]);
  });

  it('will not let one provider claim the other\'s message', async () => {
    const [theirId] = await runInTenant(alfa, () => WaMessage.listSendable(1));
    assert.equal(await runInTenant(beta, () => WaMessage.claim(theirId)), null);

    const still = await runInTenant(alfa, () => WaMessage.getById(theirId));
    assert.equal(still.delivery_status, 'queued', 'nobody else took it');
  });

  // Both Evolution servers mint their own ids, so the same string can arrive
  // at two providers. On a global unique the second one vanished silently:
  // the inbound dedupe read it as a message already stored.
  it('lets the same external id exist for both providers', async () => {
    const shared = 'WA-MSG-COLLIDE-0001';
    for (const [tenant, name] of [[alfa, 'alfa'], [beta, 'beta']]) {
      await runInTenant(tenant, async () => {
        const conversation = await WaConversation.getByThread(
          accountOf[name], `${PHONE}-${name}@s.whatsapp.net`
        );
        await WaMessage.create({
          conversation_id: conversation.id, direction: 'in', body: 'oi', external_id: shared
        });
      });
    }

    assert.equal((await getDb()('wa_messages').where({ external_id: shared })).length, 2);
    const found = await runInTenant(beta, () => WaMessage.getByExternalId(shared));
    assert.equal(Number(found.tenant_id), Number(beta));
  });
});

describe('campaigns and the alert cooldown', () => {
  const RULE = 'ont_offline';
  const SUBJECT = 'ONT-SHARED-0001';

  // The cooldown lives on the row. Shared, an ONT going down at one provider
  // opened the only row for `(rule, subject)` — so the other provider's scan
  // found the condition already announced and stayed quiet about its own
  // subscriber's outage. Recovery was worse: `clear` closed it for everyone.
  it('does not let one provider\'s alert suppress the other\'s', async () => {
    await runInTenant(alfa, () => WaAlertState.open({ rule: RULE, subject: SUBJECT }));

    assert.ok(await runInTenant(alfa, () => WaAlertState.get(RULE, SUBJECT)));
    assert.equal(await runInTenant(beta, () => WaAlertState.get(RULE, SUBJECT)), null,
      'the other provider has not announced anything yet');

    // And it can open its own for the same rule and the same subject.
    const mine = await runInTenant(beta, () => WaAlertState.open({ rule: RULE, subject: SUBJECT }));
    assert.ok(mine);
    assert.equal((await getDb()('wa_alert_state').where({ rule: RULE, subject: SUBJECT })).length, 2);
  });

  it('does not let one provider\'s recovery close the other\'s alert', async () => {
    await runInTenant(beta, () => WaAlertState.clear(RULE, SUBJECT));

    assert.ok(await runInTenant(alfa, () => WaAlertState.get(RULE, SUBJECT)),
      'the other provider\'s ONT is still down and its alert still open');
    assert.equal(await runInTenant(beta, () => WaAlertState.get(RULE, SUBJECT)), null);
  });

  it('lets both providers name a template the same thing', async () => {
    const template = { name: 'segunda-via', body: 'Olá {{nome}}', category: 'cobranca' };
    await runInTenant(alfa, () => WaTemplate.create(template));
    await runInTenant(beta, () => WaTemplate.create({ ...template, body: 'Oi {{nome}}' }));

    const theirs = await runInTenant(alfa, () => WaTemplate.getByName('segunda-via'));
    const mine = await runInTenant(beta, () => WaTemplate.getByName('segunda-via'));
    assert.equal(theirs.body, 'Olá {{nome}}');
    assert.equal(mine.body, 'Oi {{nome}}');
  });

  // `addRecipients` goes through knex's batchInsert, which takes a table name
  // and never passes through `tdb`. Unstamped, every recipient would have been
  // filed under the installation's own provider by the column default.
  it('stamps the provider on recipients added in bulk', async () => {
    const broadcast = await runInTenant(beta, () => WaBroadcast.create({
      title: 'Cobrança de setembro', body: 'Olá', status: 'draft'
    }));
    await runInTenant(beta, () => WaBroadcast.addRecipients(broadcast.id, [
      { phone: '5593900000001', body: 'Olá um' },
      { phone: '5593900000002', body: 'Olá dois' }
    ]));

    const rows = await getDb()('wa_broadcast_recipients').where({ broadcast_id: broadcast.id });
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(Number(row.tenant_id), Number(beta));

    assert.deepEqual(await runInTenant(alfa, () => WaBroadcast.listRecipients(broadcast.id)), []);
  });

  it('gives the campaign flush only its own running campaigns', async () => {
    await runInTenant(alfa, () => WaBroadcast.create({ title: 'Do alfa', body: 'a', status: 'running' }));
    await runInTenant(beta, () => WaBroadcast.create({ title: 'Do beta', body: 'b', status: 'running' }));

    const theirs = await runInTenant(alfa, () => WaBroadcast.listByStatus('running'));
    const mine = await runInTenant(beta, () => WaBroadcast.listByStatus('running'));
    assert.deepEqual(theirs.map((b) => b.title), ['Do alfa']);
    assert.deepEqual(mine.map((b) => b.title), ['Do beta']);
  });
});

describe('the configuration each provider runs on', () => {
  // `settings` and `app_state` are what a provider IS: its GenieACS, its
  // Customer ID scheme, its SGP credentials. Shared, the second provider would
  // manage the first provider's fleet.
  it('gives each provider its own GenieACS', async () => {
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', 'http://acs.alfa.test:7557'));
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', 'http://acs.beta.test:7557'));

    assert.equal(
      await runInTenant(alfa, () => Setting.getByKey('genieAcsUrl')),
      'http://acs.alfa.test:7557'
    );
    assert.equal(
      await runInTenant(beta, () => Setting.getByKey('genieAcsUrl')),
      'http://acs.beta.test:7557'
    );
  });

  it('shows each provider only its own settings', async () => {
    const theirs = await runInTenant(alfa, () => Setting.getAll());
    const mine = await runInTenant(beta, () => Setting.getAll());
    assert.equal(theirs.genieAcsUrl, 'http://acs.alfa.test:7557');
    assert.equal(mine.genieAcsUrl, 'http://acs.beta.test:7557');
  });

  it('does not let one provider delete the other\'s setting', async () => {
    await runInTenant(beta, () => Setting.delete('genieAcsUrl'));

    assert.equal(
      await runInTenant(alfa, () => Setting.getByKey('genieAcsUrl')),
      'http://acs.alfa.test:7557',
      'the other provider still knows where its ACS is'
    );
    assert.equal(await runInTenant(beta, () => Setting.getByKey('genieAcsUrl')), null);
  });

  // The blob holds the SGP API token and webhook secret, encrypted. Reading
  // another provider's is reading their credentials.
  it('keeps one provider\'s integration blob out of the other\'s reach', async () => {
    await runInTenant(alfa, () => AppState.upsert('sgp_integration_config', '{"app":"alfa"}'));

    assert.equal(
      await runInTenant(alfa, () => AppState.get('sgp_integration_config')),
      '{"app":"alfa"}'
    );
    assert.equal(await runInTenant(beta, () => AppState.get('sgp_integration_config')), null);
  });

  // Not configuration at all: device and fault counts, cached per provider.
  it('does not show one provider the other\'s dashboard numbers', async () => {
    await runInTenant(alfa, () => AppState.upsert('dashboard_snapshot', '{"data":{"stats":{"total":41}}}'));
    await runInTenant(beta, () => AppState.upsert('dashboard_snapshot', '{"data":{"stats":{"total":7}}}'));

    assert.match(await runInTenant(alfa, () => AppState.get('dashboard_snapshot')), /41/);
    assert.match(await runInTenant(beta, () => AppState.get('dashboard_snapshot')), /"total":7/);
  });

  // The latch that makes two concurrent setups safe. Per provider now, which is
  // the point: one provider finishing setup must not lock the other out of it.
  it('does not let one provider\'s completed setup block the other\'s', async () => {
    await runInTenant(alfa, () => AppState.upsert('setup_completed', '1'));

    assert.equal(await runInTenant(alfa, () => AppState.get('setup_completed')), '1');
    assert.equal(await runInTenant(beta, () => AppState.get('setup_completed')), null);
  });
});

describe('the caches a provider reads its own configuration from', () => {
  // These sit in front of `app_state`, which PR 7 made per provider. A cache
  // that is not keyed the same way undoes that silently: the second provider
  // gets a hit on the first provider's entry and never reaches the table.
  //
  // Two of them hold decrypted secrets, so a shared hit is not a stale read —
  // it is one ISP handing another its credentials.
  it('does not serve one provider the other\'s SGP token', async () => {
    await runInTenant(alfa, () => SgpService.saveConfig({
      enabled: true, baseUrl: 'https://sgp.alfa.test', app: 'alfa', token: 'token-do-alfa'
    }));
    await runInTenant(beta, () => SgpService.saveConfig({
      enabled: true, baseUrl: 'https://sgp.beta.test', app: 'beta', token: 'token-do-beta'
    }));

    // Warm alfa's entry first, then ask as beta. Shared, this is where beta
    // would be handed alfa's decrypted token.
    assert.equal((await runInTenant(alfa, () => SgpService.getConfig())).token, 'token-do-alfa');
    assert.equal((await runInTenant(beta, () => SgpService.getConfig())).token, 'token-do-beta');
    assert.equal((await runInTenant(alfa, () => SgpService.getConfig())).app, 'alfa');
  });

  it('does not serve one provider the other\'s Evolution settings', async () => {
    await runInTenant(alfa, () => WhatsAppConfigService.saveConfig({
      enabled: true, webhookBaseUrl: 'https://alfa.test/api/whatsapp-webhook'
    }));
    await runInTenant(beta, () => WhatsAppConfigService.saveConfig({
      enabled: true, webhookBaseUrl: 'https://beta.test/api/whatsapp-webhook'
    }));

    assert.match(
      (await runInTenant(alfa, () => WhatsAppConfigService.getConfig())).webhookBaseUrl,
      /alfa/
    );
    assert.match(
      (await runInTenant(beta, () => WhatsAppConfigService.getConfig())).webhookBaseUrl,
      /beta/
    );
  });

  // The alert settings hold the on-call phone numbers.
  it('does not serve one provider the other\'s on-call list', async () => {
    await runInTenant(alfa, () => WaAlertService.saveSettings({
      enabled: true, recipients: ['5593981110001']
    }));
    await runInTenant(beta, () => WaAlertService.saveSettings({
      enabled: true, recipients: ['5593982220002']
    }));

    assert.deepEqual(
      (await runInTenant(alfa, () => WaAlertService.getSettings())).recipients,
      ['5593981110001']
    );
    assert.deepEqual(
      (await runInTenant(beta, () => WaAlertService.getSettings())).recipients,
      ['5593982220002']
    );
  });

  it('invalidating one provider\'s cache leaves the other\'s warm entry alone', async () => {
    await runInTenant(alfa, () => SgpService.getConfig());
    await runInTenant(beta, () => SgpService.getConfig());

    await runInTenant(beta, () => SgpService.invalidateConfigCache());

    // Written straight to the table, under alfa: a warm alfa entry still
    // answers from cache and does not see it. If invalidate had cleared every
    // provider, this read would go to the table and return the new value.
    await runInTenant(alfa, () => AppState.upsert(
      'sgp_integration_config', JSON.stringify({ enabled: true, app: 'alterado-por-fora' })
    ));
    assert.equal((await runInTenant(alfa, () => SgpService.getConfig())).app, 'alfa');
  });

  // Not configuration: device and fault counts, and an in-flight refresh that
  // a second provider used to await and receive as its own.
  it('gives each provider its own dashboard cache and its own in-flight refresh', async () => {
    const alfaCache = await runInTenant(alfa, () => DeviceService.dashboardCacheFor());
    const betaCache = await runInTenant(beta, () => DeviceService.dashboardCacheFor());
    assert.notEqual(alfaCache, betaCache, 'two providers, two caches');

    alfaCache.data = { stats: { total: 41 } };
    alfaCache.expiresAt = Date.now() + 60_000;
    assert.equal(betaCache.data, null, 'the other provider has nothing cached');

    await runInTenant(beta, () => DeviceService.invalidateDashboard());
    assert.ok(alfaCache.expiresAt > Date.now(), 'and its entry is untouched by the other');
  });
});

describe('the subscription and the statement', () => {

  before(async () => {
    const plan = await getDb()('plans').where({ code: 'unlimited' }).first();
    await Subscription.upsertForTenant(alfa, { plan_id: plan.id, status: 'active' });
    await Subscription.upsertForTenant(beta, { plan_id: plan.id, status: 'suspended' });
    await runInTenant(alfa, () => BillingEvent.record({ type: 'payment.recorded', amountCents: 100, currency: 'BRL', externalId: 'PIX-ALFA' }));
    await runInTenant(beta, () => BillingEvent.record({ type: 'payment.recorded', amountCents: 200, currency: 'BRL', externalId: 'PIX-BETA' }));
    await SubscriptionService.invalidate(alfa);
    await SubscriptionService.invalidate(beta);
  });

  // The state one provider is in must never be read as the other's: alfa is
  // active and beta is suspended, and a gate that read the wrong row would
  // lock the paying provider out — or let the suspended one in.
  it('shows each provider only its own state', async () => {
    const mine = await runInTenant(alfa, () => Subscription.current());
    const theirs = await runInTenant(beta, () => Subscription.current());
    assert.equal(Number(mine.tenant_id), Number(alfa));
    assert.equal(Number(theirs.tenant_id), Number(beta));
    assert.equal(mine.status, 'active');
    assert.equal(theirs.status, 'suspended');

    const gateForAlfa = await runInTenant(alfa, async () => SubscriptionService.decide((await SubscriptionService.current()).subscription));
    const gateForBeta = await runInTenant(beta, async () => SubscriptionService.decide((await SubscriptionService.current()).subscription));
    assert.equal(gateForAlfa.allowed, true);
    assert.equal(gateForBeta.allowed, false);
  });

  // Financial data. One provider reading the other's statement is the number
  // it pays and when — the kind of line a competitor would like to have.
  it('shows each provider only its own statement', async () => {
    const mine = await runInTenant(alfa, () => BillingEvent.listRecent());
    const theirs = await runInTenant(beta, () => BillingEvent.listRecent());
    assert.deepEqual(mine.map((e) => e.external_id), ['PIX-ALFA']);
    assert.deepEqual(theirs.map((e) => e.external_id), ['PIX-BETA']);
  });

  it('a change made in one scope does not touch the other', async () => {
    await runInTenant(beta, () => SubscriptionService.setStatus({ status: 'canceled' }));
    const mine = await runInTenant(alfa, () => Subscription.current());
    assert.equal(mine.status, 'active');
    assert.equal(mine.canceled_at, null);
  });

  /**
   * A cobrança emitida carrega um LINK DE PAGAMENTO, e é isso que a torna pior
   * que o extrato se vazar: o extrato do vizinho diz quanto ele paga; o link do
   * vizinho é um endereço onde se paga a conta dele. As duas cobranças abaixo
   * têm de propósito o mesmo `period_end` — a chave única é por provedor, e um
   * único global faria a segunda inserção falhar em vez de coexistir.
   */
  it('shows each provider only its own charge, link and all', async () => {
    const MESMO_PERIODO = '2026-10-31';
    const aberta = async (tenantId, sufixo) => runInTenant(tenantId, async () => {
      const id = await BillingCharge.open({
        periodEnd: MESMO_PERIODO, amountCents: 19990, currency: 'BRL', provider: 'asaas'
      });
      await BillingCharge.markIssued(id, {
        gatewayChargeId: `pay_${sufixo}`,
        invoiceUrl: `https://gateway.exemplo.test/i/pay_${sufixo}`
      });
    });
    await aberta(alfa, 'alfa');
    await aberta(beta, 'beta');

    const minha = await runInTenant(alfa, () => BillingCharge.currentOpen());
    const dele = await runInTenant(beta, () => BillingCharge.currentOpen());
    assert.equal(minha.gateway_charge_id, 'pay_alfa');
    assert.equal(dele.gateway_charge_id, 'pay_beta');
    assert.ok(!minha.invoice_url.includes('beta'), 'o link de pagamento do vizinho');

    // E a busca pelo id do gateway — o caminho que o webhook usa para quitar —
    // não alcança a cobrança do vizinho nem quando o id é o dele.
    assert.equal(await runInTenant(alfa, () => BillingCharge.byGatewayId('pay_beta')), null);

    // Nem a listagem de períodos anteriores, que é o que cancela cobrança velha.
    const antigasDoAlfa = await runInTenant(alfa, () => BillingCharge.openBefore('2026-12-01'));
    assert.deepEqual(antigasDoAlfa.map((c) => c.gateway_charge_id), ['pay_alfa']);
  });
});


/**
 * O contrato do SGP é do SGP, e dois provedores podem ter o mesmo número.
 *
 * A correção do telefone de um assinante é endereçada pelo contrato, não por um
 * id daqui: `PUT /api/whatsapp/subscribers/:contract/phone` chega ao banco por
 * `where({ contract })`. Se essa consulta não fosse escopada, corrigir o número
 * do contrato 4242 mudaria o número do 4242 do vizinho — e o próximo disparo de
 * cobrança dele iria para o telefone errado, que é o pior jeito de descobrir.
 */
describe('o mesmo contrato do ERP nos dois provedores', () => {
  const CONTRATO = '4242';

  before(async () => {
    for (const [tenant, sufixo] of [[alfa, 'alfa'], [beta, 'beta']]) {
      await runInTenant(tenant, () => getDb()('sgp_links').insert({
        tenant_id: tenant,
        device_id: `ONT-${sufixo.toUpperCase()}-4242`,
        contract: CONTRATO,
        client_name: `Assinante do ${sufixo}`,
        state: 'active',
        phone_manual: null
      }));
    }
  });

  it('deixa os dois manterem o vínculo do mesmo contrato', async () => {
    for (const tenant of [alfa, beta]) {
      const links = await runInTenant(tenant, () => SgpLink.getByContract(CONTRATO));
      assert.equal(links.length, 1, 'cada provedor enxerga só o vínculo dele');
    }
  });

  it('corrige o telefone de um sem tocar no do outro', async () => {
    await runInTenant(alfa, () => WaBillingService.setSubscriberPhone(CONTRATO, '(11) 98888-0001'));

    const doAlfa = await runInTenant(alfa, () => SgpLink.getByContract(CONTRATO));
    assert.equal(doAlfa[0].phone_manual, '5511988880001');

    const doBeta = await runInTenant(beta, () => SgpLink.getByContract(CONTRATO));
    assert.equal(doBeta[0].phone_manual, null,
      'a correção do alfa mudou o telefone do assinante do beta');
  });

  it('e cada um lê a correção do seu', async () => {
    await runInTenant(beta, () => WaBillingService.setSubscriberPhone(CONTRATO, '(11) 97777-0002'));

    const doAlfa = await runInTenant(alfa, () => SgpLink.getByContract(CONTRATO));
    const doBeta = await runInTenant(beta, () => SgpLink.getByContract(CONTRATO));
    assert.equal(doAlfa[0].phone_manual, '5511988880001');
    assert.equal(doBeta[0].phone_manual, '5511977770002');
  });
});
