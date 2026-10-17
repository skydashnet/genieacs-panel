import { describe, expect, it } from 'vitest'
import { callHref } from '@/lib/wa-call'

describe('callHref', () => {
  it('monta o tel: em E.164', () => {
    expect(callHref('5593991467556')).toBe('tel:+5593991467556')
    expect(callHref('+55 (93) 99146-7556')).toBe('tel:+5593991467556')
  })

  it('sem número de telefone, sem link', () => {
    expect(callHref(null)).toBeNull()
    expect(callHref('')).toBeNull()
    expect(callHref('12345')).toBeNull()
  })
})
