'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  SUBSCRIPTION_BLOCKED_EVENT,
  subscriptionAPI,
  type SubscriptionBlockedDetail,
  type SubscriptionGateCode
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { BrandMark } from '@/components/brand-mark'
import { cobrancaDeProrata, cobrancaEmAberto } from '@/components/tenant-charges'
import { canGenerateCharge, isBillingExemptRefusal, payInNewTab } from '@/lib/plan-options'
import { displayDayMonth } from '@/lib/date-format'
import type { TenantPlanOption } from '@/lib/api'

/**
 * O que o operador vê quando a assinatura do provedor não deixa passar.
 *
 * Dois pesos, porque o backend tem dois: `past_due` e o teste vencido deixam
 * LER — então é uma faixa no alto, e a tela continua útil; `suspended`,
 * `canceled` e "sem assinatura" não deixam nada — então é um muro, com o nome
 * do plano e até quando, e uma saída.
 *
 * Ouve o evento que o cliente da API dispara em todo 402 da assinatura, em vez
 * de perguntar por conta própria a cada tela: a primeira requisição recusada
 * é a notícia. E pergunta a `/tenant/subscription` ao ser avisado, porque essa
 * rota fica fora da porta justamente para este componente ter o que mostrar.
 */
const WALL_CODES = new Set<SubscriptionGateCode>([
  'subscription_suspended', 'subscription_canceled', 'subscription_missing'
])

const MESSAGE_KEYS: Record<SubscriptionGateCode, TranslationKey> = {
  subscription_past_due: 'subscription.pastDue',
  subscription_trial_expired: 'subscription.trialExpired',
  subscription_suspended: 'subscription.suspended',
  subscription_canceled: 'subscription.canceled',
  subscription_missing: 'subscription.missing',
  subscription_paused: 'subscription.paused'
}

export function SubscriptionNotice() {
  const { t } = useTranslation()
  const { logout, user, can } = useAuth()
  const [blocked, setBlocked] = useState<SubscriptionBlockedDetail | null>(null)
  const [planName, setPlanName] = useState<string | null>(null)
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null)
  // `null` enquanto a lista de cobranças não voltou: sem saber se já há boleto
  // em aberto, oferecer "gerar cobrança" arriscaria emitir uma segunda.
  const [chargesLoaded, setChargesLoaded] = useState(false)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  // O catálogo só serve para saber se o plano atual é pago: no grátis não há
  // cobrança a gerar. A rota fica fora da porta da assinatura.
  const [plans, setPlans] = useState<TenantPlanOption[] | null>(null)

  useEffect(() => {
    const onBlocked = (event: Event) => {
      const detail = (event as CustomEvent<SubscriptionBlockedDetail>).detail
      setBlocked(detail)
      if (detail.subscription?.plan?.name) {
        setPlanName(detail.subscription.plan.name)
      } else {
        void subscriptionAPI.current().then((res) => {
          if (res.success && res.data?.subscription?.plan) setPlanName(res.data.subscription.plan.name)
        })
      }
      // E onde se paga, pela mesma razão que o nome do plano vem: o muro é a
      // única tela que este operador alcança, então é nele que a saída tem que
      // estar. A rota está fora da porta da assinatura de propósito; sem isso
      // esta chamada responderia o mesmo 402 que trouxe o muro.
      void subscriptionAPI.plans().then((res) => {
        if (res.success && res.data) setPlans(res.data)
      })
      void subscriptionAPI.charges().then((res) => {
        if (res.success && res.data) {
          // Bloqueado pela pró-rata vencida: o link é o DELA, e não o da
          // renovação que pode estar em aberto ao lado.
          const daProrata = detail.subscription?.reason === 'proration_overdue'
            ? cobrancaDeProrata(res.data.charges)
            : null
          setPaymentUrl((daProrata ?? cobrancaEmAberto(res.data.charges))?.invoiceUrl ?? null)
          setChargesLoaded(true)
        }
      })
    }
    window.addEventListener(SUBSCRIPTION_BLOCKED_EVENT, onBlocked)
    return () => window.removeEventListener(SUBSCRIPTION_BLOCKED_EVENT, onBlocked)
  }, [])

  if (!blocked) return null

  // Sem boleto em aberto, a saída do muro é gerar um — quando o bloqueio se
  // resolve pagando (atraso, teste vencido) e o plano é pago. As regras
  // moram em `canGenerateCharge`.
  // A suspensão automática por inadimplência (0102) sai pagando: o muro dela
  // diz isso, e oferece a cobrança como o do atraso.
  const autoSuspended = blocked.code === 'subscription_suspended' && blocked.subscription?.reason === 'auto_nonpayment'
  const canGenerate = canGenerateCharge({
    code: blocked.code, paymentUrl, chargesLoaded, canWrite: can('settings.write'), plans,
    billingExempt: blocked.subscription?.billingExempt === true, autoSuspended
  })

  // Síncrono até o `payInNewTab`: a aba nova precisa nascer dentro do clique.
  const generateAndPay = () => {
    setPaying(true)
    setPayError(null)
    void payInNewTab(subscriptionAPI.payNow).then((res) => {
      setPaying(false)
      const url = res.success ? res.data?.charge?.invoiceUrl ?? null : null
      if (url) setPaymentUrl(url)
      // `busy` também cai aqui: a frase do servidor já diz "tente de novo em
      // instantes", e o botão volta a ficar habilitado para isso.
      else if (res.success) setPayError(t('plan.payNoLink'))
      else if (isBillingExemptRefusal(res.code)) setPayError(t('plan.billingExemptNote'))
      else setPayError(res.message || t('plan.payFailed'))
    })
  }

  // A pró-rata vencida tem o aviso dela: o período está pago, o que falta é
  // a diferença da troca de plano.
  // A pausa de retenção (0107) diz até quando — e que pagar a encerra antes.
  const pausadaAte = blocked.code === 'subscription_paused' ? displayDayMonth(blocked.subscription?.pausedUntil) : null
  const message = (pausadaAte
    ? t('subscription.pausedUntil', { date: pausadaAte })
    : t(autoSuspended
      ? 'subscription.suspendedNonpayment'
      : blocked.code === 'subscription_past_due' && blocked.subscription?.reason === 'proration_overdue'
        ? 'subscription.prorationOverdue'
        : MESSAGE_KEYS[blocked.code])) || blocked.message
  const wall = WALL_CODES.has(blocked.code)

  if (!wall) {
    return (
      <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 wrap-anywhere dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 sm:text-sm">
        <strong className="mr-2">{t('subscription.readOnlyTitle')}</strong>
        {message}
        {planName && <span className="ml-2 opacity-80">({planName})</span>}
        {paymentUrl && (
          <a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="ml-3 inline-flex min-h-10 items-center font-semibold underline lg:min-h-0">
            {t('charges.pay')}
          </a>
        )}
        {canGenerate && (
          <button type="button" className="ml-3 inline-flex min-h-10 items-center font-semibold underline lg:min-h-0" disabled={paying} onClick={generateAndPay}>
            {paying ? t('plan.paying') : t('subscription.generateAndPay')}
          </button>
        )}
        {payError && <span className="ml-3 font-medium">{payError}</span>}
        <button type="button" className="ml-3 inline-flex min-h-10 min-w-10 items-center justify-center underline lg:min-h-0 lg:min-w-0" onClick={() => setBlocked(null)}>
          {t('common.close')}
        </button>
      </div>
    )
  }

  // No `body`: a casca põe esta peça dentro da faixa grudada, cuja camada fica
  // abaixo da barra do celular — o muro tem que cobrir a barra e o menu também.
  return createPortal(
    <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-2150 flex items-center justify-center overflow-y-auto bg-background/95 p-4 sm:p-6">
      <div className="modern-card my-auto w-full max-w-md p-6 text-center wrap-anywhere">
        <BrandMark className="mx-auto mb-4 size-10" />
        <h2 className="mb-2 text-lg font-semibold text-foreground">{t('subscription.blockedTitle')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{message}</p>
        {planName && (
          <p className="mb-4 text-sm">
            <span className="text-muted-foreground">{t('platform.subscription.plan')}: </span>
            <span className="font-medium">{planName}</span>
          </p>
        )}
        {/* O administrador da plataforma chega ao console por aqui mesmo:
            `/api/platform/*` fica fora da porta. Para todo mundo mais, sair é
            a única ação que faz sentido num painel que não responde. */}
        <div className="flex flex-wrap justify-center gap-2">
          {/* A saída do muro, quando ela existe. Primeiro na fila porque é a
              única ação aqui que desfaz o bloqueio — sair e abrir o console não
              desfazem. */}
          {paymentUrl && (
            <a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="modern-button">
              {t('charges.pay')}
            </a>
          )}
          {canGenerate && (
            <button type="button" className="modern-button" disabled={paying} onClick={generateAndPay}>
              {paying ? t('plan.paying') : t('subscription.generateAndPay')}
            </button>
          )}
          {user?.isPlatformAdmin && (
            <a href="/platform" className="modern-button-secondary">{t('platform.title')}</a>
          )}
          <button type="button" className={paymentUrl || canGenerate ? 'modern-button-secondary' : 'modern-button'} onClick={logout}>
            {t('sidebar.signOut')}
          </button>
        </div>
        {/* A recusa vem com a frase do servidor: falta de CNPJ, plano grátis,
            gateway fora. No muro não há o cadastro fiscal para onde levar a
            pessoa, então a frase é tudo que se pode dar. */}
        {payError && <p role="alert" className="mt-4 text-sm text-destructive">{payError}</p>}
      </div>
    </div>,
    document.body
  )
}
