import { tenantInScope } from './logger.js';

/**
 * Counters and one histogram, in memory, with the provider on every series.
 *
 * Small on purpose. A metrics library would bring a registry, a push gateway
 * and a dozen collectors for a process that needs to answer two questions:
 * which provider is generating the load, and which provider's ACS is failing.
 * Both are label lookups, and the labels are bounded — providers are few, and
 * a path never becomes a label, because a path is unbounded and a series per
 * path is how a registry eats the heap.
 *
 * Process-local: two replicas expose two registries, and whatever scrapes
 * them sums. Reset on restart, like every counter that lives in a process.
 */
const NAMESPACE = 'skygenpanel';

// Latency buckets in milliseconds. Coarse, because what an operator wants to
// know is "is this provider's panel slow", not the shape of its p99.
const DURATION_BUCKETS = Object.freeze([25, 100, 250, 1000, 5000]);

const counters = new Map(); // name -> Map(labelKey -> { labels, value })
const histograms = new Map(); // name -> Map(labelKey -> { labels, buckets: number[], sum, count })

function labelKey(labels) {
  return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join(',');
}

function tenantLabel(explicit) {
  const id = explicit ?? tenantInScope();
  return id === null || id === undefined ? '-' : String(id);
}

function bump(name, labels, by = 1) {
  if (!counters.has(name)) counters.set(name, new Map());
  const series = counters.get(name);
  const key = labelKey(labels);
  const entry = series.get(key) ?? { labels, value: 0 };
  entry.value += by;
  series.set(key, entry);
}

function observe(name, labels, value) {
  if (!histograms.has(name)) histograms.set(name, new Map());
  const series = histograms.get(name);
  const key = labelKey(labels);
  const entry = series.get(key) ?? {
    labels, buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0
  };
  DURATION_BUCKETS.forEach((limit, index) => {
    if (value <= limit) entry.buckets[index] += 1;
  });
  entry.sum += value;
  entry.count += 1;
  series.set(key, entry);
}

/** A finished HTTP request. Status is collapsed to its class: `2xx`, `4xx`… */
export function recordHttpRequest({ tenantId, method, status, ms }) {
  const labels = {
    tenant_id: tenantLabel(tenantId),
    method: String(method || 'GET').toUpperCase(),
    status: `${Math.floor(Number(status) / 100)}xx`
  };
  bump('http_requests_total', labels);
  observe('http_request_duration_ms', { tenant_id: labels.tenant_id }, Number(ms) || 0);
}

/**
 * One call to a provider's GenieACS. `outcome` is `ok`, `refused` (the egress
 * guard said no before a socket opened) or `error` (the network or the ACS
 * did). Which provider is read from the context the call runs in.
 */
export function recordAcsRequest({ tenantId, outcome }) {
  bump('acs_requests_total', { tenant_id: tenantLabel(tenantId), outcome: String(outcome) });
}

/** Everything back to zero. For tests, and for nothing else. */
export function resetMetrics() {
  counters.clear();
  histograms.clear();
}

function renderLabels(labels) {
  const parts = Object.keys(labels).sort().map((key) => {
    const value = String(labels[key]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `${key}="${value}"`;
  });
  return parts.length ? `{${parts.join(',')}}` : '';
}

const HELP = Object.freeze({
  http_requests_total: ['counter', 'API requests finished, by provider, method and status class.'],
  http_request_duration_ms: ['histogram', 'API request duration in milliseconds, by provider.'],
  acs_requests_total: ['counter', 'Calls to a provider\'s GenieACS, by outcome.']
});

/**
 * The Prometheus text exposition of everything counted so far.
 *
 * Series are emitted in label order so two scrapes of the same state are the
 * same bytes — which is what makes a diff of two scrapes readable.
 */
export function renderMetrics() {
  const lines = [];
  for (const [name, [type, help]] of Object.entries(HELP)) {
    const full = `${NAMESPACE}_${name}`;
    lines.push(`# HELP ${full} ${help}`, `# TYPE ${full} ${type}`);
    if (type === 'counter') {
      const series = [...(counters.get(name)?.values() ?? [])]
        .sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)));
      for (const { labels, value } of series) lines.push(`${full}${renderLabels(labels)} ${value}`);
    } else {
      const series = [...(histograms.get(name)?.values() ?? [])]
        .sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)));
      for (const { labels, buckets, sum, count } of series) {
        DURATION_BUCKETS.forEach((limit, index) => {
          lines.push(`${full}_bucket${renderLabels({ ...labels, le: String(limit) })} ${buckets[index]}`);
        });
        lines.push(`${full}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${count}`);
        lines.push(`${full}_sum${renderLabels(labels)} ${sum}`);
        lines.push(`${full}_count${renderLabels(labels)} ${count}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Express middleware: counts the request when the response ends. Mounted next
 * to the request logger rather than folded into it, so that turning one off
 * never turns the other off.
 */
export function httpMetrics() {
  return function countRequest(req, res, next) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      recordHttpRequest({
        tenantId: req.tenantId ?? null,
        method: req.method,
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - started) / 1e6
      });
    });
    next();
  };
}
