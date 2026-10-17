import { currentTenantId } from '../../config/tenantContext.js';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How many ACS requests may be in flight at once, in total and per provider.
 *
 * The dashboard read fetches a provider's whole device collection, and the plan
 * is blunt about where that goes: 20k ONTs is already several megabytes parsed
 * per minute for ONE ISP, and this process serves dozens. Without a ceiling the
 * failure is not a slow dashboard, it is every provider's request queued behind
 * one provider's fleet — a single tenant's ACS going slow stalls the panel for
 * everyone, which is precisely the noisy-neighbour failure the hosted edition
 * cannot have.
 *
 * The per-provider cap is the one that does the isolating; the global cap is
 * what keeps the process's own sockets and heap bounded when many providers are
 * busy at once.
 */
export const GLOBAL_LIMIT = positiveInt(process.env.GENIEACS_MAX_CONCURRENCY, 32);
export const TENANT_LIMIT = positiveInt(process.env.GENIEACS_MAX_CONCURRENCY_PER_TENANT, 6);

/** A counting semaphore whose waiters are served in arrival order. */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.inFlight = 0;
    this.waiting = [];
  }

  acquire() {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    // The slot is handed straight to the next waiter rather than freed and
    // re-taken: releasing first would let a caller arriving in between jump the
    // queue, which under sustained load is indistinguishable from starvation.
    if (next) next();
    else this.inFlight -= 1;
  }

  get idle() {
    return this.inFlight === 0 && this.waiting.length === 0;
  }
}

const globalGate = new Semaphore(GLOBAL_LIMIT);
const tenantGates = new Map();

function gateFor(tenantId) {
  let gate = tenantGates.get(tenantId);
  if (!gate) {
    gate = new Semaphore(TENANT_LIMIT);
    tenantGates.set(tenantId, gate);
  }
  return gate;
}

/**
 * Runs `fn` holding one of this provider's slots and one global slot.
 *
 * The two are always taken in the same order — provider first, then global —
 * because two callers taking them in opposite orders is the textbook way to
 * deadlock a pair of semaphores. Taking the provider's slot first is also what
 * bounds a provider's share of the global pool to its own cap, so a fleet-wide
 * sweep cannot occupy every global slot while other providers wait.
 */
export async function withAcsSlot(fn) {
  const tenantId = currentTenantId();
  const gate = gateFor(tenantId);

  await gate.acquire();
  try {
    await globalGate.acquire();
    try {
      return await fn();
    } finally {
      globalGate.release();
    }
  } finally {
    gate.release();
    // A provider that has gone quiet should not keep a Map entry alive: the
    // panel's provider count only grows, and a per-provider structure that is
    // never removed from is a slow leak by another name.
    if (gate.idle && tenantGates.get(tenantId) === gate) tenantGates.delete(tenantId);
  }
}

/** For tests: how many slots this provider is holding right now. */
export function inFlightForTenant() {
  return tenantGates.get(currentTenantId())?.inFlight ?? 0;
}

/** For tests, between cases. */
export function resetAcsConcurrency() {
  tenantGates.clear();
  globalGate.inFlight = 0;
  globalGate.waiting = [];
}
