/**
 * Ping e traceroute pela ONT: o que a tela decide sozinha.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 *
 * A conferência do destino é a MESMA de `backend/src/services/deviceDiagnostics.js`,
 * e o teste importa a de lá e exige que as duas concordem caso a caso. A tela só
 * acende o botão com ela; quem recusa de verdade é o servidor.
 */
import type { DeviceDiagnosticResult } from '@/lib/api'

/** De quanto em quanto tempo a tela pergunta pelo resultado. */
export const DIAGNOSTIC_POLL_MS = 5_000

/**
 * Quanto a tela espera antes de dizer que a ONT não respondeu. Um traceroute
 * de trinta saltos com três tentativas de cinco segundos pode passar de um
 * minuto numa rota ruim; dois minutos cobre isso com folga.
 */
export const DIAGNOSTIC_TIMEOUT_MS = 120_000

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
}

function isIpv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(value) || value.length > 39) return false
  const halves = value.split('::')
  if (halves.length > 2) return false
  const groups = (half: string) => (half === '' ? [] : half.split(':'))
  const todos = [...groups(halves[0]), ...(halves.length === 2 ? groups(halves[1]) : [])]
  if (!todos.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false
  return halves.length === 2 ? todos.length <= 7 : todos.length === 8
}

function isHostname(value: string): boolean {
  if (value.length > 253) return false
  if (/^[\d.]+$/.test(value)) return false
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

/** Um IPv4, um IPv6 ou um nome DNS — sem esquema, porta, caminho ou espaço. */
export function isValidDiagnosticHost(host: unknown): boolean {
  if (typeof host !== 'string') return false
  const value = host.trim()
  if (!value) return false
  return isIpv4(value) || isIpv6(value) || isHostname(value)
}

export type DiagnosticPhase = 'running' | 'done' | 'failed' | 'timedOut'

/**
 * Em que pé a tela está, dado o último resultado lido.
 *
 * `idle` enquanto a tela espera conta como rodando: logo depois do pedido o
 * ACS ainda pode estar gravando o `Requested`. Só o prazo tira a tela dessa
 * espera — e sem ele a tela ficaria girando para sempre sobre uma ONT que
 * desligou no meio do teste.
 */
export function diagnosticPhase(
  result: Pick<DeviceDiagnosticResult, 'state'> | null,
  startedAt: number,
  now: number
): DiagnosticPhase {
  if (result?.state === 'complete') return 'done'
  if (result?.state === 'error') return 'failed'
  return now - startedAt >= DIAGNOSTIC_TIMEOUT_MS ? 'timedOut' : 'running'
}

/** Perda do ping em porcentagem inteira, ou `null` quando a ONT não contou. */
export function pingLossPercent(ping: DeviceDiagnosticResult['ping']): number | null {
  if (!ping || ping.success === null || ping.failure === null) return null
  const total = ping.success + ping.failure
  return total > 0 ? Math.round((ping.failure / total) * 100) : null
}
