import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { default: DeviceService } = await import('../src/services/deviceService.js');

const param = (value) => ({ _value: value, _writable: false });

/**
 * A ZTE F-series as it reports itself: TR-069 on connection 1, Internet over
 * PPPoE on connection 2, each with its own MAC, plus the WAN port's.
 */
function zte() {
  return {
    InternetGatewayDevice: {
      WANDevice: {
        1: {
          WANEthernetInterfaceConfig: { MACAddress: param('34:36:54:87:04:50') },
          WANConnectionDevice: {
            1: { WANIPConnection: { 1: { MACAddress: param('34:36:54:87:04:5a') } } },
            2: {
              WANPPPConnection: {
                1: { Username: param('st100.563'), MACAddress: param('34:36:54:87:04:5c') }
              }
            }
          }
        }
      }
    }
  };
}

const PPPOE_PATH = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username';

describe('the WAN MAC shown on the device page', () => {
  it('is the one of the connection that dials the subscriber login', () => {
    assert.equal(DeviceService.resolveWanMacAddress(zte(), PPPOE_PATH), '34:36:54:87:04:5c');
  });

  it('falls back to the first connection that reports one', () => {
    assert.equal(DeviceService.resolveWanMacAddress(zte(), null), '34:36:54:87:04:5a');
  });

  it('falls back to the WAN port when no connection reports one', () => {
    const item = zte();
    delete item.InternetGatewayDevice.WANDevice[1].WANConnectionDevice;
    assert.equal(DeviceService.resolveWanMacAddress(item, null), '34:36:54:87:04:50');
  });

  it('is null for a device that reports none', () => {
    assert.equal(DeviceService.resolveWanMacAddress({}, null), null);
  });
});
