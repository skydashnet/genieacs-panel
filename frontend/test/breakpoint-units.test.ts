import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Breakpoint arbitrário em px é proibido nas classes.
 *
 * O Tailwind 4 ordena as media queries por unidade, não pela ordem em que as
 * classes aparecem. Os breakpoints do tema são em rem; um `min-[1200px]:` sai
 * no CSS **antes** do `lg:` (64rem), e o `lg:` vence onde os dois valem. Foi
 * assim que, na migração, a grade do WhatsApp com o Módulo SGP aberto voltou a
 * ter duas colunas entre 1200 e 1279 px e jogou o painel numa segunda linha —
 * sem erro nenhum, só a tela torta em produção.
 *
 * Breakpoint novo vai no `@theme` de `globals.css` (como `--breakpoint-3xl`),
 * ou em rem: `min-[75rem]:`.
 */
const SRC = path.resolve(__dirname, '../src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : []
  })
}

describe('breakpoints arbitrários', () => {
  it('nenhuma classe usa min-[…px] ou max-[…px]', () => {
    const offenders = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\b(?:min|max)-\[\d+(?:\.\d+)?px\]:/g)]
        .map((match) => `${path.relative(SRC, file)}: ${match[0]}`)
    })
    expect(offenders).toEqual([])
  })
})

/**
 * Mesma família de defeito: duas classes que mexem na mesma propriedade, e a
 * ordem do CSS da v4 escolhe outra vencedora. O v3 tinha `break-words
 * [overflow-wrap:anywhere]` e a propriedade arbitrária saía por último; a
 * ferramenta de migração trocou por `wrap-break-word … wrap-anywhere`, e na v4
 * o `break-word` vence. Um código PIX sem espaço deixou de quebrar e alargou a
 * conversa do WhatsApp para além do cartão.
 */
describe('quebra de linha', () => {
  it('wrap-break-word e wrap-anywhere não aparecem na mesma classe', () => {
    const offenders = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/className=(?:"[^"]*"|\{`[^`]*`\})/g)]
        .filter((match) => /\bwrap-break-word\b/.test(match[0]) && /\bwrap-anywhere\b/.test(match[0]))
        .map((match) => `${path.relative(SRC, file)}: ${match[0]}`)
    })
    expect(offenders).toEqual([])
  })
})
