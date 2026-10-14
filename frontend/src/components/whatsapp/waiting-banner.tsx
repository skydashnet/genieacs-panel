'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WaitingReport } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'

const POLL_MS = 60_000

/**
 * Quem espera gente há mais que o limite da regra "Cliente esperando" —
 * lido a cada minuto com a aba à vista. A página usa o mapa para o selo das
 * linhas e esta faixa para o resumo, com o atalho para as conversas de quem
 * está olhando (as suas e as sem atendente).
 */
export function useWaiting() {
  const [report, setReport] = useState<WaitingReport | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState === 'hidden') return
    inFlight.current = true
    try {
      const res = await whatsappAPI.getWaiting()
      if (res.success && res.data) setReport(res.data)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  return report
}

export function WaitingBanner({ report, onShow }: {
  report: WaitingReport | null
  /** Mostra as conversas: as minhas, ou as sem atendente se nenhuma é minha,
   *  ou todas as abertas quando ninguém espera com você. */
  onShow: (filter: 'me' | 'unassigned' | 'all') => void
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  if (!report || !report.withinHours || report.items.length === 0) return null
  const minhas = report.items.filter((i) => user && i.assignedUserId === user.id).length
  const semDono = report.items.filter((i) => i.assignedUserId === null).length
  const maisAntiga = report.items[0]?.minutes ?? 0

  return (
    <button
      type="button"
      className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-b border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 px-3 py-2 text-start text-xs text-foreground transition-colors hover:bg-[hsl(var(--status-warning))]/20"
      onClick={() => onShow(minhas > 0 ? 'me' : semDono > 0 ? 'unassigned' : 'all')}
    >
      <Icon name="warning" size={14} className="shrink-0 text-[hsl(var(--status-warning))]" />
      <span className="font-semibold">
        {t('whatsapp.waiting.banner', { count: report.items.length, minutes: report.thresholdMinutes })}
      </span>
      <span className="text-muted-foreground">
        {t('whatsapp.waiting.oldest', { minutes: maisAntiga })}
        {minhas + semDono > 0 && ` · ${t('whatsapp.waiting.yours', { count: minhas + semDono })}`}
      </span>
      <span className="ml-auto font-semibold text-primary underline">{t('whatsapp.waiting.show')}</span>
    </button>
  )
}
