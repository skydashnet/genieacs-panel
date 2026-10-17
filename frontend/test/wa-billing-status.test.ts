import { describe, expect, it } from 'vitest'
import { billingLabel, invoiceStatus } from '@/lib/wa-billing-status'

describe('invoiceStatus', () => {
  const agora = new Date('2026-10-06T15:00:00Z') // 12h em São Paulo
  it('vencida, vence hoje e a vencer', () => {
    expect(invoiceStatus('2026-10-03', agora)).toEqual({ status: 'overdue', daysOverdue: 3 })
    expect(invoiceStatus('2026-10-06', agora)).toEqual({ status: 'due_today', daysOverdue: 0 })
    expect(invoiceStatus('2026-10-10', agora)).toEqual({ status: 'ok', daysOverdue: 0 })
    expect(invoiceStatus(null, agora)).toBeNull()
  })
  it('às 23h em São Paulo ainda é hoje', () => {
    expect(invoiceStatus('2026-10-05', new Date('2026-10-06T02:00:00Z'))?.status).toBe('due_today')
  })
  it('rótulo', () => {
    expect(billingLabel('overdue', 4)).toEqual({ key: 'whatsapp.billing.statusOverdue', vars: { days: 4 } })
  })
})
