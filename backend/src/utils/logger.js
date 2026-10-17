import { randomUUID } from 'node:crypto';
import { currentContext, runInTenant } from '../config/tenantContext.js';

/**
 * One line per event, and the provider on every line.
 *
 * On a self-hosted install a log line belongs to the one ISP that owns the
 * box, so nobody had to say so. On a deployment shared by many, a line that
 * does not name its provider is a line nobody can act on: "GenieACS timed out"
 * is a page for somebody, and the somebody is the whole message. The provider
 * is read from the same context the queries read it from, so anything that
 * runs inside a request or a per-provider job carries it without being told.
 *
 * Two formats: `text` (logfmt-shaped, for a terminal and for journald) and
 * `json` (one object per line, for whatever collects the SaaS's logs). Chosen
 * by `LOG_FORMAT`, read per call so a test can flip it. `LOG_LEVEL` drops what
 * is below it; `debug` is off unless asked for.
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function minimumLevel() {
  return LEVELS[String(process.env.LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;
}

function format() {
  return String(process.env.LOG_FORMAT || '').toLowerCase() === 'json' ? 'json' : 'text';
}

/** The provider in scope, or null. Never throws: a log line must not be what breaks a request. */
export function tenantInScope() {
  const context = currentContext();
  return Number.isInteger(context?.tenantId) ? context.tenantId : null;
}

// Where lines go. A test swaps this to read them back; the default is stdout
// for the quiet levels and stderr for the ones a supervisor should notice.
let sink = null;

export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

function emit(level, line) {
  if (sink) return sink(line, level);
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function describeError(error) {
  if (!(error instanceof Error)) return { err: String(error) };
  const out = { err: error.message, errName: error.name };
  if (error.code) out.errCode = error.code;
  if (error.stack) out.stack = error.stack;
  return out;
}

/** logfmt quoting: bare when it is one safe token, double-quoted otherwise. */
function quote(value) {
  if (value === null || value === undefined) return '-';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text) && text !== '') return text;
  return JSON.stringify(text);
}

function normalizeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value instanceof Error) Object.assign(out, describeError(value));
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Writes one line. `fields` is a flat object; an `Error` anywhere in it is
 * spelled out as `err`, `errName`, `errCode` and, in text, its stack on the
 * following lines — where a person reads it — but inline in JSON, where a
 * machine does.
 */
export function logLine(level, msg, fields = {}) {
  if (!LEVELS[level] || LEVELS[level] < minimumLevel()) return;
  const time = new Date().toISOString();
  const tenant = tenantInScope();
  const data = normalizeFields(fields);

  if (format() === 'json') {
    emit(level, JSON.stringify({ time, level, tenant_id: tenant, msg, ...data }));
    return;
  }

  const { stack, ...rest } = data;
  const pairs = Object.entries(rest).map(([key, value]) => `${key}=${quote(value)}`);
  const head = `${time} ${level.toUpperCase().padEnd(5)} tenant=${tenant ?? '-'} ${msg}`;
  const line = pairs.length ? `${head} ${pairs.join(' ')}` : head;
  emit(level, stack ? `${line}\n${stack}` : line);
}

export const log = Object.freeze({
  debug: (msg, fields) => logLine('debug', msg, fields),
  info: (msg, fields) => logLine('info', msg, fields),
  warn: (msg, fields) => logLine('warn', msg, fields),
  error: (msg, fields) => logLine('error', msg, fields)
});

/**
 * Tags the global `console` with the provider in scope.
 *
 * The codebase has a few hundred `console.*` calls that predate the log
 * module, and every one of them is right about what it says and silent about
 * whom it says it for. Rewriting them all would be a diff nobody could
 * review; wrapping the four methods once gives each existing line the same
 * `[tenant=N]` the structured lines carry, from the same context. Idempotent:
 * the second call finds the mark and leaves the wrap alone. Nothing is tagged
 * outside a context, so boot lines and tests look as they did.
 */
const WRAPPED = Symbol.for('skygenpanel.console.tenantTagged');

export function installTenantTaggedConsole(target = console) {
  if (target[WRAPPED]) return target;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      const tenant = tenantInScope();
      return tenant === null ? original(...args) : original(`[tenant=${tenant}]`, ...args);
    };
  }
  Object.defineProperty(target, WRAPPED, { value: true, enumerable: false });
  return target;
}

/**
 * Express middleware: one `http` line per request, when the response ends.
 *
 * `path` is the URL without its query string, because a query is where a
 * caller puts a token when a header is inconvenient. The provider is whatever
 * the request ended up scoped to — the host's answer, or the token's after
 * `authenticateToken` re-scoped it — and `-` when it was refused before
 * either. `host` rides along on the SaaS because it is how a person maps a
 * line back to a customer without looking the id up.
 *
 * Every request gets an id, echoed in `X-Request-Id`, so a screenshot of an
 * error and the line that produced it can be matched. Ours, never the
 * caller's: an id a client can choose is an id a client can collide.
 *
 * `/api/health` is skipped while it answers 200: a probe every thirty seconds
 * is not an event, but a probe that fails is.
 */
export function requestLogger({ skipPath = '/api/health' } = {}) {
  return function httpLog(req, res, next) {
    const started = process.hrtime.bigint();
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);

    res.on('finish', () => {
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      if (path === skipPath && res.statusCode < 400) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const fields = {
        req: req.id,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.ip ?? null,
        host: String(req.headers.host ?? '').split(':')[0] || null
      };
      // `finish` usually fires inside the context the route opened, because
      // the store follows the async chain that called `end()`. Usually is not
      // always — a response drained by the socket later ends elsewhere — so
      // the provider is taken off the request and the line written inside it,
      // the same `tenant=` every other line of that request carries.
      const level = res.statusCode >= 500 ? 'error' : 'info';
      const write = () => logLine(level, 'http', fields);
      if (Number.isInteger(req.tenantId)) runInTenant(req.tenantId, write);
      else write();
    });

    next();
  };
}
