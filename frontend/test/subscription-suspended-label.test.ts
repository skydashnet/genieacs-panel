import { describe, expect, it } from 'vitest'
import { statusLabelKey } from '@/components/platform/tenant-plan'
import { canGenerateCharge } from '@/lib/plan-options'
import en from '@/lib/i18n/locales/en'

/**
 * O selo da suspensão automática por inadimplência (0102): ela sai pagando, a
 * suspensão à mão só pelo console, e o console precisa ver a diferença.
 */
describe('statusLabelKey', () => {
  it('separa a suspensão automática da à mão', () => {
    expect(statusLabelKey({ status: 'suspended', suspendedReason: 'auto_nonpayment' }))
      .toBe('platform.subscription.suspendedNonpayment')
    expect(statusLabelKey({ status: 'suspended', suspendedReason: 'manual' })).toBe('platform.subscription.suspended')
    expect(statusLabelKey({ status: 'suspended', suspendedReason: null })).toBe('platform.subscription.suspended')
    expect(statusLabelKey({ status: 'suspended' })).toBe('platform.subscription.suspended')
  })

  it('não mexe nos outros estados', () => {
    expect(statusLabelKey({ status: 'active', suspendedReason: 'auto_nonpayment' })).toBe('platform.subscription.active')
    expect(statusLabelKey({ status: 'past_due' })).toBe('platform.subscription.pastDue')
  })

  it('tem texto', () => {
    expect(en['platform.subscription.suspendedNonpayment']).toMatch(/nonpayment/i)
  })
})

describe('o muro da suspensão automática', () => {
  const plano = { id: 1, code: 'pro', name: 'Pro', priceCents: 19990, currency: 'BRL', periodDays: 30, limits: {} as never, current: true }
  const base = {
    code: 'subscription_suspended', paymentUrl: null, chargesLoaded: true, canWrite: true, plans: [plano]
  }

  it('oferece a cobrança só na automática', () => {
    expect(canGenerateCharge({ ...base, autoSuspended: true })).toBe(true)
    expect(canGenerateCharge(base)).toBe(false)
    expect(canGenerateCharge({ ...base, code: 'subscription_canceled', autoSuspended: true })).toBe(false)
  })
})
