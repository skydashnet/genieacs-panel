'use client'

import { useCallback, useEffect, useState } from 'react'
import { subscriptionAPI, type TenantChargeView } from '@/lib/api'
import { formatMoney } from '@/lib/money'
import { ChargePricingBreakdown } from '@/components/charge-pricing'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { displayDate } from '@/lib/date-format'
import { safeInvoiceUrl } from '@/lib/invoice'

/**
 * O que foi cobrado deste provedor, e onde ele paga.
 *
 * A tabela `billing_charges` guarda o endereço da página do gateway desde que a
 * emissão automática existe, e até aqui ele só saía pelo e-mail de aviso: quem
 * perdeu o e-mail via o muro do 402 sem ter, em tela nenhuma, onde pagar.
 *
 * A rota fica FORA da porta da assinatura, o que é o ponto todo — este bloco
 * carrega para um provedor bloqueado, que é exatamente quem precisa dele.
 */
const STATUS_KEYS: Record<TenantChargeView['status'], TranslationKey> = {
  pending: 'charges.status.pending',
  paid: 'charges.status.paid',
  canceled: 'charges.status.canceled',
  // `failed` é a emissão que o gateway recusou — a cobrança não chegou ao
  // cliente. Dizer "falhou" a ele sem mais nada seria assustar por um problema
  // nosso, então o rótulo fala do que ele vê: ainda não há o que pagar aqui.
  failed: 'charges.status.failed',
  // `overdue` é a cobrança em aberto que passou do vencimento na Asaas. Ainda
  // se paga — e o link continua na linha, igual ao de `pending`.
  overdue: 'charges.status.overdue',
  // `refunded` é o pagamento que voltou ao cliente: não há mais o que pagar.
  refunded: 'charges.status.refunded'
}

function badgeClass(status: TenantChargeView['status']) {
  if (status === 'paid') return 'modern-badge-success'
  if (status === 'pending') return 'modern-badge-warning'
  // Estornada não é erro de ninguém: é um fato, e o selo neutro diz só isso.
  if (status === 'refunded' || status === 'canceled') return 'modern-badge'
  // `-error` e não `-danger`: é a classe que existe em `globals.css`.
  return 'modern-badge-error'
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  return displayDate(value)
}

/**
 * A cobrança que ainda se paga, se houver — a mais recente delas.
 *
 * Exportada porque o muro do 402 faz a mesma pergunta: lá a resposta vira um
 * botão, aqui vira uma linha da tabela, e as duas telas não podem discordar
 * sobre qual boleto está em aberto.
 */
export function cobrancaEmAberto(charges: TenantChargeView[]) {
  return charges.find((c) => c.invoiceUrl && (c.status === 'pending' || c.status === 'overdue' || c.status === 'failed')) ?? null
}

/** A fatura de pró-rata ainda pagável, se houver — a do aviso `proration_overdue`. */
export function cobrancaDeProrata(charges: TenantChargeView[]) {
  // A de só excedente (0105) é avulsa como a pró-rata, e vencida bloqueia igual.
  return cobrancaEmAberto(charges.filter((c) => c.kind === 'proration' || c.kind === 'overage'))
}

/**
 * `refreshKey` é o jeito de a página pedir uma recarga de fora: ela muda o
 * número depois de trocar o plano ou gerar uma cobrança, e a lista busca de
 * novo sem que a página precise saber como ela carrega.
 */
export function TenantCharges({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const { t } = useTranslation()
  const [charges, setCharges] = useState<TenantChargeView[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await subscriptionAPI.charges()
    if (res.success && res.data) {
      setCharges(res.data.charges)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{t('charges.title')}</h2>
        <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
          {t('common.refresh')}
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error !== null ? (
        <p className="mt-3 text-sm text-destructive">{error || t('charges.loadFailed')}</p>
      ) : !charges?.length ? (
        /* Sem cobrança não é erro: é o provedor em teste, o de plano grátis e o
           que ainda não chegou na primeira emissão. */
        <p className="mt-3 text-sm text-muted-foreground">{t('charges.empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {charges.map((charge) => (
            <li key={charge.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {formatMoney(charge.amountCents, charge.currency)}
                  {/* A avulsa da subida no meio do período: não é a do mês. */}
                  {charge.kind === 'proration' && <span className="modern-badge-info">{t('charges.proration')}</span>}
                  {charge.kind === 'overage' && <span className="modern-badge-info">{t('charges.overage')}</span>}
                  {/* O crédito de indicação (ou do console) abatido nela (0106). */}
                  {(charge.creditCents ?? 0) > 0 && (
                    <span className="modern-badge-success">
                      {t('referrals.creditApplied', { amount: formatMoney(charge.creditCents ?? 0, charge.currency) })}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('charges.period')}: {formatDate(charge.periodEnd) ?? charge.periodEnd}
                  {formatDate(charge.dueDate) && ` · ${t('charges.dueDate')}: ${formatDate(charge.dueDate)}`}
                </p>
                {/* O plano e o excedente do período (0105), quando há excedente. */}
                <ChargePricingBreakdown pricing={charge.pricing} currency={charge.currency} />
                {/* A nota fiscal emitida: o número e o PDF, para o financeiro do
                    provedor. Só endereço `https:` vira link. */}
                {safeInvoiceUrl(charge.invoice?.pdfUrl) && (
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    {charge.invoice?.number && (
                      <span className="text-muted-foreground">{t('nfse.number', { number: charge.invoice.number })}</span>
                    )}
                    <a
                      href={safeInvoiceUrl(charge.invoice?.pdfUrl) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary hover:underline"
                    >
                      {t('nfse.pdf')}
                    </a>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Um status que este frontend ainda não conhece (backend mais novo)
                    aparece cru, que é pouco, mas é mais do que uma célula vazia. */}
                <span className={badgeClass(charge.status)}>
                  {STATUS_KEYS[charge.status] ? t(STATUS_KEYS[charge.status]) : charge.status}
                </span>
                {charge.invoiceUrl && (
                  /* `noopener` porque é endereço de terceiro, e o alvo ganharia
                     acesso a esta janela por `window.opener` sem ele. */
                  <a
                    href={charge.invoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="modern-button"
                  >
                    {t('charges.pay')}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default TenantCharges
