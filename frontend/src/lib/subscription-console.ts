import { formatDayPart, getActiveDateFormat } from '@/lib/date-format'
import { getIntlLocale } from '@/lib/i18n'
import type {
  ChargeConsoleView,
  SubscriptionConsoleRow,
  SubscriptionConsoleStatus,
  SubscriptionConsoleSummary
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { parseAmountToCents } from '@/lib/utils'

/**
 * A lógica da aba Assinaturas do console, fora do componente para poder ser
 * testada sem DOM: conta de desconto, quais botões uma cobrança oferece,
 * filtro da lista e os rótulos do resumo.
 */

export type ChargeStatus = ChargeConsoleView['status']

/**
 * As três situações em que ainda há o que cobrar. `failed` entra porque é a
 * emissão que o gateway recusou: a dívida existe, só não chegou ao cliente.
 */
export const OPEN_CHARGE_STATUSES: readonly ChargeStatus[] = ['pending', 'failed', 'overdue']

export function isChargeOpen(status: ChargeStatus) {
  return OPEN_CHARGE_STATUSES.includes(status)
}

export interface ChargeActions {
  openInvoice: boolean
  copyLink: boolean
  settle: boolean
  changeDueDate: boolean
  changeAmount: boolean
  cancel: boolean
  reissue: boolean
  refund: boolean
}

/**
 * O que, da linha, decide as ações de uma cobrança: quem cobra este provedor e
 * em que pé está a assinatura dele.
 */
export interface ChargeContext {
  gateway: SubscriptionConsoleRow['gateway']
  subscription: SubscriptionConsoleRow['subscription']
}

/**
 * Quais ações uma cobrança oferece — espelho das regras do backend, para a tela
 * não oferecer botão que só vai render um 409.
 *
 * - Tudo o que mexe em dinheiro só vale para a cobrança em aberto.
 * - Mudar valor ou vencimento exige a cobrança existir no gateway (tem
 *   `gatewayChargeId`) ou o provedor ser cobrado à mão: com gateway e sem o id,
 *   a emissão falhou e não há lá o que alterar — o caminho é reemitir.
 * - Com a assinatura isenta de cobrança, não se reemite nada.
 * - Reemitir é o caminho de volta da cancelada e da que falhou, mas só da
 *   cobrança do período ATUAL (a que vence no prazo corrente da assinatura),
 *   com o provedor ligado a um gateway e a assinatura não suspensa nem
 *   cancelada. Período velho não se cobra de novo por aqui.
 * - O link da fatura depende de ele existir; a emissão manual não tem página.
 * - Estornar é só da paga, venha ela do gateway ou da baixa manual: na manual
 *   o dinheiro volta por fora e o painel só registra.
 */
export function chargeActions(
  charge: Pick<ChargeConsoleView, 'status' | 'invoiceUrl' | 'gatewayChargeId' | 'periodEnd' | 'kind'>,
  context: ChargeContext
): ChargeActions {
  const open = isChargeOpen(charge.status)
  const link = open && Boolean(charge.invoiceUrl)
  const badge = gatewayBadge(context.gateway)
  const manual = badge.kind === 'manual'
  const editable = open && (Boolean(charge.gatewayChargeId) || manual)
  const sub = context.subscription
  const bloqueada = !sub
    || sub.storedStatus === 'suspended' || sub.storedStatus === 'canceled'
    || sub.status === 'suspended' || sub.status === 'canceled'
  const prazo = deadlineOf(sub)
  // Isento não recebe fatura: reemitir geraria justamente a cobrança que a
  // isenção cancelou (o backend recusa).
  const isento = isBillingExempt(sub)
  const periodoAtual = prazo !== null && dayKeySaoPaulo(prazo.date) === dayKeySaoPaulo(charge.periodEnd)
  return {
    openInvoice: link,
    copyLink: link,
    settle: open,
    changeDueDate: editable,
    changeAmount: editable,
    cancel: open,
    // A pró-rata (avulsa da subida) só se reemite quando a criação FALHOU no
    // gateway — é a retentativa dela; cancelada fica cancelada, e o período
    // dela não é a chave de nada.
    reissue: charge.kind === 'proration' || charge.kind === 'overage'
      ? charge.status === 'failed' && !charge.gatewayChargeId && badge.kind === 'gateway' && !isento
      : (charge.status === 'canceled' || charge.status === 'failed')
        && badge.kind === 'gateway' && !bloqueada && !isento && periodoAtual,
    refund: charge.status === 'paid'
  }
}

const DIA_MS = 24 * 60 * 60 * 1000

/**
 * O "pago até" que um estorno deixaria, para a tela avisar ANTES de confirmar.
 *
 * O estorno desfaz o período que o pagamento comprou: o prazo volta
 * `periodDays` dias. É estimativa — quem decide é o servidor, que sabe quantos
 * dias aquele pagamento comprou de fato; a tela usa os dias do plano atual. O
 * número de verdade chega na resposta (`renewsAtAfter`).
 *
 * `past` diz se o prazo novo já passou: aí o provedor fica em atraso e o painel
 * dele é bloqueado, e isso tem que estar escrito no diálogo. Sem prazo ou com
 * dias inválidos não há o que prever: nulo.
 */
export function refundPreview(
  renewsAt: string | null | undefined,
  periodDays: number | null | undefined,
  now: Date = new Date()
): { renewsAt: string; past: boolean } | null {
  const dias = Number(periodDays)
  if (!renewsAt || !Number.isInteger(dias) || dias < 1) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(renewsAt)) {
    // Dia puro: conta no calendário, ao meio-dia UTC para o horário de verão
    // de lugar nenhum mudar o dia.
    const data = new Date(`${renewsAt}T12:00:00Z`)
    if (Number.isNaN(data.getTime())) return null
    data.setUTCDate(data.getUTCDate() - dias)
    const dia = data.toISOString().slice(0, 10)
    return { renewsAt: dia, past: dia < todayIso(now) }
  }
  const instante = new Date(renewsAt)
  if (Number.isNaN(instante.getTime())) return null
  const novo = new Date(instante.getTime() - dias * DIA_MS)
  return { renewsAt: novo.toISOString(), past: novo.getTime() <= now.getTime() }
}

export type AmountMode = 'value' | 'discountAmount' | 'discountPercent'

export type AmountResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: 'invalid' | 'nonPositive' }

/**
 * Lê um percentual digitado: "10", "12,5", "12.5", "10%". Aceita só entre 0 e
 * 100, exclusivos — desconto de 0% não é desconto e de 100% zera a cobrança.
 *
 * É percentual e não dinheiro, por isso não passa por `parseAmountToCents`:
 * aqui não existe separador de milhar para confundir com o decimal.
 */
export function parsePercent(digitado: string): number | null {
  const texto = String(digitado ?? '').trim().replace(/%$/, '').trim().replace(/,/, '.')
  if (!/^\d+(\.\d+)?$/.test(texto)) return null
  const valor = Number(texto)
  return Number.isFinite(valor) ? valor : null
}

/**
 * O novo valor de uma cobrança, a partir do que foi digitado em um dos três
 * modos: valor novo, desconto em reais ou desconto em percentual.
 *
 * Arredonda para o centavo mais próximo (10% de R$ 99,99 dá R$ 89,99, não
 * 89,991) e nunca devolve zero nem negativo: uma cobrança de R$ 0 não é uma
 * cobrança, é um cancelamento com outro nome, e para isso há o botão certo.
 */
export function computeChargeAmount(baseCents: number, mode: AmountMode, digitado: string): AmountResult {
  if (mode === 'value') {
    const cents = parseAmountToCents(digitado)
    if (cents === null) return { ok: false, reason: 'invalid' }
    return cents > 0 ? { ok: true, amountCents: cents } : { ok: false, reason: 'nonPositive' }
  }
  if (mode === 'discountAmount') {
    const desconto = parseAmountToCents(digitado)
    if (desconto === null || desconto <= 0) return { ok: false, reason: 'invalid' }
    const cents = baseCents - desconto
    return cents > 0 ? { ok: true, amountCents: cents } : { ok: false, reason: 'nonPositive' }
  }
  const pct = parsePercent(digitado)
  if (pct === null || pct <= 0) return { ok: false, reason: 'invalid' }
  if (pct >= 100) return { ok: false, reason: 'nonPositive' }
  const cents = Math.round(baseCents * (1 - pct / 100))
  return cents > 0 ? { ok: true, amountCents: cents } : { ok: false, reason: 'nonPositive' }
}

/** Centavos no formato em que se digita um valor: "199,90", sem símbolo nem milhar. */
export function centsToInput(cents: number) {
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** O estado de uma linha; o provedor sem assinatura é `none`. */
export function rowStatus(row: Pick<SubscriptionConsoleRow, 'subscription'>): SubscriptionConsoleStatus {
  return row.subscription?.status ?? 'none'
}

/** A assinatura está isenta de cobrança? Campo ausente (servidor antigo) é não. */
export function isBillingExempt(subscription: { billingExempt?: boolean } | null | undefined) {
  return subscription?.billingExempt === true
}

/**
 * O dia do campo "Isento até" como o instante que vai ao servidor: o fim
 * daquele dia (`endOfDayIso` — "isento até 10/10" inclui o dia 10). Vazio é
 * `null` ("até alguém desligar"); um dia ilegível ou que já acabou é
 * `undefined` — a tela recusa antes de enviar, como o servidor faria (400).
 */
export function exemptUntilFromDateInput(day: string, now: Date = new Date()): string | null | undefined {
  const valor = day.trim()
  if (!valor) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return undefined
  const fim = endOfDayIso(valor)
  if (!fim || new Date(fim).getTime() <= now.getTime()) return undefined
  return fim
}

export interface RowFilter {
  /** Vazio é "todos". */
  statuses: readonly SubscriptionConsoleStatus[]
  onlyOpenCharge: boolean
  search: string
  /** Só os isentos de cobrança. Combina com os estados (isento continua `active`). */
  onlyExempt?: boolean
}

/** Minúsculas e sem acento: "Sao Joao" acha "São João". */
export function normalizeSearch(texto: string) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** A busca olha o nome e o slug do provedor. */
export function filterRows<T extends Pick<SubscriptionConsoleRow, 'tenant' | 'subscription' | 'openCharge'>>(
  rows: readonly T[],
  filter: RowFilter
): T[] {
  const termo = normalizeSearch(filter.search)
  return rows.filter((row) => {
    if (filter.statuses.length > 0 && !filter.statuses.includes(rowStatus(row))) return false
    if (filter.onlyOpenCharge && !row.openCharge) return false
    if (filter.onlyExempt && !isBillingExempt(row.subscription)) return false
    if (termo) {
      const alvo = normalizeSearch(`${row.tenant.name} ${row.tenant.slug}`)
      if (!alvo.includes(termo)) return false
    }
    return true
  })
}

/**
 * A ordem dos cartões do resumo e dos chips do filtro: primeiro quem paga,
 * depois quem ainda pode vir a pagar, e por último quem já não paga.
 */
export const CONSOLE_STATUS_ORDER: readonly SubscriptionConsoleStatus[] = [
  'active', 'trial', 'past_due', 'suspended', 'canceled', 'none'
]

export const CONSOLE_STATUS_LABEL_KEYS: Record<SubscriptionConsoleStatus, TranslationKey> = {
  active: 'platform.subs.status.active',
  trial: 'platform.subs.status.trial',
  past_due: 'platform.subs.status.pastDue',
  suspended: 'platform.subs.status.suspended',
  canceled: 'platform.subs.status.canceled',
  none: 'platform.subs.status.none'
}

/**
 * Quantos estão isentos: o número do servidor, ou — servidor antigo, sem o
 * campo — a contagem das linhas.
 */
export function exemptCount(
  summary: Pick<SubscriptionConsoleSummary, 'exempt'> | null,
  rows: readonly Pick<SubscriptionConsoleRow, 'subscription'>[]
) {
  if (typeof summary?.exempt === 'number') return summary.exempt
  return rows.filter((row) => isBillingExempt(row.subscription)).length
}

/** Os cartões de contagem do resumo, na ordem da tela. Estado ausente conta zero. */
export function summaryStatusCards(summary: Pick<SubscriptionConsoleSummary, 'byStatus'> | null) {
  return CONSOLE_STATUS_ORDER.map((status) => ({
    status,
    labelKey: CONSOLE_STATUS_LABEL_KEYS[status],
    count: summary?.byStatus?.[status] ?? 0
  }))
}

export type GatewayBadge =
  | { kind: 'gateway'; name: string }
  | { kind: 'manual' }
  | { kind: 'unlinked'; name: string }

/**
 * Quem cobra este provedor. Sem gateway configurado a cobrança é manual (Pix
 * combinado, boleto do banco). Com gateway mas sem o cliente ligado lá, a
 * emissão automática não tem para quem emitir — é isso que o selo avisa.
 */
export function gatewayBadge(gateway: SubscriptionConsoleRow['gateway']): GatewayBadge {
  const nome = (gateway.gateway ?? '').trim()
  if (!nome || nome.toLowerCase() === 'manual') return { kind: 'manual' }
  const bonito = nome.toLowerCase() === 'asaas' ? 'Asaas' : nome
  return gateway.linked ? { kind: 'gateway', name: bonito } : { kind: 'unlinked', name: bonito }
}

/**
 * Qual prazo a linha mostra: o fim do teste para quem está em teste, a data até
 * a qual está pago para os demais.
 */
export function deadlineOf(subscription: SubscriptionConsoleRow['subscription']) {
  if (!subscription) return null
  if (subscription.storedStatus === 'trial' && subscription.trialEndsAt) {
    return { kind: 'trial' as const, date: subscription.trialEndsAt }
  }
  if (subscription.renewsAt) return { kind: 'paid' as const, date: subscription.renewsAt }
  return null
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** Uma data como o `<input type="date">` a quer, no fuso de quem olha. */
export function toIsoDay(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * O fuso da operação. A plataforma cobra no calendário de São Paulo — é nele
 * que o backend decide o que venceu e qual é o dia de hoje — e a tela precisa
 * contar os dias igual, esteja o navegador de quem olha onde estiver.
 */
export const BILLING_TIME_ZONE = 'America/Sao_Paulo'

const DIA_SP = new Intl.DateTimeFormat('en-CA', {
  timeZone: BILLING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** O dia (AAAA-MM-DD) que um instante é em São Paulo. */
export function saoPauloDay(date: Date): string {
  return DIA_SP.format(date)
}

/**
 * A chave de dia de uma data do backend no calendário de São Paulo: o
 * "AAAA-MM-DD" puro já é o dia e fica como está; um instante vira o dia que ele
 * é lá. Vazio para nulo ou ilegível.
 */
export function dayKeySaoPaulo(value: string | null | undefined): string {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : saoPauloDay(date)
}

/** Hoje, no calendário de São Paulo: o padrão e o teto das datas de cobrança. */
export function todayIso(now: Date = new Date()) {
  return saoPauloDay(now)
}

/**
 * Lê uma data do backend. "AAAA-MM-DD" puro vira meia-noite LOCAL: o `Date`
 * nativo a leria como meia-noite UTC, e no Brasil o vencimento de 10/10
 * apareceria como 09/10.
 */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null
  const soDia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = soDia ? new Date(Number(soDia[1]), Number(soDia[2]) - 1, Number(soDia[3])) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDay(value: string | null | undefined) {
  const date = parseDay(value)
  return date ? formatDayPart(date, getActiveDateFormat(), getIntlLocale()) : '—'
}

/** A data de um prazo para preencher um `<input type="date">`, ou vazio. */
export function dayInputValue(value: string | null | undefined) {
  const date = parseDay(value)
  return date ? toIsoDay(date) : ''
}

/**
 * Um dia escolhido no `<input type="date">` como o instante em que o prazo
 * vence: o FIM daquele dia no fuso de quem escolheu. "Pago até 10/10" quer
 * dizer que o dia 10 inteiro está pago; mandar só "2026-10-10" o servidor leria
 * como meia-noite UTC — no Brasil, 21h do dia 9.
 */
export function endOfDayIso(day: string): string | null {
  const date = parseDay(day)
  if (!date) return null
  date.setHours(23, 59, 59, 0)
  return date.toISOString()
}

/** Lê o "+N dias" digitado: inteiro de 1 a 365 (o teto do backend), ou nulo. */
export function parseExtendDays(digitado: string): number | null {
  const texto = String(digitado ?? '').trim()
  if (!/^\d+$/.test(texto)) return null
  const dias = Number(texto)
  return dias >= 1 && dias <= 365 ? dias : null
}

/**
 * A cobrança já venceu? `overdue` é o que o gateway disse; `pending` com o
 * vencimento para trás é o que ele ainda não disse (ou a manual, que ninguém
 * avisa).
 */
export function isChargeLate(charge: Pick<ChargeConsoleView, 'status' | 'dueDate'>, now: Date = new Date()) {
  if (charge.status === 'overdue') return true
  if (charge.status !== 'pending') return false
  const due = dayKeySaoPaulo(charge.dueDate)
  return due !== '' && due < todayIso(now)
}

export function chargeBadgeClass(status: ChargeStatus) {
  if (status === 'paid') return 'modern-badge-success'
  if (status === 'pending') return 'modern-badge-warning'
  if (status === 'refunded' || status === 'canceled') return 'modern-badge'
  return 'modern-badge-error'
}

export const CHARGE_STATUS_LABEL_KEYS: Record<ChargeStatus, TranslationKey> = {
  pending: 'charges.status.pending',
  paid: 'charges.status.paid',
  canceled: 'charges.status.canceled',
  failed: 'charges.status.failed',
  overdue: 'charges.status.overdue',
  refunded: 'charges.status.refunded'
}

/**
 * O total em aberto por moeda, somado das cobranças em aberto das linhas.
 *
 * O resumo do backend traz um número só; somar centavos de moedas diferentes
 * daria um valor que não existe. Quando as linhas mostram mais de uma moeda, a
 * tela troca o total único por este, uma linha por moeda.
 */
export function openTotalsByCurrency(rows: readonly Pick<SubscriptionConsoleRow, 'openCharge'>[]) {
  const totais = new Map<string, number>()
  for (const row of rows) {
    if (!row.openCharge) continue
    const moeda = (row.openCharge.currency || 'BRL').toUpperCase()
    totais.set(moeda, (totais.get(moeda) ?? 0) + (Number(row.openCharge.amountCents) || 0))
  }
  return [...totais.entries()]
    .sort(([a], [b]) => (a === 'BRL' ? -1 : b === 'BRL' ? 1 : a.localeCompare(b)))
    .map(([currency, cents]) => ({ currency, cents }))
}
