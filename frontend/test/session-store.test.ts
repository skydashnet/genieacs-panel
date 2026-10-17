import { afterEach, describe, expect, it, vi } from 'vitest'

import { storedSession } from '@/lib/api'

/**
 * A precedência entre as duas gavetas onde uma sessão pode estar.
 *
 * O que está em jogo é o console da plataforma: ele abre o painel de um
 * provedor numa ABA NOVA e continua aberto atrás. Numa instalação de host
 * único as duas abas dividem o mesmo `localStorage`, então a sessão de
 * personificação vive no `sessionStorage`, que é por aba — e numa aba dessas
 * as duas gavetas estão cheias ao mesmo tempo. Quem tem de ganhar é a da aba.
 *
 * Ambiente `node`, sem DOM: o que estas funções leem são os dois storages e o
 * `window`, e é isso que o teste finge, como os outros deste diretório fazem.
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

function navegador(sessao: Record<string, string>, navegadorTodo: Record<string, string>) {
  vi.stubGlobal('window', {})
  vi.stubGlobal('sessionStorage', gaveta(sessao))
  vi.stubGlobal('localStorage', gaveta(navegadorTodo))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a sessão guardada no navegador', () => {
  it('é a do navegador quando só ela existe', () => {
    navegador({}, { token: 'do-operador', refreshToken: 'renova' })
    expect(storedSession()).toEqual({
      token: 'do-operador',
      refreshToken: 'renova',
      tabScoped: false
    })
  })

  it('é a da aba quando as duas existem, e sem refresh token', () => {
    navegador({ token: 'da-personificacao' }, { token: 'do-console', refreshToken: 'renova' })
    expect(storedSession()).toEqual({
      token: 'da-personificacao',
      refreshToken: null,
      tabScoped: true
    })
  })

  it('não é nenhuma quando nada foi guardado', () => {
    navegador({}, {})
    expect(storedSession()).toEqual({ token: null, refreshToken: null, tabScoped: false })
  })

  it('não tenta ler storage nenhum fora do navegador', () => {
    vi.stubGlobal('window', undefined)
    expect(storedSession()).toEqual({ token: null, refreshToken: null, tabScoped: false })
  })
})
