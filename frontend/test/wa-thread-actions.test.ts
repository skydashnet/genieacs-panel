import { describe, expect, it } from 'vitest'
import { ACTION_LABELS_MIN_PX, showActionLabels } from '../src/lib/wa-thread-actions'

describe('showActionLabels', () => {
  it('coluna estreita (notebook, SGP aberto, celular): só ícone', () => {
    expect(showActionLabels(420)).toBe(false) // notebook de 1100 px
    expect(showActionLabels(600)).toBe(false) // 1600 px com o módulo SGP aberto
    expect(showActionLabels(360)).toBe(false) // celular
    expect(showActionLabels(ACTION_LABELS_MIN_PX - 1)).toBe(false)
  })

  it('coluna larga: com texto', () => {
    expect(showActionLabels(ACTION_LABELS_MIN_PX)).toBe(true)
    expect(showActionLabels(950)).toBe(true) // 1600 px com o SGP fechado
  })

  it('antes da primeira medida, só ícone — nada de texto piscando', () => {
    expect(showActionLabels(0)).toBe(false)
    expect(showActionLabels(Number.NaN)).toBe(false)
  })
})
