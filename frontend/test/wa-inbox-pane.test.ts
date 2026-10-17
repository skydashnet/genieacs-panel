import { describe, expect, it } from 'vitest'
import { inboxPanes } from '../src/lib/wa-inbox-pane'

/** As classes que valem abaixo de `lg` (sem prefixo) e a partir dele. */
function shown(classes: string) {
  const tokens = classes.split(/\s+/)
  const mobile = tokens.includes('hidden') ? false : tokens.includes('flex')
  const desktop = tokens.includes('lg:flex') ? true : tokens.includes('lg:hidden') ? false : mobile
  return { mobile, desktop }
}

describe('inboxPanes', () => {
  it('no celular, sem conversa aberta, só a lista aparece', () => {
    const panes = inboxPanes(false)
    expect(shown(panes.list).mobile).toBe(true)
    expect(shown(panes.thread).mobile).toBe(false)
  })

  it('no celular, com conversa aberta, só a conversa aparece', () => {
    const panes = inboxPanes(true)
    expect(shown(panes.list).mobile).toBe(false)
    expect(shown(panes.thread).mobile).toBe(true)
  })

  it('no computador, as duas colunas aparecem sempre', () => {
    for (const hasConversation of [false, true]) {
      const panes = inboxPanes(hasConversation)
      expect(shown(panes.list).desktop).toBe(true)
      expect(shown(panes.thread).desktop).toBe(true)
    }
  })
})
