'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppDunningSend, type WhatsAppDunningStats } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { errorText } from './dunning-rule-panel'
import { ContactLink } from './contact-link'
import { missingText } from './wa-variables'
import { sheetCsv } from './dunning-export'

/**
 * What the automatic cadence did, and what it was worth.
 *
 * Every decision is here, including the ones that did NOT send — "skipped:
 * asked not to be contacted" is as much an answer to "why didn't Maria get a
 * reminder?" as a sent message is to "did she?".
 */

const PAGE = 50
const EXPORT_PAGE = 200
const EXPORT_MAX = 5000
const PERIODS = [7, 30, 90] as const

/** The reason a row was skipped, as `wa_dunning_sends.reason` stores it. */
const REASON_LABELS: Record<string, TranslationKey> = {
  no_phone: 'whatsapp.dunning.skip.noPhone',
  opt_out: 'whatsapp.dunning.skip.optOut',
  template_incomplete: 'whatsapp.dunning.skip.templateIncomplete',
  max_reached: 'whatsapp.dunning.skip.maxReached',
  paid: 'whatsapp.dunning.skip.paid',
  paused: 'whatsapp.dunning.skip.paused'
}

const DELIVERY_LABELS: Record<string, TranslationKey> = {
  queued: 'whatsapp.delivery.queued',
  sending: 'whatsapp.delivery.sending',
  sent: 'whatsapp.delivery.sent',
  delivered: 'whatsapp.delivery.delivered',
  read: 'whatsapp.delivery.read',
  failed: 'whatsapp.delivery.failed'
}

export function DunningHistoryPanel() {
  const { t, formatDate, formatDateTime, intlLocale } = useTranslation()
  const toast = useToast()

  const [days, setDays] = useState<number>(30)
  const [stats, setStats] = useState<WhatsAppDunningStats | null>(null)
  const [items, setItems] = useState<WhatsAppDunningSend[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [contract, setContract] = useState('')
  const [status, setStatus] = useState('')

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true)
    try {
      const res = await whatsappAPI.listDunningSends({ contract: contract.trim(), status, limit: PAGE, offset })
      if (!alive.current) return
      if (res.success && res.data) {
        const page = res.data
        setItems((current) => (offset === 0 ? page.items : [...current, ...page.items]))
        setHasMore(page.hasMore)
      } else {
        toast.error(errorText(res, t, 'whatsapp.dunning.loadFailed'))
      }
    } finally {
      if (alive.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, status])

  useEffect(() => { void loadPage(0) }, [loadPage])

  useEffect(() => {
    void whatsappAPI.getDunningStats(days).then((res) => {
      if (alive.current && res.success && res.data) setStats(res.data)
    })
  }, [days])

  const money = (amount: number | null | undefined) => (amount === null || amount === undefined
    ? '—'
    : amount.toLocaleString(intlLocale, { style: 'currency', currency: 'BRL' }))

  const stepLabel = (row: { kind?: string; stepOffset: number }) => {
    if (row.kind === 'thanks') return t('whatsapp.dunning.kindThanks')
    if (row.stepOffset < 0) return t('whatsapp.dunning.stepBefore', { count: Math.abs(row.stepOffset) })
    if (row.stepOffset === 0) return t('whatsapp.dunning.stepDue')
    return t('whatsapp.dunning.stepAfter', { count: row.stepOffset })
  }

  const result = (row: WhatsAppDunningSend) => {
    if (row.status === 'skipped') {
      const key = row.reason ? REASON_LABELS[row.reason] : undefined
      const text = missingText(t, row.missing) ?? (key ? t(key) : (row.reason || t('whatsapp.dunning.statusSkipped')))
      return <span className="modern-badge-warning">{text}</span>
    }
    if (row.status === 'canceled') {
      return <span className="modern-badge-info">{t('whatsapp.dunning.statusCanceled')}</span>
    }
    const delivery = row.deliveryStatus ? DELIVERY_LABELS[row.deliveryStatus] : undefined
    return (
      <span className={row.deliveryStatus === 'failed' ? 'modern-badge-error' : 'modern-badge-success'}>
        {delivery ? t(delivery) : t('whatsapp.dunning.statusQueued')}
      </span>
    )
  }

  const [exporting, setExporting] = useState(false)

  const resultText = (row: WhatsAppDunningSend) => {
    if (row.status === 'skipped') {
      const key = row.reason ? REASON_LABELS[row.reason] : undefined
      return missingText(t, row.missing) ?? (key ? t(key) : (row.reason || t('whatsapp.dunning.statusSkipped')))
    }
    if (row.status === 'canceled') return t('whatsapp.dunning.statusCanceled')
    const delivery = row.deliveryStatus ? DELIVERY_LABELS[row.deliveryStatus] : undefined
    return delivery ? t(delivery) : t('whatsapp.dunning.statusQueued')
  }

  /** Todas as linhas do filtro atual — não só as páginas já carregadas. */
  const exportSheet = async () => {
    setExporting(true)
    try {
      const all: WhatsAppDunningSend[] = []
      for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
        const res = await whatsappAPI.listDunningSends({ contract: contract.trim(), status, limit: EXPORT_PAGE, offset })
        if (!res.success || !res.data) {
          toast.error(errorText(res, t, 'whatsapp.dunning.exportFailed'))
          return
        }
        all.push(...res.data.items)
        if (!res.data.hasMore) break
      }
      const csv = sheetCsv(
        [
          t('whatsapp.dunning.when'), t('whatsapp.inbox.contract'), t('whatsapp.inbox.subscriber'),
          t('whatsapp.dunning.step'), t('whatsapp.billing.amount'), t('whatsapp.billing.dueDate'),
          t('whatsapp.dunning.result')
        ],
        all.map((row) => [
          row.createdAt ? formatDateTime(row.createdAt) : '',
          row.contract,
          row.clientName,
          stepLabel(row),
          row.amount === null || row.amount === undefined ? '' : row.amount.toFixed(2).replace('.', ','),
          row.dueDate ? formatDate(`${row.dueDate}T12:00:00`) : '',
          resultText(row)
        ])
      )
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `historico-regua-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } finally {
      if (alive.current) setExporting(false)
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="section-heading">{t('whatsapp.dunning.historyTitle')}</h2>
          <p className="section-description">{t('whatsapp.dunning.historyDescription')}</p>
        </div>
        <div className="tab-rail" role="tablist" aria-label={t('whatsapp.dunning.period')}>
          {PERIODS.map((period) => (
            <button
              key={period}
              type="button"
              className="tab-button"
              role="tab"
              data-active={days === period}
              aria-selected={days === period}
              onClick={() => setDays(period)}
            >
              {t('whatsapp.dunning.lastDays', { count: period })}
            </button>
          ))}
        </div>
      </header>

      {/* ── What it was worth ──────────────────────────────────────────── */}
      {stats && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label={t('whatsapp.dunning.statsMessages')} value={String(stats.messages)}
              hint={stats.failed > 0 ? t('whatsapp.dunning.statsFailed', { count: stats.failed }) : undefined} />
            <Tile label={t('whatsapp.dunning.statsInvoices')} value={`${stats.invoicesPaid} / ${stats.invoices}`}
              hint={t('whatsapp.dunning.statsRate', { rate: stats.recoveryRate.toLocaleString(intlLocale) })} />
            <Tile label={t('whatsapp.dunning.statsRecovered')} value={money(stats.amountRecovered)}
              hint={t('whatsapp.dunning.statsCharged', { amount: money(stats.amountCharged) })} />
            <Tile label={t('whatsapp.dunning.statsThanks')} value={String(stats.thanks)} />
          </div>
          <p className="field-hint flex gap-2">
            <Icon name="info" size={16} className="mt-0.5 shrink-0" />
            <span>{t('whatsapp.dunning.statsNote')}</span>
          </p>
          {stats.byStep.length > 0 && (
            <div className="modern-card overflow-x-auto p-2">
              <table className="modern-table">
                <thead>
                  <tr>
                    <th scope="col">{t('whatsapp.dunning.step')}</th>
                    <th scope="col">{t('whatsapp.dunning.statsSent')}</th>
                    <th scope="col">{t('whatsapp.dunning.statsPaidAfter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byStep.map((step) => (
                    <tr key={step.offsetDays}>
                      <td>{stepLabel({ stepOffset: step.offsetDays })}</td>
                      <td>{step.sent}</td>
                      <td>{step.paidAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Every decision ─────────────────────────────────────────────── */}
      <div className="modern-card overflow-hidden">
        <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
          <input
            type="search"
            className="modern-input"
            aria-label={t('whatsapp.dunning.filterContract')}
            placeholder={t('whatsapp.dunning.filterContract')}
            value={contract}
            onChange={(event) => setContract(event.target.value)}
          />
          <select
            className="modern-input"
            aria-label={t('whatsapp.dunning.filterStatus')}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">{t('whatsapp.dunning.filterAll')}</option>
            <option value="queued">{t('whatsapp.dunning.statusQueued')}</option>
            <option value="failed">{t('whatsapp.delivery.failed')}</option>
            <option value="skipped">{t('whatsapp.dunning.statusSkipped')}</option>
            <option value="canceled">{t('whatsapp.dunning.statusCanceled')}</option>
          </select>
          <button type="button" className="modern-button-secondary" disabled={exporting} onClick={() => void exportSheet()}>
            <Icon name="external" size={16} />
            {t('whatsapp.dunning.export')}
          </button>
        </div>

        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="trail" size={22} /></div>
            <p className="empty-state-title">{loading ? t('common.loading') : t('whatsapp.dunning.historyEmpty')}</p>
          </div>
        ) : (
          <>
            <div className="desktop-table overflow-x-auto">
              <table className="modern-table">
                <thead>
                  <tr>
                    <th scope="col">{t('whatsapp.dunning.when')}</th>
                    <th scope="col">{t('whatsapp.inbox.contract')}</th>
                    <th scope="col">{t('whatsapp.inbox.subscriber')}</th>
                    <th scope="col">{t('whatsapp.dunning.step')}</th>
                    <th scope="col">{t('whatsapp.billing.amount')}</th>
                    <th scope="col">{t('whatsapp.billing.dueDate')}</th>
                    <th scope="col">{t('whatsapp.dunning.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap">{row.createdAt ? formatDateTime(row.createdAt) : '—'}</td>
                      <td className="font-mono text-xs">{row.contract}</td>
                      <td><ContactLink contract={row.contract} name={row.clientName} /></td>
                      <td className="whitespace-nowrap">{stepLabel(row)}</td>
                      <td>{money(row.amount)}</td>
                      <td className="whitespace-nowrap">
                        {row.dueDate ? formatDate(`${row.dueDate}T12:00:00`) : '—'}
                        {row.paidAt && row.kind === 'step' && (
                          <span className="modern-badge-success ml-2">{t('whatsapp.dunning.paid')}</span>
                        )}
                      </td>
                      <td>{result(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* No celular, um cartão por envio: a tabela de sete colunas rolava
                de lado e o nome do assinante virava uma coluna de seis linhas. */}
            <ul className="mobile-card-list divide-y divide-border" role="list">
              {items.map((row) => (
                <li key={row.id} className="space-y-1.5 p-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 wrap-break-word font-medium">
                      <ContactLink contract={row.contract} name={row.clientName} />
                    </div>
                    <span className="shrink-0 font-mono text-xs">{row.contract}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.createdAt ? formatDateTime(row.createdAt) : '—'} · {stepLabel(row)}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{money(row.amount)}</span>
                    <span className="text-muted-foreground">
                      {t('whatsapp.billing.dueDate')}: {row.dueDate ? formatDate(`${row.dueDate}T12:00:00`) : '—'}
                    </span>
                    {row.paidAt && row.kind === 'step' && (
                      <span className="modern-badge-success">{t('whatsapp.dunning.paid')}</span>
                    )}
                  </p>
                  <div>{result(row)}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        {hasMore && (
          <div className="border-t border-border p-4">
            <button
              type="button"
              className="modern-button-secondary"
              disabled={loading}
              onClick={() => void loadPage(items.length)}
            >
              {loading ? t('common.loading') : t('whatsapp.dunning.loadMore')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="modern-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
