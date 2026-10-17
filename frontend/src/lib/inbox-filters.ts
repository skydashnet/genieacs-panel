export type AssigneeFilter = 'all' | 'me' | 'unassigned'

export type ActiveFilter = { kind: 'assignee'; value: 'me' | 'unassigned' } | { kind: 'tag'; value: number }

/** Os recortes fora das abas que estão ligados: viram chips e o contador do botão. */
export function activeFilters(assignee: AssigneeFilter, tagId: number | null): ActiveFilter[] {
  const out: ActiveFilter[] = []
  if (assignee !== 'all') out.push({ kind: 'assignee', value: assignee })
  if (tagId !== null) out.push({ kind: 'tag', value: tagId })
  return out
}
