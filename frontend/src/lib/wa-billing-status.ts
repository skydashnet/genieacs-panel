import type { TranslationKey } from '@/lib/i18n'

/** A situação financeira do contrato: em dia, vence hoje, atrasado. */
export type BillingStatus = 'ok' | 'due_today' | 'overdue'

export interface ConversationBilling {
  status: BillingStatus
  daysOverdue: number
  oldestDueDate: string | null
  checkedAt: string | null
}

// Classes escritas por inteiro: o Tailwind só gera o que aparece no código.
/** A moldura da linha da conversa. */
export const BILLING_FRAME: Record<BillingStatus, string> = {
  ok: 'ring-2 ring-inset ring-[hsl(var(--status-success)/0.55)]',
  due_today: 'ring-2 ring-inset ring-[hsl(var(--status-warning)/0.75)]',
  overdue: 'ring-2 ring-inset ring-[hsl(var(--status-danger)/0.75)]'
}

/** O selo (contrato, rótulo): borda, fundo e texto na cor. */
export const BILLING_BADGE: Record<BillingStatus, string> = {
  ok: 'border-[hsl(var(--status-success)/0.5)] bg-[hsl(var(--status-success)/0.12)] text-[hsl(var(--status-success))]',
  due_today: 'border-[hsl(var(--status-warning)/0.6)] bg-[hsl(var(--status-warning)/0.14)] text-[hsl(var(--status-warning))]',
  overdue: 'border-[hsl(var(--status-danger)/0.6)] bg-[hsl(var(--status-danger)/0.12)] text-[hsl(var(--status-danger))]'
}

/** A borda de uma fatura no Módulo SGP. */
export const BILLING_BORDER: Record<BillingStatus, string> = {
  ok: 'border-[hsl(var(--status-success)/0.6)]',
  due_today: 'border-[hsl(var(--status-warning))]',
  overdue: 'border-[hsl(var(--status-danger))]'
}

export function billingLabel(status: BillingStatus, daysOverdue = 0): { key: TranslationKey; vars?: Record<string, number> } {
  if (status === 'overdue') return { key: 'whatsapp.billing.statusOverdue', vars: { days: daysOverdue } }
  if (status === 'due_today') return { key: 'whatsapp.billing.statusDueToday' }
  return { key: 'whatsapp.billing.statusOk' }
}

/** Hoje (`AAAA-MM-DD`) no fuso do provedor. */
export function todayIn(now = new Date(), timeZone = 'America/Sao_Paulo'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/**
 * A situação de uma fatura pela data de vencimento, a mesma regra do
 * servidor: vencida é vermelha, vence hoje é amarela, a vencer é verde.
 */
export function invoiceStatus(dueDate: string | null | undefined, now = new Date()): { status: BillingStatus; daysOverdue: number } | null {
  const venc = String(dueDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return null
  const dias = Math.round((Date.parse(`${todayIn(now)}T00:00:00Z`) - Date.parse(`${venc}T00:00:00Z`)) / 86_400_000)
  if (dias > 0) return { status: 'overdue', daysOverdue: dias }
  if (dias === 0) return { status: 'due_today', daysOverdue: 0 }
  return { status: 'ok', daysOverdue: 0 }
}
