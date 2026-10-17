import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '@/lib/api'
import { crossTabTokenAction, tokenIdentity } from '@/lib/cross-tab-session'

/**
 * O que a aba faz quando outra aba do navegador troca ou apaga o token.
 * Ambiente `node`: os tokens são montados à mão, sem assinatura — o cliente
 * só lê o payload, quem verifica é o servidor.
 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.assinatura`
}

const a1 = jwt({ userId: 1, tenantId: 10, role: 'admin', iat: 1 })
const a1Renovado = jwt({ userId: 1, tenantId: 10, role: 'admin', iat: 2 })
const outroProvedor = jwt({ userId: 1, tenantId: 11, role: 'admin', iat: 2 })
const outroUsuario = jwt({ userId: 2, tenantId: 10, role: 'admin', iat: 2 })
const console1 = jwt({ userId: 1, platform: true, iat: 1 })

describe('quem o token diz que é', () => {
  it('o usuário e o provedor, ou o console', () => {
    expect(tokenIdentity(a1)).toBe('t10:1')
    expect(tokenIdentity(console1)).toBe('platform:1')
  })

  it('nada quando não dá para ler', () => {
    expect(tokenIdentity(null)).toBeNull()
    expect(tokenIdentity('lixo')).toBeNull()
    expect(tokenIdentity('a.%%%.c')).toBeNull()
    expect(tokenIdentity(jwt({ tenantId: 10 }))).toBeNull()
  })
})

describe('a ação da aba', () => {
  const base = { key: 'token', current: a1, tabScoped: false }

  it('ignora outras chaves, o mesmo valor e a aba de personificação', () => {
    expect(crossTabTokenAction({ ...base, key: 'refreshToken', newValue: null })).toBe('ignore')
    expect(crossTabTokenAction({ ...base, newValue: a1 })).toBe('ignore')
    expect(crossTabTokenAction({ ...base, tabScoped: true, newValue: null })).toBe('ignore')
    expect(crossTabTokenAction({ ...base, tabScoped: true, newValue: outroProvedor })).toBe('ignore')
  })

  it('sai junto quando a outra aba saiu', () => {
    expect(crossTabTokenAction({ ...base, newValue: null })).toBe('logout')
    // `localStorage.clear()` chega com `key` nulo.
    expect(crossTabTokenAction({ ...base, key: null, newValue: null })).toBe('logout')
  })

  it('adota em silêncio o refresh da mesma sessão', () => {
    expect(crossTabTokenAction({ ...base, newValue: a1Renovado })).toBe('adopt')
  })

  it('recarrega quando a sessão é outra ou não dá para comparar', () => {
    expect(crossTabTokenAction({ ...base, newValue: outroProvedor })).toBe('reload')
    expect(crossTabTokenAction({ ...base, newValue: outroUsuario })).toBe('reload')
    expect(crossTabTokenAction({ ...base, current: console1, newValue: a1 })).toBe('reload')
    expect(crossTabTokenAction({ ...base, newValue: 'lixo' })).toBe('reload')
    // Deslogada aqui, logada na outra: recarrega para entrar.
    expect(crossTabTokenAction({ ...base, current: null, newValue: a1 })).toBe('reload')
  })
})

describe('o cliente diante do evento', () => {
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

  let navegador: Storage
  let eventos: string[]
  let recarregou: number

  beforeEach(() => {
    navegador = gaveta()
    eventos = []
    recarregou = 0
    vi.stubGlobal('sessionStorage', gaveta())
    vi.stubGlobal('localStorage', navegador)
    vi.stubGlobal('window', {
      dispatchEvent: (e: Event) => { eventos.push(e.type); return true },
      location: { reload: () => { recarregou++ } }
    })
    apiClient.beginSession(a1, 'refresh-1')
    eventos = []
  })

  afterEach(() => {
    apiClient.clearTokens()
    vi.unstubAllGlobals()
  })

  it('adota o token e o refresh token renovados na outra aba', async () => {
    navegador.setItem('token', a1Renovado)
    navegador.setItem('refreshToken', 'refresh-2')
    apiClient.handleStorageEvent({ key: 'token', newValue: a1Renovado })

    const fetchFalso = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true, auth: (init.headers as Record<string, string>).Authorization })
    }))
    vi.stubGlobal('fetch', fetchFalso)
    const res = await apiClient.get<unknown>('/devices') as unknown as { auth: string }
    expect(res.auth).toBe(`Bearer ${a1Renovado}`)
    expect(recarregou).toBe(0)
    expect(eventos).toEqual([])
  })

  it('sai quando a outra aba saiu', () => {
    apiClient.handleStorageEvent({ key: 'token', newValue: null })
    expect(eventos).toContain('auth:unauthorized')
  })

  it('recarrega quando a outra aba entrou como outra sessão', () => {
    apiClient.handleStorageEvent({ key: 'token', newValue: outroProvedor })
    expect(recarregou).toBe(1)
  })
})
