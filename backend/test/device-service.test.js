import test from 'node:test';
import assert from 'node:assert/strict';
import DeviceService from '../src/services/deviceService.js';
import VendorService from '../src/services/vendorService.js';
import WifiSecurityConfig from '../src/models/WifiSecurityConfig.js';

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

test('customer portal requests only safe ONT and WiFi fields and never returns admin configuration', async () => {
  const originalVirtual = DeviceService.getVirtualParameters;
  const originalFetch = DeviceService.fetchFromGenieAcs;
  let projection = '';

  DeviceService.getVirtualParameters = async () => ({
    vpRxPower: 'VirtualParameters.OpticalRXPower',
    vpTemperature: 'VirtualParameters.OpticalTemperature',
    vpActiveDevices: 'VirtualParameters.TotalStations',
    vpPppoeUsername: 'VirtualParameters.PPPUsername'
  });
  DeviceService.fetchFromGenieAcs = async (_endpoint, query) => {
    projection = query.projection;
    return [{
      _id: 'portal-device',
      _deviceId: {
        _Manufacturer: 'ZTE',
        _ProductClass: 'F663',
        _SerialNumber: 'SN-PORTAL'
      },
      InternetGatewayDevice: {
        DeviceInfo: {
          SoftwareVersion: { _value: 'V1.0' },
          HardwareVersion: { _value: 'V3.1' },
          UpTime: { _value: 3600 }
        },
        LANDevice: {
          1: {
            WLANConfiguration: {
              1: {
                Enable: { _value: true },
                SSID: { _value: 'Home WiFi' },
                TotalAssociations: { _value: 2 }
              }
            }
          }
        }
      },
      VirtualParameters: {
        OpticalRXPower: { _value: '-21.5' },
        OpticalTemperature: { _value: 42 },
        TotalStations: { _value: 2 }
      },
      _lastInform: new Date().toISOString()
    }];
  };

  try {
    const result = await DeviceService.getCustomerPortalOverview('portal-device');
    assert.doesNotMatch(projection, /WANDevice/i);
    assert.doesNotMatch(projection, /PPPUsername/i);
    assert.doesNotMatch(projection, /Password|KeyPassphrase/i);
    assert.equal(result.ont.serialNumber, 'SN-PORTAL');
    assert.equal(result.wifi[0].ssid, 'Home WiFi');
    assert.equal(result.pppoe, undefined);
    assert.equal(result.wan, undefined);
  } finally {
    DeviceService.getVirtualParameters = originalVirtual;
    DeviceService.fetchFromGenieAcs = originalFetch;
  }
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

test('WiFi update uses installer virtual parameters and typed GenieACS values', async () => {
  const item = {
    _id: 'device-wifi',
    _deviceId: { _Manufacturer: 'ZTE', _ProductClass: 'F663NV3A' },
    VirtualParameters: {
      'SSID1-Name': { _value: 'Old SSID', _writable: true },
      'SSID1-Password': { _value: 'oldpassword', _writable: true },
      'SSID1-Security': { _value: 'WPA2-PSK', _writable: true }
    },
    InternetGatewayDevice: {
      LANDevice: {
        1: {
          WLANConfiguration: {
            1: {
              Enable: { _value: true, _writable: true },
              Channel: { _value: 1, _writable: true }
            }
          }
        }
      }
    }
  };
  const originalFetch = DeviceService.fetchFromGenieAcs;
  const originalPostTask = DeviceService.postTask;
  const originalDetectVendor = VendorService.detectVendor;
  const originalGetConfig = WifiSecurityConfig.getByProductClass;
  let submittedTask;

  DeviceService.fetchFromGenieAcs = async () => [item];
  DeviceService.postTask = async (_deviceId, task) => { submittedTask = task; };
  VendorService.detectVendor = async () => ({ name: 'ZTE' });
  WifiSecurityConfig.getByProductClass = async () => null;

  try {
    const result = await DeviceService.updateWifiConfig('device-wifi', 1, {
      enable: true,
      ssid: 'Sky Home',
      password: 'newpassword',
      security: 'WPA2-PSK',
      channel: 6
    });
    assert.equal(result.parameterCount, 5);
    assert.deepEqual(submittedTask, {
      name: 'setParameterValues',
      parameterValues: [
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable', true, 'xsd:boolean'],
        ['VirtualParameters.SSID1-Name', 'Sky Home', 'xsd:string'],
        ['VirtualParameters.SSID1-Password', 'newpassword', 'xsd:string'],
        ['VirtualParameters.SSID1-Security', 'WPA2-PSK', 'xsd:string'],
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel', 6, 'xsd:unsignedInt']
      ]
    });
  } finally {
    DeviceService.fetchFromGenieAcs = originalFetch;
    DeviceService.postTask = originalPostTask;
    VendorService.detectVendor = originalDetectVendor;
    WifiSecurityConfig.getByProductClass = originalGetConfig;
  }
});

test('dashboard summary aggregates operations charts and normalizes faults', () => {
  const now = Date.now();
  const devices = [
    {
      _id: 'online',
      _lastInform: new Date(now - 60_000).toISOString(),
      _registered: new Date(now - 60_000).toISOString(),
      productclass: 'F663',
      manufacturer: 'ZTE',
      rxpower: -20,
      temperature: 41,
      activedevices: 3
    },
    {
      _id: 'offline',
      _lastInform: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      _registered: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      productclass: 'HG8245',
      manufacturer: 'Huawei',
      rxpower: -28,
      temperature: 75,
      activedevices: 17
    }
  ];
  const fault = DeviceService.normalizeFault({
    _id: 'online:default',
    code: 'cwmp.9002',
    message: 'Internal error',
    timestamp: new Date(now).toISOString()
  });
  const summary = DeviceService.buildDashboardSummary(devices, [fault]);

  assert.deepEqual(summary.stats, { total: 2, online: 1, offline: 1, new24h: 1 });
  assert.equal(summary.rxDistribution.Excellent, 1);
  assert.equal(summary.rxDistribution.Danger, 1);
  assert.equal(summary.temperatureDistribution.Hot, 1);
  assert.equal(summary.clientDistribution['16+'], 1);
  assert.equal(summary.registrations.reduce((sum, point) => sum + point.value, 0), 2);
  assert.equal(summary.faults[0].deviceId, 'online');
  assert.equal(summary.faults[0].code, 'cwmp.9002');
  assert.ok(summary.generatedAt);
});

test('expired dashboard snapshots return immediately while refreshing in background', async () => {
  const originalCache = DeviceService.dashboardCache;
  const originalRefresh = DeviceService.refreshDashboardData;
  const stale = {
    generatedAt: '2026-07-24T00:00:00.000Z',
    stats: { total: 5, online: 5, offline: 0, new24h: 0 },
    rxDistribution: {},
    informFreshness: {},
    temperatureDistribution: {},
    clientDistribution: {},
    productClasses: [],
    manufacturers: [],
    registrations: [],
    faults: [],
    faultsError: null
  };
  let refreshCalls = 0;
  let releaseRefresh;

  DeviceService.dashboardCache = {
    data: stale,
    expiresAt: 0,
    promise: null,
    hydrated: true
  };
  DeviceService.refreshDashboardData = () => {
    refreshCalls += 1;
    return new Promise((resolve) => { releaseRefresh = () => resolve(stale); });
  };

  try {
    const result = await DeviceService.getDashboardData(false);
    assert.equal(result, stale);
    assert.equal(refreshCalls, 1);
    assert.ok(DeviceService.dashboardCache.promise);
    releaseRefresh();
    await DeviceService.dashboardCache.promise;
  } finally {
    DeviceService.dashboardCache = originalCache;
    DeviceService.refreshDashboardData = originalRefresh;
  }
});
