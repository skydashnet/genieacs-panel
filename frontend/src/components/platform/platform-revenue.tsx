'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { platformReportsAPI, type RevenueMonth, type RevenueReport } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { PlatformCancellations } from '@/components/platform/platform-cancellations'
import {
  lastTwelveMonths,
  monthLabel,
  netCents,
  niceCeiling,
  validateRange,
  yearToDate,
  type RevenueRange
} from '@/lib/revenue-report'

/**
 * A aba Receita do console: quanto a plataforma fatura por mês (MRR), quanto
 * entrou e voltou no período, quanto está para receber, e de que plano vem.
 *
 * O gráfico é SVG à mão, sem biblioteca: são barras de um mês ao lado do
 * outro, e uma dependência nova para isso pesaria mais que a tela. As cores
 * são os tokens do tema (`--primary`, `--status-danger`), então o modo escuro
 * vem de graça; e os números do gráfico também estão numa tabela só para
 * leitor de tela, porque barra não se lê em voz alta.
 */

const MOEDA = 'BRL'

export function PlatformRevenue() {
  const { t } = useTranslation()
  const toast = useToast()
  const [range, setRange] = useState<RevenueRange>(() => lastTwelveMonths())
  const [draft, setDraft] = useState<RevenueRange>(range)
  const [report, setReport] = useState<RevenueReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const fromId = useId()
  const toId = useId()

  const load = useCallback(async (periodo: RevenueRange) => {
    setLoading(true)
    setError(null)
    const res = await platformReportsAPI.revenue(periodo)
    if (res.success && res.data) {
      setReport(res.data)
    } else {
      setReport(null)
      setError(res.code && ['invalid_date', 'invalid_range', 'range_too_long'].includes(res.code)
        ? t('platform.revenue.invalidRange')
        : res.message || t('platform.revenue.loadFailed'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load(range)
  }, [load, range])

  const recusa = validateRange(draft)

  const aplicar = (periodo: RevenueRange) => {
    setDraft(periodo)
    if (validateRange(periodo) === null) setRange({ ...periodo })
  }

  const exportar = async () => {
    setExporting(true)
    try {
      const res = await platformReportsAPI.revenueCsv(range)
      if (!res.success || !res.blob) {
        toast.error(res.message || t('platform.revenue.exportFailed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || `receita-${range.from}-a-${range.to}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="modern-card p-4" aria-labelledby="revenue-period-title">
        <h2 id="revenue-period-title" className="section-heading mb-3">{t('platform.revenue.period')}</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            aplicar(draft)
          }}
        >
          <div>
            <label htmlFor={fromId} className="mb-1 block text-sm font-medium">{t('platform.revenue.from')}</label>
            <input
              id={fromId}
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => setDraft((atual) => ({ ...atual, from: e.target.value }))}
              className="modern-input"
              aria-invalid={recusa !== null}
            />
          </div>
          <div>
            <label htmlFor={toId} className="mb-1 block text-sm font-medium">{t('platform.revenue.to')}</label>
            <input
              id={toId}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => setDraft((atual) => ({ ...atual, to: e.target.value }))}
              className="modern-input"
              aria-invalid={recusa !== null}
            />
          </div>
          <button type="submit" className="modern-button" disabled={recusa !== null || loading}>
            {t('platform.revenue.apply')}
          </button>
          <button type="button" className="modern-button-secondary" onClick={() => aplicar(lastTwelveMonths())}>
            {t('platform.revenue.presetLast12')}
          </button>
          <button type="button" className="modern-button-secondary" onClick={() => aplicar(yearToDate())}>
            {t('platform.revenue.presetYear')}
          </button>
          <div className="ms-auto flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load(range)}>
              <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={exporting} onClick={() => void exportar()}>
              <Icon name="document" size={17} />
              {t('platform.revenue.export')}
            </button>
          </div>
        </form>
        {recusa !== null && <p className="mt-2 text-sm text-destructive" role="alert">{t('platform.revenue.invalidRange')}</p>}
        <p className="field-hint mt-2">{t('platform.revenue.note')}</p>
      </section>

      {error !== null && !loading && (
        <p className="modern-card py-8 text-center text-sm text-destructive" role="alert">{error}</p>
      )}

      {report && (
        <>
          <section aria-labelledby="revenue-kpi-title">
            <h2 id="revenue-kpi-title" className="section-heading mb-3">{t('platform.revenue.summaryTitle')}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6" aria-busy={loading}>
              <Kpi label={t('platform.revenue.mrr')} value={formatMoney(report.mrrCents, MOEDA)}
                hint={t('platform.revenue.mrrHint', { count: report.activeCount })} />
              <Kpi label={t('platform.revenue.received')} value={formatMoney(report.receivedCents, MOEDA)}
                hint={t('platform.revenue.netHint', { value: formatMoney(netCents(report), MOEDA) })} />
              <Kpi label={t('platform.revenue.refunded')} value={formatMoney(report.refundedCents, MOEDA)}
                tone={report.refundedCents > 0 ? 'danger' : undefined} />
              <Kpi label={t('platform.revenue.open')} value={formatMoney(report.openCents, MOEDA)} />
              <Kpi label={t('platform.revenue.overdue')} value={formatMoney(report.overdueCents, MOEDA)}
                hint={t('platform.revenue.overdueHint', { count: report.overdueTenants })}
                tone={report.overdueCents > 0 ? 'danger' : undefined} />
              {/* Aproximado: o preço de tabela da época do pagamento não é
                  gravado, e a conta usa o de hoje (ver `revenueReportService`). */}
              <Kpi label={t('platform.revenue.discount')} value={formatMoney(report.discountCents, MOEDA)}
                hint={report.discountApproximate === false ? undefined : t('platform.revenue.discountApprox')}
                title={report.discountApproximate === false ? undefined : t('platform.revenue.discountApproxHint')} />
            </div>
          </section>

          <section className="modern-card p-4" aria-labelledby="revenue-monthly-title">
            <h2 id="revenue-monthly-title" className="section-heading mb-3">{t('platform.revenue.monthlyTitle')}</h2>
            <MonthlyChart monthly={report.monthly} from={report.from} to={report.to} />
          </section>

          <section aria-labelledby="revenue-plan-title">
            <h2 id="revenue-plan-title" className="section-heading mb-3">{t('platform.revenue.byPlanTitle')}</h2>
            {/* No celular, cartões: a coluna do recebido ficava fora da tela. */}
            <ul className="mobile-card-list modern-card divide-y divide-border">
              {report.byPlan.length === 0 ? (
                <li className="py-6 text-center text-sm text-muted-foreground">{t('platform.revenue.empty')}</li>
              ) : report.byPlan.map((linha) => (
                <li key={linha.planId ?? 'none'} className="p-4 text-sm">
                  <p className="wrap-break-word font-semibold text-foreground">{linha.name ?? t('platform.revenue.noPlan')}</p>
                  <dl className="mt-2 space-y-1">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{t('platform.revenue.activeCount')}</dt>
                      <dd className="font-mono tabular-nums">{linha.activeCount}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{t('platform.revenue.mrr')}</dt>
                      <dd className="font-mono tabular-nums">{formatMoney(linha.mrrCents, MOEDA)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{t('platform.revenue.received')}</dt>
                      <dd className="font-mono tabular-nums">{formatMoney(linha.receivedCents, MOEDA)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="desktop-table modern-card overflow-x-auto">
              <table className="modern-table">
                <thead>
                  <tr>
                    <th scope="col">{t('platform.revenue.plan')}</th>
                    <th scope="col" className="text-end">{t('platform.revenue.activeCount')}</th>
                    <th scope="col" className="text-end">{t('platform.revenue.mrr')}</th>
                    <th scope="col" className="text-end">{t('platform.revenue.received')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byPlan.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-sm text-muted-foreground">{t('platform.revenue.empty')}</td>
                    </tr>
                  ) : report.byPlan.map((linha) => (
                    <tr key={linha.planId ?? 'none'}>
                      <td>{linha.name ?? t('platform.revenue.noPlan')}</td>
                      <td className="text-end font-mono tabular-nums">{linha.activeCount}</td>
                      <td className="text-end font-mono tabular-nums">{formatMoney(linha.mrrCents, MOEDA)}</td>
                      <td className="text-end font-mono tabular-nums">{formatMoney(linha.receivedCents, MOEDA)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!report && loading && (
        <p className="modern-card py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
      )}

      {/* Os pedidos de cancelamento (0107), desde o início do período da aba. */}
      <PlatformCancellations from={range.from} />
    </div>
  )
}

function Kpi({ label, value, hint, tone, title }: {
  label: string
  value: string
  hint?: string
  tone?: 'danger'
  /** A explicação ao passar o mouse (e lida pelo leitor de tela, pelo `title`). */
  title?: string
}) {
  return (
    <div className="modern-card p-3" title={title}>
      <p className="metric-label">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold tabular-nums ${tone === 'danger' ? 'text-destructive' : 'text-foreground'}`}>
        {value}
      </p>
      {hint && <p className="field-hint">{hint}</p>}
      {title && <p className="sr-only">{title}</p>}
    </div>
  )
}

/** As dimensões do desenho, em unidades do `viewBox` — a largura acompanha o número de meses. */
const ALTURA = 220
const MARGEM_TOPO = 12
const MARGEM_BASE = 28
const MARGEM_ESQ = 64
const LARGURA_MES = 44

function MonthlyChart({ monthly, from, to }: { monthly: RevenueMonth[]; from: string; to: string }) {
  const { t, intlLocale: locale } = useTranslation()
  const topo = niceCeiling(Math.max(0, ...monthly.map((m) => Math.max(m.receivedCents, m.refundedCents))))
  const largura = MARGEM_ESQ + monthly.length * LARGURA_MES + 8
  const util = ALTURA - MARGEM_TOPO - MARGEM_BASE
  const y = (cents: number) => MARGEM_TOPO + util - (topo > 0 ? (cents / topo) * util : 0)
  const grade = topo > 0 ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * topo) : [0]
  const barra = (LARGURA_MES - 12) / 2
  const compacto = (cents: number) => {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency', currency: MOEDA, notation: 'compact', maximumFractionDigits: 1
      }).format(cents / 100)
    } catch {
      return String(Math.round(cents / 100))
    }
  }
  // Com muitos meses, um rótulo sim e outro não — senão eles se atropelam.
  const passoRotulo = monthly.length > 18 ? 3 : monthly.length > 12 ? 2 : 1

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'hsl(var(--primary))' }} />
          {t('platform.revenue.legendReceived')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'hsl(var(--status-danger))' }} />
          {t('platform.revenue.legendRefunded')}
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${largura} ${ALTURA}`}
          width="100%"
          style={{ minWidth: Math.min(largura, 480), maxHeight: 280 }}
          role="img"
          aria-label={t('platform.revenue.chartLabel', { from, to })}
          className="block"
        >
          {grade.map((valor) => (
            <g key={valor}>
              <line
                x1={MARGEM_ESQ} x2={largura - 4} y1={y(valor)} y2={y(valor)}
                stroke="hsl(var(--border))" strokeWidth={1}
                strokeDasharray={valor === 0 ? undefined : '3 3'}
              />
              <text
                x={MARGEM_ESQ - 6} y={y(valor)} textAnchor="end" dominantBaseline="middle"
                fontSize={10} fill="hsl(var(--muted-foreground))"
              >
                {compacto(valor)}
              </text>
            </g>
          ))}
          {monthly.map((mes, i) => {
            const x0 = MARGEM_ESQ + i * LARGURA_MES + 4
            const rotulo = monthLabel(mes.month, locale)
            const dica = `${monthLabel(mes.month, locale, 'long')}: ${t('platform.revenue.legendReceived')} ${formatMoney(mes.receivedCents, MOEDA)} · ${t('platform.revenue.legendRefunded')} ${formatMoney(mes.refundedCents, MOEDA)}`
            return (
              <g key={mes.month}>
                <title>{dica}</title>
                <rect
                  x={x0} y={y(mes.receivedCents)} width={barra}
                  height={Math.max(0, y(0) - y(mes.receivedCents))}
                  rx={2} fill="hsl(var(--primary))"
                />
                <rect
                  x={x0 + barra + 2} y={y(mes.refundedCents)} width={barra}
                  height={Math.max(0, y(0) - y(mes.refundedCents))}
                  rx={2} fill="hsl(var(--status-danger))"
                />
                {i % passoRotulo === 0 && (
                  <text
                    x={x0 + barra} y={ALTURA - MARGEM_BASE + 16} textAnchor="middle"
                    fontSize={10} fill="hsl(var(--muted-foreground))"
                  >
                    {rotulo}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {/* O `sr-only` vai num invólucro: uma tabela não encolhe abaixo do
          conteúdo, e sozinha alargava a página no celular. */}
      <div className="sr-only">
        <table>
          <caption>{t('platform.revenue.monthlyTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('platform.revenue.month')}</th>
              <th scope="col">{t('platform.revenue.legendReceived')}</th>
              <th scope="col">{t('platform.revenue.legendRefunded')}</th>
              <th scope="col">{t('platform.revenue.charges')}</th>
            </tr>
          </thead>
          <tbody>
            {monthly.map((mes) => (
              <tr key={mes.month}>
                <th scope="row">{monthLabel(mes.month, locale, 'long')}</th>
                <td>{formatMoney(mes.receivedCents, MOEDA)}</td>
                <td>{formatMoney(mes.refundedCents, MOEDA)}</td>
                <td>{mes.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
