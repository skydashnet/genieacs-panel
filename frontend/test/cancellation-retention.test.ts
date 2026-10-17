import { describe, expect, it } from 'vitest'
import type { TenantPlanOption } from '@/lib/api'
import { CANCELLATION_REASONS } from '@/lib/api'
import { canGenerateCharge, canPayNow, canSwitchTo } from '@/lib/plan-options'
import { CANCELLATION_OUTCOME_KEYS, retentionRateLabel } from '@/components/platform/platform-cancellations'
import { CANCELLATION_REASON_KEYS } from '@/components/cancel-subscription'
import en from '@/lib/i18n/locales/en'

/**
 * A retenção no cancelamento (0107) do lado da tela: com o cancelamento
 * agendado ou a pausa, os botões que o servidor recusaria somem — e a pausa
 * oferece "gerar cobrança e pagar", que é o jeito de voltar antes.
 */
const plano = (over: Partial<TenantPlanOption> = {}): TenantPlanOption => ({
  id: 1, code: 'basico', name: 'Básico', priceCents: 9990, currency: 'BRL', periodDays: 30,
  limits: { operators: 3, subscribers: null, devices: 500 }, current: false, ...over
})

describe('a retenção no cancelamento na tela', () => {
  it('não oferece troca de plano com cancelamento agendado ou pausa', () => {
    const outro = plano({ id: 2 })
    const ativa = { status: 'active' as const, pendingPlan: null }
    expect(canSwitchTo(outro, true, ativa)).toBe(true)
    expect(canSwitchTo(outro, true, { ...ativa, cancelAt: '2026-11-01T00:00:00Z' })).toBe(false)
    expect(canSwitchTo(outro, true, { ...ativa, pausedUntil: '2026-12-01T00:00:00Z' })).toBe(false)
  })

  it('não oferece "pagar agora" com o cancelamento agendado, mas oferece na pausa', () => {
    const planos = [plano({ current: true })]
    expect(canPayNow(planos, true, { status: 'active', cancelAt: '2026-11-01T00:00:00Z' })).toBe(false)
    expect(canPayNow(planos, true, { status: 'past_due' })).toBe(true)
  })

  it('o 402 da pausa se resolve pagando', () => {
    const base = { code: 'subscription_paused', paymentUrl: null, chargesLoaded: true, canWrite: true, plans: [plano({ current: true })] }
    expect(canGenerateCharge(base)).toBe(true)
    expect(canGenerateCharge({ ...base, paymentUrl: 'https://pay.test' })).toBe(false)
  })

  it('a taxa de retenção vira porcentagem, e sem decidido é travessão', () => {
    expect(retentionRateLabel(null)).toBe('—')
    expect(retentionRateLabel(0.667)).toBe('67%')
    expect(retentionRateLabel(1)).toBe('100%')
  })

  it('todo motivo e todo desfecho têm texto', () => {
    for (const motivo of CANCELLATION_REASONS) expect(en[CANCELLATION_REASON_KEYS[motivo]]).toBeTruthy()
    for (const chave of Object.values(CANCELLATION_OUTCOME_KEYS)) expect(en[chave]).toBeTruthy()
  })
})
