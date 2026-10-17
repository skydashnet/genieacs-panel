'use client'

import { useState } from 'react'
import { Link } from 'react-router'
import type { LoginDestination, LoginDestinations } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'
import { cleanSecondFactor } from '@/lib/login-mfa'

/**
 * A mesma tela serve as duas portas, e a variante é o que muda entre elas.
 *
 * Tela única e não duas porque o formulário é o mesmo — identificador, senha,
 * erro, idioma — e duplicá-lo faria as duas divergirem na primeira correção que
 * alguém aplicasse só numa. O que a variante `platform` muda é o que o endereço
 * da plataforma não tem: o desvio de "esqueci a senha", cuja rota não é servida
 * ali, e o texto, que fala do console e não do painel de um provedor.
 */
export default function Login({ variant = 'provider' }: { variant?: 'provider' | 'platform' }) {
  const doConsole = variant === 'platform'
  // `identifier` e não `username`: o campo aceita os dois, e chamar o estado
  // de nome de usuário faria a próxima pessoa a ler achar que só o nome passa.
  const [formData, setFormData] = useState({ identifier: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  /**
   * O segundo passo, quando ele existe.
   *
   * Nulo quase sempre: só aparece onde o endereço não nomeia provedor e a
   * pessoa trabalha em mais de um. A senha já foi conferida quando isto deixa
   * de ser nulo — o servidor perguntou DEPOIS do bcrypt, e por isso a lista não
   * diz nada a quem não tem a senha.
   */
  const [destinos, setDestinos] = useState<LoginDestinations | null>(null)
  /**
   * O passo do código do app autenticador, quando a conta tem 2FA.
   *
   * O código fica em memória junto com a senha, como ela: vai de novo em cada
   * ida (a escolha de provedor, se vier), e o servidor só o gasta quando a
   * sessão nasce.
   */
  const [pedindoCodigo, setPedindoCodigo] = useState(false)
  const [codigo, setCodigo] = useState('')
  const { login } = useAuth()
  const { t } = useTranslation()
  const { name, tenant } = useTenant()

  /**
   * Entrar, e — quando o servidor pedir — perguntar onde.
   *
   * Um destino nomeado é reenvio do MESMO login: a senha volta com ele. Guardar
   * um token intermediário para "já conferi a senha" seria uma credencial a
   * mais viva na tela, e a rota já sabe conferir.
   */
  const entrar = async (destino?: LoginDestination) => {
    setLoading(true)
    setError('')
    try {
      const segundoFator = pedindoCodigo ? cleanSecondFactor(codigo) : undefined
      const resultado = await login(formData.identifier, formData.password, destino, segundoFator)
      if (resultado === true) return
      if (resultado === false) {
        setError(t('login.error.invalidCredentials'))
        return
      }
      if (resultado === 'locked') {
        setError(t('login.error.accountLocked'))
        return
      }
      if (resultado === 'required') {
        setPedindoCodigo(true)
        return
      }
      if (resultado === 'invalid') {
        setCodigo('')
        setError(t('login.mfa.invalid'))
        return
      }
      setDestinos(resultado)
    } catch {
      setError(t('login.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await entrar()
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(22rem,0.8fr)_minmax(32rem,1.2fr)]">
      <section className="hidden flex-col justify-between bg-[#18211d] p-10 text-[#f4f3ed] lg:flex xl:p-14" aria-label={t('login.productInformation')}>
        <div className="flex items-center gap-3">
          <BrandMark className="size-11" />
          <div>
            <div className="text-lg font-bold">{name}</div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">{t('app.genieacsOperations')}</div>
          </div>
        </div>
        <div className="max-w-lg">
          <div className="mb-5 h-px w-16 bg-[#d97706]" />
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-0.035em] text-white">
            {t('login.hero.title')}
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-[#b8c4bd]">
            {t('login.hero.description')}
          </p>
        </div>
        <p className="text-xs leading-5 text-[#819087]">
          {t('login.hero.footer')}
        </p>
      </section>

      <main className="flex min-h-screen items-start justify-center px-4 pb-10 pt-16 sm:px-8 lg:items-center lg:py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 lg:hidden">
              <BrandMark className="size-10 shrink-0" title={name} />
              <div className="min-w-0">
                <div className="font-bold wrap-anywhere">{name}</div>
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.13em] text-muted-foreground">{t('app.genieacsOperations')}</div>
              </div>
            </div>
            <LanguageSwitcher collapseOnMobile className="ms-auto shrink-0" />
          </div>

          <div className="auth-panel">
            <div className="mb-7">
              <p className="page-kicker">{t(doConsole ? 'login.platform.kicker' : 'login.kicker')}</p>
              <h1 className="text-2xl font-bold text-foreground">
                {destinos
                  ? t('login.destination.title')
                  : pedindoCodigo ? t('login.mfa.title') : t(doConsole ? 'login.platform.title' : 'login.title')}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {destinos
                  ? t('login.destination.subtitle')
                  : pedindoCodigo ? t('login.mfa.subtitle') : t(doConsole ? 'login.platform.subtitle' : 'login.subtitle')}
              </p>
            </div>

            {destinos ? (
              /* O segundo passo. A senha já foi conferida — o servidor só
                 perguntou depois do bcrypt —, então aqui não há campo, só
                 escolha. */
              <div className="space-y-3">
                {error && (
                  <div id="login-error" className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                {destinos.tenants.map((provedor) => (
                  <button
                    key={provedor.id}
                    type="button"
                    disabled={loading}
                    onClick={() => void entrar({ tenantId: provedor.id })}
                    className="modern-button w-full justify-between"
                  >
                    <span className="min-w-0 text-start wrap-anywhere">{provedor.name}</span>
                    {/* Suspenso continua na lista: quem trabalha lá entra e
                        encontra a tela que explica. Esconder o destino trocaria
                        a explicação por um erro de credencial. */}
                    {provedor.status !== 'active' && (
                      <span className="shrink-0 text-xs opacity-80">{t('login.destination.suspended')}</span>
                    )}
                  </button>
                ))}
                {destinos.console && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void entrar({ console: true })}
                    className="modern-button w-full"
                  >
                    {t('login.destination.console')}
                  </button>
                )}
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => { setDestinos(null); setPedindoCodigo(false); setCodigo(''); setError('') }}
                  className="w-full text-center text-sm underline text-muted-foreground"
                >
                  {t('login.destination.back')}
                </button>
              </div>
            ) : pedindoCodigo ? (
              /* O passo do código. A senha já foi conferida: o servidor só pede
                 o código a quem a acertou. */
              <form className="space-y-5" onSubmit={handleSubmit} noValidate>
                {error && (
                  <div id="login-error" className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                <div>
                  <label htmlFor="totp-code" className="field-label">{t('login.mfa.code')}</label>
                  <input
                    id="totp-code"
                    name="totp-code"
                    type="text"
                    inputMode="text"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    maxLength={32}
                    value={codigo}
                    onChange={(event) => setCodigo(event.target.value)}
                    className="modern-input font-mono tracking-widest"
                    placeholder="123 456"
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'login-error' : 'totp-hint'}
                  />
                  <p id="totp-hint" className="field-hint">{t('login.mfa.hint')}</p>
                </div>
                <button type="submit" disabled={loading || !codigo.trim()} className="modern-button w-full">
                  {loading ? t('login.submitting') : t('login.mfa.submit')}
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => { setPedindoCodigo(false); setCodigo(''); setError('') }}
                  className="w-full text-center text-sm underline text-muted-foreground"
                >
                  {t('login.destination.back')}
                </button>
              </form>
            ) : (
            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              {error && (
                <div id="login-error" className="alert-error flex gap-2.5" role="alert">
                  <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label htmlFor="identifier" className="field-label">{t('login.identifier')}</label>
                {/* `text` e `username`, e deliberadamente não `email`: um
                    `type="email"` faria o navegador recusar o nome de usuário
                    que a maioria ainda digita, e `autoComplete="username"` é o
                    único valor que o gerenciador de senhas preenche com
                    qualquer um dos dois. */}
                <input
                  id="identifier"
                  name="identifier"
                  type="text"
                  autoComplete="username"
                  required
                  autoFocus
                  value={formData.identifier}
                  onChange={(event) => setFormData((value) => ({ ...value, identifier: event.target.value }))}
                  className="modern-input"
                  placeholder={t('login.identifierPlaceholder')}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'login-error' : 'identifier-hint'}
                />
                <p id="identifier-hint" className="field-hint">{t('login.identifierHint')}</p>
              </div>

              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor="password" className="field-label">{t('login.password')}</label>
                  {/* Ao lado do campo, que é onde a pessoa está quando descobre
                      que não lembra. A tela do outro lado responde a mesma
                      coisa para todo mundo — ver `forgot-password.tsx`. */}
                  {/* No endereço da plataforma esta rota não é servida — a
                      redefinição por e-mail grava na trilha de um provedor, e
                      ali não há um. Para uma conta de plataforma o caminho é
                      `scripts/reset-password.js`, que roda sem escopo. */}
                  {!doConsole && (
                    <Link to="/forgot-password" className="-my-3 inline-flex min-h-10 items-center text-xs text-muted-foreground underline hover:text-foreground lg:my-0 lg:min-h-0">
                      {t('login.forgotPassword')}
                    </Link>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={formData.password}
                    onChange={(event) => setFormData((value) => ({ ...value, password: event.target.value }))}
                    className="modern-input pe-12"
                    placeholder={t('login.passwordPlaceholder')}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 inset-e-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                  >
                    <Icon name={showPassword ? 'eye-off' : 'eye'} size={19} />
                  </button>
                </div>
              </div>

              <button type="submit" disabled={loading} className="modern-button w-full">
                {loading ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {t('login.submitting')}
                  </>
                ) : t('login.submit')}
              </button>
            </form>
            )}
          </div>
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            {t(doConsole ? 'login.platform.helpText' : 'login.helpText')}
          </p>
          {/* O operador lê o que guardamos dele ANTES de entrar — é onde o aviso
              tem que estar para quem vai criar e usar uma conta. */}
          <p className="mt-1 text-center text-xs">
            <Link to="/privacidade" className="inline-flex min-h-10 items-center text-muted-foreground underline hover:text-foreground lg:min-h-0">
              {t('login.privacyLink')}
            </Link>
          </p>
          {/* Sign-up lives at the platform's front door, not at this provider's
              address: a new ISP is nobody's customer yet. */}
          {doConsole ? (
            // Aqui o cadastro é uma rota desta mesma casca: o ápice é a porta
            // de entrada das duas pessoas sem conta — o ISP que ainda não
            // existe e quem opera a plataforma.
            <p className="mt-3 text-center text-sm">
              <Link to="/signup" className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('login.signupLink')}</Link>
            </p>
          ) : tenant?.edition === 'saas' && tenant.panelBaseDomain && (
            <p className="mt-3 text-center text-sm">
              <a href={`https://${tenant.panelBaseDomain}/signup`} className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('login.signupLink')}</a>
            </p>
          )}
        </div>
      </main>
    </div>
  )
}
