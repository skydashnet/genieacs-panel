import { describe, expect, it } from 'vitest'

import {
  BATCH_LIMIT,
  canSelectWholeFilter,
  pageSelectionState,
  toggleOne,
  togglePage,
  type SelectableRow
} from '@/lib/device-batch'

const backendUrl = new URL('../../backend/src/services/deviceBatch.js', import.meta.url).href
const backend = (await import(/* @vite-ignore */ backendUrl)) as { BATCH_LIMIT: number }

const linhas = (n: number, prefixo = 'ONT'): SelectableRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefixo}-${i}`, label: `S${i}` }))

describe('o teto do lote', () => {
  it('é o mesmo do backend', () => {
    expect(BATCH_LIMIT).toBe(backend.BATCH_LIMIT)
  })

  it('marcar um além do teto não faz nada; desmarcar sempre faz', () => {
    const cheio = togglePage(new Map(), linhas(BATCH_LIMIT))
    expect(cheio.size).toBe(BATCH_LIMIT)
    expect(toggleOne(cheio, { id: 'mais-um', label: 'X' }).size).toBe(BATCH_LIMIT)
    expect(toggleOne(cheio, { id: 'ONT-0', label: 'S0' }).size).toBe(BATCH_LIMIT - 1)
  })

  it('marcar a página para no teto', () => {
    const quase = togglePage(new Map(), linhas(BATCH_LIMIT - 3))
    const depois = togglePage(quase, linhas(10, 'OUTRA'))
    expect(depois.size).toBe(BATCH_LIMIT)
    expect([...depois.keys()].filter((id) => id.startsWith('OUTRA'))).toEqual(['OUTRA-0', 'OUTRA-1', 'OUTRA-2'])
  })
})

describe('a caixa do cabeçalho', () => {
  const pagina = linhas(3)

  it('diz se a página está toda marcada, em parte, ou nada', () => {
    expect(pageSelectionState(new Map(), pagina)).toBe('none')
    expect(pageSelectionState(new Map([['ONT-1', 'S1']]), pagina)).toBe('some')
    expect(pageSelectionState(togglePage(new Map(), pagina), pagina)).toBe('all')
  })

  it('marca o que falta, e com tudo marcado desmarca só a página', () => {
    const outra = new Map([['OUTRA', 'O']])
    const parcial = new Map([...outra, ['ONT-0', 'S0']])
    const tudo = togglePage(parcial, pagina)
    expect([...tudo.keys()].sort()).toEqual(['ONT-0', 'ONT-1', 'ONT-2', 'OUTRA'])
    expect([...togglePage(tudo, pagina).keys()]).toEqual(['OUTRA'])
  })

  it('página vazia não marca nem desmarca nada', () => {
    const sel = new Map([['X', 'x']])
    expect(togglePage(sel, [])).toEqual(sel)
  })
})

describe('"selecionar todos os N do filtro"', () => {
  it('só quando o total cabe no lote e ainda falta marcar', () => {
    expect(canSelectWholeFilter(37, 25, false)).toBe(true)
    expect(canSelectWholeFilter(BATCH_LIMIT, 0, false)).toBe(true)
    expect(canSelectWholeFilter(BATCH_LIMIT + 1, 0, false)).toBe(false)
    expect(canSelectWholeFilter(37, 37, false)).toBe(false)
    expect(canSelectWholeFilter(0, 0, false)).toBe(false)
  })

  it('nunca com o filtro de contrato, que é aplicado só na tela', () => {
    expect(canSelectWholeFilter(37, 0, true)).toBe(false)
  })
})
