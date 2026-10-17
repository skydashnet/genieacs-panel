import { tdb, tinsert, withDeadlockRetry } from '../config/database.js';

class SgpLink {
  static async getByDeviceId(deviceId) {
    return (await tdb('sgp_links').where({ device_id: deviceId }).first()) || null;
  }

  static async getByAccountId(accountId) {
    return (await tdb('sgp_links').where({ account_id: accountId }).first()) || null;
  }

  static async upsert(link) {
    const now = new Date();
    // The conflict target is the composite unique, not `device_id` alone:
    // since 0017 the same device id exists once per provider, and two providers
    // reading one ACS do see the same ids. On MySQL the target is ignored
    // either way, so naming it wrongly is invisible there and fails loudly on
    // SQLite and Postgres.
    // The fleet sync writes several links at once; on MySQL two of these
    // upserts can deadlock, and the one the database drops is safe to repeat.
    await withDeadlockRetry(() => tinsert('sgp_links', { ...link, updated_at: now })
      .onConflict(['tenant_id', 'device_id'])
      .merge({ ...link, updated_at: now }));
    return this.getByDeviceId(link.device_id);
  }

  static async deleteByDeviceId(deviceId) {
    const affected = await tdb('sgp_links').where({ device_id: deviceId }).del();
    return affected > 0;
  }

  static async getByDeviceIds(deviceIds) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return [];
    return tdb('sgp_links').whereIn('device_id', deviceIds);
  }

  /** One contract can cover several CPEs, so an event fans out to all of them. */
  static async getByContract(contract) {
    if (!contract) return [];
    return tdb('sgp_links').where({ contract: String(contract) }).orderBy('id', 'asc');
  }

  /**
   * The operator's correction to a subscriber's number, written on every ONT
   * the contract covers.
   *
   * All of them, not just one: the reader collapses `sgp_links` to one
   * subscriber per contract and keeps whichever row sorts first by `device_id`,
   * so correcting a single row would leave the panel showing the old number
   * whenever a different ONT happened to sort ahead of it.
   *
   * `null` clears the override; nothing else in the row is touched, because
   * everything else in it belongs to the ERP.
   */
  static async setManualPhone(contract, phone) {
    return tdb('sgp_links')
      .where({ contract: String(contract) })
      .update({ phone_manual: phone, updated_at: new Date() });
  }

  /**
   * Carries a contract's link from the ONT that was replaced onto the one that
   * replaced it.
   *
   * An update rather than a delete and a fresh `upsert`: the row holds two
   * things the ERP did not put there — `phone_manual`, the operator's
   * correction to the subscriber's number, and `link_mode: 'manual'`, which
   * says reconciliation must not overwrite the binding. Rebuilding the row from
   * a contract lookup would discard both without any error, and the operator
   * would find the correction gone with nothing to explain it.
   *
   * When the replacement already has a link of its own there is nothing to
   * carry: the old row is dropped so it stops pointing at equipment that is out
   * of service. The manual phone does not need carrying over in that case —
   * `setManualPhone` writes it on every row of the contract, so a link for the
   * same contract already has it, and a link for a different contract belongs
   * to another subscriber and must not inherit it.
   */
  static async moveDevice(previousDeviceId, deviceId) {
    const previous = await tdb('sgp_links').where({ device_id: previousDeviceId }).first();
    if (!previous) return { action: 'none', link: null };

    const target = await tdb('sgp_links').where({ device_id: deviceId }).first();
    if (target) {
      await tdb('sgp_links').where({ id: previous.id }).del();
      return { action: 'cleared', link: target };
    }

    await tdb('sgp_links')
      .where({ id: previous.id })
      .update({ device_id: deviceId, updated_at: new Date() });
    return { action: 'moved', link: await this.getByDeviceId(deviceId) };
  }

  /** Round-robin page used by reconciliation so no link is starved. */
  static async listAfterId(afterId = 0, limit = 25) {
    return tdb('sgp_links')
      .where('id', '>', Number(afterId) || 0)
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 200));
  }

  static async count() {
    const [row] = await tdb('sgp_links').count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  /** The links of several contracts at once — one `IN`, for the billing cadence. */
  static async getByContracts(contracts) {
    if (!Array.isArray(contracts) || contracts.length === 0) return [];
    return tdb('sgp_links').whereIn('contract', contracts.map(String)).orderBy('device_id', 'asc');
  }

  static async getAll() {
    return tdb('sgp_links').orderBy('device_id', 'asc');
  }
}

export default SgpLink;
