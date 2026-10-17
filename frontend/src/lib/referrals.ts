import type { ReferralStatus } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { parseAmountToCents } from '@/lib/utils'

/**
 * A indicação de provedores na tela (0106): o link, o selo de cada indicado e
 * o valor digitado no ajuste do console e na configuração do programa.
 *
 * Quem decide o dinheiro é o servidor — a recompensa, o abatimento na fatura
 * e o piso de R$ 5,00. Aqui só se lê e se formata.
 */

/** O mínimo de uma fatura com crédito: R$ 5,00, o mesmo do cupom. */
export const CREDIT_FLOOR_CENTS = 500

/** O maior ajuste manual e a maior recompensa: R$ 10.000,00 (o servidor confere). */
export const MAX_CREDIT_CENTS = 1_000_000

/**
 * O link de indicação: o que o servidor montou, ou — quando o deploy não sabe
 * o próprio endereço — o cadastro na origem desta página, com o código.
 */
export function referralLink(signupUrl: string | null | undefined, code: string | null | undefined, origin: string) {
  if (signupUrl) return signupUrl
  if (!code) return null
  const base = String(origin || '').replace(/\/+$/, '')
  return base ? `${base}/signup?ref=${encodeURIComponent(code)}` : null
}

/** O código que veio no link (`?ref=`), como o servidor o lê — ou nada. */
export function referralCodeFromQuery(valor: string | null | undefined) {
  const texto = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return texto.length >= 4 && texto.length <= 16 ? texto : null
}

export const REFERRAL_STATUS_KEYS: Record<ReferralStatus, TranslationKey> = {
  pending: 'referrals.status.pending',
  credited: 'referrals.status.credited',
  canceled: 'referrals.status.canceled'
}

export function referralBadgeClass(status: ReferralStatus | string) {
  if (status === 'credited') return 'modern-badge-success'
  if (status === 'pending') return 'modern-badge-warning'
  return 'modern-badge'
}

/**
 * Um ajuste digitado em reais, com sinal: `-10,00` tira dez reais do saldo.
 * Nulo quando não dá para ler, quando é zero ou passa do teto.
 */
export function parseSignedAmountToCents(digitado: string): number | null {
  const texto = String(digitado ?? '').trim()
  const negativo = texto.startsWith('-')
  const centavos = parseAmountToCents(negativo ? texto.slice(1) : texto)
  if (centavos === null || centavos === 0 || centavos > MAX_CREDIT_CENTS) return null
  return negativo ? -centavos : centavos
}

/** A recompensa digitada na configuração: reais, de 0 (desliga) até o teto. */
export function parseRewardToCents(digitado: string): number | null {
  const texto = String(digitado ?? '').trim()
  if (!texto) return 0
  const centavos = parseAmountToCents(texto)
  if (centavos === null || centavos > MAX_CREDIT_CENTS) return null
  return centavos
}
