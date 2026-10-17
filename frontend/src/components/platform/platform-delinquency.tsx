'use client'

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  platformAPI,
  type DelinquencyAction,
  type DelinquencyActionResult,
  type DelinquencyBucket,
  type DelinquencyRow,
  type DelinquencyStatusFilter,
  type DelinquencySummary
} from '@/lib/api'
import { statusBadgeClass, statusLabelKey } from '@/components/platform/tenant-plan'
import { CardBadge } from '@/components/card-badge'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { formatDay } from '@/lib/subscription-console'
import {
  ACTION_LABEL_KEYS,
  BUCKET_LABEL_KEYS,
  DELINQUENCY_BUCKETS,
  MAX_SELECTION,
  delinquencyCsv,
  newRequestId,
  parseBulkDays,
  pruneSelection,
  resultCodeKey,
  toggleAll,
  toggleSelection
} from '@/lib/delinquency'

/**
 * A aba Inadimplência do console: quem está devendo, quanto e desde quando —
 * e a mão para agir sobre muitos de uma vez (lembrete, suspensão, isenção,
 * prazo). Cada ação vale por provedor: o servidor responde o resultado de
 * cada um, e a tela mostra quem falhou e por quê.
 */
export function PlatformDelinquency() {
  const { t } = useTranslation()
  const toast = useToast()
  const [rows, setRows] = useState<DelinquencyRow[]>([])
  const [summary, setSummary] = useState<DelinquencySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bucket, setBucket] = useState<DelinquencyBucket | ''>('')
  const [status, setStatus] = useState<DelinquencyStatusFilter | ''>('')
  const [sort, setSort] = useState<'days' | 'amount'>('days')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [action, setAction] = useState<DelinquencyAction | null>(null)
  const [results, setResults] = useState<{ action: DelinquencyAction; items: DelinquencyActionResult[] } | null>(null)

  // A busca vai ao servidor, mas não a cada tecla.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.listDelinquency({ bucket, status, q: query, sort })
    if (res.success && res.data) {
      setRows(res.data.rows)
      setSummary(res.data.summary)
      setSelected((atual) => pruneSelection(atual, res.data?.rows ?? []))
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [bucket, status, query, sort])

  useEffect(() => {
    void load()
  }, [load])

  const visibleIds = useMemo(() => rows.map((row) => row.tenant.id), [rows])
  const todosMarcados = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
  const nomeDe = useMemo(() => new Map(rows.map((row) => [row.tenant.id, row.tenant.name])), [rows])

  const exportar = () => {
    const csv = delinquencyCsv(rows, [
      'id', t('platform.delinq.col.provider'), 'slug', t('platform.delinq.col.status'), 'currency',
      t('platform.delinq.col.amount'), t('platform.delinq.kind.renewal'), t('platform.delinq.kind.proration'),
      t('platform.delinq.kind.overage'), t('platform.delinq.col.since'), t('platform.delinq.col.days'),
      t('platform.delinq.col.bucket'), t('platform.delinq.col.lastReminder'), t('platform.delinq.col.autoSuspend'),
      t('platform.delinq.col.card')
    ])
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `inadimplencia-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const moedaTotal = summary?.totalsByCurrency[0]?.currency || 'BRL'
  const vazio = loading
    ? t('common.loading')
    : error !== null
      ? error || t('platform.delinq.loadFailed')
      : rows.length === 0
        ? (bucket || status || query ? t('platform.delinq.noMatch') : t('platform.delinq.empty'))
        : null

  return (
    <div className="space-y-6">
      <section aria-labelledby="delinq-summary-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="delinq-summary-title" className="section-heading">{t('platform.delinq.title')}</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary" disabled={rows.length === 0} onClick={exportar}>
              <Icon name="document" size={17} />
              {t('platform.delinq.exportCsv')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
              <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="modern-card col-span-2 p-3 sm:col-span-1">
            <p className="metric-label">{t('platform.delinq.totalOverdue')}</p>
            {(summary?.totalsByCurrency.length ?? 0) > 1 ? (
              <ul className="mt-1 font-mono text-sm font-semibold tabular-nums text-destructive">
                {summary?.totalsByCurrency.map((total) => (
                  <li key={total.currency}>{formatMoney(total.cents, total.currency)}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-destructive">
                {formatMoney(summary?.totalOverdueCents ?? 0, moedaTotal)}
              </p>
            )}
          </div>
          <div className="modern-card p-3">
            <p className="metric-label">{t('platform.delinq.count')}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">{summary?.count ?? 0}</p>
          </div>
          {DELINQUENCY_BUCKETS.map((faixa) => (
            <button
              key={faixa}
              type="button"
              aria-pressed={bucket === faixa}
              onClick={() => setBucket((atual) => (atual === faixa ? '' : faixa))}
              className={`modern-card p-3 text-start ${bucket === faixa ? 'ring-2 ring-primary' : ''}`}
            >
              <span className="metric-label block">{t(BUCKET_LABEL_KEYS[faixa])}</span>
              <span className="mt-1 block font-mono text-2xl font-semibold tabular-nums text-foreground">
                {summary?.byBucket[faixa] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="modern-card flex flex-wrap items-end gap-3 p-4" aria-label={t('platform.delinq.filters')}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="modern-input w-full sm:w-64"
          placeholder={t('platform.delinq.search')}
          aria-label={t('platform.delinq.search')}
        />
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t('platform.delinq.col.bucket')}</span>
          <select className="modern-input" value={bucket} onChange={(e) => setBucket(e.target.value as DelinquencyBucket | '')}>
            <option value="">{t('platform.delinq.allBuckets')}</option>
            {DELINQUENCY_BUCKETS.map((faixa) => (
              <option key={faixa} value={faixa}>{t(BUCKET_LABEL_KEYS[faixa])}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t('platform.delinq.col.status')}</span>
          <select className="modern-input" value={status} onChange={(e) => setStatus(e.target.value as DelinquencyStatusFilter | '')}>
            <option value="">{t('platform.delinq.status.all')}</option>
            <option value="past_due">{t('platform.delinq.status.pastDue')}</option>
            <option value="auto_suspended">{t('platform.delinq.status.autoSuspended')}</option>
            <option value="manual_suspended">{t('platform.delinq.status.manualSuspended')}</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t('platform.delinq.sort')}</span>
          <select className="modern-input" value={sort} onChange={(e) => setSort(e.target.value as 'days' | 'amount')}>
            <option value="days">{t('platform.delinq.sort.days')}</option>
            <option value="amount">{t('platform.delinq.sort.amount')}</option>
          </select>
        </label>
      </section>

      {selected.length > 0 && (
        <section
          className="modern-card sticky top-2 z-10 flex flex-wrap items-center gap-2 p-3"
          aria-label={t('platform.delinq.actions')}
        >
          <span className="text-sm font-medium text-foreground">
            {t('platform.delinq.selected', { count: selected.length, max: MAX_SELECTION })}
          </span>
          {(Object.keys(ACTION_LABEL_KEYS) as DelinquencyAction[]).map((acao) => (
            <button
              key={acao}
              type="button"
              className={acao === 'suspend' ? 'modern-button-danger' : 'modern-button-secondary'}
              onClick={() => setAction(acao)}
            >
              {t(ACTION_LABEL_KEYS[acao])}
            </button>
          ))}
          <button type="button" className="modern-button-secondary" onClick={() => setSelected([])}>
            {t('platform.delinq.clearSelection')}
          </button>
        </section>
      )}

      {results && (
        <ResultsPanel results={results} nomeDe={nomeDe} onClose={() => setResults(null)} />
      )}

      {/* No celular, cartões: com oito colunas o valor e o prazo ficavam fora da tela. */}
      <ul className="mobile-card-list modern-card divide-y divide-border" aria-label={t('platform.delinq.title')}>
        {rows.length > 0 && vazio === null && (
          <li className="flex items-center gap-2 p-3 text-sm">
            <input
              id="delinq-select-all-mobile"
              type="checkbox"
              checked={todosMarcados}
              onChange={() => setSelected((atual) => toggleAll(atual, visibleIds))}
            />
            <label htmlFor="delinq-select-all-mobile">{t('platform.delinq.selectAll')}</label>
          </li>
        )}
        {vazio !== null ? (
          <li className={`py-6 text-center text-sm ${error !== null && !loading ? 'text-destructive' : 'text-muted-foreground'}`}>{vazio}</li>
        ) : (
          rows.map((row) => (
            <DelinquencyCard
              key={row.tenant.id}
              row={row}
              checked={selected.includes(row.tenant.id)}
              onToggle={() => setSelected((atual) => toggleSelection(atual, row.tenant.id))}
            />
          ))
        )}
      </ul>
      <div className="desktop-table modern-card overflow-x-auto">
        <table className="modern-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={todosMarcados}
                  disabled={rows.length === 0}
                  onChange={() => setSelected((atual) => toggleAll(atual, visibleIds))}
                  aria-label={t('platform.delinq.selectAll')}
                />
              </th>
              <th>{t('platform.delinq.col.provider')}</th>
              <th>{t('platform.delinq.col.status')}</th>
              <th>{t('platform.delinq.col.amount')}</th>
              <th>{t('platform.delinq.col.since')}</th>
              <th>{t('platform.delinq.col.lastReminder')}</th>
              <th>{t('platform.delinq.col.autoSuspend')}</th>
              <th>{t('platform.delinq.col.card')}</th>
            </tr>
          </thead>
          <tbody>
            {vazio !== null ? (
              <tr>
                <td colSpan={8} className={`py-8 text-center ${error !== null && !loading ? 'text-destructive' : 'text-muted-foreground'}`}>{vazio}</td>
              </tr>
            ) : (
              rows.map((row) => (
                <DelinquencyTableRow
                  key={row.tenant.id}
                  row={row}
                  checked={selected.includes(row.tenant.id)}
                  onToggle={() => setSelected((atual) => toggleSelection(atual, row.tenant.id))}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {action && (
        <ActionDialog
          action={action}
          tenantIds={selected}
          onClose={() => setAction(null)}
          onDone={async (resposta) => {
            setAction(null)
            setResults({ action: resposta.action, items: resposta.results })
            if (resposta.failedCount === 0) {
              toast.success(t('platform.delinq.done', { ok: resposta.okCount, total: resposta.results.length }))
            } else {
              toast.error(t('platform.delinq.done', { ok: resposta.okCount, total: resposta.results.length }))
            }
            setSelected(resposta.results.filter((r) => !r.ok).map((r) => r.tenantId))
            await load()
          }}
        />
      )}
    </div>
  )
}

function DelinquencyTableRow({ row, checked, onToggle }: { row: DelinquencyRow; checked: boolean; onToggle: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const partes = (['renewal', 'proration', 'overage'] as const).filter((kind) => row.amountByKind[kind] > 0)
  return (
    <tr>
      <td>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={t('platform.delinq.selectRow', { name: row.tenant.name })} />
      </td>
      <td>
        <span className="font-medium">{row.tenant.name}</span>
        <span className="block font-mono text-xs text-muted-foreground">{row.tenant.slug}</span>
      </td>
      <td>
        <span className={statusBadgeClass(row.status)}>
          {t(statusLabelKey({ status: row.status, suspendedReason: row.suspendedReason }))}
        </span>
      </td>
      <td className="text-sm">
        <span className="font-mono font-semibold tabular-nums">{formatMoney(row.amountCents, row.currency)}</span>
        {partes.length > 1 && (
          <span className="block text-xs text-muted-foreground">
            {partes.map((kind) => `${t(`platform.delinq.kind.${kind}`)} ${formatMoney(row.amountByKind[kind], row.currency)}`).join(' · ')}
          </span>
        )}
        {partes.length === 1 && partes[0] !== 'renewal' && (
          <span className="block text-xs text-muted-foreground">{t(`platform.delinq.kind.${partes[0]}`)}</span>
        )}
      </td>
      <td className="text-sm">
        {formatDay(row.overdueSince)}
        <span className="block text-xs text-muted-foreground">{t('platform.delinq.days', { days: row.daysOverdue })}</span>
      </td>
      <td className="text-sm">
        {row.lastReminder?.sentAt ? formatDateTime(row.lastReminder.sentAt) : <span className="text-muted-foreground">{t('platform.delinq.noReminder')}</span>}
      </td>
      <td className="text-sm">
        {row.autoSuspendAt ? (
          <>
            {formatDay(row.autoSuspendAt)}
            {row.autoSuspendWarned && <span className="block text-xs text-muted-foreground">{t('platform.delinq.warned')}</span>}
          </>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td>
        {row.card.saved ? <CardBadge card={row.card} /> : <span className="text-sm text-muted-foreground">—</span>}
      </td>
    </tr>
  )
}

function DelinquencyCard({ row, checked, onToggle }: { row: DelinquencyRow; checked: boolean; onToggle: () => void }) {
  const { t, formatDateTime } = useTranslation()
  return (
    <li className="flex gap-3 p-4 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={onToggle}
        aria-label={t('platform.delinq.selectRow', { name: row.tenant.name })}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 wrap-break-word font-semibold text-foreground">{row.tenant.name}</span>
          <span className="font-mono font-semibold tabular-nums">{formatMoney(row.amountCents, row.currency)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={statusBadgeClass(row.status)}>
            {t(statusLabelKey({ status: row.status, suspendedReason: row.suspendedReason }))}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatDay(row.overdueSince)} · {t('platform.delinq.days', { days: row.daysOverdue })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('platform.delinq.col.lastReminder')}: {row.lastReminder?.sentAt ? formatDateTime(row.lastReminder.sentAt) : t('platform.delinq.noReminder')}
        </p>
        {row.autoSuspendAt && (
          <p className="text-xs text-muted-foreground">
            {t('platform.delinq.col.autoSuspend')}: {formatDay(row.autoSuspendAt)}
            {row.autoSuspendWarned && ` · ${t('platform.delinq.warned')}`}
          </p>
        )}
        {row.card.saved && <CardBadge card={row.card} />}
      </div>
    </li>
  )
}

function ResultsPanel({
  results,
  nomeDe,
  onClose
}: {
  results: { action: DelinquencyAction; items: DelinquencyActionResult[] }
  nomeDe: Map<number, string>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ok = results.items.filter((item) => item.ok).length
  const falhas = results.items.filter((item) => !item.ok)
  return (
    <section className="modern-card p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">
          {t(ACTION_LABEL_KEYS[results.action])}: {t('platform.delinq.done', { ok, total: results.items.length })}
        </h3>
        <button type="button" className="modern-button-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
      {falhas.length > 0 && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">{t('platform.delinq.failures')}</p>
          <ul className="mt-1 space-y-1 text-sm">
            {falhas.map((item) => (
              <li key={item.tenantId}>
                <span className="font-medium">{nomeDe.get(item.tenantId) ?? `#${item.tenantId}`}</span>
                {' — '}
                <span className="text-destructive">{t(resultCodeKey(item.code))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function ActionDialog({
  action,
  tenantIds,
  onClose,
  onDone
}: {
  action: DelinquencyAction
  tenantIds: number[]
  onClose: () => void
  onDone: (resposta: { action: DelinquencyAction; results: DelinquencyActionResult[]; okCount: number; failedCount: number }) => Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [days, setDays] = useState('7')
  const [invalido, setInvalido] = useState<string | null>(null)
  // Uma chave por diálogo: o mesmo pedido mandado de novo (a resposta que
  // demorou e o clique repetido) não dá a cortesia duas vezes.
  const [requestId] = useState(newRequestId)

  const enviar = async () => {
    const params: { reason?: string; until?: string; days?: number; requestId?: string } = { requestId }
    if (reason.trim()) params.reason = reason.trim()
    if (action === 'extend') {
      const dias = parseBulkDays(days)
      if (dias === null) {
        setInvalido(t('platform.delinq.invalidDays'))
        return
      }
      params.days = dias
    }
    if (action === 'exempt' && until) {
      // O fim do dia escolhido, no fuso de quem escolhe.
      const fim = new Date(`${until}T23:59:59`)
      if (Number.isNaN(fim.getTime()) || fim.getTime() <= Date.now()) {
        setInvalido(t('platform.delinq.invalidUntil'))
        return
      }
      params.until = fim.toISOString()
    }
    setInvalido(null)
    setBusy(true)
    try {
      const res = await platformAPI.runDelinquencyAction({ tenantIds, action, params })
      if (res.success && res.data) {
        await onDone(res.data)
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t(ACTION_LABEL_KEYS[action])}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button
            type="button"
            className={action === 'suspend' ? 'modern-button-danger' : 'modern-button'}
            onClick={() => void enviar()}
            disabled={busy}
          >
            {busy ? t('common.saving') : t('common.confirm')}
          </button>
        </>
      )}
    >
      <p className="text-foreground">{t(`platform.delinq.confirm.${action}`, { count: tenantIds.length })}</p>
      {action === 'exempt' && (
        <Field label={t('platform.delinq.exemptUntil')} hint={t('platform.delinq.exemptUntilHint')}>
          {(id) => <input id={id} type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="modern-input w-full" />}
        </Field>
      )}
      {action === 'extend' && (
        <Field label={t('platform.delinq.extendDays')}>
          {(id) => (
            <input id={id} type="number" min={1} max={60} step={1} value={days} onChange={(e) => setDays(e.target.value)} className="modern-input w-full" />
          )}
        </Field>
      )}
      {action !== 'remind' && (
        <Field label={t('platform.delinq.reason')}>
          {(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className="modern-input w-full" maxLength={255} />}
        </Field>
      )}
      {invalido && <p className="text-sm text-destructive" role="alert">{invalido}</p>}
    </Dialog>
  )
}

function Dialog({
  title,
  onClose,
  children,
  footer,
  busy
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  busy?: boolean
}) {
  const titleId = useId()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-panel modern-card flex max-w-lg flex-col">
        <div className="border-b border-border p-5">
          <h3 id={titleId} className="text-lg font-semibold text-foreground">{title}</h3>
        </div>
        <div className="space-y-3 p-5 text-sm">{children}</div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border p-5">{footer}</div>
      </div>
    </div>
  )
}

function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      {children(id)}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}
