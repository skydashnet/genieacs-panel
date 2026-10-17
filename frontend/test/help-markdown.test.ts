import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MarkdownBlocks } from '@/components/markdown-view'
import { PLATFORM_BILLING_MANUAL, PROVIDER_BILLING_GUIDE } from '@/lib/help-docs'
import { buildToc, filterBlocks, isSafeHref, parseInline, parseMarkdown, slugify, type Block } from '@/lib/markdown'

const render = (source: string) => renderToStaticMarkup(createElement(MarkdownBlocks, { blocks: parseMarkdown(source) }))

describe('o leitor de Markdown', () => {
  it('lê títulos, parágrafos, listas, tabela, código e citação', () => {
    const blocks = parseMarkdown([
      '# Título',
      '',
      'Um parágrafo',
      'que continua.',
      '',
      '- um',
      '- dois',
      '',
      '1. primeiro',
      '2. segundo',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```',
      'cd backend',
      '```',
      '',
      '> **Atenção:** cuidado',
      '',
      '---'
    ].join('\n'))
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'table', 'code', 'quote', 'rule'])
    const para = blocks[1] as Extract<Block, { type: 'paragraph' }>
    expect(para.children).toEqual([{ type: 'text', text: 'Um parágrafo que continua.' }])
    expect((blocks[2] as Extract<Block, { type: 'list' }>).ordered).toBe(false)
    expect((blocks[3] as Extract<Block, { type: 'list' }>).ordered).toBe(true)
    expect((blocks[5] as Extract<Block, { type: 'code' }>).text).toBe('cd backend')
  })

  it('lê negrito, itálico, código e link em linha', () => {
    expect(parseInline('a **b** *c* `d` [e](https://x.y)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'c' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'd' },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://x.y', children: [{ type: 'text', text: 'e' }] }
    ])
  })

  it('não interpreta nada dentro de código', () => {
    expect(parseInline('`**x** [a](b)`')).toEqual([{ type: 'code', text: '**x** [a](b)' }])
  })

  it('deixa um sublinhado no meio da palavra em paz', () => {
    expect(parseInline('ASAAS_SANDBOX_API_KEY')).toEqual([{ type: 'text', text: 'ASAAS_SANDBOX_API_KEY' }])
  })
})

describe('o desenho escapa o HTML', () => {
  it('mostra uma tag escrita no Markdown como texto', () => {
    const html = render('Olá <script>alert(1)</script> e <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapa também dentro de títulos, tabelas e código', () => {
    const html = render(['## <b>x</b>', '', '| <i>a</i> |', '| --- |', '| <u>b</u> |', '', '```', '<div>', '```'].join('\n'))
    expect(html).not.toMatch(/<(b|i|u|div)>/)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('&lt;div&gt;')
  })

  it('não faz link de esquema perigoso', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,x')).toBe(false)
    expect(isSafeHref('https://asaas.com')).toBe(true)
    expect(isSafeHref('#secao')).toBe(true)
    const html = render('[clique](javascript:alert(1)) e [ok](https://asaas.com)')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('clique')
    expect(html).toContain('href="https://asaas.com"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('dá aos títulos o id que o sumário aponta', () => {
    expect(render('## Integrações → Asaas')).toContain('id="integracoes-asaas"')
  })
})

describe('o sumário', () => {
  it('lista os níveis 2 e 3, na ordem, com ids sem acento e únicos', () => {
    const toc = buildToc(parseMarkdown(['# Manual', '## Inadimplência', '### Ações em massa', '## Perguntas', '### Ações em massa', '#### fundo'].join('\n\n')))
    expect(toc).toEqual([
      { id: 'inadimplencia', level: 2, text: 'Inadimplência' },
      { id: 'acoes-em-massa', level: 3, text: 'Ações em massa' },
      { id: 'perguntas', level: 2, text: 'Perguntas' },
      { id: 'acoes-em-massa-2', level: 3, text: 'Ações em massa' }
    ])
  })

  it('nunca devolve id vazio', () => {
    expect(slugify('→ !!')).toBe('secao')
  })
})

describe('a busca', () => {
  const doc = parseMarkdown([
    '# Manual',
    'Introdução.',
    '## Cupons',
    'Códigos de desconto.',
    '## Assinaturas',
    'A lista.',
    '### Estornar',
    'Devolve o pagamento.',
    '### Isentar',
    'Sem fatura.'
  ].join('\n\n'))
  const titulos = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'heading' ? [b.text] : []))

  it('vazia mostra tudo', () => {
    expect(filterBlocks(doc, '   ')).toBe(doc)
  })

  it('ignora acento e caixa, e exige todas as palavras', () => {
    expect(titulos(filterBlocks(doc, 'CODIGOS'))).toEqual(['Cupons'])
    expect(titulos(filterBlocks(doc, 'códigos lista'))).toEqual([])
  })

  it('um nível 3 que casa leva o título do nível 2 dele', () => {
    expect(titulos(filterBlocks(doc, 'devolve'))).toEqual(['Assinaturas', 'Estornar'])
  })

  it('um nível 2 que casa leva os níveis 3 dele', () => {
    expect(titulos(filterBlocks(doc, 'lista'))).toEqual(['Assinaturas', 'Estornar', 'Isentar'])
  })

  it('não repete o título de cima quando dois níveis 3 casam', () => {
    expect(titulos(filterBlocks(doc, 'fatura pagamento'))).toEqual([])
    expect(titulos(filterBlocks(doc, 'o'))).toContain('Assinaturas')
    const ambos = filterBlocks(doc, 'e')
    expect(titulos(ambos).filter((t) => t === 'Assinaturas')).toHaveLength(1)
  })
})

describe('os manuais embutidos', () => {
  it('o manual da plataforma carrega e cobre as seções do plano', () => {
    expect(PLATFORM_BILLING_MANUAL.length).toBeGreaterThan(1000)
    const secoes = buildToc(parseMarkdown(PLATFORM_BILLING_MANUAL)).filter((e) => e.level === 2).map((e) => e.text)
    for (const nome of ['Integrações → Asaas', 'Planos', 'Cupons', 'Assinaturas', 'Inadimplência', 'Receita', 'Indicação', 'Retenção', 'Alertas', 'Teste no sandbox', 'Perguntas frequentes']) {
      expect(secoes, nome).toContain(nome)
    }
    expect(PLATFORM_BILLING_MANUAL).toContain('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED')
    expect(PLATFORM_BILLING_MANUAL).toContain('npm run e2e:asaas-sandbox')
  })

  it('o guia do provedor carrega', () => {
    const secoes = buildToc(parseMarkdown(PROVIDER_BILLING_GUIDE)).map((e) => e.text)
    expect(secoes).toContain('Pagar uma fatura')
    expect(secoes).toContain('Pausar ou cancelar')
  })

  it('nenhum dos dois leva HTML cru para a tela', () => {
    for (const source of [PLATFORM_BILLING_MANUAL, PROVIDER_BILLING_GUIDE]) {
      expect(render(source)).not.toMatch(/<(script|iframe|img|style)\b/i)
    }
  })
})
