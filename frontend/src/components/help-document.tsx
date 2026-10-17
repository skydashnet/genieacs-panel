import { useMemo, useState } from 'react'
import { MarkdownBlocks, scrollToAnchor } from '@/components/markdown-view'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { HELP_CONTENT_LOCALE } from '@/lib/help-docs'
import { buildToc, filterBlocks, parseMarkdown } from '@/lib/markdown'

/**
 * Um manual embutido: a busca, o sumário e o texto.
 *
 * `page` põe o sumário numa coluna ao lado (a aba Ajuda do console); `modal`
 * o põe em cima, recolhível, porque a janela do "Como funciona" é estreita.
 * O sumário some durante a busca: o que se mostra ali é só o que casou, e um
 * sumário apontando para títulos escondidos levaria a lugar nenhum.
 */
export function HelpDocument({ source, layout = 'page' }: { source: string; layout?: 'page' | 'modal' }) {
  const { t, locale } = useTranslation()
  const [busca, setBusca] = useState('')
  const blocks = useMemo(() => parseMarkdown(source), [source])
  const toc = useMemo(() => buildToc(blocks), [blocks])
  const visiveis = useMemo(() => filterBlocks(blocks, busca), [blocks, busca])
  const buscando = busca.trim() !== ''

  const sumario = !buscando && toc.length > 0 && (
    <nav aria-label={t('help.toc')}>
      <p className="metric-label mb-2">{t('help.toc')}</p>
      <ul className="space-y-1 text-sm">
        {toc.map((entry) => (
          <li key={entry.id} className={entry.level === 3 ? 'ps-3' : ''}>
            <a
              href={`#${entry.id}`}
              onClick={(event) => {
                event.preventDefault()
                scrollToAnchor(entry.id)
              }}
              className={`block rounded px-2 py-1 hover:bg-muted hover:text-foreground ${entry.level === 2 ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )

  const campoBusca = (
    <div className="relative">
      <Icon name="search" size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={busca}
        onChange={(event) => setBusca(event.target.value)}
        placeholder={t('help.searchPlaceholder')}
        aria-label={t('help.searchPlaceholder')}
        className="modern-input w-full ps-9"
      />
    </div>
  )

  const texto = (
    <div className="min-w-0">
      {locale !== HELP_CONTENT_LOCALE && (
        <p className="mb-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-3 py-2 text-xs text-muted-foreground" lang={locale}>
          {t('help.portugueseOnly')}
        </p>
      )}
      {visiveis.length > 0 ? (
        <div lang={HELP_CONTENT_LOCALE}>
          <MarkdownBlocks blocks={visiveis} />
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('help.noResults', { query: busca.trim() })}</p>
      )}
    </div>
  )

  if (layout === 'modal') {
    return (
      <div className="space-y-4">
        {campoBusca}
        {sumario && (
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold">{t('help.toc')}</summary>
            <div className="mt-2">{sumario}</div>
          </details>
        )}
        {texto}
      </div>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        {campoBusca}
        {sumario}
      </aside>
      <article className="modern-card min-w-0 p-5 sm:p-6">{texto}</article>
    </div>
  )
}

export default HelpDocument
