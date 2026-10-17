import { formatDayPart, getActiveDateFormat, toDate } from '@/lib/date-format'
import type { SgpContractLink, SgpContractState } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * O selo de situação de um contrato do ERP: a cor e o texto.
 *
 * **A cor sai do `state`, nunca do rótulo.** A tela decidia isto com
 * `/ativo/i.test(statusLabel)`, e "Inativo" CONTÉM "ativo" — um contrato
 * inativo aparecia em verde. O backend já tinha resolvido o problema e escrito
 * o porquê: `deriveContractState` testa cancelamento primeiro justamente
 * "because 'Inativo' and 'Desativado' contain 'ativo'", e manda o resultado
 * pronto em `publicLink`. Faltava a tela usar o que já chegava.
 *
 * **O texto, ao contrário, continua sendo o do ERP.** Quem nomeia a situação é
 * o sistema do provedor, que escreve cada um do seu jeito; nós só escolhemos a
 * cor. Traduzir o rótulo aqui seria inventar um vocabulário que não é nosso.
 *
 * Função pura em `lib/` pelo precedente de `shell.ts` e `money.ts`: o
 * `frontend/test/` roda em node puro, sem DOM, e regra dentro de JSX é regra
 * que ninguém verifica.
 */

/** O que cada estado merece de cor, e por quê. */
const CLASSES: Record<SgpContractState, string> = {
  active: 'modern-badge-success',
  // Bloqueio se desfaz pagando: é aviso, não fim de linha.
  blocked: 'modern-badge-warning',
  // Contrato encerrado. O aparelho pode estar de pé e não deveria.
  cancelled: 'modern-badge-error',
  // "Não sei" não é uma boa notícia nem uma má. O neutro é a resposta honesta.
  unknown: 'modern-badge'
}

/** O que a tela precisa para desenhar o selo. Só o que ela usa. */
export type SgpBadgeInput = Pick<SgpContractLink, 'status' | 'statusLabel'> & {
  state?: SgpContractState | null
}

export interface SgpBadge {
  className: string
  /** O rótulo do ERP, ou `null` quando ele não mandou nenhum. */
  text: string | null
  /** A chave a usar quando `text` é nulo — a tela traduz, esta função não. */
  fallbackKey: TranslationKey
}

export function sgpBadge(link: SgpBadgeInput | null | undefined): SgpBadge {
  // Um `state` ausente vale `unknown` e não `active`: payload antigo, resposta
  // pela metade ou campo que alguém tirou têm que cair no neutro, nunca no
  // verde. Um selo que erra para o lado bom é o que ninguém vai conferir.
  const estado = link?.state ?? 'unknown'
  const texto = link?.statusLabel?.trim() || link?.status?.trim() || null
  return {
    className: CLASSES[estado] ?? CLASSES.unknown,
    text: texto,
    fallbackKey: 'detail.sgp.statusUnknown'
  }
}

/**
 * O que a tela do aparelho e o módulo SGP da conversa mostram de um título.
 * Moram aqui, e não em cada tela, para os dois lugares escreverem igual.
 */

/** SGP reports amounts in BRL; only the grouping follows the reader's locale. */
export function formatBrl(amount: number | null, intlLocale: string) {
  if (amount === null || !Number.isFinite(amount)) return '—'
  return amount.toLocaleString(intlLocale, { style: 'currency', currency: 'BRL' })
}

/**
 * Uma data do SGP no formato do leitor (no Brasil, 03/10/2026).
 *
 * O SGP manda vencimento como `YYYY-MM-DD`, sem hora: ancorada ao meio-dia
 * local, nenhum fuso a empurra para o dia vizinho. Uma data com hora passa
 * direto; o que não for data volta como veio, para nunca sumir da tela.
 */
export function formatSgpDate(value: string | null | undefined, intlLocale: string) {
  if (!value) return '—'
  const texto = String(value).trim()
  const data = toDate(texto)
  if (!data) return texto
  // No formato escolhido em Configurações; em `auto`, o do idioma.
  if (getActiveDateFormat() !== 'auto') return formatDayPart(data, getActiveDateFormat(), intlLocale)
  return new Intl.DateTimeFormat(intlLocale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(data)
}

export function isSafeExternalUrl(value: string | null): value is string {
  if (!value) return false
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export async function copyToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/**
 * The router's own management page, from the WAN address the ONT reported.
 * Only a bare dotted IPv4 becomes a link: anything else the ONT might put in
 * that field is shown as text and never navigated to.
 */
export function routerUrl(ip: string | null | undefined): string | null {
  const value = String(ip ?? '').trim()
  const parts = value.split('.')
  if (parts.length !== 4) return null
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null
  if (value === '0.0.0.0') return null
  return `http://${value}/`
}

export default sgpBadge
