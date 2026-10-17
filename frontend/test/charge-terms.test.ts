import { describe, expect, it } from 'vitest'
import type { AsaasIntegration } from '@/lib/api'
import { chargeTermsFormOf, chargeTermsPayload } from '@/lib/charge-terms'

const base: AsaasIntegration = {
  environment: 'sandbox',
  apiKeyConfigured: true,
  apiKeySource: 'db',
  webhookTokenConfigured: true,
  webhookTokenSource: 'db',
  webhookUrl: '/api/billing-webhook',
  updatedAt: null
}

describe('multa, juros e desconto no formulário', () => {
  it('servidor antigo, sem os campos: tudo desligado', () => {
    const form = chargeTermsFormOf(base)
    expect(form).toEqual({
      finePercent: '0', interestMonthlyPercent: '0', discountKind: 'percent', discountValue: '0', discountDaysBefore: '0'
    })
    expect(chargeTermsPayload(form)).toEqual({
      ok: true,
      body: { finePercent: 0, interestMonthlyPercent: 0, discountKind: 'percent', discountValue: 0, discountDaysBefore: 0 }
    })
  })

  it('o desconto fixo aparece em reais e viaja em centavos', () => {
    const form = chargeTermsFormOf({ ...base, discountKind: 'fixed', discountValue: 1990, finePercent: 2.5 })
    expect(form.discountValue).toBe('19,90')
    expect(form.finePercent).toBe('2,5')
    const res = chargeTermsPayload({ ...form, discountValue: '25,00' })
    expect(res.ok && res.body).toMatchObject({ discountKind: 'fixed', discountValue: 2500, finePercent: 2.5 })
  })

  it('aponta os campos fora da faixa', () => {
    const res = chargeTermsPayload({
      finePercent: '11', interestMonthlyPercent: 'x', discountKind: 'percent', discountValue: '101', discountDaysBefore: '31'
    })
    expect(res).toEqual({
      ok: false, invalid: ['finePercent', 'interestMonthlyPercent', 'discountValue', 'discountDaysBefore']
    })
    expect(chargeTermsPayload({
      finePercent: '', interestMonthlyPercent: '', discountKind: 'percent', discountValue: '', discountDaysBefore: '1.5'
    })).toEqual({ ok: false, invalid: ['discountDaysBefore'] })
  })
})
