import type { TranslationKey } from '@/lib/i18n/dictionary'

/**
 * As conferências que a tela faz ANTES de mandar, e por que ela as faz.
 *
 * O salvar da aba percorre as chaves e para na primeira que o servidor recusa,
 * mostrando uma mensagem genérica — "não foi possível salvar" — sem dizer qual
 * campo. Enquanto todo campo daquele laço vinha de um seletor ou tinha valor
 * fixo, isso nunca apareceu: não havia como digitar algo inválido. O prazo da
 * trilha é o primeiro campo numérico livre a passar por ali.
 *
 * Então a conferência vem para cá, no mesmo espírito da que já existe para a
 * credencial da NBI, e pelo mesmo motivo escrito lá: barrar aqui evita a ida
 * perdida e diz qual campo falta, que a resposta não diz.
 *
 * NÃO substitui a do servidor, e isso importa: a tela é um conforto, o
 * servidor é a regra. Os limites aparecem nos dois lugares porque quem chama a
 * API sem passar por esta tela também tem que ser recusado.
 *
 * Módulo próprio e função pura pelo motivo de sempre: o vitest roda em
 * ambiente `node`, sem jsdom, e lógica dentro do componente é lógica sem prova.
 */

export const AUDIT_RETENTION_MIN_DAYS = 30
export const AUDIT_RETENTION_MAX_DAYS = 3650

/**
 * A chave da mensagem quando o prazo da trilha não serve, ou `null` quando ele
 * serve.
 *
 * O texto tem que ser exatamente o inteiro. `Number.parseInt` aceita `'30.5'`
 * e `'12abc'` e devolve um inteiro dos dois — que passaria por qualquer teste
 * de tipo e chegaria ao servidor como um número que ninguém digitou.
 */
export function auditRetentionError(value: string, cap: number | null = null): TranslationKey | null {
  const texto = String(value ?? '').trim()
  if (!/^[0-9]+$/.test(texto)) return 'settings.audit.retentionInvalid'
  const dias = Number.parseInt(texto, 10)
  if (dias < AUDIT_RETENTION_MIN_DAYS || dias > AUDIT_RETENTION_MAX_DAYS) {
    return 'settings.audit.retentionInvalid'
  }
  // O teto do plano, na SaaS. O servidor recusa acima dele com 422; dizer
  // aqui é o que dá ao operador o número em vez de "não foi possível salvar".
  if (cap !== null && dias > cap) return 'settings.audit.retentionAboveCap'
  return null
}

/**
 * Os dias de retenção do WhatsApp (mensagens ou anexos) acima do teto do
 * plano. Zero é "para sempre", e com teto isso é acima dele por definição.
 */
export function waRetentionAboveCap(days: number, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined) return false
  const n = Math.trunc(Number(days))
  return !Number.isFinite(n) || n <= 0 || n > cap
}
