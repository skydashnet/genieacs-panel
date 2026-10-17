import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/** How long a message may sit in 'sending' before another pass may retake it. */
export const RECLAIM_MS = 5 * 60 * 1000;

/**
 * What the outbox may take, as one WHERE both the listing and the claim use.
 *
 * A queued row is only sendable once its backoff has run out. `next_attempt_at`
 * NULL means due now, and it has to: the column arrived in migration 0018 with
 * every existing row already written, so any other reading would strand an
 * install's whole queue the moment it upgraded. The index behind this test is
 * `(delivery_status, next_attempt_at)`, added by the same migration.
 *
 * The stale branch deliberately ignores the due time. A row stuck in 'sending'
 * is a pass that died mid-send, not a backoff: retaking it after the cutoff is
 * what makes a crash recoverable, and making that wait on a due time written by
 * an earlier failure would leave the row untouchable for as long as the backoff
 * had grown.
 */
function sendable(query, now) {
  const cutoff = new Date(now.getTime() - RECLAIM_MS);
  return query
    .where((ready) => ready
      .where({ delivery_status: 'queued' })
      .where((due) => due.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
    .orWhere((stale) => stale
      .where({ delivery_status: 'sending' })
      .where('claimed_at', '<', cutoff));
}

/**
 * What putting a failed row back in the queue means, in one place.
 *
 * `attempts` to zero and `next_attempt_at` to NULL — due now. Whoever pressed
 * the button decided the reason for the failure is over, and holding them to a
 * backoff computed from attempts that no longer apply would be the panel
 * arguing with the operator.
 */
function requeuePatch() {
  return {
    delivery_status: 'queued',
    delivery_error: null,
    claimed_at: null,
    attempts: 0,
    next_attempt_at: null,
    updated_at: new Date()
  };
}

/**
 * `wa_messages` is the outbox. There is no separate queue table: an outbound
 * message is a row whose `delivery_status` walks
 * queued → sending → sent → delivered → read, or → failed.
 */
class WaMessage {
  static async getById(id) {
    return (await tdb('wa_messages').where({ id }).first()) || null;
  }

  static async getByExternalId(externalId) {
    return (await tdb('wa_messages').where({ external_id: externalId }).first()) || null;
  }

  /**
   * A linha de saída que este eco É, se ela já existe aqui.
   *
   * O servidor ecoa toda mensagem que sai como evento de entrada. Quando o eco
   * de uma mensagem que o PAINEL mandou chega antes de a confirmação de saída
   * gravar o `external_id`, o eco não tinha como se reconhecer — a única
   * deduplicação de entrada é por `external_id`, e a linha do operador ainda
   * está com ele nulo, que é a premissa exata da corrida. Então o eco inseria
   * uma linha nova, e a conversa ficava com DUAS bolhas iguais: a do operador,
   * congelada em "enviada" para sempre, e a do eco, que recebe os recibos.
   *
   * Para quem lê a tela, isso é o cliente ter recebido a mensagem duas vezes —
   * o oposto do que o tratamento de unicidade no worker existe para evitar.
   *
   * Adotar em vez de inserir resolve as três pontas de uma vez: uma bolha só, o
   * `external_id` na linha que o operador vê, e o recibo passando a encontrá-la.
   *
   * A mais ANTIGA primeiro, que é a ordem de envio: com dois textos iguais
   * seguidos, casar pelo fim trocaria os dois ids entre si.
   *
   * @returns {Promise<number|null>} o id adotado, ou null para inserir normal.
   */
  static async adoptEcho({ conversationId, body, externalId }) {
    const candidata = await tdb('wa_messages')
      .where({ conversation_id: conversationId, direction: 'out', is_note: false })
      .whereNull('external_id')
      // Uma linha ainda `queued` não saiu: o eco dela não existe. Estas duas são
      // os estados em que o despacho já aconteceu.
      .whereIn('delivery_status', ['sending', 'sent'])
      .where((q) => (body === null ? q.whereNull('body') : q.where({ body })))
      .orderBy('id', 'asc')
      .first();
    if (!candidata) return null;

    // O `whereNull` de novo, e não é redundante: entre a leitura acima e esta
    // escrita, a confirmação de saída pode ter gravado o `external_id`. Aí esta
    // atualização casa zero linhas, quem chamou insere, e o índice único decide
    // — que é o mesmo desenho da garra do outbox.
    const mudou = await tdb('wa_messages')
      .where({ id: candidata.id })
      .whereNull('external_id')
      .update({ external_id: externalId, updated_at: new Date() });
    return mudou > 0 ? candidata.id : null;
  }

  /**
   * One page of a thread, newest first.
   *
   * `before` is a keyset cursor — the id of the oldest row the caller already
   * has — and not an offset. This table grows while it is being read: a
   * customer answering mid-scroll shifts every offset by one, so an offset
   * page would repeat a message or skip one, and the operator would never know
   * which. A cursor on the id cannot move.
   *
   * Ordered by `id` rather than `created_at` for the same reason: two rows can
   * share a timestamp, and a tie makes the page boundary arbitrary. Insertion
   * order is arrival order here — `created_at` is when the panel received the
   * message, not when the sender typed it.
   */
  static async listForConversation(conversationId, { limit = 100, before = null } = {}) {
    const query = tdb('wa_messages')
      .where({ conversation_id: conversationId })
      .orderBy('id', 'desc')
      .limit(limit);
    if (Number.isInteger(before) && before > 0) query.where('id', '<', before);
    return query;
  }

  /**
   * Puts a failed message back in the queue, as itself.
   *
   * The screen's old "resend" was not this: it read the row's `body` and sent a
   * NEW message, which left the failed row sitting there and produced a second
   * one — and it did nothing at all for a message whose content was an
   * attachment, because there was no body to read. Requeuing the row keeps its
   * attachment, its `source`, its place in the thread and its id, so a
   * subscriber sees one message rather than a duplicate every time a send is
   * retried.
   *
   * `attempts` goes back to zero and `next_attempt_at` to NULL, which means due
   * now: an operator pressing this has decided the reason for the failure is
   * over, and making them wait out a backoff computed from attempts that are no
   * longer relevant would be the panel arguing with them.
   *
   * Only a `failed` row is eligible, and the WHERE says so rather than the
   * caller: requeuing a `sent` row would send a subscriber the same message
   * twice, and requeuing a `queued` one would reset a backoff that is doing its
   * job. The affected-row count is the answer, so two operators pressing at
   * once cannot both win.
   *
   * @returns {Promise<object|null>} the requeued row, or null when not eligible
   */
  static async requeue(id) {
    const changed = await tdb('wa_messages')
      .where({ id, delivery_status: 'failed' })
      .update(requeuePatch());
    return changed > 0 ? this.getById(id) : null;
  }

  /**
   * The same thing, for every failure inside a window.
   *
   * One statement rather than a loop over `requeue`, because the case this
   * exists for is a campaign whose thousands of recipients failed against a
   * server that was restarting, and thousands of round trips is not a recovery.
   *
   * It lives here and not in the controller so that the patch and the
   * `delivery_status: 'failed'` rule have ONE definition. Written out twice
   * they agree only until somebody changes one — and the half that would have
   * been forgotten is the one no test reaches through a screen.
   *
   * Scoped like everything else on this model: `tdb` puts the caller's provider
   * in the WHERE, so an operator at one ISP cannot put another ISP's queue back
   * on the wire.
   *
   * @returns {Promise<number>} how many rows went back to the queue
   */
  static async requeueFailedSince(since) {
    return tdb('wa_messages')
      .where({ delivery_status: 'failed' })
      .where('created_at', '>=', since)
      .update(requeuePatch());
  }

  static async create(message) {
    const id = await tinsertReturningId('wa_messages', message);
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_messages')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  /**
   * Os provedores que têm alguma mensagem para a fila levar agora.
   *
   * O worker acorda a cada cinco segundos e visitava TODO provedor ativo para
   * perguntar isto a cada um: uma consulta pela lista de provedores e mais uma
   * por provedor, com a fila vazia em todos — que é o estado normal de um
   * painel. Doze consultas por minuto por provedor para ouvir "nada".
   *
   * Perguntar uma vez para todos exige atravessar o escopo, e a resposta é o
   * único dado que atravessa: ids de provedor, nunca uma linha de mensagem. Cada
   * provedor da lista continua sendo servido pelo `listSendable` dele, dentro
   * do escopo dele, e é ali que a fila é lida de fato.
   *
   * O critério é o MESMO `sendable` da listagem e da garra. Um critério próprio
   * aqui divergiria dos dois na primeira vez que alguém mexesse num deles, e o
   * provedor com mensagem vencida ficaria sem visita — uma fila parada sem erro.
   */
  static async providersWithSendable() {
    const now = new Date();
    const rows = await runUnscoped(
      'the outbox worker asks which providers have anything due before opening a scope for each',
      // tenant-scope-exempt: só `tenant_id` sai daqui; a fila é lida no escopo de cada um.
      () => getDb()('wa_messages')
        .distinct('tenant_id')
        .whereNull('external_id')
        .where((q) => sendable(q, now))
    );
    return rows.map((row) => Number(row.tenant_id)).filter(Number.isInteger);
  }

  /**
   * Ids the outbox worker should try next, oldest first.
   *
   * `bulk: true` só as automáticas (`source='campaign'`), que saem no ritmo do
   * worker; `bulk: false` todas as outras, que saem na hora. Sem a opção, a
   * fila inteira.
   */
  static async listSendable(limit, { bulk } = {}) {
    const now = new Date();
    const query = tdb('wa_messages')
      .whereNull('external_id')
      .where((q) => sendable(q, now));
    if (bulk === true) query.where('source', 'campaign');
    else if (bulk === false) query.whereNot('source', 'campaign');
    // `id` desempata: as mensagens de uma mesma resposta (a fatura em partes)
    // nascem no mesmo instante e têm que sair na ordem em que foram escritas.
    return query
      .orderBy('created_at')
      .orderBy('id')
      .limit(limit)
      .pluck('id');
  }

  /**
   * Takes ownership of one message, or reports that someone else already has it.
   *
   * This is a conditional UPDATE checked by affected-row count rather than
   * `SELECT ... FOR UPDATE SKIP LOCKED`, because SQLite has no such clause. The
   * WHERE repeats the eligibility test — the same `sendable` predicate the
   * listing uses — so two concurrent passes cannot both win: whoever's UPDATE
   * lands first changes the status, and the loser's UPDATE matches zero rows.
   * Repeating the due time in it also means a row that came due between the
   * listing and the claim is the only kind that can slip through, which is a
   * message sent on time rather than one sent early.
   *
   * @returns {Promise<object|null>} the claimed row, or null when not claimable
   */
  static async claim(id) {
    const now = new Date();
    const changed = await tdb('wa_messages')
      .where({ id })
      .whereNull('external_id')
      .where((q) => sendable(q, now))
      .update({
        delivery_status: 'sending',
        claimed_at: now,
        attempts: getDb().raw('attempts + 1'),
        updated_at: now
      });
    return changed > 0 ? this.getById(id) : null;
  }

  /**
   * Applies a delivery receipt.
   *
   * Never walks the status backwards: a 'delivered' event arriving after 'read'
   * (the two can cross on the wire) must not turn the blue ticks grey again.
   */
  /**
   * A Meta recusou depois de aceitar. Só mexe em quem ainda está a caminho:
   * uma mensagem já entregue ou lida não "falha" por um evento atrasado.
   */
  static async markFailedByExternalId(externalIds, errorText) {
    return tdb('wa_messages')
      .whereIn('external_id', externalIds)
      .whereIn('delivery_status', ['sending', 'sent'])
      .update({
        delivery_status: 'failed',
        delivery_error: String(errorText || '').slice(0, 500),
        updated_at: new Date()
      });
  }

  static async applyReceipt(externalIds, status) {
    const rank = { sent: 1, delivered: 2, read: 3 };
    const weaker = Object.keys(rank).filter((s) => rank[s] < rank[status]);
    const patch = { delivery_status: status, updated_at: new Date() };
    if (status === 'read') patch.read_at = new Date();
    return tdb('wa_messages')
      .whereIn('external_id', externalIds)
      .whereIn('delivery_status', ['sending', ...weaker])
      .update(patch);
  }
}

export default WaMessage;
