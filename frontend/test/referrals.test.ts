import { describe, expect, it } from 'vitest'
import {
  CREDIT_FLOOR_CENTS,
  REFERRAL_STATUS_KEYS,
  parseRewardToCents,
  parseSignedAmountToCents,
  referralBadgeClass,
  referralCodeFromQuery,
  referralLink
} from '@/lib/referrals'

describe('referrals', () => {
  it('usa o link do servidor e, sem ele, monta o cadastro na origem', () => {
    expect(referralLink('https://painel.test/signup?ref=ABCD2345', 'ABCD2345', 'https://x.test')).toBe('https://painel.test/signup?ref=ABCD2345')
    expect(referralLink(null, 'ABCD2345', 'https://x.test/')).toBe('https://x.test/signup?ref=ABCD2345')
    expect(referralLink(null, null, 'https://x.test')).toBeNull()
    expect(referralLink(null, 'ABCD2345', '')).toBeNull()
  })

  it('lê o código do link como o servidor', () => {
    expect(referralCodeFromQuery(' ab-cd 23 ')).toBe('ABCD23')
    expect(referralCodeFromQuery('x')).toBeNull()
    expect(referralCodeFromQuery(null)).toBeNull()
    expect(referralCodeFromQuery('A'.repeat(17))).toBeNull()
  })

  it('o ajuste do console aceita sinal, recusa zero e o que passa do teto', () => {
    expect(parseSignedAmountToCents('30,00')).toBe(3000)
    expect(parseSignedAmountToCents('-10,50')).toBe(-1050)
    expect(parseSignedAmountToCents('0')).toBeNull()
    expect(parseSignedAmountToCents('abc')).toBeNull()
    expect(parseSignedAmountToCents('10001')).toBeNull()
    expect(parseSignedAmountToCents('1.234')).toBeNull()
  })

  it('a recompensa vazia é zero (desligado), e negativa não passa', () => {
    expect(parseRewardToCents('')).toBe(0)
    expect(parseRewardToCents('50,00')).toBe(5000)
    expect(parseRewardToCents('-1')).toBeNull()
    expect(parseRewardToCents('20000')).toBeNull()
  })

  it('selos e o piso', () => {
    expect(CREDIT_FLOOR_CENTS).toBe(500)
    expect(referralBadgeClass('credited')).toBe('modern-badge-success')
    expect(referralBadgeClass('pending')).toBe('modern-badge-warning')
    expect(referralBadgeClass('canceled')).toBe('modern-badge')
    expect(Object.keys(REFERRAL_STATUS_KEYS).sort()).toEqual(['canceled', 'credited', 'pending'])
  })
})
