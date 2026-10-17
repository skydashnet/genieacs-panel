import { describe, expect, it } from 'vitest'
import { panelLink } from '@/lib/panel-link'

describe('panelLink', () => {
  it('usa a URL do servidor quando ela vem', () => {
    expect(panelLink('https://alfa.exemplo.test/reset-password#abc', 'abc', '/reset-password', 'https://outro.test'))
      .toBe('https://alfa.exemplo.test/reset-password#abc')
  })

  it('sem URL, monta com o endereço desta aba', () => {
    expect(panelLink(null, 'abc', '/reset-password', 'https://painel.exemplo.test'))
      .toBe('https://painel.exemplo.test/reset-password#abc')
    expect(panelLink(undefined, 'xyz', '/invite', 'https://painel.exemplo.test/'))
      .toBe('https://painel.exemplo.test/invite#xyz')
  })
})
