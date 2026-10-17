import { describe, expect, it } from 'vitest'

import { TEMPLATE_NAME_LIMIT, copyName } from '@/components/whatsapp/template-copy'

/**
 * O nome de um modelo duplicado. O servidor recusa nome repetido, então a
 * cópia nasce com um nome livre — e cabendo na coluna.
 */
describe('copyName', () => {
  it('acrescenta "(cópia)" quando está livre', () => {
    expect(copyName('Régua · 1 dia de atraso', ['Régua · 1 dia de atraso'], 'cópia'))
      .toBe('Régua · 1 dia de atraso (cópia)')
  })

  it('numera quando a cópia já existe, sem ligar para maiúsculas', () => {
    const existentes = ['Lembrete', 'lembrete (CÓPIA)', 'Lembrete (cópia 2)']
    expect(copyName('Lembrete', existentes, 'cópia')).toBe('Lembrete (cópia 3)')
  })

  it('corta o nome, nunca o sufixo, para caber em 80 caracteres', () => {
    const longo = 'x'.repeat(TEMPLATE_NAME_LIMIT)
    const nome = copyName(longo, [longo], 'cópia')
    expect(nome.length).toBeLessThanOrEqual(TEMPLATE_NAME_LIMIT)
    expect(nome.endsWith(' (cópia)')).toBe(true)
  })

  it('usa o sufixo do idioma da tela', () => {
    expect(copyName('Reminder', [], 'copy')).toBe('Reminder (copy)')
  })
})
