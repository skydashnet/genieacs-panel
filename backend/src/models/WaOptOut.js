import { tdb, tinsertReturningId } from '../config/database.js';
import { bloqueia, gravarTipos, tiposGravados } from '../utils/wa/waOptOutTipos.js';

/**
 * "Não perturbe".
 *
 * An opt-out means **the provider does not initiate contact**. It blocks mass
 * dispatch, the billing cadence and any proactive alert to that number. It does
 * NOT block an operator answering someone, or the bot replying to a person who
 * just wrote in — refusing to answer a customer who asked a question would be a
 * worse product, not a more respectful one.
 *
 * Keyed by phone and LID, never by customer id: an opt-out has to survive a
 * record being merged, deleted, or created again. Whoever asked to be left
 * alone asked as a phone number.
 *
 * And per provider, not per deployment. Unqualified, one ISP's opt-out list
 * silenced every other ISP's number for that person — and the reverse leak is
 * just as bad, because the list itself says who asked whom to stop. Each ISP
 * honours the requests made to it: that list is its own compliance record, and
 * it can neither be bound by nor read another's.
 */
class WaOptOut {
  /**
   * Whether this address is currently opted out.
   *
   * Both identities are checked because a contact may be known by only one of
   * them, and the request to stop was made by the person, not by the column.
   */
  static async isActive({ waPhone, waLid, category } = {}) {
    const phone = String(waPhone || '').trim();
    const lid = String(waLid || '').trim();
    if (!phone && !lid) return false;
    const rows = await tdb('wa_opt_outs')
      .whereNull('revoked_at')
      .where((q) => {
        if (phone) q.orWhere({ wa_phone_e164: phone });
        if (lid) q.orWhere({ wa_lid: lid });
      })
      .select('categories');
    // Com `category`, só conta o bloqueio que cobre aquele tipo: quem pediu
    // para não receber promoção ainda recebe a fatura.
    return rows.some((row) => bloqueia(row.categories, category));
  }

  /** Active opt-outs among a batch of numbers — one query for a whole campaign. */
  static async activePhones(phones, category) {
    const list = [...new Set((phones || []).map((p) => String(p || '').trim()).filter(Boolean))];
    if (list.length === 0) return new Set();
    const rows = await tdb('wa_opt_outs')
      .whereNull('revoked_at')
      .whereIn('wa_phone_e164', list)
      .select('wa_phone_e164', 'categories');
    return new Set(rows.filter((row) => bloqueia(row.categories, category)).map((row) => row.wa_phone_e164));
  }

  /**
   * O que cada número bloqueia: o telefone → os tipos (`null` quando é tudo).
   * Para a tela, que mostra "não perturbe" por inteiro ou só por tipo.
   */
  static async activeBlocks(phones) {
    const list = [...new Set((phones || []).map((p) => String(p || '').trim()).filter(Boolean))];
    const blocks = new Map();
    if (list.length === 0) return blocks;
    const rows = await tdb('wa_opt_outs')
      .whereNull('revoked_at')
      .whereIn('wa_phone_e164', list)
      .select('wa_phone_e164', 'categories');
    for (const row of rows) {
      const tipos = tiposGravados(row.categories);
      const antes = blocks.get(row.wa_phone_e164);
      // Duas linhas para o mesmo número (raro): vale a união; `null` (tudo) vence.
      blocks.set(row.wa_phone_e164, antes === null || tipos === null ? null : [...new Set([...(antes ?? []), ...tipos])]);
    }
    return blocks;
  }

  /**
   * Records an opt-out, unless an active one already exists.
   *
   * The duplicate check lives here rather than in a partial unique index
   * because MySQL has none. A duplicate row would be noise rather than a safety
   * failure — the dangerous direction is a MISSING opt-out — but writing one
   * row per repeated "SAIR" would make the operator's list unreadable.
   */
  static async record({ waPhone, waLid, conversationId, origin = 'customer', reasonText, categories = null }) {
    const existente = await this.findActive({ waPhone, waLid });
    if (existente) {
      // Quem já bloqueia só alguns tipos e agora pede TUDO (um "SAIR" do
      // cliente, ou a equipe marcando "não receber nada") passa a bloquear
      // tudo: o pedido mais forte vale. O contrário — afinar para menos —
      // é decisão da equipe, e vai por `setCategories`.
      if (!categories && existente.categories) await this.setCategories(existente.id, null);
      return null;
    }
    const now = new Date();
    const id = await tinsertReturningId('wa_opt_outs', {
      wa_phone_e164: waPhone || null,
      wa_lid: waLid || null,
      conversation_id: conversationId || null,
      origin,
      reason_text: reasonText ? String(reasonText).slice(0, 500) : null,
      categories: gravarTipos(categories),
      created_at: now
    });
    return (await tdb('wa_opt_outs').where({ id }).first()) || null;
  }

  /** A linha ativa deste endereço, qualquer que seja o tipo que ela bloqueia. */
  static async findActive({ waPhone, waLid } = {}) {
    const phone = String(waPhone || '').trim();
    const lid = String(waLid || '').trim();
    if (!phone && !lid) return null;
    return (await tdb('wa_opt_outs')
      .whereNull('revoked_at')
      .where((q) => {
        if (phone) q.orWhere({ wa_phone_e164: phone });
        if (lid) q.orWhere({ wa_lid: lid });
      })
      .orderBy('id')
      .first()) || null;
  }

  /** Troca os tipos que uma linha ativa bloqueia; `null` é todos. */
  static async setCategories(id, categories) {
    await tdb('wa_opt_outs')
      .where({ id })
      .whereNull('revoked_at')
      .update({ categories: gravarTipos(categories) });
    return (await tdb('wa_opt_outs').where({ id }).first()) || null;
  }

  static async revoke(id, userId) {
    await tdb('wa_opt_outs')
      .where({ id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), revoked_by: userId || null });
    return (await tdb('wa_opt_outs').where({ id }).first()) || null;
  }

  static async listActive({ limit = 200 } = {}) {
    return tdb('wa_opt_outs').whereNull('revoked_at').orderBy('created_at', 'desc').limit(limit);
  }
}

export default WaOptOut;
