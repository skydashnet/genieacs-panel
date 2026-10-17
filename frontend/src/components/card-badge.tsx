'use client'

import type { SubscriptionCard } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { cardBadge } from '@/lib/card-autopay'

const TONE_CLASS = {
  success: 'modern-badge-success',
  warning: 'modern-badge-warning',
  neutral: 'modern-badge'
} as const

/** O selo "Cartão" do console (aba Assinaturas e painel Plano). Nada sem cartão. */
export function CardBadge({ card }: { card: SubscriptionCard | null | undefined }) {
  const { t } = useTranslation()
  const selo = cardBadge(card)
  if (!selo) return null
  return <span className={TONE_CLASS[selo.tone]}>{t(selo.key, selo.vars)}</span>
}
