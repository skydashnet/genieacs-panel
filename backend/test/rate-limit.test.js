import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { ipKey } from '../src/middleware/rateLimit.js';

const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);

let portalUrl;
const first = { customerId: 'CSG-AAAAAAA-222222', password: null };
const second = { customerId: 'CSG-BBBBBBB-333333', password: null };

async function createAccount(account, index) {
  const { password, record } = await CustomerPortalPasswordService.createRecord();
  await getDb()('customer_accounts').insert({
    customer_id: account.customerId,
    device_id: `ratelimit-device-${index}`,
    identity_hash: `ratelimit-${index}`.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: `ratelimit-${index}`,
    active: true,
    ...record
  });
  account.password = password;
}

before(async () => {
  ({ portalUrl } = await startTestServers());
  await createAccount(first, 1);
  await createAccount(second, 2);
});

after(async () => {
  await stopTestServers();
});

describe('ipKey', () => {
  it('passes IPv4 through unchanged', () => {
    assert.equal(ipKey({ ip: '203.0.113.7' }), '203.0.113.7');
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    assert.equal(ipKey({ ip: '::ffff:203.0.113.7' }), '203.0.113.7');
  });

  it('collapses a full IPv6 address to its /64 prefix', () => {
    assert.equal(ipKey({ ip: '2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd' }), '2001:db8:0:1::/64');
  });

  /**
   * O caso que faltava, e é ele que o balde existe para atender.
   *
   * O teste acima usava o endereço escrito POR EXTENSO, que é como quase nenhum
   * endereço IPv6 aparece na vida real — e era a única forma que a conta à mão
   * acertava. Na forma comprimida ela devolvia o endereço inteiro, então trocar
   * o último grupo dava um balde novo: o limite protegia contra quem não estava
   * tentando contorná-lo.
   */
  it('gives two addresses of the same /64 the same bucket, compressed or not', () => {
    const chave = ipKey({ ip: '2001:db8:0:1::1' });
    assert.equal(ipKey({ ip: '2001:db8:0:1::2' }), chave);
    assert.equal(ipKey({ ip: '2001:db8:0:1:aaaa:bbbb:cccc:dddd' }), chave);
    assert.equal(ipKey({ ip: '2001:0db8:0000:0001:0000:0000:0000:0001' }), chave);
  });

  it('and keeps a different /64 in a different bucket', () => {
    assert.notEqual(ipKey({ ip: '2001:db8:0:2::1' }), ipKey({ ip: '2001:db8:0:1::1' }));
  });

  it('falls back to one bucket when there is no address to separate by', () => {
    assert.equal(ipKey({}), 'unknown');
    // A zona nomeia a interface de quem recebe, não o cliente: `fe80::1%eth0`
    // e `fe80::1%eth1` são o mesmo vizinho chegando por duas placas.
    assert.equal(ipKey({ ip: 'fe80::1%eth0' }), ipKey({ ip: 'fe80::1%eth1' }));
  });
});

describe('portal login rate limit', () => {
  // Every customer reaches the portal through the same reverse proxy, so a
  // limiter keyed only by source address would let one visitor lock out the
  // whole customer base.
  it('isolates one customer from another customer failed attempts', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { status } = await call(`${portalUrl}/api/customer/login`, {
        method: 'POST',
        body: { customerId: first.customerId, password: 'WRONGPASS1' }
      });
      assert.ok([401, 429].includes(status));
    }

    const exhausted = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: first.customerId, password: first.password }
    });
    assert.equal(exhausted.status, 429, 'the abused customer ID should be throttled');

    const unaffected = await call(`${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: second.customerId, password: second.password }
    });
    assert.equal(unaffected.status, 200, 'other customers must stay able to log in');
  });
});
