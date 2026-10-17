import { describe, expect, it } from 'vitest'

import type { DelinquencyRow } from '@/lib/api'
import {
  MAX_SELECTION, delinquencyCsv, newRequestId, parseBulkDays, pruneSelection, resultCodeKey, toggleAll, toggleSelection
} from '@/lib/delinquency'
import en from '@/lib/i18n/locales/en'

/** As peças puras do painel de inadimplência: seleção, cortesia, códigos e planilha. */

function linha(id: number, patch: Partial<DelinquencyRow> = {}): DelinquencyRow {
  return {
    tenant: { id, name: `Provedor ${id}`, slug: `p${id}`, status: 'active' },
    status: 'past_due',
    storedStatus: 'active',
    suspendedReason: null,
    overdueReason: 'renewal_expired',
    overdueSince: '2026-09-18T12:00:00.000Z',
    daysOverdue: 20,
    bucket: '16-30',
    amountCents: 12500,
    amountByKind: { renewal: 10000, proration: 2500, overage: 0 },
    openCents: 22500,
    currency: 'BRL',
    overdueCharges: 2,
    plan: { id: 1, code: 'pro', name: 'Pro' },
    renewsAt: '2026-09-18T12:00:00.000Z',
    trialEndsAt: null,
    lastReminder: null,
    autoSuspendAt: '2026-10-11T12:00:00.000Z',
    autoSuspendWarned: false,
    card: {
      autopayEnabled: true, autopaySince: null, saved: true, brand: 'VISA', last4: '4242',
      savedAt: null, failedAt: null, failure: null
    },
    gateway: { gateway: 'asaas', linked: true },
    ...patch
  }
}

describe('a seleção', () => {
  it('liga e desliga um, sem passar do teto', () => {
    expect(toggleSelection([1, 2], 2)).toEqual([1])
    expect(toggleSelection([1], 3)).toEqual([1, 3])
    const cheia = Array.from({ length: MAX_SELECTION }, (_, i) => i + 1)
    expect(toggleSelection(cheia, 999)).toBe(cheia)
  })

  it('"todos" liga os visíveis até o teto, e desliga quando já estão todos', () => {
    expect(toggleAll([9], [1, 2])).toEqual([9, 1, 2])
    expect(toggleAll([9, 1, 2], [1, 2])).toEqual([9])
    const muitos = Array.from({ length: MAX_SELECTION + 10 }, (_, i) => i + 1)
    expect(toggleAll([], muitos)).toHaveLength(MAX_SELECTION)
  })

  it('esquece quem saiu da lista', () => {
    expect(pruneSelection([1, 2, 3], [linha(1), linha(3)])).toEqual([1, 3])
  })
})

describe('a cortesia em massa', () => {
  it('aceita só inteiros de 1 a 60', () => {
    expect(parseBulkDays('7')).toBe(7)
    expect(parseBulkDays(' 60 ')).toBe(60)
    for (const ruim of ['0', '61', '1.5', '-3', '', 'dez']) expect(parseBulkDays(ruim)).toBeNull()
  })
})

describe('os códigos de resultado', () => {
  it('têm frase, e o desconhecido cai em "erro"', () => {
    for (const code of ['sent', 'rate_limited', 'not_overdue', 'gateway_failed', 'subscription_canceled', 'not_found']) {
      expect(en[resultCodeKey(code)]).toBeTruthy()
    }
    expect(resultCodeKey('qualquer_coisa')).toBe('platform.delinq.code.error')
  })
})

describe('a planilha', () => {
  it('traz uma linha por provedor, com BOM, `;` e a fórmula neutralizada', () => {
    const csv = delinquencyCsv([
      linha(1),
      linha(2, { tenant: { id: 2, name: '=HYPERLINK("x")', slug: 'p2', status: 'active' }, status: 'suspended', suspendedReason: 'auto_nonpayment' })
    ], ['id', 'nome'])
    expect(csv.startsWith('\uFEFFid;nome\r\n')).toBe(true)
    const [, primeira, segunda] = csv.trim().split('\r\n')
    expect(primeira).toBe('1;Provedor 1;p1;past_due;BRL;125.00;100.00;25.00;0.00;2026-09-18;20;16-30;;2026-10-11T12:00:00.000Z;VISA 4242')
    expect(segunda).toContain('"\'=HYPERLINK(""x"")"')
    expect(segunda).toContain('suspended:auto_nonpayment')
  })

  it('neutraliza toda célula que começa com = + - @ (também depois de espaço ou quebra de linha)', () => {
    const nomes = ['+SUM(1)', '-2+3', '@cmd', ' =1+1', '\n=1+1', '\tx']
    const csv = delinquencyCsv(nomes.map((name, i) => linha(i + 1, {
      tenant: { id: i + 1, name, slug: `p${i + 1}`, status: 'active' }
    })), ['id'])
    const celulas = csv.trim().split(/\r\n(?=\d+;)/).slice(1).map((l) => l.split(';')[1])
    for (const celula of celulas) expect(celula.replace(/^"/, '').startsWith("'")).toBe(true)
    // Número negativo é número, não fórmula.
    const negativo = delinquencyCsv([linha(9, { daysOverdue: -3 })], ['id'])
    expect(negativo).toContain(';-3;')
  })
})

describe('a chave do pedido', () => {
  it('tem o formato que o servidor aceita e muda a cada chamada', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    expect(a).not.toBe(b)
  })
})
