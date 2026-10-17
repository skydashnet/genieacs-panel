import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

const ON_CALL = '5593981110001';
const MINUTE = 60_000;
const inTenant = (fn) => asTenant(fn);
const scan = () => inTenant(() => WaAlertService.scan({ now: Date.now() }));
const flush = (options) => inTenant(async () => WaAlertService.flushDigest(await WaAlertService.getSettings(), options));

let fleet = [];
let realDashboardDevices;
let realIdentityDevices;

const offline = (id, minutes = 40) => ({
  _id: id,
  rxpower: -20,
  temperature: 45,
  _lastInform: new Date(Date.now() - minutes * MINUTE).toISOString()
});

const outbox = () => getDb()('wa_messages').where({ direction: 'out' }).orderBy('id');

const save = (extra = {}) => inTenant(() => WaAlertService.saveSettings({
  enabled: true,
  recipients: [ON_CALL],
  rules: {
    ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 120 },
    rx_power_low: { enabled: false },
    temperature_high: { enabled: false },
    mass_outage: { enabled: false },
    wa_disconnected: { enabled: false },
    wa_waiting: { enabled: false }
  },
  ...extra
}));

before(async () => {
  await startTestServers();
  realDashboardDevices = DeviceService.getDashboardDevices;
  realIdentityDevices = DeviceService.getCustomerIdentityDevices;
  DeviceService.getDashboardDevices = async () => fleet;
  DeviceService.getCustomerIdentityDevices = async () => [];
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-alertas',
    purpose: 'alerts',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-alertas'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-alertas')
  }));
});

after(async () => {
  DeviceService.getDashboardDevices = realDashboardDevices;
  DeviceService.getCustomerIdentityDevices = realIdentityDevices;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_messages').del();
  await getDb()('wa_alert_state').del();
  await getDb()('app_state').where({ key: 'whatsapp_alert_digest' }).del();
  fleet = [];
  WaAlertService.settingsCache.clear();
});

describe('digestMinutes', () => {
  it('defaults to 0 and sends one message per alert, as before', async () => {
    await save();
    fleet = [offline('a'), offline('b'), offline('c')];
    await scan();
    assert.equal((await outbox()).length, 3);
  });

  it('keeps only 0, 5, 10, 15 and 30; anything else goes back to 0', async () => {
    assert.equal((await save({ digestMinutes: 15 })).digestMinutes, 15);
    assert.equal((await save({ digestMinutes: 7 })).digestMinutes, 0);
    assert.equal((await save({ digestMinutes: 'abc' })).digestMinutes, 0);
    assert.equal((await save({ digestMinutes: 30 })).digestMinutes, 30);
  });

  it('queues the alerts and sends ONE message when the time is up', async () => {
    await save({ digestMinutes: 10 });
    fleet = [offline('a'), offline('b'), offline('c'), offline('d'), offline('e')];
    const summary = await scan();
    assert.equal(summary.fired, 5);
    assert.equal(summary.notified, 5, 'the condition still counts as notified');
    assert.equal((await outbox()).length, 0, 'nothing leaves before the time');

    assert.equal(await flush({ now: Date.now() + 5 * MINUTE }), 0, 'five minutes is not ten');
    assert.equal((await outbox()).length, 0);

    assert.ok(await flush({ now: Date.now() + 10 * MINUTE }) > 0);
    const sent = await outbox();
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /5 novo|5 new/);
    for (const id of ['a', 'b', 'c', 'd', 'e']) assert.ok(sent[0].body.includes(id), id);

    assert.equal(await flush({ now: Date.now() + 30 * MINUTE }), 0, 'the queue was emptied');
    assert.equal((await outbox()).length, 1);
  });

  it('a single queued alert goes out with its original text', async () => {
    await save({ digestMinutes: 5 });
    fleet = [offline('solo')];
    await scan();
    await flush({ force: true });
    const sent = await outbox();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].body.includes('solo'));
    assert.doesNotMatch(sent[0].body, /•/);
  });

  it('separates new alerts from recoveries', async () => {
    await save({ digestMinutes: 5 });
    fleet = [offline('a'), offline('b')];
    await scan();
    fleet = [{ ...offline('a'), _lastInform: new Date().toISOString() }, offline('b'), offline('c')];
    await scan();
    await flush({ force: true });
    const sent = await outbox();
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Novos:|New:/);
    assert.match(sent[0].body, /Normalizados:|Back to normal:/);
  });

  it('caps each section at 25 lines and says how many were left out', async () => {
    await save({ digestMinutes: 5 });
    fleet = Array.from({ length: 30 }, (_, i) => offline(`ont-${i}`));
    await scan();
    await flush({ force: true });
    const body = (await outbox())[0].body;
    assert.equal(body.split('\n').filter((line) => line.startsWith('•')).length, 25);
    assert.match(body, /5/);
    assert.match(body, /… (e mais|and) 5|… and 5 more/);
  });

  it('keeps the queue when no channel is ready', async () => {
    await save({ digestMinutes: 5 });
    fleet = [offline('a'), offline('b')];
    await scan();
    const settings = await inTenant(() => WaAlertService.getSettings());
    const real = WaAlertService.readyChannels;
    WaAlertService.readyChannels = async () => ({ whatsapp: null, email: null, telegram: null, reason: 'no_alert_number' });
    try {
      assert.equal(await inTenant(() => WaAlertService.flushDigest(settings, { force: true })), 0);
    } finally {
      WaAlertService.readyChannels = real;
    }
    await flush({ force: true });
    assert.equal((await outbox()).length, 1, 'delivered once a channel is back');
  });

  it('returning to "right away" flushes what was waiting on the next tick', async () => {
    await save({ digestMinutes: 30 });
    fleet = [offline('a'), offline('b')];
    await scan();
    await save({ digestMinutes: 0 });
    await inTenant(() => WaAlertService.tickForTenant());
    assert.equal((await outbox()).length, 1);
  });

  it('the manual scan route flushes the queue', async () => {
    await save({ digestMinutes: 30 });
    fleet = [offline('a'), offline('b')];
    await scan();
    assert.equal((await outbox()).length, 0);
    const { default: Controller } = await import('../src/controllers/whatsappAlertsController.js');
    const res = { json() { return this; }, status() { return this; } };
    await inTenant(() => Controller.scan({ t: (k) => k, headers: {} }, res));
    assert.equal((await outbox()).length, 1);
  });
});
