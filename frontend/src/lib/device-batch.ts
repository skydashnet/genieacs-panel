/**
 * A seleção de equipamentos para uma ação em lote: o que a tela decide sozinha.
 *
 * Funções puras, porque o vitest roda em `node`, sem jsdom. O teto é o mesmo de
 * `backend/src/services/deviceBatch.js`, e o teste importa o de lá e exige que
 * os dois concordem — a tela deixando marcar 201 para o servidor recusar é um
 * erro que o operador só descobre depois de confirmar.
 */

export const BATCH_LIMIT = 200

/** O aparelho marcado: o id, e o que a tela mostra dele (série ou id). */
export type Selection = ReadonlyMap<string, string>

export interface SelectableRow {
  id: string
  label: string
}

/** Marca ou desmarca um aparelho. Marcar além do teto não faz nada. */
export function toggleOne(selection: Selection, row: SelectableRow): Map<string, string> {
  const next = new Map(selection)
  if (next.has(row.id)) {
    next.delete(row.id)
  } else if (next.size < BATCH_LIMIT) {
    next.set(row.id, row.label)
  }
  return next
}

/** Se a página está toda marcada, em parte, ou nada. */
export function pageSelectionState(selection: Selection, rows: readonly SelectableRow[]): 'none' | 'some' | 'all' {
  const marcados = rows.filter((row) => selection.has(row.id)).length
  if (marcados === 0) return 'none'
  return marcados === rows.length ? 'all' : 'some'
}

/**
 * A caixa do cabeçalho: com a página toda marcada, desmarca a página; senão,
 * marca o que falta — até o teto, na ordem da página.
 */
export function togglePage(selection: Selection, rows: readonly SelectableRow[]): Map<string, string> {
  const next = new Map(selection)
  if (rows.length > 0 && pageSelectionState(selection, rows) === 'all') {
    for (const row of rows) next.delete(row.id)
    return next
  }
  for (const row of rows) {
    if (next.size >= BATCH_LIMIT) break
    if (!next.has(row.id)) next.set(row.id, row.label)
  }
  return next
}

/**
 * Se a tela oferece "selecionar todos os N do filtro".
 *
 * Só quando o total cabe no lote, e nunca com o filtro de contrato do SGP
 * ligado: esse filtro é aplicado na tela, página por página, e o total que o
 * servidor devolve não é o que o operador está vendo — marcaria aparelhos que
 * o recorte na tela esconde.
 */
export function canSelectWholeFilter(total: number, selectedSize: number, contractFiltered: boolean): boolean {
  return !contractFiltered && total > 0 && total <= BATCH_LIMIT && selectedSize < total
}
