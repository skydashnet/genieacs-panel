export type TextPart = { text: string; href?: string }

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING = /[.,;:!?)\]}]+$/

/** Quebra o texto em pedaços, marcando os links http(s) (só esses: nunca javascript:). */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    const raw = match[0]
    const url = raw.replace(TRAILING, '')
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ text: url, href: url })
    if (url.length < raw.length) parts.push({ text: raw.slice(url.length) })
    last = start + raw.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
