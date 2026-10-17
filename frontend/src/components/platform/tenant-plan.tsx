'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import {
  platformAPI,
  platformReportsAPI,
  type BillingEventView,
  type Plan,
  type SubscriptionStatus,
  type SubscriptionUsage,
  type SubscriptionView,
  type Tenant
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { parseAmountToCents } from '@/lib/utils'
import { formatMoney } from '@/lib/money'
import { InvoiceSummary, IssueInvoiceButton } from '@/components/platform/charge-invoice'
import { canIssueInvoiceForEvent } from '@/lib/invoice'
import { useTranslation } from '@/contexts/language-context'
import { displayDate, displayDayMonth } from '@/lib/date-format'
import { exemptUntilFromDateInput, todayIso, toIsoDay } from '@/lib/subscription-console'
import { CouponBadge, CouponControl } from '@/components/platform/coupon-control'
import { CardBadge } from '@/components/card-badge'
import { TenantReferrals } from '@/components/platform/tenant-referrals'

interface Props {
  tenant: Tenant
  plans: Plan[]
  /** The list row shows the plan and the state; both change here. */
  onSubscriptionChange: () => void
}

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['trial', 'active', 'past_due', 'suspended', 'canceled']

/** The i18n key for each state — shared with the block screen and the list. */
export const STATUS_LABEL_KEYS = {
  trial: 'platform.subscription.trial',
  active: 'platform.subscription.active',
  past_due: 'platform.subscription.pastDue',
  suspended: 'platform.subscription.suspended',
  canceled: 'platform.subscription.canceled'
} as const

/**
 * O rótulo do estado, com a suspensão automática por inadimplência (0102)
 * separada da suspensão à mão: a primeira sai pagando, a segunda só pelo console.
 */
export function statusLabelKey(subscription: { status: SubscriptionStatus; suspendedReason?: string | null }) {
  if (subscription.status === 'suspended' && subscription.suspendedReason === 'auto_nonpayment') {
    return 'platform.subscription.suspendedNonpayment' as const
  }
  return STATUS_LABEL_KEYS[subscription.status]
}

/** A data de renovação já passou? Nulo e data inválida não venceram. */
function expirou(value: string | null | undefined) {
  if (!value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now()
}

export function statusBadgeClass(status: SubscriptionStatus | null | undefined) {
  if (status === 'active' || status === 'trial') return 'modern-badge-success'
  if (status === 'past_due') return 'modern-badge-warning'
  return 'modern-badge-error'
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  return displayDate(value) ?? '—'
}

/** O que o interruptor de isenção lê da assinatura — a do painel e a da linha da aba Assinaturas. */
export interface BillingExemptSubscription {
  storedStatus: SubscriptionStatus
  billingExempt?: boolean
  billingExemptSince?: string | null
  billingExemptReason?: string | null
  billingExemptUntil?: string | null
}

/** O selo "Isento até dd/mm" — ou nulo quando a isenção não tem data de fim. */
export function exemptUntilLabel(
  subscription: { billingExempt?: boolean; billingExemptUntil?: string | null } | null | undefined,
  t: (key: 'platform.subscription.exempt.untilBadge', vars: { date: string }) => string
): string | null {
  if (subscription?.billingExempt !== true || !subscription.billingExemptUntil) return null
  const date = displayDayMonth(subscription.billingExemptUntil)
  return date ? t('platform.subscription.exempt.untilBadge', { date }) : null
}

/**
 * Os selos da retenção no cancelamento (0107): "Cancela em dd/mm" (o
 * cancelamento agendado pelo próprio provedor) e "Pausada até dd/mm". Nada
 * quando não há nenhum dos dois.
 */
export function RetentionBadges({ subscription }: {
  subscription: { cancelAt?: string | null; pausedUntil?: string | null } | null | undefined
}) {
  const { t } = useTranslation()
  const cancela = displayDayMonth(subscription?.cancelAt)
  const pausada = displayDayMonth(subscription?.pausedUntil)
  return (
    <>
      {cancela && <span className="modern-badge-warning">{t('platform.subs.cancelsOn', { date: cancela })}</span>}
      {pausada && <span className="modern-badge-info">{t('platform.subs.pausedUntil', { date: pausada })}</span>}
    </>
  )
}

/**
 * O console desfaz o cancelamento agendado de um provedor (0107): a cobrança
 * volta normalmente, e a fatura que o agendamento cancelou é reaberta.
 */
export function RevertCancellationButton({ tenantId, cancelAt, onChanged }: {
  tenantId: number
  cancelAt: string | null | undefined
  onChanged: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!cancelAt) return null
  const desfazer = async () => {
    if (!window.confirm(t('platform.subscription.revertCancelConfirm', { date: formatDate(cancelAt) }))) return
    setBusy(true)
    try {
      const res = await platformReportsAPI.revertCancellation(tenantId)
      if (res.success) {
        toast.success(t('platform.subscription.cancelReverted'))
        await onChanged()
      } else {
        toast.error(res.message || t('platform.subscription.revertCancelFailed'))
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void desfazer()}>
      {busy ? t('common.saving') : t('platform.subscription.revertCancel')}
    </button>
  )
}

/**
 * "Isento de cobrança": a assinatura fica ativa, não vence e não gera fatura
 * até alguém desligar. Ligar e desligar passam pelos dois por uma confirmação —
 * ligar cancela as cobranças abertas no gateway, desligar volta a cobrar.
 *
 * O interruptor não muda sozinho: ele mostra o que o servidor diz, e só depois
 * da resposta (e da recarga) é que passa para o outro lado.
 */
export function BillingExemptControl({
  tenantId,
  subscription,
  onChanged
}: {
  tenantId: number
  subscription: BillingExemptSubscription | null
  onChanged: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const switchId = useId()
  const titleId = useId()
  const reasonId = useId()
  const untilId = useId()
  const untilHintId = useId()
  const [confirming, setConfirming] = useState<boolean | null>(null)
  const [reason, setReason] = useState('')
  const [untilDay, setUntilDay] = useState('')
  const [busy, setBusy] = useState(false)
  // Já isento: mudar (ou tirar) só a data de fim, sem desligar e religar.
  const editUntilId = useId()
  const noEndId = useId()
  const [editingUntil, setEditingUntil] = useState(false)
  const [newUntilDay, setNewUntilDay] = useState('')
  const [noEnd, setNoEnd] = useState(false)

  const exempt = subscription?.billingExempt === true
  // Cancelada não tem o que isentar (o backend responde `not_billable`); a
  // isenção já ligada pode sempre ser desligada.
  const disabled = !subscription || (!exempt && subscription.storedStatus === 'canceled')

  const fechar = useCallback(() => {
    setConfirming(null)
    setReason('')
    setUntilDay('')
  }, [])

  useEffect(() => {
    if (confirming === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) fechar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming, busy, fechar])

  const enviar = async () => {
    if (confirming === null) return
    // A data de fim só existe ao ligar; vazia é "até alguém desligar".
    const until = confirming ? exemptUntilFromDateInput(untilDay) : null
    if (until === undefined) {
      toast.error(t('platform.subscription.exempt.untilInvalid'))
      return
    }
    setBusy(true)
    try {
      const res = await platformAPI.setBillingExempt(tenantId, {
        exempt: confirming,
        reason: reason.trim() || undefined,
        ...(until ? { until } : {})
      })
      if (res.success && res.data) {
        const canceled = res.data.canceledCharges ?? 0
        const failed = res.data.failedCharges ?? 0
        if (!confirming) toast.success(t('platform.subscription.exempt.disabled'))
        else if (canceled > 0) toast.success(t('platform.subscription.exempt.enabledCanceled', { count: canceled }))
        else toast.success(t('platform.subscription.exempt.enabled'))
        // As que o gateway não cancelou continuam vivas lá: quem ligou precisa
        // saber, e o agendador tenta cancelá-las de novo.
        if (confirming && failed > 0) toast.warning(t('platform.subscription.exempt.chargesLeftOpen', { count: failed }))
        fechar()
        await onChanged()
      } else if (res.code === 'not_billable') {
        toast.error(t('platform.subscription.exempt.notBillable'))
      } else if (res.code === 'invalid_until') {
        toast.error(t('platform.subscription.exempt.untilInvalid'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const abrirData = () => {
    // O dia no fuso de quem vê, o mesmo em que `exemptUntilFromDateInput` lê
    // o campo (a data de fim é o fim do dia escolhido).
    const ate = subscription?.billingExemptUntil ? new Date(subscription.billingExemptUntil) : null
    setNewUntilDay(ate && !Number.isNaN(ate.getTime()) ? toIsoDay(ate) : '')
    setNoEnd(!subscription?.billingExemptUntil)
    setEditingUntil(true)
  }

  const salvarData = async () => {
    const until = noEnd ? null : exemptUntilFromDateInput(newUntilDay)
    // Sem a caixa "sem data de fim", um dia é obrigatório (vazio seria tirar a data sem dizer).
    if (until === undefined || (!noEnd && until === null)) {
      toast.error(t('platform.subscription.exempt.untilInvalid'))
      return
    }
    setBusy(true)
    try {
      const res = await platformAPI.setBillingExempt(tenantId, { exempt: true, until })
      if (res.success && res.data) {
        toast.success(t('platform.subscription.exempt.untilUpdated'))
        setEditingUntil(false)
        await onChanged()
      } else if (res.code === 'invalid_until') {
        toast.error(t('platform.subscription.exempt.untilInvalid'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <label htmlFor={switchId} className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
        <input
          id={switchId}
          type="checkbox"
          role="switch"
          className="mt-0.5"
          checked={exempt}
          aria-checked={exempt}
          disabled={disabled || busy}
          // Controlado pelo servidor: o clique só abre a confirmação.
          onChange={() => setConfirming(!exempt)}
        />
        <span className="font-medium text-foreground">{t('platform.subscription.exempt.toggle')}</span>
      </label>
      {exempt && (
        <div className="mt-2 space-y-1 text-sm">
          <span className="modern-badge-info">
            {subscription?.billingExemptSince
              ? t('platform.subscription.exempt.since', { date: formatDate(subscription.billingExemptSince) })
              : t('platform.subs.exempt')}
          </span>
          {exemptUntilLabel(subscription, t) && (
            <span className="modern-badge-info ml-1">{exemptUntilLabel(subscription, t)}</span>
          )}
          {subscription?.billingExemptReason && (
            <p className="text-muted-foreground wrap-anywhere">{subscription.billingExemptReason}</p>
          )}
          {!editingUntil ? (
            <button
              type="button"
              className="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
              onClick={abrirData}
              disabled={busy}
            >
              {t('platform.subscription.exempt.changeUntil')}
            </button>
          ) : (
            <div className="mt-2 space-y-2 rounded-md border border-border p-3">
              <label htmlFor={editUntilId} className="block text-sm font-medium">
                {t('platform.subscription.exempt.until')}
              </label>
              <input
                id={editUntilId}
                type="date"
                value={noEnd ? '' : newUntilDay}
                min={todayIso()}
                disabled={noEnd || busy}
                onChange={(e) => setNewUntilDay(e.target.value)}
                className="modern-input w-full"
              />
              <label htmlFor={noEndId} className="flex items-center gap-2 text-sm">
                <input
                  id={noEndId}
                  type="checkbox"
                  checked={noEnd}
                  disabled={busy}
                  onChange={(e) => setNoEnd(e.target.checked)}
                />
                {t('platform.subscription.exempt.noEnd')}
              </label>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="modern-button-secondary"
                  onClick={() => setEditingUntil(false)}
                  disabled={busy}
                >
                  {t('common.cancel')}
                </button>
                <button type="button" className="modern-button" onClick={() => void salvarData()} disabled={busy}>
                  {busy ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {confirming !== null && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="modal-panel modern-card flex max-w-lg flex-col">
            <div className="border-b border-border p-5">
              <h3 id={titleId} className="text-lg font-semibold text-foreground">
                {t(confirming ? 'platform.subscription.exempt.enableTitle' : 'platform.subscription.exempt.disableTitle')}
              </h3>
            </div>
            <div className="space-y-3 p-5 text-sm">
              <p className="text-foreground">
                {t(confirming ? 'platform.subscription.exempt.enableWarning' : 'platform.subscription.exempt.disableWarning')}
              </p>
              {/* Ligar a isenção de quem está suspenso o reativa ("manter
                  ativo"): dito com todas as letras antes do clique. */}
              {confirming && subscription?.storedStatus === 'suspended' && (
                <p className="font-medium text-[hsl(var(--status-warning))]">
                  {t('platform.subscription.exempt.reactivatesSuspended')}
                </p>
              )}
              <div>
                <label htmlFor={reasonId} className="mb-1 block text-sm font-medium">
                  {t('platform.subscription.exempt.reason')}
                </label>
                <textarea
                  id={reasonId}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="modern-input w-full"
                  rows={3}
                  maxLength={255}
                />
              </div>
              {confirming && (
                <div>
                  <label htmlFor={untilId} className="mb-1 block text-sm font-medium">
                    {t('platform.subscription.exempt.until')}
                  </label>
                  <input
                    id={untilId}
                    type="date"
                    value={untilDay}
                    min={todayIso()}
                    onChange={(e) => setUntilDay(e.target.value)}
                    className="modern-input w-full"
                    aria-describedby={untilHintId}
                  />
                  <p id={untilHintId} className="mt-1 text-xs text-muted-foreground">
                    {t('platform.subscription.exempt.untilHint')}
                  </p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border p-5">
              <button type="button" className="modern-button-secondary" onClick={fechar} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button type="button" className="modern-button" onClick={() => void enviar()} disabled={busy}>
                {busy ? t('common.saving') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The commercial half of one provider's row: which plan, which state, the
 * payment we record by hand, and usage against the limits.
 *
 * Plan and state are two separate saves on purpose. Changing the plan of a
 * provider in `past_due` must not quietly reactivate it, and reactivating must
 * not quietly change what it pays for — each is its own line on the statement
 * and its own line in both audit trails, and the two buttons say so.
 */
export function TenantPlan({ tenant, plans, onSubscriptionChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [subscription, setSubscription] = useState<SubscriptionView | null>(null)
  const [planId, setPlanId] = useState<number | null>(null)
  const [events, setEvents] = useState<BillingEventView[]>([])
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'plan' | 'status' | 'payment' | null>(null)

  const [chosenPlan, setChosenPlan] = useState<number | ''>('')
  const [chosenStatus, setChosenStatus] = useState<SubscriptionStatus>('active')
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')

  const tenantId = tenant.id

  const load = useCallback(async () => {
    setLoading(true)
    const [sub, use] = await Promise.all([
      platformAPI.getSubscription(tenantId),
      platformAPI.getUsage(tenantId)
    ])
    if (sub.success && sub.data) {
      setSubscription(sub.data.subscription)
      setPlanId(sub.data.planId)
      setEvents(sub.data.events)
      setChosenPlan(sub.data.planId ?? '')
      setChosenStatus(sub.data.subscription?.storedStatus ?? 'active')
      setError(null)
    } else {
      setError(sub.message || '')
    }
    setUsage(use.success && use.data ? use.data : null)
    setLoading(false)
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  const savePlan = async () => {
    if (chosenPlan === '' || chosenPlan === planId) return
    setSaving('plan')
    try {
      const res = await platformAPI.updateSubscription(tenantId, { planId: Number(chosenPlan) })
      if (res.success) {
        await load()
        onSubscriptionChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(null)
    }
  }

  const saveStatus = async () => {
    if (chosenStatus === subscription?.storedStatus) return
    // Suspending and canceling are the two that lock people out; both are asked
    // about, with the same words the provider switch uses for the same reason.
    if ((chosenStatus === 'suspended' || chosenStatus === 'canceled')
      && !window.confirm(t('platform.subscription.lockConfirm'))) return
    setSaving('status')
    try {
      const res = await platformAPI.updateSubscription(tenantId, {
        status: chosenStatus,
        reason: reason.trim() || undefined
      })
      if (res.success) {
        setReason('')
        await load()
        onSubscriptionChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(null)
    }
  }

  /**
   * O 409 que o backend devolve quando o valor não fecha, guardado para a tela
   * poder dizer QUANTO falta e oferecer o caminho de insistir.
   *
   * Não é um toast: um toast some, e o que vem depois dele é uma decisão sobre
   * dinheiro. Fica na tela até alguém resolver.
   */
  const [underpayment, setUnderpayment] = useState<{ paid: number; expected: number } | null>(null)

  /** Uma fonte só para a moeda: o envio e o aviso têm que dizer a mesma coisa. */
  const moedaDoPlano = plans.find((p) => p.id === planId)?.currency || 'BRL'

  const savePayment = async (force = false) => {
    // Digitado em reais com vírgula ou ponto; guardado em centavos, inteiro.
    // `parseAmountToCents` recusa o ambíguo em vez de adivinhar — ver o porquê
    // lá, que envolve "1.234" ter virado 123 centavos em silêncio.
    const parsed = parseAmountToCents(amount)
    if (parsed === null) {
      toast.error(t('platform.subscription.amountInvalid'))
      return
    }
    setSaving('payment')
    try {
      const res = await platformAPI.recordPayment(tenantId, {
        amountCents: parsed,
        currency: moedaDoPlano,
        reference: reference.trim() || undefined,
        ...(force ? { allowUnderpayment: true } : {})
      })
      // O valor não fecha com o que foi cobrado. Os dois números vêm do
      // servidor de propósito — quanto foi pedido é conta dele, e refazê-la
      // aqui seria a segunda cópia da regra.
      if (!res.success && res.code === 'underpaid' && typeof res.expectedCents === 'number') {
        setUnderpayment({ paid: res.paidCents ?? parsed, expected: res.expectedCents })
        return
      }
      if (res.success) {
        setAmount('')
        setReference('')
        setUnderpayment(null)
        await load()
        onSubscriptionChange()
        // O backend recusa a referência repetida corretamente — 200, nada
        // creditado, `duplicate: true` — e a tela não dizia nada. Sem aviso
        // nenhum, reenviar uma referência produzia exatamente a mesma cena de
        // um pagamento aceito: campos limpos, extrato recarregado. Quem
        // administra concluía que estendeu o período pago e não estendeu.
        //
        // Os dois casos passam a ter cada um a sua frase. É dinheiro: a
        // diferença entre "creditei" e "isto já estava creditado" não pode
        // depender de o operador reparar que o extrato não cresceu.
        if (res.data?.duplicate) toast.info(t('platform.subscription.paymentDuplicate'))
        else toast.success(t('platform.subscription.paymentRecorded'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(null)
    }
  }

  const limitText = (used: number | null, limit: number | null) => {
    if (used === null) return t('platform.subscription.uncounted')
    return limit === null ? `${used} / ∞` : `${used} / ${limit}`
  }

  if (loading) return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>
  if (error !== null) return <p className="py-3 text-sm text-destructive">{error || t('platform.loadFailed')}</p>

  return (
    <div className="space-y-4 py-3">
      <h3 className="font-semibold text-foreground">{t('platform.subscription.title')}</h3>

      {subscription && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={statusBadgeClass(subscription.status)}>
            {t(statusLabelKey(subscription))}
          </span>
          {subscription.billingExempt && (
            <span className="modern-badge-info">{exemptUntilLabel(subscription, t) ?? t('platform.subs.exempt')}</span>
          )}
          {subscription.coupon && <CouponBadge coupon={subscription.coupon} currency={moedaDoPlano} />}
          <CardBadge card={subscription.card} />
          <RetentionBadges subscription={subscription} />
          <RevertCancellationButton
            tenantId={tenantId}
            cancelAt={subscription.cancelAt}
            onChanged={async () => {
              await load()
              onSubscriptionChange()
            }}
          />
          {subscription.reason === 'trial_expired' && (
            <span className="text-muted-foreground">{t('platform.subscription.trialExpiredNote')}</span>
          )}
          {subscription.reason === 'renewal_expired' && (
            <span className="text-muted-foreground">{t('platform.subscription.renewalExpiredNote')}</span>
          )}
          {subscription.reason === 'proration_overdue' && (
            <span className="text-muted-foreground">{t('platform.subscription.prorationOverdueNote')}</span>
          )}
          {subscription.trialEndsAt && subscription.storedStatus === 'trial' && (
            <span className="text-muted-foreground">
              {t('platform.subscription.trialEnds', { date: formatDate(subscription.trialEndsAt) })}
            </span>
          )}
          {subscription.renewsAt && !subscription.billingExempt && (
            <span className="text-muted-foreground">
              {t(
                expirou(subscription.renewsAt)
                  ? 'platform.subscription.renewsExpired'
                  : 'platform.subscription.renews',
                { date: formatDate(subscription.renewsAt) }
              )}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Plano */}
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.plan')}</h4>
          <select
            value={chosenPlan}
            onChange={(e) => setChosenPlan(e.target.value === '' ? '' : Number(e.target.value))}
            className="modern-input w-full"
            aria-label={t('platform.subscription.plan')}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id} disabled={!plan.active && plan.id !== planId}>
                {plan.name} ({plan.code}){plan.active ? '' : ` — ${t('platform.plans.inactive')}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void savePlan()}
            disabled={saving !== null || chosenPlan === '' || chosenPlan === planId}
            className="modern-button mt-2"
          >
            {saving === 'plan' ? t('common.saving') : t('platform.subscription.changePlan')}
          </button>
          <CouponControl
            tenantId={tenantId}
            coupon={subscription?.coupon}
            currency={moedaDoPlano}
            storedStatus={subscription?.storedStatus}
            onChanged={async () => {
              await load()
              onSubscriptionChange()
            }}
          />
        </div>

        {/* Estado */}
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('common.status')}</h4>
          <select
            value={chosenStatus}
            onChange={(e) => setChosenStatus(e.target.value as SubscriptionStatus)}
            className="modern-input w-full"
            aria-label={t('common.status')}
          >
            {SUBSCRIPTION_STATUSES.map((status) => (
              <option key={status} value={status}>{t(STATUS_LABEL_KEYS[status])}</option>
            ))}
          </select>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="modern-input mt-2 w-full"
            placeholder={t('platform.subscription.reason')}
            aria-label={t('platform.subscription.reason')}
            maxLength={255}
          />
          <button
            type="button"
            onClick={() => void saveStatus()}
            disabled={saving !== null || chosenStatus === subscription?.storedStatus}
            className="modern-button mt-2"
          >
            {saving === 'status' ? t('common.saving') : t('platform.subscription.changeStatus')}
          </button>
          <p className="field-hint">{t('platform.subscription.statusHint')}</p>
          <BillingExemptControl
            tenantId={tenantId}
            subscription={subscription}
            onChanged={async () => {
              await load()
              onSubscriptionChange()
            }}
          />
        </div>

        {/* Pagamento */}
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.payment')}</h4>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="modern-input w-full"
            placeholder={t('platform.subscription.amount')}
            aria-label={t('platform.subscription.amount')}
            inputMode="decimal"
          />
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="modern-input mt-2 w-full"
            placeholder={t('platform.subscription.reference')}
            aria-label={t('platform.subscription.reference')}
            maxLength={128}
          />
          {underpayment !== null && (
            <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              <p className="text-sm text-foreground">
                {t('platform.subscription.underpaid')
                  .replace('{paid}', formatMoney(underpayment.paid, moedaDoPlano))
                  .replace('{expected}', formatMoney(underpayment.expected, moedaDoPlano))}
              </p>
              <p className="field-hint">{t('platform.subscription.underpaidHint')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void savePayment(true)}
                  disabled={saving !== null}
                  className="modern-button-secondary"
                >
                  {t('platform.subscription.underpaidConfirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setUnderpayment(null)}
                  disabled={saving !== null}
                  className="modern-button-secondary"
                >
                  {t('platform.subscription.underpaidCancel')}
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void savePayment()}
            disabled={saving !== null || amount.trim() === ''}
            className="modern-button mt-2"
          >
            {saving === 'payment' ? t('common.saving') : t('platform.subscription.recordPayment')}
          </button>
          <p className="field-hint">{t('platform.subscription.paymentHint')}</p>
        </div>
      </div>

      {/* Uso */}
      {usage && (
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.subscription.usage')}</h4>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            {([
              ['operators', t('platform.subscription.operators')],
              ['subscribers', t('platform.subscription.subscribers')],
              ['devices', t('platform.subscription.devices')]
            ] as const).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className={`whitespace-nowrap ${usage.over[key] ? 'font-semibold text-destructive' : 'font-medium'}`}>
                  {limitText(usage.usage[key], usage.limits[key])}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* A indicação e os créditos do provedor (0106), com o ajuste manual. */}
      <TenantReferrals tenantId={tenantId} />

      {/* Extrato */}
      {events.length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <h4 className="px-3 pt-3 text-sm font-semibold text-foreground">{t('platform.subscription.statement')}</h4>
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="modern-badge mr-2">{event.type}</span>
                  {/* O pagamento (ou a troca) da pró-rata de uma subida. */}
                  {event.detail?.proration ? <span className="modern-badge-info mr-2">{t('charges.proration')}</span> : null}
                  {event.amountCents !== null && <span>{formatMoney(event.amountCents, event.currency)}</span>}
                  {event.externalId && <span className="ml-2 font-mono text-xs break-all text-muted-foreground">{event.externalId}</span>}
                </span>
                <span className="text-muted-foreground">{formatDate(event.at)}</span>
                {/* A nota fiscal do pagamento que quitou uma cobrança do painel. */}
                {event.type === 'payment.recorded' && event.chargeId ? (
                  <span className="flex w-full flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{t('nfse.column')}:</span>
                    <InvoiceSummary invoice={event.invoice} />
                    {canIssueInvoiceForEvent(event) && (
                      <IssueInvoiceButton
                        tenantId={tenantId}
                        chargeId={event.chargeId}
                        reissue={Boolean(event.invoice)}
                        onDone={load}
                      />
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
