'use client'

import { useCallback, useEffect, useState } from 'react'
import { auditAPI, type AuditEntry } from '@/lib/api'
import { auditActionLabelKey } from '@/lib/audit-actions'
import { useTranslation } from '@/contexts/language-context'

const POR_PAGINA = 50

/** Quantos pares do detalhe cabem na célula antes de o resto ficar atrás do botão. */
const PARES_VISIVEIS = 3

/** O `detail` lido como pares, com o resto atrás de um botão — nunca como JSON despejado numa célula. */
function Detalhe({ detail }: { detail: Record<string, unknown> | null }) {
  const { t } = useTranslation()
  const [aberto, setAberto] = useState(false)

  if (!detail) return <span className="text-muted-foreground">—</span>
  const pares = Object.entries(detail)
  if (pares.length === 0) return <span className="text-muted-foreground">—</span>

  const visiveis = aberto ? pares : pares.slice(0, PARES_VISIVEIS)

  return (
    <div className="space-y-0.5">
      {visiveis.map(([chave, valor]) => (
        <div key={chave} className="wrap-break-word">
          <span className="text-muted-foreground">{chave}: </span>
          <span className="text-foreground wrap-anywhere">
            {valor === null || valor === undefined
              ? '—'
              : typeof valor === 'object'
                ? JSON.stringify(valor)
                : String(valor)}
          </span>
        </div>
      ))}
      {pares.length > PARES_VISIVEIS && (
        <button
          type="button"
          className="inline-flex min-h-10 items-center text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground md:min-h-0"
          onClick={() => setAberto((v) => !v)}
        >
          {aberto ? t('audit.showLess') : t('audit.showAll', { count: String(pares.length) })}
        </button>
      )}
    </div>
  )
}

function Acao({ action }: { action: string }) {
  const { t } = useTranslation()
  const chave = auditActionLabelKey(action)
  // Ação que este frontend não conhece — de um backend mais novo, ou de uma
  // linha antiga cuja ação saiu do enum. O código cru é pouco, e é mais do que
  // uma célula vazia.
  if (!chave) return <code className="text-xs">{action}</code>
  return (
    <>
      <span className="text-foreground">{t(chave)}</span>
      <span className="ms-1 hidden text-xs text-muted-foreground lg:inline">{action}</span>
    </>
  )
}

function Ator({ actor }: { actor: AuditEntry['actor'] }) {
  const { t } = useTranslation()
  return (
    <>
      <span>{actor.username || '—'}</span>
      {/* `operator` é o caso normal e não ganha etiqueta; os outros dois ganham
          porque são a informação: "a plataforma entrou no seu painel" é outra
          coisa de "seu administrador entrou". */}
      {actor.kind !== 'operator' && (
        <span className="modern-badge-warning ms-2 whitespace-nowrap text-[11px]">
          {actor.kind === 'platform' ? t('audit.actorKind.platform') : t('audit.actorKind.system')}
        </span>
      )}
    </>
  )
}

/**
 * A trilha deste provedor: o que aconteceu DENTRO do painel dele.
 *
 * Irmã da trilha da plataforma (`components/platform/platform-audit.tsx`) e com
 * público oposto, o que muda três coisas em relação àquela:
 *
 * 1. **A ação vira frase.** Lá o código cru serve, porque quem lê opera o SaaS.
 *    Aqui quem lê é o administrador do ISP, e `portal_password.revealed` numa
 *    tabela não é informação, é ruído.
 * 2. **O filtro é do servidor.** A rota aceita `?action=` com índice por trás;
 *    filtrar sobre o que já foi carregado diria "nada encontrado" para uma ação
 *    que existe três páginas adiante.
 * 3. **O detalhe é lido, não despejado.** `JSON.stringify` numa célula é o
 *    formato de quem desistiu de saber o que tem dentro.
 *
 * A paginação é por cursor (`before`) porque a tabela cresce pela frente, e o
 * fim se detecta por página incompleta: `nextBefore` só é nulo na página vazia,
 * apesar do que o comentário do controlador dizia até esta fatia.
 */
export default function AuditPage() {
  const { t, formatDateTime } = useTranslation()

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState('')

  const carregar = useCallback(async (before: number | null, action: string) => {
    setLoading(true)
    const res = await auditAPI.list({ action: action || null, limit: POR_PAGINA, before })
    if (res.success && res.data) {
      // `before` nulo é a primeira página — e é também o que a troca de filtro
      // manda, porque uma página 2 de outro filtro não existe.
      setEntries((atual) => (before === null ? res.data!.entries : [...atual, ...res.data!.entries]))
      setActions(res.data.actions)
      // Página incompleta quer dizer que acabou. `nextBefore` não serve para
      // isso: ele só é nulo quando a página veio vazia, e um botão que pede
      // sempre mais uma página vazia nunca some.
      setNextBefore(res.data.entries.length < POR_PAGINA ? null : res.data.nextBefore)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void carregar(null, filtro)
  }, [carregar, filtro])

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <h1 className="page-title">{t('audit.title')}</h1>
            <p className="page-description">{t('audit.subtitle')}</p>
          </div>
          <select
            className="modern-input shrink-0 sm:w-72"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            aria-label={t('audit.filter')}
          >
            <option value="">{t('audit.allActions')}</option>
            {actions.map((action) => {
              const chave = auditActionLabelKey(action)
              return <option key={action} value={action}>{chave ? t(chave) : action}</option>
            })}
          </select>
        </header>

        {error !== null && (
          <p className="mb-4 text-sm text-destructive">{error || t('audit.loadFailed')}</p>
        )}

        {loading && entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
        ) : (
          <div className="modern-card p-4 sm:p-5">
            <div className="hidden overflow-x-auto xl:block">
              <table className="w-full min-w-208 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pe-3 font-medium">{t('audit.column.when')}</th>
                    <th className="py-2 pe-3 font-medium">{t('audit.column.action')}</th>
                    <th className="py-2 pe-3 font-medium">{t('audit.column.actor')}</th>
                    <th className="py-2 pe-3 font-medium">{t('audit.column.subject')}</th>
                    <th className="py-2 pe-3 font-medium">{t('audit.column.detail')}</th>
                    <th className="py-2 font-medium">{t('audit.column.ip')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap py-2 pe-3 text-muted-foreground">
                        {formatDateTime(entry.at)}
                      </td>
                      <td className="min-w-32 py-2 pe-3 wrap-anywhere"><Acao action={entry.action} /></td>
                      {/* Largura mínima nas colunas de texto longo: com quebra em qualquer
                          letra, a tabela as espremia a um caractere por linha. */}
                      <td className="min-w-36 py-2 pe-3 wrap-anywhere"><Ator actor={entry.actor} /></td>
                      <td className="min-w-32 py-2 pe-3 text-xs text-muted-foreground wrap-anywhere">
                        {entry.subject.type
                          ? <>{entry.subject.type}{entry.subject.id ? ` #${entry.subject.id}` : ''}</>
                          : '—'}
                      </td>
                      <td className="min-w-56 py-2 pe-3 text-xs"><Detalhe detail={entry.detail} /></td>
                      <td className="min-w-28 max-w-40 py-2 text-xs text-muted-foreground wrap-anywhere">
                        {entry.ip || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Até o xl cada linha vira um bloco: seis colunas não cabem (nem no
                tablet, nem ao lado do menu), e rolar de lado esconderia
                justamente o detalhe. */}
            <ul className="divide-y divide-border xl:hidden">
              {entries.map((entry) => (
                <li key={entry.id} className="space-y-1.5 py-3 text-sm first:pt-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 font-medium wrap-anywhere"><Acao action={entry.action} /></span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
                  </div>
                  <div className="text-xs wrap-anywhere"><Ator actor={entry.actor} /></div>
                  {(entry.subject.type || entry.ip) && (
                    <p className="text-xs text-muted-foreground wrap-anywhere">
                      {entry.subject.type && <>{entry.subject.type}{entry.subject.id ? ` #${entry.subject.id}` : ''}</>}
                      {entry.subject.type && entry.ip ? ' · ' : ''}
                      {entry.ip}
                    </p>
                  )}
                  {entry.detail && Object.keys(entry.detail).length > 0 && (
                    <div className="rounded-md bg-muted/50 p-2 text-xs"><Detalhe detail={entry.detail} /></div>
                  )}
                </li>
              ))}
            </ul>

            {nextBefore !== null && (
              <div className="mt-4">
                <button
                  type="button" className="modern-button-secondary w-full sm:w-auto" disabled={loading}
                  onClick={() => void carregar(nextBefore, filtro)}
                >
                  {loading ? t('common.loading') : t('audit.loadMore')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
