'use client'

import { useState } from 'react'
import { Link } from 'react-router'
import { authAPI } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'

/**
 * "Esqueci minha senha": o pedido.
 *
 * A tela diz a MESMA coisa sempre, e isso não é preguiça de tratar erro — é o
 * mecanismo. O backend responde igual para conta que existe, conta que não
 * existe, endereço não provado e pessoa de outro provedor, porque qualquer
 * diferença aqui transformaria este campo num oráculo de "quem tem conta neste
 * painel". A tela, então, não tem o que distinguir, e é bom que não tenha:
 * inventar uma mensagem específica seria desfazer no navegador o que o servidor
 * fez de propósito.
 *
 * O que ela promete é exatamente o que o backend promete: SE existir uma conta,
 * a mensagem foi mandada. O condicional está na frase, e é honesto.
 */
export default function ForgotPassword() {
  const { t } = useTranslation()
  const [identifier, setIdentifier] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [enviado, setEnviado] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (!identifier.trim()) return setError(t('forgot.identifierRequired'))

    setSubmitting(true)
    try {
      const res = await authAPI.requestPasswordReset(identifier.trim())
      // Só um 429 do limitador chega aqui como falha — e esse vale mostrar,
      // porque diz à pessoa para esperar em vez de tentar de novo agora.
      if (!res.success) {
        setError(res.message || t('login.error.unreachable'))
        return
      }
      setEnviado(true)
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
          {enviado ? (
            <>
              <h1 className="text-2xl font-bold text-foreground">{t('forgot.sentTitle')}</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('forgot.sentText')}</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-foreground">{t('forgot.title')}</h1>
              <p className="mt-2 mb-7 text-sm leading-6 text-muted-foreground">{t('forgot.subtitle')}</p>

              <form className="space-y-5" onSubmit={submit} noValidate>
                {error && (
                  <div className="alert-error flex gap-2.5" role="alert">
                    <Icon name="warning" size={19} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div>
                  <label htmlFor="forgot-identifier" className="field-label">{t('login.identifier')}</label>
                  <input
                    id="forgot-identifier" className="modern-input" required autoFocus autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                  <p className="field-hint">{t('forgot.identifierHint')}</p>
                </div>

                <button type="submit" disabled={submitting} className="modern-button w-full">
                  {submitting ? t('forgot.sending') : t('forgot.send')}
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
