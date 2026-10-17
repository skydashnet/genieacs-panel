import { describe, expect, it } from 'vitest'
import { brazilDigits, hasContact, mailtoHref, telHref, whatsappHref } from '@/lib/portal-contact'

describe('portal-contact', () => {
  it('normaliza telefone brasileiro para 55 + DDD + número', () => {
    expect(brazilDigits('(93) 3518-0000')).toBe('559335180000')
    expect(brazilDigits('93 99100-2222')).toBe('5593991002222')
    expect(brazilDigits('+55 93 99100-2222')).toBe('5593991002222')
    expect(brazilDigits('3518-0000')).toBeNull()
    expect(brazilDigits('')).toBeNull()
  })

  it('monta os links de discar, WhatsApp e e-mail', () => {
    expect(telHref('(93) 3518-0000')).toBe('tel:+559335180000')
    expect(whatsappHref('93 99100-2222')).toBe('https://wa.me/5593991002222')
    expect(mailtoHref('suporte@fibra.test')).toBe('mailto:suporte@fibra.test')
    expect(mailtoHref('javascript:alert(1)')).toBeNull()
    expect(whatsappHref(null)).toBeNull()
  })

  it('o cartão só aparece ligado e com algum dado', () => {
    expect(hasContact(null)).toBe(false)
    expect(hasContact({ enabled: false })).toBe(false)
    expect(hasContact({ enabled: true, name: 'Fibra' })).toBe(false)
    expect(hasContact({ enabled: true, name: 'Fibra', phone: '93 3518-0000' })).toBe(true)
  })
})
