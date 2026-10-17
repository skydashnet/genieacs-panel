import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

/**
 * A Nokia G-0425G-C as GenieACS holds it: the optics live in
 * `X_ALU_OntOpticalParam` at the root of the tree, not under WANDevice, and
 * the `TemperatureStatus` sensor reads -274 — TR-098's "no reading". Until
 * someone asks for the leaves by name, GenieACS knows them only by name.
 */
const genieAcs = {
  server: null,
  tasks: [],
  /** 'read' — values present; 'names' — leaves known, never read; 'absent' — no object. */
  optics: 'read',
  manufacturer: 'ALCL'
};

const param = (value) => ({ _value: value, _writable: false });
const unread = () => ({ _writable: false, _object: false });

function ont() {
  const device = {
    _id: 'ALCL-G0425GC-1',
    _deviceId: { _SerialNumber: 'ALCLFCD64769', _ProductClass: 'G-0425G-C', _Manufacturer: genieAcs.manufacturer },
    InternetGatewayDevice: {
      DeviceInfo: {
        SoftwareVersion: param('3FE49362IJKJ21'),
        TemperatureStatus: { TemperatureSensor: { 1: { Value: param(-274) } } }
      },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: { WANPPPConnection: { 1: { Username: param('ta100.565') } } }
          }
        }
      }
    },
    _lastInform: new Date().toISOString(),
    _registered: new Date().toISOString()
  };
  if (genieAcs.optics === 'read') {
    device.InternetGatewayDevice.X_ALU_OntOpticalParam = {
      RXPower: param('-19.87'),
      TXPower: param('2.31'),
      Temperature: param('45'),
      TemperatureThreshold: param('90')
    };
  } else if (genieAcs.optics === 'names') {
    device.InternetGatewayDevice.X_ALU_OntOpticalParam = {
      RXPower: unread(),
      TXPower: unread(),
      Temperature: unread()
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

function project(document, projection) {
  if (!projection) return document;
  const result = {};
  for (const path of projection.split(',').filter(Boolean)) {
    const value = getPath(document, path);
    if (value !== undefined) setPath(result, path, value);
  }
  return result;
}

function startGenieAcsStub() {
  return new Promise((resolve) => {
    genieAcs.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname.endsWith('/tasks')) {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          genieAcs.tasks.push(JSON.parse(raw || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        });
        return;
      }
      if (!url.pathname.startsWith('/devices')) {
        res.writeHead(404).end('[]');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', total: '1' })
        .end(JSON.stringify([project(ont(), url.searchParams.get('projection'))]));
    });
    genieAcs.server.listen(0, '127.0.0.1', () => resolve());
  });
}

before(async () => {
  await startTestServers();
  await startGenieAcsStub();
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
  genieAcs.optics = 'read';
  genieAcs.manufacturer = 'ALCL';
  DeviceService.parameterReadRequests.clear();
  await asTenant(() => getDb()('app_state')
    .whereIn('key', ['rx_power_path', 'temperature_path']).del());
});

const detail = () => asTenant(() => DeviceService.getDetailDevice('ALCL-G0425GC-1'));
const listing = () => asTenant(() => DeviceService.getDevicesPage({}));
const reads = () => genieAcs.tasks.filter((task) => task.name === 'getParameterValues');
const refreshes = () => genieAcs.tasks
  .filter((task) => task.name === 'refreshObject')
  .map((task) => task.objectName);

describe('a Nokia whose optics sit in X_ALU_OntOpticalParam', () => {
  it('shows its signal and temperature on the detail page', async () => {
    const { virtualParameters } = await detail();

    assert.equal(virtualParameters.rxpower.value, -19.87);
    assert.equal(virtualParameters.rxpower.path, 'InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower');
    assert.equal(virtualParameters.temperature.value, 45);
    assert.equal(reads().length, 0, 'nothing to ask for');
  });

  it('shows them in the listing too', async () => {
    const { devices } = await listing();
    assert.equal(devices[0].rxpower, -19.87);
  });
});

describe('a Nokia whose optics GenieACS never read', () => {
  it('queues a read of exactly those leaves, once', async () => {
    genieAcs.optics = 'names';

    const first = await detail();
    await detail();

    assert.equal(first.virtualParameters.rxpower.value ?? null, null);
    assert.deepEqual(reads().map((task) => task.parameterNames), [[
      'InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower',
      'InternetGatewayDevice.X_ALU_OntOpticalParam.Temperature'
    ]]);
  });

  it('reads them when summoned', async () => {
    genieAcs.optics = 'names';
    await asTenant(() => DeviceService.summonDevice('ALCL-G0425GC-1'));

    const leaves = reads().at(-1).parameterNames;
    assert.ok(leaves.includes('InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower'));
    assert.ok(leaves.includes('InternetGatewayDevice.X_ALU_OntOpticalParam.Temperature'));
    assert.ok(leaves.includes(
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username'
    ));
    assert.ok(!refreshes().includes('InternetGatewayDevice.X_ALU_OntOpticalParam'),
      'the leaves are known; asking for them is enough');
  });
});

describe('summoning an ONT without the optics object', () => {
  it('asks a Nokia to enumerate it', async () => {
    genieAcs.optics = 'absent';
    await asTenant(() => DeviceService.summonDevice('ALCL-G0425GC-1'));
    assert.ok(refreshes().includes('InternetGatewayDevice.X_ALU_OntOpticalParam'));
  });

  it('never asks another make for Nokia\'s object', async () => {
    genieAcs.optics = 'absent';
    genieAcs.manufacturer = 'ZTE';
    await asTenant(() => DeviceService.summonDevice('ALCL-G0425GC-1'));
    assert.ok(!refreshes().includes('InternetGatewayDevice.X_ALU_OntOpticalParam'));
  });
});
