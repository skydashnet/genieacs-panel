import { describe, expect, it } from 'vitest'
import { canGeocode, geocodeFields, isDefaultCenter } from '@/lib/provider-location'

describe('provider-location', () => {
  it('reconhece o centro padrão (Brasília), com ou sem arredondamento', () => {
    expect(isDefaultCenter(-15.7942, -47.8822)).toBe(true)
    expect(isDefaultCenter(-15.79420001, -47.88219999)).toBe(true)
    expect(isDefaultCenter(-4.263615, -55.992787)).toBe(false)
  })

  it('manda para a geocodificação só os campos de endereço preenchidos', () => {
    expect(geocodeFields({ legalName: 'X', addressLine: ' Rua A ', city: 'Itaituba', state: 'PA', district: '' }))
      .toEqual({ addressLine: 'Rua A', city: 'Itaituba', state: 'PA' })
  })

  it('exige cidade e UF', () => {
    expect(canGeocode({ city: 'Itaituba', state: 'PA' })).toBe(true)
    expect(canGeocode({ city: 'Itaituba', state: '' })).toBe(false)
  })
})
