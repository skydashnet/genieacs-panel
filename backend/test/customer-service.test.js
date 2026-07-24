import test from 'node:test';
import assert from 'node:assert/strict';
import CustomerAccount from '../src/models/CustomerAccount.js';
import CustomerService from '../src/services/customerService.js';

test('customer IDs use the required format and derive a six-digit initial password', () => {
  const ids = new Set();
  for (let index = 0; index < 100; index += 1) {
    const id = CustomerService.generateCustomerId();
    assert.match(id, /^CSG-[A-Z0-9]{7}-[0-9]{6}$/);
    assert.match(CustomerService.passwordForCustomerId(id), /^[0-9]{6}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 100);
});

test('customer identity binding is deterministic and existing device IDs stay immutable', async () => {
  assert.equal(
    CustomerService.identityHash('V1', 'pppoe-user'),
    CustomerService.identityHash('V1', 'pppoe-user')
  );
  assert.notEqual(
    CustomerService.identityHash('V1', 'pppoe-user'),
    CustomerService.identityHash('V2', 'pppoe-user')
  );

  const originalByDevice = CustomerAccount.getByDeviceId;
  const originalTouch = CustomerAccount.touch;
  const originalCreate = CustomerAccount.create;
  let createCalls = 0;
  const stored = {
    id: 7,
    customer_id: 'CSG-EXIST22-123456',
    device_id: 'device-one'
  };

  CustomerAccount.getByDeviceId = async () => stored;
  CustomerAccount.touch = async () => stored;
  CustomerAccount.create = async () => {
    createCalls += 1;
    throw new Error('must not create');
  };

  try {
    const result = await CustomerService.ensureAccount({
      _id: 'device-one',
      softwareId: 'new-firmware',
      pppoe: 'same-user'
    });
    assert.equal(result.customer_id, stored.customer_id);
    assert.equal(createCalls, 0);
  } finally {
    CustomerAccount.getByDeviceId = originalByDevice;
    CustomerAccount.touch = originalTouch;
    CustomerAccount.create = originalCreate;
  }
});

test('customer account generation requires device, software, and PPPoE identity', async () => {
  assert.equal(await CustomerService.ensureAccount({
    _id: 'device-one',
    softwareId: '',
    pppoe: 'user'
  }), null);
  assert.equal(await CustomerService.ensureAccount({
    _id: 'device-one',
    softwareId: 'V1',
    pppoe: ''
  }), null);
});
