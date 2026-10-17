'use client'

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { mapSettingsAPI, settingsAPI, sgpAPI, tenantAPI, usersAPI, whatsappAPI, type GenieAcsAuthType, type TenantBilling, type WhatsAppConfig } from '@/lib/api'
import { canGeocode, geocodeFields } from '@/lib/provider-location'
import { Icon } from '@/components/ui/icon'
import { LocationPicker, wrapLongitude } from '@/components/location-picker'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'
import { onboardingDismissKey } from '@/lib/onboarding'
import { useAuth } from '@/contexts/auth-context'
import { WhatsAppConnection } from '@/components/whatsapp-connection'

/**
 * The first minutes of a provider that just signed up: a welcome, what it is
 * called and where its plant is, which GenieACS it manages, the SGP and the
 * WhatsApp number (each optional, and only for who may configure them), a
 * first colleague, and a summary of what got done. Every screen is a form the
 * settings page already has — the same API in a different order, not a second
 * way to write any of it.
 *
 * Shown by `OnboardingGate` while the provider has no GenieACS address, which
 * is the one thing a panel cannot do anything without. Skippable, and the skip
 * is remembered per provider in the browser: an operator who wants to set
 * things up from the settings page is not nagged into a wizard.
 */

type Step = 'welcome' | 'identity' | 'acs' | 'sgp' | 'whatsapp' | 'team' | 'done'

/** O que ficou feito nesta passagem pelo assistente, para o resumo final. */
interface Saved {
  acs: boolean
  sgp: boolean
  whatsapp: boolean
  colleague: boolean
}

export default function Onboarding() {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { name: currentName, refresh, platformManaged } = useTenant()
  const { can, user } = useAuth()
  const [step, setStep] = useState<Step>('welcome')
  const [busy, setBusy] = useState(false)
  // Na SaaS o ACS é da plataforma, salvo quando o console marcou que o
  // provedor usa o próprio servidor. Até saber, o lado seguro: da plataforma.
  const [ownAcs, setOwnAcs] = useState(false)
  const acsManaged = platformManaged && !ownAcs
  useEffect(() => {
    if (!platformManaged) return
    let cancelled = false
    void settingsAPI.getGenieAcsAuth().then((res) => {
      if (!cancelled && res.success && res.data?.platformManaged === false) setOwnAcs(true)
    })
    return () => { cancelled = true }
  }, [platformManaged])

  // SGP e WhatsApp só para quem pode configurá-los: um passo que responderia
  // 403 ao salvar é um passo que não deveria aparecer.
  const canSgp = can('sgp.config')
  const canWhatsapp = can('whatsapp.config')
  const canBilling = can('settings.write')
  const canMapWrite = can('map.write')
  const steps = useMemo<Step[]>(() => [
    'welcome', 'identity', 'acs',
    ...(canSgp ? ['sgp' as const] : []),
    ...(canWhatsapp ? ['whatsapp' as const] : []),
    'team', 'done'
  ], [canSgp, canWhatsapp])
  const go = (delta: 1 | -1) => {
    const next = steps[steps.indexOf(step) + delta]
    if (next) setStep(next)
  }
  const [saved, setSaved] = useState<Saved>({ acs: false, sgp: false, whatsapp: false, colleague: false })

  const [sgp, setSgp] = useState({ baseUrl: '', app: '', token: '' })
  const [sgpReady, setSgpReady] = useState(false)
  const [sgpTest, setSgpTest] = useState<string | null>(null)
  const [waConfig, setWaConfig] = useState<WhatsAppConfig | null>(null)
  const [waProblem, setWaProblem] = useState(false)

  const [name, setName] = useState(currentName)
  const [center, setCenter] = useState<{ lat: string; lng: string }>({ lat: '', lng: '' })
  // O CNPJ do passo 1 e o cadastro que ele trouxe, gravado ao avançar.
  const [cnpj, setCnpj] = useState('')
  const [cnpjBusy, setCnpjBusy] = useState(false)
  const [billingFound, setBillingFound] = useState<Partial<TenantBilling> | null>(null)
  const [acs, setAcs] = useState({ url: '', authType: 'none' as GenieAcsAuthType, username: '', secret: '' })
  const [testResult, setTestResult] = useState<string | null>(null)
  /** O endereço que a plataforma sugere para este provedor, se houver um. */
  const [suggested, setSuggested] = useState<string | null>(null)
  const [colleague, setColleague] = useState({ username: '', email: '', password: '' })

  useEffect(() => {
    setName(currentName)
  }, [currentName])

  useEffect(() => {
    void (async () => {
      const map = await mapSettingsAPI.get()
      const data = map.data as { center_lat?: string; center_lng?: string } | undefined
      if (map.success && data) setCenter({ lat: String(data.center_lat ?? ''), lng: String(data.center_lng ?? '') })
    })()
  }, [])

  /**
   * A sugestão de endereço do ACS, quando o deploy hospeda um por provedor.
   *
   * Preenche o campo, e não só mostra ao lado: quem chega aqui quer avançar, e
   * um valor que precisa ser copiado à mão é um valor que vai ser digitado
   * errado. Continua editável — é sugestão, não imposição.
   *
   * Só preenche o campo VAZIO. Este efeito roda uma vez, mas um `setAcs` que
   * sobrescrevesse o que já está lá seria a forma de apagar o que o operador
   * acabou de digitar, no dia em que alguém acrescentar uma dependência aqui.
   */
  useEffect(() => {
    void (async () => {
      const res = await settingsAPI.genieAcsSuggestion()
      const sugerido = res.success ? (res.data?.suggestion ?? null) : null
      if (!sugerido) return
      setSuggested(sugerido)
      setAcs((a) => (a.url.trim() === '' ? { ...a, url: sugerido } : a))
    })()
  }, [])

  // O SGP já configurado não é perguntado de novo: o passo só confirma.
  useEffect(() => {
    if (step !== 'sgp') return
    let cancelled = false
    void sgpAPI.getConfig().then((res) => {
      if (cancelled || !res.success || !res.data) return
      setSgp((c) => ({ ...c, baseUrl: c.baseUrl || res.data!.baseUrl || '', app: c.app || res.data!.app || '' }))
      if (res.data.ready) {
        setSgpReady(true)
        setSaved((s) => ({ ...s, sgp: true }))
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [step])

  /**
   * O WhatsApp de um provedor novo ainda não está ligado, e sem isso o bloco de
   * conexão não deixa adicionar número. O endereço público do painel é o desta
   * própria aba: é por ele que a Evolution vai entregar as mensagens.
   */
  useEffect(() => {
    if (step !== 'whatsapp' || waConfig) return
    let cancelled = false
    void (async () => {
      try {
        const res = await whatsappAPI.getConfig()
        if (cancelled) return
        if (!res.success || !res.data) { setWaProblem(true); return }
        let config = res.data
        // Quando a plataforma fornece o servidor, o provedor só liga a
        // integração — e só se o servidor já estiver lá. Sem ele, o bloco de
        // conexão mostra o aviso e fica esperando a plataforma.
        const podeLigar = platformManaged ? Boolean(config.managedUrl) : true
        if (!config.ready && podeLigar) {
          const updated = await whatsappAPI.updateConfig(platformManaged
            ? { enabled: true }
            : { enabled: true, webhookBaseUrl: config.webhookBaseUrl || window.location.origin })
          if (cancelled) return
          if (updated.success && updated.data) config = updated.data
          else if (!platformManaged) { setWaProblem(true); return }
        }
        setWaConfig(config)
      } catch {
        if (!cancelled) setWaProblem(true)
      }
    })()
    return () => { cancelled = true }
  }, [step, waConfig, platformManaged])

  const testSgp = async () => {
    setBusy(true)
    setSgpTest(null)
    try {
      const res = await sgpAPI.test({ baseUrl: sgp.baseUrl.trim(), app: sgp.app.trim(), token: sgp.token.trim() || undefined })
      setSgpTest(res.success
        ? t('onboarding.sgp.testOk', { count: res.data?.contracts ?? 0 })
        : (res.message || t('onboarding.sgp.testFailed')))
    } catch (error) {
      setSgpTest(error instanceof Error && error.message ? error.message : t('onboarding.sgp.testFailed'))
    } finally {
      setBusy(false)
    }
  }

  const saveSgp = async () => {
    // Já pronto e nada digitado: só segue.
    if (sgpReady && !sgp.token.trim()) { go(1); return }
    if (!sgp.baseUrl.trim() || !sgp.app.trim() || !sgp.token.trim()) {
      toast.error(t('onboarding.sgp.required'))
      return
    }
    setBusy(true)
    try {
      const res = await sgpAPI.updateConfig({ enabled: true, baseUrl: sgp.baseUrl.trim(), app: sgp.app.trim(), token: sgp.token.trim() })
      if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      setSaved((s) => ({ ...s, sgp: true }))
      go(1)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('settings.saveError'))
    } finally {
      setBusy(false)
    }
  }

  const leaveWhatsapp = async () => {
    try {
      const res = await whatsappAPI.listAccounts()
      if (res.success && res.data) setSaved((s) => ({ ...s, whatsapp: res.data!.length > 0 }))
    } catch {}
    go(1)
  }

  const finish = () => {
    // No provedor, para outro administrador ou outro navegador não receberem o
    // assistente de novo. Se a gravação falhar, o '1' local faz o gate subir a
    // marca na próxima visita.
    //
    // O espelho é o do provedor da sessão, não o do host: no host compartilhado
    // o `tenant` é o do primeiro provedor. Sem slug na sessão, só o servidor.
    const sessionSlug = user?.tenant?.slug
    void settingsAPI.dismissOnboarding('wizard').then((res) => {
      if (res.success && sessionSlug) {
        try { localStorage.setItem(onboardingDismissKey(sessionSlug), '2') } catch {}
      }
    }).catch(() => {})
    if (sessionSlug) {
      try { localStorage.setItem(onboardingDismissKey(sessionSlug), '1') } catch {}
    }
    navigate('/dashboard', { replace: true })
  }

  /**
   * O CNPJ preenche o passo inteiro: o nome do painel (nome fantasia, ou a
   * razão social), o cadastro fiscal — gravado ao avançar — e o ponto no mapa
   * pelo endereço. Tudo editável antes de avançar.
   */
  const fillFromCnpj = async () => {
    setCnpjBusy(true)
    try {
      const res = await tenantAPI.lookupCnpj(cnpj)
      if (!res.success || !res.data) { toast.error(res.message || t('settings.providerAddress.cnpjLookupFailed')); return }
      const { tradeName, ...billing } = res.data
      const suggested = (tradeName || billing.legalName || '').trim()
      if (suggested) setName(suggested.slice(0, 128))
      setBillingFound(billing)
      toast.success(t('onboarding.identity.cnpjFilled'))
      const form = billing as Record<string, string | null | undefined>
      if (canMapWrite && canGeocode(form)) {
        const geo = await tenantAPI.geocode(geocodeFields(form))
        if (geo.success && geo.data) setCenter({ lat: String(geo.data.lat), lng: String(geo.data.lng) })
      }
    } finally {
      setCnpjBusy(false)
    }
  }

  const saveIdentity = async () => {
    setBusy(true)
    try {
      const trimmed = name.trim()
      if (trimmed && trimmed !== currentName) {
        const res = await tenantAPI.rename(trimmed)
        if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
        await refresh()
      }
      // O cadastro que o CNPJ trouxe. Um erro aqui avisa, mas não prende o
      // provedor no primeiro passo: a aba Geral grava o mesmo depois.
      if (billingFound && canBilling) {
        const res = await tenantAPI.updateBilling(billingFound)
        if (res.success) setBillingFound(null)
        else toast.error(res.message || t('billing.saveFailed'))
      }
      const lat = Number(center.lat), lng = wrapLongitude(Number(center.lng))
      if (center.lat !== '' && center.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng)) {
        const current = await mapSettingsAPI.get()
        const res = await mapSettingsAPI.update({ ...(current.data as object ?? {}), center_lat: String(lat), center_lng: String(lng) })
        if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      }
      go(1)
    } finally {
      setBusy(false)
    }
  }

  const testAcs = async () => {
    setBusy(true)
    setTestResult(null)
    try {
      const res = await settingsAPI.testGenieAcs(acs.url.trim())
      setTestResult(res.success ? t('onboarding.acs.testOk') : (res.message || t('onboarding.acs.testFailed')))
    } finally {
      setBusy(false)
    }
  }

  const saveAcs = async () => {
    const url = acs.url.trim()
    if (!url) { toast.error(t('onboarding.acs.urlRequired')); return }
    if (acs.authType === 'basic' && !acs.username.trim()) { toast.error(t('settings.genieAuth.usernameRequired')); return }
    setBusy(true)
    try {
      const saved = await settingsAPI.update('genieAcsUrl', url)
      if (!saved.success) { toast.error(saved.message || t('settings.saveError')); return }
      const auth = await settingsAPI.updateGenieAcsAuth({
        authType: acs.authType,
        username: acs.username.trim(),
        ...(acs.authType !== 'none' && acs.secret ? { secret: acs.secret } : {})
      })
      if (!auth.success) { toast.error(auth.message || t('settings.genieAuth.saveFailed')); return }
      setSaved((s) => ({ ...s, acs: true }))
      go(1)
    } finally {
      setBusy(false)
    }
  }

  const saveColleague = async () => {
    if (!colleague.username.trim()) { go(1); return }
    setBusy(true)
    try {
      const res = await usersAPI.create({ username: colleague.username.trim(), email: colleague.email.trim(), password: colleague.password, role: 'tech' })
      if (!res.success) { toast.error(res.message || t('settings.saveError')); return }
      setSaved((s) => ({ ...s, colleague: true }))
      go(1)
    } finally {
      setBusy(false)
    }
  }

  // "Passo X de Y" conta só os passos com formulário: a boas-vindas e o resumo
  // não são passos, são a porta de entrada e a de saída.
  const middle: Step[] = steps.filter((s) => s !== 'welcome' && s !== 'done')
  const index = middle.indexOf(step)
  const inMiddle = index !== -1
  const kicker = inMiddle
    ? t('onboarding.kicker', { step: index + 1, total: middle.length })
    : t(step === 'welcome' ? 'onboarding.welcome.kicker' : 'onboarding.done.kicker')
  const doneCount = step === 'done' ? middle.length : Math.max(index, 0)

  return (
    <div className="page-shell">
      <div className="page-frame max-w-2xl">
        <header className="page-header">
          <div>
            <p className="page-kicker">{kicker}</p>
            <h1 className="page-title">{t(`onboarding.${step}.title`, { name: currentName })}</h1>
            <p className="page-description">{t(`onboarding.${step}.description`)}</p>
          </div>
          {step !== 'done' && (
            <button type="button" className="modern-button-secondary" onClick={finish}>{t('onboarding.skip')}</button>
          )}
        </header>

        {step !== 'welcome' && (
          <div
            className="mb-5 h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={t('onboarding.progress')}
            aria-valuemin={0}
            aria-valuemax={middle.length}
            aria-valuenow={doneCount}
          >
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round((doneCount / middle.length) * 100)}%` }} />
          </div>
        )}

        <div className="modern-card space-y-5 p-5 sm:p-6">
          {step === 'welcome' && (
            <>
              <ul className="space-y-3">
                {([
                  ['server', 'onboarding.welcome.point1'],
                  ['invoice', 'onboarding.welcome.point2'],
                  ['chat', 'onboarding.welcome.point3']
                ] as const).map(([icon, key]) => (
                  <li key={key} className="flex items-start gap-3">
                    <Icon name={icon} size={18} className="mt-0.5 shrink-0 text-primary" />
                    <span className="text-sm leading-6 text-foreground">{t(key)}</span>
                  </li>
                ))}
              </ul>
              <p className="field-hint">{t('onboarding.welcome.time')}</p>
              <button type="button" className="modern-button" onClick={() => go(1)}>
                {t('onboarding.welcome.start')}
              </button>
            </>
          )}

          {step === 'identity' && (
            <>
              {canBilling && (
                <div>
                  <label htmlFor="ob-cnpj" className="field-label">{t('onboarding.identity.cnpj')}</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input id="ob-cnpj" className="modern-input w-full sm:flex-1" inputMode="numeric" maxLength={20} value={cnpj} onChange={(e) => setCnpj(e.target.value)} />
                    <button
                      type="button"
                      className="modern-button-secondary whitespace-nowrap"
                      disabled={busy || cnpjBusy || cnpj.replace(/\D/g, '').length !== 14}
                      onClick={() => void fillFromCnpj()}
                    >
                      {cnpjBusy ? t('settings.providerAddress.cnpjLooking') : t('settings.providerAddress.cnpjFill')}
                    </button>
                  </div>
                  <p className="field-hint">{t('onboarding.identity.cnpjHint')}</p>
                </div>
              )}
              <div>
                <label htmlFor="ob-name" className="field-label">{t('settings.general.appName')}</label>
                <input id="ob-name" className="modern-input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ob-lat" className="field-label">{t('onboarding.identity.lat')}</label>
                  <input id="ob-lat" className="modern-input w-full" inputMode="decimal" value={center.lat} onChange={(e) => setCenter((c) => ({ ...c, lat: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="ob-lng" className="field-label">{t('onboarding.identity.lng')}</label>
                  <input id="ob-lng" className="modern-input w-full" inputMode="decimal" value={center.lng} onChange={(e) => setCenter((c) => ({ ...c, lng: e.target.value }))} />
                </div>
              </div>
              <LocationPicker
                lat={center.lat.trim() === '' ? null : Number(center.lat)}
                lng={center.lng.trim() === '' ? null : Number(center.lng)}
                onChange={(lat, lng) => setCenter({ lat: String(lat), lng: String(lng) })}
              />
              <p className="field-hint">{t('onboarding.identity.mapHint')}</p>
              <button type="button" className="modern-button" disabled={busy} onClick={() => void saveIdentity()}>
                {busy ? t('common.saving') : t('common.next')}
              </button>
            </>
          )}

          {/* Na SaaS quem aponta o painel para o ACS é a plataforma, pelo
              console: o passo vira aviso, e segue adiante sem gravar nada.
              Com ACS próprio, o passo é o mesmo da self-hosted. */}
          {step === 'acs' && acsManaged && (
            <>
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-4">
                <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
                <p className="text-sm leading-6">{t('onboarding.acs.platformManaged')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => go(-1)}>{t('common.back')}</button>
                <button type="button" className="modern-button" onClick={() => go(1)}>{t('common.next')}</button>
              </div>
            </>
          )}

          {step === 'acs' && !acsManaged && (
            <>
              <div>
                <label htmlFor="ob-acs" className="field-label">{t('settings.general.genieAcsUrl')}</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input id="ob-acs" className="modern-input flex-1" placeholder="https://acs.seu-provedor.com.br:7557" value={acs.url} onChange={(e) => setAcs((a) => ({ ...a, url: e.target.value }))} />
                  <button type="button" className="modern-button-secondary" disabled={busy || !acs.url.trim()} onClick={() => void testAcs()}>
                    {t('settings.general.testConnection')}
                  </button>
                </div>
                {/* De onde veio o valor. Sem esta linha, o campo aparece
                    preenchido e ninguém sabe se foi o painel ou um resto de
                    sessão anterior — e a primeira reação é apagar. */}
                {suggested && acs.url === suggested && (
                  <p className="field-hint">{t('onboarding.acsSuggested')}</p>
                )}
                {testResult && <p className="field-hint">{testResult}</p>}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="ob-auth" className="field-label">{t('settings.genieAuth.type')}</label>
                  <select id="ob-auth" className="modern-input w-full" value={acs.authType} onChange={(e) => setAcs((a) => ({ ...a, authType: e.target.value as GenieAcsAuthType }))}>
                    <option value="none">{t('settings.genieAuth.typeNone')}</option>
                    <option value="basic">{t('settings.genieAuth.typeBasic')}</option>
                    <option value="bearer">{t('settings.genieAuth.typeBearer')}</option>
                  </select>
                </div>
                {acs.authType === 'basic' && (
                  <div>
                    <label htmlFor="ob-user" className="field-label">{t('settings.genieAuth.username')}</label>
                    <input id="ob-user" className="modern-input w-full" autoComplete="off" value={acs.username} onChange={(e) => setAcs((a) => ({ ...a, username: e.target.value }))} />
                  </div>
                )}
                {acs.authType !== 'none' && (
                  <div>
                    <label htmlFor="ob-secret" className="field-label">{t(acs.authType === 'basic' ? 'settings.genieAuth.password' : 'settings.genieAuth.token')}</label>
                    <input id="ob-secret" type="password" className="modern-input w-full" autoComplete="new-password" value={acs.secret} onChange={(e) => setAcs((a) => ({ ...a, secret: e.target.value }))} />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => go(-1)}>{t('common.back')}</button>
                <button type="button" className="modern-button" disabled={busy} onClick={() => void saveAcs()}>
                  {busy ? t('common.saving') : t('common.next')}
                </button>
              </div>
            </>
          )}

          {step === 'sgp' && (
            <>
              {sgpReady && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-4">
                  <Icon name="check" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-success))]" />
                  <p className="text-sm leading-6">{t('onboarding.sgp.alreadyConfigured')}</p>
                </div>
              )}
              <div>
                <label htmlFor="ob-sgp-url" className="field-label">{t('settings.sgp.baseUrl')}</label>
                <input id="ob-sgp-url" type="url" className="modern-input w-full" placeholder="https://sgp.seu-provedor.com.br" value={sgp.baseUrl} onChange={(e) => setSgp((c) => ({ ...c, baseUrl: e.target.value }))} />
                <p className="field-hint">{t('settings.sgp.baseUrlHint')}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ob-sgp-app" className="field-label">{t('settings.sgp.app')}</label>
                  <input id="ob-sgp-app" className="modern-input w-full" autoComplete="off" value={sgp.app} onChange={(e) => setSgp((c) => ({ ...c, app: e.target.value }))} />
                  <p className="field-hint">{t('settings.sgp.appHint')}</p>
                </div>
                <div>
                  <label htmlFor="ob-sgp-token" className="field-label">{t('settings.sgp.token')}</label>
                  <input
                    id="ob-sgp-token"
                    type="password"
                    className="modern-input w-full"
                    autoComplete="new-password"
                    placeholder={sgpReady ? t('settings.sgp.tokenPlaceholderStored') : t('settings.sgp.tokenPlaceholderEmpty')}
                    value={sgp.token}
                    onChange={(e) => setSgp((c) => ({ ...c, token: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <button type="button" className="modern-button-secondary" disabled={busy || !sgp.baseUrl.trim() || !sgp.app.trim()} onClick={() => void testSgp()}>
                  {t('settings.general.testConnection')}
                </button>
                {sgpTest && <p className="field-hint">{sgpTest}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => go(-1)}>{t('common.back')}</button>
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => go(1)}>{t('onboarding.skipStep')}</button>
                <button type="button" className="modern-button" disabled={busy} onClick={() => void saveSgp()}>
                  {busy ? t('common.saving') : t('common.next')}
                </button>
              </div>
            </>
          )}

          {step === 'whatsapp' && (
            <>
              {waProblem && <p className="field-hint">{t('onboarding.whatsapp.notAvailable')}</p>}
              {!waProblem && !waConfig && <p className="field-hint">{t('onboarding.whatsapp.preparing')}</p>}
              {waConfig && platformManaged && !waConfig.managedUrl && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-4">
                  <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
                  <p className="text-sm leading-6">{t('settings.platformManaged.whatsappMissing')}</p>
                </div>
              )}
              {waConfig && <WhatsAppConnection config={waConfig} compact />}
              <div className="flex flex-wrap gap-2">
                <button type="button" className="modern-button-secondary" onClick={() => go(-1)}>{t('common.back')}</button>
                <button type="button" className="modern-button-secondary" onClick={() => go(1)}>{t('onboarding.skipStep')}</button>
                <button type="button" className="modern-button" onClick={() => void leaveWhatsapp()}>{t('common.next')}</button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <ul className="divide-y divide-border">
                {([
                  ['onboarding.done.item.name', Boolean(currentName.trim())],
                  ['onboarding.done.item.acs', saved.acs || acsManaged],
                  ...(canSgp ? [['onboarding.done.item.sgp', saved.sgp] as const] : []),
                  ...(canWhatsapp ? [['onboarding.done.item.whatsapp', saved.whatsapp] as const] : []),
                  ['onboarding.done.item.team', saved.colleague]
                ] as const).map(([key, ok]) => (
                  <li key={key} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <Icon
                        name={ok ? 'check' : 'info'}
                        size={17}
                        className={ok ? 'text-[hsl(var(--status-success))]' : 'text-muted-foreground'}
                      />
                      {t(key)}
                    </span>
                    {/* O ACS da SaaS é da plataforma: dizer "configurado" seria
                        afirmar o que o provedor não fez nem pode conferir. */}
                    {key === 'onboarding.done.item.acs' && acsManaged && !saved.acs ? (
                      <span className="modern-badge-info">{t('onboarding.done.byPlatform')}</span>
                    ) : (
                      <span className={ok ? 'modern-badge-success' : 'modern-badge-warning'}>
                        {t(ok ? 'onboarding.done.configured' : 'onboarding.done.pending')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="field-hint">{t('onboarding.done.pendingHint')}</p>
              <button type="button" className="modern-button" onClick={finish}>
                <Icon name="check" size={17} />
                {t('onboarding.done.goToPanel')}
              </button>
            </>
          )}

          {step === 'team' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="ob-colleague" className="field-label">{t('settings.operators.username')}</label>
                  <input id="ob-colleague" className="modern-input w-full" autoComplete="off" value={colleague.username} onChange={(e) => setColleague((c) => ({ ...c, username: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="ob-colleague-email" className="field-label">{t('settings.operators.email')}</label>
                  <input id="ob-colleague-email" type="email" className="modern-input w-full" autoComplete="off" placeholder={t('settings.operators.emailPlaceholder')} value={colleague.email} onChange={(e) => setColleague((c) => ({ ...c, email: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="ob-colleague-pw" className="field-label">{t('login.password')}</label>
                  <input id="ob-colleague-pw" type="password" className="modern-input w-full" autoComplete="new-password" value={colleague.password} onChange={(e) => setColleague((c) => ({ ...c, password: e.target.value }))} />
                </div>
              </div>
              <p className="field-hint">{t('onboarding.team.hint')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => go(-1)}>{t('common.back')}</button>
                <button type="button" className="modern-button" disabled={busy || (colleague.username.trim() !== '' && (colleague.password.length < 8 || !colleague.email.includes('@')))} onClick={() => void saveColleague()}>
                  <Icon name="check" size={17} />
                  {colleague.username.trim() ? t('onboarding.team.addAndFinish') : t('common.next')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
