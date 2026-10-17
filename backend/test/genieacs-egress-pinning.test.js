import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stated rather than left to the default, so this file keeps testing the
// self-hosted edition whatever a developer's `.env` happens to say. It has to
// be in place before `edition.js` loads, hence the dynamic imports below.
process.env.EDITION = 'selfhosted';

const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { asTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

/**
 * Two hosts on the same port, told apart only by the address the socket goes
 * to. 127/8 is entirely local, so `first` and `second` stand in for "the
 * address the name gave when it was checked" and "the address it gives now"
 * without either of them being a real host anywhere.
 */
const first = { address: '127.0.0.1', server: null, hits: [] };
const second = { address: '127.0.0.2', server: null, hits: [] };
let port;

/** The name in the settings row. It resolves to nothing; only the script below answers it. */
const ACS_NAME = 'acs.lan.invalid';

function serve(host, listenPort) {
  return new Promise((resolve, reject) => {
    host.server = http.createServer((req, res) => {
      host.hits.push({ url: req.url, host: req.headers.host });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    host.server.once('error', reject);
    host.server.listen(listenPort, host.address, () => resolve(host.server.address().port));
  });
}

const realLookup = GenieAcsEgress.lookup;

/**
 * The rebinding answer, in the only form a test can hold: public-then-private
 * is unusable here because nothing public is reachable, so this is
 * first-then-second and the question is simply which of the two got the
 * request. The guard is permissive in this edition, so both answers pass the
 * address check and only the pinning decides.
 */
function scriptRebinding() {
  const calls = [];
  GenieAcsEgress.lookup = async (hostname) => {
    calls.push(hostname);
    const host = calls.length === 1 ? first : second;
    return [{ address: host.address, family: 4 }];
  };
  return calls;
}

before(async () => {
  port = await serve(first, 0);
  await serve(second, port);
  await startTestServers();
  await asTenant(() => Setting.upsert('genieAcsUrl', `http://${ACS_NAME}:${port}`));
});

after(async () => {
  GenieAcsEgress.lookup = realLookup;
  await stopTestServers();
  await new Promise((done) => first.server.close(done));
  await new Promise((done) => second.server.close(done));
});

afterEach(() => {
  GenieAcsEgress.lookup = realLookup;
  first.hits.length = 0;
  second.hits.length = 0;
});

describe('the vetted address is the address connected to', () => {
  /**
   * This is the whole exercise. A guard that resolves a name, likes the answer,
   * and then hands the name to an HTTP client has closed nothing: the client
   * resolves it again and the second answer is the attacker's. Here the second
   * answer exists and is reachable, so if it ever reaches a socket the second
   * host records it — the assertion is not "an error was thrown" but "the other
   * host was never touched".
   */
  it('sends the request to the first answer and never to the second', async () => {
    const calls = scriptRebinding();

    const result = await asTenant(() => DeviceService.fetchFromGenieAcs(''));

    // The second host is asserted first so that a hole reports itself as what
    // it is — "the request followed the rebound answer" — instead of as a count
    // that has to be reasoned about.
    assert.deepEqual(second.hits, [], 'the request followed the second answer');
    assert.equal(first.hits.length, 1, 'the vetted address did not get the request');
    assert.equal(calls.length, 1, `the name was resolved ${calls.length} times, not once`);
    assert.deepEqual(result, []);
  });

  /**
   * Pinning that reached the right socket by putting the IP in the URL would
   * break every virtual-hosted ACS and every TLS certificate. The name has to
   * survive into the request, and the header is where that is visible.
   */
  it('still sends the configured name in the Host header', async () => {
    scriptRebinding();

    await asTenant(() => DeviceService.fetchFromGenieAcs(''));

    assert.equal(first.hits[0].host, `${ACS_NAME}:${port}`);
  });

  it('pins every path, not only the device one', async () => {
    scriptRebinding();

    await asTenant(() => DeviceService.fetchGenieAcsCollection('faults'));

    assert.deepEqual(second.hits, [], 'the request followed the second answer');
    assert.equal(first.hits.length, 1);
    assert.match(first.hits[0].url, /^\/faults/);
  });

  it('pins a request that carries a body too', async () => {
    scriptRebinding();

    await asTenant(() => DeviceService.postProvisioningTask('device-1', { name: 'reboot' }));

    assert.deepEqual(second.hits, [], 'the request followed the second answer');
    assert.equal(first.hits.length, 1);
  });
});

describe('a self-hosted install reaches its own LAN', () => {
  /**
   * On this edition the ACS is on the operator's own network and a private
   * address is the normal case — there is no untrusted party to defend against,
   * because the person who wrote the URL owns the install. Every one of these
   * is refused on the SaaS edition, which is the point of the flag.
   */
  const lan = [
    ['loopback', '127.0.0.1'],
    ['private 10/8', '10.0.0.5'],
    ['private 172.16/12', '172.20.1.9'],
    ['private 192.168/16', '192.168.0.10'],
    ['carrier-grade NAT', '100.70.0.1'],
    ['an IPv6 unique local address', 'fd00::1']
  ];

  for (const [what, address] of lan) {
    it(`accepts ${what} (${address})`, async () => {
      GenieAcsEgress.lookup = async () => [{ address, family: address.includes(':') ? 6 : 4 }];

      const target = await GenieAcsEgress.resolveTarget(`http://acs.lan.invalid:${port}/devices`);

      assert.deepEqual(target.addresses, [{ address, family: address.includes(':') ? 6 : 4 }]);
    });
  }

  /**
   * The two guards now share one table of blocked ranges, and that union is
   * strictly wider than what either of them enforced alone — 192.0.0.0/16 and
   * 6to4 came from the WhatsApp side, IPv6 multicast from this one, and the
   * IPv4-translated form was missing from both. None of that may narrow what a
   * self-hosted install can reach, because this edition does not consult the
   * table at all. These are the newly-blocked classes, asserted from the side
   * that must not have changed.
   */
  for (const address of ['192.0.2.5', 'ff02::1', '::ffff:0:7f00:1']) {
    it(`is unaffected by the widened blocklist (${address})`, async () => {
      GenieAcsEgress.lookup = async () => [{ address, family: address.includes(':') ? 6 : 4 }];

      const target = await GenieAcsEgress.resolveTarget(`http://acs.lan.invalid:${port}/devices`);

      assert.equal(target.addresses[0].address, address);
    });
  }

  // The NBI on a self-hosted box sits wherever the operator put it, and the
  // suite itself proves the point: its stub listens on an ephemeral port.
  it('accepts a port the SaaS allowlist would refuse', async () => {
    GenieAcsEgress.lookup = async () => [{ address: '10.0.0.5', family: 4 }];

    const target = await GenieAcsEgress.resolveTarget('http://acs.lan.invalid:9999/devices');

    assert.equal(target.port, 9999);
  });

  // Permissive about addresses is not permissive about everything: a scheme
  // that is not HTTP is a different transport, not a different network.
  it('still refuses a scheme that is not HTTP or HTTPS', async () => {
    await assert.rejects(
      GenieAcsEgress.resolveTarget('file:///etc/passwd'),
      (error) => error.code === 'GENIEACS_EGRESS_REFUSED'
    );
  });
});
