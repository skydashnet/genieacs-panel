'use client'

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { authAPI } from '@/lib/api'
import { BrandMark } from '@/components/brand-mark'
import { useTranslation } from '@/contexts/language-context'

/**
 * A confirmação do endereço, aberta a partir da mensagem.
 *
 * Não pede sessão — nem o backend pede. A mensagem costuma ser lida no celular,
 * onde não há sessão do painel, e pôr um formulário de login entre o clique e a
 * confirmação seria ensinar a equipe a digitar a senha depois de clicar num
 * link de e-mail, que é a forma exata de um phishing. O bilhete é a credencial,
 * vale uma vez e só carimba o endereço que ele nomeia.
 *
 * O fragmento é limpo antes da chamada, como no resgate da personificação: já
 * foi gasto nesse ponto, e deixá-lo na barra é deixá-lo no histórico.
 */
export default function VerifyEmail() {
  const { t } = useTranslation()
  const [estado, setEstado] = useState<'confirmando' | 'pronto' | 'erro'>('confirmando')
  const [error, setError] = useState('')
  // React roda o efeito duas vezes em desenvolvimento (StrictMode), e o bilhete
  // serve UMA vez: sem esta trava a segunda passada resgataria um bilhete já
  // consumido e a tela mostraria o erro de uma confirmação que deu certo.
  const tentado = useRef(false)

  useEffect(() => {
    if (tentado.current) return
    tentado.current = true

    const token = window.location.hash.slice(1)
    window.history.replaceState(null, '', window.location.pathname)
    if (!token) { setEstado('erro'); setError(t('verifyEmail.missing')); return }

    void authAPI.confirmEmailVerification(token).then((res) => {
      if (res.success) { setEstado('pronto'); return }
      setEstado('erro')
      setError(res.message || t('verifyEmail.failed'))
    }).catch(() => {
      setEstado('erro')
      setError(t('login.error.unreachable'))
    })
  }, [t])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <BrandMark className={`mx-auto size-11 ${estado === 'confirmando' ? 'animate-pulse' : ''}`} />
        {estado === 'confirmando' && (
          <p className="mt-6 text-sm text-muted-foreground" role="status" aria-live="polite">
            {t('verifyEmail.confirming')}
          </p>
        )}
        {estado === 'pronto' && (
          <>
            <h1 className="mt-6 text-xl font-bold text-foreground">{t('verifyEmail.doneTitle')}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('verifyEmail.doneText')}</p>
          </>
        )}
        {estado === 'erro' && (
          <>
            <h1 className="mt-6 text-xl font-bold text-foreground">{t('verifyEmail.failedTitle')}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground wrap-anywhere">{error}</p>
          </>
        )}
        <p className="mt-5 text-sm">
          <Link to="/login" className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('invite.backToLogin')}</Link>
        </p>
      </div>
    </main>
  )
}
