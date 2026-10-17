import type { WhatsAppAccount } from '@/lib/api'

/**
 * A janela de 24 horas da API oficial da Meta, do lado da tela.
 *
 * A mesma regra de `backend/src/utils/wa/waJanelaMeta.js`: num número
 * oficial, texto livre só até 24 h depois da última mensagem do cliente, com
 * meia hora de folga para a fila. A tela só avisa e trava o botão — quem
 * decide de verdade é o servidor, que recusa com `meta_window_closed`.
 */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000
export const META_WINDOW_MARGIN_MS = 30 * 60 * 1000

export type MetaWindow =
  | { state: 'open'; hoursLeft: number }
  | { state: 'closed' }

/** null quando não há janela: número por QR, ou número desconhecido. */
export function metaWindowFor(
  account: Pick<WhatsAppAccount, 'id' | 'integration'> | undefined,
  conversation: { accountId: number; lastInboundAt: string | null },
  now: number = Date.now()
): MetaWindow | null {
  if (!account || account.integration !== 'cloud') return null
  if (account.id !== conversation.accountId || !conversation.lastInboundAt) return { state: 'closed' }
  const inicio = new Date(conversation.lastInboundAt).getTime()
  if (!Number.isFinite(inicio)) return { state: 'closed' }
  const restante = inicio + META_WINDOW_MS - META_WINDOW_MARGIN_MS - now
  if (restante <= 0) return { state: 'closed' }
  return { state: 'open', hoursLeft: Math.max(1, Math.ceil(restante / 3_600_000)) }
}
