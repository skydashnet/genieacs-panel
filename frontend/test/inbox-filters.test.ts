import { describe, expect, it } from 'vitest'
import { activeFilters } from '@/lib/inbox-filters'

describe('activeFilters', () => {
  it('não lista nada sem recorte', () => {
    expect(activeFilters('all', null)).toEqual([])
  })
  it('lista atendente e etiqueta ligados', () => {
    expect(activeFilters('me', 7)).toEqual([{ kind: 'assignee', value: 'me' }, { kind: 'tag', value: 7 }])
    expect(activeFilters('unassigned', null)).toEqual([{ kind: 'assignee', value: 'unassigned' }])
  })
})
