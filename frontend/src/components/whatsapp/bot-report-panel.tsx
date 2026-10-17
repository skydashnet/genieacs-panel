'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type BotReport } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { formatDayMonth, toDate } from '@/lib/date-format'

const PERIODS = [7, 30, 90] as const
type Period = (typeof PERIODS)[number]

interface Column {
  /** O rótulo curto do eixo e do leitor (dia ou hora). */
  label: string
  value: number
}

/**
 * Colunas de uma série só, em HTML puro como o `BarChart` do Dashboard.
 *
 * Uma série: cor primária, sem legenda (o título do cartão diz o que é).
 * Passar o mouse (ou o foco do teclado) numa coluna mostra o valor na linha
 * de leitura acima; o alvo é a faixa inteira da coluna, não só a barra, para
 * que um dia com zero também possa ser lido. A tabela em `<details>` é a
 * mesma informação sem depender de ver as barras.
 */
export function ColumnChart({ columns, ticks, ariaLabel, valueLabel, tableHeader }: {
  columns: Column[]
  /** Índices que ganham rótulo no eixo: todos poluiriam 30 ou 90 barras. */
  ticks: Set<number>
  ariaLabel: string
  valueLabel: (value: number) => string
  tableHeader: string
}) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...columns.map((c) => c.value), 1)
  const total = columns.reduce((soma, c) => soma + c.value, 0)
  const lido = hover === null ? null : columns[hover]

  return (
    <div>
      <p className="h-5 text-sm text-muted-foreground" aria-live="polite">
        {lido ? <><span className="font-medium text-foreground">{lido.label}</span>{' · '}{valueLabel(lido.value)}</> : t('whatsapp.botReport.hoverHint')}
      </p>
      <div
        className="mt-2 flex h-40 items-end gap-[2px] border-b border-border"
        role="img"
        aria-label={`${ariaLabel}: ${valueLabel(total)}`}
        onMouseLeave={() => setHover(null)}
      >
        {columns.map((column, i) => (
          <div
            key={column.label}
            className="group flex h-full min-w-0 flex-1 cursor-default items-end"
            onMouseEnter={() => setHover(i)}
          >
            <div
              className={`w-full rounded-t-[4px] bg-primary transition-opacity ${hover !== null && hover !== i ? 'opacity-50' : ''}`}
              style={{ height: `${(column.value / max) * 100}%`, minHeight: column.value ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[11px] text-muted-foreground" aria-hidden="true">
        {columns.map((column, i) => (
          <span key={column.label} className="relative min-w-0 flex-1">
            {/* As pontas encostam na borda em vez de centrar, para não vazar do cartão. */}
            {ticks.has(i) && (
              <span className={`absolute whitespace-nowrap ${i === 0 ? 'left-0' : i === columns.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}>
                {column.label}
              </span>
            )}
          </span>
        ))}
      </div>
      <details className="mt-6 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t('whatsapp.botReport.showTable')}</summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 font-medium">{tableHeader}</th>
              <th className="py-1 text-right font-medium">{t('whatsapp.botReport.tableValue')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.label} className="border-t border-border">
                <td className="py-1">{column.label}</td>
                <td className="py-1 text-right tabular-nums">{column.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

/** Um número do relatório, no mesmo desenho dos cartões do Dashboard. */
function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="modern-card min-w-0 p-4 sm:p-5">
      <p className="metric-label">{label}</p>
      <p className="metric-value mt-3 wrap-break-word text-xl text-foreground sm:truncate sm:text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * O relatório do chatbot: quanto o atendimento automático resolveu sozinho e
 * em que horas o cliente pediu gente. Só leitura, sem polling: são números de
 * dias, não de minutos.
 */
export function BotReportPanel() {
  const { t, intlLocale, dateFormat } = useTranslation()
  const [days, setDays] = useState<Period>(7)
  const [report, setReport] = useState<BotReport | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (periodo: Period) => {
    setError('')
    const res = await whatsappAPI.getBotReport(periodo)
    if (!alive.current) return
    if (res.success && res.data) setReport(res.data)
    else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => {
    void load(days)
  }, [days, load])

  const numero = (n: number) => new Intl.NumberFormat(intlLocale).format(n)
  // O dia chega como `YYYY-MM-DD` já no fuso do provedor: formatado ao meio-dia
  // UTC, nenhum fuso do navegador o empurra para o dia vizinho.
  const dia = (d: string) => {
    const data = toDate(d)
    return data ? formatDayMonth(data, dateFormat, intlLocale) : d
  }

  const vazio = report !== null && report.replies === 0

  return (
    <section className="grid gap-5">
      <div className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('whatsapp.botReport.title')}</h2>
            <p className="field-hint mt-1">{t('whatsapp.botReport.description')}</p>
          </div>
          <div className="tab-rail" role="radiogroup" aria-label={t('whatsapp.botReport.period')}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={days === p}
                data-active={days === p}
                className="tab-button"
                onClick={() => setDays(p)}
              >
                {t('whatsapp.botReport.lastDays', { count: p })}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-[hsl(var(--status-danger))]">{error}</p>}
        {report === null && !error && <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {vazio && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.botReport.empty')}</p>}
      </div>

      {report && !vazio && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
            <Tile label={t('whatsapp.botReport.conversations')} value={numero(report.conversations)} />
            <Tile
              label={t('whatsapp.botReport.resolvedRate')}
              value={report.resolvedRate === null ? '—' : new Intl.NumberFormat(intlLocale, { style: 'percent' }).format(report.resolvedRate)}
              hint={t('whatsapp.botReport.resolvedHint', { count: report.resolvedWithoutHuman })}
            />
            <Tile label={t('whatsapp.botReport.invoicesSent')} value={numero(report.invoicesSent)} />
            <Tile label={t('whatsapp.botReport.unlocks')} value={numero(report.unlocks)} />
            <Tile label={t('whatsapp.botReport.outagesInformed')} value={numero(report.outagesInformed)} />
            <Tile label={t('whatsapp.botReport.humanRequests')} value={numero(report.humanRequests)} />
          </div>

          <div className="modern-card p-5 sm:p-6">
            <h3 className="section-heading">{t('whatsapp.botReport.otherTitle')}</h3>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {([
                ['whatsapp.botReport.signalChecks', report.signalChecks],
                ['whatsapp.botReport.noOpenInvoice', report.noOpenInvoice],
                ['whatsapp.botReport.identified', report.identified],
                ['whatsapp.botReport.documentFailures', report.documentFailures],
                ['whatsapp.botReport.replies', report.replies]
              ] as const).map(([chave, valor]) => (
                <div key={chave} className="flex justify-between gap-3 border-b border-border py-1">
                  <dt className="text-muted-foreground">{t(chave)}</dt>
                  <dd className="tabular-nums font-medium">{numero(valor)}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.botReport.dailyTitle')}</h3>
              <p className="field-hint mt-1">{t('whatsapp.botReport.dailyHint')}</p>
              <div className="mt-4">
                <ColumnChart
                  columns={report.daily.map((d) => ({ label: dia(d.day), value: d.conversations }))}
                  ticks={new Set([0, Math.floor((report.daily.length - 1) / 2), report.daily.length - 1])}
                  ariaLabel={t('whatsapp.botReport.dailyTitle')}
                  valueLabel={(v) => t('whatsapp.botReport.conversationsCount', { count: v })}
                  tableHeader={t('whatsapp.botReport.tableDay')}
                />
              </div>
            </div>
            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.botReport.hourlyTitle')}</h3>
              <p className="field-hint mt-1">{t('whatsapp.botReport.hourlyHint', { timezone: report.timezone })}</p>
              <div className="mt-4">
                <ColumnChart
                  columns={report.humanRequestsByHour.map((v, h) => ({ label: `${String(h).padStart(2, '0')}h`, value: v }))}
                  ticks={new Set([0, 6, 12, 18, 23])}
                  ariaLabel={t('whatsapp.botReport.hourlyTitle')}
                  valueLabel={(v) => t('whatsapp.botReport.requestsCount', { count: v })}
                  tableHeader={t('whatsapp.botReport.tableHour')}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default BotReportPanel
