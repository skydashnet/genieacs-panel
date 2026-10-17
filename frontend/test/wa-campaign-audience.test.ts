import { describe, expect, it } from 'vitest'
import { estimatedHours, localInputToIso, parseContracts, toggleValue } from '../src/components/whatsapp/campaign-audience'

describe('campaign audience helpers', () => {
  it('lê contratos colados em linhas, vírgulas e espaços, sem repetir', () => {
    expect(parseContracts('101\n102, 103;104  101\n\n')).toEqual(['101', '102', '103', '104'])
    expect(parseContracts('   ')).toEqual([])
  })

  it('liga e desliga um valor da seleção', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('estima as horas de envio pelo ritmo', () => {
    expect(estimatedHours(0, 90)).toBe(0)
    expect(estimatedHours(10, 90)).toBe(1)
    expect(estimatedHours(200, 90)).toBe(3)
  })

  it('converte o campo datetime-local', () => {
    expect(localInputToIso('')).toBeNull()
    expect(localInputToIso('não é data')).toBeNull()
    expect(localInputToIso('2026-10-01T09:30')).toMatch(/^2026-10-01T/)
  })
})
