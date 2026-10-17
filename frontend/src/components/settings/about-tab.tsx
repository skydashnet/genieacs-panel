'use client'

import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { APP_RELEASE, ReleaseNotesModal } from '@/components/release-notes-modal'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { LOCALE_METADATA } from '@/lib/i18n/config'
import { normalizeRole, ROLE_LABEL_KEYS } from '@/lib/permissions'
import { settingsAPI, type OnboardingStatus } from '@/lib/api'

/** O que `GET /api/health` responde. Rota pública, fora do envelope `{ success, data }`. */
interface Health {
  status: 'ok' | 'degraded'
  database: 'ok' | 'unavailable'
  timestamp: string
  version: string
}

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
      <dt className="text-sm text-muted-foreground">{rotulo}</dt>
      <dd className="text-sm font-medium text-foreground">{children}</dd>
    </div>
  )
}

/**
 * A aba "Sobre" da Configuração: o que este painel é, em que versão está, se o
 * servidor responde e o que já está ligado nele. Tudo em leitura, e tudo
 * vindo de fontes que já existiam — o arquivo de versão do build, a rota de
 * saúde e o mesmo estado dos "Primeiros passos" do Dashboard.
 *
 * A versão do servidor ao lado da do navegador existe por um motivo prático:
 * depois de uma atualização, a aba aberta há dias continua com o JavaScript
 * antigo, e o sintoma ("o botão novo não apareceu") não se parece com a causa.
 */
export function AboutTab({ appName }: { appName: string }) {
  const { t, locale, formatDateTime } = useTranslation()
  const { user, can } = useAuth()
  const { tenant, providerName, isSaas } = useTenant()
  // O da sessão: no host compartilhado o `TenantProvider` lê o PRIMEIRO
  // provedor, e esta linha diria o identificador de outro.
  const providerSlug = user?.tenant?.slug || tenant?.slug
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [checking, setChecking] = useState(false)
  const [integrations, setIntegrations] = useState<OnboardingStatus | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)

  const podeVerIntegracoes = can('settings.read')

  const checarServidor = useCallback(async () => {
    setChecking(true)
    setHealthError(false)
    try {
      const base = import.meta.env.VITE_API_URL || ''
      const res = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } })
      const body = await res.json() as Health
      setHealth(body)
    } catch {
      setHealth(null)
      setHealthError(true)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void checarServidor()
  }, [checarServidor])

  useEffect(() => {
    if (!podeVerIntegracoes) return
    let cancelled = false
    settingsAPI.onboardingStatus()
      .then((res) => { if (!cancelled && res.success && res.data) setIntegrations(res.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [podeVerIntegracoes])

  const versaoPainel = APP_RELEASE.version
  const versaoDiferente = Boolean(health?.version && health.version !== versaoPainel)
  const operando = health?.status === 'ok'

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('settings.about.panelTitle')}</h2>
            <p className="field-hint mt-1">{t('settings.about.panelHint')}</p>
          </div>
          <button type="button" className="modern-button-secondary" onClick={() => setNotesOpen(true)}>
            <Icon name="info" size={16} />
            {t('settings.about.releaseNotes')}
          </button>
        </div>
        <dl className="mt-3 divide-y divide-border">
          <Linha rotulo={t('settings.about.appName')}>{appName}</Linha>
          <Linha rotulo={t('settings.about.version')}>
            <span className="font-mono">v{versaoPainel}</span>
            {APP_RELEASE.build ? <span className="ml-2 text-muted-foreground">build {APP_RELEASE.build}</span> : null}
          </Linha>
          {__APP_COMMIT__ && (
            <Linha rotulo={t('settings.about.commit')}>
              <span className="font-mono">{__APP_COMMIT__}</span>
            </Linha>
          )}
          {APP_RELEASE.releasedAt && (
            <Linha rotulo={t('settings.about.releasedAt')}>{APP_RELEASE.releasedAt.split('-').reverse().join('/')}</Linha>
          )}
          <Linha rotulo={t('settings.about.edition')}>
            {t(isSaas ? 'settings.about.editionSaas' : 'settings.about.editionSelfHosted')}
          </Linha>
        </dl>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('settings.about.serverTitle')}</h2>
            <p className="field-hint mt-1">{t('settings.about.serverHint')}</p>
          </div>
          <button type="button" className="modern-button-secondary" disabled={checking} onClick={() => void checarServidor()}>
            <Icon name="refresh" size={16} className={checking ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
        {healthError ? (
          <p className="mt-4 text-sm text-[hsl(var(--status-danger))]">{t('settings.about.serverUnreachable')}</p>
        ) : (
          <dl className="mt-3 divide-y divide-border">
            <Linha rotulo={t('settings.about.status')}>
              {health ? (
                <span className={operando ? 'modern-badge-success' : 'modern-badge-warning'}>
                  {t(operando ? 'settings.about.statusOk' : 'settings.about.statusDegraded')}
                </span>
              ) : '—'}
            </Linha>
            <Linha rotulo={t('settings.about.database')}>
              {health ? (
                <span className={health.database === 'ok' ? 'modern-badge-success' : 'modern-badge-error'}>
                  {t(health.database === 'ok' ? 'settings.about.databaseOk' : 'settings.about.databaseDown')}
                </span>
              ) : '—'}
            </Linha>
            <Linha rotulo={t('settings.about.serverVersion')}>
              <span className="font-mono">{health?.version ? `v${health.version}` : '—'}</span>
            </Linha>
            <Linha rotulo={t('settings.about.checkedAt')}>
              {health?.timestamp ? formatDateTime(health.timestamp) : '—'}
            </Linha>
          </dl>
        )}
        {versaoDiferente && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
            <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
            <p className="text-sm leading-6">{t('settings.about.versionMismatch')}</p>
          </div>
        )}
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.about.sessionTitle')}</h2>
        <dl className="mt-3 divide-y divide-border">
          {providerName && <Linha rotulo={t('settings.about.provider')}>{providerName}</Linha>}
          {providerSlug && (
            <Linha rotulo={t('settings.about.providerId')}>
              <span className="font-mono">{providerSlug}</span>
            </Linha>
          )}
          <Linha rotulo={t('settings.about.user')}>{user?.username ?? '—'}</Linha>
          <Linha rotulo={t('settings.about.role')}>{t(ROLE_LABEL_KEYS[normalizeRole(user?.role)])}</Linha>
          <Linha rotulo={t('settings.about.language')}>{LOCALE_METADATA[locale].label}</Linha>
        </dl>
      </section>

      {podeVerIntegracoes && (
        <section className="modern-card p-5 sm:p-6">
          <h2 className="section-heading">{t('settings.about.integrationsTitle')}</h2>
          <p className="field-hint mt-1">{t('settings.about.integrationsHint')}</p>
          {!integrations ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {integrations.items.map(({ key, done }) => (
                <li key={key} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-sm text-foreground">{t(`onboarding.checklist.${key}.title` as TranslationKey)}</span>
                  <span className={done ? 'modern-badge-success' : 'modern-badge-warning'}>
                    {t(done ? 'onboarding.done.configured' : 'onboarding.done.pending')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ReleaseNotesModal open={notesOpen} onClose={() => setNotesOpen(false)} />
    </div>
  )
}

export default AboutTab
