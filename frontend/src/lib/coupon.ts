import type { CouponDuration, CouponKind } from '@/lib/api'
import type { TranslationKey, TranslationVars } from '@/lib/i18n'
import { formatMoney } from '@/lib/money'

/**
 * O cupom de desconto na tela: o rótulo do desconto, o da duração e o preço
 * de um plano com o cupom.
 *
 * A conta de preço é a do backend (`SubscriptionService.priceWithCoupon`), e
 * aqui só serve para a vitrine — "este plano sairia por tanto com o seu
 * cupom". O valor que vale é sempre o que o servidor devolve em
 * `coupon.priceCents` e na cobrança.
 */

/** O mínimo de uma fatura com cupom: R$ 5,00, o que o Asaas aceita. */
export const COUPON_FLOOR_CENTS = 500

export interface CouponTerms {
  kind: CouponKind
  value: number
  duration: CouponDuration
  durationCycles?: number | null
  cyclesLeft?: number | null
  planIds?: number[] | null
}

/** O preço com o desconto, nunca abaixo do piso; o plano que já custa menos fica como está. */
export function couponPriceCents(priceCents: number, coupon: Pick<CouponTerms, 'kind' | 'value'> | null | undefined) {
  const preco = Math.floor(Number(priceCents))
  if (!Number.isFinite(preco) || preco <= 0) return 0
  if (!coupon || preco <= COUPON_FLOOR_CENTS) return preco
  const valor = Math.floor(Number(coupon.value))
  if (!Number.isFinite(valor) || valor <= 0) return preco
  const desconto = coupon.kind === 'percent' ? Math.floor((preco * valor) / 100) : valor
  return Math.max(COUPON_FLOOR_CENTS, preco - desconto)
}

/** Se o cupom vale num plano: tem ciclo (ou é `forever`) e o plano está na lista, quando há lista. */
export function couponAppliesToPlan(coupon: CouponTerms | null | undefined, planId: number) {
  if (!coupon) return false
  if (coupon.duration !== 'forever' && !((coupon.cyclesLeft ?? 0) > 0)) return false
  return !coupon.planIds || coupon.planIds.includes(planId)
}

/** "10%" ou "R$ 19,90". */
export function couponDiscountLabel(coupon: Pick<CouponTerms, 'kind' | 'value'>, currency: string | null | undefined = 'BRL') {
  return coupon.kind === 'percent' ? `${coupon.value}%` : formatMoney(coupon.value, currency || 'BRL')
}

/** A duração como a tela a diz: só a primeira fatura, N faturas, ou para sempre. */
export function couponDurationLabel(coupon: Pick<CouponTerms, 'duration' | 'durationCycles'>): {
  key: TranslationKey
  vars?: TranslationVars
} {
  if (coupon.duration === 'once') return { key: 'coupons.duration.once' }
  if (coupon.duration === 'repeating') {
    return { key: 'coupons.duration.repeating', vars: { count: coupon.durationCycles ?? 0 } }
  }
  return { key: 'coupons.duration.forever' }
}

/** Os 409 do cupom, que a tela mostra no próprio campo e não num toast genérico. */
export const COUPON_REFUSAL_CODES = [
  'coupon_invalid',
  'coupon_expired',
  'coupon_exhausted',
  'coupon_plan_mismatch',
  'coupon_already_applied',
  // O provedor já resgatou este cupom um dia (e o gastou): não vale de novo.
  'coupon_already_used'
] as const

export function isCouponRefusal(code: string | undefined) {
  return code !== undefined && (COUPON_REFUSAL_CODES as readonly string[]).includes(code)
}

/**
 * O formulário do console, lido e conferido antes de ir ao servidor — a mesma
 * regra que o backend aplica, para a recusa sair no campo e não depois do
 * clique. `value` vem em percentual inteiro ou em centavos (já convertido).
 */
export function couponFormError(form: {
  code: string
  kind: CouponKind
  value: number | null
  duration: CouponDuration
  durationCycles: number | null
}): TranslationKey | null {
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(form.code.trim().toUpperCase())) return 'coupons.error.code'
  if (form.value === null || !Number.isInteger(form.value) || form.value < 1) return 'coupons.error.value'
  if (form.kind === 'percent' && form.value >= 100) return 'coupons.error.fullDiscount'
  if (form.duration === 'repeating' && !(form.durationCycles !== null && Number.isInteger(form.durationCycles)
    && form.durationCycles >= 1 && form.durationCycles <= 120)) return 'coupons.error.cycles'
  return null
}
