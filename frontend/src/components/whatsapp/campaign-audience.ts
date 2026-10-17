/**
 * As regras puras do formulário "Nova campanha", fora do componente para
 * poderem ser testadas.
 */

/** Os contratos colados: um por linha, ou separados por vírgula, ponto e vírgula ou espaço. */
export function parseContracts(text: string): string[] {
  return [...new Set(
    text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, 64))
  )]
}

/** Liga ou desliga um valor numa lista de seleção múltipla. */
export function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/**
 * Quantas horas o envio leva no ritmo configurado, arredondado para cima.
 * `perHour` é a vazão das mensagens automáticas (Configurações → WhatsApp).
 */
export function estimatedHours(recipients: number, perHour: number): number {
  if (recipients <= 0 || perHour <= 0) return 0
  return Math.max(1, Math.ceil(recipients / perHour))
}

/** `datetime-local` (hora local do navegador) → ISO, ou null quando vazio ou inválido. */
export function localInputToIso(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
