'use client'

import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

interface Props {
  /** Abre a aba da integração (`sgp`, `teiah`, `whatsapp`, `chatbot`). */
  onOpen: (tab: string) => void
  canTeiah: boolean
  canFocusChat: boolean
  canChatbot: boolean
}

interface Card {
  tab: string
  icon: string
  title: TranslationKey
  description: TranslationKey
}

/**
 * Configuração → Integrações: um card por sistema de fora, e o clique leva à
 * tela de cada um. As telas são as mesmas de antes — só saíram da trilha de
 * abas, que já não cabia numa linha.
 */
export function IntegrationsHub({ onOpen, canTeiah, canFocusChat, canChatbot }: Props) {
  const { t } = useTranslation()

  const cards: Card[] = [
    { tab: 'sgp', icon: 'invoice', title: 'settings.tab.sgp', description: 'settings.integrations.sgpDesc' },
    ...(canTeiah
      ? [{ tab: 'teiah', icon: 'document', title: 'settings.tab.teiah', description: 'settings.integrations.teiahDesc' } as Card]
      : []),
    ...(canFocusChat
      ? [{ tab: 'focuschat', icon: 'chat', title: 'settings.tab.focuschat', description: 'settings.integrations.focuschatDesc' } as Card]
      : []),
    { tab: 'whatsapp', icon: 'chat', title: 'sidebar.nav.whatsapp', description: 'settings.integrations.whatsappDesc' },
    ...(canChatbot
      ? [{ tab: 'chatbot', icon: 'terminal', title: 'settings.tab.chatbot', description: 'settings.integrations.chatbotDesc' } as Card]
      : [])
  ]

  return (
    <section>
      <h2 className="section-heading">{t('settings.integrations.title')}</h2>
      <p className="section-description mb-6">{t('settings.integrations.description')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <button
            key={card.tab}
            type="button"
            onClick={() => onOpen(card.tab)}
            className="modern-card group flex h-full flex-col items-start gap-3 p-5 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="inline-flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon name={card.icon} size={22} />
            </span>
            <span className="text-base font-semibold text-foreground">{t(card.title)}</span>
            <span className="flex-1 text-sm leading-6 text-muted-foreground">{t(card.description)}</span>
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
              {t('settings.integrations.open')}
              <Icon name="chevron-right" size={16} className="transition group-hover:translate-x-0.5" />
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

export default IntegrationsHub
