import { describe, expect, it } from 'vitest'
import { visibleHeightWithKeyboard } from '../src/lib/wa-keyboard'

describe('visibleHeightWithKeyboard', () => {
  it('com o teclado aberto no iPhone, devolve a altura visível', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 460 })).toBe(460)
  })

  it('sem teclado, não muda nada', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 812 })).toBeNull()
  })

  it('a barra de endereço recolhendo não conta como teclado', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 760 })).toBeNull()
  })

  it('no Android a página já encolhe junto: nada a corrigir', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 460, vvHeight: 460 })).toBeNull()
  })

  it('valores inválidos não quebram a conta', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 0, vvHeight: 0 })).toBeNull()
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: Number.NaN })).toBeNull()
  })

  it('arredonda o zoom fracionário do iOS', () => {
    expect(visibleHeightWithKeyboard({ innerHeight: 812, vvHeight: 459.6 })).toBe(460)
  })
})
