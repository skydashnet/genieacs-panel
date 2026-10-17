import type { SubscriptionCard } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * O cartão recorrente lido para a tela — puro, para o teste não precisar de
 * React. O token nunca chega aqui: o servidor manda só bandeira, quatro
 * dígitos, datas e um código de falha.
 */

/** A bandeira como ela se escreve na tela, ou nulo. `VISA` → `Visa`; siglas curtas ficam. */
export function cardBrandLabel(brand: string | null | undefined): string | null {
  const limpo = String(brand ?? '').trim()
  if (!limpo) return null
  if (limpo.length <= 4) return limpo.toUpperCase()
  return limpo.charAt(0).toUpperCase() + limpo.slice(1).toLowerCase()
}

/** Se a próxima fatura sai no cartão: ligado, salvo e sem recusa. */
export function cardInUse(card: SubscriptionCard | null | undefined): boolean {
  return Boolean(card?.autopayEnabled && card.saved && !card.failedAt)
}

/**
 * A frase do estado do cartão na tela de Plano: salvo e em uso, salvo e
 * parado (desligado ou recusado), ou ligado esperando o primeiro pagamento
 * com cartão. Nulo quando não há nada a dizer (desligado e sem cartão).
 */
export function cardSummary(
  card: SubscriptionCard | null | undefined
): { key: TranslationKey; vars: Record<string, string> } | null {
  if (!card) return null
  const vars = { last4: card.last4 ?? '••••', brand: cardBrandLabel(card.brand) ?? '—' }
  if (card.saved) {
    if (card.failedAt) return { key: 'plan.card.savedFailed', vars }
    return { key: card.autopayEnabled ? 'plan.card.saved' : 'plan.card.savedOff', vars }
  }
  if (card.autopayEnabled) return { key: 'plan.card.waiting', vars: {} }
  return null
}

/**
 * O selo do console: "Cartão •••• 4242", verde em uso, amarelo recusado,
 * neutro parado — ou nulo, sem cartão salvo nem cobrança automática.
 */
export function cardBadge(
  card: SubscriptionCard | null | undefined
): { key: TranslationKey; vars: Record<string, string>; tone: 'success' | 'warning' | 'neutral' } | null {
  if (!card || (!card.saved && !card.autopayEnabled)) return null
  if (!card.saved) return { key: 'platform.subscription.cardWaiting', vars: {}, tone: 'neutral' }
  const vars = { last4: card.last4 ?? '••••', brand: cardBrandLabel(card.brand) ?? '—' }
  if (card.failedAt) return { key: 'platform.subscription.cardFailed', vars, tone: 'warning' }
  return { key: 'platform.subscription.cardBadge', vars, tone: card.autopayEnabled ? 'success' : 'neutral' }
}
