'use client'

import { useState } from 'react'
import { PlatformIntegrations } from '@/components/platform/platform-integrations'
import { PlatformProfileForm } from '@/components/platform/platform-profile'
import { PlatformAlertsSettings } from '@/components/platform/platform-alerts'
import { useTranslation } from '@/contexts/language-context'

/**
 * Configurações do console, com submenu: os dados da empresa que vende o SaaS
 * e as integrações com sistemas de fora (a conta Asaas). E os alertas para
 * quem opera a plataforma (0112).
 */
export function PlatformSettings() {
  const { t } = useTranslation()
  const [sub, setSub] = useState<'profile' | 'alerts' | 'integrations'>('profile')

  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
      <nav aria-label={t('platform.tabs.settings')} className="flex gap-2 overflow-x-auto lg:flex-col">
        {([
          ['profile', 'platform.settings.profile'],
          ['alerts', 'platform.settings.alerts'],
          ['integrations', 'platform.tabs.integrations']
        ] as const).map(([chave, rotulo]) => (
          <button
            key={chave}
            type="button"
            onClick={() => setSub(chave)}
            aria-current={sub === chave ? 'page' : undefined}
            className={`shrink-0 rounded-md px-3 py-2 text-left text-sm font-semibold transition ${sub === chave
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {t(rotulo)}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {sub === 'profile' && <PlatformProfileForm />}
        {sub === 'alerts' && <PlatformAlertsSettings />}
        {sub === 'integrations' && <PlatformIntegrations />}
      </div>
    </div>
  )
}

export default PlatformSettings
