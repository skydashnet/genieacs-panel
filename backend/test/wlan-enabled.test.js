import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { default: DeviceService } = await import('../src/services/deviceService.js');

const base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';
const reader = (values) => (path) => values[path] ?? null;
const resolve = (values) => DeviceService.resolveWlanEnabled(reader(values), 1);

describe('whether a WiFi network is on', () => {
  it('reads Enable when the ONT reported it', () => {
    assert.equal(resolve({ [`${base}.Enable`]: true }), true);
    assert.equal(resolve({ [`${base}.Enable`]: '0' }), false);
  });

  it('falls back to RadioEnabled', () => {
    assert.equal(resolve({ [`${base}.RadioEnabled`]: '1' }), true);
  });

  it('falls back to Status Up / Disabled', () => {
    assert.equal(resolve({ [`${base}.Status`]: 'Up' }), true);
    assert.equal(resolve({ [`${base}.Status`]: 'Disabled' }), false);
  });

  it('Enable wins over Status', () => {
    assert.equal(resolve({ [`${base}.Enable`]: false, [`${base}.Status`]: 'Up' }), false);
  });

  it('stays unknown when nothing decides it', () => {
    assert.equal(resolve({}), null);
    assert.equal(resolve({ [`${base}.Enable`]: '' }), null);
    assert.equal(resolve({ [`${base}.Status`]: 'Error' }), null);
  });
});
