import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dataDir;
let port;
let baseUrl;
let server;
let serverOutput = '';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy:\n${serverOutput}`);
}

async function request(endpoint, {
  method = 'GET',
  body,
  token,
  origin = baseUrl,
  headers = {}
} = {}) {
  return fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      Origin: origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skygenpanel-api-'));
  port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_ENV: 'production',
      JWT_SECRET: 'integration-test-secret-that-is-long-and-random-enough',
      DATA_DIR: dataDir,
      CORS_ORIGINS: 'http://localhost:5890'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForHealth();
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  if (dataDir) {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('same-origin CORS works and an untrusted origin is rejected', async () => {
  const sameOrigin = await request('/api/auth/setup-status');
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get('access-control-allow-origin'), baseUrl);

  const rejected = await request('/api/auth/setup-status', {
    origin: 'https://attacker.invalid'
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).message, 'Origin is not allowed');
});

test('initial setup is atomic and authentication token types stay separated', async () => {
  const attempts = [
    { username: 'admin-one', password: 'passwordOne123' },
    { username: 'admin-two', password: 'passwordTwo123' }
  ];
  const responses = await Promise.all(attempts.map((body) => request('/api/auth/setup', {
    method: 'POST',
    body
  })));

  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const successIndex = responses.findIndex((response) => response.status === 201);
  const payload = await responses[successIndex].json();
  const credentials = attempts[successIndex];

  assert.equal(payload.success, true);
  assert.ok(payload.data.token);
  assert.ok(payload.data.refreshToken);

  const accessToken = payload.data.token;
  const refreshToken = payload.data.refreshToken;

  const accessRequest = await request('/api/settings', { token: accessToken });
  assert.equal(accessRequest.status, 200);

  const refreshAsAccess = await request('/api/settings', { token: refreshToken });
  assert.equal(refreshAsAccess.status, 403);
  assert.equal((await refreshAsAccess.json()).code, 'invalid_token');

  const refreshed = await request('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken }
  });
  assert.equal(refreshed.status, 200);
  const refreshedPayload = await refreshed.json();
  assert.ok(refreshedPayload.data.token);
  assert.ok(refreshedPayload.data.refreshToken);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: credentials
  });
  assert.equal(login.status, 200);
  const loginPayload = await login.json();

  const emptySetting = await request('/api/settings/appName', {
    method: 'PUT',
    token: loginPayload.data.token,
    body: { value: '' }
  });
  assert.equal(emptySetting.status, 200);

  const getEmptySetting = await request('/api/settings/appName', {
    token: loginPayload.data.token
  });
  assert.equal(getEmptySetting.status, 200);
  assert.equal((await getEmptySetting.json()).data.appName, '');

  const nodeA = await request('/api/mapping-data/nodes', {
    method: 'POST',
    token: loginPayload.data.token,
    body: {
      node_id: 'node-a',
      type: 'odc',
      name: 'Node A',
      latitude: -6.2,
      longitude: 106.8
    }
  });
  assert.equal(nodeA.status, 201);
  const nodeB = await request('/api/mapping-data/nodes', {
    method: 'POST',
    token: loginPayload.data.token,
    body: {
      node_id: 'node-b',
      type: 'odp',
      name: 'Node B',
      latitude: -6.21,
      longitude: 106.81
    }
  });
  assert.equal(nodeB.status, 201);
  const edge = await request('/api/mapping-data/edges', {
    method: 'POST',
    token: loginPayload.data.token,
    body: {
      edge_id: 'edge-a-b',
      source: 'node-a',
      target: 'node-b',
      fiber_type: 'distribution'
    }
  });
  assert.equal(edge.status, 201);

  const reset = await request('/api/mapping-data/reset', {
    method: 'DELETE',
    token: loginPayload.data.token,
    body: { password: credentials.password }
  });
  assert.equal(reset.status, 200);

  const remainingNodes = await request('/api/mapping-data/nodes', {
    token: loginPayload.data.token
  });
  const remainingEdges = await request('/api/mapping-data/edges', {
    token: loginPayload.data.token
  });
  assert.deepEqual((await remainingNodes.json()).data, []);
  assert.deepEqual((await remainingEdges.json()).data, []);
});

test('production error handling, CSP, and static fallback are safe', async () => {
  const invalidJson = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Content-Type': 'application/json'
    },
    body: '{'
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).message, 'Invalid JSON request body');

  const page = await fetch(`${baseUrl}/network-map/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control') || '', /no-cache/);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /tile\.openstreetmap\.org/);
  assert.match(csp, /basemaps\.cartocdn\.com/);
  assert.match(csp, /mt1\.google\.com/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(await page.text(), /<script>self\.__next_f/);

  const missingAsset = await fetch(`${baseUrl}/missing-script.js`);
  assert.equal(missingAsset.status, 404);
});
