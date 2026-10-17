import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

// A scan reached directly has no request behind it, so nothing has resolved a
// provider — the same position the timer is in, and why `tick` opens one. The
// routes that call `scan` are already inside a request.
const scan = (options) => asTenant(() => WaAlertService.scan(options));
const { default: WaAlertService, LAST_SCAN_KEY } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

const ALERTS = 'painel-alertas';
const ON_CALL = '5593981110001';
const SECOND_ON_CALL = '5593981110002';

let panelUrl;
let token;
let alertsAccountId;

/**
 * The telemetry is stubbed rather than served by a GenieACS.
 *
 * What is under test is the rules and the noise control, and both are pure
 * functions of a fleet read. Standing up an ACS would test the reader in
 * `deviceService`, which has its own tests, and would make "an ONT that has
 * been offline for exactly thirty minutes" impossible to write down.
 */
let fleet = [];
let identities = [];
let realDashboardDevices;
let realIdentityDevices;

const MINUTE = 60_000;
const now = () => Date.now();
const informedMinutesAgo = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();

function device(id, patch = {}) {
  return {
    _id: id,
    rxpower: -20,
    temperature: 45,
    _lastInform: informedMinutesAgo(1),
    ...patch
  };
}

async function outbox() {
  return getDb()('wa_messages').where({ direction: 'out' }).orderBy('id');
}

async function alertRows() {
  return getDb()('wa_alert_state').orderBy('id');
}

/** Each test starts from an empty outbox and no open condition. */
async function reset() {
  await getDb()('wa_messages').del();
  await getDb()('wa_alert_state').del();
  fleet = [];
  identities = [];
  WaAlertService.settingsCache.clear();
}

async function setRules(rules, extra = {}) {
  // Scoped for the same reason `scan` is: saving settings reads back the
  // alert number to report whether alerts are actually deliverable.
  await asTenant(() => WaAlertService.saveSettings({
    enabled: true,
    recipients: [ON_CALL],
    rules,
    ...extra
  }));
}

/** Only the rule under test is on, so no fixture can trip a second one. */
const onlyRule = (rule, patch = {}) => ({
  ont_offline: { enabled: false },
  rx_power_low: { enabled: false },
  temperature_high: { enabled: false },
  mass_outage: { enabled: false },
  wa_disconnected: { enabled: false },
  wa_waiting: { enabled: false },
  [rule]: { enabled: true, ...patch }
});

before(async () => {
  ({ panelUrl } = await startTestServers());

  realDashboardDevices = DeviceService.getDashboardDevices;
  realIdentityDevices = DeviceService.getCustomerIdentityDevices;
  DeviceService.getDashboardDevices = async () => fleet;
  DeviceService.getCustomerIdentityDevices = async () => identities;

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
  }));

  const account = await asTenant(() => WhatsAppAccount.create({
    name: ALERTS,
    purpose: 'alerts',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-alertas'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-alertas')
  }));
  alertsAccountId = account.id;
});

after(async () => {
  DeviceService.getDashboardDevices = realDashboardDevices;
  DeviceService.getCustomerIdentityDevices = realIdentityDevices;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(reset);

describe('the settings routes', () => {
  it('hands back the five rules with their thresholds', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200);
    assert.deepEqual(
      Object.keys(body.data.rules).sort(),
      ['mass_outage', 'ont_offline', 'rx_power_low', 'temperature_high', 'wa_disconnected', 'wa_waiting']
    );
    for (const rule of Object.values(body.data.rules)) {
      assert.equal(typeof rule.enabled, 'boolean');
      assert.equal(typeof rule.cooldownMinutes, 'number');
    }
    assert.ok(Array.isArray(body.data.recipients));
  });

  it('saves what it is given and refuses a number it cannot dial', async () => {
    const saved = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: {
        enabled: true,
        intervalSeconds: 120,
        recipients: [ON_CALL, SECOND_ON_CALL],
        rules: { ont_offline: { enabled: true, threshold: 45, cooldownMinutes: 90 } }
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.intervalSeconds, 120);
    assert.deepEqual(saved.body.data.recipients, [ON_CALL, SECOND_ON_CALL]);
    assert.equal(saved.body.data.rules.ont_offline.threshold, 45);
    // The three rules the request did not mention keep their stored values.
    assert.equal(saved.body.data.rules.rx_power_low.threshold, -27);

    const refused = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { recipients: ['nao-e-um-telefone'] }
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'invalid_phone');
  });

  it('refuses to be enabled with nobody on duty, under its own code', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true, recipients: [] }
    });
    assert.equal(status, 400);
    // Not the campaign's `no_recipients`, which means "the filters left nobody
    // to charge". A form that translates the code would put that sentence on
    // this screen.
    assert.equal(body.code, 'no_alert_recipients');

    // And the refusal is not a silent no-op: the stored list is untouched.
    const after = await call(`${panelUrl}/api/whatsapp/alerts/settings`, { headers: authHeaders(token) });
    assert.deepEqual(after.body.data.recipients, [ON_CALL, SECOND_ON_CALL]);
  });

  it('an emptied threshold goes back to the default, never to zero', async () => {
    // `Number(null)` and `Number('')` are both 0, and 0 is finite. Read after
    // the conversion, a box the operator cleared would be stored as a threshold
    // of zero — and `temperature_high` at 0 °C alerts on the whole fleet,
    // forever, which is the loudest possible way to be wrong.
    for (const empty of [null, '']) {
      const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: { rules: { temperature_high: { enabled: true, threshold: empty } } }
      });
      assert.equal(status, 200);
      assert.equal(body.data.rules.temperature_high.threshold, 70, `for ${JSON.stringify(empty)}`);
    }

    // And a real zero, typed on purpose, is still a zero.
    const zero = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { rules: { rx_power_low: { enabled: true, threshold: 0 } } }
    });
    assert.equal(zero.body.data.rules.rx_power_low.threshold, 0);
  });
});

describe('each rule fires at its threshold and not just inside it', () => {
  it('ont_offline fires at the threshold in minutes, not before', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 120 }));

    fleet = [device('dev-quase', { _lastInform: informedMinutesAgo(29) })];
    let summary = await scan({ now: now() });
    assert.equal(summary.fired, 0, 'twenty-nine minutes is inside the window');
    assert.equal((await outbox()).length, 0);

    fleet = [device('dev-fora', { _lastInform: informedMinutesAgo(30) })];
    summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    const rows = await alertRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule, 'ont_offline');
    assert.equal(rows[0].subject, 'dev-fora');
    const enviadas = await outbox();
    assert.equal(enviadas.length, 1);
    // The on-duty thread is a conversation like any other, so the bot reads it
    // too. Unnamed, a busy night would have counted against the bot's ceiling
    // for whoever is on call.
    assert.equal(enviadas[0].source, 'alert');
  });

  it('rx_power_low fires at the threshold in dBm, not just above it', async () => {
    await setRules(onlyRule('rx_power_low', { threshold: -27, cooldownMinutes: 360 }));

    fleet = [device('dev-ok', { rxpower: -26.9 })];
    let summary = await scan({ now: now() });
    assert.equal(summary.fired, 0);

    fleet = [device('dev-fraco', { rxpower: -27 })];
    summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    assert.equal((await alertRows())[0].rule, 'rx_power_low');
  });

  it('temperature_high fires at the threshold in °C, not just below it', async () => {
    await setRules(onlyRule('temperature_high', { threshold: 70, cooldownMinutes: 360 }));

    fleet = [device('dev-morno', { temperature: 69.9 })];
    let summary = await scan({ now: now() });
    assert.equal(summary.fired, 0);

    fleet = [device('dev-quente', { temperature: 70 })];
    summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    assert.equal((await alertRows())[0].rule, 'temperature_high');
  });
});

describe('a firing condition speaks once', () => {
  it('notifies once and then stays quiet until the cooldown passes', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-teimoso', { _lastInform: informedMinutesAgo(120) })];

    const first = await scan({ now: now() });
    assert.equal(first.fired, 1);
    assert.equal((await outbox()).length, 1);

    // Three more passes over the same unchanged fault.
    await scan({ now: now() });
    await scan({ now: now() });
    await scan({ now: now() });
    assert.equal((await outbox()).length, 1, 'a repeated alert is how a channel gets muted');
    let row = (await alertRows())[0];
    assert.equal(Number(row.notify_count), 1);
    assert.equal(row.state, 'firing');

    // The cooldown is measured from `last_notified_at`, so backdating it is the
    // same thing as an hour going by.
    await getDb()('wa_alert_state')
      .where({ id: row.id })
      .update({ last_notified_at: new Date(Date.now() - 61 * MINUTE) });

    const later = await scan({ now: now() });
    assert.equal(later.fired, 0, 'a repeat is not a new condition');
    assert.equal((await outbox()).length, 2);
    row = (await alertRows())[0];
    assert.equal(Number(row.notify_count), 2);
  });
});

describe('a recovery is a message too', () => {
  it('says so once and clears the row', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-volta', { _lastInform: informedMinutesAgo(120) })];
    await scan({ now: now() });
    const alerted = await outbox();
    assert.equal(alerted.length, 1);

    fleet = [device('dev-volta', { _lastInform: informedMinutesAgo(1) })];
    const summary = await scan({ now: now() });
    assert.equal(summary.cleared, 1);
    assert.equal((await alertRows()).length, 0, 'the row goes with the fault');

    const messages = await outbox();
    assert.equal(messages.length, 2);
    assert.notEqual(
      messages[1].body,
      messages[0].body,
      'a recovery that reads like the alarm is read as a second alarm'
    );

    // And only once: a cleared condition has nothing left to say.
    await scan({ now: now() });
    assert.equal((await outbox()).length, 2);
  });
});

describe('a mass outage is one message, not forty', () => {
  before(async () => {
    // One ODP with six ONTs hanging off it, plus one ONT on a second ODP that
    // never goes down — so the grouping has something to NOT include.
    await insertReturningId('mapping_nodes', {
      node_id: 'ODP-1', type: 'odp', name: 'ODP Centro', latitude: -3.1, longitude: -60.0
    });
    await insertReturningId('mapping_nodes', {
      node_id: 'ODP-2', type: 'odp', name: 'ODP Bairro', latitude: -3.2, longitude: -60.1
    });
    for (let index = 1; index <= 6; index += 1) {
      await insertReturningId('mapping_nodes', {
        node_id: `ONT-${index}`,
        type: 'ont',
        name: `Assinante ${index}`,
        latitude: -3.1,
        longitude: -60.0,
        pppoe: `cliente${index}`
      });
      await getDb()('mapping_edges').insert({
        edge_id: `E-${index}`,
        source: `ONT-${index}`,
        target: index === 6 ? 'ODP-2' : 'ODP-1',
        fiber_type: 'drop'
      });
    }
  });

  it('names the node, counts the ONTs, and holds back the individual alerts', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    });

    identities = Array.from({ length: 6 }, (unused, index) => ({
      _id: `dev-${index + 1}`,
      pppoe: `cliente${index + 1}`
    }));
    // The five on ODP-1 drop together; the one on ODP-2 stays up.
    fleet = identities.map((item, index) => device(item._id, {
      _lastInform: index < 5 ? informedMinutesAgo(45) : informedMinutesAgo(1)
    }));

    const summary = await scan({ now: now() });
    assert.equal(summary.fired, 1, 'one fibre cut is one alert');

    const rows = await alertRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule, 'mass_outage');
    assert.equal(rows[0].subject, 'ODP-1');

    const messages = await outbox();
    assert.equal(messages.length, 1, 'forty messages at 3 a.m. is how alerting gets muted');
  });

  it('leaves an ONT on an unaffected node to its own alert', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    });

    identities = Array.from({ length: 6 }, (unused, index) => ({
      _id: `dev-${index + 1}`,
      pppoe: `cliente${index + 1}`
    }));
    // Two of the five on ODP-1: under the threshold AND not the majority of the
    // box, so nothing is grouped and each one is announced on its own.
    fleet = identities.map((item, index) => device(item._id, {
      _lastInform: index < 2 ? informedMinutesAgo(45) : informedMinutesAgo(1)
    }));

    const summary = await scan({ now: now() });
    assert.equal(summary.fired, 2);
    const rules = new Set((await alertRows()).map((row) => row.rule));
    assert.deepEqual([...rules], ['ont_offline']);
  });

  it('a small box whose majority dropped is a fibre cut, told with "x of y", the time and the place', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    });

    identities = Array.from({ length: 6 }, (unused, index) => ({
      _id: `dev-${index + 1}`,
      pppoe: `cliente${index + 1}`
    }));
    // Four of the five on ODP-1: below the absolute threshold of five, but 80%
    // of the box. That is the drop cable, not four coincidences.
    fleet = identities.map((item, index) => device(item._id, {
      _lastInform: index < 4 ? informedMinutesAgo(45 + index) : informedMinutesAgo(1)
    }));

    const summary = await scan({ now: now() });
    assert.equal(summary.fired, 1);
    const rows = await alertRows();
    assert.deepEqual(rows.map((row) => [row.rule, row.subject]), [['mass_outage', 'ODP-1']]);

    const [message] = await outbox();
    assert.match(message.body, /4 de 5/);
    // "Há quanto tempo": o sinal mais antigo, o do primeiro que caiu.
    assert.match(message.body, /48 min/);
    assert.match(message.body, /https:\/\/maps\.google\.com\/\?q=-3\.\d+,-60\.\d+/);
    // Voltou: a mensagem diz o NOME da caixa, não o id interno.
    fleet = identities.map((item) => device(item._id, { _lastInform: informedMinutesAgo(1) }));
    await scan({ now: now() });
    const messages = await outbox();
    assert.equal(messages.length, 2);
    assert.ok(!messages[1].body.includes('ODP-1'), messages[1].body);
    assert.match(messages[1].body, /ODP Centro restabelecido/);
  });
});

describe('a scan that cannot say anything says why', () => {
  it('does nothing at all when no number carries the alerts purpose', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30 }));
    fleet = [device('dev-mudo', { _lastInform: informedMinutesAgo(120) })];

    await asTenant(() => WhatsAppAccount.update(alertsAccountId, { status: 'disconnected' }));
    try {
      const summary = await scan({ now: now() });
      // Its own reason, not `no_recipients`: this one is fixed on the
      // connection screen, that one on the alerts screen, and a single message
      // for both sends the admin to the wrong place.
      assert.equal(summary.skipped, 'no_alert_number');
      assert.equal(summary.fired, 0);
      assert.equal((await alertRows()).length, 0, 'nothing may be recorded as announced');
      assert.equal((await outbox()).length, 0);

      const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/scan`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {}
      });
      assert.equal(status, 409);
      assert.equal(body.code, 'no_alert_number');
    } finally {
      await asTenant(() => WhatsAppAccount.update(alertsAccountId, { status: 'connected' }));
    }
  });

  it('runs a pass from the route and reports what it did', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-rota', { _lastInform: informedMinutesAgo(90) })];

    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/scan`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {}
    });
    assert.equal(status, 200);
    assert.equal(body.data.fired, 1);
    assert.equal(body.data.cleared, 0);
  });
});

describe('one bad reading is not the fleet', () => {
  it('does not throw, and still alerts on the device it could read', async () => {
    await setRules({
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      rx_power_low: { enabled: true, threshold: -27, cooldownMinutes: 60 },
      temperature_high: { enabled: true, threshold: 70, cooldownMinutes: 60 },
      mass_outage: { enabled: false }
    });

    fleet = [
      null,
      {},
      device('dev-sem-inform', { _lastInform: 'ontem de manhã' }),
      device('dev-sem-id', { _id: '' }),
      device('dev-lixo', { rxpower: 'n/a', temperature: '--' }),
      device('dev-real', { _lastInform: informedMinutesAgo(90) })
    ];

    const summary = await scan({ now: now() });
    assert.equal(summary.error, null, 'a scan must never throw out of a tick');
    const rows = await alertRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'dev-real');
  });

  it('reports rather than throws when the fleet read itself fails', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30 }));
    DeviceService.getDashboardDevices = async () => {
      throw new Error('GenieACS API responded with status: 502');
    };
    try {
      const summary = await scan({ now: now() });
      assert.equal(summary.skipped, 'error');
      assert.match(summary.error, /502/);
    } finally {
      DeviceService.getDashboardDevices = async () => fleet;
    }
  });

  it('refuses to call an empty fleet a fleet-wide recovery', async () => {
    await setRules(onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 }));
    fleet = [device('dev-vivo', { _lastInform: informedMinutesAgo(90) })];
    await scan({ now: now() });
    assert.equal((await alertRows()).length, 1);

    // An empty read is a broken ACS far more often than a provider with no
    // ONTs, and treating it as "all clear" would blast one recovery per row.
    fleet = [];
    const summary = await scan({ now: now() });
    assert.equal(summary.skipped, 'no_devices');
    assert.equal(summary.cleared, 0);
    assert.equal((await alertRows()).length, 1);
  });
});

describe('the recipients are staff, and the do-not-disturb list still holds', () => {
  it('writes one message per recipient and skips a number that opted out', async () => {
    await asTenant(() => WaAlertService.saveSettings({
      enabled: true,
      recipients: [ON_CALL, SECOND_ON_CALL],
      rules: onlyRule('ont_offline', { threshold: 30, cooldownMinutes: 60 })
    }));
    fleet = [device('dev-dois', { _lastInform: informedMinutesAgo(90) })];

    await scan({ now: now() });
    assert.equal((await outbox()).length, 2);

    await getDb()('wa_alert_state').del();
    await getDb()('wa_messages').del();
    await getDb()('wa_opt_outs').insert({
      wa_phone_e164: SECOND_ON_CALL,
      origin: 'admin',
      created_at: new Date()
    });

    await scan({ now: now() });
    assert.equal((await outbox()).length, 1, 'an alert is the provider initiating contact');
    await getDb()('wa_opt_outs').del();
  });
});

describe('the scan interval survives a restart', () => {
  it('does not sweep the fleet again on the first tick after the process forgets', async () => {
    // An hour between passes, which is what the operator asking for an hour
    // means. Held only in memory, every restart reset it to "never scanned" and
    // the first tick swept the whole fleet regardless — and a panel restarts
    // for a deploy, a crash loop or a container rescheduled, none of which is
    // the operator changing their mind.
    await setRules(onlyRule('ont_offline', { threshold: 30 }), { intervalSeconds: 3600 });
    fleet = [device('dev-reinicio', { _lastInform: informedMinutesAgo(90) })];

    try {
      const primeiro = await asTenant(() => WaAlertService.tickForTenant());
      assert.equal(primeiro.fired, 1, 'the first tick is due and scans');
      const stamp = await getDb()('app_state').where({ key: LAST_SCAN_KEY }).first();
      assert.ok(stamp, 'and it records when, where a restart cannot reach');

      // What a restart looks like from in here: the class is new, the table is not.
      WaAlertService.lastScanAt.clear();
      const segundo = await asTenant(() => WaAlertService.tickForTenant());
      assert.equal(segundo.skipped, 'not_due', 'the hour is still the hour');
    } finally {
      await getDb()('app_state').where({ key: LAST_SCAN_KEY }).del();
      WaAlertService.lastScanAt.clear();
    }
  });
});

describe('a WhatsApp number that drops tells the team', () => {
  let atendimentoId;

  before(async () => {
    const account = await asTenant(() => WhatsAppAccount.create({
      name: 'painel-atendimento',
      label: 'Atendimento',
      purpose: 'general',
      flavor: 'v2',
      base_url: 'https://evo.provedor.test',
      status: 'connected',
      phone_e164: '5593981119999',
      ...WhatsAppConfigService.encryptInstanceToken('token-atendimento'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-atendimento')
    }));
    atendimentoId = account.id;
  });

  const setStatus = (status) => getDb()('whatsapp_accounts').where({ id: atendimentoId }).update({ status });

  after(async () => {
    await getDb()('whatsapp_accounts').where({ id: atendimentoId }).del();
  });

  it('warns once the grace has passed, even with GenieACS unreadable, and says when it is back', async () => {
    await setStatus('disconnected');
    await setRules(onlyRule('wa_disconnected', { threshold: 5 }));

    // Dentro da carência: a condição abre calada.
    const first = await scan({ now: now() });
    assert.equal(first.skipped, 'no_devices', 'a frota vazia continua sendo dita');
    assert.equal((await alertRows()).length, 1);
    assert.equal((await outbox()).length, 0);

    const second = await scan({ now: now() + 6 * MINUTE });
    assert.equal(second.notified, 1);
    const [sent] = await outbox();
    assert.match(sent.body, /Atendimento \(\+5593981119999\)/);
    assert.match(sent.body, /Configurações › WhatsApp/);

    // Não repete antes do intervalo.
    await scan({ now: now() + 10 * MINUTE });
    assert.equal((await outbox()).length, 1);

    await setStatus('connected');
    const back = await scan({ now: now() + 12 * MINUTE });
    assert.equal(back.cleared, 1);
    const messages = await outbox();
    assert.equal(messages.length, 2);
    assert.match(messages[1].body, /reconectado/);
    assert.equal((await alertRows()).length, 0);
  });

  it('a drop that heals inside the grace never says anything', async () => {
    await setStatus('disconnected');
    await setRules(onlyRule('wa_disconnected', { threshold: 5 }));
    await scan({ now: now() });
    await setStatus('connected');
    const summary = await scan({ now: now() + MINUTE });
    assert.equal(summary.cleared, 1);
    assert.equal((await outbox()).length, 0);
  });

  it('a number still pairing is not a drop', async () => {
    await setStatus('connecting');
    await setRules(onlyRule('wa_disconnected', { threshold: 0 }));
    await scan({ now: now() });
    assert.equal((await alertRows()).length, 0);
    await setStatus('connected');
  });

  it('does not touch the fleet alerts while GenieACS is unreadable', async () => {
    await setStatus('connected');
    const { default: WaAlertState } = await import('../src/models/WaAlertState.js');
    await asTenant(async () => {
      const row = await WaAlertState.open({ rule: 'ont_offline', subject: 'ONT-QUIETA' });
      await WaAlertState.markNotified(row.id, new Date());
    });
    const before = (await alertRows()).filter((row) => row.rule === 'ont_offline').length;
    await setRules(onlyRule('wa_disconnected', { threshold: 0 }));
    await scan({ now: now() });
    assert.equal((await alertRows()).filter((row) => row.rule === 'ont_offline').length, before);
  });
});

const { tinsert } = await import('../src/config/database.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');

describe('a customer waiting for a person tells the team', () => {
  let conversaId;

  // O instante vai com os milissegundos zerados: o DATETIME do MySQL ARREDONDA a
  // fração de segundo (,500 ou mais sobe 1 s), e "25 min atrás" virava 24 min 59 s
  // na leitura — a asserção de minutos falhava só no MySQL, de vez em quando.
  // Truncar para baixo deixa a espera pelo menos do tamanho pedido em todo banco.
  const msg = (direction, minutosAtras, extra = {}) => {
    const quando = new Date(Math.floor((Date.now() - minutosAtras * MINUTE) / 1000) * 1000);
    return asTenant(() => tinsert('wa_messages', {
      conversation_id: conversaId,
      direction,
      body: direction === 'in' ? 'alguém?' : 'oi, já vejo',
      source: 'operator',
      delivery_status: direction === 'in' ? null : 'sent',
      created_at: quando,
      updated_at: quando,
      ...extra
    }));
  };

  before(async () => {
    const c = await asTenant(() => WaConversation.ensure({
      accountId: alertsAccountId,
      externalThreadId: '5593981169999@s.whatsapp.net',
      waPhone: '5593981169999',
      waLid: null,
      pushName: 'Dona Maria'
    }));
    conversaId = c.id;
    await getDb()('wa_conversations').where({ id: conversaId }).update({ last_inbound_at: new Date(Date.now() - 20 * MINUTE) });
  });

  it('avisa uma vez quando passa do limite, e respondida sai calada', async () => {
    await msg('in', 20, { external_id: 'ESPERA-IN-1' });
    await setRules(onlyRule('wa_waiting', { threshold: 15 }));

    const primeira = await scan({ now: now() });
    assert.equal(primeira.notified, 1);
    const enviados = (await outbox()).filter((m) => /esperando resposta/.test(m.body));
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].body, /Dona Maria/);
    assert.match(enviados[0].body, /sem atendente/);

    await scan({ now: now() + 5 * MINUTE });
    assert.equal((await outbox()).filter((m) => /esperando resposta/.test(m.body)).length, 1, 'não repete antes do intervalo');

    // A equipe respondeu pelo celular (eco com id do servidor).
    await msg('out', 1, { external_id: 'ESPERA-OUT-1' });
    const depois = await scan({ now: now() + 10 * MINUTE });
    assert.equal(depois.cleared, 1);
    assert.equal((await outbox()).filter((m) => /esperando resposta/.test(m.body)).length, 1, 'respondida não vira mensagem');
  });

  it('fora do horário de atendimento, nada dispara', async () => {
    await msg('in', 30, { external_id: 'ESPERA-IN-2' });
    await asTenant(() => WaBotConfigService.saveConfig({
      hours: { enabled: true, week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true })) }
    }));
    try {
      await setRules(onlyRule('wa_waiting', { threshold: 15 }));
      const r = await scan({ now: now() });
      assert.equal(r.fired, 0);
      assert.equal((await alertRows()).filter((row) => row.rule === 'wa_waiting').length, 0);
    } finally {
      await asTenant(() => WaBotConfigService.saveConfig({ hours: { enabled: false } }));
    }
  });

  it('a rota da caixa de entrada lista quem espera', async () => {
    // 26 e não 25: o TIMESTAMP do MySQL não guarda milissegundos e arredonda o
    // instante gravado, então "há 25 minutos" pode voltar como 24 e meio.
    await msg('in', 26, { external_id: 'ESPERA-IN-3' });
    await setRules(onlyRule('wa_waiting', { threshold: 15 }));
    const { status, body } = await call(`${panelUrl}/api/whatsapp/waiting`, { headers: authHeaders(token) });
    assert.equal(status, 200);
    assert.equal(body.data.thresholdMinutes, 15);
    assert.equal(body.data.withinHours, true);
    const item = body.data.items.find((i) => i.conversationId === conversaId);
    assert.ok(item && item.minutes >= 25, JSON.stringify(body.data));
    assert.equal(item.contact, 'Dona Maria');
  });
});
