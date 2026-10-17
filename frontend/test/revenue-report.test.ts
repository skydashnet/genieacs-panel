import { describe, expect, it } from 'vitest'

import {
  MAX_RANGE_MONTHS,
  lastTwelveMonths,
  monthLabel,
  monthsSpanned,
  netCents,
  niceCeiling,
  parseIsoDay,
  validateRange,
  yearToDate
} from '@/lib/revenue-report'

/**
 * As contas da aba Receita. A validação do período é a do servidor repetida
 * aqui de propósito — recusar antes de perguntar —, e por isso a mesma régua:
 * meses de calendário tocados, teto de 36.
 */
describe('o período do relatório de receita', () => {
  const agora = new Date('2026-10-03T12:00:00Z')

  it('o padrão são os últimos doze meses, como no servidor', () => {
    expect(lastTwelveMonths(agora)).toEqual({ from: '2025-11-01', to: '2026-10-03' })
    expect(yearToDate(agora)).toEqual({ from: '2026-01-01', to: '2026-10-03' })
  })

  it('recusa data que não existe, período invertido e mais de 36 meses', () => {
    expect(parseIsoDay('2026-02-30')).toBeNull()
    expect(parseIsoDay('2026-02-28')).toBe(Date.UTC(2026, 1, 28))
    expect(validateRange({ from: '', to: '2026-01-01' })).toBe('invalid_date')
    expect(validateRange({ from: '2026-05-01', to: '2026-04-30' })).toBe('invalid_range')
    expect(validateRange({ from: '2023-01-01', to: '2026-01-31' })).toBe('range_too_long')
    expect(validateRange({ from: '2023-02-15', to: '2026-01-02' })).toBeNull()
    expect(monthsSpanned(Date.UTC(2023, 1, 15), Date.UTC(2026, 0, 2))).toBe(MAX_RANGE_MONTHS)
  })
})

describe('o gráfico mensal', () => {
  it('arredonda o topo do eixo para um valor redondo', () => {
    expect(niceCeiling(0)).toBe(0)
    expect(niceCeiling(-5)).toBe(0)
    expect(niceCeiling(1)).toBe(1)
    expect(niceCeiling(130)).toBe(200)
    expect(niceCeiling(2100)).toBe(2500)
    expect(niceCeiling(4800)).toBe(5000)
    expect(niceCeiling(5001)).toBe(10000)
  })

  it('escreve o mês no idioma da tela, sem escorregar de fuso', () => {
    expect(monthLabel('2026-01', 'en-US', 'long')).toBe('January 2026')
    expect(monthLabel('lixo', 'en-US')).toBe('lixo')
  })

  it('o líquido é recebido menos estornado', () => {
    expect(netCents({ receivedCents: 30000, refundedCents: 10000 })).toBe(20000)
  })
})
