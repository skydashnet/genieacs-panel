/**
 * The API answers with a localized `message` — the backend negotiates the
 * caller's language — next to a machine-readable `code`. The portal reads the
 * message, and the code only where behaviour, not wording, depends on it.
 */

/** Codes that mean the portal session is gone and the browser must sign in again. */
export const CUSTOMER_SESSION_CODES = [
  'customer_session_required',
  'customer_session_invalid',
  'customer_session_expired',
] as const

export type CustomerSessionCode = (typeof CUSTOMER_SESSION_CODES)[number]

const SESSION_CODES = new Set<string>(CUSTOMER_SESSION_CODES)

/** True when the response says the customer session ended. */
export function isCustomerSessionCode(code: string | undefined): code is CustomerSessionCode {
  return code !== undefined && SESSION_CODES.has(code)
}
