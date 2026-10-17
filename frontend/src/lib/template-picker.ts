/**
 * O botão "Modelos" da conversa: todos os modelos ativos do painel, para o
 * atendente pôr na caixa e revisar antes de enviar. Puro, para ser testado
 * sem navegador.
 */

import { matchQuickReplies } from '@/lib/quick-replies'

export interface PickableTemplate {
  id: number
  name: string
  body: string
  category: string
  active?: boolean
}

/** A ordem dos grupos na lista: a mesma da aba Modelos. */
export const PICKER_CATEGORIES = ['atendimento', 'cobranca', 'suporte', 'alerta', 'geral'] as const

/**
 * As variáveis que só a fatura preenche: com uma delas, o texto vem do
 * servidor, que relê a fatura em aberto no SGP (a mesma conta da 2ª via).
 */
export const INVOICE_VARIABLES = [
  'valor',
  'vencimento',
  'dias_atraso',
  'dias_para_vencer',
  'pix',
  'linha_digitavel',
  'link_boleto',
  'plano'
] as const

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g

/** Cada variável que o texto cita, uma vez. */
export function templateVariables(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER)) found.add(match[1])
  return [...found]
}

/** O modelo precisa da fatura do assinante para ser preenchido? */
export function needsInvoice(body: string): boolean {
  return templateVariables(body).some((name) => (INVOICE_VARIABLES as readonly string[]).includes(name))
}

/**
 * Os modelos ativos que batem com a busca, em grupos na ordem de
 * `PICKER_CATEGORIES` (uma categoria desconhecida vai para `geral`). A busca
 * é a das respostas rápidas: sem acento, primeiro pelo nome.
 */
export function groupTemplates<T extends PickableTemplate>(
  list: T[],
  query = ''
): { category: (typeof PICKER_CATEGORIES)[number]; items: T[] }[] {
  const ativos = list.filter((item) => item.active !== false)
  const achados = matchQuickReplies(ativos, query, Number.POSITIVE_INFINITY)
  const categoria = (value: string) =>
    ((PICKER_CATEGORIES as readonly string[]).includes(value) ? value : 'geral') as (typeof PICKER_CATEGORIES)[number]
  return PICKER_CATEGORIES
    .map((category) => ({ category, items: achados.filter((item) => categoria(item.category) === category) }))
    .filter((group) => group.items.length > 0)
}
