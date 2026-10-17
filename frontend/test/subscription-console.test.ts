import { describe, expect, it } from 'vitest'
import type { ChargeConsoleView, SubscriptionConsoleRow, SubscriptionStatus } from '@/lib/api'
import {
  centsToInput,
  chargeActions,
  computeChargeAmount,
  dayInputValue,
  dayKeySaoPaulo,
  endOfDayIso,
  deadlineOf,
  exemptCount,
  exemptUntilFromDateInput,
  filterRows,
  gatewayBadge,
  isBillingExempt,
  isChargeLate,
  openTotalsByCurrency,
  parseDay,
  parseExtendDays,
  parsePercent,
  refundPreview,
  saoPauloDay,
  summaryStatusCards,
  todayIso
} from '@/lib/subscription-console'

function row(
  id: number,
  name: string,
  status: SubscriptionStatus | null,
  open = false
): SubscriptionConsoleRow {
  return {
    tenant: { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), status: 'active' },
    subscription: status === null
      ? null
      : {
        status,
        storedStatus: status,
        planId: 1,
        planCode: 'basic',
        planName: 'Básico',
        priceCents: 9990,
        currency: 'BRL',
        trialEndsAt: null,
        renewsAt: null,
        pendingPlan: null
      },
    gateway: { gateway: null, linked: false },
    openCharge: open ? ({ id: id * 10, status: 'pending' } as ChargeConsoleView) : null
  }
}

describe('computeChargeAmount', () => {
  it('aceita um valor novo digitado em reais', () => {
    expect(computeChargeAmount(10000, 'value', '89,90')).toEqual({ ok: true, amountCents: 8990 })
  })

  it('recusa valor novo zero e texto ilegível', () => {
    expect(computeChargeAmount(10000, 'value', '0')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'value', 'abc')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('subtrai um desconto em reais', () => {
    expect(computeChargeAmount(19990, 'discountAmount', '20')).toEqual({ ok: true, amountCents: 17990 })
  })

  it('nunca deixa o desconto em reais zerar ou negativar a cobrança', () => {
    expect(computeChargeAmount(10000, 'discountAmount', '100')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'discountAmount', '150,00')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'discountAmount', '0')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('aplica percentual arredondando ao centavo', () => {
    expect(computeChargeAmount(9999, 'discountPercent', '10')).toEqual({ ok: true, amountCents: 8999 })
    expect(computeChargeAmount(10000, 'discountPercent', '12,5')).toEqual({ ok: true, amountCents: 8750 })
    expect(computeChargeAmount(333, 'discountPercent', '33.3%')).toEqual({ ok: true, amountCents: 222 })
  })

  it('recusa percentual fora de (0, 100) e o que arredonda para zero', () => {
    expect(computeChargeAmount(10000, 'discountPercent', '100')).toEqual({ ok: false, reason: 'nonPositive' })
    expect(computeChargeAmount(10000, 'discountPercent', '0')).toEqual({ ok: false, reason: 'invalid' })
    expect(computeChargeAmount(10000, 'discountPercent', '-5')).toEqual({ ok: false, reason: 'invalid' })
    expect(computeChargeAmount(1, 'discountPercent', '60')).toEqual({ ok: false, reason: 'nonPositive' })
  })
})

describe('parsePercent', () => {
  it('lê vírgula, ponto e o sinal de porcento', () => {
    expect(parsePercent('7,5')).toBe(7.5)
    expect(parsePercent(' 10 % ')).toBe(10)
    expect(parsePercent('dez')).toBeNull()
  })
})

describe('chargeActions', () => {
  const sub = (over: Partial<NonNullable<SubscriptionConsoleRow['subscription']>> = {}) => ({
    ...row(1, 'X', 'active').subscription!,
    renewsAt: '2026-10-10T02:59:59.000Z',
    ...over
  })
  const asaas = { gateway: 'asaas', linked: true }
  const manual = { gateway: null, linked: false }
  const ctx = { gateway: asaas, subscription: sub() }
  // 2026-10-10T02:59:59Z é 23:59:59 do dia 09/10 em São Paulo.
  const atual = '2026-10-09'

  const c = (over: Partial<ChargeConsoleView>) => ({
    status: 'pending' as const,
    invoiceUrl: 'https://x',
    gatewayChargeId: 'pay_1',
    periodEnd: atual,
    ...over
  })

  it('cobrança pendente no gateway oferece tudo menos reemitir', () => {
    expect(chargeActions(c({}), ctx)).toEqual({
      openInvoice: true,
      copyLink: true,
      settle: true,
      changeDueDate: true,
      changeAmount: true,
      cancel: true,
      reissue: false,
      refund: false
    })
  })

  it('sem link, não há fatura para abrir nem copiar', () => {
    const acoes = chargeActions(c({ status: 'overdue', invoiceUrl: null }), ctx)
    expect(acoes.openInvoice).toBe(false)
    expect(acoes.copyLink).toBe(false)
    expect(acoes.settle).toBe(true)
  })

  it('valor e vencimento pedem o id no gateway, ou provedor manual', () => {
    const semId = chargeActions(c({ gatewayChargeId: null }), ctx)
    expect(semId.changeAmount).toBe(false)
    expect(semId.changeDueDate).toBe(false)
    expect(semId.settle).toBe(true)
    const manualSemId = chargeActions(c({ gatewayChargeId: null }), { gateway: manual, subscription: sub() })
    expect(manualSemId.changeAmount).toBe(true)
    expect(manualSemId.changeDueDate).toBe(true)
  })

  it('reemite a cancelada ou falha do período atual com gateway ligado', () => {
    expect(chargeActions(c({ status: 'failed', gatewayChargeId: null }), ctx).reissue).toBe(true)
    expect(chargeActions(c({ status: 'canceled' }), ctx).reissue).toBe(true)
    // Período atual lido como instante também casa pelo dia de São Paulo.
    expect(chargeActions(c({ status: 'canceled', periodEnd: '2026-10-10T02:59:59.000Z' }), ctx).reissue).toBe(true)
  })

  it('não reemite período velho, sem gateway ligado, nem assinatura parada', () => {
    expect(chargeActions(c({ status: 'canceled', periodEnd: '2026-09-09' }), ctx).reissue).toBe(false)
    expect(chargeActions(c({ status: 'canceled' }), { gateway: manual, subscription: sub() }).reissue).toBe(false)
    expect(chargeActions(c({ status: 'canceled' }), { gateway: { gateway: 'asaas', linked: false }, subscription: sub() }).reissue)
      .toBe(false)
    for (const status of ['suspended', 'canceled'] as const) {
      expect(chargeActions(c({ status: 'canceled' }), { gateway: asaas, subscription: sub({ status, storedStatus: status }) }).reissue)
        .toBe(false)
    }
    expect(chargeActions(c({ status: 'canceled' }), { gateway: asaas, subscription: null }).reissue).toBe(false)
  })

  it('a pró-rata só se reemite quando a criação falhou no gateway', () => {
    const pr = (over: Partial<ChargeConsoleView>) => c({ kind: 'proration', ...over })
    expect(chargeActions(pr({ status: 'failed', gatewayChargeId: null }), ctx).reissue).toBe(true)
    // De qualquer período: a dela é o do momento da subida, não a chave da renovação.
    expect(chargeActions(pr({ status: 'failed', gatewayChargeId: null, periodEnd: '2026-09-09' }), ctx).reissue).toBe(true)
    expect(chargeActions(pr({ status: 'canceled' }), ctx).reissue).toBe(false)
    expect(chargeActions(pr({ status: 'failed', gatewayChargeId: null }), { gateway: manual, subscription: sub() }).reissue)
      .toBe(false)
    expect(chargeActions(pr({ status: 'failed', gatewayChargeId: null }), { gateway: asaas, subscription: sub({ billingExempt: true }) })
      .reissue).toBe(false)
  })

  it('isento de cobrança não reemite', () => {
    expect(chargeActions(c({ status: 'canceled' }), ctx).reissue).toBe(true)
    expect(chargeActions(c({ status: 'canceled' }), { gateway: asaas, subscription: sub({ billingExempt: true }) }).reissue)
      .toBe(false)
  })

  it('em teste, o período atual é o fim do teste', () => {
    const trial = sub({ status: 'trial', storedStatus: 'trial', trialEndsAt: '2026-10-01', renewsAt: null })
    expect(chargeActions(c({ status: 'failed', periodEnd: '2026-10-01' }), { gateway: asaas, subscription: trial }).reissue).toBe(true)
  })

  it('paga oferece só o estorno, com gateway ou manual', () => {
    for (const context of [ctx, { gateway: manual, subscription: sub() }, { gateway: asaas, subscription: null }]) {
      const acoes = chargeActions(c({ status: 'paid' }), context)
      expect(acoes.refund).toBe(true)
      expect(Object.entries(acoes).filter(([, v]) => v).map(([k]) => k)).toEqual(['refund'])
    }
    expect(chargeActions(c({ status: 'paid', gatewayChargeId: null, invoiceUrl: null }), ctx).refund).toBe(true)
  })

  it('estornada não oferece nada, e nenhuma outra situação estorna', () => {
    expect(Object.values(chargeActions(c({ status: 'refunded' }), ctx)).some(Boolean)).toBe(false)
    for (const status of ['pending', 'overdue', 'failed', 'canceled'] as const) {
      expect(chargeActions(c({ status }), ctx).refund).toBe(false)
    }
  })
})

describe('refundPreview', () => {
  const agora = new Date('2026-09-28T15:00:00Z')

  it('volta os dias do período a partir do instante', () => {
    expect(refundPreview('2026-11-10T02:59:59.000Z', 30, agora))
      .toEqual({ renewsAt: '2026-10-11T02:59:59.000Z', past: false })
  })

  it('avisa quando o prazo novo já passou', () => {
    expect(refundPreview('2026-10-10T02:59:59.000Z', 30, agora))
      .toEqual({ renewsAt: '2026-09-10T02:59:59.000Z', past: true })
  })

  it('conta dia puro no calendário, com hoje ainda valendo', () => {
    expect(refundPreview('2026-10-28', 30, agora)).toEqual({ renewsAt: '2026-09-28', past: false })
    expect(refundPreview('2026-10-27', 30, agora)).toEqual({ renewsAt: '2026-09-27', past: true })
    expect(refundPreview('2026-03-01', 1, agora)?.renewsAt).toBe('2026-02-28')
  })

  it('sem prazo ou com dias inválidos não prevê nada', () => {
    expect(refundPreview(null, 30, agora)).toBeNull()
    expect(refundPreview('lixo', 30, agora)).toBeNull()
    expect(refundPreview('2026-10-10', 0, agora)).toBeNull()
    expect(refundPreview('2026-10-10', 2.5, agora)).toBeNull()
    expect(refundPreview('2026-10-10', null, agora)).toBeNull()
  })
})

describe('calendário de São Paulo', () => {
  it('hoje é o dia de São Paulo, não o do navegador', () => {
    // 01:30 UTC do dia 29 ainda é 22:30 do dia 28 em São Paulo (UTC-3).
    expect(todayIso(new Date('2026-09-29T01:30:00Z'))).toBe('2026-09-28')
    expect(todayIso(new Date('2026-09-29T03:30:00Z'))).toBe('2026-09-29')
    expect(saoPauloDay(new Date('2026-12-31T23:00:00Z'))).toBe('2026-12-31')
  })

  it('a chave de dia mantém AAAA-MM-DD e converte instantes', () => {
    expect(dayKeySaoPaulo('2026-10-10')).toBe('2026-10-10')
    expect(dayKeySaoPaulo('2026-10-10T02:00:00.000Z')).toBe('2026-10-09')
    expect(dayKeySaoPaulo(null)).toBe('')
    expect(dayKeySaoPaulo('lixo')).toBe('')
  })

  it('vencida conta pelo dia de São Paulo', () => {
    const noite = new Date('2026-09-29T01:30:00Z') // 28/09 em São Paulo
    expect(isChargeLate({ status: 'pending', dueDate: '2026-09-28' }, noite)).toBe(false)
    expect(isChargeLate({ status: 'pending', dueDate: '2026-09-27' }, noite)).toBe(true)
  })
})

describe('openTotalsByCurrency', () => {
  const com = (currency: string, amountCents: number) =>
    ({ openCharge: { currency, amountCents } as ChargeConsoleView })

  it('soma por moeda, BRL primeiro, e ignora quem não tem cobrança', () => {
    expect(openTotalsByCurrency([com('USD', 500), com('BRL', 1000), { openCharge: null }, com('brl', 250)])).toEqual([
      { currency: 'BRL', cents: 1250 },
      { currency: 'USD', cents: 500 }
    ])
    expect(openTotalsByCurrency([])).toEqual([])
  })
})

describe('filterRows', () => {
  const rows = [
    row(1, 'São João Net', 'active', true),
    row(2, 'Fibra Sul', 'past_due', true),
    row(3, 'Rede Norte', 'trial'),
    row(4, 'Sem Plano', null)
  ]

  it('sem filtro devolve tudo', () => {
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: false, search: '' })).toHaveLength(4)
  })

  it('filtra por estado, incluindo quem não tem assinatura', () => {
    expect(filterRows(rows, { statuses: ['past_due', 'none'], onlyOpenCharge: false, search: '' }).map((r) => r.tenant.id))
      .toEqual([2, 4])
  })

  it('filtra só quem tem cobrança em aberto', () => {
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: true, search: '' }).map((r) => r.tenant.id)).toEqual([1, 2])
  })

  it('busca pelo nome sem caixa nem acento, e pelo slug', () => {
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: false, search: 'sao joao' }).map((r) => r.tenant.id)).toEqual([1])
    expect(filterRows(rows, { statuses: [], onlyOpenCharge: false, search: 'rede-norte' }).map((r) => r.tenant.id)).toEqual([3])
  })

  it('filtra só os isentos de cobrança', () => {
    const comIsento = [...rows, { ...row(5, 'Isenta', 'active'), subscription: { ...row(5, 'Isenta', 'active').subscription!, billingExempt: true } }]
    expect(filterRows(comIsento, { statuses: [], onlyOpenCharge: false, search: '', onlyExempt: true }).map((r) => r.tenant.id))
      .toEqual([5])
    expect(filterRows(comIsento, { statuses: ['active'], onlyOpenCharge: false, search: '', onlyExempt: false }).map((r) => r.tenant.id))
      .toEqual([1, 5])
  })

  it('combina os filtros', () => {
    expect(filterRows(rows, { statuses: ['active', 'trial'], onlyOpenCharge: true, search: 'net' }).map((r) => r.tenant.id))
      .toEqual([1])
  })
})

describe('isenção de cobrança', () => {
  it('campo ausente ou falso não é isento', () => {
    expect(isBillingExempt(null)).toBe(false)
    expect(isBillingExempt({})).toBe(false)
    expect(isBillingExempt({ billingExempt: false })).toBe(false)
    expect(isBillingExempt({ billingExempt: true })).toBe(true)
  })

  it('conta pelo resumo do servidor, ou pelas linhas sem o campo', () => {
    const isenta = { ...row(1, 'A', 'active'), subscription: { ...row(1, 'A', 'active').subscription!, billingExempt: true } }
    const linhas = [isenta, row(2, 'B', 'active')]
    expect(exemptCount({ exempt: 7 }, linhas)).toBe(7)
    expect(exemptCount(null, linhas)).toBe(1)
    expect(exemptCount({}, linhas)).toBe(1)
  })
})

describe('summaryStatusCards', () => {
  it('segue a ordem da tela e conta zero para o que faltar', () => {
    const cards = summaryStatusCards({
      byStatus: { active: 5, trial: 2, past_due: 1, suspended: 0, canceled: 3 } as never
    })
    expect(cards.map((c) => [c.status, c.count])).toEqual([
      ['active', 5], ['trial', 2], ['past_due', 1], ['suspended', 0], ['canceled', 3], ['none', 0]
    ])
    expect(cards[0].labelKey).toBe('platform.subs.status.active')
  })

  it('sem resumo, tudo zero', () => {
    expect(summaryStatusCards(null).every((c) => c.count === 0)).toBe(true)
  })
})

describe('gatewayBadge', () => {
  it('distingue gateway ligado, não ligado e manual', () => {
    expect(gatewayBadge({ gateway: 'asaas', linked: true })).toEqual({ kind: 'gateway', name: 'Asaas' })
    expect(gatewayBadge({ gateway: 'asaas', linked: false })).toEqual({ kind: 'unlinked', name: 'Asaas' })
    expect(gatewayBadge({ gateway: null, linked: false })).toEqual({ kind: 'manual' })
    expect(gatewayBadge({ gateway: 'manual', linked: true })).toEqual({ kind: 'manual' })
  })
})

describe('datas', () => {
  it('lê AAAA-MM-DD como meia-noite local, não UTC', () => {
    const d = parseDay('2026-10-10')
    expect(d?.getFullYear()).toBe(2026)
    expect(d?.getMonth()).toBe(9)
    expect(d?.getDate()).toBe(10)
    expect(dayInputValue('2026-10-10')).toBe('2026-10-10')
    expect(parseDay('lixo')).toBeNull()
    expect(dayInputValue(null)).toBe('')
  })

  it('pendente com vencimento para trás conta como vencida', () => {
    const agora = new Date(2026, 8, 28, 12)
    expect(isChargeLate({ status: 'pending', dueDate: '2026-09-27' }, agora)).toBe(true)
    expect(isChargeLate({ status: 'pending', dueDate: '2026-09-28' }, agora)).toBe(false)
    expect(isChargeLate({ status: 'overdue', dueDate: null }, agora)).toBe(true)
    expect(isChargeLate({ status: 'paid', dueDate: '2020-01-01' }, agora)).toBe(false)
  })

  it('o prazo da linha é o fim do teste em teste, e a renovação nos demais', () => {
    const base = row(1, 'X', 'trial').subscription!
    expect(deadlineOf({ ...base, trialEndsAt: '2026-10-01', renewsAt: '2026-11-01' })).toEqual({ kind: 'trial', date: '2026-10-01' })
    expect(deadlineOf({ ...base, storedStatus: 'active', renewsAt: '2026-11-01' })).toEqual({ kind: 'paid', date: '2026-11-01' })
    expect(deadlineOf(null)).toBeNull()
  })

  it('lê os dias a estender', () => {
    expect(parseExtendDays('15')).toBe(15)
    expect(parseExtendDays('0')).toBeNull()
    expect(parseExtendDays('2,5')).toBeNull()
    expect(parseExtendDays('365')).toBe(365)
    expect(parseExtendDays('366')).toBeNull()
  })
})

describe('endOfDayIso', () => {
  it('manda o fim do dia local, que volta ao mesmo dia no input', () => {
    const iso = endOfDayIso('2026-10-10')
    expect(iso).not.toBeNull()
    expect(dayInputValue(iso)).toBe('2026-10-10')
    expect(endOfDayIso('')).toBeNull()
  })
})

describe('centsToInput', () => {
  it('escreve centavos como se digita', () => {
    expect(centsToInput(19990)).toBe('199,90')
    expect(centsToInput(5)).toBe('0,05')
  })
})

describe('exemptUntilFromDateInput', () => {
  const agora = new Date(2026, 9, 3, 12, 0, 0)

  it('vazio é sem data de fim', () => {
    expect(exemptUntilFromDateInput('', agora)).toBeNull()
    expect(exemptUntilFromDateInput('   ', agora)).toBeNull()
  })

  it('o dia escolhido vira o fim daquele dia, no fuso de quem escolheu', () => {
    const iso = exemptUntilFromDateInput('2026-10-10', agora)
    expect(iso).toBe(new Date(2026, 9, 10, 23, 59, 59).toISOString())
    expect(exemptUntilFromDateInput('2026-10-03', agora)).toBe(new Date(2026, 9, 3, 23, 59, 59).toISOString())
  })

  it('o dia que já acabou ou ilegível é recusado antes de enviar', () => {
    expect(exemptUntilFromDateInput('2026-10-02', agora)).toBeUndefined()
    expect(exemptUntilFromDateInput('10/10/2026', agora)).toBeUndefined()
    expect(exemptUntilFromDateInput('amanhã', agora)).toBeUndefined()
  })
})
