import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * WhatsApp numbers connected through the Evolution API.
 *
 * Rows carry two encrypted secrets and neither ever leaves the server. Callers
 * that need to hand an account to the browser must go through
 * `whatsappConfigService.publicAccount()`, which builds the safe shape field by
 * field — the same reason `evolutionApi.readInstances()` does not spread the
 * server's response.
 */
class WhatsAppAccount {
  static async getAll() {
    return tdb('whatsapp_accounts').orderBy([{ column: 'is_default', order: 'desc' }, { column: 'id' }]);
  }

  static async getById(id) {
    return (await tdb('whatsapp_accounts').where({ id }).first()) || null;
  }

  /**
   * The webhook resolves the account from the instance name in the payload.
   *
   * Deliberately not scoped, and it must stay that way: an Evolution webhook
   * arrives with no session, so this lookup is what tells us which provider the
   * event belongs to. Scoping it would mean already knowing the answer. The
   * name is minted locally (`skygp_<hex>_<ts>`) and keeps a global unique for
   * exactly this reason, which is why one row can be found without a provider.
   *
   * tenant-scope-exempt: this lookup is how the provider is discovered.
   *
   * `runUnscoped` says the same thing to the SQL sentinel, which reads the SQL
   * and not the comment above it. Declaring it here rather than teaching the
   * sentinel to tolerate a query shape is what keeps the exemption exactly one
   * lookup wide: the next unfiltered read of this table still fails.
   */
  static async getByName(name) {
    return runUnscoped(
      'the Evolution webhook arrives with no session; this is what names the provider',
      async () => (await getDb()('whatsapp_accounts').where({ name }).first()) || null
    );
  }

  /**
   * The number that should carry a given kind of traffic.
   *
   * Falls back to the default account, then to any connected one: a billing run
   * must not stop because nobody labelled a number "billing", but it also must
   * not silently use a disconnected one.
   */
  static async getForPurpose(purpose, { integration = null } = {}) {
    const connected = integration ? { status: 'connected', integration } : { status: 'connected' };
    return (
      (await tdb('whatsapp_accounts').where({ ...connected, purpose }).orderBy('id').first())
      || (await tdb('whatsapp_accounts').where({ ...connected, is_default: true }).orderBy('id').first())
      || (await tdb('whatsapp_accounts').where(connected).orderBy('id').first())
      || null
    );
  }

  /** Número oficial da Meta (integração WHATSAPP-BUSINESS do Evolution). */
  static isCloud(row) {
    return row?.integration === 'cloud';
  }

  static async create(account) {
    const id = await tinsertReturningId('whatsapp_accounts', account);
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('whatsapp_accounts')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async remove(id) {
    return tdb('whatsapp_accounts').where({ id }).del();
  }

  /**
   * Exactly one row may be the default; clearing the others is part of setting
   * it. "The others" means this provider's — unqualified, choosing a default
   * here cleared the default number of every provider on the deployment.
   */
  static async setDefault(id) {
    await tdb('whatsapp_accounts').update({ is_default: false, updated_at: new Date() });
    await tdb('whatsapp_accounts').where({ id }).update({ is_default: true, updated_at: new Date() });
    return this.getById(id);
  }
}

export default WhatsAppAccount;
