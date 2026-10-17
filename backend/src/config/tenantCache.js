import { currentTenantId } from './tenantContext.js';

/**
 * A time-boxed cache holding one entry per provider.
 *
 * Four services cached their configuration in a single `{ value, expiresAt }`
 * field on the class. That was right while the table underneath held one row
 * for the deployment; it stopped being right the moment the configuration
 * became per provider, and two of those caches hold decrypted secrets — the
 * SGP token and webhook secret, the Evolution admin key. A second provider
 * reading the first provider's cache is not a stale read, it is a credential
 * leak.
 *
 * Keeping the provider in the key rather than in each caller is what makes
 * that structural instead of remembered.
 */
export class TenantCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  /** The provider's own entry, or null when absent or expired. */
  get() {
    const entry = this.entries.get(currentTenantId());
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  set(value) {
    this.entries.set(currentTenantId(), { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  /** Forget this provider's entry — its configuration just changed. */
  invalidate() {
    this.entries.delete(currentTenantId());
  }

  /**
   * Forget every provider's entry.
   *
   * For a reset between tests, and for the rare change that is not one
   * provider's to make. Not the same as `invalidate()`, and the difference
   * matters: clearing everything because one provider saved its settings would
   * hand every other provider a needless round trip.
   */
  clear() {
    this.entries.clear();
  }
}
