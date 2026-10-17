import { getDb, tbatchInsert, tdb, tinsertReturningId } from '../config/database.js';

/** How long a recipient may sit in 'sending' before another tick may retake it. */
export const RECLAIM_MS = 5 * 60 * 1000;

/** Attempts one recipient gets before the campaign gives up on it. */
/**
 * Same number as the outbox's, and for the same reason.
 *
 * Three was written when a failed recipient went straight back to 'pending' and
 * the next tick took it a minute later: three attempts inside two minutes, and
 * then the campaign was over. With a wait between them the count is what buys
 * the window, and the window has to outlast a server restart.
 */
export const MAX_ATTEMPTS = 7;

/**
 * A campaign and the people it is addressed to.
 *
 * `wa_broadcast_recipients` is a work queue with the same shape as the outbox:
 * a row walks pending → sending → sent, or → skipped / failed. It is a separate
 * table from `wa_messages` because the two answer different questions — the
 * outbox knows whether WhatsApp accepted a message, the campaign knows whether
 * a subscriber was contacted at all, and a recipient dropped for an opt-out
 * never becomes a message.
 *
 * 'sent' here means "handed to the outbox", which is as far as the campaign's
 * responsibility reaches; `message_id` points at the row that carries the real
 * delivery state.
 */
/**
 * The 'pending' half of both queue reads: waiting, and actually due.
 *
 * NULL is due now. That is what every row written before `next_attempt_at`
 * existed carries, and what a first attempt carries, so the NULL branch is the
 * common case here rather than an edge one — a campaign in flight during the
 * upgrade must not stall.
 *
 * Written once and used by `listPendingIds` and `claimRecipient` alike: they
 * are the same eligibility test, and `claimRecipient` repeats it precisely so
 * two overlapping ticks cannot both take a recipient. Two copies that drifted
 * would put that guarantee quietly out of step.
 */
/**
 * A linha que um tick anterior garrou e nunca concluiu.
 *
 * Um tick que morreu no meio do envio deixa a linha em 'sending' para sempre;
 * retomá-la é o que torna uma queda recuperável. A idade sai de `claimed_at`, o
 * instante da garra — e NÃO de `created_at`, que é quando a campanha foi
 * montada e não diz nada sobre quem a está enviando agora.
 *
 * `claimed_at` nulo nunca casa, o que é o certo: linha antiga, de antes da
 * coluna existir, ou linha que ninguém garrou, só é alcançável pelo ramo
 * 'pending'.
 *
 * O prazo de envio NÃO é consultado neste ramo, de propósito: uma garra
 * abandonada é queda a recuperar, não espera que alguém agendou.
 */
function reclaimable(q) {
  return q
    .where({ status: 'sending' })
    .whereNotNull('claimed_at')
    .where('claimed_at', '<', new Date(Date.now() - RECLAIM_MS));
}

function due(q, now) {
  return q.where((pending) => pending
    .where({ status: 'pending' })
    .where((wait) => wait.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)));
}

class WaBroadcast {
  static async getById(id) {
    return (await tdb('wa_broadcasts').where({ id }).first()) || null;
  }

  static async list({ limit = 100 } = {}) {
    return tdb('wa_broadcasts').orderBy('id', 'desc').limit(limit);
  }

  static async listByStatus(status) {
    return tdb('wa_broadcasts').where({ status }).orderBy('id');
  }

  static async create(broadcast) {
    const now = new Date();
    const id = await tinsertReturningId('wa_broadcasts', {
      ...broadcast,
      created_at: now,
      updated_at: now
    });
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_broadcasts')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /** Update only while the campaign is still in one of `statuses`; false when it moved on. */
  static async updateIfStatus(id, statuses, patch) {
    const changed = await tdb('wa_broadcasts')
      .where({ id })
      .whereIn('status', statuses)
      .update({ ...patch, updated_at: new Date() });
    return Number(changed) > 0;
  }

  /** Swaps the whole recipient list; only for a campaign that has not started. */
  static async replaceRecipients(broadcastId, recipients) {
    await tdb('wa_broadcast_recipients').where({ broadcast_id: broadcastId }).del();
    return this.addRecipients(broadcastId, recipients);
  }

  /**
   * Writes the recipient list.
   *
   * Chunked because a campaign can carry 300 rows and SQLite has a hard ceiling
   * on bound parameters per statement.
   */
  static async addRecipients(broadcastId, recipients) {
    if (!Array.isArray(recipients) || recipients.length === 0) return 0;
    const now = new Date();
    const rows = recipients.map((recipient) => ({
      broadcast_id: broadcastId,
      phone_e164: recipient.phone,
      contract: recipient.contract || null,
      client_name: recipient.clientName || null,
      rendered_body: recipient.body,
      meta_template: recipient.metaTemplate ? JSON.stringify(recipient.metaTemplate) : null,
      invoice_key: recipient.invoiceKey || null,
      due_date: recipient.dueDate || null,
      status: 'pending',
      created_at: now
    }));
    await tbatchInsert('wa_broadcast_recipients', rows, 50);
    return rows.length;
  }

  static async listRecipients(broadcastId) {
    return tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .orderBy('id');
  }

  /** Ids the flush loop should try next for one campaign, oldest first. */
  static async listPendingIds(broadcastId, limit) {
    return tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .where((q) => due(q, new Date()).orWhere((stale) => reclaimable(stale)))
      .orderBy('id')
      .limit(limit)
      .pluck('id');
  }

  /**
   * Takes ownership of one recipient, or reports that someone else already has.
   *
   * Um `UPDATE` condicional conferido pela contagem de linhas afetadas,
   * exatamente como `WaMessage.claim()`: o SQLite não tem `SKIP LOCKED`, e
   * repetir o WHERE é o que impede dois ticks sobrepostos de contatarem o mesmo
   * assinante.
   *
   * Isso só passou a ser verdade quando `claimed_at` existiu. Antes, a condição
   * de retomada media idade por `created_at` — o instante em que a campanha foi
   * MONTADA —, e numa campanha revisada antes de disparar esse corte já estava
   * no passado: o ramo "garra morta" casava junto com a garra, e a trava era
   * vazia. Gravar `claimed_at` aqui é o que fecha a janela.
   */
  static async claimRecipient(id) {
    const now = new Date();
    const changed = await tdb('wa_broadcast_recipients')
      .where({ id })
      .where((q) => due(q, now).orWhere((stale) => reclaimable(stale)))
      .update({
        status: 'sending',
        claimed_at: now,
        attempts: getDb().raw('attempts + 1')
      });
    return changed > 0 ? this.getRecipient(id) : null;
  }

  static async getRecipient(id) {
    return (await tdb('wa_broadcast_recipients').where({ id }).first()) || null;
  }

  static async updateRecipient(id, patch) {
    await tdb('wa_broadcast_recipients').where({ id }).update(patch);
    return this.getRecipient(id);
  }

  /**
   * Recipients still owed an attempt.
   *
   * Counts 'sending' as well as 'pending': a row another tick is holding is not
   * finished, and calling the campaign done while one is in flight would close
   * it a message short.
   */
  static async countUnfinished(broadcastId) {
    const [row] = await tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .whereIn('status', ['pending', 'sending'])
      .count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  /** Totals for the campaign header, recomputed from the recipient rows. */
  static async tally(broadcastId) {
    const rows = await tdb('wa_broadcast_recipients')
      .where({ broadcast_id: broadcastId })
      .select('status')
      .count({ total: '*' })
      .groupBy('status');
    const counts = {};
    for (const row of rows) counts[row.status] = Number(row.total ?? 0);
    return {
      sent: counts.sent ?? 0,
      // A skip is a failure to reach someone as far as the header is concerned:
      // the operator needs one number for "did not arrive", and the per-row
      // `error_msg` says which of the two it was.
      failed: (counts.failed ?? 0) + (counts.skipped ?? 0)
    };
  }
}

export default WaBroadcast;
