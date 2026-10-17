'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { whatsappAPI } from '@/lib/api'
import { downAccounts, downSignature, type DownAccount } from '@/lib/wa-down-accounts'
import { WA_DOWN_DISMISSED_KEY } from '@/lib/session-owner'

/** Um minuto, como o sino de saúde: a lista de números é uma consulta só. */
const POLL_MS = 60_000
const DISMISS_KEY = WA_DOWN_DISMISSED_KEY

function readDismissed(): string {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * A faixa vermelha de "número de WhatsApp caído", em todas as telas.
 *
 * Fica na casca porque quem descobre a queda pela caixa de entrada descobre
 * tarde: o atendente só vê o erro quando tenta responder. Fechar esconde a
 * faixa nesta aba até OUTRO número cair — a queda que a pessoa já viu não
 * precisa gritar de novo a cada tela, mas uma nova precisa.
 */
export function WhatsAppDisconnectedBanner() {
  const { can } = useAuth()
  const { t } = useTranslation()
  const [down, setDown] = useState<DownAccount[]>([])
  const [dismissed, setDismissed] = useState(readDismissed)
  const inFlight = useRef(false)
  const allowed = can('whatsapp.read')

  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState === 'hidden') return
    inFlight.current = true
    try {
      const res = await whatsappAPI.listAccounts()
      // Uma leitura que falhou não diz que está tudo bem nem que caiu: fica o
      // que se sabia.
      if (res.success && Array.isArray(res.data)) setDown(downAccounts(res.data))
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [allowed, load])

  const signature = downSignature(down)
  if (!allowed || down.length === 0 || dismissed === signature) return null

  const dismiss = () => {
    setDismissed(signature)
    try {
      window.sessionStorage.setItem(DISMISS_KEY, signature)
    } catch {
      // Sem armazenamento, a faixa só volta na próxima tela; nada a fazer.
    }
  }

  // Quem pode abrir as Configurações vai direto ao número; quem não pode, à
  // tela do WhatsApp, que diz a quem pedir.
  const to = can('settings.read') ? '/settings?tab=whatsapp#wa-accounts' : '/whatsapp'

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/40 bg-background bg-linear-to-r from-destructive/15 to-destructive/10 px-4 py-2 text-xs text-destructive wrap-anywhere sm:text-sm"
    >
      <Icon name="warning" size={17} className="shrink-0" />
      <span className="font-semibold">
        {down.length === 1
          ? t('whatsapp.down.bannerOne', { name: down[0].name })
          : t('whatsapp.down.bannerMany', { count: down.length, names: down.map((account) => account.name).join(', ') })}
      </span>
      <span className="text-destructive/90">{t('whatsapp.down.bannerText')}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <Link to={to} className="inline-flex min-h-8 items-center font-semibold underline lg:min-h-0">
          {t('whatsapp.down.reconnect')}
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-destructive/10 lg:h-6 lg:w-6"
          aria-label={t('whatsapp.down.dismiss')}
          title={t('whatsapp.down.dismiss')}
        >
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  )
}

export default WhatsAppDisconnectedBanner
