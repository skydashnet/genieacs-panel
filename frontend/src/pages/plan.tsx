'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { subscriptionAPI, type BillingCycle, type SubscriptionUsage, type TenantPlanOption } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { BillingProfile } from '@/components/billing-profile'
import { TenantCharges } from '@/components/tenant-charges'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { formatMoney } from '@/lib/money'
import {
  PLAN_RESOURCES,
  canCancelPending,
  canPayNow,
  canSwitchTo,
  confirmKey,
  couponCountsYears,
  couponDroppedOnAnnual,
  currentCycle,
  cyclePricing,
  isBillingExempt,
  isBillingExemptRefusal,
  isBusy,
  isPendingLocked,
  isPendingLockedRefusal,
  needsBillingProfile,
  overLimitDetail,
  payInNewTab,
  pendingBlockedDetail,
  periodLabel,
  planChangeKind,
  resourceLabelKey,
  subscriptionAllowsChanges
} from '@/lib/plan-options'
import { displayDate, displayDayMonth } from '@/lib/date-format'
import { couponAppliesToPlan, couponDurationLabel, couponPriceCents } from '@/lib/coupon'
import { CouponBadge } from '@/components/platform/coupon-control'
import { CardAutopay } from '@/components/card-autopay'
import { blockingOver } from '@/lib/overage'
import { ReferralCard } from '@/components/referral-card'
import { CancelSubscription } from '@/components/cancel-subscription'
import { BillingGuideModal } from '@/components/billing-guide-modal'

/**
 * O "plano e uso" do próprio provedor: qual plano, em que estado, quanto dele
 * está em uso — e, para quem tem `settings.write`, a troca de plano e o
 * "pagar agora".
 *
 * A próxima cobrança já sai com o preço novo. Subir vale na hora — e, com um
 * período pago correndo, cobra agora a diferença proporcional ao que falta
 * (a pró-rata, que a lista de planos já traz calculada e a confirmação
 * mostra); descer com a assinatura em dia fica agendado para a renovação
 * (`pendingPlan`), e o agendamento se cancela pedindo o plano atual. A tela
 * adianta na confirmação qual dos casos é, mas quem decide é o servidor — a
 * frase dele é o que aparece depois. É o backend quem recusa a troca para um plano que não comporta o
 * uso atual (`over_limit`); a tela só traduz a recusa em números. Quem não
 * escreve vê o catálogo, mas sem botões — mostrar um botão que sempre daria 403
 * é apontar para o que a pessoa não alcança.
 */
const STATUS_KEYS: Record<string, TranslationKey> = {
  trial: 'platform.subscription.trial',
  active: 'platform.subscription.active',
  past_due: 'platform.subscription.pastDue',
  suspended: 'platform.subscription.suspended',
  canceled: 'platform.subscription.canceled'
}

function badgeClass(status: string | undefined) {
  if (status === 'active' || status === 'trial') return 'modern-badge-success'
  if (status === 'past_due') return 'modern-badge-warning'
  return 'modern-badge-error'
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  return displayDate(value)
}

/** A data de renovação já passou? Nulo e data inválida não venceram. */
function expirou(value: string | null | undefined) {
  if (!value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now()
}

export default function PlanPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [data, setData] = useState<SubscriptionUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plans, setPlans] = useState<TenantPlanOption[] | null>(null)
  /** O "Como funciona": o guia de cobrança do provedor numa janela. */
  const [guiaAberto, setGuiaAberto] = useState(false)
  const [plansError, setPlansError] = useState<string | null>(null)
  const [mudando, setMudando] = useState<number | null>(null)
  const [pagando, setPagando] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  // `info` é o `busy`: outra operação deste provedor em andamento no servidor.
  // Não é erro — é "tente de novo em instantes" — e não leva o tom vermelho.
  const [aviso, setAviso] = useState<{ tipo: 'erro' | 'ok' | 'info'; texto: string } | null>(null)
  // Muda a cada troca de plano ou cobrança gerada: é o que faz a lista de
  // cobranças, que carrega sozinha, buscar de novo.
  const [chargesKey, setChargesKey] = useState(0)
  // "Tenho um cupom": o campo fica fechado até a pessoa pedir.
  const [cupomAberto, setCupomAberto] = useState(false)
  const [cupom, setCupom] = useState('')
  const [aplicandoCupom, setAplicandoCupom] = useState(false)
  const [cupomErro, setCupomErro] = useState<string | null>(null)
  // O seletor Mensal/Anual (0104): nulo é "o ciclo de agora da assinatura".
  const [cicloEscolhido, setCicloEscolhido] = useState<BillingCycle | null>(null)
  const cadastroRef = useRef<HTMLDivElement>(null)

  // Estável: a janela usa `onClose` como dependência do efeito que prende o Esc.
  const fecharGuia = useCallback(() => setGuiaAberto(false), [])

  const load = useCallback(async () => {
    setLoading(true)
    // O catálogo carrega junto, mas com o próprio erro: uma falha nele não
    // pode esconder o plano atual, e vice-versa.
    const [res, catalogo] = await Promise.all([subscriptionAPI.current(), subscriptionAPI.plans()])
    if (res.success && res.data) {
      setData(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    if (catalogo.success && catalogo.data) {
      setPlans(catalogo.data)
      setPlansError(null)
    } else {
      setPlansError(catalogo.message || '')
    }
    setLoading(false)
  }, [])

  const podeEscrever = can('settings.write')

  /**
   * Pede a troca ao servidor e, no sucesso, mostra a frase dele — é ela que diz
   * se valeu na hora, se ficou agendada ou se o agendamento caiu — e recarrega
   * assinatura, catálogo e cobranças: o preço novo muda o que "pagar agora"
   * oferece, e a troca pode ter mexido na cobrança em aberto.
   */
  const trocar = async (planId: number, fallback: string, cycle?: BillingCycle) => {
    setAviso(null)
    const res = await subscriptionAPI.changePlan(planId, cycle)
    if (res.success && res.data) {
      setData(res.data)
      setError(null)
      toast.success(res.message || fallback)
      // A fatura de pró-rata que a subida abriu: o link fica nas cobranças,
      // logo abaixo, e o aviso diz que ela está lá.
      const prorata = res.data.proration
      if (prorata && !prorata.skipped && prorata.amountCents > 0) {
        const valor = formatMoney(prorata.amountCents, prorata.currency ?? 'BRL')
        setAviso({
          tipo: prorata.issued ? 'ok' : 'info',
          texto: t(prorata.issued ? 'plan.proration.issued' : 'plan.proration.pending', { amount: valor })
        })
      }
      const [atual, catalogo] = await Promise.all([subscriptionAPI.current(), subscriptionAPI.plans()])
      if (atual.success && atual.data) setData(atual.data)
      if (catalogo.success && catalogo.data) setPlans(catalogo.data)
      setChargesKey((k) => k + 1)
      return
    }
    if (isBusy(res.code) || isPendingLockedRefusal(res.code)) {
      // A trava pode ter nascido depois da última carga: recarrega para os
      // botões sumirem.
      if (isPendingLockedRefusal(res.code)) {
        const atual = await subscriptionAPI.current()
        if (atual.success && atual.data) setData(atual.data)
      }
      setAviso({ tipo: 'info', texto: res.message || t('plan.options.changeFailed') })
      return
    }
    const acima = overLimitDetail(res)
    setAviso({
      tipo: 'erro',
      texto: acima
        ? t(acima.key, { resource: t(acima.resourceKey), used: acima.used, limit: acima.limit })
        : res.message || t('plan.options.changeFailed')
    })
  }

  /** A frase da pró-rata de subir para `plan`, ou nulo quando não há o que cobrar. */
  const prorationLine = (plan: TenantPlanOption) => {
    const previa = plan.proration
    if (!previa) return null
    if (previa.skipped) return t('plan.proration.belowMinimum')
    if (!(previa.amountCents > 0)) return null
    return t('plan.proration.confirm', {
      amount: formatMoney(previa.amountCents, previa.currency || plan.currency),
      days: previa.remainingDays
    })
  }

  const mudarPara = async (plan: TenantPlanOption, ciclo: BillingCycle) => {
    const doCiclo = cyclePricing(plan, ciclo)
    const periodo = periodLabel(doCiclo.periodDays, formatMoney(doCiclo.priceCents, plan.currency))
    const preco = t(periodo.key, periodo.vars)
    const atual = plans?.find((p) => p.current) ?? null
    const tipo = planChangeKind(atual, plan, data?.subscription, undefined, ciclo)
    if (tipo === 'same') return
    const vars = { name: plan.name, price: preco, date: formatDate(data?.subscription?.renewsAt) ?? '' }
    // A pró-rata, ANTES do clique que a cobra: "você vai pagar R$ X agora".
    const prorata = tipo === 'upgrade' ? prorationLine(plan) : null
    // O cupom de N faturas que a troca para o anual tira (0104), dito ANTES do clique.
    const cupomSai = couponDroppedOnAnnual(data?.subscription?.coupon, currentCycle(data?.subscription), ciclo)
      ? t('plan.cycle.couponDropped', { code: data?.subscription?.coupon?.code ?? '' })
      : null
    const pergunta = [t(confirmKey(tipo), vars), prorata, cupomSai].filter(Boolean).join('\n\n')
    if (!window.confirm(pergunta)) return
    setMudando(plan.id)
    await trocar(plan.id, t('plan.options.changed', { name: plan.name }), ciclo)
    setMudando(null)
  }

  const cancelarAgendamento = async (planoAtualId: number, agendado: string) => {
    if (!window.confirm(t('plan.pending.cancelConfirm', { plan: agendado }))) return
    setCancelando(true)
    await trocar(planoAtualId, t('plan.pending.canceled'))
    setCancelando(false)
  }

  // Síncrono até o `payInNewTab`: a aba nova tem que abrir dentro do clique,
  // ou o navegador a bloqueia como pop-up.
  const pagarAgora = () => {
    setPagando(true)
    setAviso(null)
    void payInNewTab(subscriptionAPI.payNow).then((res) => {
      setPagando(false)
      setChargesKey((k) => k + 1)
      if (res.success && res.data?.charge?.invoiceUrl) return
      if (res.success) {
        setAviso({ tipo: 'erro', texto: t('plan.payNoLink') })
        return
      }
      if (isBillingExemptRefusal(res.code)) {
        // A isenção nasceu depois da última carga: recarrega para o botão
        // sumir e a nota aparecer.
        setAviso({ tipo: 'info', texto: t('plan.billingExemptNote') })
        void load()
        return
      }
      const texto = res.message || t('plan.payFailed')
      if (isBusy(res.code)) {
        // A aba em branco já foi fechada por `payInNewTab`.
        setAviso({ tipo: 'info', texto })
        return
      }
      if (needsBillingProfile(res.code)) {
        // O que falta está nesta mesma tela, logo abaixo: leva a pessoa até lá.
        setAviso({ tipo: 'erro', texto: `${texto} ${t('plan.payBillingHint')}` })
        cadastroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        cadastroRef.current?.focus({ preventScroll: true })
      } else {
        setAviso({ tipo: 'erro', texto })
      }
    })
  }

  /**
   * Aplica o cupom e redesenha com o que volta (a mesma tela de `current`, com
   * `subscription.coupon`). A fatura em aberto pode ter sido reemitida com o
   * desconto, então as cobranças recarregam. A recusa (inválido, vencido,
   * esgotado, de outro plano) fica no campo, na frase do servidor.
   */
  const aplicarCupom = async () => {
    const codigo = cupom.trim()
    if (!codigo) return
    setAplicandoCupom(true)
    setCupomErro(null)
    try {
      const res = await subscriptionAPI.applyCoupon(codigo)
      if (res.success && res.data) {
        setData(res.data)
        setCupom('')
        setCupomAberto(false)
        toast.success(res.message || t('coupons.applied'))
        setChargesKey((k) => k + 1)
      } else {
        setCupomErro(res.message || t('coupons.applyFailed'))
      }
    } finally {
      setAplicandoCupom(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  const subscription = data?.subscription ?? null
  // O ciclo de agora e o que o seletor mostra (0104).
  const cicloAtual = currentCycle(subscription)
  const cicloVisto: BillingCycle = cicloEscolhido ?? cicloAtual
  const rotuloCiclo = (ciclo: BillingCycle) => t(ciclo === 'annual' ? 'plan.cycle.annual' : 'plan.cycle.monthly')
  // A maior economia do anual no catálogo, para o seletor.
  const maiorEconomia = (plans ?? []).reduce((maior, p) => Math.max(maior, p.annualSavingsPercent ?? 0), 0)
  const algumAnual = (plans ?? []).some((p) => p.annualAvailable)
  // Isento: não vence nem recebe fatura. Some o prazo, o aviso de vencido e o
  // "pagar agora"; fica a nota.
  const isento = isBillingExempt(subscription)
  // Até quando (dd/mm), quando a isenção tem data de fim.
  const isentoAte = isento ? displayDayMonth(subscription?.billingExemptUntil) : null
  const venceu = !isento && expirou(subscription?.renewsAt)
  const pendente = subscription?.pendingPlan ?? null
  const pendenteBloqueio = pendingBlockedDetail(pendente)
  const planoAtualId = plans?.find((p) => p.current)?.id ?? null
  const cupomAtual = subscription?.coupon ?? null
  const moedaAtual = plans?.find((p) => p.current)?.currency ?? 'BRL'
  // O campo do cupom: quem escreve, com a assinatura viva, sem isenção e sem
  // cupom (trocar de cupom é com a plataforma).
  const podeCupom = podeEscrever && !isento && !cupomAtual && subscriptionAllowsChanges(subscription)

  const meter = (used: number | null, limit: number | null) => {
    if (used === null) return { text: t('platform.subscription.uncounted'), pct: 0 }
    if (limit === null) return { text: `${used} / ∞`, pct: 0 }
    return { text: `${used} / ${limit}`, pct: limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)) }
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <h1 className="page-title">{t('plan.title')}</h1>
            <p className="page-description">{t('plan.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <button type="button" className="modern-button-secondary" onClick={() => setGuiaAberto(true)}>
              <Icon name="info" size={17} />
              {t('help.howItWorks')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
              <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
          </div>
        </header>
        <BillingGuideModal open={guiaAberto} onClose={fecharGuia} />

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : error !== null ? (
          <p className="text-sm text-destructive">{error || t('plan.loadFailed')}</p>
        ) : !subscription ? (
          <p className="text-sm text-muted-foreground">{t('subscription.missing')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <section className="modern-card p-5 sm:p-6">
              <h2 className="section-heading">{t('platform.subscription.plan')}</h2>
              <p className="mt-1 wrap-break-word text-2xl font-semibold text-foreground">{subscription.plan?.name ?? '—'}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                {/* Pausada (0107) não é atraso: o selo dela, logo abaixo, diz até quando. */}
                {subscription.reason !== 'paused' && (
                  <span className={badgeClass(subscription.status)}>
                    {t(STATUS_KEYS[subscription.status] ?? 'platform.subscription.suspended')}
                  </span>
                )}
                {!isento && subscription.reason === 'trial_expired' && (
                  <span className="text-muted-foreground">{t('platform.subscription.trialExpiredNote')}</span>
                )}
                {!isento && subscription.reason === 'renewal_expired' && (
                  <span className="text-muted-foreground">{t('platform.subscription.renewalExpiredNote')}</span>
                )}
                {!isento && subscription.reason === 'proration_overdue' && (
                  <span className="text-muted-foreground">{t('platform.subscription.prorationOverdueNote')}</span>
                )}
                {/* A retenção no cancelamento (0107). */}
                {subscription.cancelAt && (
                  <span className="modern-badge-warning">
                    {t('platform.subs.cancelsOn', { date: displayDayMonth(subscription.cancelAt) ?? '—' })}
                  </span>
                )}
                {subscription.pausedUntil && (
                  <span className="modern-badge-info">
                    {t('platform.subs.pausedUntil', { date: displayDayMonth(subscription.pausedUntil) ?? '—' })}
                  </span>
                )}
              </div>
              {isento && (
                <p role="status" className="mt-3 flex items-start gap-2 text-sm text-foreground">
                  <Icon name="info" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-info))]" />
                  {isentoAte ? t('plan.billingExemptUntilNote', { date: isentoAte }) : t('plan.billingExemptNote')}
                </p>
              )}
              <dl className="mt-4 space-y-2 text-sm">
                {!isento && subscription.storedStatus === 'trial' && formatDate(subscription.trialEndsAt) && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('plan.trialEnds')}</dt>
                    <dd className="font-medium">{formatDate(subscription.trialEndsAt)}</dd>
                  </div>
                )}
                {!isento && formatDate(subscription.renewsAt) && (
                  <div className="flex justify-between gap-3">
                    {/* "Pago até 12/03" com hoje em 12/09 era o painel publicando
                        ao cliente uma data que ele mesmo não respeitava. Agora
                        que o período vencido bloqueia a escrita, a etiqueta tem
                        que dizer qual dos dois lados da data se está. */}
                    <dt className="text-muted-foreground">
                      {venceu ? t('plan.paidThroughExpired') : t('plan.paidThrough')}
                    </dt>
                    <dd className="font-medium">{formatDate(subscription.renewsAt)}</dd>
                  </div>
                )}
                {subscription.billingCycle && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('plan.cycle.label')}</dt>
                    <dd className="font-medium">{rotuloCiclo(cicloAtual)}</dd>
                  </div>
                )}
              </dl>
              {cupomAtual && (
                <div className="mt-4 space-y-1 text-sm">
                  <CouponBadge coupon={cupomAtual} currency={moedaAtual} />
                  <p className="text-muted-foreground">
                    {t(couponDurationLabel(cupomAtual).key, couponDurationLabel(cupomAtual).vars)}
                    {cupomAtual.cyclesLeft !== null && ` · ${t('coupons.cyclesLeft', { count: cupomAtual.cyclesLeft })}`}
                  </p>
                  <p className="font-medium text-foreground">
                    {cupomAtual.appliesToPlan
                      ? t('plan.coupon.nextInvoice', { price: formatMoney(cupomAtual.priceCents, moedaAtual) })
                      : t('coupons.notApplicable')}
                  </p>
                </div>
              )}
              {podeCupom && !cupomAberto && (
                <button type="button" className="mt-2 inline-flex min-h-10 items-center text-sm font-medium text-primary underline-offset-2 hover:underline md:mt-4 md:min-h-0" onClick={() => setCupomAberto(true)}>
                  {t('plan.coupon.have')}
                </button>
              )}
              {podeCupom && cupomAberto && (
                <form
                  className="mt-4"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void aplicarCupom()
                  }}
                >
                  <label htmlFor="plan-coupon" className="mb-1 block text-sm font-medium">{t('plan.coupon.have')}</label>
                  <div className="flex flex-wrap gap-2">
                    <input
                      id="plan-coupon"
                      value={cupom}
                      onChange={(e) => setCupom(e.target.value.toUpperCase())}
                      className="modern-input min-w-0 flex-1"
                      placeholder={t('coupons.codePlaceholder')}
                      maxLength={32}
                      autoComplete="off"
                      disabled={aplicandoCupom}
                    />
                    <button type="submit" className="modern-button-secondary" disabled={aplicandoCupom || !cupom.trim()}>
                      {aplicandoCupom ? t('coupons.applying') : t('coupons.apply')}
                    </button>
                  </div>
                  <p className="field-hint">{t('plan.coupon.hint')}</p>
                  {cupomErro && <p role="alert" className="mt-1 text-sm text-destructive">{cupomErro}</p>}
                </form>
              )}
              <p className="field-hint mt-4">{t('plan.changeHint')}</p>
              {canPayNow(plans, podeEscrever, subscription) && (
                <button type="button" className="modern-button mt-4" disabled={pagando} onClick={pagarAgora}>
                  <Icon name="invoice" size={17} />
                  {pagando ? t('plan.paying') : t('plan.payNow')}
                </button>
              )}
              {/* O cartão recorrente: a quem paga (plano pago, sem isenção), e
                  a quem já tem cartão ou cobrança automática para desligar. */}
              {subscription.card && !isento
                && (canPayNow(plans, true, subscription) || subscription.card.saved || subscription.card.autopayEnabled) && (
                <CardAutopay
                  card={subscription.card}
                  canWrite={podeEscrever}
                  canEnable={subscriptionAllowsChanges(subscription)}
                  onChanged={(novo) => {
                    setData(novo)
                    setChargesKey((k) => k + 1)
                  }}
                />
              )}
            </section>

            <section className="modern-card p-5 sm:p-6">
              <h2 className="section-heading">{t('platform.subscription.usage')}</h2>
              <ul className="mt-3 space-y-4">
                {([
                  ['operators', t('platform.subscription.operators')],
                  ['subscribers', t('platform.subscription.subscribers')],
                  ['devices', t('platform.subscription.devices')]
                ] as const).map(([key, label]) => {
                  const { text, pct } = meter(data!.usage[key], data!.limits[key])
                  const over = data!.over[key]
                  return (
                    <li key={key}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 text-muted-foreground">{label}</span>
                        <span className={`shrink-0 ${over ? 'font-semibold text-destructive' : 'font-medium'}`}>{text}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div
                          className={`h-full rounded-full ${over ? 'bg-destructive' : 'bg-primary'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
              {/* O aviso de bloqueio só para o recurso SEM preço de excedente: o
                  com preço não bloqueia (0105), e o que ele custa vem logo abaixo. */}
              {blockingOver(data!.over, data!.overage?.prices).length > 0 && (
                <p className="mt-4 text-sm text-destructive">{t('plan.overHint')}</p>
              )}
              {data!.overage && (
                <div className="mt-4 space-y-1 text-sm">
                  {data!.overage.items.map((item) => (
                    <p key={item.resource} className="font-medium text-[hsl(var(--status-warning))]">
                      {t('plan.overage.line', {
                        resource: t(resourceLabelKey(item.resource)),
                        units: item.units,
                        unit: formatMoney(item.unitCents, data!.overage!.currency),
                        total: formatMoney(item.cents, data!.overage!.currency)
                      })}
                    </p>
                  ))}
                  {data!.overage.items.length > 1 && (
                    <p className="font-semibold text-foreground">
                      {t('plan.overage.total', { total: formatMoney(data!.overage.totalCents, data!.overage.currency) })}
                    </p>
                  )}
                  <p className="field-hint">
                    {t(data!.overage.billing === 'monthly' ? 'plan.overage.hintAnnual' : 'plan.overage.hint')}
                  </p>
                </div>
              )}
            </section>
          </div>
        )}

        {!loading && pendente && (
          <section
            role="status"
            className="mt-6 flex flex-col gap-3 rounded-lg border border-[hsl(var(--status-info)/.3)] bg-[hsl(var(--status-info)/.06)] p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 gap-3">
              <Icon name="info" size={18} className="mt-0.5 shrink-0 text-[hsl(var(--status-info))]" />
              <div className="min-w-0 text-sm">
                <p className="wrap-break-word font-medium text-foreground">
                  {t('plan.pending.title', {
                    plan: pendente.billingCycle && pendente.billingCycle !== cicloAtual
                      ? `${pendente.name} (${rotuloCiclo(pendente.billingCycle)})`
                      : pendente.name,
                    date: formatDate(pendente.effectiveAt) ?? '—'
                  })}
                </p>
                <p className="mt-1 text-muted-foreground">{t('plan.pending.hint')}</p>
                {isPendingLocked(pendente) && (
                  <p className="mt-1 text-muted-foreground">
                    {t('plan.pending.locked', { date: formatDate(pendente.effectiveAt) ?? '—' })}
                  </p>
                )}
                {pendenteBloqueio && (
                  <p className="mt-2 text-[hsl(var(--status-warning))]">
                    {t(pendenteBloqueio.key, {
                      resource: t(pendenteBloqueio.resourceKey),
                      used: pendenteBloqueio.used,
                      limit: pendenteBloqueio.limit
                    })}
                  </p>
                )}
              </div>
            </div>
            {canCancelPending(pendente, podeEscrever) && planoAtualId !== null && (
              <button
                type="button"
                className="modern-button-secondary w-full shrink-0 justify-center sm:w-auto"
                disabled={cancelando || mudando !== null}
                onClick={() => void cancelarAgendamento(planoAtualId, pendente.name)}
              >
                {cancelando ? t('plan.pending.canceling') : t('plan.pending.cancel')}
              </button>
            )}
          </section>
        )}

        {aviso && (
          <p
            role={aviso.tipo === 'erro' ? 'alert' : 'status'}
            className={`mt-6 text-sm ${
              aviso.tipo === 'erro'
                ? 'text-destructive'
                : aviso.tipo === 'info'
                  ? 'text-muted-foreground'
                  : 'text-emerald-700 dark:text-emerald-400'
            }`}
          >
            {aviso.texto}
          </p>
        )}

        {/* O catálogo fica entre o plano atual e as cobranças: é a pergunta
            seguinte a "em que plano estou". Fora do estado de carga da
            assinatura, como as cobranças, porque tem a própria carga. */}
        {!loading && (
          <section className="modern-card mt-6 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="section-heading">{t('plan.options.title')}</h2>
                <p className="section-description">{t('plan.options.description')}</p>
              </div>
              {/* Mensal ou Anual (0104): o preço que os cartões mostram e o
                  ciclo que a troca pede. Só quando algum plano tem o anual. */}
              {algumAnual && (
                <div role="radiogroup" aria-label={t('plan.cycle.label')} className="flex shrink-0 flex-wrap items-center gap-2">
                  {(['monthly', 'annual'] as const).map((ciclo) => (
                    <button
                      key={ciclo}
                      type="button"
                      role="radio"
                      aria-checked={cicloVisto === ciclo}
                      className={cicloVisto === ciclo ? 'modern-button' : 'modern-button-secondary'}
                      onClick={() => setCicloEscolhido(ciclo)}
                    >
                      {rotuloCiclo(ciclo)}
                      {ciclo === 'annual' && maiorEconomia > 0 && (
                        <span className="text-xs font-normal">{t('plan.cycle.saveUpTo', { percent: maiorEconomia })}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {cicloVisto !== cicloAtual && (
              <p className="field-hint mt-2">{t('plan.cycle.hint')}</p>
            )}
            {couponDroppedOnAnnual(cupomAtual, cicloAtual, cicloVisto) ? (
              <p role="note" className="mt-2 text-sm text-[hsl(var(--status-warning))]">
                {t('plan.cycle.couponDropped', { code: cupomAtual?.code ?? '' })}
              </p>
            ) : couponCountsYears(cupomAtual, cicloVisto) && (
              <p role="note" className="mt-2 text-sm text-[hsl(var(--status-warning))]">{t('plan.cycle.couponYears')}</p>
            )}
            {plansError !== null ? (
              <p className="mt-3 text-sm text-destructive">{plansError || t('plan.options.loadFailed')}</p>
            ) : !plans?.length ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('plan.options.empty')}</p>
            ) : (
              <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {plans.map((plan) => {
                  // O preço do ciclo do seletor; sem anual, o mensal, com o aviso.
                  const semAnual = cicloVisto === 'annual' && !plan.annualAvailable
                  const doCiclo = cyclePricing(plan, cicloVisto)
                  const periodo = periodLabel(doCiclo.periodDays, formatMoney(doCiclo.priceCents, plan.currency))
                  const agendadoAqui = plan.id === pendente?.id && (pendente?.billingCycle ?? cicloAtual) === cicloVisto
                  const atualAqui = plan.current && cicloVisto === cicloAtual
                  return (
                    <li
                      key={plan.id}
                      className={`flex min-w-0 flex-col rounded-lg border p-4 ${
                        atualAqui ? 'border-primary' : agendadoAqui ? 'border-dashed border-primary/60' : 'border-border'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="min-w-0 wrap-break-word font-semibold text-foreground">{plan.name}</h3>
                        {atualAqui && <span className="modern-badge-success">{t('plan.options.current')}</span>}
                        {!atualAqui && agendadoAqui && (
                          <span className="modern-badge-info">{t('plan.options.scheduled')}</span>
                        )}
                      </div>
                      <p className={`mt-1 text-lg font-semibold ${semAnual ? 'text-muted-foreground' : 'text-foreground'}`}>
                        {t(periodo.key, periodo.vars)}
                      </p>
                      {semAnual && <p className="text-sm text-muted-foreground">{t('plan.cycle.unavailable')}</p>}
                      {cicloVisto === 'annual' && !semAnual && plan.annualSavingsPercent != null && plan.annualSavingsPercent > 0 && (
                        <p className="text-sm font-medium text-[hsl(var(--status-success))]">
                          {t('plan.cycle.save', { percent: plan.annualSavingsPercent })}
                        </p>
                      )}
                      {/* O preço com o cupom do provedor, quando ele vale neste
                          plano — a vitrine; o valor que vale é o da fatura. */}
                      {cupomAtual && couponAppliesToPlan(cupomAtual, plan.id)
                        && couponPriceCents(doCiclo.priceCents, cupomAtual) !== doCiclo.priceCents && (
                        <p className="text-sm font-medium text-[hsl(var(--status-success))]">
                          {t('coupons.priceWithCoupon', {
                            price: formatMoney(couponPriceCents(doCiclo.priceCents, cupomAtual), plan.currency)
                          })}
                        </p>
                      )}
                      {/* Quanto subir para este plano cobra agora (a pró-rata). */}
                      {!plan.current && cicloVisto === cicloAtual && canSwitchTo(plan, podeEscrever, subscription) && plan.proration
                        && !plan.proration.skipped && plan.proration.amountCents > 0 && (
                        <p className="text-sm text-muted-foreground">
                          {t('plan.proration.preview', {
                            amount: formatMoney(plan.proration.amountCents, plan.proration.currency || plan.currency),
                            days: plan.proration.remainingDays
                          })}
                        </p>
                      )}
                      <dl className="mt-3 flex-1 space-y-1 text-sm">
                        {PLAN_RESOURCES.map((recurso) => (
                          <div key={recurso} className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">{t(resourceLabelKey(recurso))}</dt>
                            <dd className="font-medium">{plan.limits[recurso] ?? t('plan.options.unlimited')}</dd>
                          </div>
                        ))}
                      </dl>
                      {canSwitchTo(plan, podeEscrever, subscription, cicloVisto) && (
                        <button
                          type="button"
                          className="modern-button-secondary mt-4 w-full justify-center"
                          disabled={mudando !== null || cancelando}
                          onClick={() => void mudarPara(plan, cicloVisto)}
                        >
                          {mudando === plan.id ? t('plan.options.switching') : t('plan.options.switch')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}

        {/* As cobranças vêm ANTES do cadastro fiscal e depois do plano, que é a
            ordem da pergunta: em que plano estou, o que me foi cobrado, e para
            quem vai a nota. Fora do `else` do estado de carga acima de
            propósito: o bloco tem a própria carga, então um provedor sem
            assinatura — que é um dos que mais precisa pagar — continua vendo o
            que deve. */}
        <div className="mt-6">
          <TenantCharges refreshKey={chargesKey} />
        </div>

        {/* A indicação de provedores (0106): o link, o saldo de créditos e os
            indicados. Depois das cobranças, porque o crédito é abatido nelas. */}
        <div className="mt-6">
          <ReferralCard />
        </div>

        {/* Abaixo do plano, e não numa aba das configurações: é a mesma
            conversa — em que plano estou, até quando paguei, e para quem vai a
            nota. */}
        {/* `tabIndex` para o "pagar agora" poder levar o foco até aqui quando a
            cobrança é recusada por falta de CNPJ ou razão social. */}
        {data && (
          <div ref={cadastroRef} tabIndex={-1} className="mt-6 scroll-mt-4 outline-hidden">
            <BillingProfile
              billing={data.billing}
              onSaved={(billing) => setData((atual) => (atual ? { ...atual, billing } : atual))}
            />
          </div>
        )}

        {/* O cancelamento, por último: o motivo, as ofertas de retenção e o
            agendamento (0107). Só o dono o vê — o bloco se esconde sozinho. */}
        {!loading && subscription && !isento && (
          <CancelSubscription
            subscription={subscription}
            canWrite={podeEscrever}
            currency={moedaAtual}
            onChanged={() => {
              void load()
              setChargesKey((k) => k + 1)
            }}
          />
        )}
      </div>
    </div>
  )
}
