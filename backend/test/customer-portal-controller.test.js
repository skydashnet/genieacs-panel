import test from 'node:test';
import assert from 'node:assert/strict';
import CustomerPortalController from '../src/controllers/customerPortalController.js';
import DeviceService from '../src/services/deviceService.js';

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
  const calls = [];
  DeviceService.getCustomerPortalOverview = async (deviceId) => {
    calls.push(deviceId);
    return {
      status: 'online',
      ont: { serialNumber: `serial-${deviceId}` },
      wifi: []
    };
  };
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
    assert.deepEqual(calls, ['device-a', 'device-b']);
  } finally {
    CustomerPortalController.overviewCache.clear();
    DeviceService.getCustomerPortalOverview = originalOverview;
  }
});
