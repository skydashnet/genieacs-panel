import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { buildDevice, startGenieAcsStub, writtenParameters } from './helpers/genieacs-stub.js';

// The provisioning models read inside a provider's scope since `0023`, and the
// stored Wi-Fi credential since `0027`, so the direct model and service calls
// below are wrapped in `asTenant` — the same scope a request would have
// resolved. Raw `getDb()` reads stay unwrapped on purpose: they are asserting
// what the database holds, provider column and all.
const { default: ProvisioningRun } = await import('../src/models/ProvisioningRun.js');
const { default: ProvisioningService } = await import('../src/services/provisioningService.js');
const { default: CustomerWifiCredentialService } = await import(
  '../src/services/customerWifiCredentialService.js'
);

const DEVICE_ID = 'stub-device-1';
const PPPOE = 'joao@provedor';
// The SGP stub returns this as the contract's PPPoE password. No response body
// anywhere in the panel may contain it.
const PPPOE_PASSWORD = 'segredo-pppoe-do-contrato';
// The CPE administrative credential a profile applies. It lives on a virtual
// parameter whose name does not contain "password", which is exactly why it
// has to be covered by a test.
const CPE_PASSWORD = 'senha-admin-do-provedor';
const APP = 'painel';
const TOKEN = 'token-secreto-123';

let panelUrl;
let token;
let sgpUrl;
let sgpServer;
let genie;

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
        // An install that answers "no results" rather than rejecting the query.
        if (payload.login === 'sem-contrato@provedor') return send({ status: 1, contratos: [] });
        if (payload.login !== PPPOE && String(payload.contrato) !== '4321') {
          return send({ status: 0, msg: 'Cliente não encontrado' });
        }
        return send({
          status: 1,
          contratos: [{
            contrato: 4321,
            contratoStatus: 1,
            contratoStatusDisplay: 'Ativo',
            planoInternet: 'Fibra 500MB',
            razaoSocial: 'João da Silva',
            cpfcnpj: '12345678909',
            login: PPPOE,
            // A spelling the normalizer has to reach through `pick`.
            senha_pppoe: PPPOE_PASSWORD,
            bloqueado: false
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

async function createProfile(overrides = {}) {
  const { status, body } = await call(`${panelUrl}/api/provisioning/profiles`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      name: 'Fibra',
      planPatterns: ['fibra'],
      priority: 20,
      enabled: true,
      applyWan: true,
      applyPppoePassword: true,
      wanVlanId: 100,
      wanServiceList: 'INTERNET',
      applyWifi: true,
      wifiIndexes: [1],
      wifiSsidTemplate: 'Provedor-{contract}',
      wifiPasswordMode: 'random',
      applyCredentials: true,
      credentialTargets: 'super',
      cpePassword: CPE_PASSWORD,
      ...overrides
    }
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body.data.profile;
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
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await genie.close();
  await stopTestServers();
});

describe('provisioning profiles', () => {
  it('requires an administrator', async () => {
    const { status } = await call(`${panelUrl}/api/provisioning/profiles`);
    assert.equal(status, 401);
  });

  it('rejects a second profile with the same name', async () => {
    await createProfile({ name: 'Duplicada' });
    const { status } = await call(`${panelUrl}/api/provisioning/profiles`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { name: 'Duplicada', planPatterns: [] }
    });
    assert.equal(status, 409);
  });

  it('never returns a stored profile secret', async () => {
    const profile = await createProfile({ name: 'Segredos', cpePassword: 'senha-admin' });
    assert.equal(profile.cpePasswordConfigured, true);
    assert.ok(!JSON.stringify(profile).includes('senha-admin'));
  });

  it('matches a profile by plan name and falls back to the default', async () => {
    await getDb()('provisioning_profiles').del();
    ProvisioningService.configCache.clear();
    await createProfile({ name: 'Fibra 500', planPatterns: ['fibra 500'], priority: 30 });
    await createProfile({ name: 'Padrão', planPatterns: [], isDefault: true, priority: 1 });

    assert.equal((await asTenant(() => ProvisioningService.matchProfile('Fibra 500MB'))).name, 'Fibra 500');
    assert.equal((await asTenant(() => ProvisioningService.matchProfile('Rádio 10MB'))).name, 'Padrão');
  });

  it('refuses to enable the poller without an enabled profile', async () => {
    await getDb()('provisioning_profiles').update({ enabled: false });
    const { status } = await call(`${panelUrl}/api/provisioning/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true }
    });
    assert.equal(status, 400);
    await getDb()('provisioning_profiles').update({ enabled: true });
  });

  it('rejects a marker tag GenieACS would refuse', async () => {
    const { status } = await call(`${panelUrl}/api/provisioning/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { markerTag: 'não-válida' }
    });
    assert.equal(status, 400);
  });
});

describe('provisioning preview', () => {
  before(async () => {
    await getDb()('provisioning_profiles').del();
    await createProfile();
  });

  it('plans every step without writing to the ONT', async () => {
    genie.state.tasks.length = 0;
    const { status, body } = await call(
      `${panelUrl}/api/provisioning/devices/${DEVICE_ID}/preview`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.profile.name, 'Fibra');
    assert.equal(body.data.contract.contract, '4321');
    assert.equal(body.data.pppoePasswordFound, true);
    assert.ok(body.data.steps.length >= 3);
    assert.equal(genie.state.tasks.length, 0);
  });

  it('masks the secrets it planned and never returns the PPPoE password', async () => {
    const { body } = await call(
      `${panelUrl}/api/provisioning/devices/${DEVICE_ID}/preview`,
      { method: 'POST', headers: authHeaders(token) }
    );
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(PPPOE_PASSWORD));
    assert.ok(serialized.includes('••••'));
  });
});

describe('provisioning run', () => {
  before(async () => {
    await getDb()('provisioning_profiles').del();
    await getDb()('provisioning_runs').del();
    await createProfile();
  });

  it('writes Wi-Fi and credentials before WAN', async () => {
    genie.state.tasks.length = 0;
    genie.state.tags.length = 0;
    const { status, body } = await call(
      `${panelUrl}/api/provisioning/devices/${DEVICE_ID}/provision`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(status, 200, JSON.stringify(body));

    const paths = writtenParameters(genie.state).map(([path]) => path);
    const wifiAt = paths.findIndex((path) => path.includes('WLANConfiguration'));
    const wanAt = paths.findIndex((path) => path.includes('WANPPPConnection'));
    assert.ok(wifiAt >= 0 && wanAt >= 0);
    assert.ok(wifiAt < wanAt, 'Wi-Fi must be written before the WAN bounce');
  });

  it('sends the contract PPPoE password to the ONT but returns it to nobody', async () => {
    const written = writtenParameters(genie.state);
    const password = written.find(([path]) => path.endsWith('WANPPPConnection.1.Password'));
    assert.ok(password, 'the PPPoE password must reach the CPE');
    assert.equal(password[1], PPPOE_PASSWORD);

    const { body } = await call(`${panelUrl}/api/provisioning/runs`, { headers: authHeaders(token) });
    assert.ok(!JSON.stringify(body).includes(PPPOE_PASSWORD));

    const rows = await getDb()('provisioning_runs').select('steps', 'error');
    assert.ok(!JSON.stringify(rows).includes(PPPOE_PASSWORD));
  });

  it('keeps the CPE admin credential out of the stored run and the API', async () => {
    const written = writtenParameters(genie.state);
    assert.ok(
      written.some(([path, value]) => path.endsWith('LoginSuperPass') && value === CPE_PASSWORD),
      'the admin credential must reach the CPE'
    );
    const rows = await getDb()('provisioning_runs').select('steps', 'error');
    assert.ok(!JSON.stringify(rows).includes(CPE_PASSWORD));

    const { body } = await call(`${panelUrl}/api/provisioning/runs`, { headers: authHeaders(token) });
    assert.ok(!JSON.stringify(body).includes(CPE_PASSWORD));
  });

  it('links the contract and stores the generated Wi-Fi password', async () => {
    const link = await getDb()('sgp_links').where({ device_id: DEVICE_ID }).first();
    assert.equal(link.contract, '4321');
    assert.equal(link.state, 'active');

    const account = await getDb()('customer_accounts').where({ device_id: DEVICE_ID }).first();
    assert.ok(account, 'the run creates the portal account');
    const revealed = await asTenant(() => CustomerWifiCredentialService.reveal(account.id, 1));
    assert.ok(revealed && revealed.length >= 8);
  });

  it('waits for verification instead of reporting success straight away', async () => {
    const run = await asTenant(() => ProvisioningRun.getLatestByDeviceId(DEVICE_ID));
    assert.equal(run.status, 'awaiting_verify');
    assert.ok(run.next_attempt_at, 'the verification deadline lives in the row, not in a timer');
  });

  it('confirms the run once the ONT reports the written values', async () => {
    // The stub device now answers with what provisioning wrote.
    const written = writtenParameters(genie.state);
    const ssid = written.find(([path]) => path.endsWith('WLANConfiguration.1.SSID'))?.[1];
    const device = genie.state.devices[0];
    device.InternetGatewayDevice.LANDevice[1].WLANConfiguration[1].SSID._value = ssid;
    device.InternetGatewayDevice.WANDevice[1].WANConnectionDevice[1]
      .WANPPPConnection[1]['X_ZTE-COM_VLANID']._value = 100;

    const run = await asTenant(() => ProvisioningRun.getLatestByDeviceId(DEVICE_ID));
    const verified = await asTenant(() => ProvisioningService.verifyRun(run));
    assert.equal(verified.status, 'success', JSON.stringify(verified.steps));
    assert.ok(genie.state.tags.some((entry) => entry.tag === 'SkyGenProvisioned' && entry.method === 'POST'));
  });

  it('skips a device whose login matches no contract', async () => {
    genie.state.devices.push(buildDevice({
      id: 'stub-device-2', pppoeUsername: 'sem-contrato@provedor'
    }));
    const { body } = await call(
      `${panelUrl}/api/provisioning/devices/stub-device-2/provision`,
      { method: 'POST', headers: authHeaders(token) }
    );
    assert.equal(body.data.run.status, 'skipped');
    assert.equal(body.data.run.error, 'provisioning.skip.no_contract');
  });

  it('retries with a backoff when SGP rejects the lookup, then gives up', async () => {
    genie.state.devices.push(buildDevice({
      id: 'stub-device-4', pppoeUsername: 'desconhecido@provedor'
    }));
    const { body } = await call(
      `${panelUrl}/api/provisioning/devices/stub-device-4/provision`,
      { method: 'POST', headers: authHeaders(token) }
    );
    // A rejected query may be a transient SGP problem, so it is retried rather
    // than skipped -- but on a schedule that ends.
    assert.equal(body.data.run.status, 'pending');
    assert.ok(body.data.run.nextAttemptAt);

    let run = await asTenant(() => ProvisioningRun.getById(body.data.run.id));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      run = await asTenant(() => ProvisioningService.executeRun(run));
    }
    assert.equal(run.status, 'failed_permanent');
    assert.equal(run.attempt_count, 5);
  });
});

describe('provisioning poller', () => {
  it('does not touch GenieACS while it is disabled', async () => {
    const { default: SchedulerService } = await import('../src/services/schedulerService.js');
    genie.state.tasks.length = 0;
    const summary = await asTenant(() => SchedulerService.runJobs());
    assert.equal(summary.provisioning, null);
    assert.equal(genie.state.tasks.length, 0);
  });

  it('leaves an already provisioned device alone', async () => {
    const candidates = await asTenant(() => ProvisioningService.findCandidates({ limit: 10 }));
    assert.ok(!candidates.includes(DEVICE_ID), 'a successful run settles the device');
  });

  it('fails a run that was interrupted mid-flight', async () => {
    const run = await asTenant(() => ProvisioningRun.create({
      device_id: 'stub-device-3', trigger: 'poller', status: 'running'
    }));
    await getDb()('provisioning_runs')
      .where({ id: run.id })
      .update({ updated_at: new Date(Date.now() - 3600_000) });
    await asTenant(() => ProvisioningService.reapInterrupted());
    assert.equal((await asTenant(() => ProvisioningRun.getById(run.id))).status, 'failed');
  });
});
