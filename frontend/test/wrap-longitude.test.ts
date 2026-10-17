import { describe, expect, it } from 'vitest'
import { wrapLongitude } from '@/components/location-picker'

describe('wrapLongitude', () => {
  it('traz a longitude de outra volta do globo para ±180', () => {
    expect(wrapLongitude(304.007213)).toBe(-55.992787)
    expect(wrapLongitude(-416)).toBe(-56)
    expect(wrapLongitude(540)).toBe(-180)
  })

  it('não mexe no que já está no intervalo', () => {
    expect(wrapLongitude(-55.992787)).toBe(-55.992787)
    expect(wrapLongitude(180)).toBe(180)
    expect(wrapLongitude(-180)).toBe(-180)
  })
})
