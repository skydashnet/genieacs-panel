/**
 * A cor de cada número do WhatsApp na caixa de entrada.
 *
 * O provedor com mais de um número via as conversas misturadas e idênticas: o
 * mesmo assinante duas vezes seguidas, uma por número, sem nada dizendo qual
 * recebeu. A cor separa, e o NOME do número vai sempre junto — cor sozinha não
 * chega a quem não a distingue.
 *
 * Módulo próprio, e não um trecho do componente, pelo motivo de sempre neste
 * repositório: o vitest roda em `node`, sem jsdom, e função pura aqui é a única
 * forma de esta decisão ter teste.
 *
 * A paleta é a mesma de `backend/src/config/waAccountColors.js`, e o teste a
 * importa de lá e exige que as duas concordem.
 */
import type { WhatsAppAccount, WhatsAppConversation } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

export const WA_ACCOUNT_COLORS = [
  'blue', 'pink', 'lime', 'violet', 'orange', 'cyan', 'fuchsia', 'indigo'
] as const

export type WaAccountColor = typeof WA_ACCOUNT_COLORS[number]

/**
 * A classe que define `--wa-account`, escrita por extenso.
 *
 * Por extenso e não `wa-account-${cor}`: o Tailwind só conserva o que acha
 * escrito no código, e é este mapa que faz as oito regras de `globals.css`
 * sobreviverem ao build.
 */
export const WA_ACCOUNT_CLASS: Record<WaAccountColor, string> = {
  blue: 'wa-account-blue',
  violet: 'wa-account-violet',
  pink: 'wa-account-pink',
  fuchsia: 'wa-account-fuchsia',
  orange: 'wa-account-orange',
  cyan: 'wa-account-cyan',
  indigo: 'wa-account-indigo',
  lime: 'wa-account-lime'
}

/** Os nomes das cores no dicionário, para a amostra ter texto e não só tinta. */
export const WA_ACCOUNT_COLOR_LABEL: Record<WaAccountColor, TranslationKey> = {
  blue: 'whatsapp.color.blue',
  violet: 'whatsapp.color.violet',
  pink: 'whatsapp.color.pink',
  fuchsia: 'whatsapp.color.fuchsia',
  orange: 'whatsapp.color.orange',
  cyan: 'whatsapp.color.cyan',
  indigo: 'whatsapp.color.indigo',
  lime: 'whatsapp.color.lime'
}

export function isAccountColor(value: unknown): value is WaAccountColor {
  return typeof value === 'string' && (WA_ACCOUNT_COLORS as readonly string[]).includes(value)
}

/**
 * A cor de um número, nunca vazia.
 *
 * A gravada, quando é uma da paleta. Senão — número que nasceu sem cor, ou um
 * servidor mais novo com uma cor que este frontend não conhece —, uma derivada
 * do id: estável entre recargas, e diferente entre números de id vizinho.
 */
export function accountColor(account: Pick<WhatsAppAccount, 'id' | 'color'>): WaAccountColor {
  if (isAccountColor(account.color)) return account.color
  const indice = Number.isInteger(account.id) ? Math.abs(account.id) % WA_ACCOUNT_COLORS.length : 0
  return WA_ACCOUNT_COLORS[indice]
}

/** O nome do número, na mesma ordem que a tela de números conectados usa. */
export function accountName(account: Pick<WhatsAppAccount, 'label' | 'phoneE164' | 'name'>): string {
  return account.label || account.phoneE164 || account.name
}

export interface AccountTag {
  /** A classe que pinta: vai no elemento que contém a faixa, o chip ou o balão. */
  className: string
  color: WaAccountColor
  name: string
  /**
   * Se o chip com o nome aparece. Com um número só não há o que distinguir, e
   * o mesmo nome em toda linha é ruído; a cor fica, e passa a significar algo
   * no dia em que o segundo número entrar.
   */
  showName: boolean
}

/**
 * O número de uma conversa, pronto para a tela — ou `null` quando não se sabe.
 *
 * `null` quando a lista de números não carregou ou não tem o desta conversa: a
 * tela desenha sem cor, como antes desta mudança, em vez de inventar um número.
 */
export function accountTag(
  accounts: ReadonlyMap<number, WhatsAppAccount>,
  conversation: Pick<WhatsAppConversation, 'accountId'>
): AccountTag | null {
  const account = accounts.get(conversation.accountId)
  if (!account) return null
  const color = accountColor(account)
  return {
    className: WA_ACCOUNT_CLASS[color],
    color,
    name: accountName(account),
    showName: accounts.size > 1
  }
}
