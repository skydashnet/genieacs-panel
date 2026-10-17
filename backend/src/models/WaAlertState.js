import { getDb, tdb, tinsert, tinsertReturningId } from '../config/database.js';

/**
 * The set of technical conditions the panel currently believes are firing.
 *
 * This is a STATE table, not a log. One row per `(rule, subject)` while the
 * condition holds, and the row is deleted the moment it recovers. Keeping
 * cleared rows around was the obvious alternative and it is worse twice over:
 * the cooldown check would have to reason about which of several rows for the
 * same subject is the live one, and the table would gain a row for every ONT
 * that ever blinked, forever, on a fleet that has thousands of them.
 *
 * What the row is for is noise control. `last_notified_at` and `notify_count`
 * are the whole point of persisting anything: an ONT that stays down for a
 * weekend must produce one message and then a message per cooldown window, not
 * one per scan. An alert that repeats every scan stops being read, and the one
 * that mattered goes unread with it.
 */
class WaAlertState {
  /** `wa_alert_state.subject` is 255 wide; a longer device id is truncated. */
  static SUBJECT_LIMIT = 255;

  static subjectOf(value) {
    return String(value ?? '').slice(0, this.SUBJECT_LIMIT);
  }

  /**
   * Every open condition, in one query.
   *
   * The scan reconciles a whole fleet against this, so it reads the table once
   * and indexes it in memory. Asking per device would be one round trip per
   * ONT per scan, which on a real fleet is thousands of queries every few
   * minutes to discover that nothing changed.
   */
  static async listOpen() {
    return tdb('wa_alert_state').where({ state: 'firing' }).orderBy('id');
  }

  static async get(rule, subject) {
    return (
      (await tdb('wa_alert_state')
        .where({ rule, subject: this.subjectOf(subject) })
        .first()) || null
    );
  }

  /**
   * Opens a condition, or reopens one whose row somehow survived recovery.
   *
   * The upsert is not decorative: two scans can overlap (a manual
   * `POST /alerts/scan` while the loop is mid-pass), and the unique index on
   * `(tenant_id, rule, subject)` is what makes that safe. Losing the race must
   * not throw.
   */
  static async open({ rule, subject, now = new Date() }) {
    const key = { rule, subject: this.subjectOf(subject) };
    const existing = await this.get(rule, key.subject);
    if (existing) {
      await tdb('wa_alert_state').where({ id: existing.id }).update({
        state: 'firing',
        fired_at: now,
        cleared_at: null,
        updated_at: now
      });
      return this.get(rule, key.subject);
    }
    await tinsertReturningId('wa_alert_state', {
      ...key,
      state: 'firing',
      fired_at: now,
      cleared_at: null,
      last_notified_at: null,
      notify_count: 0,
      created_at: now,
      updated_at: now
    });
    return this.get(rule, key.subject);
  }

  /**
   * Records that a message actually went out for this condition.
   *
   * The counter is bumped in the same UPDATE as the timestamp rather than with
   * a separate `increment()`: the two values are one fact, and a crash between
   * two statements would leave a row that looks notified but is not counted.
   */
  static async markNotified(id, now = new Date()) {
    await tdb('wa_alert_state').where({ id }).update({
      last_notified_at: now,
      notify_count: getDb().raw('notify_count + 1'),
      updated_at: now
    });
    return (await tdb('wa_alert_state').where({ id }).first()) || null;
  }

  /** The condition recovered. The row goes with it — see the class comment. */
  static async clear(rule, subject) {
    return tdb('wa_alert_state')
      .where({ rule, subject: this.subjectOf(subject) })
      .del();
  }

  static async removeById(id) {
    return tdb('wa_alert_state').where({ id }).del();
  }
}

export default WaAlertState;
