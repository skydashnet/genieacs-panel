'use client'

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { authAPI, publicAPI, type PublicPlan, type SignupResult } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'
import { referralCodeFromQuery } from '@/lib/referrals'

/** O nome do provedor como subdomínio: minúsculas, sem acento, hífens. */
function slugFromName(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

/**
 * An ISP signing up on its own. Only reachable where the deployment gives
 * providers subdomains (`panelBaseDomain`), because the answer to a signup is
 * an ADDRESS: the new provider's panel lives at `slug.<base>`, and this host
 * cannot sign the person in there — a token stored here would be refused on
 * that host. So the screen ends with the address and a link, not a session.
 */
export default function Signup() {
  const { t } = useTranslation()
  const { tenant, name: hostName, isPlatformHost } = useTenant()
  const base = tenant?.panelBaseDomain ?? null
  const [params] = useSearchParams()
  // O código do link de indicação (0106). O servidor ignora o inválido e a
  // indicação de si mesmo; aqui só se lê e se mostra.
  const referralCode = referralCodeFromQuery(params.get('ref'))
  const [form, setForm] = useState({
    providerName: '', slug: '', username: '', email: '', password: '', confirm: '',
    planCode: params.get('plano') ?? params.get('plan') ?? '', taxId: '', phone: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<SignupResult | null>(null)
  // O catálogo da página pública, para o plano escolhido vir marcado e poder
  // ser trocado aqui mesmo. Fora do ápice a rota não existe, e a lista fica vazia.
  const [plans, setPlans] = useState<PublicPlan[]>([])
  const [slugState, setSlugState] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  const [cnpj, setCnpj] = useState<{ state: 'idle' | 'checking' | 'found' | 'invalid' | 'failed'; legalName?: string; city?: string; state_?: string }>({ state: 'idle' })

  useEffect(() => {
    if (!isPlatformHost) return
    let vivo = true
    publicAPI.plans()
      .then((res) => { if (vivo && res.success && res.data) setPlans(res.data.plans) })
      .catch(() => {})
    return () => { vivo = false }
  }, [isPlatformHost])

  // O subdomínio conferido enquanto se digita, com a mesma regra do cadastro.
  useEffect(() => {
    if (!isPlatformHost || !form.slug) { setSlugState('idle'); return }
    setSlugState('checking')
    const timer = window.setTimeout(() => {
      publicAPI.slugAvailable(form.slug)
        .then((res) => {
          if (!res.success || !res.data) return setSlugState('idle')
          setSlugState(res.data.available ? 'available' : (res.data.problem === 'taken' ? 'taken' : 'invalid'))
        })
        .catch(() => setSlugState('idle'))
    }, 400)
    return () => window.clearTimeout(timer)
  }, [form.slug, isPlatformHost])

  // O CNPJ completo vai à Receita e preenche o nome, se ainda estiver vazio.
  useEffect(() => {
    const digitos = form.taxId.replace(/\D/g, '')
    if (!isPlatformHost || digitos.length !== 14) { setCnpj({ state: 'idle' }); return }
    let vivo = true
    setCnpj({ state: 'checking' })
    publicAPI.cnpj(digitos)
      .then((res) => {
        if (!vivo) return
        if (res.success && res.data) {
          const dados = res.data
          setCnpj({ state: 'found', legalName: dados.legalName, city: dados.city, state_: dados.state })
          setForm((f) => {
            if (f.providerName.trim()) return f
            const nome = dados.tradeName || dados.legalName || ''
            return { ...f, providerName: nome, slug: f.slug || slugFromName(nome) }
          })
        } else {
          setCnpj({ state: res.message && /inv/i.test(res.message) ? 'invalid' : 'failed' })
        }
      })
      .catch(() => { if (vivo) setCnpj({ state: 'failed' }) })
    return () => { vivo = false }
  }, [form.taxId, isPlatformHost])

  const escolhido = plans.find((plan) => plan.code === form.planCode) ?? null
  const dinheiro = (cents: number, currency: string) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100) } catch { return `${(cents / 100).toFixed(2)} ${currency}` }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (form.providerName.trim().length < 1) return setError(t('signup.error.name'))
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(form.slug) || form.slug.length < 3) return setError(t('signup.error.slug'))
    if (form.username.trim().length < 3) return setError(t('setup.error.usernameTooShort'))
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setError(t('setup.error.emailInvalid'))
    if (form.password.length < 8) return setError(t('setup.error.passwordTooShort'))
    if (form.password !== form.confirm) return setError(t('setup.error.passwordMismatch'))
    const telefone = form.phone.replace(/\D/g, '')
    if (telefone && (telefone.length < 10 || telefone.length > 13)) return setError(t('signup.error.phone'))
    const taxId = form.taxId.replace(/\D/g, '')
    if (taxId && taxId.length !== 14) return setError(t('signup.taxIdInvalid'))
    setLoading(true)
    try {
      const res = await authAPI.signup({
        providerName: form.providerName.trim(), slug: form.slug, username: form.username.trim(), email: form.email.trim(), password: form.password,
        planCode: form.planCode || undefined,
        referralCode: referralCode || undefined,
        taxId: taxId || undefined,
        phone: telefone || undefined,
        legalName: cnpj.state === 'found' ? cnpj.legalName : undefined,
        city: cnpj.state === 'found' ? cnpj.city : undefined,
        state: cnpj.state === 'found' ? cnpj.state_ : undefined
      })
      if (res.success && res.data) setDone(res.data)
      else setError(res.message || t('signup.error.failed'))
    } catch {
      setError(t('login.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-background px-4 pb-10 pt-16 sm:px-8 lg:items-center">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="size-10 shrink-0" title={hostName} />
            <div className="min-w-0">
              <div className="font-bold wrap-anywhere">{hostName}</div>
              <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">{t('app.genieacsOperations')}</div>
            </div>
          </div>
          <LanguageSwitcher collapseOnMobile className="ml-auto shrink-0" />
        </div>

        <div className="auth-panel">
          {!base && !isPlatformHost ? (
            <p className="text-sm text-muted-foreground">{t('signup.unavailable')}</p>
          ) : done ? (
            <div className="space-y-4">
              <p className="page-kicker mb-4">{t('signup.doneKicker')}</p>
              <h1 className="text-2xl font-bold text-foreground">{t('signup.doneTitle', { name: done.tenant.name })}</h1>
              <p className="text-sm leading-6 text-muted-foreground">{t('signup.doneText')}</p>
              {/* A prova do endereço saiu agora, e a pessoa precisa saber que
                  ela existe antes de fechar esta aba. Quando o deploy não tem
                  SMTP a tela não promete nada: dizer "confira seu e-mail" para
                  quem nunca vai receber é pior do que não dizer. */}
              {done.emailed && (
                <p className="alert-info text-sm leading-6">{t('signup.checkInbox', { email: form.email })}</p>
              )}
              {done.panelUrl && (
                <a href={done.panelUrl} className="modern-button w-full">
                  <Icon name="external" size={17} />
                  {done.panelUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          ) : (
            <>
              <div className="mb-7">
                <p className="page-kicker">{t('signup.kicker')}</p>
                <h1 className="text-2xl font-bold text-foreground">{t('signup.title')}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('signup.subtitle')}</p>
                {referralCode && (
                  <p className="alert-info mt-3 text-sm leading-6">{t('signup.referred', { code: referralCode })}</p>
                )}
              </div>
              <form className="space-y-5" onSubmit={submit} noValidate>
                {error && (
                  <div id="signup-error" className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                {plans.length > 0 && (
                  <div>
                    <label htmlFor="planCode" className="field-label">{t('signup.planLabel')}</label>
                    <select
                      id="planCode" className="modern-input" value={form.planCode}
                      onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value }))}
                    >
                      <option value="">{t('signup.planDefault')}</option>
                      {plans.map((plan) => (
                        <option key={plan.code} value={plan.code}>
                          {plan.name} — {dinheiro(plan.priceCents, plan.currency)}
                        </option>
                      ))}
                    </select>
                    {escolhido && escolhido.trialDays > 0 && (
                      <p className="field-hint">{t('signup.planTrial', { days: escolhido.trialDays })}</p>
                    )}
                  </div>
                )}
                {isPlatformHost && (
                  <div>
                    <label htmlFor="taxId" className="field-label">{t('signup.taxId')}</label>
                    <input
                      id="taxId" className="modern-input font-mono" inputMode="numeric" maxLength={18}
                      value={form.taxId} placeholder="00.000.000/0000-00"
                      onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))}
                      aria-describedby="taxId-hint"
                    />
                    <p id="taxId-hint" className="field-hint" aria-live="polite">
                      {cnpj.state === 'checking' ? t('signup.slugChecking')
                        : cnpj.state === 'found' ? t('signup.taxIdFound', { name: cnpj.legalName ?? '' })
                          : cnpj.state === 'invalid' ? t('signup.taxIdInvalid')
                            : cnpj.state === 'failed' ? t('signup.taxIdLookupFailed')
                              : t('signup.taxIdHint')}
                    </p>
                  </div>
                )}
                <div>
                  <label htmlFor="providerName" className="field-label">{t('signup.providerName')}</label>
                  <input
                    id="providerName" className="modern-input" required autoFocus maxLength={128}
                    value={form.providerName}
                    onChange={(e) => setForm((f) => ({ ...f, providerName: e.target.value, slug: f.slug === slugFromName(f.providerName) ? slugFromName(e.target.value) : f.slug }))}
                  />
                </div>
                <div>
                  <label htmlFor="slug" className="field-label">{t('signup.slug')}</label>
                  <div className="flex items-center gap-2">
                    <input
                      id="slug" className="modern-input min-w-0 flex-1 font-mono" required maxLength={63}
                      value={form.slug}
                      onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                      aria-describedby="slug-hint"
                    />
                    {base && (
                      <span className="min-w-0 max-w-[55%] text-sm text-muted-foreground wrap-anywhere">.{base}</span>
                    )}
                  </div>
                  <p id="slug-hint" className="field-hint" aria-live="polite">
                    {slugState === 'checking' ? t('signup.slugChecking')
                      : slugState === 'available' ? <span className="text-emerald-500">✓ {t('signup.slugAvailable')}</span>
                        : slugState === 'taken' ? <span className="text-destructive">✗ {t('signup.slugTaken')}</span>
                          : slugState === 'invalid' ? <span className="text-destructive">✗ {t('signup.slugInvalid')}</span>
                            : t('platform.slugHint')}
                  </p>
                </div>
                <div>
                  <label htmlFor="username" className="field-label">{t('signup.username')}</label>
                  <input id="username" className="modern-input" required autoComplete="username" value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="email" className="field-label">{t('setup.email')}</label>
                  <input id="email" type="email" className="modern-input" required autoComplete="email" placeholder={t('setup.emailPlaceholder')} value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
                  <p className="field-hint">{t('setup.emailHint')}</p>
                </div>
                {isPlatformHost && (
                  <div>
                    <label htmlFor="phone" className="field-label">{t('signup.phone')}</label>
                    <input id="phone" type="tel" className="modern-input" autoComplete="tel" placeholder="(11) 99999-9999" value={form.phone}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
                    <p className="field-hint">{t('signup.phoneHint')}</p>
                  </div>
                )}
                <div>
                  <label htmlFor="password" className="field-label">{t('login.password')}</label>
                  <input id="password" type="password" className="modern-input" required autoComplete="new-password" value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="confirm" className="field-label">{t('setup.confirmPassword')}</label>
                  <input id="confirm" type="password" className="modern-input" required autoComplete="new-password" value={form.confirm}
                    onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} />
                </div>
                <button type="submit" disabled={loading} className="modern-button w-full">
                  {loading ? t('signup.submitting') : t('signup.submit')}
                </button>
              </form>
            </>
          )}
        </div>
        {/* The platform's own host has no login to go back to: whoever has a
            panel signs in at that panel's address. */}
        {!isPlatformHost ? (
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            <Link to="/login" className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('signup.backToLogin')}</Link>
          </p>
        ) : (
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            <Link to="/" className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('signup.backToSite')}</Link>
          </p>
        )}
      </div>
    </main>
  )
}
