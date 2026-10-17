import { describe, expect, it } from 'vitest'

import { filterWifiByStatus, parseWifiStatusFilter } from '@/lib/wifi-filter'

const networks = [
  { index: 1, enable: true },
  { index: 2, enable: false },
  { index: 3, enable: null },
  { index: 4, enable: undefined },
]

describe('filterWifiByStatus', () => {
  const run = (filter: 'all' | 'enabled' | 'disabled' | 'unknown') =>
    filterWifiByStatus(networks, filter, (n) => n.enable)

  it('conta ativas, desativadas e desconhecidas separadamente', () => {
    expect(run('all').counts).toEqual({ all: 4, enabled: 1, disabled: 1, unknown: 2 })
  })

  it('mostra todas por padrão', () => {
    expect(run('all').visible.map((n) => n.index)).toEqual([1, 2, 3, 4])
  })

  it('mostra só as ativas', () => {
    expect(run('enabled').visible.map((n) => n.index)).toEqual([1])
  })

  it('mostra só as desativadas', () => {
    expect(run('disabled').visible.map((n) => n.index)).toEqual([2])
  })

  it('mostra só as de estado desconhecido', () => {
    expect(run('unknown').visible.map((n) => n.index)).toEqual([3, 4])
  })
})

describe('parseWifiStatusFilter', () => {
  it('aceita as três opções', () => {
    expect(parseWifiStatusFilter('enabled')).toBe('enabled')
    expect(parseWifiStatusFilter('disabled')).toBe('disabled')
    expect(parseWifiStatusFilter('all')).toBe('all')
    expect(parseWifiStatusFilter('unknown')).toBe('unknown')
  })

  it('volta para "all" com valor ausente ou inválido', () => {
    expect(parseWifiStatusFilter(null)).toBe('all')
    expect(parseWifiStatusFilter(undefined)).toBe('all')
    expect(parseWifiStatusFilter('ativas')).toBe('all')
  })
})
