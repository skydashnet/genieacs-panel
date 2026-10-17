import { Fragment, type MouseEvent, type ReactNode } from 'react'
import type { Block, Inline } from '@/lib/markdown'

/**
 * Desenha a árvore de `lib/markdown.ts` com elementos React.
 *
 * Todo texto entra como filho de texto, que o React escapa: um `<script>`
 * escrito no Markdown aparece na tela como `<script>`, e nunca roda. Links só
 * existem com esquema seguro (o leitor já descartou os outros); os de fora
 * abrem em outra aba, e os `#âncora` rolam até o título sem mexer na rota.
 */

export function scrollToAnchor(id: string) {
  const alvo = typeof document === 'undefined' ? null : document.getElementById(id)
  alvo?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function irPara(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault()
  scrollToAnchor(href.slice(1))
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>
      case 'code':
        return <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{node.text}</code>
      case 'strong':
        return <strong key={index} className="font-semibold text-foreground">{renderInline(node.children)}</strong>
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>
      case 'link':
        return node.href.startsWith('#') ? (
          <a key={index} href={node.href} className="font-medium text-primary hover:underline" onClick={(e) => irPara(e, node.href)}>
            {renderInline(node.children)}
          </a>
        ) : (
          <a key={index} href={node.href} target="_blank" rel="noreferrer noopener" className="font-medium text-primary hover:underline">
            {renderInline(node.children)}
          </a>
        )
    }
  })
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'text-2xl font-bold tracking-tight text-foreground',
  2: 'mt-8 border-b border-border pb-2 text-xl font-semibold text-foreground',
  3: 'mt-6 text-base font-semibold text-foreground',
  4: 'mt-4 text-sm font-semibold text-foreground'
}

export function MarkdownBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-3 text-sm leading-6 text-foreground/90">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4'
            return (
              <Tag key={index} id={block.id} className={`scroll-mt-4 wrap-break-word ${HEADING_CLASS[block.level]}`}>
                {renderInline(block.children)}
              </Tag>
            )
          }
          case 'paragraph':
            return <p key={index} className="wrap-break-word">{renderInline(block.children)}</p>
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={index} className={`space-y-1 ps-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
                {block.items.map((item, i) => <li key={i} className="wrap-break-word">{renderInline(item)}</li>)}
              </Tag>
            )
          }
          case 'code':
            return (
              <pre key={index} className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-5">
                <code>{block.text}</code>
              </pre>
            )
          case 'quote':
            return (
              <blockquote key={index} className="rounded-md border-s-4 border-primary bg-[hsl(var(--surface-subtle))] px-4 py-3">
                {renderInline(block.children)}
              </blockquote>
            )
          case 'table':
            return (
              <div key={index} className="overflow-x-auto rounded-md border border-border">
                <table className="modern-table">
                  <thead>
                    <tr>{block.header.map((cell, i) => <th key={i}>{renderInline(cell)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>{row.map((cell, c) => <td key={c} className="text-sm">{renderInline(cell)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'rule':
            return <hr key={index} className="border-border" />
        }
      })}
    </div>
  )
}

export default MarkdownBlocks
