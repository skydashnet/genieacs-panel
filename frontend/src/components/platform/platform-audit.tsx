'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type PlatformAuditEntry } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { displayDateTime } from '@/lib/date-format'

const POR_PAGINA = 50

function quando(valor: string | null) {
  if (!valor) return '—'
  return displayDateTime(valor) ?? '—'
}

/**
 * A trilha do plano de controle: o que NÓS fizemos com um provedor.
 *
 * Separada do `audit_log` de cada provedor de propósito, e a diferença é de
 * quem é a pergunta. O ISP pergunta "quem mexeu no meu painel" e lê a trilha
 * dele; esta responde "o que a plataforma fez com quem", e é a que sobrevive à
 * exclusão de um provedor — a tabela guarda o nome e o slug na própria linha,
 * sem chave estrangeira, justamente para que a linha que registra a exclusão
 * não seja apagada junto com o que ela registra.
 *
 * Paginada por `before` e não por número de página: a tabela cresce pela
 * frente, e um deslocamento calculado pula ou repete linhas quando algo é
 * escrito entre um pedido e o outro.
 *
 * O filtro por ação é do lado do cliente, e isso é uma escolha com prazo de
 * validade: enquanto a trilha couber em algumas páginas, filtrar aqui evita
 * uma rodada ao servidor a cada clique. No dia em que ela não couber, o filtro
 * tem que descer para a query — e este comentário é o aviso de que ele não
 * desceu ainda.
 */
export function PlatformAudit() {
  const { t } = useTranslation()

  const [entries, setEntries] = useState<PlatformAuditEntry[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState('')

  const carregar = useCallback(async (before: number | null) => {
    setLoading(true)
    const res = await platformAPI.listAudit({ limit: POR_PAGINA, before })
    if (res.success && res.data) {
      // `before` nulo é a primeira página; as outras acumulam.
      setEntries((atual) => (before === null ? res.data!.entries : [...atual, ...res.data!.entries]))
      setActions(res.data.actions)
      // Menos linhas que o pedido quer dizer que acabou: sem isso o botão de
      // "carregar mais" ficaria para sempre, pedindo uma página vazia.
      setNextBefore(res.data.entries.length < POR_PAGINA ? null : res.data.nextBefore)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void carregar(null)
  }, [carregar])

  const visiveis = filtro ? entries.filter((e) => e.action === filtro) : entries

  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-foreground">{t('platform.audit.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('platform.audit.description')}</p>
        </div>
        <select
          className="modern-input shrink-0 sm:w-64"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          aria-label={t('platform.audit.filter')}
        >
          <option value="">{t('platform.audit.allActions')}</option>
          {actions.map((action) => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>
      </div>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive">{error || t('platform.audit.loadFailed')}</p>
      )}

      {loading && entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : visiveis.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('platform.audit.empty')}</p>
      ) : (
        <>
        <ul className="mobile-card-list mt-4 divide-y divide-border border-t border-border">
          {visiveis.map((entry) => (
            <li key={entry.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <code className="break-all text-xs font-semibold">{entry.action}</code>
                <span className="text-xs text-muted-foreground">{quando(entry.at)}</span>
              </div>
              <p className="mt-1 wrap-break-word">
                {entry.actor.username || '—'}
                {' · '}
                {entry.tenant.name || entry.tenant.slug || '—'}
                {entry.tenant.slug && entry.tenant.name && (
                  <span className="ms-1 text-xs text-muted-foreground">({entry.tenant.slug})</span>
                )}
              </p>
              {entry.detail && (
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{JSON.stringify(entry.detail)}</p>
              )}
            </li>
          ))}
        </ul>
        <div className="desktop-table mt-4 overflow-x-auto">
          <table className="w-full min-w-176 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pe-3 font-medium">{t('platform.audit.when')}</th>
                <th className="py-2 pe-3 font-medium">{t('platform.audit.action')}</th>
                <th className="py-2 pe-3 font-medium">{t('platform.audit.actor')}</th>
                <th className="py-2 pe-3 font-medium">{t('platform.audit.provider')}</th>
                <th className="py-2 font-medium">{t('platform.audit.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((entry) => (
                <tr key={entry.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap py-2 pe-3 text-muted-foreground">{quando(entry.at)}</td>
                  <td className="py-2 pe-3"><code className="text-xs">{entry.action}</code></td>
                  <td className="py-2 pe-3">{entry.actor.username || '—'}</td>
                  <td className="py-2 pe-3">
                    {entry.tenant.name || entry.tenant.slug || '—'}
                    {entry.tenant.slug && entry.tenant.name && (
                      <span className="ms-1 text-xs text-muted-foreground">({entry.tenant.slug})</span>
                    )}
                  </td>
                  <td className="py-2 text-xs break-all text-muted-foreground">
                    {entry.detail ? JSON.stringify(entry.detail) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {nextBefore !== null && (
        <div className="mt-4">
          <button
            type="button" className="modern-button-secondary" disabled={loading}
            onClick={() => void carregar(nextBefore)}
          >
            {loading ? t('common.loading') : t('platform.audit.loadMore')}
          </button>
        </div>
      )}
    </section>
  )
}

export default PlatformAudit
