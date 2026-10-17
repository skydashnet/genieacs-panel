import { isAccountColor, WA_ACCOUNT_CLASS, WA_ACCOUNT_COLORS, type WaAccountColor } from '@/lib/wa-account-color'

/** O mesmo teto do servidor (`waTagService.TAG_NAME_MAX`). */
export const TAG_NAME_MAX = 40

/** O nome como o servidor vai gravar: espaços juntados e aparados. */
export function cleanTagName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Cabe? Não vazio, até 40, e sem repetir outro (sem diferenciar maiúsculas). */
export function tagNameProblem(raw: string, others: ReadonlyArray<{ name: string }>): 'empty' | 'long' | 'taken' | null {
  const name = cleanTagName(raw)
  if (!name) return 'empty'
  if (name.length > TAG_NAME_MAX) return 'long'
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) return 'taken'
  return null
}

/** A classe que pinta o chip; uma cor desconhecida cai na primeira da paleta. */
export function tagClass(color: string): string {
  return WA_ACCOUNT_CLASS[isAccountColor(color) ? color : WA_ACCOUNT_COLORS[0]]
}

/** A próxima cor para uma etiqueta nova: a menos usada, na ordem da paleta. */
export function nextTagColor(used: readonly string[]): WaAccountColor {
  const conta = (cor: string) => used.filter((u) => u === cor).length
  return [...WA_ACCOUNT_COLORS].sort((a, b) => conta(a) - conta(b))[0]
}
