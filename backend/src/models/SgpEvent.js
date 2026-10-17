import { tdb, tinsert } from '../config/database.js';

/** Event view for the API. */
export function publicEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    source: event.source,
    type: event.type,
    rawType: event.raw_type,
    contract: event.contract,
    document: event.document,
    login: event.login,
    deviceId: event.device_id,
    status: event.status,
    attempts: event.attempts,
    payload: event.payload,
    error: event.error,
    occurredAt: event.occurred_at ? new Date(event.occurred_at).toISOString() : null,
    receivedAt: event.received_at ? new Date(event.received_at).toISOString() : null,
    processedAt: event.processed_at ? new Date(event.processed_at).toISOString() : null
  };
}

/**
 * The ERP event log of one provider.
 *
 * Every row carries a subscriber's contract, document (CPF/CNPJ), PPPoE login,
 * device id and a redacted copy of what SGP sent — the heaviest concentration
 * of personal data in the panel. Nothing here reads or writes outside the
 * provider in scope, which is why every method goes through `tdb`/`tinsert`
 * rather than `getDb()`.
 */
class SgpEvent {
  /**
   * Inserts an event unless this provider has already stored its dedupe key. A
   * redelivered webhook must be answered with success rather than an error, or
   * the sender keeps retrying, so the caller needs to know whether the row is
   * new.
   *
   * "This provider has already stored it" is the correction, not a detail.
   * `dedupe_key` was unique deployment-wide while `sgpEventService` builds it
   * from an SGP event id — a per-ERP sequential number. Two ISPs both reach
   * event #12345, so the second one to arrive looked exactly like a redelivery
   * of the first: this method reported `created: false`, the endpoint answered
   * 200 duplicate, and the event was gone with nothing logged anywhere. The
   * lookup and the insert are both scoped now, over 0024's
   * `(tenant_id, dedupe_key)` unique, so a key means "seen before by this
   * provider" instead of "seen before by anyone".
   */
  static async insertIfNew(row) {
    const existing = await this.getByDedupeKey(row.dedupe_key);
    if (existing) return { created: false, event: existing };
    try {
      await tinsert('sgp_events', row);
    } catch (error) {
      // Two deliveries of the same event in flight at once: the unique index
      // decides, and the loser reports the row the winner stored. The return
      // value of `onConflict().ignore()` cannot be used for this, since SQLite
      // and MySQL disagree on what it reports for an ignored insert.
      const stored = await this.getByDedupeKey(row.dedupe_key);
      if (!stored) throw error;
      return { created: false, event: stored };
    }
    return { created: true, event: await this.getByDedupeKey(row.dedupe_key) };
  }

  static async getById(id) {
    return (await tdb('sgp_events').where({ id }).first()) || null;
  }

  static async getByDedupeKey(dedupeKey) {
    return (await tdb('sgp_events').where({ dedupe_key: dedupeKey }).first()) || null;
  }

  static async list({ status = null, type = null, contract = null, limit = 25 } = {}) {
    const query = tdb('sgp_events').orderBy('id', 'desc');
    if (status) query.where({ status });
    if (type) query.where({ type });
    // A contract number is the provider's own sequence, so the same one exists
    // at two ISPs and names two different subscribers there.
    if (contract) query.where({ contract });
    return query.limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
  }

  static async getPending(limit = 20) {
    return tdb('sgp_events')
      .where({ status: 'pending' })
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 100));
  }

  static async update(id, patch) {
    await tdb('sgp_events').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async countByStatus() {
    const rows = await tdb('sgp_events').select('status').count({ total: '*' }).groupBy('status');
    return rows.reduce((acc, row) => ({ ...acc, [row.status]: Number(row.total) }), {});
  }

  /**
   * Drops this provider's settled history past its retention window.
   *
   * The scope is the whole point of this one. With no identity column in the
   * WHERE, a retention of thirty days configured by one ISP deleted every other
   * ISP's processed and ignored events on the same deployment — a destructive
   * write that leaves nothing behind to notice it happened.
   */
  static async pruneOlderThan(date) {
    return tdb('sgp_events')
      .whereIn('status', ['processed', 'ignored'])
      .where('updated_at', '<', date)
      .del();
  }
}

export default SgpEvent;
