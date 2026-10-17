'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  whatsappAPI,
  type MetaPriceCategory,
  type MetaPrices,
  type MetaUsagePeriod,
  type MetaUsageReport
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const PERIODS: MetaUsagePeriod[] = [3, 6, 12]
const PRICE_CATEGORIES: MetaPriceCategory[] = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE']
const TOP = 10

type PriceDraft = Record<MetaPriceCategory, string>

function draftFrom(prices: MetaPrices): PriceDraft {
  const out = {} as PriceDraft
  for (const cat of PRICE_CATEGORIES) out[cat] = prices[cat] === null ? '' : String(prices[cat])
  return out
}

/**
 * Quantos modelos aprovados da Meta o painel mandou por mês, por categoria, e
 * quanto isso custaria pelos preços que o provedor digitar.
 *
 * O número é do PAINEL, não da fatura: a Meta cobra por país do destinatário,
 * faixa de volume e janela gratuita, e nada disso está aqui. Por isso a coluna
 * em reais se chama estimativa e diz, ao lado, para conferir na fatura.
 */
export function MetaUsagePanel() {
  const { t, intlLocale } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const podeLer = can('campaigns.read')
  const podeGerir = can('campaigns.manage')
  const [hasCloud, setHasCloud] = useState<boolean | null>(null)
  const [months, setMonths] = useState<MetaUsagePeriod>(6)
  const [report, setReport] = useState<MetaUsageReport | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<PriceDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!podeLer) return
    void whatsappAPI.listAccounts().then((res) => {
      if (!alive.current) return
      setHasCloud(Boolean(res.success && res.data?.some((a) => a.integration === 'cloud')))
    })
  }, [podeLer])

  const load = useCallback(async (periodo: MetaUsagePeriod) => {
    setError('')
    const res = await whatsappAPI.getMetaUsage(periodo)
    if (!alive.current) return
    if (res.success && res.data) {
      setReport(res.data)
      setDraft((atual) => atual ?? draftFrom(res.data!.prices))
    } else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => {
    if (podeLer && hasCloud) void load(months)
  }, [podeLer, hasCloud, months, load])

  const savePrices = async () => {
    if (!draft) return
    setSaving(true)
    const res = await whatsappAPI.saveMetaPrices(draft)
    if (!alive.current) return
    setSaving(false)
    if (res.success && res.data) {
      toast.success(t('whatsapp.metaUsage.pricesSaved'))
      setDraft(draftFrom(res.data))
      void load(months)
    } else {
      toast.error(whatsappErrorMessage(t, res.code))
    }
  }

  if (!podeLer || hasCloud === null) return null

  if (!hasCloud) {
    return (
      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('whatsapp.metaUsage.title')}</h2>
        <p className="field-hint mt-1">{t('whatsapp.metaUsage.cloudOnly')}</p>
      </section>
    )
  }

  const inteiro = new Intl.NumberFormat(intlLocale)
  const moeda = new Intl.NumberFormat(intlLocale, { style: 'currency', currency: 'BRL' })
  const mesFmt = new Intl.DateTimeFormat(intlLocale, { month: 'short', year: 'numeric' })
  const nomeMes = (chave: string) => {
    const [ano, mes] = chave.split('-').map(Number)
    return mesFmt.format(new Date(ano, mes - 1, 1))
  }
  const nomeCategoria = (cat: string) => (cat === 'UNKNOWN' ? t('whatsapp.metaUsage.unknownCategory') : cat)

  const prices = report?.prices
  const comPreco = (cat: string): cat is MetaPriceCategory =>
    Boolean(prices && (PRICE_CATEGORIES as string[]).includes(cat) && prices[cat as MetaPriceCategory] !== null)
  const colunas = report
    ? report.categories.filter((cat) => (report.totals.byCategory[cat] ?? 0) > 0 || comPreco(cat))
    : []
  const temEstimativa = Boolean(report?.estimate)
  const estimar = (byCategory: Record<string, number>) => {
    let total = 0
    for (const cat of PRICE_CATEGORIES) {
      const preco = prices?.[cat]
      if (preco !== null && preco !== undefined) total += (byCategory[cat] ?? 0) * preco
    }
    return total
  }
  const vazio = report !== null && report.totals.total === 0 && report.totals.failed === 0

  return (
    <section className="grid gap-5">
      <div className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('whatsapp.metaUsage.title')}</h2>
            <p className="field-hint mt-1">{t('whatsapp.metaUsage.description')}</p>
          </div>
          <div className="tab-rail" role="radiogroup" aria-label={t('whatsapp.metaUsage.period')}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={months === p}
                data-active={months === p}
                className="tab-button"
                onClick={() => setMonths(p)}
              >
                {t('whatsapp.metaUsage.lastMonths', { count: p })}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-[hsl(var(--status-danger))]">{error}</p>}
        {report === null && !error && <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {report?.truncated && <p className="mt-3 text-sm text-[hsl(var(--status-warning))]">{t('whatsapp.metaUsage.truncated')}</p>}
        {vazio && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.metaUsage.empty')}</p>}

        {report && !vazio && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-lg text-left text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 font-medium">{t('whatsapp.metaUsage.month')}</th>
                  {colunas.map((cat) => (
                    <th key={cat} className="py-1 text-right font-medium">{nomeCategoria(cat)}</th>
                  ))}
                  <th className="py-1 text-right font-medium">{t('whatsapp.metaUsage.total')}</th>
                  <th className="py-1 text-right font-medium" title={t('whatsapp.metaUsage.failedHint')}>
                    {t('whatsapp.metaUsage.failed')}
                  </th>
                  {temEstimativa && <th className="py-1 text-right font-medium">{t('whatsapp.metaUsage.estimate')}</th>}
                </tr>
              </thead>
              <tbody>
                {report.monthly.map((m) => (
                  <tr key={m.month} className="border-t border-border">
                    <td className="py-1.5 capitalize">{nomeMes(m.month)}</td>
                    {colunas.map((cat) => (
                      <td key={cat} className="py-1.5 text-right tabular-nums">{inteiro.format(m.byCategory[cat] ?? 0)}</td>
                    ))}
                    <td className="py-1.5 text-right tabular-nums font-medium">{inteiro.format(m.total)}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{inteiro.format(m.failed)}</td>
                    {temEstimativa && <td className="py-1.5 text-right tabular-nums">{moeda.format(estimar(m.byCategory))}</td>}
                  </tr>
                ))}
                <tr className="border-t-2 border-border font-semibold">
                  <td className="py-1.5">{t('whatsapp.metaUsage.total')}</td>
                  {colunas.map((cat) => (
                    <td key={cat} className="py-1.5 text-right tabular-nums">{inteiro.format(report.totals.byCategory[cat] ?? 0)}</td>
                  ))}
                  <td className="py-1.5 text-right tabular-nums">{inteiro.format(report.totals.total)}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">{inteiro.format(report.totals.failed)}</td>
                  {temEstimativa && <td className="py-1.5 text-right tabular-nums">{moeda.format(report.estimate?.total ?? 0)}</td>}
                </tr>
              </tbody>
            </table>
            <p className="field-hint mt-2">{t('whatsapp.metaUsage.failedHint')}</p>
            {temEstimativa && <p className="field-hint mt-1">{t('whatsapp.metaUsage.estimateHint')}</p>}
            {report.timezone && <p className="field-hint mt-1">{t('whatsapp.metaUsage.timezone', { timezone: report.timezone })}</p>}
          </div>
        )}
      </div>

      {report && !vazio && (
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="modern-card min-w-0 p-5 sm:p-6">
            <h3 className="section-heading">{t('whatsapp.metaUsage.topTemplates')}</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 font-medium">{t('whatsapp.metaUsage.template')}</th>
                    <th className="py-1 font-medium">{t('whatsapp.metaUsage.language')}</th>
                    <th className="py-1 font-medium">{t('whatsapp.metaUsage.category')}</th>
                    <th className="py-1 text-right font-medium">{t('whatsapp.metaUsage.count')}</th>
                    <th className="py-1 text-right font-medium">{t('whatsapp.metaUsage.failed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.templates.slice(0, TOP).map((m) => (
                    <tr key={`${m.name}|${m.language}`} className="border-t border-border">
                      <td className="py-1.5 font-mono text-xs wrap-anywhere">{m.name || '—'}</td>
                      <td className="py-1.5 text-muted-foreground">{m.language || '—'}</td>
                      <td className="py-1.5">{nomeCategoria(m.category)}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{inteiro.format(m.count)}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{inteiro.format(m.failed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="modern-card min-w-0 p-5 sm:p-6">
            <h3 className="section-heading">{t('whatsapp.metaUsage.byAccount')}</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 font-medium">{t('whatsapp.metaUsage.account')}</th>
                    <th className="py-1 text-right font-medium">{t('whatsapp.metaUsage.count')}</th>
                    <th className="py-1 text-right font-medium">{t('whatsapp.metaUsage.failed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.accounts.map((a) => (
                    <tr key={a.accountId ?? 'none'} className="border-t border-border">
                      <td className="py-1.5">{a.label || a.name || '—'}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{inteiro.format(a.total)}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{inteiro.format(a.failed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="modern-card p-5 sm:p-6">
          <h3 className="section-heading">{t('whatsapp.metaUsage.prices')}</h3>
          <p className="field-hint mt-1">{t('whatsapp.metaUsage.pricesHint')}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {PRICE_CATEGORIES.map((cat) => (
              <label key={cat} className="grid gap-1 text-sm">
                <span className="text-muted-foreground">{t('whatsapp.metaUsage.priceFor', { category: cat })}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.0001}
                  className="modern-input"
                  value={draft[cat]}
                  disabled={!podeGerir || saving}
                  onChange={(e) => setDraft({ ...draft, [cat]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="modern-button-secondary mt-4"
            disabled={!podeGerir || saving}
            onClick={() => void savePrices()}
          >
            {t('whatsapp.metaUsage.savePrices')}
          </button>
        </div>
      )}
    </section>
  )
}

export default MetaUsagePanel
