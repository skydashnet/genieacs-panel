/**
 * O contato do provedor no portal do assinante, e os links que o celular
 * sabe abrir: `tel:` disca, `wa.me` abre o WhatsApp.
 */
export interface ProviderContact {
  enabled: boolean
  name?: string | null
  phone?: string | null
  whatsapp?: string | null
  email?: string | null
  address?: string | null
}

/**
 * Só os dígitos, com o 55 na frente. O número chega como o provedor digitou
 * — "(93) 3518-0000", "93 99100-2222", "+55 93…" —, e DDD mais número são
 * 10 ou 11 dígitos; com o código do país, 12 ou 13. Fora disso não há link.
 */
export function brazilDigits(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length === 10 || digits.length === 11) return `55${digits}`
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits
  return null
}

export function telHref(value: string | null | undefined): string | null {
  const digits = brazilDigits(value)
  return digits ? `tel:+${digits}` : null
}

export function whatsappHref(value: string | null | undefined): string | null {
  const digits = brazilDigits(value)
  return digits ? `https://wa.me/${digits}` : null
}

export function mailtoHref(value: string | null | undefined): string | null {
  const email = String(value ?? '').trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `mailto:${email}` : null
}

/** Há algo para mostrar no cartão? Ligado e sem nenhum dado, o cartão some. */
export function hasContact(contact: ProviderContact | null): contact is ProviderContact {
  return Boolean(contact?.enabled && (contact.phone || contact.whatsapp || contact.email || contact.address))
}
