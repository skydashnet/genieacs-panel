import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: DeviceService } = await import('../src/services/deviceService.js');
const { connectorFor } = await import('../src/services/genieacs/connector.js');

// The marker never appears in anything the panel is allowed to say. A response
// carrying it came from a host the operator did not configure, or from a body
// the panel was supposed to keep to itself.
const SECRET = 'INTERNAL-SERVICE-SECRET';

/**
 * Stands in for whatever the panel's own network can reach and the operator
 * never pointed it at — the metadata service, an internal admin API. It is
 * never configured anywhere, so a single recorded request is the whole finding.
 */
const internal = { server: null, url: null, hits: [] };

function startInternalHost() {
  return new Promise((resolve) => {
    internal.server = http.createServer((req, res) => {
      internal.hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: SECRET }));
    });
    internal.server.listen(0, '127.0.0.1', () => {
      internal.url = `http://127.0.0.1:${internal.server.address().port}`;
      resolve();
    });
  });
}

let panelUrl;
let token;
let genie;

before(async () => {
  await startInternalHost();
  genie = await startGenieAcsStub({ devices: [buildDevice()] });
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await call(`${panelUrl}/api/settings/genieAcsUrl`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { value: genie.url }
  });
});

after(async () => {
  await stopTestServers();
  await genie.close();
  await new Promise((done) => internal.server.close(done));
});

afterEach(() => {
  genie.state.respond = null;
  internal.hits.length = 0;
});

describe('the endpoint cannot choose the host', () => {
  it('builds an absolute endpoint under the configured base instead of obeying it', async () => {
    // A afirmação é a mesma de antes; o que mudou foi de quem ela é. A Fase 4
    // tirou de `DeviceService` a montagem de URL: ele devolve um caminho
    // relativo (`devicePath`) e quem resolve o destino é o conector. Continua
    // sendo a raiz configurada que decide o host, e um endpoint que se parece
    // com URL absoluta continua caindo debaixo dela.
    const connector = await asTenant(() => connectorFor());
    const url = await asTenant(() => connector.urlFor(
      DeviceService.devicePath(`${internal.url}/latest/meta-data`)
    ));

    assert.equal(url.origin, new URL(genie.url).origin);
    assert.ok(url.pathname.startsWith('/devices/'), `unexpected path: ${url.pathname}`);
  });

  it('never sends the request to a host named by the endpoint', async () => {
    // The hits are asserted before the rejection so a hole reports itself as
    // "the endpoint picked the host", not as a missing error.
    const attempt = asTenant(() => DeviceService.fetchFromGenieAcs(`${internal.url}/latest/meta-data`));
    const outcome = await attempt.then(() => null, (error) => error);

    assert.deepEqual(internal.hits, [], 'the endpoint chose the host and the request went there');
    assert.ok(outcome instanceof Error, 'a request off the configured base must fail');
  });
});

describe('the upstream failure body stays server-side', () => {
  /** Every route of the configured host fails with a body worth stealing. */
  function failWithSecret() {
    genie.state.respond = ({ res }) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: SECRET }));
    };
  }

  it('reports the device status without the body', async () => {
    failWithSecret();

    await assert.rejects(
      asTenant(() => DeviceService.fetchFromGenieAcs('')),
      (error) => {
        assert.match(error.message, /502/);
        assert.ok(!error.message.includes(SECRET), `body leaked: ${error.message}`);
        return true;
      }
    );
  });

  it('reports the collection status without the body', async () => {
    failWithSecret();

    await assert.rejects(
      asTenant(() => DeviceService.fetchGenieAcsCollection('faults')),
      (error) => {
        assert.match(error.message, /502/);
        assert.ok(!error.message.includes(SECRET), `body leaked: ${error.message}`);
        return true;
      }
    );
  });

  // Nothing here goes through the HTTP API on purpose: `createErrorResponse`
  // only attaches the detail when APP_ENV is development, so a request-level
  // assertion would pass with the leak still in place. The thrown message is
  // the thing that has to be clean — it is what reaches a development install,
  // the logs, and any future caller that surfaces it.
});

describe('the configured host cannot redirect the request elsewhere', () => {
  /** An allowed host answering 302 towards somewhere it is not allowed to send us. */
  function redirectToInternal() {
    genie.state.respond = ({ res }) => {
      res.writeHead(302, { Location: `${internal.url}/latest/meta-data` });
      res.end();
    };
  }

  /**
   * The redirect target is asserted before the error, so a followed redirect
   * reports itself as the reachability problem it is rather than as a missing
   * rejection. The message is checked for the status too: a redirect and an
   * upstream failure are both not-ok under `redirect: 'manual'`, and an
   * operator reading the log has to be able to tell them apart.
   */
  async function assertRefused(run) {
    redirectToInternal();
    const outcome = await run().then(() => null, (error) => error);

    assert.deepEqual(internal.hits, [], 'the redirect was followed off the configured host');
    assert.ok(outcome instanceof Error, 'a redirected request must fail');
    assert.match(outcome.message, /redirect/i);
    assert.match(outcome.message, /302/);
  }

  it('refuses a redirected device request and says so', async () => {
    await assertRefused(() => asTenant(() => DeviceService.fetchFromGenieAcs('')));
  });

  it('refuses a redirected collection request and says so', async () => {
    await assertRefused(() => asTenant(() => DeviceService.fetchGenieAcsCollection('faults')));
  });

  it('refuses a redirected task post, keeping it out of the applied path', async () => {
    await assertRefused(
      () => asTenant(() => DeviceService.postProvisioningTask('stub-device-1', { name: 'reboot' }))
    );
  });
});
