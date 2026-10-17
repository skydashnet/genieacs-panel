import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, startTestServers, stopTestServers } from './helpers/harness.js';

// Deliberately does not set EDITION: the point is that an install which sets
// nothing keeps every capability it had before the flag existed.
let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('self-hosted edition', () => {
  // The counterpart to edition-saas.test.js. Without this, that suite's 404s
  // would still pass if the route had been deleted outright instead of gated.
  it('mounts the database management routes', async () => {
    const { status } = await call(`${panelUrl}/api/database/config`);
    assert.equal(status, 401, 'route should exist and merely require a session');
  });
});
