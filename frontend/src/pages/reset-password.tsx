'use client'

import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { authAPI } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'

/**
 * "Esqueci minha senha": a escolha da senha nova.
 *
 * O token vem no FRAGMENTO, como o do convite e o da personificação e pelo
 * mesmo motivo: é uma credencial — quem o tem escolhe a senha desta conta — e o
 * fragmento é a única parte do endereço que o navegador não manda ao servidor.
 * Ele é limpo da barra assim que é lido, porque a partir daí só faria companhia
 * ao histórico e a uma eventual captura de tela.
 *
 * Ao contrário do convite e da personificação, aqui NÃO nasce sessão. É
 * deliberado no backend, e a tela segue a decisão: manda para o login. A senha
 * recém-escolhida é usada uma vez na frente de quem a escolheu, que é como se
 * descobre ali mesmo que ela foi digitada errada.
 */
export default function ResetPassword() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [token] = useState(() => {
    const valor = window.location.hash.slice(1)
    window.history.replaceState(null, '', window.location.pathname)
    return valor
  })
  const [form, setForm] = useState({ password: '', confirm: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (form.password.length < 8) return setError(t('setup.error.passwordTooShort'))
    if (form.password !== form.confirm) return setError(t('reset.mismatch'))

    setSubmitting(true)
    try {
      const res = await authAPI.confirmPasswordReset(token, form.password)
      if (res.success) {
        navigate('/login', { replace: true })
        return
      }
      setError(res.message || t('reset.failed'))
    } catch {
      setError(t('login.error.unreachable'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-background px-4 pb-10 pt-16 sm:px-8 lg:items-center lg:py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="size-10 shrink-0" />
            <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">
              {t('app.genieacsOperations')}
            </div>
          </div>
          <LanguageSwitcher collapseOnMobile className="ml-auto shrink-0" />
        </div>

        <div className="auth-panel">
          <p className="page-kicker">{t('forgot.kicker')}</p>
          {!token ? (
            <>
              {/* Vencido, já usado, de outro painel e inexistente respondem a
                  mesma coisa; um link sem token nenhum entra no mesmo balde. */}
              <h1 className="text-2xl font-bold text-foreground">{t('reset.invalidTitle')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('reset.invalidText')}</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-foreground">{t('reset.title')}</h1>
              <p className="mt-2 mb-7 text-sm leading-6 text-muted-foreground">{t('reset.subtitle')}</p>

              <form className="space-y-5" onSubmit={submit} noValidate>
                {error && (
                  <div className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div>
                  <label htmlFor="reset-password" className="field-label">{t('reset.newPassword')}</label>
                  <input
                    id="reset-password" type="password" className="modern-input" required autoFocus
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />
                  <p className="field-hint">{t('invite.passwordHint')}</p>
                </div>
                <div>
                  <label htmlFor="reset-confirm" className="field-label">{t('reset.confirmPassword')}</label>
                  <input
                    id="reset-confirm" type="password" className="modern-input" required
                    autoComplete="new-password"
                    value={form.confirm}
                    onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))}
                  />
                </div>

                <button type="submit" disabled={submitting} className="modern-button w-full">
                  {submitting ? t('reset.saving') : t('reset.save')}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
          <Link to="/login" className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('invite.backToLogin')}</Link>
        </p>
      </div>
    </main>
  )
}
