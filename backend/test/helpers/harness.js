import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every environment variable the application reads at import time has to be in
// place before the modules under test are loaded, so the imports below are
// deliberately dynamic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-test-'));
process.env.DATA_DIR = dataDir;
process.env.APP_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-production-rules';
process.env.PORTAL_JWT_SECRET = 'test-portal-secret-that-is-long-enough-for-tests';
process.env.CORS_ORIGINS = 'http://localhost:5890';
// Assigned rather than deleted: dotenv does not overwrite variables that are
// already set, so an unset value would be repopulated from a developer's .env.
process.env.TRUST_PROXY = '0';
process.env.PORTAL_COOKIE_SECURE = 'auto';

// SQLite unless the run asks for another dialect. Pointed at a server, every
// suite would otherwise share one database: `node --test` runs files in
// parallel, so each process claims its own namespace and drops it on the way
// out. Postgres namespaces with a schema inside the shared database; MySQL has
// no such thing, so there the namespace is a database of its own.
const TEST_DB_CLIENT = process.env.TEST_DB_CLIENT || 'sqlite3';
const IS_SERVER_DB = TEST_DB_CLIENT !== 'sqlite3';
const testNamespace = `skygp_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

const serverConnection = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT) || undefined,
  user: process.env.TEST_DB_USER,
  password: process.env.TEST_DB_PASSWORD || ''
};

if (IS_SERVER_DB) {
  fs.writeFileSync(path.join(dataDir, 'db-config.json'), JSON.stringify({
    client: TEST_DB_CLIENT,
    ...serverConnection,
    database: TEST_DB_CLIENT === 'pg' ? process.env.TEST_DB_NAME : testNamespace,
    ...(TEST_DB_CLIENT === 'pg' ? { schema: testNamespace } : {})
  }));
}

const { app, portalApp } = await import('../../src/app.js');
const { ensureSchema } = await import('../../src/config/schema.js');
const { seedDefaults } = await import('../../src/config/seed.js');
const { getDb, closePool, insertReturningId } = await import('../../src/config/database.js');
const { runInTenant } = await import('../../src/config/tenantContext.js');
const { agentHub, attachAgentHub } = await import('../../src/services/genieacs/agentHub.js');

// Re-exported so fixtures reach for the same dialect-aware helper the models
// use: `const [id] = await knex(...).insert(...)` only yields an id on SQLite
// and MySQL, so a fixture written that way passes locally and fails on Postgres.
export { app, portalApp, getDb, insertReturningId, runInTenant };

/**
 * Runs a fixture as the installation's own provider — what a request resolves
 * to. Setup that writes to a scoped table needs it, because a model reached
 * outside a request has no provider and refuses to guess.
 */
export async function asTenant(fn) {
  const tenant = await getDb()('tenants').orderBy('id', 'asc').first();
  if (!tenant) throw new Error('no provider exists; run the migrations first');
  return runInTenant(tenant.id, fn);
}

/** The installation's own provider id. */
export async function defaultTenantId() {
  const tenant = await getDb()('tenants').orderBy('id', 'asc').first();
  return tenant?.id ?? null;
}

const listeners = [];

function listen(target) {
  return new Promise((resolve) => {
    const server = target.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Boots a fresh schema plus both listeners and returns their base URLs.
 * `beforeSchema` runs first, so a test can lay down an older table layout and
 * exercise the upgrade path.
 */
export async function startTestServers({ beforeSchema } = {}) {
  await createNamespace();
  if (beforeSchema) await beforeSchema(getDb());
  await ensureSchema();
  await seedDefaults();
  const [panel, portal] = await Promise.all([listen(app), listen(portalApp)]);
  // O agente do GenieACS no servidor do painel, como em `server.js`: os testes
  // do modo agente exercitam o upgrade de verdade, e não um atalho.
  attachAgentHub(panel);
  listeners.push(panel, portal);
  return {
    panelUrl: `http://127.0.0.1:${panel.address().port}`,
    portalUrl: `http://127.0.0.1:${portal.address().port}`
  };
}

/**
 * A connection to the server itself rather than to this process's namespace,
 * since a database cannot create or drop itself.
 */
async function withServerConnection(fn) {
  const { default: knexFactory } = await import('knex');
  const admin = knexFactory({
    client: TEST_DB_CLIENT,
    connection: TEST_DB_CLIENT === 'pg'
      ? { ...serverConnection, database: process.env.TEST_DB_NAME }
      : serverConnection
  });
  try {
    await fn(admin);
  } finally {
    await admin.destroy();
  }
}

async function createNamespace() {
  if (!IS_SERVER_DB) return;
  await withServerConnection((admin) => admin.raw(
    TEST_DB_CLIENT === 'pg'
      ? 'CREATE SCHEMA IF NOT EXISTS ??'
      : 'CREATE DATABASE IF NOT EXISTS ??',
    [testNamespace]
  ));
}

async function dropNamespace() {
  if (!IS_SERVER_DB) return;
  await withServerConnection((admin) => admin.raw(
    TEST_DB_CLIENT === 'pg'
      ? 'DROP SCHEMA IF EXISTS ?? CASCADE'
      : 'DROP DATABASE IF EXISTS ??',
    [testNamespace]
  ));
}

export async function stopTestServers() {
  // Antes dos servidores: um WebSocket de agente aberto seria uma conexão que
  // o `server.close` esperaria para sempre.
  agentHub.close();
  await Promise.all(listeners.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve))
  ));
  // After closePool, so nothing is still connected to what is being dropped.
  await closePool();
  await dropNamespace();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/** fetch wrapper that always returns the parsed body alongside the response. */
export async function call(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual'
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, status: response.status, body };
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}
