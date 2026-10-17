'use client'

import { Link } from 'react-router'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'
import { INNER_SCREENS, visibleMenuScreens, visibleSettingsSections, type ScreenGroup } from '@/lib/screens'

/**
 * Em que ordem os grupos aparecem. Não é a ordem do menu: ali os itens estão
 * onde o operador aprendeu a procurá-los, e aqui a pergunta é outra — "que
 * telas existem e para que servem".
 */
const GROUPS: readonly { group: ScreenGroup, titleKey: TranslationKey }[] = [
  { group: 'operation', titleKey: 'siteMap.group.operation' },
  { group: 'administration', titleKey: 'siteMap.group.administration' },
  { group: 'platform', titleKey: 'siteMap.group.platform' },
]

/**
 * O mapa do painel: toda tela, agrupada, com o que ela faz.
 *
 * A rota não tem `PermissionRoute`: todo papel chega, e é a tela que filtra —
 * com as mesmas funções que desenham o menu (`lib/screens.ts`), para que ela
 * nunca ofereça o que a sessão não abre. Um `viewer` vê três telas aqui porque
 * são três as que ele tem.
 */
export default function SiteMapPage() {
  const { t } = useTranslation()
  const { can, user } = useAuth()
  const { isSaas } = useTenant()

  const screens = visibleMenuScreens({ can, isSaas, isPlatformAdmin: Boolean(user?.isPlatformAdmin) })
  // As seções moram dentro de Configuração: sem a capacidade de abri-la, o
  // link levaria ao redirecionamento da própria rota.
  const settingsSections = can('settings.read') ? visibleSettingsSections({ can, isSaas }) : []
  const inner = INNER_SCREENS.filter((screen) => can(screen.permission))

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('siteMap.kicker')}</p>
            <h1 className="page-title">{t('siteMap.title')}</h1>
            <p className="page-description">{t('siteMap.description')}</p>
          </div>
        </header>

        <div className="space-y-6">
          {GROUPS.map(({ group, titleKey }) => {
            const doGrupo = screens.filter((screen) => screen.group === group)
            // Grupo vazio não vira cartão vazio: para quem não é administrador
            // de plataforma, "Plataforma" simplesmente não existe.
            if (doGrupo.length === 0) return null
            return (
              <section key={group} className="modern-card p-4 sm:p-5">
                <h2 className="section-heading mb-4">{t(titleKey)}</h2>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {doGrupo.map((screen) => (
                    <li key={screen.href}>
                      <Link
                        to={screen.href}
                        className="flex min-h-14 items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/50"
                      >
                        <Icon name={screen.icon} size={20} className="mt-0.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-foreground">{t(screen.labelKey)}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{t(screen.descriptionKey)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}

          {settingsSections.length > 0 && (
            <section className="modern-card p-4 sm:p-5">
              <h2 className="section-heading">{t('siteMap.settings.title')}</h2>
              <p className="section-description mb-4">{t('siteMap.settings.description')}</p>
              <ul className="flex flex-wrap gap-2">
                {settingsSections.map((section) => (
                  <li key={section.tab}>
                    {/* `?tab=` é um mecanismo que a tela de Configuração já
                        oferece justamente para que outra aponte para uma seção
                        em vez de descrever onde ela fica. */}
                    <Link
                      to={`/settings?tab=${section.tab}`}
                      className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                    >
                      {t(section.labelKey)}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {inner.length > 0 && (
            <section className="modern-card p-4 sm:p-5">
              <h2 className="section-heading">{t('siteMap.inner.title')}</h2>
              <p className="section-description mb-4">{t('siteMap.inner.description')}</p>
              {/* Sem link, e é a parte que importa: `/devices/detail` sem `?id=`
                  é a tela de "não deu para abrir o aparelho", e `/contacts/:key`
                  sem chave não é rota. Um link aqui seria um botão que não
                  funciona — pior que a ausência, porque parece navegação. */}
              <ul className="space-y-2">
                {inner.map((screen) => (
                  <li key={screen.path} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    <span className="font-semibold text-foreground">{t(screen.labelKey)}</span>
                    <span className="text-muted-foreground">{t(screen.reachedKey)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
