import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '@/lib/api'
import { readDashboardSnapshot, writeDashboardSnapshot } from '@/lib/dashboard-snapshot'
import { clearSessionScopedStorage, sessionOwner, WA_DOWN_DISMISSED_KEY } from '@/lib/session-owner'

/**
 * O dono da sessão da aba, e o que acontece com o que a aba guardou em nome
 * dele quando a sessão muda de dono.
 *
 * Ambiente `node`, sem DOM: os storages, o `window` e o `fetch` são fingidos,
 * como nos outros testes deste diretório.
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
let navegador: Storage

beforeEach(() => {
  sessao = gaveta()
  navegador = gaveta()
  vi.stubGlobal('sessionStorage', sessao)
  vi.stubGlobal('localStorage', navegador)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('o dono da sessão', () => {
  it('é o provedor e o usuário', () => {
    expect(sessionOwner({ id: 7, tenant: { slug: 'provedor-a', name: 'A' } })).toBe('provedor-a:7')
  })

  it('distingue o mesmo id em provedores diferentes', () => {
    expect(sessionOwner({ id: 1, tenant: { slug: 'provedor-a', name: 'A' } }))
      .not.toBe(sessionOwner({ id: 1, tenant: { slug: 'provedor-b', name: 'B' } }))
  })

  it('usa "-" quando a sessão não tem provedor', () => {
    expect(sessionOwner({ id: 3, tenant: null })).toBe('-:3')
    expect(sessionOwner({ id: 3 })).toBe('-:3')
  })

  it('não existe sem usuário', () => {
    expect(sessionOwner(null)).toBeNull()
    expect(sessionOwner(undefined)).toBeNull()
  })
})

describe('a limpeza do que a aba guarda pela sessão', () => {
  it('apaga a cópia do dashboard e a faixa do WhatsApp fechada', () => {
    writeDashboardSnapshot('provedor-a:1', { total: 146 })
    sessao.setItem(WA_DOWN_DISMISSED_KEY, '12,13')
    sessao.setItem('outra-coisa', 'fica')

    clearSessionScopedStorage()

    expect(readDashboardSnapshot('provedor-a:1')).toBeNull()
    expect(sessao.getItem(WA_DOWN_DISMISSED_KEY)).toBeNull()
    expect(sessao.getItem('outra-coisa')).toBe('fica')
  })

  it('não quebra com o storage bloqueado', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') }
    })
    expect(() => clearSessionScopedStorage()).not.toThrow()
  })
})

describe('um refresh que volta depois da troca de sessão', () => {
  function json(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }

  beforeEach(() => {
    vi.stubGlobal('window', { dispatchEvent: () => true })
  })

  afterEach(() => {
    apiClient.clearTokens()
  })

  it('é descartado: não grava os tokens da sessão anterior por cima da nova', async () => {
    apiClient.beginSession('token-a', 'refresh-a')

    let responderRefresh: (value: unknown) => void = () => {}
    const fetchFalso = vi.fn((url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return new Promise((resolve) => { responderRefresh = resolve })
      }
      return Promise.resolve(json(403, { success: false, code: 'invalid_token' }))
    })
    vi.stubGlobal('fetch', fetchFalso)

    const pedido = apiClient.get('/devices')
    // Até o refresh sair.
    await vi.waitFor(() => expect(fetchFalso).toHaveBeenCalledTimes(2))

    // Sair e entrar como outro provedor enquanto o refresh está no ar.
    apiClient.clearTokens()
    apiClient.beginSession('token-b', 'refresh-b')

    responderRefresh(json(200, { success: true, data: { token: 'token-a2', refreshToken: 'refresh-a2' } }))
    const res = await pedido

    expect(res.success).toBe(false)
    expect(navegador.getItem('token')).toBe('token-b')
    expect(navegador.getItem('refreshToken')).toBe('refresh-b')
    // O pedido antigo não foi refeito com token nenhum.
    expect(fetchFalso).toHaveBeenCalledTimes(2)
  })

  it('também não derruba a sessão nova quando falha', async () => {
    apiClient.beginSession('token-a', 'refresh-a')

    let responderRefresh: (value: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return new Promise((resolve) => { responderRefresh = resolve })
      }
      return Promise.resolve(json(403, { success: false, code: 'invalid_token' }))
    }))

    const pedido = apiClient.get('/devices')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    apiClient.beginSession('token-b', 'refresh-b')
    responderRefresh(json(401, { success: false }))
    await pedido

    expect(navegador.getItem('token')).toBe('token-b')
  })

  it('da mesma sessão continua renovando', async () => {
    apiClient.beginSession('token-a', 'refresh-a')

    let chamadas = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return Promise.resolve(json(200, { success: true, data: { token: 'token-a2', refreshToken: 'refresh-a2' } }))
      }
      chamadas += 1
      return Promise.resolve(chamadas === 1
        ? json(403, { success: false, code: 'invalid_token' })
        : json(200, { success: true, data: [] }))
    }))

    const res = await apiClient.get('/devices')

    expect(res.success).toBe(true)
    expect(navegador.getItem('token')).toBe('token-a2')
    expect(navegador.getItem('refreshToken')).toBe('refresh-a2')
  })
})
