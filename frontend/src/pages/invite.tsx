'use client'

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { invitesAPI, type InvitePreview } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { ROLE_LABEL_KEYS } from '@/lib/permissions'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { cleanSecondFactor, mfaStepDaResposta } from '@/lib/login-mfa'



/**
 * Aceitar um convite: a tela que faltava para o link que a API já dava.
 *
 * O token vem no FRAGMENTO da URL, não no caminho nem na query. É uma
 * credencial — quem o tem entra na equipe —, e o fragmento é a única parte do
 * endereço que o navegador não manda ao servidor: ele não aparece em log de
 * proxy, nem no `Referer` de uma imagem que a página venha a carregar. É a
 * mesma escolha do bilhete de personificação, pelo mesmo motivo.
 *
 * Um formulário só para os dois caminhos, porque do lado de quem preenche é a
 * mesma coisa: nome e senha. Quem já tem conta prova quem é com a senha que já
 * usa; quem não tem escolhe a dela e informa um e-mail. Quem decide qual é o
 * caso é o banco, e não uma caixinha que a pessoa marcaria adivinhando se já
 * existe no deploy.
 */
export default function Invite() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { adoptSession } = useAuth()

  const [token] = useState(() => window.location.hash.slice(1))
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Quem já tem conta com login em duas etapas: aceitar o convite emite sessão,
  // então o servidor pede o código como no login.
  const [pedindoCodigo, setPedindoCodigo] = useState(false)
  const [codigo, setCodigo] = useState('')

  useEffect(() => {
    if (!token) { setLoading(false); return }
    let cancelled = false
    void invitesAPI.preview(token).then((res) => {
      if (cancelled) return
      setPreview(res.success && res.data ? res.data : null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [token])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (form.username.trim().length < 3) return setError(t('setup.error.usernameTooShort'))
    if (form.password.length < 8) return setError(t('setup.error.passwordTooShort'))
    // O e-mail é exigido de quem está criando conta aqui. Como esta tela não
    // sabe (nem deve saber) se a pessoa já existe no deploy, ela pede sempre e
    // deixa o backend ignorá-lo quando a conta já existe — perguntar seria
    // dizer a um estranho se um nome tem conta.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setError(t('setup.error.emailInvalid'))

    setSubmitting(true)
    try {
      const res = await invitesAPI.accept(token, {
        username: form.username.trim(),
        email: form.email.trim(),
        password: form.password,
        ...(pedindoCodigo && codigo.trim() ? { totpCode: cleanSecondFactor(codigo) } : {})
      })
      const passo = mfaStepDaResposta(res)
      if (passo) {
        setPedindoCodigo(true)
        setCodigo('')
        setError(passo === 'invalid' ? t('login.mfa.invalid') : t('login.mfa.subtitle'))
        return
      }
      if (res.success && res.data) {
        adoptSession(res.data.token, res.data.refreshToken, res.data.user)
        navigate('/dashboard', { replace: true })
        return
      }
      setError(res.message || t('invite.acceptFailed'))
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
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !preview ? (
            <>
              {/* Vencido, revogado, já usado e inexistente respondem todos a
                  mesma coisa: quem tem um link ruim não tem por que aprender
                  qual dos quatro é. */}
              <p className="page-kicker">{t('invite.kicker')}</p>
              <h1 className="text-2xl font-bold text-foreground">{t('invite.invalidTitle')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('invite.invalidText')}</p>
            </>
          ) : (
            <>
              <div className="mb-7">
                <p className="page-kicker">{t('invite.kicker')}</p>
                <h1 className="text-2xl font-bold text-foreground">
                  {t('invite.title', { provider: preview.tenant.name })}
                </h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t('invite.subtitle', { role: t(ROLE_LABEL_KEYS[preview.role]) })}
                </p>
              </div>

              <form className="space-y-5" onSubmit={submit} noValidate>
                {error && (
                  <div className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div>
                  <label htmlFor="invite-username" className="field-label">{t('login.identifier')}</label>
                  <input
                    id="invite-username" className="modern-input" required autoFocus autoComplete="username"
                    value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="invite-email" className="field-label">{t('setup.email')}</label>
                  <input
                    id="invite-email" type="email" className="modern-input" required autoComplete="email"
                    placeholder={t('setup.emailPlaceholder')}
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="invite-password" className="field-label">{t('login.password')}</label>
                  <input
                    id="invite-password" type="password" className="modern-input" required autoComplete="current-password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />
                  <p className="field-hint">{t('invite.passwordHint')}</p>
                </div>
                {pedindoCodigo && (
                  <div>
                    <label htmlFor="invite-totp" className="field-label">{t('login.mfa.code')}</label>
                    <input
                      id="invite-totp" type="text" className="modern-input font-mono tracking-widest" required
                      autoComplete="one-time-code" autoFocus maxLength={32} placeholder="123 456"
                      value={codigo}
                      onChange={(e) => setCodigo(e.target.value)}
                    />
                    <p className="field-hint">{t('login.mfa.hint')}</p>
                  </div>
                )}

                <button type="submit" disabled={submitting} className="modern-button w-full">
                  {submitting ? t('invite.accepting') : t('invite.accept')}
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
