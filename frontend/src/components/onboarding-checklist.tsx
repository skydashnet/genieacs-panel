'use client'

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { settingsAPI, type OnboardingItemKey, type OnboardingStatus } from '@/lib/api'

/** Para onde cada item leva, e o ícone que o acompanha. `null`: nada a clicar. */
const ITENS: Record<OnboardingItemKey, { icon: string; href: string | null }> = {
  genieacs: { icon: 'server', href: '/settings?tab=general' },
  firstDevice: { icon: 'devices', href: '/devices' },
  provisioning: { icon: 'power', href: '/settings?tab=provisioning' },
  sgp: { icon: 'invoice', href: '/settings?tab=sgp' },
  whatsapp: { icon: 'chat', href: '/settings?tab=whatsapp' },
  team: { icon: 'contacts', href: '/settings?tab=security' }
}

/**
 * "Primeiros passos" no topo do Dashboard de um provedor novo.
 *
 * O assistente de boas-vindas cobre só o que o painel não funciona sem — o
 * GenieACS. O resto (SGP, WhatsApp, ativação automática, a equipe, ver o
 * primeiro equipamento chegar) ficava sem guia. Cada item aqui é conferido no
 * servidor pelo que o provedor TEM, então se marca sozinho quando é feito em
 * qualquer tela, e o card some quando tudo está pronto ou alguém o oculta.
 *
 * Mesmas condições do assistente: edição hospedada, um provedor de verdade e
 * quem pode mexer nas configurações.
 */
export function OnboardingChecklist() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const { tenant, isSaas } = useTenant()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [hidden, setHidden] = useState(false)

  const eligible = isSaas && tenant?.kind !== 'platform' && can('settings.write')

  useEffect(() => {
    if (!eligible) return
    let cancelled = false
    settingsAPI.onboardingStatus()
      .then((res) => { if (!cancelled && res.success && res.data) setStatus(res.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [eligible])

  if (!eligible || !status || hidden || status.checklistDismissed) return null
  const feitos = status.items.filter((item) => item.done).length
  const total = status.items.length
  if (total === 0 || feitos === total) return null

  const ocultar = () => {
    setHidden(true)
    void settingsAPI.dismissOnboarding('checklist').catch(() => {})
  }

  return (
    <section className="modern-card mb-5 p-5 sm:p-6" aria-labelledby="onboarding-checklist-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="onboarding-checklist-title" className="section-heading">{t('onboarding.checklist.title')}</h2>
          <p className="field-hint mt-1">{t('onboarding.checklist.description')}</p>
        </div>
        <button type="button" className="modern-button-secondary" onClick={ocultar}>
          <Icon name="x" size={16} />
          {t('onboarding.checklist.hide')}
        </button>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('onboarding.checklist.progress', { done: feitos, total })}</span>
        </div>
        <div
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={feitos}
          aria-label={t('onboarding.checklist.progress', { done: feitos, total })}
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round((feitos / total) * 100)}%` }} />
        </div>
      </div>

      <ul className="mt-4 divide-y divide-border">
        {status.items.map(({ key, done }) => {
          const item = ITENS[key]
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <Icon
                  name={done ? 'check' : item.icon}
                  size={18}
                  className={`mt-0.5 shrink-0 ${done ? 'text-[hsl(var(--status-success))]' : 'text-muted-foreground'}`}
                />
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                    {t(`onboarding.checklist.${key}.title` as TranslationKey)}
                  </p>
                  {!done && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(`onboarding.checklist.${key}.hint` as TranslationKey)}
                    </p>
                  )}
                </div>
              </div>
              {done ? (
                <span className="modern-badge-success">{t('onboarding.checklist.done')}</span>
              ) : item.href ? (
                <Link to={item.href} className="modern-button-secondary min-h-10 px-3 py-1 text-xs lg:min-h-9">
                  {t(key === 'firstDevice' ? 'onboarding.checklist.view' : 'onboarding.checklist.configure')}
                </Link>
              ) : (
                <span className="modern-badge-warning">{t('onboarding.checklist.pending')}</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default OnboardingChecklist
