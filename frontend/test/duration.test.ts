import { describe, expect, it } from 'vitest'
import { formatDuration } from '../src/lib/duration'

const labels = {
  seconds: (n: number) => `${n} s`,
  minutes: (n: number) => `${n} min`,
  hours: (h: number, m: number) => `${h} h ${m} min`,
  days: (d: number, h: number) => `${d} d ${h} h`
}

describe('formatDuration', () => {
  it('escolhe a unidade pelo tamanho', () => {
    expect(formatDuration(45, labels)).toBe('45 s')
    expect(formatDuration(240, labels)).toBe('4 min')
    expect(formatDuration(89, labels)).toBe('1 min')
    expect(formatDuration(4320, labels)).toBe('1 h 12 min')
    expect(formatDuration(3599, labels)).toBe('1 h 0 min')
    expect(formatDuration(97200, labels)).toBe('1 d 3 h')
  })

  it('sem valor vira travessão', () => {
    expect(formatDuration(null, labels)).toBe('—')
    expect(formatDuration(undefined, labels)).toBe('—')
    expect(formatDuration(Number.NaN, labels)).toBe('—')
  })
})
