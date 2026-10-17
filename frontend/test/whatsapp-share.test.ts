import { describe, expect, it } from 'vitest'

import { formatPhone, whatsappShareUrl } from '@/lib/whatsapp-share'

describe('o link do WhatsApp', () => {
  it('leva o número em dígitos e o texto codificado', () => {
    expect(whatsappShareUrl('+55 (11) 98765-4321', 'Olá & até'))
      .toBe('https://wa.me/5511987654321?text=Ol%C3%A1%20%26%20at%C3%A9')
  })

  it('sem número utilizável, deixa o WhatsApp perguntar para quem', () => {
    expect(whatsappShareUrl(null, 'x')).toBe('https://wa.me/?text=x')
    expect(whatsappShareUrl('12', 'x')).toBe('https://wa.me/?text=x')
  })
})

describe('o telefone na tela', () => {
  it('formata celular e fixo brasileiros', () => {
    expect(formatPhone('5511987654321')).toBe('+55 11 98765-4321')
    expect(formatPhone('552133334444')).toBe('+55 21 3333-4444')
  })

  it('internacional e vazio', () => {
    expect(formatPhone('14155552671')).toBe('+14155552671')
    expect(formatPhone(null)).toBe('')
  })
})
