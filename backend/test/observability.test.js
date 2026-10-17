import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O provedor em toda linha de log e em toda métrica.
 *
 * Numa instalação de um ISP só, uma linha sem provedor é de quem é dono da
 * máquina. Numa compartilhada, é uma linha que ninguém consegue transformar
 * em ação. Os testes aqui conferem o mecanismo pelos dois lados: o que o
 * módulo escreve e o que sai pela API.
 *
 * SaaS sem domínio-base, para que o `call` do harness (que não põe `Host`)
 * chegue ao provedor da instalação — o mesmo arranjo do console.
 */
process.env.EDITION = 'saas';
process.env.METRICS_TOKEN = 'scrape-token-that-is-at-least-thirty-two-chars';

const { call, authHeaders, getDb, startTestServers, stopTestServers, runInTenant, defaultTenantId } = await import('./helpers/harness.js');
const { log, logLine, setLogSink, installTenantTaggedConsole, tenantInScope } = await import('../src/utils/logger.js');
const { recordAcsRequest, renderMetrics, resetMetrics } = await import('../src/utils/metrics.js');
const { GenieAcsEgress } = await import('../src/services/genieacsEgress.js');

let panelUrl;
let ownerToken;
let commonToken;
let tenantId;

const lines = [];

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  // The SaaS setup already seats the first administrator on the platform.
  if (!(await getDb()('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  const hire = await call(`${panelUrl}/api/users`, {
    method: 'POST', headers: authHeaders(ownerToken),
    body: { username: 'comum', password: 'comum-senha-1', role: 'admin', email: 'comum@exemplo.test' }
  });
  assert.equal(hire.status, 201);
  const signIn = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum', password: 'comum-senha-1', email: 'comum@exemplo.test' }
  });
  commonToken = signIn.body.data.token;
  setLogSink((line) => lines.push(line));
});

after(async () => {
  setLogSink(null);
  await stopTestServers();
});

describe('a log line', () => {
  it('names the provider in scope, and says so when there is none', async () => {
    lines.length = 0;
    log.info('outside');
    await runInTenant(7, async () => log.warn('inside', { device: 'ABC-123', note: 'two words' }));
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+ INFO {2}tenant=- outside$/);
    assert.match(lines[1], /^\S+ WARN {2}tenant=7 inside device=ABC-123 note="two words"$/);
  });

  it('spells an error out and keeps its stack for a person', () => {
    lines.length = 0;
    const boom = new Error('kaput');
    boom.code = 'ECONNRESET';
    log.error('acs_failed', { err: boom });
    assert.match(lines[0], /^\S+ ERROR tenant=- acs_failed err=kaput errName=Error errCode=ECONNRESET\n/);
    assert.match(lines[0], /\n\s+at /);
  });

  it('is one JSON object per line when asked, with tenant_id as a field', async () => {
    lines.length = 0;
    process.env.LOG_FORMAT = 'json';
    try {
      await runInTenant(3, async () => log.info('json_line', { n: 2 }));
    } finally {
      delete process.env.LOG_FORMAT;
    }
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.tenant_id, 3);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.msg, 'json_line');
    assert.equal(parsed.n, 2);
  });

  it('drops what is below LOG_LEVEL', () => {
    lines.length = 0;
    logLine('debug', 'quiet');
    assert.equal(lines.length, 0);
    process.env.LOG_LEVEL = 'debug';
    try {
      logLine('debug', 'loud');
    } finally {
      delete process.env.LOG_LEVEL;
    }
    assert.equal(lines.length, 1);
  });

  it('never throws for the provider when nothing is in scope', () => {
    assert.equal(tenantInScope(), null);
  });
});

describe('the tagged console', () => {
  it('prefixes the provider on every method, inside a context only, and only once', async () => {
    const seen = [];
    const fake = {
      log: (...a) => seen.push(['log', a]),
      info: (...a) => seen.push(['info', a]),
      warn: (...a) => seen.push(['warn', a]),
      error: (...a) => seen.push(['error', a]),
      debug: (...a) => seen.push(['debug', a])
    };
    installTenantTaggedConsole(fake);
    installTenantTaggedConsole(fake); // idempotent: no double prefix below
    fake.log('boot');
    await runInTenant(5, async () => {
      fake.error('failed', 42);
      fake.warn('slow');
    });
    assert.deepEqual(seen, [
      ['log', ['boot']],
      ['error', ['[tenant=5]', 'failed', 42]],
      ['warn', ['[tenant=5]', 'slow']]
    ]);
  });
});

describe('the request log', () => {
  it('writes one http line per request, with the provider and a request id', async () => {
    lines.length = 0;
    const res = await call(`${panelUrl}/api/tenant/public`);
    assert.equal(res.status, 200);
    const line = lines.find((l) => / http /.test(l));
    assert.ok(line, `no http line among: ${lines.join(' | ')}`);
    assert.match(line, new RegExp(`^\\S+ INFO {2}tenant=${tenantId} http req=[0-9a-f-]{36} method=GET path=/api/tenant/public status=200 ms=[0-9.]+ ip=\\S+ host=127.0.0.1$`));
  });

  it('echoes the request id so a screenshot can be matched to a line', async () => {
    const { headers } = await rawHeaders(`${panelUrl}/api/tenant/public`);
    assert.match(headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/);
  });

  it('logs a query-less path', async () => {
    lines.length = 0;
    await call(`${panelUrl}/api/tenant/public?token=should-not-appear`);
    const line = lines.find((l) => / http /.test(l));
    assert.ok(line);
    assert.doesNotMatch(line, /should-not-appear/);
    assert.match(line, / path=\/api\/tenant\/public /);
  });

  it('stays quiet for a healthy probe', async () => {
    lines.length = 0;
    await call(`${panelUrl}/api/health`);
    assert.equal(lines.filter((l) => / http /.test(l)).length, 0);
  });
});

async function rawHeaders(url) {
  const response = await fetch(url);
  await response.text();
  return { headers: Object.fromEntries(response.headers.entries()) };
}

describe('the metrics', () => {
  it('count requests per provider by method and status class, in exposition format', async () => {
    resetMetrics();
    await call(`${panelUrl}/api/tenant/public`);
    await call(`${panelUrl}/api/does-not-exist`);
    const text = renderMetrics();
    assert.match(text, /^# TYPE skygenpanel_http_requests_total counter$/m);
    assert.match(text, new RegExp(`^skygenpanel_http_requests_total\\{method="GET",status="2xx",tenant_id="${tenantId}"\\} 1$`, 'm'));
    assert.match(text, new RegExp(`^skygenpanel_http_requests_total\\{method="GET",status="4xx",tenant_id="${tenantId}"\\} 1$`, 'm'));
    assert.match(text, new RegExp(`^skygenpanel_http_request_duration_ms_count\\{tenant_id="${tenantId}"\\} 2$`, 'm'));
    assert.match(text, new RegExp(`^skygenpanel_http_request_duration_ms_bucket\\{le="\\+Inf",tenant_id="${tenantId}"\\} 2$`, 'm'));
  });

  it('count a GenieACS call by outcome, for the provider in scope', async () => {
    resetMetrics();
    await runInTenant(9, async () => {
      // A private address on the SaaS edition: refused by the egress guard
      // before any socket opens, which is the outcome worth alarming on.
      await assert.rejects(GenieAcsEgress.fetch('http://127.0.0.1:7557/devices'));
    });
    recordAcsRequest({ tenantId: 9, outcome: 'ok' });
    const text = renderMetrics();
    assert.match(text, /^skygenpanel_acs_requests_total\{outcome="refused",tenant_id="9"\} 1$/m);
    assert.match(text, /^skygenpanel_acs_requests_total\{outcome="ok",tenant_id="9"\} 1$/m);
  });

  it('are read by a platform administrator', async () => {
    const response = await fetch(`${panelUrl}/api/platform/metrics`, { headers: authHeaders(ownerToken) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    assert.match(await response.text(), /^# HELP skygenpanel_http_requests_total /m);
  });

  it('are read by a scraper carrying METRICS_TOKEN', async () => {
    const response = await fetch(`${panelUrl}/api/platform/metrics`, {
      headers: { Authorization: `Bearer ${process.env.METRICS_TOKEN}` }
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /tenant_id=/);
  });

  it('are nobody else\'s: a provider administrator sees a route that does not exist', async () => {
    const res = await call(`${panelUrl}/api/platform/metrics`, { headers: authHeaders(commonToken) });
    assert.equal(res.status, 404);
  });

  it('refuse a wrong scraper token, and a right-length wrong one', async () => {
    // 403 and not 401: a bearer was offered, and it is not a session either.
    const wrong = await call(`${panelUrl}/api/platform/metrics`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 403);
    const sameLength = `${process.env.METRICS_TOKEN.slice(0, -1)}X`;
    const near = await call(`${panelUrl}/api/platform/metrics`, { headers: { Authorization: `Bearer ${sameLength}` } });
    assert.equal(near.status, 403);
    const nobody = await call(`${panelUrl}/api/platform/metrics`);
    assert.equal(nobody.status, 401);
  });
});
