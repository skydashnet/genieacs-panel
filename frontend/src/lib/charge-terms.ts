import type { AsaasIntegration, AsaasIntegrationUpdate } from '@/lib/api'
import { parseAmountToCents } from '@/lib/utils'
import { centsToInput, parsePercent } from '@/lib/subscription-console'

/**
 * Multa, juros e desconto por antecipação das cobranças da plataforma no
 * Asaas — o formulário de Integrações, como funções puras.
 *
 * As faixas são as do backend (`asaasSettingsService`, bloco `charges`): a
 * tela confere antes para dizer o que está errado sem um 400, mas quem decide
 * é o servidor. O desconto fixo se digita em reais e viaja em centavos, como
 * todo dinheiro do painel.
 */
export type DiscountKind = 'percent' | 'fixed'

export interface ChargeTermsForm {
  finePercent: string
  interestMonthlyPercent: string
  discountKind: DiscountKind
  discountValue: string
  discountDaysBefore: string
}

export const CHARGE_TERMS_LIMITS = Object.freeze({
  finePercent: 10,
  interestMonthlyPercent: 10,
  discountPercent: 100,
  discountDaysBefore: 30
})

/** O número digitado no formato da tela: vírgula decimal, sem zeros à toa. */
function percentToInput(valor: number | undefined) {
  return String(valor ?? 0).replace('.', ',')
}

export function chargeTermsFormOf(info: AsaasIntegration): ChargeTermsForm {
  const kind: DiscountKind = info.discountKind === 'fixed' ? 'fixed' : 'percent'
  const valor = info.discountValue ?? 0
  return {
    finePercent: percentToInput(info.finePercent),
    interestMonthlyPercent: percentToInput(info.interestMonthlyPercent),
    discountKind: kind,
    discountValue: kind === 'fixed' ? centsToInput(valor) : percentToInput(valor),
    discountDaysBefore: String(info.discountDaysBefore ?? 0)
  }
}

export type ChargeTermsField = 'finePercent' | 'interestMonthlyPercent' | 'discountValue' | 'discountDaysBefore'

/**
 * O que gravar, ou os campos que não fecham. Campo vazio é zero — desligado —,
 * como no backend.
 */
export function chargeTermsPayload(
  form: ChargeTermsForm
): { ok: true; body: AsaasIntegrationUpdate } | { ok: false; invalid: ChargeTermsField[] } {
  const invalid: ChargeTermsField[] = []
  const percent = (texto: string, max: number, campo: ChargeTermsField) => {
    if (!texto.trim()) return 0
    const valor = parsePercent(texto)
    if (valor === null || valor > max) {
      invalid.push(campo)
      return 0
    }
    return valor
  }
  const finePercent = percent(form.finePercent, CHARGE_TERMS_LIMITS.finePercent, 'finePercent')
  const interestMonthlyPercent = percent(
    form.interestMonthlyPercent, CHARGE_TERMS_LIMITS.interestMonthlyPercent, 'interestMonthlyPercent'
  )
  let discountValue = 0
  if (form.discountKind === 'fixed') {
    if (form.discountValue.trim()) {
      const cents = parseAmountToCents(form.discountValue)
      if (cents === null) invalid.push('discountValue')
      else discountValue = cents
    }
  } else {
    discountValue = percent(form.discountValue, CHARGE_TERMS_LIMITS.discountPercent, 'discountValue')
  }
  const diasTexto = form.discountDaysBefore.trim()
  const dias = diasTexto ? Number(diasTexto) : 0
  if (!/^\d*$/.test(diasTexto) || !Number.isInteger(dias) || dias > CHARGE_TERMS_LIMITS.discountDaysBefore) {
    invalid.push('discountDaysBefore')
  }
  if (invalid.length) return { ok: false, invalid }
  return {
    ok: true,
    body: {
      finePercent,
      interestMonthlyPercent,
      discountKind: form.discountKind,
      discountValue,
      discountDaysBefore: dias
    }
  }
}
