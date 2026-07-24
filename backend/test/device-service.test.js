import test from 'node:test';
import assert from 'node:assert/strict';
import DeviceService from '../src/services/deviceService.js';
import VendorService from '../src/services/vendorService.js';

test('device normalization preserves valid false, zero, and empty-string values', () => {
  const item = {
    _id: 'device-1',
    _deviceId: {
      _SerialNumber: 'SN1',
      _ProductClass: 'ONT',
      _Manufacturer: 'Vendor'
    },
    VirtualParameters: {
      PPPUsername: { _value: '' },
      WANBridge: { _value: false },
      OpticalRXPower: { _value: 0 },
      OpticalTemperature: { _value: 0 },
      TotalStations: { _value: 0 }
    },
    _lastInform: '2026-07-24T00:00:00.000Z',
    _registered: '2026-07-23T00:00:00.000Z'
  };
  const virtualParameters = {
    vpPppoeUsername: 'VirtualParameters.PPPUsername',
    vpWanBridge: 'VirtualParameters.WANBridge',
    vpRxPower: 'VirtualParameters.OpticalRXPower',
    vpTemperature: 'VirtualParameters.OpticalTemperature',
    vpActiveDevices: 'VirtualParameters.TotalStations'
  };

  const result = DeviceService.processDeviceData(item, virtualParameters);
  assert.equal(result.pppoe, '');
  assert.equal(result.wanbridge, false);
  assert.equal(result.rxpower, 0);
  assert.equal(result.temperature, 0);
  assert.equal(result.activedevices, 0);
  assert.equal(result.manufacturer, 'Vendor');
  assert.equal(result._lastInform, item._lastInform);
  assert.equal(result._registered, item._registered);
});

test('GenieACS metadata-only nodes and typed tuples never escape as renderable objects', () => {
  const metadataNode = { _object: false, _writable: false };
  const item = {
    _id: 'device-metadata',
    _deviceId: {
      _SerialNumber: 'SN-META',
      _ProductClass: 'ONT',
      _Manufacturer: 'Vendor'
    },
    VirtualParameters: {
      PPPUsername: metadataNode,
      WANBridge: metadataNode,
      OpticalRXPower: { _value: ['-23.5', 'xsd:string'] },
      OpticalTemperature: metadataNode,
      TotalStations: metadataNode
    }
  };
  const virtualParameters = {
    vpPppoeUsername: 'VirtualParameters.PPPUsername',
    vpWanBridge: 'VirtualParameters.WANBridge',
    vpRxPower: 'VirtualParameters.OpticalRXPower',
    vpTemperature: 'VirtualParameters.OpticalTemperature',
    vpActiveDevices: 'VirtualParameters.TotalStations'
  };

  const result = DeviceService.processDeviceData(item, virtualParameters);
  assert.equal(result.pppoe, null);
  assert.equal(result.wanbridge, null);
  assert.equal(result.rxpower, '-23.5');
  assert.equal(result.temperature, null);
  assert.equal(result.activedevices, null);
  assert.equal(DeviceService.getParameterValue(item, 'VirtualParameters.PPPUsername'), null);
});

test('WAN discovery keeps every IP and PPP instance and updates the selected PPP path', async () => {
  const item = {
    _id: 'device-1',
    _deviceId: { _Manufacturer: 'Vendor', _ProductClass: 'ONT' },
    InternetGatewayDevice: {
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANIPConnection: {
                1: { Name: { _value: 'ip-one' } }
              },
              WANPPPConnection: {
                1: { Name: { _value: 'ppp-one' } },
                2: { Name: { _value: 'ppp-two' } }
              }
            }
          }
        }
      }
    }
  };
  const virtualParameters = {
    vpPppoeUsername: 'VirtualParameters.PPPUsername',
    vpWanBridge: 'VirtualParameters.WANBridge',
    vpRxPower: 'VirtualParameters.OpticalRXPower',
    vpTemperature: 'VirtualParameters.OpticalTemperature',
    vpActiveDevices: 'VirtualParameters.TotalStations',
    vpSuperAdmin: 'VirtualParameters.LoginSuperUser',
    vpSuperPassword: 'VirtualParameters.LoginSuperPass',
    vpUserAdmin: '',
    vpUserPassword: ''
  };

  const originalDetectVendor = VendorService.detectVendor;
  const originalFetch = DeviceService.fetchFromGenieAcs;
  const originalPostTask = DeviceService.postTask;
  let submittedTask;

  VendorService.detectVendor = async () => ({ id: 1, name: 'Vendor' });
  DeviceService.fetchFromGenieAcs = async () => [item];
  DeviceService.postTask = async (_deviceId, task) => {
    submittedTask = task;
  };

  try {
    const detail = await DeviceService.processDetailDeviceData(item, virtualParameters);
    assert.deepEqual(
      detail.wan.map(connection => connection.index),
      ['1.1.ip.1', '1.1.ppp.1', '1.1.ppp.2']
    );

    await DeviceService.updateWanConfig('device-1', '1.1.ppp.2', { username: 'selected-user' });
    assert.deepEqual(submittedTask.parameterValues, [[
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username',
      'selected-user',
      'xsd:string'
    ]]);
  } finally {
    VendorService.detectVendor = originalDetectVendor;
    DeviceService.fetchFromGenieAcs = originalFetch;
    DeviceService.postTask = originalPostTask;
  }
});
