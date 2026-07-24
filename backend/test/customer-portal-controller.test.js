import test from 'node:test';
import assert from 'node:assert/strict';
import CustomerPortalController from '../src/controllers/customerPortalController.js';
import DeviceService from '../src/services/deviceService.js';
import CustomerWifiCredentialService, {
  decryptPassword,
  encryptPassword
} from '../src/services/customerWifiCredentialService.js';

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

test('portal overview works as an unbound Express callback and keeps cache isolated by account', async () => {
  const originalOverview = DeviceService.getCustomerPortalOverview;
  const originalSavedPasswordStatus = CustomerWifiCredentialService.getSavedPasswordStatus;
  const calls = [];
  DeviceService.getCustomerPortalOverview = async (deviceId) => {
    calls.push(deviceId);
    return {
      status: 'online',
      ont: { serialNumber: `serial-${deviceId}` },
      wifi: [{ index: 1, ssid: `wifi-${deviceId}` }]
    };
  };
  CustomerWifiCredentialService.getSavedPasswordStatus = async (accountId) => (
    accountId === 11
      ? new Map([[1, { hasPassword: true }]])
      : new Map()
  );
  CustomerPortalController.overviewCache.clear();

  try {
    // Express invokes class methods as plain callbacks, without binding `this`.
    const handler = CustomerPortalController.overview;
    const userA = responseRecorder();
    await handler(
      { customer: { id: 11, customer_id: 'CSG-USERAAA-111111', device_id: 'device-a' } },
      userA
    );
    assert.equal(userA.statusCode, 200);
    assert.equal(userA.payload.success, true);
    assert.equal(userA.payload.data.ont.serialNumber, 'serial-device-a');
    assert.equal(userA.payload.data.wifi[0].hasSavedPassword, true);
    assert.equal(userA.payload.data.wifi[0].password, undefined);

    const userACached = responseRecorder();
    await handler(
      { customer: { id: 11, customer_id: 'CSG-USERAAA-111111', device_id: 'device-a' } },
      userACached
    );
    assert.equal(userACached.payload.data.ont.serialNumber, 'serial-device-a');

    const userB = responseRecorder();
    await handler(
      { customer: { id: 12, customer_id: 'CSG-USERBBB-222222', device_id: 'device-b' } },
      userB
    );
    assert.equal(userB.payload.data.ont.serialNumber, 'serial-device-b');
    assert.equal(userB.payload.data.wifi[0].hasSavedPassword, false);
    assert.deepEqual(calls, ['device-a', 'device-b']);
  } finally {
    CustomerPortalController.overviewCache.clear();
    DeviceService.getCustomerPortalOverview = originalOverview;
    CustomerWifiCredentialService.getSavedPasswordStatus = originalSavedPasswordStatus;
  }
});

test('portal reveals a saved WiFi password only from the authenticated account', async () => {
  const originalReveal = CustomerWifiCredentialService.reveal;
  const calls = [];
  CustomerWifiCredentialService.reveal = async (accountId, wifiIndex) => {
    calls.push({ accountId, wifiIndex });
    return accountId === 31 && wifiIndex === 1 ? 'account-a-password' : null;
  };

  try {
    const response = responseRecorder();
    await CustomerPortalController.revealWifiPassword({
      customer: { id: 31, device_id: 'device-a' },
      params: { index: '1' },
      query: { accountId: 99 },
      body: { accountId: 99, deviceId: 'device-b' }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.data.password, 'account-a-password');
    assert.deepEqual(calls, [{ accountId: 31, wifiIndex: 1 }]);

    const missing = responseRecorder();
    await CustomerPortalController.revealWifiPassword({
      customer: { id: 32, device_id: 'device-b' },
      params: { index: '1' }
    }, missing);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(calls[1], { accountId: 32, wifiIndex: 1 });
  } finally {
    CustomerWifiCredentialService.reveal = originalReveal;
  }
});

test('portal WiFi updates always target the authenticated customer device', async () => {
  const originalOverview = DeviceService.getCustomerPortalOverview;
  const originalUpdate = DeviceService.updateWifiConfig;
  const originalSave = CustomerWifiCredentialService.save;
  const originalExpiry = DeviceService.dashboardCache.expiresAt;
  const calls = [];
  const saved = [];

  DeviceService.getCustomerPortalOverview = async (deviceId) => ({
    status: 'online',
    wifi: [{ index: 1, ssid: `current-${deviceId}` }]
  });
  DeviceService.updateWifiConfig = async (deviceId, index, formData) => {
    calls.push({ deviceId, index, formData });
    return { success: true };
  };
  CustomerWifiCredentialService.save = async (...args) => {
    saved.push(args);
  };

  try {
    const handler = CustomerPortalController.updateWifi;
    const response = responseRecorder();
    await handler({
      customer: {
        id: 21,
        customer_id: 'CSG-USERAAA-111111',
        device_id: 'device-a'
      },
      body: {
        deviceId: 'device-b',
        index: 1,
        ssid: 'Rumah A',
        password: 'securepass123',
        enable: false,
        channel: 196
      }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{
      deviceId: 'device-a',
      index: 1,
      formData: {
        ssid: 'Rumah A',
        password: 'securepass123'
      }
    }]);
    assert.deepEqual(response.payload.data, { index: 1, ssid: 'Rumah A' });
    assert.equal(response.payload.data.password, undefined);
    assert.deepEqual(saved, [[21, 1, 'Rumah A', 'securepass123']]);

    const missingNetwork = responseRecorder();
    await handler({
      customer: { id: 21, device_id: 'device-a' },
      body: { index: 8, ssid: 'Hidden radio', password: '' }
    }, missingNetwork);
    assert.equal(missingNetwork.statusCode, 404);
    assert.equal(calls.length, 1);
  } finally {
    DeviceService.dashboardCache.expiresAt = originalExpiry;
    DeviceService.getCustomerPortalOverview = originalOverview;
    DeviceService.updateWifiConfig = originalUpdate;
    CustomerWifiCredentialService.save = originalSave;
  }
});

test('saved portal WiFi passwords use authenticated encryption at rest', () => {
  const first = encryptPassword('securepass123');
  const second = encryptPassword('securepass123');
  assert.notEqual(first.password_ciphertext, second.password_ciphertext);
  assert.doesNotMatch(JSON.stringify(first), /securepass123/);
  assert.equal(decryptPassword(first), 'securepass123');
  assert.equal(decryptPassword({
    ...first,
    password_ciphertext: `${first.password_ciphertext.slice(0, -2)}AA`
  }), null);
});
