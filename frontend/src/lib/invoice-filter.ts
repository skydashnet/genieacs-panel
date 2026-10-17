import type { SgpInvoice } from '@/lib/api'

export type InvoiceStatusGroup = 'open' | 'cancelled' | 'other'
export type InvoiceStatusFilter = 'all' | InvoiceStatusGroup

const FILTERS: readonly InvoiceStatusFilter[] = ['all', 'open', 'cancelled', 'other']

// O SGP escreve a situação do título em texto livre, cada provedor do seu
// jeito. Cancelamento é testado primeiro: "cancelado" nunca pode cair em
// "aberto" por acaso.
const CANCELLED = /cancel|estorn|exclu|anulad/
const OPEN = /abert|pendent|vencid|vencer|atras|gerad|emitid|aguard/

function normalize(value: string | null) {
  return (value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Em que grupo do filtro o título cai. Sem situação informada e sem
 * pagamento, o título está em aberto — é o que o SGP devolve quando só manda
 * os títulos em aberto.
 */
export function invoiceStatusGroup(invoice: Pick<SgpInvoice, 'status' | 'paid'>): InvoiceStatusGroup {
  const status = normalize(invoice.status)
  if (CANCELLED.test(status)) return 'cancelled'
  if (invoice.paid) return 'other'
  if (!status || OPEN.test(status)) return 'open'
  return 'other'
}

/** Valor salvo no navegador; qualquer coisa desconhecida volta para "em aberto". */
export function parseInvoiceStatusFilter(value: string | null | undefined): InvoiceStatusFilter {
  return FILTERS.includes(value as InvoiceStatusFilter) ? (value as InvoiceStatusFilter) : 'open'
}

export function filterInvoicesByStatus<T extends Pick<SgpInvoice, 'status' | 'paid'>>(
  invoices: readonly T[],
  filter: InvoiceStatusFilter
) {
  const counts: Record<InvoiceStatusFilter, number> = { all: invoices.length, open: 0, cancelled: 0, other: 0 }
  for (const invoice of invoices) counts[invoiceStatusGroup(invoice)] += 1
  const visible = filter === 'all'
    ? [...invoices]
    : invoices.filter((invoice) => invoiceStatusGroup(invoice) === filter)
  return { visible, counts }
}
