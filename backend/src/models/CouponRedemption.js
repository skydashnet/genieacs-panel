import { tdb, tinsert } from '../config/database.js';

/**
 * Os cupons que um provedor já resgatou (0093) — uma linha por cupom por
 * provedor, com o índice único `(coupon_id, tenant_id)`.
 *
 * Só por `tdb`/`tinsert`: quem chama abre o escopo do provedor antes
 * (`CouponService.apply` roda dentro de `runInTenant`).
 *
 * `subscriptions.coupon_id` diz qual cupom vale AGORA e some quando o último
 * ciclo é gasto; esta tabela é a memória que fica — é por ela que o provedor
 * não resgata de novo o cupom que já usou.
 */
class CouponRedemption {
  /** Se este provedor já resgatou o cupom. */
  static async exists(couponId, db = null) {
    const linha = await tdb('coupon_redemptions', db).where({ coupon_id: couponId }).first();
    return Boolean(linha);
  }

  /** Grava o resgate. O índice único recusa o segundo (`isUniqueViolation`). */
  static async record(couponId, { at = new Date() } = {}, db = null) {
    await tinsert('coupon_redemptions', { coupon_id: couponId, redeemed_at: at }, db);
  }

  /** Desfaz o resgate de uma aplicação que não chegou a valer. */
  static async remove(couponId, db = null) {
    const changed = await tdb('coupon_redemptions', db).where({ coupon_id: couponId }).del();
    return changed > 0;
  }
}

export default CouponRedemption;
