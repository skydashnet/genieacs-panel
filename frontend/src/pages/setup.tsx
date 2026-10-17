'use client'

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'

export default function Setup() {
  const [formData, setFormData] = useState({ username: '', email: '', password: '', confirmPassword: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { completeSetup } = useAuth()
  const { t } = useTranslation()
  const { name } = useTenant()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (formData.username.trim().length < 3) {
      setError(t('setup.error.usernameTooShort'))
      return
    }
    // Conferência frouxa de propósito, e só para pegar engano de digitação: o
    // servidor é quem decide, e uma regra mais apertada aqui recusaria endereço
    // válido que ele aceitaria — numa tela sem administrador acima para
    // corrigir, porque esta conta é a primeira do install.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      setError(t('setup.error.emailInvalid'))
      return
    }
    if (formData.password.length < 8) {
      setError(t('setup.error.passwordTooShort'))
      return
    }
    if (formData.password !== formData.confirmPassword) {
      setError(t('setup.error.passwordMismatch'))
      return
    }

    setLoading(true)
    try {
      if (!await completeSetup(formData.username.trim(), formData.password, formData.email.trim())) {
        setError(t('setup.error.createFailed'))
      }
    } catch {
      setError(t('setup.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }

  const updateField = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((value) => ({ ...value, [event.target.name]: event.target.value }))
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(22rem,0.8fr)_minmax(32rem,1.2fr)]">
      <section className="hidden flex-col justify-between bg-[#18211d] p-10 text-[#f4f3ed] lg:flex xl:p-14" aria-label={t('setup.information')}>
        <div className="flex items-center gap-3">
          <BrandMark className="size-11" />
          <div>
            <div className="text-lg font-bold">{name}</div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">{t('setup.firstRun')}</div>
          </div>
        </div>
        <div className="max-w-lg">
          <div className="mb-5 h-px w-16 bg-[#d97706]" />
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-white">
            {t('setup.hero.title')}
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-[#b8c4bd]">
            {t('setup.hero.description')}
          </p>
        </div>
        <p className="text-xs leading-5 text-[#819087]">{t('setup.hero.footer')}</p>
      </section>

      <main className="flex min-h-screen items-start justify-center px-4 pb-10 pt-12 sm:px-8 lg:items-center lg:py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 lg:hidden">
              <BrandMark className="size-10 shrink-0" title={name} />
              <div className="min-w-0">
                <div className="font-bold wrap-anywhere">{name}</div>
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">{t('setup.firstRun')}</div>
              </div>
            </div>
            <LanguageSwitcher collapseOnMobile className="ms-auto shrink-0" />
          </div>

          <div className="auth-panel">
            <div className="mb-7">
              <p className="page-kicker">{t('setup.kicker')}</p>
              <h1 className="text-2xl font-bold text-foreground">{t('setup.title')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t('setup.subtitle')}
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              {error && (
                <div id="setup-error" className="alert-error flex gap-2.5" role="alert">
                  <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label htmlFor="username" className="field-label">{t('setup.username')}</label>
                <input id="username" name="username" autoComplete="username" required autoFocus value={formData.username}
                  onChange={updateField} className="modern-input" placeholder="network-admin"
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : 'username-hint'} />
                <p id="username-hint" className="field-hint">{t('setup.usernameHint')}</p>
              </div>

              <div>
                <label htmlFor="email" className="field-label">{t('setup.email')}</label>
                <input id="email" name="email" type="email" autoComplete="email" required value={formData.email}
                  onChange={updateField} className="modern-input" placeholder={t('setup.emailPlaceholder')}
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : 'email-hint'} />
                <p id="email-hint" className="field-hint">{t('setup.emailHint')}</p>
              </div>

              <div>
                <label htmlFor="password" className="field-label">{t('setup.password')}</label>
                <input id="password" name="password" type="password" autoComplete="new-password" required value={formData.password}
                  onChange={updateField} className="modern-input" placeholder={t('setup.passwordPlaceholder')}
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : 'password-hint'} />
                <p id="password-hint" className="field-hint">{t('setup.passwordHint')}</p>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="field-label">{t('setup.confirmPassword')}</label>
                <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required
                  value={formData.confirmPassword} onChange={updateField} className="modern-input" placeholder={t('setup.confirmPasswordPlaceholder')}
                  aria-invalid={Boolean(error)} aria-describedby={error ? 'setup-error' : undefined} />
              </div>

              <button type="submit" disabled={loading} className="modern-button w-full">
                {loading ? t('setup.submitting') : t('setup.submit')}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  )
}
