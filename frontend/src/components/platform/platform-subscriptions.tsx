'use client'

import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  platformAPI,
  type BillingEventView,
  type ChargeConsoleView,
  type Plan,
  type SubscriptionConsoleRow,
  type SubscriptionConsoleStatus,
  type SubscriptionConsoleSummary,
  type SubscriptionReminderView,
  type SubscriptionStatus
} from '@/lib/api'
import {
  BillingExemptControl, RetentionBadges, RevertCancellationButton, exemptUntilLabel, statusBadgeClass, statusLabelKey
} from '@/components/platform/tenant-plan'
import { InvoiceSummary, IssueInvoiceButton } from '@/components/platform/charge-invoice'
import { CouponBadge, CouponControl } from '@/components/platform/coupon-control'
import { CardBadge } from '@/components/card-badge'
import { ChargePricingBreakdown } from '@/components/charge-pricing'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { copyToClipboard, parseAmountToCents } from '@/lib/utils'
import { canIssueInvoice } from '@/lib/invoice'
import {
  CHARGE_STATUS_LABEL_KEYS,
  CONSOLE_STATUS_LABEL_KEYS,
  CONSOLE_STATUS_ORDER,
  centsToInput,
  chargeActions,
  chargeBadgeClass,
  computeChargeAmount,
  dayInputValue,
  dayKeySaoPaulo,
  deadlineOf,
  endOfDayIso,
  exemptCount,
  filterRows,
  formatDay,
  gatewayBadge,
  isBillingExempt,
  isChargeLate,
  openTotalsByCurrency,
  parseExtendDays,
  refundPreview,
  summaryStatusCards,
  todayIso,
  type AmountMode,
  type ChargeContext
} from '@/lib/subscription-console'

/**
 * A aba Assinaturas do console: a carteira inteira numa tela só.
 *
 * A aba de provedores responde "quem é este cliente"; esta responde "quem
 * está devendo, quanto, e o que eu faço com isso". Por isso a linha já mostra
 * a cobrança em aberto e o gateway, e o painel aberto da linha é onde se dá
 * baixa, se muda vencimento ou valor, se cancela e se reemite — sem precisar
 * abrir a Asaas em outra aba.
 */
interface Props {
  plans: Plan[]
  /** Celular e tablet: a tabela vira cartões, como na aba de provedores. */
  estreito: boolean
}

type SubscriptionRow = SubscriptionConsoleRow

/** O recurso que não cabe no plano novo, no 409 `over_limit` da troca. */
const RESOURCE_KEYS = {
  operators: 'platform.subscription.operators',
  subscribers: 'platform.subscription.subscribers',
  devices: 'platform.subscription.devices'
} as const

export function PlatformSubscriptions({ plans, estreito }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SubscriptionRow[]>([])
  const [summary, setSummary] = useState<SubscriptionConsoleSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const [statuses, setStatuses] = useState<SubscriptionConsoleStatus[]>([])
  const [onlyOpenCharge, setOnlyOpenCharge] = useState(false)
  const [onlyExempt, setOnlyExempt] = useState(false)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.listSubscriptions()
    if (res.success && res.data) {
      setRows(res.data.rows)
      setSummary(res.data.summary)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visiveis = useMemo(
    () => filterRows(rows, { statuses, onlyOpenCharge, search, onlyExempt }),
    [rows, statuses, onlyOpenCharge, search, onlyExempt]
  )

  const alternarStatus = (status: SubscriptionConsoleStatus) => {
    setStatuses((atual) => (atual.includes(status) ? atual.filter((s) => s !== status) : [...atual, status]))
  }

  // O total em aberto. O resumo do backend é um número só; se as cobranças em
  // aberto das linhas vêm em mais de uma moeda, somar tudo seria inventar um
  // valor, e a tela mostra uma linha por moeda. Com uma moeda só (o caso de
  // sempre), vale o número do servidor, na moeda dessas cobranças.
  const totaisPorMoeda = useMemo(() => openTotalsByCurrency(rows), [rows])
  const variasMoedas = totaisPorMoeda.length > 1
  const moedaTotal = totaisPorMoeda[0]?.currency || plans[0]?.currency || 'BRL'

  const vazio = loading
    ? t('common.loading')
    : error !== null
      ? error || t('platform.subs.loadFailed')
      : rows.length === 0
        ? t('platform.subs.empty')
        : visiveis.length === 0
          ? t('platform.subs.noMatch')
          : null

  const isentos = exemptCount(summary, rows)

  const alternarLinha = (id: number) => setExpandedId((atual) => (atual === id ? null : id))

  return (
    <div className="space-y-6">
      <section aria-labelledby="subs-summary-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="subs-summary-title" className="section-heading">{t('platform.subs.summaryTitle')}</h2>
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {summaryStatusCards(summary).map((card) => (
            <div key={card.status} className="modern-card p-3">
              <p className="metric-label">{t(card.labelKey)}</p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">{card.count}</p>
            </div>
          ))}
          <div className="modern-card p-3">
            <p className="metric-label">{t('platform.subs.filterExempt')}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">{isentos}</p>
          </div>
          {/* No celular, linha inteira e por último: um total de sete dígitos
              em mono não cabe na metade da tela. */}
          <div className="modern-card order-last col-span-2 p-3 sm:order-none sm:col-span-1">
            <p className="metric-label">{t('platform.subs.openTotal')}</p>
            {variasMoedas ? (
              <>
                <ul className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">
                  {totaisPorMoeda.map((total) => (
                    <li key={total.currency}>{formatMoney(total.cents, total.currency)}</li>
                  ))}
                </ul>
                <p className="field-hint">{t('platform.subs.openTotalByCurrency')}</p>
              </>
            ) : (
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                {formatMoney(summary?.openTotalCents ?? 0, moedaTotal)}
              </p>
            )}
          </div>
          <div className="modern-card p-3">
            <p className="metric-label">{t('platform.subs.overdueCount')}</p>
            <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${(summary?.overdueCount ?? 0) > 0 ? 'text-destructive' : 'text-foreground'}`}>
              {summary?.overdueCount ?? 0}
            </p>
          </div>
        </div>
      </section>

      <section className="modern-card p-4" aria-label={t('platform.subs.filters')}>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('platform.subs.filterStatus')}>
          {CONSOLE_STATUS_ORDER.map((status) => {
            const ligado = statuses.includes(status)
            return (
              <button
                key={status}
                type="button"
                aria-pressed={ligado}
                onClick={() => alternarStatus(status)}
                className={ligado ? 'modern-button' : 'modern-button-secondary'}
              >
                {t(CONSOLE_STATUS_LABEL_KEYS[status])}
                <span className="font-mono text-xs opacity-80">{summary?.byStatus?.[status] ?? 0}</span>
              </button>
            )
          })}
          {/* Isento continua `active`: é um recorte à parte, que combina com os estados. */}
          <button
            type="button"
            aria-pressed={onlyExempt}
            onClick={() => setOnlyExempt((atual) => !atual)}
            className={onlyExempt ? 'modern-button' : 'modern-button-secondary'}
          >
            {t('platform.subs.filterExempt')}
            <span className="font-mono text-xs opacity-80">{isentos}</span>
          </button>
          {(statuses.length > 0 || onlyExempt) && (
            <button
              type="button"
              className="modern-button-secondary"
              onClick={() => {
                setStatuses([])
                setOnlyExempt(false)
              }}
            >
              {t('platform.subs.clearFilters')}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="modern-input w-full sm:w-72"
            placeholder={t('platform.subs.searchPlaceholder')}
            aria-label={t('platform.subs.searchPlaceholder')}
          />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={onlyOpenCharge}
              onChange={(e) => setOnlyOpenCharge(e.target.checked)}
            />
            {t('platform.subs.onlyOpenCharge')}
          </label>
        </div>
      </section>

      {estreito ? (
        <div className="space-y-3">
          {vazio !== null ? (
            <p className={`modern-card py-8 text-center text-sm ${error !== null && !loading ? 'text-destructive' : 'text-muted-foreground'}`}>{vazio}</p>
          ) : (
            visiveis.map((row) => {
              const expanded = expandedId === row.tenant.id
              return (
                <article key={row.tenant.id} className="modern-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="wrap-break-word font-semibold text-foreground">{row.tenant.name}</h3>
                      <p className="break-all font-mono text-xs text-muted-foreground">{row.tenant.slug}</p>
                    </div>
                    <StatusBadge row={row} />
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-2 text-sm">
                    <div><dt className="metric-label">{t('platform.subs.col.plan')}</dt><dd><PlanCell row={row} /></dd></div>
                    <div><dt className="metric-label">{t('platform.subs.col.deadline')}</dt><dd><DeadlineCell row={row} /></dd></div>
                    <div><dt className="metric-label">{t('platform.subs.col.openCharge')}</dt><dd><OpenChargeCell row={row} /></dd></div>
                    <div><dt className="metric-label">{t('platform.subs.col.gateway')}</dt><dd><GatewayCell row={row} /></dd></div>
                  </dl>
                  <div className="mt-4 border-t border-border pt-4">
                    <ExpandButton expanded={expanded} onClick={() => alternarLinha(row.tenant.id)} name={row.tenant.name} />
                  </div>
                  {expanded && (
                    <div className="mt-4 min-w-0 border-t border-border pt-4">
                      <SubscriptionDetail row={row} plans={plans} onChanged={() => void load()} />
                    </div>
                  )}
                </article>
              )
            })
          )}
        </div>
      ) : (
        <div className="modern-card overflow-x-auto">
          <table className="modern-table">
            <thead>
              <tr>
                <th>{t('platform.subs.col.provider')}</th>
                <th>{t('platform.subs.col.plan')}</th>
                <th>{t('common.status')}</th>
                <th>{t('platform.subs.col.deadline')}</th>
                <th>{t('platform.subs.col.openCharge')}</th>
                <th>{t('platform.subs.col.gateway')}</th>
                <th><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {vazio !== null ? (
                <tr>
                  <td colSpan={7} className={`py-8 text-center ${error !== null && !loading ? 'text-destructive' : 'text-muted-foreground'}`}>{vazio}</td>
                </tr>
              ) : (
                visiveis.map((row) => {
                  const expanded = expandedId === row.tenant.id
                  return (
                    <Fragment key={row.tenant.id}>
                      <tr>
                        <td>
                          <span className="font-medium">{row.tenant.name}</span>
                          <span className="block font-mono text-xs text-muted-foreground">{row.tenant.slug}</span>
                        </td>
                        <td className="text-sm"><PlanCell row={row} /></td>
                        <td><StatusBadge row={row} /></td>
                        <td className="text-sm"><DeadlineCell row={row} /></td>
                        <td className="text-sm"><OpenChargeCell row={row} /></td>
                        <td><GatewayCell row={row} /></td>
                        <td>
                          <ExpandButton expanded={expanded} onClick={() => alternarLinha(row.tenant.id)} name={row.tenant.name} />
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={7}>
                            <SubscriptionDetail row={row} plans={plans} onChanged={() => void load()} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── As células da linha, escritas uma vez para a tabela e para os cartões ──

function ExpandButton({ expanded, onClick, name }: { expanded: boolean; onClick: () => void; name: string }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={t(expanded ? 'platform.subs.collapseRow' : 'platform.subs.expandRow', { provider: name })}
      className="modern-button-secondary"
    >
      <Icon name="chevron-down" size={16} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
      {t('platform.subs.manage')}
    </button>
  )
}

function StatusBadge({ row }: { row: SubscriptionRow }) {
  const { t } = useTranslation()
  if (!row.subscription) return <span className="modern-badge">{t('platform.subs.status.none')}</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={statusBadgeClass(row.subscription.status)}>
        {t(statusLabelKey(row.subscription))}
      </span>
      {isBillingExempt(row.subscription) && (
        <span className="modern-badge-info" title={row.subscription.billingExemptReason ?? undefined}>
          {exemptUntilLabel(row.subscription, t) ?? t('platform.subs.exempt')}
        </span>
      )}
      <CardBadge card={row.subscription.card} />
      <RetentionBadges subscription={row.subscription} />
    </span>
  )
}

function PlanCell({ row }: { row: SubscriptionRow }) {
  const { t } = useTranslation()
  const sub = row.subscription
  if (!sub) return <span className="text-muted-foreground">—</span>
  return (
    <span className="block">
      <span>{sub.planName ?? sub.planCode ?? '—'}</span>
      {/* O ciclo (0104): o preço é o de UM ciclo — o do ano, no anual. */}
      {sub.billingCycle === 'annual' && <span className="modern-badge-info ml-1 text-xs">{t('plan.cycle.annual')}</span>}
      {sub.priceCents !== null && (
        <span className="block text-xs text-muted-foreground">
          {t(sub.billingCycle === 'annual' ? 'plan.options.perYear' : 'plan.options.perMonth', {
            price: formatMoney(sub.priceCents, sub.currency)
          })}
        </span>
      )}
      {/* O cupom: o selo e o que a próxima fatura de fato pede. */}
      {sub.coupon && (
        <span className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <CouponBadge coupon={sub.coupon} currency={sub.currency} />
          {sub.coupon.appliesToPlan && sub.coupon.priceCents !== sub.priceCents && (
            <span className="text-muted-foreground">
              {t('coupons.priceWithCoupon', { price: formatMoney(sub.coupon.priceCents, sub.currency) })}
            </span>
          )}
        </span>
      )}
      {/* A descida agendada: até a data, o plano de cima continua valendo — e
          quem olha a carteira precisa saber que a receita vai cair. */}
      {sub.pendingPlan && (
        <span className="mt-1 block text-xs text-[hsl(var(--status-warning))]">
          {t('platform.subs.pendingPlan', {
            plan: sub.pendingPlan.billingCycle && sub.pendingPlan.billingCycle !== (sub.billingCycle ?? 'monthly')
              ? `${sub.pendingPlan.name} (${t(sub.pendingPlan.billingCycle === 'annual' ? 'plan.cycle.annual' : 'plan.cycle.monthly')})`
              : sub.pendingPlan.name,
            date: formatDay(sub.pendingPlan.effectiveAt)
          })}
          {sub.pendingPlan.locked && ` · ${t('platform.subs.pendingLocked')}`}
        </span>
      )}
    </span>
  )
}

function DeadlineCell({ row }: { row: SubscriptionRow }) {
  const { t } = useTranslation()
  const prazo = deadlineOf(row.subscription)
  if (!prazo) return <span className="text-muted-foreground">—</span>
  return (
    <span className="block">
      <span className="block text-xs text-muted-foreground">
        {t(prazo.kind === 'trial' ? 'platform.subs.trialEnd' : 'platform.subs.paidUntil')}
      </span>
      <span>{formatDay(prazo.date)}</span>
    </span>
  )
}

function OpenChargeCell({ row }: { row: SubscriptionRow }) {
  const { t } = useTranslation()
  const charge = row.openCharge
  if (!charge) return <span className="text-muted-foreground">{t('platform.subs.noOpenCharge')}</span>
  const late = isChargeLate(charge)
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono tabular-nums">{formatMoney(charge.amountCents, charge.currency)}</span>
      {charge.kind === 'proration' && <span className="modern-badge-info">{t('charges.proration')}</span>}
      {charge.kind === 'overage' && <span className="modern-badge-info">{t('charges.overage')}</span>}
      <span className={late ? 'text-destructive' : 'text-muted-foreground'}>
        {t('platform.subs.dueOn', { date: formatDay(charge.dueDate) })}
      </span>
      <span className={late && charge.status === 'pending' ? 'modern-badge-error' : chargeBadgeClass(charge.status)}>
        {late && charge.status === 'pending' ? t('charges.status.overdue') : t(CHARGE_STATUS_LABEL_KEYS[charge.status])}
      </span>
      {charge.invoiceUrl && (
        <a
          href={charge.invoiceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-10 items-center gap-1 text-primary underline-offset-2 hover:underline sm:min-h-0"
        >
          <Icon name="external" size={14} />
          {t('platform.subs.invoice')}
        </a>
      )}
    </span>
  )
}

function GatewayCell({ row }: { row: SubscriptionRow }) {
  const { t } = useTranslation()
  const badge = gatewayBadge(row.gateway)
  if (badge.kind === 'manual') return <span className="modern-badge">{t('platform.subs.gatewayManual')}</span>
  if (badge.kind === 'unlinked') {
    return (
      <span className="modern-badge-warning" title={badge.name}>
        {t('platform.subs.gatewayUnlinked', { gateway: badge.name })}
      </span>
    )
  }
  return <span className="modern-badge-success">{badge.name}</span>
}

// ── O diálogo compartilhado (as classes são as dos modais do painel) ──

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
  // Esc fecha, menos no meio de um envio: fechar ali deixaria a resposta
  // chegar a um diálogo que não existe mais, sem ninguém para ler o erro.
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

// ── O painel aberto da linha ──

type DialogState =
  | { kind: 'status'; status: SubscriptionStatus }
  | { kind: 'deadlines' }
  | { kind: 'settle'; charge: ChargeConsoleView }
  | { kind: 'dueDate'; charge: ChargeConsoleView }
  | { kind: 'amount'; charge: ChargeConsoleView }
  | { kind: 'cancelCharge'; charge: ChargeConsoleView }
  | { kind: 'reissue'; charge: ChargeConsoleView }
  | { kind: 'refund'; charge: ChargeConsoleView }

/**
 * Traduz as recusas conhecidas das rotas de cobrança pelo `code`: o backend
 * responde em inglês literal, e a frase que o operador lê tem que estar na
 * língua dele. O que não se conhece cai na mensagem do servidor.
 */
function useRefusal() {
  const { t } = useTranslation()
  return (res: { code?: string; message?: string }) => {
    if (res.code === 'not_open') return t('platform.subs.err.notOpen')
    if (res.code === 'not_paid') return t('platform.subs.err.notPaid')
    if (res.code === 'busy') return t('platform.subs.err.busy')
    if (res.code === 'gateway_failed') return t('platform.subs.err.gatewayFailed')
    return res.message || t('platform.saveFailed')
  }
}

function SubscriptionDetail({ row, plans, onChanged }: { row: SubscriptionRow; plans: Plan[]; onChanged: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const tenantId = row.tenant.id
  const sub = row.subscription

  const [charges, setCharges] = useState<ChargeConsoleView[]>([])
  const [events, setEvents] = useState<BillingEventView[]>([])
  const [reminders, setReminders] = useState<SubscriptionReminderView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [chosenPlan, setChosenPlan] = useState<number | ''>(sub?.planId ?? '')
  const [savingPlan, setSavingPlan] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [cobrancas, assinatura] = await Promise.all([
      platformAPI.listTenantCharges(tenantId),
      platformAPI.getSubscription(tenantId)
    ])
    if (cobrancas.success && cobrancas.data) {
      setCharges(cobrancas.data.charges)
      setError(null)
    } else {
      setError(cobrancas.message || '')
    }
    setEvents(assinatura.success && assinatura.data ? assinatura.data.events : [])
    setReminders(assinatura.success && assinatura.data ? assinatura.data.reminders ?? [] : [])
    setLoading(false)
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setChosenPlan(sub?.planId ?? '')
  }, [sub?.planId])

  /** Depois de qualquer ação: a linha (lista) e o painel aberto, os dois. */
  const recarregar = async () => {
    onChanged()
    await load()
  }

  const fechar = useCallback(() => setDialog(null), [])

  const trocarPlano = async () => {
    if (chosenPlan === '' || chosenPlan === sub?.planId) return
    setSavingPlan(true)
    try {
      const res = await platformAPI.updateSubscription(tenantId, { planId: Number(chosenPlan) })
      if (res.success) {
        toast.success(t('platform.subs.planChanged'))
        await recarregar()
      } else if (res.code === 'over_limit' && res.resource && typeof res.limit === 'number') {
        toast.error(t('platform.subs.err.overLimit', {
          resource: t(RESOURCE_KEYS[res.resource]),
          used: res.used ?? 0,
          limit: res.limit
        }))
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setSavingPlan(false)
    }
  }

  const copiar = async (url: string) => {
    const ok = await copyToClipboard(url)
    if (ok) toast.success(t('platform.subs.linkCopied'))
    else toast.error(t('platform.subs.copyFailed'))
  }

  const stored = sub?.storedStatus ?? null
  // Os dias que um pagamento compra, para a prévia do estorno: os do plano
  // atual, ou os 30 que o backend assume quando o plano não diz.
  const periodDays = plans.find((plan) => plan.id === sub?.planId)?.periodDays ?? 30

  return (
    <div className="space-y-5 py-3">
      {/* Assinatura */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.plan')}</h4>
          <select
            value={chosenPlan}
            onChange={(e) => setChosenPlan(e.target.value === '' ? '' : Number(e.target.value))}
            className="modern-input w-full"
            aria-label={t('platform.subscription.plan')}
          >
            {chosenPlan === '' && <option value="">—</option>}
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id} disabled={!plan.active && plan.id !== sub?.planId}>
                {plan.name} · {formatMoney(plan.priceCents, plan.currency)}
                {plan.active ? '' : ` — ${t('platform.plans.inactive')}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void trocarPlano()}
            disabled={savingPlan || chosenPlan === '' || chosenPlan === sub?.planId}
            className="modern-button mt-2"
          >
            {savingPlan ? t('common.saving') : t('platform.subscription.changePlan')}
          </button>
          {sub && (
            <CouponControl
              tenantId={tenantId}
              coupon={sub.coupon}
              currency={sub.currency}
              storedStatus={sub.storedStatus}
              onChanged={recarregar}
            />
          )}
        </div>

        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('common.status')}</h4>
          <div className="flex flex-wrap gap-2">
            {stored !== 'suspended' && stored !== 'canceled' && (
              <button type="button" className="modern-button-secondary" onClick={() => setDialog({ kind: 'status', status: 'suspended' })}>
                <Icon name="lock" size={16} />
                {t('platform.subs.suspend')}
              </button>
            )}
            {(stored === 'suspended' || stored === 'canceled' || stored === 'past_due') && (
              <button type="button" className="modern-button-secondary" onClick={() => setDialog({ kind: 'status', status: 'active' })}>
                <Icon name="unlock" size={16} />
                {t('platform.subs.reactivate')}
              </button>
            )}
            {stored !== 'canceled' && (
              <button type="button" className="modern-button-secondary text-destructive" onClick={() => setDialog({ kind: 'status', status: 'canceled' })}>
                <Icon name="x" size={16} />
                {t('platform.subs.cancelSubscription')}
              </button>
            )}
          </div>
          <p className="field-hint">{t('platform.subscription.statusHint')}</p>
          {/* O cancelamento agendado pelo próprio provedor (0107). */}
          {sub?.cancelAt && (
            <div className="mt-2">
              <RevertCancellationButton tenantId={tenantId} cancelAt={sub.cancelAt} onChanged={recarregar} />
            </div>
          )}
          <BillingExemptControl tenantId={tenantId} subscription={sub} onChanged={recarregar} />
        </div>

        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subs.deadlines')}</h4>
          <p className="text-sm text-muted-foreground">
            {t('platform.subs.paidUntil')}: {formatDay(sub?.renewsAt)}
            {sub?.trialEndsAt && (
              <>
                <br />
                {t('platform.subs.trialEnd')}: {formatDay(sub.trialEndsAt)}
              </>
            )}
          </p>
          <button type="button" className="modern-button-secondary mt-2" disabled={!sub} onClick={() => setDialog({ kind: 'deadlines' })}>
            <Icon name="edit" size={16} />
            {t('platform.subs.extend')}
          </button>
        </div>
      </div>

      {/* Cobranças */}
      <div className="rounded-md border border-border bg-card">
        <h4 className="px-3 pt-3 text-sm font-semibold text-foreground">{t('platform.subs.charges')}</h4>
        {loading ? (
          <p className="p-3 text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : error !== null ? (
          <p className="p-3 text-sm text-destructive">{error || t('charges.loadFailed')}</p>
        ) : charges.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t('charges.empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {charges.map((charge) => (
              <ChargeItem
                key={charge.id}
                charge={charge}
                context={{ gateway: row.gateway, subscription: row.subscription }}
                onAction={(kind) => setDialog({ kind, charge })}
                onCopy={(url) => void copiar(url)}
                tenantId={tenantId}
                onInvoiceQueued={recarregar}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Histórico */}
      {events.length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <h4 className="px-3 pt-3 text-sm font-semibold text-foreground">{t('platform.subs.history')}</h4>
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="modern-badge mr-2">{event.type}</span>
                  {event.amountCents !== null && <span>{formatMoney(event.amountCents, event.currency)}</span>}
                  {event.externalId && <span className="ml-2 font-mono text-xs break-all text-muted-foreground">{event.externalId}</span>}
                </span>
                <span className="text-muted-foreground">{formatDay(event.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Lembretes de cobrança mandados (somente leitura) */}
      {reminders.length > 0 && <ReminderList reminders={reminders} />}

      {dialog?.kind === 'status' && (
        <StatusDialog tenantId={tenantId} status={dialog.status} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'deadlines' && sub && (
        <DeadlinesDialog tenantId={tenantId} subscription={sub} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'settle' && (
        <SettleDialog tenantId={tenantId} charge={dialog.charge} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'dueDate' && (
        <DueDateDialog tenantId={tenantId} charge={dialog.charge} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'amount' && (
        <AmountDialog tenantId={tenantId} charge={dialog.charge} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'cancelCharge' && (
        <CancelChargeDialog tenantId={tenantId} charge={dialog.charge} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'reissue' && (
        <ReissueDialog tenantId={tenantId} charge={dialog.charge} onClose={fechar} onDone={recarregar} />
      )}
      {dialog?.kind === 'refund' && (
        <RefundDialog
          tenantId={tenantId}
          charge={dialog.charge}
          renewsAt={sub?.renewsAt ?? null}
          periodDays={periodDays}
          onClose={fechar}
          onDone={recarregar}
        />
      )}
    </div>
  )
}

const REMINDER_STEP_KEYS = {
  before: 'platform.subs.reminders.step.before',
  due: 'platform.subs.reminders.step.due',
  after: 'platform.subs.reminders.step.after',
  // A suspensão automática (0102): o aviso antes, e o aviso dela.
  suspension_warning: 'platform.subs.reminders.step.suspensionWarning',
  suspended: 'platform.subs.reminders.step.suspended',
  // O lembrete mandado à mão pelo painel de inadimplência.
  manual: 'platform.subs.reminders.step.manual'
} as const

const REMINDER_CHANNEL_KEYS: Record<string, 'platform.subs.reminders.channel.email' | 'platform.subs.reminders.channel.whatsapp'> = {
  email: 'platform.subs.reminders.channel.email',
  whatsapp: 'platform.subs.reminders.channel.whatsapp'
}

/**
 * Os lembretes de cobrança que a régua já mandou a este provedor: responde
 * "ele foi avisado?" sem abrir o log do SMTP. Só leitura — a régua é do
 * agendador.
 */
function ReminderList({ reminders }: { reminders: SubscriptionReminderView[] }) {
  const { t, formatDateTime } = useTranslation()
  return (
    <div className="rounded-md border border-border bg-card">
      <h4 className="px-3 pt-3 text-sm font-semibold text-foreground">{t('platform.subs.reminders.title')}</h4>
      <ul className="divide-y divide-border">
        {reminders.map((reminder) => (
          <li
            key={`${reminder.dueAt}:${reminder.step}`}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="modern-badge">{t(REMINDER_STEP_KEYS[reminder.step])}</span>
              <span className="text-muted-foreground">{t('platform.subs.reminders.dueAt', { date: formatDay(reminder.dueAt) })}</span>
              <span className="text-muted-foreground">
                {reminder.channels
                  .map((canal) => (REMINDER_CHANNEL_KEYS[canal] ? t(REMINDER_CHANNEL_KEYS[canal]) : canal))
                  .join(' · ')}
              </span>
            </span>
            <span className="text-muted-foreground">{formatDateTime(reminder.sentAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

type ChargeDialogKind = 'settle' | 'dueDate' | 'amount' | 'cancelCharge' | 'reissue' | 'refund'

function ChargeItem({
  charge,
  context,
  onAction,
  onCopy,
  tenantId,
  onInvoiceQueued
}: {
  charge: ChargeConsoleView
  /** A linha decide parte das ações: gateway, prazo e estado da assinatura. */
  context: ChargeContext
  onAction: (kind: ChargeDialogKind) => void
  onCopy: (url: string) => void
  tenantId: number
  onInvoiceQueued: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const acoes = chargeActions(charge, context)
  const late = isChargeLate(charge)
  // A tentativa e o último erro vão no `title` e também visíveis: tooltip
  // sozinho não existe no celular, e é lá que se atende cobrança de manhã.
  const tentativas = charge.attempts > 0
    ? t('platform.subs.attempts', { count: charge.attempts })
    : null
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className={late && charge.status === 'pending' ? 'modern-badge-error' : chargeBadgeClass(charge.status)}>
          {late && charge.status === 'pending' ? t('charges.status.overdue') : t(CHARGE_STATUS_LABEL_KEYS[charge.status])}
        </span>
        <span className="font-mono font-semibold tabular-nums">{formatMoney(charge.amountCents, charge.currency)}</span>
        {/* A avulsa da subida no meio do período (a diferença proporcional). */}
        {charge.kind === 'proration' && <span className="modern-badge-info">{t('charges.proration')}</span>}
        {/* A de só excedente (0105): a fatia mensal do anual, ou a final de quem cancela. */}
        {charge.kind === 'overage' && <span className="modern-badge-info">{t('charges.overage')}</span>}
        <span className="text-muted-foreground">{t('charges.period')}: {formatDay(charge.periodEnd)}</span>
        <span className={late ? 'text-destructive' : 'text-muted-foreground'}>
          {t('charges.dueDate')}: {formatDay(charge.dueDate)}
        </span>
        {/* O plano e o excedente do período (0105), quando há excedente. */}
        <ChargePricingBreakdown pricing={charge.pricing} currency={charge.currency} className="w-full text-xs text-muted-foreground" />
        {tentativas && (
          <span
            className={charge.lastError ? 'cursor-help text-[hsl(var(--status-warning))]' : 'text-muted-foreground'}
            title={charge.lastError ?? undefined}
          >
            {tentativas}
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">
          {charge.provider}{charge.gatewayChargeId ? ` · ${charge.gatewayChargeId}` : ''}
        </span>
      </div>
      {charge.lastError && (
        <p className="text-xs text-destructive wrap-anywhere">
          {t('platform.subs.lastError', { error: charge.lastError })}
        </p>
      )}
      {/* A nota fiscal: só da cobrança paga, ou de qualquer uma que já tenha nota. */}
      {(charge.status === 'paid' || charge.invoice) && (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('nfse.column')}:</span>
          <InvoiceSummary invoice={charge.invoice} />
        </p>
      )}
      {charge.superseded.length > 0 && (
        <p
          className="text-xs text-muted-foreground"
          title={charge.superseded.map((s) => `${s.gatewayChargeId} · ${formatMoney(s.amountCents, charge.currency)}`).join('\n')}
        >
          {t('platform.subs.superseded', { count: charge.superseded.length })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {acoes.openInvoice && charge.invoiceUrl && (
          <a href={charge.invoiceUrl} target="_blank" rel="noopener noreferrer" className="modern-button-secondary">
            <Icon name="external" size={16} />
            {t('platform.subs.openInvoice')}
          </a>
        )}
        {acoes.copyLink && charge.invoiceUrl && (
          <button type="button" className="modern-button-secondary" onClick={() => onCopy(charge.invoiceUrl as string)}>
            <Icon name="copy" size={16} />
            {t('platform.subs.copyLink')}
          </button>
        )}
        {acoes.settle && (
          <button type="button" className="modern-button-secondary" onClick={() => onAction('settle')}>
            <Icon name="check" size={16} />
            {t('platform.subs.settle')}
          </button>
        )}
        {acoes.changeDueDate && (
          <button type="button" className="modern-button-secondary" onClick={() => onAction('dueDate')}>
            {t('platform.subs.changeDueDate')}
          </button>
        )}
        {acoes.changeAmount && (
          <button type="button" className="modern-button-secondary" onClick={() => onAction('amount')}>
            {t('platform.subs.changeAmount')}
          </button>
        )}
        {acoes.reissue && (
          <button type="button" className="modern-button-secondary" onClick={() => onAction('reissue')}>
            <Icon name="refresh" size={16} />
            {t('platform.subs.reissue')}
          </button>
        )}
        {acoes.cancel && (
          <button type="button" className="modern-button-secondary text-destructive" onClick={() => onAction('cancelCharge')}>
            <Icon name="x" size={16} />
            {t('platform.subs.cancelCharge')}
          </button>
        )}
        {canIssueInvoice(charge) && (
          <IssueInvoiceButton
            tenantId={tenantId}
            chargeId={charge.id}
            reissue={Boolean(charge.invoice)}
            onDone={onInvoiceQueued}
          />
        )}
        {acoes.refund && (
          <button type="button" className="modern-button-secondary text-destructive" onClick={() => onAction('refund')}>
            <Icon name="back" size={16} />
            {t('platform.subs.refund')}
          </button>
        )}
      </div>
    </li>
  )
}

// ── Os diálogos de cada ação ──

interface ActionDialogProps {
  tenantId: number
  onClose: () => void
  onDone: () => Promise<void>
}

function StatusDialog({ tenantId, status, onClose, onDone }: ActionDialogProps & { status: SubscriptionStatus }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const titulo = status === 'suspended'
    ? t('platform.subs.suspend')
    : status === 'canceled'
      ? t('platform.subs.cancelSubscription')
      : t('platform.subs.reactivate')

  const enviar = async () => {
    setBusy(true)
    try {
      const res = await platformAPI.updateSubscription(tenantId, { status, reason: reason.trim() || undefined })
      if (res.success) {
        toast.success(t('platform.subs.statusChanged'))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={titulo}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy}>
            {busy ? t('common.saving') : t('common.confirm')}
          </button>
        </>
      )}
    >
      {/* Suspender e cancelar tiram o provedor do ar: a frase é a mesma da aba
          de provedores, pelo mesmo motivo. */}
      {status !== 'active' && <p className="text-foreground">{t('platform.subscription.lockConfirm')}</p>}
      {status === 'active' && <p className="text-foreground">{t('platform.subscription.statusHint')}</p>}
      <Field label={t('platform.subscription.reason')}>
        {(id) => (
          <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className="modern-input w-full" maxLength={255} />
        )}
      </Field>
    </Dialog>
  )
}

function DeadlinesDialog({
  tenantId,
  subscription,
  onClose,
  onDone
}: ActionDialogProps & { subscription: NonNullable<SubscriptionRow['subscription']> }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [mode, setMode] = useState<'days' | 'date'>('days')
  const [days, setDays] = useState('7')
  const [renewsAt, setRenewsAt] = useState(dayInputValue(subscription.renewsAt))
  const [trialEndsAt, setTrialEndsAt] = useState(dayInputValue(subscription.trialEndsAt))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const mostraTeste = subscription.storedStatus === 'trial' || Boolean(subscription.trialEndsAt)

  const payload = (() => {
    const base = reason.trim() ? { reason: reason.trim() } : {}
    if (mode === 'days') {
      const n = parseExtendDays(days)
      return n === null ? null : { ...base, extendDays: n }
    }
    const mudou: { renewsAt?: string; trialEndsAt?: string } = {}
    const renova = renewsAt && renewsAt !== dayInputValue(subscription.renewsAt) ? endOfDayIso(renewsAt) : null
    const teste = mostraTeste && trialEndsAt && trialEndsAt !== dayInputValue(subscription.trialEndsAt)
      ? endOfDayIso(trialEndsAt)
      : null
    if (renova) mudou.renewsAt = renova
    if (teste) mudou.trialEndsAt = teste
    return Object.keys(mudou).length > 0 ? { ...base, ...mudou } : null
  })()

  const enviar = async () => {
    if (!payload) return
    setBusy(true)
    try {
      const res = await platformAPI.updateSubscriptionDeadlines(tenantId, payload)
      if (res.success) {
        toast.success(t('platform.subs.deadlinesSaved'))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('platform.subs.extend')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy || !payload}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </>
      )}
    >
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('platform.subs.extend')}>
        {(['days', 'date'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={mode === m ? 'modern-button' : 'modern-button-secondary'}
            onClick={() => setMode(m)}
          >
            {t(m === 'days' ? 'platform.subs.extendByDays' : 'platform.subs.extendToDate')}
          </button>
        ))}
      </div>
      {mode === 'days' ? (
        <Field label={t('platform.subs.extendDays')} hint={t('platform.subs.extendDaysHint')}>
          {(id) => (
            <input id={id} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="modern-input w-full" />
          )}
        </Field>
      ) : (
        <>
          <Field label={t('platform.subs.paidUntil')}>
            {(id) => (
              <input id={id} type="date" value={renewsAt} onChange={(e) => setRenewsAt(e.target.value)} className="modern-input w-full" />
            )}
          </Field>
          {mostraTeste && (
            <Field label={t('platform.subs.trialEnd')}>
              {(id) => (
                <input id={id} type="date" value={trialEndsAt} onChange={(e) => setTrialEndsAt(e.target.value)} className="modern-input w-full" />
              )}
            </Field>
          )}
        </>
      )}
      <Field label={t('platform.subscription.reason')}>
        {(id) => (
          <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className="modern-input w-full" maxLength={255} />
        )}
      </Field>
    </Dialog>
  )
}

function SettleDialog({ tenantId, charge, onClose, onDone }: ActionDialogProps & { charge: ChargeConsoleView }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [paidAt, setPaidAt] = useState(todayIso())
  const [amount, setAmount] = useState(centsToInput(charge.amountCents))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * As recusas que pedem uma decisão ficam NA TELA, não num toast: o que vem
   * depois delas é uma decisão sobre dinheiro, e um toast some antes de alguém
   * decidir.
   *
   * - `underpaid`: o valor digitado é menor que o cobrado.
   * - `already_recorded_underpaid`: um pagamento a menor já foi registrado
   *   nesta cobrança (pelo webhook ou por outra baixa); aceitar fecha com ele.
   * - `subscription_inactive`: a assinatura está suspensa ou cancelada.
   *
   * Cada "sim" vira uma bandeira que fica ligada nos reenvios seguintes: quem
   * aceitou o valor menor e depois esbarra na assinatura inativa não precisa
   * aceitar o valor de novo.
   */
  const [aviso, setAviso] = useState<
    | { kind: 'underpaid' | 'alreadyUnderpaid'; paid: number; expected: number }
    | { kind: 'inactive' }
    | null
  >(null)
  const [aceites, setAceites] = useState<{ allowUnderpayment?: boolean; force?: boolean }>({})
  const cents = parseAmountToCents(amount)

  const enviar = async (extra: { allowUnderpayment?: boolean; force?: boolean } = {}) => {
    if (cents === null || cents <= 0 || !paidAt) return
    const flags = { ...aceites, ...extra }
    setAceites(flags)
    setBusy(true)
    try {
      const res = await platformAPI.settleCharge(tenantId, charge.id, {
        paidAt,
        amountCents: cents,
        note: note.trim() || undefined,
        ...(flags.allowUnderpayment ? { allowUnderpayment: true } : {}),
        ...(flags.force ? { force: true } : {})
      })
      if (!res.success && (res.code === 'underpaid' || res.code === 'already_recorded_underpaid')
        && typeof res.expectedCents === 'number') {
        setAviso({
          kind: res.code === 'underpaid' ? 'underpaid' : 'alreadyUnderpaid',
          paid: res.paidCents ?? cents,
          expected: res.expectedCents
        })
        return
      }
      if (!res.success && res.code === 'subscription_inactive') {
        setAviso({ kind: 'inactive' })
        return
      }
      if (res.success) {
        // "Já estava quitada" e "quitei agora" são frases diferentes: é
        // dinheiro, e a diferença não pode depender de alguém reparar.
        if (res.data?.duplicate) toast.info(t('platform.subs.settleDuplicate'))
        else toast.success(t('platform.subs.settled'))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('platform.subs.settle')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button
            type="button"
            className="modern-button"
            onClick={() => void enviar()}
            disabled={busy || cents === null || cents <= 0 || !paidAt || aviso !== null}
          >
            {busy ? t('common.saving') : t('platform.subs.settleConfirm')}
          </button>
        </>
      )}
    >
      <p className="text-muted-foreground">
        {t('platform.subs.chargeOf', { amount: formatMoney(charge.amountCents, charge.currency), date: formatDay(charge.dueDate) })}
      </p>
      <Field label={t('platform.subs.paidAt')}>
        {(id) => (
          <input id={id} type="date" max={todayIso()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="modern-input w-full" />
        )}
      </Field>
      <Field label={t('platform.subs.paidAmount')} hint={cents === null && amount.trim() !== '' ? t('platform.subscription.amountInvalid') : undefined}>
        {(id) => (
          <input
            id={id}
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setAviso(null); setAceites({}) }}
            className="modern-input w-full"
            inputMode="decimal"
          />
        )}
      </Field>
      <Field label={t('platform.subs.note')}>
        {(id) => (
          <input id={id} value={note} onChange={(e) => setNote(e.target.value)} className="modern-input w-full" maxLength={255} />
        )}
      </Field>
      {aviso !== null && aviso.kind !== 'inactive' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" role="alert">
          <p className="text-foreground">
            {aviso.kind === 'underpaid'
              ? t('platform.subscription.underpaid', {
                paid: formatMoney(aviso.paid, charge.currency),
                expected: formatMoney(aviso.expected, charge.currency)
              })
              : t('platform.subs.alreadyRecordedUnderpaid', {
                paid: formatMoney(aviso.paid, charge.currency),
                expected: formatMoney(aviso.expected, charge.currency)
              })}
          </p>
          <p className="field-hint">{t('platform.subs.underpaidHint')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="modern-button-secondary"
              disabled={busy}
              onClick={() => void enviar({ allowUnderpayment: true })}
            >
              {t(aviso.kind === 'underpaid' ? 'platform.subs.confirmAnyway' : 'platform.subs.acceptUnderpayment')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => setAviso(null)}>
              {t('common.back')}
            </button>
          </div>
        </div>
      )}
      {aviso?.kind === 'inactive' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" role="alert">
          <p className="text-foreground">{t('platform.subs.subscriptionInactive')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void enviar({ force: true })}>
              {t('platform.subs.settleAnyway')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => setAviso(null)}>
              {t('common.back')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function DueDateDialog({ tenantId, charge, onClose, onDone }: ActionDialogProps & { charge: ChargeConsoleView }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const hoje = todayIso()
  const atual = dayKeySaoPaulo(charge.dueDate)
  const [dueDate, setDueDate] = useState(atual && atual >= hoje ? atual : hoje)
  const [busy, setBusy] = useState(false)
  const valido = Boolean(dueDate) && dueDate >= hoje && dueDate !== atual

  const enviar = async () => {
    if (!valido) return
    setBusy(true)
    try {
      const res = await platformAPI.updateCharge(tenantId, charge.id, { dueDate })
      if (res.success) {
        toast.success(t('platform.subs.dueDateChanged'))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('platform.subs.changeDueDate')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy || !valido}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </>
      )}
    >
      <Field label={t('charges.dueDate')} hint={t('platform.subs.dueDateHint')}>
        {(id) => (
          <input id={id} type="date" min={hoje} value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="modern-input w-full" />
        )}
      </Field>
    </Dialog>
  )
}

function AmountDialog({ tenantId, charge, onClose, onDone }: ActionDialogProps & { charge: ChargeConsoleView }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [mode, setMode] = useState<AmountMode>('discountAmount')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const resultado = input.trim() === '' ? null : computeChargeAmount(charge.amountCents, mode, input)
  const novo = resultado?.ok ? resultado.amountCents : null
  const valido = novo !== null && novo !== charge.amountCents

  const enviar = async () => {
    if (!valido || novo === null) return
    setBusy(true)
    try {
      const res = await platformAPI.updateCharge(tenantId, charge.id, { amountCents: novo })
      if (res.success) {
        toast.success(t('platform.subs.amountChanged', { amount: formatMoney(novo, charge.currency) }))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  const rotulos: Record<AmountMode, Parameters<typeof t>[0]> = {
    value: 'platform.subs.amountModeValue',
    discountAmount: 'platform.subs.amountModeDiscount',
    discountPercent: 'platform.subs.amountModePercent'
  }

  return (
    <Dialog
      title={t('platform.subs.changeAmount')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy || !valido}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </>
      )}
    >
      <p className="text-muted-foreground">
        {t('platform.subs.currentAmount', { amount: formatMoney(charge.amountCents, charge.currency) })}
      </p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('platform.subs.changeAmount')}>
        {(['value', 'discountAmount', 'discountPercent'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={mode === m ? 'modern-button' : 'modern-button-secondary'}
            onClick={() => { setMode(m); setInput('') }}
          >
            {t(rotulos[m])}
          </button>
        ))}
      </div>
      <Field label={t(rotulos[mode])}>
        {(id) => (
          <input
            id={id}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="modern-input w-full"
            inputMode="decimal"
            placeholder={mode === 'discountPercent' ? '10' : '19,90'}
          />
        )}
      </Field>
      <p aria-live="polite" className={resultado && !resultado.ok ? 'text-destructive' : 'text-foreground'}>
        {resultado === null
          ? null
          : resultado.ok
            ? t('platform.subs.amountPreview', {
              from: formatMoney(charge.amountCents, charge.currency),
              to: formatMoney(resultado.amountCents, charge.currency)
            })
            : t(resultado.reason === 'nonPositive' ? 'platform.subs.amountNonPositive' : 'platform.subscription.amountInvalid')}
      </p>
      <p className="field-hint">{t('platform.subs.amountHint')}</p>
    </Dialog>
  )
}

function CancelChargeDialog({ tenantId, charge, onClose, onDone }: ActionDialogProps & { charge: ChargeConsoleView }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const enviar = async () => {
    setBusy(true)
    try {
      const res = await platformAPI.cancelCharge(tenantId, charge.id, { reason: reason.trim() || undefined })
      if (res.success) {
        toast.success(t('platform.subs.chargeCanceled'))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('platform.subs.cancelCharge')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.back')}</button>
          <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy}>
            {busy ? t('common.saving') : t('platform.subs.cancelChargeConfirm')}
          </button>
        </>
      )}
    >
      <p className="text-foreground">
        {t('platform.subs.cancelChargeText', { amount: formatMoney(charge.amountCents, charge.currency), date: formatDay(charge.dueDate) })}
      </p>
      <Field label={t('platform.subscription.reason')}>
        {(id) => (
          <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className="modern-input w-full" maxLength={255} />
        )}
      </Field>
    </Dialog>
  )
}

function ReissueDialog({ tenantId, charge, onClose, onDone }: ActionDialogProps & { charge: ChargeConsoleView }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [busy, setBusy] = useState(false)

  const enviar = async () => {
    setBusy(true)
    try {
      const res = await platformAPI.reissueCharge(tenantId, charge.id)
      if (res.success) {
        toast.success(t('platform.subs.reissued'))
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('platform.subs.reissue')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy}>
            {busy ? t('common.saving') : t('common.confirm')}
          </button>
        </>
      )}
    >
      <p className="text-foreground">
        {t('platform.subs.reissueText', { amount: formatMoney(charge.amountCents, charge.currency), date: formatDay(charge.periodEnd) })}
      </p>
    </Dialog>
  )
}

function RefundDialog({
  tenantId,
  charge,
  renewsAt,
  periodDays,
  onClose,
  onDone
}: ActionDialogProps & { charge: ChargeConsoleView; renewsAt: string | null; periodDays: number }) {
  const { t } = useTranslation()
  const toast = useToast()
  const recusa = useRefusal()
  const [reason, setReason] = useState('')
  const [outsideGateway, setOutsideGateway] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * A recusa do gateway fica NA TELA, com o texto dele: o caminho de saída é
   * estornar lá e marcar a caixa, e isso não cabe num toast que some.
   */
  const [falhaGateway, setFalhaGateway] = useState<string | null>(null)
  /**
   * Aqui paga, lá em outro estado: o gateway não tem o que estornar. Fica na
   * tela pelo mesmo motivo da recusa acima — a saída é conferir lá e, se o
   * dinheiro já voltou por fora, marcar a caixa.
   */
  const [statusGateway, setStatusGateway] = useState<string | null>(null)
  const previa = refundPreview(renewsAt, periodDays)
  // Quem cobrou é quem estorna: o provider da cobrança, não o de hoje do
  // provedor. Sem id lá, ou emitida à mão, não há gateway a chamar — o dinheiro
  // volta por fora e o painel só registra.
  const badge = gatewayBadge({ gateway: charge.provider, linked: true })
  const viaGateway = badge.kind !== 'manual' && Boolean(charge.gatewayChargeId)
  const gateway = badge.kind === 'manual' ? '' : badge.name

  const enviar = async () => {
    setBusy(true)
    try {
      const res = await platformAPI.refundCharge(tenantId, charge.id, {
        reason: reason.trim() || undefined,
        ...(viaGateway && outsideGateway ? { outsideGateway: true } : {})
      })
      if (!res.success && res.code === 'gateway_failed') {
        setFalhaGateway(res.detail || '')
        setStatusGateway(null)
        return
      }
      if (!res.success && res.code === 'not_paid') {
        if (res.gatewayStatus) {
          setStatusGateway(res.gatewayStatus)
          setFalhaGateway(null)
          return
        }
        // Não está mais paga do lado de cá: a linha mudou, recarrega.
        toast.error(recusa(res))
        onClose()
        await onDone()
        return
      }
      if (res.success) {
        // "Já estava estornada" e "estornei agora" são frases diferentes, como
        // na baixa: é dinheiro, e a diferença não pode depender de alguém reparar.
        if (res.data?.alreadyRefunded) {
          toast.info(t('platform.subs.refundAlready'))
        } else {
          toast.success(t('platform.subs.refunded', {
            from: formatDay(res.data?.renewsAtBefore),
            to: formatDay(res.data?.renewsAtAfter)
          }))
        }
        onClose()
        await onDone()
      } else {
        toast.error(recusa(res))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('platform.subs.refund')}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.back')}</button>
          <button type="button" className="modern-button-danger" onClick={() => void enviar()} disabled={busy}>
            {busy ? t('common.saving') : t('platform.subs.refundConfirm')}
          </button>
        </>
      )}
    >
      <p className="text-foreground">
        {t('platform.subs.refundText', { date: formatDay(charge.periodEnd) })}
      </p>
      <Field label={t('platform.subs.refundAmount')} hint={t('platform.subs.refundAmountHint')}>
        {(id) => (
          <input
            id={id}
            value={formatMoney(charge.amountCents, charge.currency)}
            readOnly
            className="modern-input w-full font-mono tabular-nums"
          />
        )}
      </Field>
      <Field label={t('platform.subscription.reason')}>
        {(id) => (
          <textarea
            id={id}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="modern-input w-full"
            rows={2}
            maxLength={255}
          />
        )}
      </Field>
      {renewsAt && (
        <p className="text-foreground">
          {previa
            ? t('platform.subs.refundPreview', { from: formatDay(renewsAt), to: formatDay(previa.renewsAt) })
            : `${t('platform.subs.paidUntil')}: ${formatDay(renewsAt)}`}
        </p>
      )}
      {previa?.past && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" role="alert">
          <p className="text-foreground">{t('platform.subs.refundPastWarning')}</p>
        </div>
      )}
      {viaGateway ? (
        <label className="flex items-start gap-2 text-foreground">
          <input
            type="checkbox"
            className="mt-1"
            checked={outsideGateway}
            onChange={(e) => { setOutsideGateway(e.target.checked); setFalhaGateway(null); setStatusGateway(null) }}
          />
          <span>{t('platform.subs.refundOutside', { gateway })}</span>
        </label>
      ) : (
        <p className="field-hint">{t('platform.subs.refundManualHint')}</p>
      )}
      {falhaGateway !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3" role="alert">
          <p className="text-foreground wrap-anywhere">
            {falhaGateway
              ? t('platform.subs.refundGatewayFailed', { gateway, detail: falhaGateway })
              : t('platform.subs.err.gatewayFailed')}
          </p>
          <p className="field-hint">{t('platform.subs.refundGatewayHint', { gateway })}</p>
        </div>
      )}
      {statusGateway !== null && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" role="alert">
          <p className="text-foreground wrap-anywhere">
            {t('platform.subs.refundGatewayStatus', { gateway: gateway || charge.provider, status: statusGateway })}
          </p>
          {viaGateway && <p className="field-hint">{t('platform.subs.refundGatewayStatusHint', { gateway })}</p>}
        </div>
      )}
    </Dialog>
  )
}
