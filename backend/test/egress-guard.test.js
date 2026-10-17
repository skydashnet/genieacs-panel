import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the two egress guards do about a NAME, and about a body.
 *
 * The suites that came before this one drove hostile LITERALS through
 * `new URL()` and asserted the classification. That is half the surface. The
 * other half — a perfectly ordinary hostname that RESOLVES somewhere internal —
 * had nothing pinned to it on the WhatsApp path at all, which is how the split
 * resolver survived: `ssrfGuard` checked a name with `dns.resolve4`/`resolve6`,
 * the DNS protocol, and then handed the name to `fetch`, which resolves through
 * `getaddrinfo`. Anything the system resolver knows and DNS does not —
 * `/etc/hosts`, a Compose `extra_hosts:`, a container name, NSS, mDNS — was
 * validated as public and connected to as private.
 *
 * The SaaS edition, because that is where the address classes are enforced:
 * self-hosted deliberately reaches its own LAN, and `genieacs-egress-pinning`
 * is the file that pins that. It has to be set before `edition.js` loads, hence
 * the dynamic imports.
 */
process.env.EDITION = 'saas';

const { blockedAddressReason } = await import('../src/utils/net/blockedRanges.js');
const { PinnedTransport, ResponseTooLargeError } = await import('../src/utils/net/pinnedFetch.js');
const {
  assertPublicUrl, isBlockedHost, safeFetch, SsrfBlockedError
} = await import('../src/utils/wa/ssrfGuard.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/** A name no zone answers for, so nothing here can accidentally reach the network. */
const NAME = 'egresso.invalid';

/** A port the GenieACS allowlist accepts, so a port failure cannot be mistaken for an address one. */
const ALLOWED_PORT = 7557;

/** TEST-NET-3: routable as far as either blocklist is concerned. Nothing here dials it. */
const PUBLIC_ADDRESS = '203.0.113.7';

const realLookup = PinnedTransport.lookup;
const realRequest = PinnedTransport.request;

/** Stands the shared resolver up with a fixed answer, and counts the calls. */
function resolvesTo(...addresses) {
  const calls = [];
  PinnedTransport.lookup = async (hostname) => {
    calls.push(hostname);
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return calls;
}

/** Stands the shared transport up, so a socket that should never open is visible. */
function transportAnswers(responder) {
  const calls = [];
  PinnedTransport.request = (options) => {
    calls.push(options);
    return Promise.resolve(responder(options, calls.length));
  };
  return calls;
}

afterEach(() => {
  PinnedTransport.lookup = realLookup;
  PinnedTransport.request = realRequest;
});

/**
 * Every address class the union table refuses, in the spelling `new URL()`
 * produces. Each one is asserted three ways — the table itself, the WhatsApp
 * guard, and the GenieACS guard — because the whole point of moving the table
 * into one file is that the three can no longer disagree. Before the move they
 * did: the last four rows were refused by one guard and waved through by the
 * other, in both directions.
 */
const REFUSED = [
  ['loopback', '127.0.0.1'],
  ['the unspecified address', '0.0.0.0'],
  ['private 10/8', '10.0.0.5'],
  ['private 172.16/12', '172.20.1.9'],
  ['private 192.168/16', '192.168.1.1'],
  ['link-local, where the metadata service lives', '169.254.169.254'],
  ['carrier-grade NAT', '100.70.0.1'],
  ['IPv6 loopback', '::1'],
  ['an IPv6 unique local address', 'fd00::1'],
  ['IPv6 link-local', 'fe80::1'],
  ['loopback as an IPv4-mapped address', '::ffff:127.0.0.1'],
  // Only `ssrfGuard` had these two.
  ['IETF protocol assignments (192.0.0.0/24)', '192.0.0.1'],
  ['TEST-NET-1, inside the 192.0.0.0/16 rule', '192.0.2.5'],
  ['6to4 wrapping the metadata service', '2002:a9fe:a9fe::'],
  // Only `genieacsEgress` had this one.
  ['IPv6 multicast', 'ff02::1'],
  // Neither had this one: 127.0.0.1 with one zero group more than the regex
  // looked for, and one byte pair off from where the byte test looked.
  ['loopback as an IPv4-translated address', '::ffff:0:7f00:1'],
  ['NAT64 wrapping loopback', '64:ff9b::7f00:1']
];

const ALLOWED = [
  ['a public IPv4', PUBLIC_ADDRESS],
  ['a public IPv6', '2001:4860:4860::8888'],
  ['6to4 wrapping a public IPv4', '2002:cb00:7107::'],
  ['a public IPv4 as an IPv4-mapped address', '::ffff:203.0.113.7']
];

/** The host string as a URL carries it — brackets and all, for a v6 literal. */
function hostOf(address) {
  return new URL(address.includes(':') ? `http://[${address}]/` : `http://${address}/`).hostname;
}

describe('both guards read one table of blocked ranges', () => {
  for (const [what, address] of REFUSED) {
    it(`refuses ${what} (${address})`, async () => {
      assert.ok(blockedAddressReason(address), 'the shared table does not name a reason');
      assert.equal(isBlockedHost(hostOf(address)), true, 'the WhatsApp guard let the literal through');

      resolvesTo(address);
      await assert.rejects(
        GenieAcsEgress.resolveTarget(`http://${NAME}:${ALLOWED_PORT}/devices`),
        (error) => {
          assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
          assert.ok(error.message.includes(address), `the refusal must name it: ${error.message}`);
          return true;
        }
      );
    });
  }

  for (const [what, address] of ALLOWED) {
    it(`still allows ${what} (${address})`, async () => {
      assert.equal(blockedAddressReason(address), null);
      assert.equal(isBlockedHost(hostOf(address)), false);

      resolvesTo(address);
      const target = await GenieAcsEgress.resolveTarget(`http://${NAME}:${ALLOWED_PORT}/devices`);
      assert.deepEqual(target.addresses, [{ address, family: address.includes(':') ? 6 : 4 }]);
    });
  }

  /**
   * The two ranges the brief expected to find in the union and that are
   * deliberately absent: neither guard ever blocked them, so adding them would
   * be a new decision rather than a union of two old ones — and every suite in
   * this repository uses 203.0.113.x as its stand-in for a reachable host.
   */
  it('leaves TEST-NET-2/3 and 198.18/15 alone, as both guards always did', () => {
    for (const address of ['198.51.100.4', '203.0.113.7', '198.18.0.1']) {
      assert.equal(blockedAddressReason(address), null, address);
    }
  });
});

describe('a name is checked with the resolver the socket would have used', () => {
  /**
   * The finding, in one assertion. `getaddrinfo` answers for `localhost` out of
   * `/etc/hosts`; the DNS protocol does not answer for it at all. A guard that
   * consults `dns.resolve4` therefore learns nothing about any name that only
   * the system resolver knows — which is every name in `/etc/hosts`, every
   * Compose `extra_hosts:` entry and every container name — and then hands that
   * name to a client that resolves it the other way and connects.
   *
   * No network: the hosts file is consulted first and answers.
   */
  it('resolves through getaddrinfo, not through the DNS protocol', async () => {
    const answer = await PinnedTransport.lookup('localhost');
    const addresses = answer.map((entry) => entry.address);

    assert.ok(addresses.length > 0, 'the shared slot must be getaddrinfo, which reads /etc/hosts');
    assert.ok(
      addresses.every((address) => blockedAddressReason(address)),
      `localhost resolved to something public: ${addresses.join(', ')}`
    );
  });

  it('refuses a name that resolves to loopback, on the WhatsApp path', async () => {
    const calls = resolvesTo('127.0.0.1');

    await assert.rejects(
      () => assertPublicUrl(`http://${NAME}/midia.png`),
      (error) => error instanceof SsrfBlockedError
    );
    assert.deepEqual(calls, [NAME], 'the name was never resolved');
  });

  it('refuses a name that resolves to loopback, on the GenieACS path', async () => {
    resolvesTo('127.0.0.1');

    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://${NAME}:${ALLOWED_PORT}/devices`),
      (error) => error.code === 'GENIEACS_EGRESS_REFUSED'
    );
  });

  it('never opens the socket for such a name', async () => {
    resolvesTo('127.0.0.1');
    const sent = transportAnswers(() => new Response('ok', { status: 200 }));

    await assert.rejects(() => safeFetch(`http://${NAME}/midia.png`));

    assert.deepEqual(sent, [], 'the request went out anyway');
  });

  /**
   * One good answer and one bad one is the cheapest rebinding there is: no
   * second lookup is needed, because a client walking the list on a failed
   * connect gets there by itself.
   */
  it('refuses a name that answers with a public address and a private one', async () => {
    resolvesTo(PUBLIC_ADDRESS, '10.1.2.3');

    await assert.rejects(
      () => assertPublicUrl(`http://${NAME}/midia.png`),
      (error) => error instanceof SsrfBlockedError
    );
  });

  /**
   * The vetted address is what the transport is handed, so no second resolution
   * can happen between the check and the connection.
   */
  it('hands the transport the address it vetted, not the name', async () => {
    resolvesTo(PUBLIC_ADDRESS);
    const sent = transportAnswers(() => new Response('ok', { status: 200 }));

    await safeFetch(`http://${NAME}/midia.png`);

    assert.deepEqual(sent[0].addresses, [{ address: PUBLIC_ADDRESS, family: 4 }]);
    assert.equal(sent[0].url.hostname, NAME, 'the name has to survive into the Host header');
  });

  it('refuses a name that resolves to nothing, rather than dialling blind', async () => {
    PinnedTransport.lookup = async () => [];
    const sent = transportAnswers(() => new Response('ok', { status: 200 }));

    await assert.rejects(
      () => safeFetch(`http://${NAME}/midia.png`),
      (error) => error instanceof SsrfBlockedError
    );
    assert.deepEqual(sent, []);
  });

  // A name that does not resolve is not a blocked host: the connection is what
  // fails there, and calling NXDOMAIN "private" would only mislabel it. This is
  // what `EvolutionClient.assertTarget` leans on when it validates a base URL
  // the operator has only just typed.
  it('still lets validation alone pass for a name that does not resolve', async () => {
    PinnedTransport.lookup = async () => [];

    assert.equal((await assertPublicUrl(`https://${NAME}/`)).hostname, NAME);
  });
});

describe('a redirect is re-checked at every hop', () => {
  /**
   * The first hop is a public literal and is allowed; the 302 points at a NAME,
   * and that name resolves to loopback. Only a guard that re-resolves and
   * re-classifies the target of each hop catches this — the address in the
   * `Location` header is not even visible as an address.
   */
  it('refuses a redirect whose target resolves to a private address', async () => {
    resolvesTo('127.0.0.1');
    const sent = transportAnswers(() => new Response(null, {
      status: 302,
      headers: { location: `http://${NAME}/latest/meta-data` }
    }));

    await assert.rejects(
      () => safeFetch('http://203.0.113.10/midia.png'),
      (error) => error instanceof SsrfBlockedError
    );

    assert.equal(sent.length, 1, 'the redirect was followed to the private target');
  });

  it('refuses a redirect to a private literal too', async () => {
    const sent = transportAnswers(() => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' }
    }));

    await assert.rejects(
      () => safeFetch('http://203.0.113.10/midia.png'),
      (error) => error instanceof SsrfBlockedError
    );

    assert.equal(sent.length, 1);
  });
});

describe('the far end does not choose how much memory this process uses', () => {
  /**
   * A real server on loopback, because the ceiling is a property of the socket
   * and not of any classification: it has to be proved against bytes actually
   * arriving. The guards above never reach an address like this — the transport
   * is called here directly, with the address already vetted, which is exactly
   * the position `GenieAcsEgress.fetch` and `safeFetch` hand it.
   */
  const upstream = { server: null, port: null, mode: 'small' };
  const CAP = 64 * 1024;

  before(() => new Promise((resolve) => {
    upstream.server = http.createServer((req, res) => {
      const chunk = 'A'.repeat(16 * 1024);
      if (upstream.mode === 'declared') {
        const body = chunk.repeat(8); // 128 KiB, honestly declared
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) });
        res.end(body);
        return;
      }
      if (upstream.mode === 'streamed') {
        // No declared length at all: the running total is the only thing that
        // can stop this, and without it the writer decides when to stop.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        for (let i = 0; i < 16; i += 1) res.write(chunk);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    upstream.server.listen(0, '127.0.0.1', () => {
      upstream.port = upstream.server.address().port;
      resolve();
    });
  }));

  after(() => new Promise((done) => upstream.server.close(done)));

  const fetchIt = () => PinnedTransport.request({
    url: new URL(`http://127.0.0.1:${upstream.port}/`),
    addresses: [{ address: '127.0.0.1', family: 4 }],
    maxBytes: CAP
  });

  it('reads an answer under the ceiling exactly as before', async () => {
    upstream.mode = 'small';
    const response = await fetchIt();

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  });

  it('refuses a body that declares an oversized length', async () => {
    upstream.mode = 'declared';

    await assert.rejects(fetchIt, (error) => {
      assert.ok(error instanceof ResponseTooLargeError);
      assert.equal(error.code, 'EGRESS_RESPONSE_TOO_LARGE');
      return true;
    });
  });

  /**
   * The case `content-length` does not cover: a server that declares no length,
   * or lies about it. Refused rather than truncated — half a document parses as
   * nothing useful, and handing back a fragment invites a caller to act on it.
   */
  it('refuses a body that declares nothing and streams past the ceiling', async () => {
    upstream.mode = 'streamed';

    await assert.rejects(fetchIt, (error) => error instanceof ResponseTooLargeError);
  });

  it('gives the GenieACS path a ceiling too, where there was none', () => {
    assert.ok(Number.isFinite(GenieAcsEgress.MAX_RESPONSE_BYTES));
    assert.ok(GenieAcsEgress.MAX_RESPONSE_BYTES > 0);
  });
});

/**
 * `POST /api/sgp/test` is the shape that made this worth doing: the SGP base
 * URL arrives in the request body, behind `sgp.config` — a permission every
 * provider admin holds, and on a multi-provider deployment that admin is a
 * tenant rather than the host operator — and the controller hands back the
 * message the far end supplied. Pointed at something internal, the probe
 * answered with that service's own body.
 */
describe('the SGP probe cannot be pointed into our own network', () => {
  const SECRET = 'TOKEN-INTERNO-abc123';
  const internal = { server: null, port: null, hits: [] };
  let panelUrl;
  let token;

  before(async () => {
    await new Promise((resolve) => {
      internal.server = http.createServer((req, res) => {
        internal.hits.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 1, msg: SECRET }));
      });
      internal.server.listen(0, '127.0.0.1', () => {
        internal.port = internal.server.address().port;
        resolve();
      });
    });

    ({ panelUrl } = await startTestServers());
    const setup = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
    });
    token = setup.body.data.token;
  });

  after(async () => {
    await stopTestServers();
    await new Promise((done) => internal.server.close(done));
  });

  afterEach(() => {
    internal.hits.length = 0;
  });

  async function probe(baseUrl) {
    return call(`${panelUrl}/api/sgp/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { baseUrl, app: 'painel', token: 'token-secreto-123' }
    });
  }

  it('refuses a probe aimed at loopback, and reflects nothing back', async () => {
    const { status, body } = await probe(`http://127.0.0.1:${internal.port}`);

    // The hits are asserted first so a hole reports itself as what it is — the
    // request reached an internal service — rather than as a wrong status code.
    assert.deepEqual(internal.hits, [], 'the probe reached the internal service');
    assert.equal(status, 400);
    assert.equal(body.code, 'blocked_host');
    assert.ok(
      !JSON.stringify(body).includes(SECRET),
      `the internal body came back to the caller: ${JSON.stringify(body)}`
    );
  });

  it('refuses the metadata service, and every other spelling of it', async () => {
    for (const baseUrl of [
      'http://169.254.169.254',
      'http://[::1]:8080',
      'http://[::ffff:0:7f00:1]',
      'http://2130706433'
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await probe(baseUrl);
      assert.equal(status, 400, `${baseUrl} was not refused: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'blocked_host', baseUrl);
    }
  });

  it('refuses a name that resolves into our own network', async () => {
    resolvesTo('10.0.0.5');

    const { status, body } = await probe(`https://sgp.${NAME}`);

    assert.equal(status, 400);
    assert.equal(body.code, 'blocked_host');
    // The refusal is deliberately vague: the reader here is one tenant of the
    // deployment, and naming the address would map our private network for them.
    assert.ok(!JSON.stringify(body).includes('10.0.0.5'), 'the refusal named an internal address');
  });
});

