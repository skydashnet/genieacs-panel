import { describe, expect, it } from 'vitest'
import { formatBrPhone } from '@/lib/phone'

describe('formatBrPhone', () => {
  it('formata o celular com nono dígito', () => {
    expect(formatBrPhone('5593991261076')).toBe('(93) 99126-1076')
  })

  it('formata o fixo e o celular sem o nono dígito', () => {
    expect(formatBrPhone('559335220001')).toBe('(93) 3522-0001')
    expect(formatBrPhone('559391329381')).toBe('(93) 9132-9381')
  })

  it('um DDD 55 não é confundido com o código do país', () => {
    expect(formatBrPhone('5555939118448')).toBe('(55) 93911-8448')
  })

  it('o que não parece telefone sai como veio', () => {
    expect(formatBrPhone('144')).toBe('144')
    expect(formatBrPhone('')).toBe('')
    expect(formatBrPhone(null)).toBe('')
  })
})
