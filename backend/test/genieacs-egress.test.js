import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The edition has to be chosen before anything reads it, and `edition.js` reads
// it once at module load. Static imports are hoisted above every statement in
// the file, so everything under test is pulled in dynamically below — the same
// shape `edition-saas.test.js` uses.
process.env.EDITION = 'saas';

const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { asTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

/**
 * An address in the documentation range: routable as far as any blocklist is
 * concerned, so it stands in for "the customer's real ACS" without the tests
 * ever reaching the network. Nothing here connects to it.
 */
const PUBLIC_ADDRESS = '203.0.113.7';

/** A port the allowlist accepts, so a port failure cannot be mistaken for an address one. */
const ALLOWED_PORT = 7557;

const realLookup = GenieAcsEgress.lookup;

/** Stands the resolver up with a scripted sequence of answers, and counts the calls. */
function scriptLookup(...answers) {
  const calls = [];
  GenieAcsEgress.lookup = async (hostname) => {
    calls.push(hostname);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return calls;
}

afterEach(() => {
  GenieAcsEgress.lookup = realLookup;
});

describe('the resolved address decides whether the request happens', () => {
  // Each of these is a way of naming something the panel's own network can
  // reach and no customer's ACS ever is. They are listed as resolver answers
  // rather than as URLs because that is the form the attack takes: the name in
  // the settings row looks ordinary, and the zone answers with one of these.
  const refused = [
    ['loopback', '127.0.0.1'],
    ['loopback, anywhere in 127/8', '127.9.9.9'],
    ['the unspecified address', '0.0.0.0'],
    ['private 10/8', '10.0.0.5'],
    ['private 172.16/12, at the bottom', '172.16.0.1'],
    ['private 172.16/12, at the top', '172.31.255.254'],
    ['private 192.168/16', '192.168.1.1'],
    ['link-local, where the metadata service lives', '169.254.169.254'],
    ['carrier-grade NAT, at the bottom', '100.64.0.1'],
    ['carrier-grade NAT, at the top', '100.127.255.254'],
    ['IPv6 loopback', '::1'],
    ['an IPv6 unique local address', 'fc00::1'],
    ['an IPv6 unique local address in fd00::/8', 'fd12:3456:789a::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['loopback written as an IPv4-mapped IPv6 address', '::ffff:127.0.0.1'],
    ['private 10/8 written as an IPv4-mapped IPv6 address', '::ffff:10.0.0.5'],
    ['the metadata service written as an IPv4-mapped IPv6 address', '::ffff:169.254.169.254']
  ];

  for (const [what, address] of refused) {
    it(`refuses ${what} (${address})`, async () => {
      scriptLookup([address]);

      await assert.rejects(
        GenieAcsEgress.resolveTarget(`http://acs.example.invalid:${ALLOWED_PORT}/devices`),
        (error) => {
          assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
          assert.ok(
            error.message.includes(address),
            `the refusal must name the address it refused: ${error.message}`
          );
          return true;
        }
      );
    });
  }

  it('refuses a loopback address named outright, with no name to resolve', async () => {
    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://127.0.0.1:${ALLOWED_PORT}/devices`),
      (error) => error.code === 'GENIEACS_EGRESS_REFUSED'
    );
  });

  it('refuses an IPv6 loopback literal in its bracketed URL form', async () => {
    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://[::1]:${ALLOWED_PORT}/devices`),
      (error) => error.code === 'GENIEACS_EGRESS_REFUSED'
    );
  });

  // A name that answers with one good address and one bad one is the cheapest
  // rebinding there is: no second lookup is needed, because a client that walks
  // the list on a failed connect gets there on its own.
  it('refuses a name that answers with a public address and a private one', async () => {
    scriptLookup([PUBLIC_ADDRESS, '10.1.2.3']);

    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://acs.example.invalid:${ALLOWED_PORT}/devices`),
      (error) => {
        assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
        assert.match(error.message, /10\.1\.2\.3/);
        return true;
      }
    );
  });

  it('accepts a public address and hands back exactly what it vetted', async () => {
    scriptLookup([PUBLIC_ADDRESS]);

    const target = await GenieAcsEgress.resolveTarget(`http://acs.example.invalid:${ALLOWED_PORT}/devices`);

    assert.equal(target.hostname, 'acs.example.invalid');
    assert.equal(target.port, ALLOWED_PORT);
    assert.deepEqual(target.addresses, [{ address: PUBLIC_ADDRESS, family: 4 }]);
  });

  it('refuses a name that resolves to nothing at all', async () => {
    GenieAcsEgress.lookup = async () => [];

    await assert.rejects(
      GenieAcsEgress.resolveTarget(`http://acs.example.invalid:${ALLOWED_PORT}/devices`),
      /did not resolve/
    );
  });
});

describe('only a handful of ports are reachable', () => {
  for (const port of [80, 443, 7557, 8080]) {
    it(`allows ${port}`, async () => {
      scriptLookup([PUBLIC_ADDRESS]);
      const target = await GenieAcsEgress.resolveTarget(`http://acs.example.invalid:${port}/devices`);
      assert.equal(target.port, port);
    });
  }

  // Without a list the "test connection" button is a port scanner pointed at
  // whatever our network runs: the panel reports refused or connected for each.
  for (const port of [22, 3306, 5432, 6379, 9200, 11211]) {
    it(`refuses ${port}`, async () => {
      scriptLookup([PUBLIC_ADDRESS]);

      await assert.rejects(
        GenieAcsEgress.resolveTarget(`http://acs.example.invalid:${port}/devices`),
        (error) => {
          assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
          assert.match(error.message, new RegExp(`port ${port} is not allowed`));
          return true;
        }
      );
    });
  }

  it('refuses a disallowed port before it ever asks the resolver', async () => {
    const calls = scriptLookup([PUBLIC_ADDRESS]);

    await assert.rejects(GenieAcsEgress.resolveTarget('http://acs.example.invalid:22/devices'));

    assert.deepEqual(calls, [], 'a refused port must not become a DNS query');
  });

  it('takes the port from the scheme when the URL omits it', async () => {
    scriptLookup([PUBLIC_ADDRESS]);
    assert.equal((await GenieAcsEgress.resolveTarget('https://acs.example.invalid/devices')).port, 443);
    assert.equal((await GenieAcsEgress.resolveTarget('http://acs.example.invalid/devices')).port, 80);
  });
});

/**
 * A host bound to loopback on an allowed port: what a rebinding answer is
 * trying to reach, and the only thing in these tests that can record a hit.
 */
const internal = { server: null, port: null, hits: [] };

describe('a request whose name turns private never leaves', () => {
  /**
   * Uma porta FIXA, e é o único servidor da suíte inteira que precisa disso: a
   * edição SaaS só deixa o egresso sair por 80, 443, 7557 ou 8080, então
   * `listen(0)` — o que todos os outros arquivos fazem — daria uma porta que o
   * próprio guarda recusaria, e o teste passaria pelo motivo errado.
   *
   * Porta fixa colide, e a colisão custou meses. Sem o `once('error')` abaixo,
   * um `EADDRINUSE` fazia esta Promise **nunca resolver**: o `before` ficava
   * pendurado, o event loop esvaziava, e o `node --test` cancelava o arquivo
   * inteiro com "Promise resolution is still pending but the event loop has
   * already resolved" — mensagem que não nomeia porta, arquivo nem causa, e que
   * no CI aparecia como um vermelho aleatório sem relação com o que estava
   * sendo mudado. Era uma das duas causas do "flake" da suíte.
   *
   * As duas coisas juntas fecham o buraco: tenta cada porta permitida em vez de
   * insistir numa, e falha DIZENDO o que houve quando nenhuma serve.
   */
  before(async () => {
    const candidatas = [ALLOWED_PORT, 8080];
    let ultimoErro = null;
    for (const porta of candidatas) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          internal.server = http.createServer((req, res) => {
            internal.hits.push(req.url);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
          });
          internal.server.once('error', reject);
          internal.server.listen(porta, '127.0.0.1', resolve);
        });
        ultimoErro = null;
        break;
      } catch (error) {
        ultimoErro = error;
        internal.server = null;
      }
    }
    if (ultimoErro) {
      throw new Error(
        `nenhuma porta permitida disponível (${candidatas.join(', ')}): ${ultimoErro.message}`
      );
    }
    internal.port = internal.server.address().port;
  });

  after(async () => {
    if (internal.server) await new Promise((done) => internal.server.close(done));
  });

  afterEach(() => {
    internal.hits.length = 0;
  });

  /**
   * The rebinding shape, at the level the guard sees it: the name is public the
   * first time it is asked and loopback every time after. The assertion that
   * matters is the call count. One lookup means the address that was vetted is
   * the address the socket got; two would mean the second answer — the attacker's
   * — decided where the request went, and no amount of checking the first one
   * would have mattered.
   */
  it('asks the resolver once, so the second answer cannot redirect it', async () => {
    const calls = scriptLookup([PUBLIC_ADDRESS], ['127.0.0.1']);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      await GenieAcsEgress
        .fetch(`http://acs.rebind.invalid:${ALLOWED_PORT}/devices`, { signal: controller.signal })
        .then(() => null, (error) => error);
    } finally {
      clearTimeout(timer);
    }

    assert.equal(calls.length, 1, `the name was resolved ${calls.length} times, not once`);
    assert.deepEqual(internal.hits, [], 'the second, private answer decided where the request went');
  });

  it('refuses outright when the first answer is already private', async () => {
    scriptLookup(['127.0.0.1']);

    await assert.rejects(
      GenieAcsEgress.fetch(`http://acs.rebind.invalid:${ALLOWED_PORT}/devices`),
      (error) => error.code === 'GENIEACS_EGRESS_REFUSED'
    );

    assert.deepEqual(internal.hits, [], 'the request reached the loopback host anyway');
  });
});

describe('the guard is on the path DeviceService actually takes', () => {
  before(async () => {
    await startTestServers();
    await asTenant(() => Setting.upsert('genieAcsUrl', `http://acs.settings.invalid:${ALLOWED_PORT}`));
  });

  after(async () => {
    await stopTestServers();
  });

  // Wiring, not logic: the classes above are proven on the guard itself, and
  // this is the assertion that the guard is what the device path goes through
  // rather than a module nobody calls.
  it('refuses a device fetch whose configured host resolves to loopback', async () => {
    scriptLookup(['127.0.0.1']);

    await assert.rejects(
      asTenant(() => DeviceService.fetchFromGenieAcs('')),
      (error) => {
        assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
        return true;
      }
    );
  });

  it('refuses a collection fetch the same way', async () => {
    scriptLookup(['169.254.169.254']);

    await assert.rejects(
      asTenant(() => DeviceService.fetchGenieAcsCollection('faults')),
      (error) => {
        assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
        return true;
      }
    );
  });

  it('refuses a device deletion the same way', async () => {
    scriptLookup(['10.0.0.5']);

    await assert.rejects(
      asTenant(() => DeviceService.deleteDevice('stub-device-1')),
      (error) => {
        assert.equal(error.code, 'GENIEACS_EGRESS_REFUSED');
        return true;
      }
    );
  });
});
