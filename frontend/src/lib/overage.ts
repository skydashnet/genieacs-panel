import type { PlanOveragePrices } from '@/lib/api'
import { parseAmountToCents } from '@/lib/utils'
import { PLAN_RESOURCES, type PlanResource } from '@/lib/plan-options'

/**
 * A cobrança por excedente (0105), no que a tela decide sem React.
 *
 * Com preço de excedente, passar do teto não bloqueia: as unidades a mais vão
 * à fatura da renovação. Sem preço, o teto bloqueia como sempre. A tela só
 * avisa "novos registros são recusados" pelo recurso que de fato recusa.
 */

/** Os recursos acima do teto que BLOQUEIAM — os sem preço de excedente, na ordem da tela. */
export function blockingOver(
  over: Record<PlanResource, boolean>,
  prices: PlanOveragePrices | null | undefined
): PlanResource[] {
  return PLAN_RESOURCES.filter((recurso) => over[recurso] && !prices?.[recurso])
}

/**
 * O preço de excedente digitado no catálogo: vazio é `null` ("sem preço", o
 * teto bloqueia); o que não se lê como dinheiro, ou zero, é `undefined` —
 * inválido, e a tela recusa antes de mandar. Excedente de graça seria teto
 * nenhum, e isso o plano já diz com o limite vazio.
 */
export function overagePriceFromInput(texto: string): number | null | undefined {
  if (!texto.trim()) return null
  const cents = parseAmountToCents(texto)
  return cents === null || cents < 1 ? undefined : cents
}
