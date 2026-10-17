import type { User } from '@/types'
import { clearDashboardSnapshot } from '@/lib/dashboard-snapshot'
import { CONTACTS_FILTERS_KEY } from '@/lib/contact-filters'

/**
 * Quem é o dono da sessão desta aba: o provedor e o usuário.
 *
 * É a mesma assinatura que a cópia do dashboard usa, num lugar só, para que
 * tudo o que a aba guarda ou carrega de uma tela para outra — a cópia do
 * dashboard, a conversa que outra tela manda abrir no WhatsApp — compare com a
 * mesma régua. Sem usuário não há dono, e quem recebe `null` não lê nem grava.
 *
 * O slug vem da sessão (`user.tenant`), nunca do `TenantProvider`: no host
 * compartilhado aquele é o do PRIMEIRO provedor, não o de quem entrou.
 */
export function sessionOwner(user: Pick<User, 'id' | 'tenant'> | null | undefined): string | null {
  if (!user) return null
  return `${user.tenant?.slug ?? '-'}:${user.id}`
}

/**
 * A faixa de "número de WhatsApp caído" fechada nesta aba. Mora aqui, e não só
 * no componente, porque trocar de sessão tem que apagá-la: senão o provedor B
 * herdava a faixa que o provedor A fechou.
 */
export const WA_DOWN_DISMISSED_KEY = 'wa-down-dismissed'

/**
 * Apaga tudo o que a aba guarda em nome da sessão atual.
 *
 * Chamada toda vez que a sessão muda de dono — sair, entrar em outro provedor,
 * personificação, cuja aba nova herda o `sessionStorage` da aba do console.
 */
export function clearSessionScopedStorage() {
  clearDashboardSnapshot()
  try {
    sessionStorage.removeItem(WA_DOWN_DISMISSED_KEY)
    sessionStorage.removeItem(CONTACTS_FILTERS_KEY)
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
}
