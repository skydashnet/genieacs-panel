import { afterEach, describe, expect, it } from 'vitest'
import {
  displayDate,
  formatDateValue,
  displayDayMonth,
  formatDayMonth,
  isoDay,
  setActiveDateFormat,
  toDate
} from '../src/lib/date-format'
import { getIntlLocale } from '../src/lib/i18n/runtime'

afterEach(() => setActiveDateFormat('auto'))

describe('formato da data', () => {
  it('um dia puro é o dia do calendário, sem fuso empurrando para a véspera', () => {
    const d = toDate('2026-05-02')!
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 5, 2])
    expect(toDate('')).toBeNull()
    expect(toDate('não é data')).toBeNull()
  })

  it('escreve cada ordem da lista', () => {
    const v = '2026-05-02'
    const f = (format: Parameters<typeof formatDateValue>[1]['format']) => formatDateValue(v, { format, intlLocale: 'pt-BR' })
    expect(f('dd/MM/yyyy')).toBe('02/05/2026')
    expect(f('MM/dd/yyyy')).toBe('05/02/2026')
    expect(f('yyyy-MM-dd')).toBe('2026-05-02')
    expect(f('dd-MM-yyyy')).toBe('02-05-2026')
    expect(f('dd.MM.yyyy')).toBe('02.05.2026')
    expect(f('auto')).toBe('02/05/2026')
    expect(formatDateValue('2026-05-02', { format: 'auto', intlLocale: 'en-US' })).toBe('5/2/26')
  })

  it('com hora, só quando o valor tem hora', () => {
    const v = new Date(2026, 9, 2, 3, 31, 36)
    expect(formatDateValue(v, { format: 'dd/MM/yyyy', intlLocale: 'pt-BR', time: 'short' })).toBe('02/10/2026 03:31')
    expect(formatDateValue(v, { format: 'yyyy-MM-dd', intlLocale: 'pt-BR', time: 'seconds' })).toBe('2026-10-02 03:31:36')
    expect(formatDateValue('2026-10-02', { format: 'dd/MM/yyyy', intlLocale: 'pt-BR', time: 'short' })).toBe('02/10/2026')
  })

  it('o formato ativo vale para quem está fora do React', () => {
    setActiveDateFormat('yyyy-MM-dd')
    expect(displayDate('2026-05-02')).toBe('2026-05-02')
    setActiveDateFormat('valor estranho')
    expect(displayDate('2026-05-02')).toBe(formatDateValue('2026-05-02', { format: 'auto', intlLocale: getIntlLocale() }))
  })

  it('dia e mês na ordem escolhida', () => {
    const d = new Date(2026, 9, 2)
    expect(formatDayMonth(d, 'dd/MM/yyyy', 'pt-BR')).toBe('02/10')
    expect(formatDayMonth(d, 'MM/dd/yyyy', 'pt-BR')).toBe('10/02')
    expect(formatDayMonth(d, 'yyyy-MM-dd', 'pt-BR')).toBe('10-02')
    expect(formatDayMonth(d, 'dd.MM.yyyy', 'pt-BR')).toBe('02.10')
  })

  it('reconhece o dia do SGP e deixa o resto como veio', () => {
    expect(isoDay('2026-05-02')).toBe('2026-05-02')
    expect(isoDay('2026-05-02 00:00:00')).toBe('2026-05-02')
    expect(isoDay('02/05/2026')).toBeNull()
    expect(isoDay(null)).toBeNull()
  })
})

describe('displayDayMonth', () => {
  it('dia e mês na ordem do provedor, e nulo para vazio', () => {
    setActiveDateFormat('dd/MM/yyyy')
    expect(displayDayMonth(new Date(2026, 9, 10, 23, 59, 59))).toBe('10/10')
    expect(displayDayMonth('2026-10-02')).toBe('02/10')
    setActiveDateFormat('MM/dd/yyyy')
    expect(displayDayMonth('2026-10-02')).toBe('10/02')
    expect(displayDayMonth(null)).toBeNull()
    expect(displayDayMonth('nada')).toBeNull()
  })
})
