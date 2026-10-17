import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearDashboardSnapshot, readDashboardSnapshot, writeDashboardSnapshot } from '@/lib/dashboard-snapshot'

/**
 * A cópia do dashboard que a aba guarda tem dono. Sem isso, trocar de provedor
 * na mesma aba — ou abrir a personificação, que herda o `sessionStorage` do
 * console — mostrava os números do provedor anterior.
 */
function gaveta(inicial: Record<string, string> = {}): Storage {
  const dados = new Map(Object.entries(inicial))
  return {
    get length() { return dados.size },
    key: (i: number) => [...dados.keys()][i] ?? null,
    getItem: (k: string) => dados.get(k) ?? null,
    setItem: (k: string, v: string) => { dados.set(k, String(v)) },
    removeItem: (k: string) => { dados.delete(k) },
    clear: () => dados.clear()
  }
}

let sessao: Storage

beforeEach(() => {
  sessao = gaveta()
  vi.stubGlobal('sessionStorage', sessao)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a cópia do dashboard', () => {
  it('volta para o mesmo dono', () => {
    writeDashboardSnapshot('provedor-a:1', { total: 146 })
    expect(readDashboardSnapshot('provedor-a:1')).toEqual({ total: 146 })
  })

  it('não aparece para outro provedor', () => {
    writeDashboardSnapshot('provedor-a:1', { total: 146 })
    expect(readDashboardSnapshot('provedor-b:1')).toBeNull()
  })

  it('não é lida nem gravada sem usuário', () => {
    writeDashboardSnapshot(null, { total: 146 })
    expect(sessao.length).toBe(0)
    writeDashboardSnapshot('provedor-a:1', { total: 146 })
    expect(readDashboardSnapshot(null)).toBeNull()
  })

  it('ignora e apaga a chave antiga, que não tinha dono', () => {
    sessao.setItem('skygenpanel.dashboard.snapshot.v1', JSON.stringify({ total: 146 }))
    expect(readDashboardSnapshot('provedor-b:1')).toBeNull()
    expect(sessao.getItem('skygenpanel.dashboard.snapshot.v1')).toBeNull()
  })

  it('some quando a sessão é limpa', () => {
    writeDashboardSnapshot('provedor-a:1', { total: 146 })
    clearDashboardSnapshot()
    expect(readDashboardSnapshot('provedor-a:1')).toBeNull()
  })
})
