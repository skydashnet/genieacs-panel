import { tdb, tinsert, withDeadlockRetry } from '../config/database.js';

/** Rows older than this are of no use to anyone: the cache expires in 30 days. */
const PRUNE_AFTER_DAYS = 90;

function readJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * What the TeiaH answered about one CPF/CNPJ, kept so the panel does not ask
 * (and pay) again within the validity window — see `teiah_consultations` in
 * `config/migrations.js`. One row per document and provider.
 */
class TeiahConsultation {
  static async get(document) {
    const row = await tdb('teiah_consultations').where({ document: String(document) }).first();
    if (!row) return null;
    const data = readJson(row.data);
    if (!data) return null;
    return { data, consultedAt: new Date(row.consulted_at) };
  }

  static async save(document, data) {
    const now = new Date();
    const values = { data: JSON.stringify(data), consulted_at: now };
    await withDeadlockRetry(() => tinsert('teiah_consultations', { document: String(document), ...values })
      .onConflict(['tenant_id', 'document'])
      .merge(values));
    // The cache outlives its use after 30 days; what is older than 90 goes.
    await tdb('teiah_consultations')
      .where('consulted_at', '<', new Date(now.getTime() - PRUNE_AFTER_DAYS * 86_400_000))
      .del();
    return { data, consultedAt: now };
  }
}

export default TeiahConsultation;
