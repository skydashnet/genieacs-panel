/**
 * The filters of the Modelos screen, as plain functions so they can be tested
 * without React.
 *
 * The list is loaded whole, so everything here runs on it in memory. The
 * numbers beside each filter follow the rule of the Contatos screen: what the
 * list would show if that filter were clicked now, with the others left as they
 * are — so the number on the active filter is the list's own length.
 */

export const TEMPLATE_CATEGORIES = ['cobranca', 'atendimento', 'suporte', 'alerta', 'geral'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export const asCategory = (value: string | null | undefined): TemplateCategory =>
  (TEMPLATE_CATEGORIES as readonly string[]).includes(String(value)) ? (value as TemplateCategory) : 'geral'

/** The backend's own placeholder pattern, character for character. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g

/** Every distinct variable a body cites, known or not. */
export function citedVariables(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER)) found.add(match[1])
  return [...found]
}

export type Classification = 'reminder' | 'dunning' | 'both' | 'none'

/**
 * What a template IS, read off what it cites — never off a field an operator
 * could set to disagree with the text.
 *
 * `dias_atraso` and `dias_para_vencer` are mirrors: an overdue invoice fills
 * the first and empties the second, and vice versa. Since an empty variable
 * refuses the whole message, a body citing `dias_atraso` can only ever render
 * for someone already overdue — which is the rule that keeps a dunning text
 * away from a subscriber who has not been billed yet. A body citing BOTH is
 * therefore not "more general": it can never render for anybody, and the editor
 * is the only place an operator can be told so before a campaign silently
 * skips every recipient.
 */
export function classify(body: string): Classification {
  const cited = citedVariables(body)
  const reminder = cited.includes('dias_para_vencer')
  const dunning = cited.includes('dias_atraso')
  if (reminder && dunning) return 'both'
  if (reminder) return 'reminder'
  if (dunning) return 'dunning'
  return 'none'
}

export type BillingKind = 'reminder' | 'dunning'

export interface TemplateFilter {
  search: string
  category: TemplateCategory | ''
  kind: BillingKind | ''
}

export const NO_FILTER: TemplateFilter = { search: '', category: '', kind: '' }

export const isFiltering = (filter: TemplateFilter) => Boolean(filter.search.trim() || filter.category || filter.kind)

/** Lower case and without accents, so "cobranca" finds "Cobrança". */
const fold = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

interface Filterable {
  name: string
  body: string
  category: string
}

export function filterTemplates<T extends Filterable>(templates: T[], filter: TemplateFilter): T[] {
  const term = fold(filter.search.trim())
  return templates.filter((template) => {
    if (filter.category && asCategory(template.category) !== filter.category) return false
    if (filter.kind && classify(template.body) !== filter.kind) return false
    return !term || fold(template.name).includes(term) || fold(template.body).includes(term)
  })
}

export interface TemplateCounts {
  /** `all` is the whole list under the other filters; the rest, one category each. */
  categories: Record<TemplateCategory | 'all', number>
  kinds: Record<BillingKind, number>
}

export function templateCounts<T extends Filterable>(templates: T[], filter: TemplateFilter): TemplateCounts {
  const size = (patch: Partial<TemplateFilter>) => filterTemplates(templates, { ...filter, ...patch }).length
  return {
    categories: {
      all: size({ category: '' }),
      cobranca: size({ category: 'cobranca' }),
      atendimento: size({ category: 'atendimento' }),
      suporte: size({ category: 'suporte' }),
      alerta: size({ category: 'alerta' }),
      geral: size({ category: 'geral' })
    },
    kinds: {
      reminder: size({ kind: 'reminder' }),
      dunning: size({ kind: 'dunning' })
    }
  }
}
