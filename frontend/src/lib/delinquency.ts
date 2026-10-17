import type { DelinquencyAction, DelinquencyBucket, DelinquencyRow } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * As peças puras do painel de inadimplência: as faixas, os rótulos dos
 * códigos de resultado, a seleção e a planilha. Fora do componente para o
 * teste alcançá-las sem montar a tela.
 */

export const DELINQUENCY_BUCKETS: readonly DelinquencyBucket[] = ['1-7', '8-15', '16-30', '30+']

export const BUCKET_LABEL_KEYS: Record<DelinquencyBucket, TranslationKey> = {
  '1-7': 'platform.delinq.bucket.1to7',
  '8-15': 'platform.delinq.bucket.8to15',
  '16-30': 'platform.delinq.bucket.16to30',
  '30+': 'platform.delinq.bucket.30plus'
}

export const ACTION_LABEL_KEYS: Record<DelinquencyAction, TranslationKey> = {
  remind: 'platform.delinq.action.remind',
  suspend: 'platform.delinq.action.suspend',
  exempt: 'platform.delinq.action.exempt',
  extend: 'platform.delinq.action.extend'
}

export const MAX_SELECTION = 200
export const MAX_EXTEND_DAYS = 60

/** O código de resultado de uma ação como a pessoa o lê; o desconhecido cai em "erro". */
const RESULT_CODE_KEYS: Record<string, TranslationKey> = {
  sent: 'platform.delinq.code.sent',
  suspended: 'platform.delinq.code.suspended',
  exempted: 'platform.delinq.code.exempted',
  extended: 'platform.delinq.code.extended',
  rate_limited: 'platform.delinq.code.rateLimited',
  not_overdue: 'platform.delinq.code.notOverdue',
  already_suspended: 'platform.delinq.code.alreadySuspended',
  already_exempt: 'platform.delinq.code.alreadyExempt',
  subscription_canceled: 'platform.delinq.code.canceled',
  subscription_not_found: 'platform.delinq.code.noSubscription',
  not_found: 'platform.delinq.code.notFound',
  no_recipient: 'platform.delinq.code.noRecipient',
  no_transport: 'platform.delinq.code.noTransport',
  send_failed: 'platform.delinq.code.sendFailed',
  gateway_failed: 'platform.delinq.code.gatewayFailed',
  busy: 'platform.delinq.code.busy'
}

export function resultCodeKey(code: string): TranslationKey {
  return RESULT_CODE_KEYS[code] ?? 'platform.delinq.code.error'
}

/** Liga ou desliga um id na seleção, sem passar do teto do pedido. */
export function toggleSelection(selected: number[], id: number): number[] {
  if (selected.includes(id)) return selected.filter((item) => item !== id)
  if (selected.length >= MAX_SELECTION) return selected
  return [...selected, id]
}

/** "Selecionar todos" dos visíveis: liga todos (até o teto) ou, se já estão todos, desliga. */
export function toggleAll(selected: number[], visibleIds: number[]): number[] {
  const todos = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
  if (todos) return selected.filter((id) => !visibleIds.includes(id))
  const juntos = [...selected]
  for (const id of visibleIds) {
    if (juntos.length >= MAX_SELECTION) break
    if (!juntos.includes(id)) juntos.push(id)
  }
  return juntos
}

/** A seleção que ainda está na lista (depois de recarregar ou filtrar no servidor). */
export function pruneSelection(selected: number[], rows: DelinquencyRow[]): number[] {
  const ids = new Set(rows.map((row) => row.tenant.id))
  return selected.filter((id) => ids.has(id))
}

/** `days` válido para a cortesia em massa: inteiro de 1 a 60. */
export function parseBulkDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const dias = Number(value.trim())
  return dias >= 1 && dias <= MAX_EXTEND_DAYS ? dias : null
}

/**
 * A chave de um pedido de ação em massa (8–64 letras, dígitos ou hífens).
 * `crypto.randomUUID` só existe em contexto seguro, e o painel também roda
 * em HTTP na rede local — aí vai o relógio com sorteio.
 */
export function newRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`
}

const csvCell = (value: unknown) => {
  const text = String(value ?? '')
  // Célula que o Excel leria como fórmula sai neutralizada, como nas outras
  // planilhas — também com espaço ou quebra de linha antes do sinal, que
  // alguns leitores descartam antes de decidir se é fórmula.
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text) ? `'${text}` : text
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const reais = (cents: number) => (cents / 100).toFixed(2)

/**
 * A planilha das linhas carregadas: separador `;`, com BOM, que é o que o
 * Excel em português abre direto. Valores em unidades da moeda com ponto
 * decimal, e datas ISO — a planilha é para conta, não para leitura.
 */
export function delinquencyCsv(rows: DelinquencyRow[], headers: string[]): string {
  const lines = [headers.map(csvCell).join(';')]
  for (const row of rows) {
    lines.push([
      row.tenant.id,
      row.tenant.name,
      row.tenant.slug,
      row.status === 'suspended' && row.suspendedReason ? `${row.status}:${row.suspendedReason}` : row.status,
      row.currency,
      reais(row.amountCents),
      reais(row.amountByKind.renewal),
      reais(row.amountByKind.proration),
      reais(row.amountByKind.overage),
      row.overdueSince ? row.overdueSince.slice(0, 10) : '',
      row.daysOverdue,
      row.bucket,
      row.lastReminder?.sentAt ?? '',
      row.autoSuspendAt ?? '',
      row.card.saved ? `${row.card.brand ?? ''} ${row.card.last4 ?? ''}`.trim() : ''
    ].map(csvCell).join(';'))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
