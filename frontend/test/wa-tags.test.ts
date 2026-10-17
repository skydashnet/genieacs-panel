import { describe, expect, it } from 'vitest'
import { cleanTagName, nextTagColor, tagClass, tagNameProblem } from '../src/lib/wa-tags'

describe('etiquetas', () => {
  it('limpa o nome como o servidor', () => {
    expect(cleanTagName('  Suporte   técnico ')).toBe('Suporte técnico')
  })

  it('aponta nome vazio, longo ou repetido', () => {
    const outras = [{ name: 'Financeiro' }]
    expect(tagNameProblem('  ', outras)).toBe('empty')
    expect(tagNameProblem('x'.repeat(41), outras)).toBe('long')
    expect(tagNameProblem('financeiro', outras)).toBe('taken')
    expect(tagNameProblem('Venda', outras)).toBeNull()
  })

  it('pinta pela paleta e sugere a cor menos usada', () => {
    expect(tagClass('violet')).toBe('wa-account-violet')
    expect(tagClass('red')).toBe('wa-account-blue')
    expect(nextTagColor([])).toBe('blue')
    expect(nextTagColor(['blue'])).toBe('pink')
  })
})
