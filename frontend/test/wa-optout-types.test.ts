import { describe, expect, it } from 'vitest'
import { ALL_OPT_OUT_TYPES, categoriesFor, selectionFor, toggleType } from '../src/lib/wa-optout-types'

describe('tipos do não perturbe', () => {
  it('tudo marcado é "todos" para o servidor (null), e menos que isso é a lista', () => {
    expect(categoriesFor([...ALL_OPT_OUT_TYPES])).toBeNull()
    expect(categoriesFor(['marketing', 'billing'])).toEqual(['billing', 'marketing'])
    expect(categoriesFor([])).toEqual([])
  })

  it('o que está gravado volta para a seleção; null é tudo', () => {
    expect(selectionFor(null)).toEqual([...ALL_OPT_OUT_TYPES])
    expect(selectionFor(['marketing'])).toEqual(['marketing'])
    expect(selectionFor(['marketing', 'inventado'])).toEqual(['marketing'])
  })

  it('marcar e desmarcar mantém a ordem fixa', () => {
    expect(toggleType(['marketing'], 'billing')).toEqual(['billing', 'marketing'])
    expect(toggleType(['billing', 'marketing'], 'billing')).toEqual(['marketing'])
  })
})
