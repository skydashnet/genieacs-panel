import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * Os pedidos de cancelamento de um provedor (0107) — ver
 * `cancellationRequestsTable` na migração e `CancellationService`.
 *
 * Só por `tdb`/`tinsertReturningId` no caminho do provedor: quem chama abre
 * o escopo dele antes. A única leitura de cima é o relatório do console
 * (`listAll`), declarada como tal.
 */
export const CANCELLATION_OUTCOMES = Object.freeze({
  RETAINED_DISCOUNT: 'retained_discount',
  RETAINED_PAUSE: 'retained_pause',
  CANCELED: 'canceled',
  REVERTED: 'reverted'
});

class CancellationRequest {
  static async findById(id, trx = null) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await tdb('cancellation_requests', trx).where({ id: numero }).first()) || null;
  }

  /** O pedido ainda sem decisão (o mais recente), ou nulo. */
  static async open(trx = null) {
    return (await tdb('cancellation_requests', trx).whereNull('outcome').orderBy('id', 'desc').first()) || null;
  }

  /** O pedido que agendou o cancelamento que está valendo, ou nulo. */
  static async scheduled(trx = null) {
    return (await tdb('cancellation_requests', trx)
      .where({ outcome: CANCELLATION_OUTCOMES.CANCELED })
      .whereNull('reverted_at')
      .orderBy('id', 'desc')
      .first()) || null;
  }

  static async create(row, trx = null) {
    const id = await tinsertReturningId('cancellation_requests', row, trx);
    return CancellationRequest.findById(id, trx);
  }

  /** Atualiza um pedido ainda aberto; devolve se mudou. */
  static async updateOpen(id, patch, trx = null) {
    const changed = await tdb('cancellation_requests', trx).where({ id }).whereNull('outcome').update(patch);
    return changed > 0;
  }

  /**
   * Grava a decisão — só se o pedido ainda está sem decisão. Dois cliques
   * (dois donos, duas abas) não decidem o mesmo pedido duas vezes.
   */
  static async decide(id, patch, trx = null) {
    const changed = await tdb('cancellation_requests', trx).where({ id }).whereNull('outcome').update(patch);
    return changed > 0;
  }

  /** Marca o cancelamento agendado como desfeito. */
  static async markReverted(id, { at, by }, trx = null) {
    const changed = await tdb('cancellation_requests', trx)
      .where({ id, outcome: CANCELLATION_OUTCOMES.CANCELED })
      .whereNull('reverted_at')
      .update({ outcome: CANCELLATION_OUTCOMES.REVERTED, reverted_at: at, reverted_by: by });
    return changed > 0;
  }

  /** O último pedido com este desfecho (o desconto, a pausa), de qualquer data, ou nulo. */
  static async lastWithOutcome(outcome, trx = null) {
    return (await tdb('cancellation_requests', trx)
      .where({ outcome })
      .whereNotNull('decided_at')
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .first()) || null;
  }

  /** O último desconto de retenção aceito desde `since`, ou nulo. */
  static async discountAcceptedSince(since, trx = null) {
    return (await tdb('cancellation_requests', trx)
      .where({ outcome: CANCELLATION_OUTCOMES.RETAINED_DISCOUNT })
      .where('decided_at', '>=', since)
      .orderBy('id', 'desc')
      .first()) || null;
  }

  /**
   * Todos os pedidos de todos os provedores desde `since` (ou todos), com o
   * nome do provedor — o relatório de cancelamentos do console.
   */
  static async listAll({ since = null, limit = null } = {}) {
    return runUnscoped('the console reports every provider\'s cancellation requests', async () => {
      // tenant-scope-exempt: relatório do plano de controle, acima dos provedores.
      const query = getDb()('cancellation_requests')
        .leftJoin('tenants', 'tenants.id', 'cancellation_requests.tenant_id')
        .select('cancellation_requests.*', 'tenants.name as tenant_name', 'tenants.slug as tenant_slug')
        .orderBy('cancellation_requests.id', 'desc');
      if (limit) query.limit(limit);
      if (since) query.where('cancellation_requests.created_at', '>=', since);
      return await query;
    });
  }
}

export default CancellationRequest;
