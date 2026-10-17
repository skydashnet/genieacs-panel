import { describe, expect, it } from 'vitest'
import { missingText, variableLabel } from '../src/components/whatsapp/wa-variables'

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join('|')})` : key

describe('template variable labels', () => {
  it('traduz a variável conhecida e devolve o nome cru da desconhecida', () => {
    expect(variableLabel(t, 'pix')).toBe('whatsapp.variable.pix')
    expect(variableLabel(t, 'nova_variavel')).toBe('nova_variavel')
  })

  it('diz quais faltaram, ou nada quando a lista está vazia', () => {
    expect(missingText(t, ['pix', 'link_boleto']))
      .toBe('whatsapp.dunning.skip.templateMissing(whatsapp.variable.pix, whatsapp.variable.link_boleto)')
    expect(missingText(t, [])).toBeNull()
    expect(missingText(t, undefined)).toBeNull()
  })
})
