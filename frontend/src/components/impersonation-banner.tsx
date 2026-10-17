'use client'

import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'

/**
 * A faixa que diz, o tempo todo, que este painel não é seu.
 *
 * Uma sessão de personificação é indistinguível de uma comum na tela — é
 * exatamente o que ela existe para ser, porque o atendimento precisa ver o que
 * o cliente vê. Isso é útil e é perigoso pelo mesmo motivo: sem um aviso
 * permanente, alguém do plantão troca de aba, volta meia hora depois e acha que
 * está no painel da plataforma.
 *
 * Fica na casca e não numa tela porque vale em todas, e é vermelha e fixa
 * porque um aviso que se pode rolar para fora da vista é um aviso que some
 * justamente quando alguém está concentrado noutra coisa.
 *
 * Sair é jogar o token fora: `logout` limpa o que está guardado e volta ao
 * login. A chamada de logout que ele dispara é recusada pelo backend com 403 —
 * de propósito, porque ela revogaria as sessões de quem personifica, não as do
 * cliente —, e não é preciso fazer nada com isso: o que encerra a
 * personificação é o token deixar de existir neste navegador.
 */
export function ImpersonationBanner() {
  const { user, logout } = useAuth()
  const { name } = useTenant()
  const { t } = useTranslation()

  if (!user?.impersonation) return null

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/40 bg-background bg-linear-to-r from-destructive/10 to-destructive/10 px-4 py-2 text-xs text-destructive wrap-anywhere sm:text-sm"
    >
      <Icon name="warning" size={17} className="shrink-0" />
      <span className="font-semibold">{t('impersonate.bannerTitle')}</span>
      <span className="text-destructive/90">
        {t('impersonate.bannerText', {
          // O nome da SESSÃO na frente do nome do endereço: numa instalação de
          // host único o endereço nomeia o primeiro provedor, e esta faixa
          // diria o nome de um painel que não é o que está na tela. O `name`
          // continua como reserva, para uma sessão aberta antes desta mudança.
          provider: user.impersonation.tenantName || name,
          operator: user.impersonation.platformUsername
        })}
      </span>
      <button type="button" onClick={logout} className="ml-auto inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center font-semibold underline lg:min-h-0 lg:min-w-0">
        {t('impersonate.leave')}
      </button>
    </div>
  )
}

export default ImpersonationBanner
