import { describe, expect, it } from 'vitest'
import type { SubscriptionCard } from '@/lib/api'
import { cardBadge, cardBrandLabel, cardInUse, cardSummary } from '@/lib/card-autopay'

const cartao = (extra: Partial<SubscriptionCard> = {}): SubscriptionCard => ({
  autopayEnabled: true,
  autopaySince: '2026-10-01T12:00:00.000Z',
  saved: true,
  brand: 'VISA',
  last4: '4242',
  savedAt: '2026-10-01T12:00:00.000Z',
  failedAt: null,
  failure: null,
  ...extra
})

describe('cartão recorrente', () => {
  it('escreve a bandeira como se lê', () => {
    expect(cardBrandLabel('VISA')).toBe('VISA')
    expect(cardBrandLabel('MASTERCARD')).toBe('Mastercard')
    expect(cardBrandLabel('elo')).toBe('ELO')
    expect(cardBrandLabel(null)).toBeNull()
  })

  it('só está em uso ligado, salvo e sem recusa', () => {
    expect(cardInUse(cartao())).toBe(true)
    expect(cardInUse(cartao({ autopayEnabled: false }))).toBe(false)
    expect(cardInUse(cartao({ failedAt: '2026-10-02T00:00:00.000Z' }))).toBe(false)
    expect(cardInUse(cartao({ saved: false }))).toBe(false)
    expect(cardInUse(null)).toBe(false)
  })

  it('a frase da tela de Plano diz o estado', () => {
    expect(cardSummary(cartao())).toEqual({ key: 'plan.card.saved', vars: { last4: '4242', brand: 'VISA' } })
    expect(cardSummary(cartao({ autopayEnabled: false }))?.key).toBe('plan.card.savedOff')
    expect(cardSummary(cartao({ failedAt: '2026-10-02T00:00:00.000Z' }))?.key).toBe('plan.card.savedFailed')
    expect(cardSummary(cartao({ saved: false, last4: null, brand: null }))?.key).toBe('plan.card.waiting')
    expect(cardSummary(cartao({ saved: false, autopayEnabled: false }))).toBeNull()
  })

  it('o selo do console: verde em uso, amarelo recusado, nada sem cartão', () => {
    expect(cardBadge(cartao())?.tone).toBe('success')
    expect(cardBadge(cartao({ failedAt: '2026-10-02T00:00:00.000Z' }))).toMatchObject({
      key: 'platform.subscription.cardFailed', tone: 'warning'
    })
    expect(cardBadge(cartao({ autopayEnabled: false }))?.tone).toBe('neutral')
    expect(cardBadge(cartao({ saved: false }))?.key).toBe('platform.subscription.cardWaiting')
    expect(cardBadge(cartao({ saved: false, autopayEnabled: false }))).toBeNull()
    expect(cardBadge(undefined)).toBeNull()
  })
})
