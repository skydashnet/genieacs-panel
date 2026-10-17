import { describe, expect, it } from 'vitest'
import { blockingOver, overagePriceFromInput } from '@/lib/overage'

describe('blockingOver', () => {
  const acima = { operators: true, subscribers: true, devices: false }

  it('sem preço de excedente, todo recurso acima do teto bloqueia', () => {
    expect(blockingOver(acima, null)).toEqual(['operators', 'subscribers'])
    expect(blockingOver(acima, undefined)).toEqual(['operators', 'subscribers'])
  })

  it('o recurso com preço não bloqueia; o sem preço continua bloqueando', () => {
    expect(blockingOver(acima, { operators: 1000, subscribers: null, devices: null })).toEqual(['subscribers'])
    expect(blockingOver(acima, { operators: 1000, subscribers: 200, devices: 300 })).toEqual([])
  })

  it('nada acima do teto, nada bloqueia', () => {
    expect(blockingOver({ operators: false, subscribers: false, devices: false }, null)).toEqual([])
  })
})

describe('overagePriceFromInput', () => {
  it('vazio é sem preço', () => {
    expect(overagePriceFromInput('')).toBeNull()
    expect(overagePriceFromInput('   ')).toBeNull()
  })

  it('lê dinheiro em centavos', () => {
    expect(overagePriceFromInput('10')).toBe(1000)
    expect(overagePriceFromInput('2,50')).toBe(250)
    expect(overagePriceFromInput('1.234,56')).toBe(123456)
  })

  it('zero e lixo são inválidos, não "de graça"', () => {
    expect(overagePriceFromInput('0')).toBeUndefined()
    expect(overagePriceFromInput('abc')).toBeUndefined()
  })
})
