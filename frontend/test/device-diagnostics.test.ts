import { describe, expect, it } from 'vitest'

import {
  DIAGNOSTIC_TIMEOUT_MS,
  diagnosticPhase,
  isValidDiagnosticHost,
  pingLossPercent
} from '@/lib/device-diagnostics'

/**
 * A conferência do destino é escrita duas vezes — aqui e no backend, que é
 * quem recusa de verdade. O teste importa a do backend e exige a mesma
 * resposta caso a caso: uma tela que acende o botão para o que o servidor
 * recusa é um erro que o operador só vê depois de clicar.
 */
const backendUrl = new URL('../../backend/src/services/deviceDiagnostics.js', import.meta.url).href
const backend = (await import(/* @vite-ignore */ backendUrl)) as {
  isValidDiagnosticHost: (host: unknown) => boolean
}

const CASOS: unknown[] = [
  '8.8.8.8', ' 1.1.1.1 ', '0.0.0.0', '255.255.255.255', '2001:4860:4860::8888', '::1', 'fe80::1',
  '1:2:3:4:5:6:7:8', 'google.com', 'dns.provedor.net.br', 'localhost',
  '', '   ', null, undefined, 42, 'http://google.com', 'google.com:443', '8.8.8.8:53', 'a b',
  'google.com/x', '10.0.0.300', '256.1.1.1', '1.2.3', '01.2.3.4', '-inicio.com', 'fim-.com', 'a..b',
  '1:2:3', '1::2::3', '1:2:3:4:5:6:7:8:9', `${'a'.repeat(64)}.com`, 'g$oogle.com', '8.8.8.8;reboot'
]

describe('o destino do diagnóstico', () => {
  it('diz o mesmo que o backend, caso a caso', () => {
    for (const caso of CASOS) {
      expect(isValidDiagnosticHost(caso), JSON.stringify(caso)).toBe(backend.isValidDiagnosticHost(caso))
    }
  })

  it('aceita IP e nome, e recusa URL, porta e o vazio', () => {
    expect(isValidDiagnosticHost('8.8.8.8')).toBe(true)
    expect(isValidDiagnosticHost('google.com')).toBe(true)
    expect(isValidDiagnosticHost('http://google.com')).toBe(false)
    expect(isValidDiagnosticHost('8.8.8.8:53')).toBe(false)
    expect(isValidDiagnosticHost('')).toBe(false)
  })
})

describe('em que pé a tela está', () => {
  const inicio = 1_000_000

  it('terminado e erro são respostas, a qualquer hora', () => {
    expect(diagnosticPhase({ state: 'complete' }, inicio, inicio + 1)).toBe('done')
    expect(diagnosticPhase({ state: 'error' }, inicio, inicio + DIAGNOSTIC_TIMEOUT_MS * 2)).toBe('failed')
  })

  it('rodando, ou ainda sem nada, espera até o prazo — e não além', () => {
    expect(diagnosticPhase({ state: 'running' }, inicio, inicio + 5_000)).toBe('running')
    expect(diagnosticPhase({ state: 'idle' }, inicio, inicio + 5_000)).toBe('running')
    expect(diagnosticPhase(null, inicio, inicio)).toBe('running')
    expect(diagnosticPhase({ state: 'running' }, inicio, inicio + DIAGNOSTIC_TIMEOUT_MS - 1)).toBe('running')
    expect(diagnosticPhase({ state: 'running' }, inicio, inicio + DIAGNOSTIC_TIMEOUT_MS)).toBe('timedOut')
    expect(diagnosticPhase(null, inicio, inicio + DIAGNOSTIC_TIMEOUT_MS)).toBe('timedOut')
  })
})

describe('a perda do ping', () => {
  const ping = (success: number | null, failure: number | null) => ({
    success, failure, average: null, minimum: null, maximum: null
  })

  it('em porcentagem inteira', () => {
    expect(pingLossPercent(ping(4, 0))).toBe(0)
    expect(pingLossPercent(ping(3, 1))).toBe(25)
    expect(pingLossPercent(ping(0, 4))).toBe(100)
    expect(pingLossPercent(ping(2, 1))).toBe(33)
  })

  it('sem contagem, não inventa zero', () => {
    expect(pingLossPercent(null)).toBeNull()
    expect(pingLossPercent(ping(null, 0))).toBeNull()
    expect(pingLossPercent(ping(0, 0))).toBeNull()
  })
})
