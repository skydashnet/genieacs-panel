import { tdb, tinsertReturningId } from '../config/database.js';

export const REFERRAL_STATUSES = Object.freeze(['new', 'contacted', 'won', 'rewarded', 'lost']);

/**
 * As indicações dos clientes: quem um cliente indicou pelo link dele.
 *
 * Uma linha por indicado. Tudo passa por `tdb`, então cada provedor só vê as
 * suas.
 */
class CustomerReferral {
  static async getById(id) {
    return (await tdb('customer_referrals').where({ id }).first()) || null;
  }

  static async create(row) {
    const now = new Date();
    const id = await tinsertReturningId('customer_referrals', { ...row, created_at: now, updated_at: now });
    return this.getById(id);
  }

  /** O mesmo indicado (telefone) pelo mesmo cliente: o cadastro repetido não duplica. */
  static async findDuplicate(referrerContract, phone) {
    return (await tdb('customer_referrals')
      .where({ referrer_contract: String(referrerContract), phone_e164: phone })
      .first()) || null;
  }

  static async list({ status = null, limit = 200, offset = 0 } = {}) {
    const query = tdb('customer_referrals').orderBy('id', 'desc').limit(limit).offset(offset);
    if (status) query.where({ status });
    return query;
  }

  static async counts() {
    const rows = await tdb('customer_referrals').select('status').count({ total: '*' }).groupBy('status');
    const counts = Object.fromEntries(REFERRAL_STATUSES.map((s) => [s, 0]));
    for (const row of rows) counts[row.status] = Number(row.total ?? 0);
    return counts;
  }

  static async update(id, patch) {
    await tdb('customer_referrals').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }
}

export default CustomerReferral;
