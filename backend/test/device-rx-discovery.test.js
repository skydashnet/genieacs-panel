import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');

const param = (value) => ({ _value: value, _writable: false });

/**
 * An ONT whose vendor put the optical reading under an object name no
 * catalogue has ever listed — the case the panel cannot fix by guessing.
 */
const VENDOR_RX_PATH = 'InternetGatewayDevice.WANDevice.1.X_TAV-COM_PonOptical.RXPower';

function ont(index) {
  return {
    _id: `ONT-${index}`,
    _deviceId: {
      _SerialNumber: `SN000${index}`,
      _ProductClass: 'G-1425G-B',
      _Manufacturer: 'alcl'
    },
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: param('3FE49362IJKJ21') },
      WANDevice: {
        1: {
          'X_TAV-COM_PonOptical': {
            RXPower: param('-2417'),
            TXPower: param('215'),
            RXPowerThreshold: param('-2800')
          },
          WANConnectionDevice: {
            1: { WANPPPConnection: { 1: { Username: param(`subscriber-${index}`) } } }
          }
        }
      }
    },
    _lastInform: new Date().toISOString(),
    _registered: new Date().toISOString()
  };
}

function getPath(source, path) {
  let current = source;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part]) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

/**
 * What the NBI actually does with `projection`: a document comes back holding
 * the named subtrees and nothing else. Without this the stub would hand the
 * panel parameters it never asked for, and a test could not tell a lookup
 * that works from one that only works against a generous stub.
 */
function project(document, projection) {
  if (!projection) return document;
  const result = {};
  for (const path of projection.split(',').filter(Boolean)) {
    const value = getPath(document, path);
    if (value !== undefined) setPath(result, path, value);
  }
  return result;
}

const genieAcs = { server: null, fleet: [], projections: [] };

function startGenieAcsStub() {
  return new Promise((resolve) => {
    genieAcs.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith('/devices')) {
        res.writeHead(404).end('[]');
        return;
      }
      const projection = url.searchParams.get('projection');
      genieAcs.projections.push(projection || '');
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      let rows = genieAcs.fleet;
      if (Number.isFinite(limit)) rows = rows.slice(0, limit);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        total: String(genieAcs.fleet.length)
      }).end(JSON.stringify(rows.map((device) => project(device, projection))));
    });
    genieAcs.server.listen(0, '127.0.0.1', () => resolve());
  });
}

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  await startGenieAcsStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert(
    'genieAcsUrl',
    `http://127.0.0.1:${genieAcs.server.address().port}`
  ));
});

after(async () => {
  await new Promise((resolve) => genieAcs.server.close(resolve));
  await stopTestServers();
});

async function listDevices() {
  genieAcs.projections.length = 0;
  const { status, body } = await call(`${panelUrl}/api/devices`, { headers: authHeaders(token) });
  assert.equal(status, 200);
  return body.data.devices;
}

describe('an optical path no catalogue lists', () => {
  it('is discovered on the first listing and read on that same listing', async () => {
    genieAcs.fleet = [ont(1), ont(2)];
    const devices = await listDevices();

    assert.equal(devices.length, 2);
    for (const device of devices) assert.equal(device.rxpower, -24.17);

    // The probe is what made it possible: it projects whole WAN subtrees,
    // which no other request in the listing does.
    assert.ok(
      genieAcs.projections.some((projection) =>
        projection.split(',').includes('InternetGatewayDevice.WANDevice')
      ),
      'the listing probed for the fleet optical path'
    );
  });

  it('is asked for by name afterwards, without probing again', async () => {
    genieAcs.fleet = [ont(3)];
    const [device] = await listDevices();

    assert.equal(device.rxpower, -24.17);
    assert.ok(
      genieAcs.projections.at(-1).split(',').includes(VENDOR_RX_PATH),
      'the learned path is named in the listing projection'
    );
    assert.ok(
      !genieAcs.projections.some((projection) =>
        projection.split(',').includes('InternetGatewayDevice.WANDevice')
      ),
      'a path already learned is not probed for again'
    );
  });

  it('learns both vendors of a mixed fleet, not just the first', async () => {
    await asTenant(() => getDb()('app_state').where({ key: 'rx_power_path' }).del());
    const other = ont(7);
    other.InternetGatewayDevice.WANDevice[1] = {
      'X_OTHER_GponInterfaceConfig': { RXPower: param('-1902') },
      WANConnectionDevice: { 1: { WANPPPConnection: { 1: { Username: param('subscriber-7') } } } }
    };
    genieAcs.fleet = [ont(6), other];

    const devices = await listDevices();
    const readings = devices.map((device) => device.rxpower).sort((a, b) => a - b);
    assert.deepEqual(readings, [-24.17, -19.02]);

    // Both are named by the next listing, so neither vendor needs the probe.
    genieAcs.fleet = [ont(8)];
    await listDevices();
    const projection = genieAcs.projections.at(-1).split(',');
    assert.ok(projection.includes(VENDOR_RX_PATH));
    assert.ok(projection.includes('InternetGatewayDevice.WANDevice.1.X_OTHER_GponInterfaceConfig.RXPower'));
  });

  it('gives up quietly on a fleet that reports no optical at all', async () => {
    await asTenant(() => getDb()('app_state').where({ key: 'rx_power_path' }).del());
    genieAcs.fleet = [{ ...ont(9), InternetGatewayDevice: { DeviceInfo: { SoftwareVersion: param('v1') } } }];

    const [first] = await listDevices();
    assert.equal(first.rxpower, null);
    assert.ok(
      genieAcs.projections.some((projection) =>
        projection.split(',').includes('InternetGatewayDevice.WANDevice')
      ),
      'the first listing probed'
    );

    // A fleet with nothing to find must not be re-probed on every page view.
    await listDevices();
    assert.ok(
      !genieAcs.projections.some((projection) =>
        projection.split(',').includes('InternetGatewayDevice.WANDevice')
      ),
      'a fruitless probe is remembered'
    );
  });

  /**
   * O painel contava `Unknown` onde a lista mostrava o valor.
   *
   * A frota deste arquivo é a que expõe o defeito: o RX está num caminho que
   * catálogo nenhum lista, então só é legível por quem o APRENDEU. A lista
   * projeta o aprendido; o painel não projetava — e o que não é projetado não
   * volta. As duas telas liam a mesma frota e respondiam coisas diferentes, e
   * o painel errava para baixo: escondia risco óptico.
   *
   * Agora o número e a lista que ele abre têm que dar o mesmo, que é o que
   * torna o link honesto.
   */
  it('is counted by the dashboard too, and the slice agrees with the number', async () => {
    await asTenant(() => getDb()('app_state').where({ key: 'rx_power_path' }).del());
    const arriscado = ont(11);
    arriscado.InternetGatewayDevice.WANDevice[1]['X_TAV-COM_PonOptical'].RXPower = param('-2650');
    genieAcs.fleet = [arriscado];

    const [device] = await listDevices();
    assert.equal(device.rxpower, -26.5, 'a lista lê o caminho aprendido');

    const painel = await call(`${panelUrl}/api/devices/dashboard?refresh=1`, {
      headers: authHeaders(token)
    });
    assert.equal(painel.status, 200);
    assert.equal(painel.body.data.rxDistribution.Poor, 1);
    assert.equal(painel.body.data.rxDistribution.Unknown, 0, 'o painel não pode dizer que não sabe');

    const recorte = await call(`${panelUrl}/api/devices?focus=weak-signal`, {
      headers: authHeaders(token)
    });
    assert.equal(recorte.body.data.total, 1);
    assert.deepEqual(recorte.body.data.devices.map((row) => row._id), ['ONT-11']);
  });

  it('never mistakes a threshold or the transmit power for the signal', async () => {
    await asTenant(() => getDb()('app_state').where({ key: 'rx_power_path' }).del());
    genieAcs.fleet = [ont(4)];
    const [device] = await listDevices();

    // -28.00 is the alarm threshold and 21.5 the transmit power; both sit in
    // the same object as the reading and neither is what a technician reads.
    assert.equal(device.rxpower, -24.17);
  });
});
