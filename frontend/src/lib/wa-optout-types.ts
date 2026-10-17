import type { TranslationKey } from '@/lib/i18n'

/**
 * The kinds of message a "do not disturb" can block, in the order the team
 * reaches for them. The ids are the server's (`utils/wa/waOptOutTipos.js`).
 */
export const OPT_OUT_TYPES = [
  ['billing', 'whatsapp.optOut.type.billing'],
  ['service', 'whatsapp.optOut.type.service'],
  ['marketing', 'whatsapp.optOut.type.marketing'],
  ['survey', 'whatsapp.optOut.type.survey']
] as const satisfies ReadonlyArray<readonly [string, TranslationKey]>

export type OptOutType = (typeof OPT_OUT_TYPES)[number][0]

export const ALL_OPT_OUT_TYPES: OptOutType[] = OPT_OUT_TYPES.map(([id]) => id)

/** The picker's selection for a stored entry: `null` means "everything". */
export function selectionFor(categories: readonly string[] | null | undefined): OptOutType[] {
  if (!categories || categories.length === 0) return [...ALL_OPT_OUT_TYPES]
  return ALL_OPT_OUT_TYPES.filter((id) => categories.includes(id))
}

/** What to send: `null` when everything is ticked (the server's "all"), else the ticked kinds. */
export function categoriesFor(selected: readonly OptOutType[]): OptOutType[] | null {
  const ticked = ALL_OPT_OUT_TYPES.filter((id) => selected.includes(id))
  return ticked.length === ALL_OPT_OUT_TYPES.length ? null : ticked
}

export function toggleType(selected: readonly OptOutType[], id: OptOutType): OptOutType[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : ALL_OPT_OUT_TYPES.filter((item) => item === id || selected.includes(item))
}
