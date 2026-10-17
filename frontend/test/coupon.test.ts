import { describe, expect, it } from 'vitest'
import {
  COUPON_FLOOR_CENTS,
  couponAppliesToPlan,
  couponDiscountLabel,
  couponDurationLabel,
  couponFormError,
  couponPriceCents,
  isCouponRefusal
} from '@/lib/coupon'

describe('coupon', () => {
  it('desconta percentual e fixo, com o desconto arredondado para baixo', () => {
    expect(couponPriceCents(19990, { kind: 'percent', value: 10 })).toBe(17991)
    expect(couponPriceCents(19990, { kind: 'fixed', value: 2500 })).toBe(17490)
    expect(couponPriceCents(19990, null)).toBe(19990)
  })

  it('nunca abaixo do piso, e o plano que já custa menos fica como está', () => {
    expect(COUPON_FLOOR_CENTS).toBe(500)
    expect(couponPriceCents(19990, { kind: 'fixed', value: 100000 })).toBe(500)
    expect(couponPriceCents(600, { kind: 'percent', value: 99 })).toBe(500)
    expect(couponPriceCents(400, { kind: 'fixed', value: 100 })).toBe(400)
    expect(couponPriceCents(0, { kind: 'fixed', value: 100 })).toBe(0)
  })

  it('vale no plano da lista e enquanto houver ciclo', () => {
    const base = { kind: 'percent' as const, value: 10 }
    expect(couponAppliesToPlan({ ...base, duration: 'forever', planIds: null }, 3)).toBe(true)
    expect(couponAppliesToPlan({ ...base, duration: 'forever', planIds: [1, 2] }, 3)).toBe(false)
    expect(couponAppliesToPlan({ ...base, duration: 'repeating', cyclesLeft: 2, planIds: [3] }, 3)).toBe(true)
    expect(couponAppliesToPlan({ ...base, duration: 'once', cyclesLeft: 0 }, 3)).toBe(false)
    expect(couponAppliesToPlan(null, 3)).toBe(false)
  })

  it('rótulos de desconto e de duração', () => {
    expect(couponDiscountLabel({ kind: 'percent', value: 15 })).toBe('15%')
    expect(couponDiscountLabel({ kind: 'fixed', value: 1990 }, 'BRL')).toMatch(/19[,.]90/)
    expect(couponDurationLabel({ duration: 'once' }).key).toBe('coupons.duration.once')
    expect(couponDurationLabel({ duration: 'repeating', durationCycles: 3 }))
      .toEqual({ key: 'coupons.duration.repeating', vars: { count: 3 } })
    expect(couponDurationLabel({ duration: 'forever' }).key).toBe('coupons.duration.forever')
  })

  it('confere o formulário como o backend: o de 100% e o código ruim são recusados', () => {
    const ok = { code: 'BEMVINDO', kind: 'percent' as const, value: 10, duration: 'once' as const, durationCycles: null }
    expect(couponFormError(ok)).toBeNull()
    expect(couponFormError({ ...ok, value: 100 })).toBe('coupons.error.fullDiscount')
    expect(couponFormError({ ...ok, value: 0 })).toBe('coupons.error.value')
    expect(couponFormError({ ...ok, value: null })).toBe('coupons.error.value')
    expect(couponFormError({ ...ok, code: 'a' })).toBe('coupons.error.code')
    expect(couponFormError({ ...ok, duration: 'repeating', durationCycles: null })).toBe('coupons.error.cycles')
    expect(couponFormError({ ...ok, kind: 'fixed', value: 100000 })).toBeNull()
  })

  it('reconhece as recusas do cupom', () => {
    expect(isCouponRefusal('coupon_exhausted')).toBe(true)
    expect(isCouponRefusal('coupon_already_used')).toBe(true)
    expect(isCouponRefusal('busy')).toBe(false)
    expect(isCouponRefusal(undefined)).toBe(false)
  })
})
