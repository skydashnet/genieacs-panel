import { getDb, insertReturningId } from '../config/database.js';

/**
 * Os pedidos de demonstração da página pública.
 *
 * Lida fora de `tdb`, como `plans`: é da plataforma e não tem `tenant_id` —
 * quem pede ainda não é provedor. Só o console lê, atrás de
 * `requirePlatformAdmin`; a escrita pública só insere.
 */
export const LEAD_STATUSES = Object.freeze(['new', 'contacted', 'won', 'lost']);

class Lead {
  static async create(row) {
    const id = await insertReturningId('leads', row);
    return Lead.findById(id);
  }

  static async findById(id) {
    if (!id) return null;
    return (await getDb()('leads').where({ id }).first()) || null;
  }

  static async list({ status = null, limit = 200 } = {}) {
    let query = getDb()('leads').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit);
    if (status) query = query.where({ status });
    return query;
  }

  static async countByStatus() {
    const rows = await getDb()('leads').select('status').count({ n: '*' }).groupBy('status');
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
  }

  static async update(id, patch) {
    const changed = await getDb()('leads').where({ id }).update({ ...patch, updated_at: new Date() });
    return changed > 0 ? Lead.findById(id) : null;
  }

  /**
   * Apaga os pedidos antigos que não deram em cliente. Devolve quantos saíram,
   * como `AuditLog.prune`.
   *
   * `won` NUNCA sai, em nenhum prazo. Um lead ganho é o único registro de como
   * um cliente pagante chegou — não há `tenant_id`, `lead_id` nem `converted_at`
   * ligando um provedor ao pedido que o originou, então esta linha é o elo, e
   * apagá-la é perda comercial sem ganho de privacidade. Depois da
   * `0109_drop_lead_ip` ela também já não guarda o campo que não tinha
   * finalidade.
   *
   * A idade é `created_at` e nunca `updated_at`: `Lead.update` mexe em
   * `updated_at` a cada patch, então ele significa "última vez que um humano
   * tocou" — um lead de três anos que alguém reclassificou ontem tem
   * `updated_at` de ontem.
   *
   * O filtro por `status` não é só a regra: é o que faz a consulta usar o
   * índice `leads_status_created_idx`, cuja primeira coluna é `status`. Uma
   * poda só por idade varreria a tabela. Poupar o `won` e usar o índice são a
   * mesma consulta, por sorte.
   */
  static async prune(cutoff) {
    return getDb()('leads')
      .whereIn('status', ['new', 'contacted', 'lost'])
      .where('created_at', '<', cutoff)
      .del();
  }
}

export default Lead;
