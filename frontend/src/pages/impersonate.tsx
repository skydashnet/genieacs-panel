'use client'

import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { authAPI } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { BrandMark } from '@/components/brand-mark'
import { useTranslation } from '@/contexts/language-context'

/**
 * A troca do bilhete pelo token, no host do provedor.
 *
 * É a metade da personificação que vive no navegador. O console cunhou um
 * bilhete e mandou o navegador para cá com ele no FRAGMENTO — a parte do
 * endereço que nunca chega a servidor nenhum. Aqui ele é trocado pela sessão
 * numa chamada ao host onde a página está, e o token nasce no origin onde vai
 * viver: nada atravessou uma URL que algum log pudesse guardar.
 *
 * O fragmento é limpo assim que é lido, antes mesmo da chamada. Ele já foi
 * usado nesse ponto, e deixá-lo na barra de endereços é deixá-lo no histórico
 * e numa captura de tela de quem estiver atendendo.
 */
export default function Impersonate() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { adoptSession } = useAuth()
  const [error, setError] = useState('')
  // React roda o efeito duas vezes em desenvolvimento (StrictMode), e o bilhete
  // serve UMA vez: sem esta trava a segunda passada resgataria um bilhete já
  // consumido e a tela mostraria o erro de um resgate que deu certo.
  const tentado = useRef(false)

  useEffect(() => {
    if (tentado.current) return
    tentado.current = true

    const ticket = window.location.hash.slice(1)
    window.history.replaceState(null, '', window.location.pathname)
    if (!ticket) { setError(t('impersonate.missing')); return }

    void authAPI.redeemImpersonation(ticket).then((res) => {
      if (res.success && res.data) {
        // Sem refresh token: a sessão dura meia hora e não se renova sozinha.
        // `tabOnly`: a sessão fica só nesta aba. O console abriu o painel
        // numa aba nova e continua atrás — numa instalação de host único as
        // duas dividem o `localStorage`, e sem isto esta aba trocaria a sessão
        // do console pela do provedor.
        adoptSession(res.data.token, undefined, res.data.user, { tabOnly: true })
        navigate('/dashboard', { replace: true })
        return
      }
      setError(res.message || t('impersonate.failed'))
    }).catch(() => setError(t('login.error.unreachable')))
  }, [adoptSession, navigate, t])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <BrandMark className={`mx-auto size-11 ${error ? '' : 'animate-pulse'}`} />
        {error ? (
          <>
            <h1 className="mt-6 text-xl font-bold text-foreground">{t('impersonate.failedTitle')}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground wrap-anywhere">{error}</p>
            <p className="mt-5 text-sm">
              <Link to="/login" className="inline-flex min-h-10 items-center underline lg:min-h-0">{t('invite.backToLogin')}</Link>
            </p>
          </>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground" role="status" aria-live="polite">
            {t('impersonate.starting')}
          </p>
        )}
      </div>
    </main>
  )
}
