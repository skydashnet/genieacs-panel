import { describe, expect, it } from 'vitest'
import { healthBadge } from '../src/lib/wa-health-badge'

describe('healthBadge', () => {
  it('um vermelho entre amarelos deixa o sino vermelho, contando todos os avisos', () => {
    expect(healthBadge(['calm', 'warn', 'alarm', 'warn', 'calm'], false)).toEqual({
      tone: 'alarm',
      count: 3,
      unreadable: false
    })
  })

  it('só amarelos deixam o sino amarelo', () => {
    expect(healthBadge(['calm', 'warn', 'calm'], false)).toEqual({ tone: 'warn', count: 1, unreadable: false })
  })

  it('tudo calmo não acende nada', () => {
    expect(healthBadge(['calm', 'calm', 'calm'], false)).toEqual({ tone: 'calm', count: 0, unreadable: false })
    expect(healthBadge([], false)).toEqual({ tone: 'calm', count: 0, unreadable: false })
  })

  it('não conseguir ler a saúde é vermelho, e não calma', () => {
    expect(healthBadge([], true)).toEqual({ tone: 'alarm', count: 0, unreadable: true })
    expect(healthBadge(['calm'], true).tone).toBe('alarm')
  })

  it('o caso da captura: sem conexão ausente, mas falhas e silêncio', () => {
    // 2 de 2 conectados (calmo), 9 na fila recente (calmo), 9 falhas (amarelo),
    // nada chegou há 1 dia (vermelho), disco (calmo).
    expect(healthBadge(['calm', 'calm', 'warn', 'alarm', 'calm'], false)).toEqual({
      tone: 'alarm',
      count: 2,
      unreadable: false
    })
  })
})
