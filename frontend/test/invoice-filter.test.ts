import { describe, expect, it } from 'vitest'

import { filterInvoicesByStatus, invoiceStatusGroup, parseInvoiceStatusFilter } from '@/lib/invoice-filter'

const invoice = (status: string | null, paid = false) => ({ status, paid })

describe('invoiceStatusGroup', () => {
  it('reconhece títulos cancelados, com ou sem acento', () => {
    expect(invoiceStatusGroup(invoice('cancelado'))).toBe('cancelled')
    expect(invoiceStatusGroup(invoice('Cancelada'))).toBe('cancelled')
    expect(invoiceStatusGroup(invoice('Estornado'))).toBe('cancelled')
  })

  it('reconhece títulos em aberto', () => {
    expect(invoiceStatusGroup(invoice('aberto'))).toBe('open')
    expect(invoiceStatusGroup(invoice('Em Aberto'))).toBe('open')
    expect(invoiceStatusGroup(invoice('Pendente'))).toBe('open')
    expect(invoiceStatusGroup(invoice('Vencido'))).toBe('open')
  })

  it('sem situação e sem pagamento, o título está em aberto', () => {
    expect(invoiceStatusGroup(invoice(null))).toBe('open')
  })

  it('pagos e situações desconhecidas vão para "outros"', () => {
    expect(invoiceStatusGroup(invoice('pago', true))).toBe('other')
    expect(invoiceStatusGroup(invoice(null, true))).toBe('other')
    expect(invoiceStatusGroup(invoice('Renegociado'))).toBe('other')
  })
})

describe('filterInvoicesByStatus', () => {
  const invoices = [invoice('aberto'), invoice('cancelado'), invoice('cancelado'), invoice('renegociado')]

  it('conta cada grupo', () => {
    expect(filterInvoicesByStatus(invoices, 'all').counts).toEqual({ all: 4, open: 1, cancelled: 2, other: 1 })
  })

  it('mostra só o grupo escolhido', () => {
    expect(filterInvoicesByStatus(invoices, 'cancelled').visible).toHaveLength(2)
    expect(filterInvoicesByStatus(invoices, 'open').visible.map((i) => i.status)).toEqual(['aberto'])
    expect(filterInvoicesByStatus(invoices, 'all').visible).toHaveLength(4)
  })
})

describe('parseInvoiceStatusFilter', () => {
  it('volta para "em aberto" com valor ausente ou inválido', () => {
    expect(parseInvoiceStatusFilter(null)).toBe('open')
    expect(parseInvoiceStatusFilter('xyz')).toBe('open')
    expect(parseInvoiceStatusFilter('cancelled')).toBe('cancelled')
  })
})
