import type { InvoiceStatus, TenantInvoiceView } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * A NFS-e de uma cobrança, nas telas: o rótulo de cada estado, a cor do selo
 * e quando o console oferece "emitir nota".
 *
 * Funções puras, fora dos componentes, pelo motivo de `subscription-console`:
 * a regra do botão é a mesma na aba Assinaturas e no Extrato, e uma cópia em
 * cada tela é a que um dia discorda da outra.
 */

export const INVOICE_STATUS_LABEL_KEYS: Record<InvoiceStatus, TranslationKey> = {
  pending: 'nfse.status.pending',
  scheduled: 'nfse.status.scheduled',
  authorized: 'nfse.status.authorized',
  error: 'nfse.status.error',
  canceling: 'nfse.status.canceling',
  canceled: 'nfse.status.canceled'
}

/** O rótulo de um estado — ou nulo, quando o backend é mais novo que a tela. */
export function invoiceStatusKey(status: string): TranslationKey | null {
  return (INVOICE_STATUS_LABEL_KEYS as Record<string, TranslationKey>)[status] ?? null
}

export function invoiceBadgeClass(status: string) {
  if (status === 'authorized') return 'modern-badge-success'
  if (status === 'pending' || status === 'scheduled' || status === 'canceling') return 'modern-badge-warning'
  if (status === 'error') return 'modern-badge-error'
  return 'modern-badge'
}

/**
 * O endereço do PDF/XML da nota, só se for `https:` — ou nulo.
 *
 * O backend já recusa outro esquema ao gravar; a tela confere de novo porque
 * é ela que põe o endereço num `href`, e um `javascript:` ali seria código
 * rodando no painel.
 */
export function safeInvoiceUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Os estados de que o console pode pedir outra nota para a mesma cobrança. */
const REEMITIVEIS = new Set<string>(['error', 'canceled'])

/**
 * Se o console oferece emitir (ou reemitir) a nota desta cobrança.
 *
 * Só da cobrança PAGA pelo gateway — a baixa sem id lá não tem pagamento da
 * Asaas a que a nota aponte — e sem nota viva: a que está na fila, sendo
 * processada ou emitida não ganha outra. O backend confere tudo de novo; a
 * regra aqui é só para não mostrar um botão que ele sempre recusaria.
 */
export function canIssueInvoice(charge: {
  status: string
  gatewayChargeId?: string | null
  invoice?: Pick<TenantInvoiceView, 'status'> | null
}) {
  if (charge.status !== 'paid' || !charge.gatewayChargeId) return false
  return !charge.invoice || REEMITIVEIS.has(charge.invoice.status)
}

/** O mesmo, para uma linha do extrato: o pagamento com a cobrança dele. */
export function canIssueInvoiceForEvent(event: {
  type: string
  chargeId?: number | null
  invoice?: Pick<TenantInvoiceView, 'status'> | null
}) {
  if (event.type !== 'payment.recorded' || !event.chargeId) return false
  return !event.invoice || REEMITIVEIS.has(event.invoice.status)
}
