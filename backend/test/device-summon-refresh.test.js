import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');

const param = (value) => ({ _value: value, _writable: false });

/**
 * The fleet this whole thread is about: GenieACS holds no optical parameter
 * for these ONTs, because its provision script was never told to fetch one.
 * `optical` is what the device would report once asked to — the stub only
 * puts it in the document after a refresh task names the object.
 */
const genieAcs = {
  server: null,
  tasks: [],
  refusedObjects: new Set(),
  /** An ONT behind CGNAT: GenieACS cannot call it back and only queues. */
  unreachable: false,
  /** When the TR-098 ONT last informed; now, unless a test says otherwise. */
  lastInform: null,
  optical: null,
  /** TR-181 ONTs answer on `Device.` and have no `InternetGatewayDevice`. */
  dataModel: 'InternetGatewayDevice'
};

function ont() {
  if (genieAcs.dataModel === 'Device') {
    return {
      _id: 'ONT-1',
      _deviceId: { _SerialNumber: 'SN0001', _ProductClass: 'XS-2426G', _Manufacturer: 'alcl' },
      Device: {
        DeviceInfo: { SoftwareVersion: param('3FE49362IJKJ21') },
        PPP: { Interface: { 1: { Username: param('subscriber-1') } } }
      },
      _lastInform: new Date().toISOString(),
      _registered: new Date().toISOString()
    };
  }
  const device = {
    _id: 'ONT-1',
    _deviceId: { _SerialNumber: 'SN0001', _ProductClass: 'G-1425G-B', _Manufacturer: 'alcl' },
    InternetGatewayDevice: {
      DeviceInfo: { SoftwareVersion: param('3FE49362IJKJ21') },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: { WANPPPConnection: { 1: { Username: param('subscriber-1') } } }
          }
        }
      }
    },
    _lastInform: genieAcs.lastInform || new Date().toISOString(),
    _registered: new Date().toISOString()
  };
  if (genieAcs.optical) {
    device.InternetGatewayDevice.WANDevice[1][genieAcs.optical.object] = {
      RXPower: param(genieAcs.optical.value)
    };
  }
  return device;
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

/** The NBI hands back only the subtrees a projection names. */
function project(document, projection) {
  if (!projection) return document;
  const result = {};
  for (const path of projection.split(',').filter(Boolean)) {
    const value = getPath(document, path);
    if (value !== undefined) setPath(result, path, value);
  }
  return result;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
  });
}

function startGenieAcsStub() {
  return new Promise((resolve) => {
    genieAcs.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname.endsWith('/tasks')) {
        const task = await readBody(req);
        genieAcs.tasks.push({ ...task, connectionRequest: url.searchParams.has('connection_request') });
        if (genieAcs.unreachable && url.searchParams.has('connection_request')) {
          res.writeHead(202, 'Device is offline', { 'Content-Type': 'application/json' })
            .end(JSON.stringify(task));
          return;
        }
        if (task?.name === 'refreshObject' && genieAcs.refusedObjects.has(task.objectName)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ fault: { faultString: 'Invalid parameter name' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }

      if (!url.pathname.startsWith('/devices')) {
        res.writeHead(404).end('[]');
        return;
      }
      const projection = url.searchParams.get('projection');
      res.writeHead(200, { 'Content-Type': 'application/json', total: '1' })
        .end(JSON.stringify([project(ont(), projection)]));
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

beforeEach(async () => {
  genieAcs.tasks = [];
  genieAcs.refusedObjects = new Set();
  genieAcs.unreachable = false;
  genieAcs.lastInform = null;
  genieAcs.optical = null;
  genieAcs.dataModel = 'InternetGatewayDevice';
  await asTenant(() => getDb()('app_state').where({ key: 'rx_power_path' }).del());
});

const summon = () => call(`${panelUrl}/api/devices/summon`, {
  method: 'POST',
  headers: authHeaders(token),
  body: { deviceId: 'ONT-1' }
});

const listDevices = () => call(`${panelUrl}/api/devices`, { headers: authHeaders(token) });

const TR098_OBJECTS = [
  'InternetGatewayDevice.WANDevice',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration',
  'InternetGatewayDevice.DeviceInfo.TemperatureStatus',
  // The fixture is a Nokia (alcl) with no optics object in its document yet.
  'InternetGatewayDevice.X_ALU_OntOpticalParam'
];

describe('summoning a device', () => {
  it('asks the ONT to re-report the object its optical reading lives under', async () => {
    const { status, body } = await summon();
    assert.equal(status, 200);

    const refreshed = genieAcs.tasks
      .filter((task) => task.name === 'refreshObject')
      .map((task) => task.objectName);
    assert.deepEqual(refreshed, TR098_OBJECTS);
    assert.deepEqual(body.data.refreshed, TR098_OBJECTS);
  });

  it('asks the ONT to re-report its WiFi networks, so their on/off state is known', async () => {
    await summon();
    assert.ok(
      genieAcs.tasks.some((task) =>
        task.name === 'refreshObject' &&
        task.objectName === 'InternetGatewayDevice.LANDevice.1.WLANConfiguration'),
      'the summon refreshes WLANConfiguration'
    );
  });

  it('never posts a TR-181 refresh to a TR-098 ONT', async () => {
    await summon();
    // A task the device was always going to refuse leaves a fault behind, and
    // in GenieACS a fault is in the way of everything queued after it.
    assert.ok(
      !genieAcs.tasks.some((task) => String(task.objectName).startsWith('Device.')),
      'the summon asked only for objects this ONT could have'
    );
  });

  it('asks a TR-181 ONT for its own optical object instead', async () => {
    genieAcs.dataModel = 'Device';
    const { body } = await summon();
    assert.deepEqual(body.data.refreshed, ['Device.Optical', 'Device.DeviceInfo.TemperatureStatus']);
  });

  it('still requests the inform it always did', async () => {
    await summon();
    const read = genieAcs.tasks.find((task) => task.name === 'getParameterValues');
    assert.ok(read, 'the summon still asks for a parameter');
    assert.ok(read.parameterNames.includes('InternetGatewayDevice.DeviceInfo.SerialNumber'));
  });

  it('asks the ONT for its PPPoE login by name, after the inform', async () => {
    // A ZTE F-series faults on refreshing the whole WAN tree and its login
    // stays unread; without the login the SGP contract never links.
    await summon();
    const reads = genieAcs.tasks.filter((task) => task.name === 'getParameterValues');
    assert.equal(reads.length, 2);
    assert.deepEqual(reads[1].parameterNames, [
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
    ]);
  });

  it('survives an ONT that carries the root but refuses the object', async () => {
    genieAcs.refusedObjects = new Set(TR098_OBJECTS);

    const { status, body } = await summon();
    assert.equal(status, 200);
    assert.deepEqual(body.data.refreshed, []);
  });
});

describe('the reading a summon was asked for', () => {
  it('is not hidden by a probe that ran before the ONT informed', async () => {
    // A listing before the summon records that this fleet reports no optical.
    await listDevices();
    const before = await listDevices();
    assert.equal(before.body.data.devices[0].rxpower, null);

    await summon();

    // The ONT informs; the refreshed object is in the document now. The
    // half-hour cooldown from that first probe must not sit on this.
    genieAcs.optical = { object: 'X_TAV-COM_PonOptical', value: '-2417' };
    const after = await listDevices();
    assert.equal(after.body.data.devices[0].rxpower, -24.17);
  });

  it('keeps looking across listings while the ONT has still not informed', async () => {
    await listDevices();
    await summon();
    await listDevices();
    await listDevices();

    genieAcs.optical = { object: 'X_TAV-COM_PonOptical', value: '-1902' };
    const { body } = await listDevices();
    assert.equal(body.data.devices[0].rxpower, -19.02);
  });
});

describe('summoning an ONT GenieACS cannot reach', () => {
  it('says the request waits for the next Inform instead of reporting success', async () => {
    genieAcs.unreachable = true;
    const { status, body } = await summon();

    assert.equal(status, 200);
    assert.equal(body.data.reached, false);
    assert.equal(body.data.reason, 'Device is offline');
    assert.match(body.message, /Device is offline/);
    assert.match(body.message, /Inform/);
    assert.equal(body.data.stale, false, 'informed moments ago');
    assert.ok(body.data.lastInform);
  });

  it('says when an ONT silent for days last informed', async () => {
    genieAcs.unreachable = true;
    genieAcs.lastInform = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
    const { body } = await summon();

    assert.equal(body.data.reached, false);
    assert.equal(body.data.stale, true);
    assert.equal(body.data.lastInform, genieAcs.lastInform);
  });

  it('asks GenieACS to call the ONT once, and only queues the rest', async () => {
    genieAcs.unreachable = true;
    await summon();

    const called = genieAcs.tasks.filter((task) => task.connectionRequest);
    assert.equal(called.length, 1, 'one connection request, not one per task');
    assert.equal(called[0].name, 'getParameterValues');
    assert.ok(
      genieAcs.tasks.some((task) => task.name === 'refreshObject' && !task.connectionRequest),
      'the refreshes are still queued for the next Inform'
    );
  });

  it('reports success when the ONT answers', async () => {
    const { body } = await summon();
    assert.equal(body.data.reached, true);
    assert.equal(body.data.reason, null);
    assert.equal(body.data.stale, undefined, 'a reached ONT needs no silence read');
  });
});
