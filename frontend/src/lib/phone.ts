/**
 * A stored Brazilian phone (55 + DDD + number) as a person reads it:
 * 5593991261076 → (93) 99126-1076, 559335220001 → (93) 3522-0001. Anything
 * that is not a phone of that shape — a short code, a foreign number — is
 * shown as it came.
 */
export function formatBrPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (!digits) return String(phone ?? '')
  const local = digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`
  return String(phone)
}
