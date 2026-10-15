import { describe, expect, it } from 'vitest'
import { linkify } from '@/lib/linkify'

describe('linkify', () => {
  it('liga o link da localização', () => {
    expect(linkify('📍 Localização\nhttps://www.google.com/maps?q=-16.7,-49.2')).toEqual([
      { text: '📍 Localização\n' },
      { text: 'https://www.google.com/maps?q=-16.7,-49.2', href: 'https://www.google.com/maps?q=-16.7,-49.2' }
    ])
  })
  it('deixa a pontuação final fora do link', () => {
    expect(linkify('veja http://a.com/x).')).toEqual([
      { text: 'veja ' },
      { text: 'http://a.com/x', href: 'http://a.com/x' },
      { text: ').' }
    ])
  })
  it('não liga esquemas perigosos nem texto simples', () => {
    expect(linkify('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }])
    expect(linkify('')).toEqual([])
  })
})
