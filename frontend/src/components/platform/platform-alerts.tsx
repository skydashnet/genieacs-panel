'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformAPI,
  PLATFORM_ALERT_EVENTS,
  type PlatformAlertChannel,
  type PlatformAlertEvent,
  type PlatformAlertsConfig,
  type PlatformProfile
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { centsToInput } from '@/lib/subscription-console'
import {
  ALERT_EVENT_LABELS,
  PLATFORM_ALERT_CHANNELS,
  buildAlertsPatch,
  eventsWithoutChannel,
  toggleChannel
} from '@/lib/platform-alerts'

const HORAS = Array.from({ length: 24 }, (_, h) => h)
const ROTULO_CANAL = { whatsapp: 'platform.alerts.channel.whatsapp', email: 'platform.alerts.channel.email' } as const

/**
 * Configurações → Alertas (0112): o que avisa quem opera a plataforma, por
 * quais canais, o limite do "atraso alto" e o resumo diário. Os destinos são
 * os de Dados do SaaS (WhatsApp e e-mail de avisos).
 */
export function PlatformAlertsSettings() {
  const { t } = useTranslation()
  const toast = useToast()
  const [perfil, setPerfil] = useState<PlatformProfile | null>(null)
  const [rascunho, setRascunho] = useState<PlatformAlertsConfig | null>(null)
  const [limite, setLimite] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [testando, setTestando] = useState(false)

  const aplicar = useCallback((dados: PlatformProfile) => {
    setPerfil(dados)
    if (dados.alerts) {
      setRascunho(dados.alerts)
      setLimite(centsToInput(dados.alerts.bigOverdueCents))
    }
  }, [])

  useEffect(() => {
    let vivo = true
    platformAPI.getPlatformProfile().then((res) => {
      if (!vivo) return
      if (res.success && res.data?.alerts) aplicar(res.data)
      else setErro(res.message || t('platform.alerts.loadFailed'))
    }).catch(() => { if (vivo) setErro(t('platform.alerts.loadFailed')) })
    return () => { vivo = false }
  }, [aplicar, t])

  const mudarEvento = (evento: PlatformAlertEvent, patch: { enabled?: boolean; channel?: PlatformAlertChannel }) => {
    setRascunho((r) => {
      if (!r) return r
      const atual = r.events[evento]
      return {
        ...r,
        events: {
          ...r.events,
          [evento]: {
            enabled: patch.enabled ?? atual.enabled,
            channels: patch.channel ? toggleChannel(atual.channels, patch.channel) : atual.channels
          }
        }
      }
    })
  }

  const salvar = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!perfil?.alerts || !rascunho) return
    if (eventsWithoutChannel(rascunho).length) {
      toast.error(t('platform.alerts.noChannel'))
      return
    }
    const { patch, invalidThreshold } = buildAlertsPatch(perfil.alerts, rascunho, limite)
    if (invalidThreshold) {
      toast.error(t('platform.alerts.thresholdInvalid'))
      return
    }
    if (!Object.keys(patch).length) {
      toast.success(t('platform.profile.nothingChanged'))
      return
    }
    setSalvando(true)
    try {
      const res = await platformAPI.updatePlatformProfile({ alerts: patch })
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('platform.alerts.saved'))
      } else {
        toast.error(res.message || t('platform.alerts.saveFailed'))
      }
    } catch {
      toast.error(t('platform.alerts.saveFailed'))
    } finally {
      setSalvando(false)
    }
  }

  const testar = async () => {
    setTestando(true)
    try {
      const res = await platformAPI.testPlatformAlert()
      if (res.success) toast.success(t('platform.alerts.testSent'))
      else if (res.code === 'no_destination') toast.error(t('platform.alerts.noDestination'))
      else toast.error(t('platform.alerts.testFailed'))
    } catch {
      toast.error(t('platform.alerts.testFailed'))
    } finally {
      setTestando(false)
    }
  }

  if (erro) return <p className="alert-error text-sm">{erro}</p>
  if (!perfil || !rascunho) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  const semDestino = !perfil.values.notifyWhatsapp && !perfil.values.notifyEmail

  return (
    <form onSubmit={salvar} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('platform.settings.alerts')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.alerts.description')}</p>
      </div>

      {!perfil.canSave && <p className="alert-warning text-sm">{t('platform.profile.noPlatformBox')}</p>}
      {semDestino && <p className="alert-warning text-sm">{t('platform.alerts.noDestination')}</p>}

      <section className="rounded-md border border-border p-4 sm:p-5">
        <h3 className="font-semibold text-foreground">{t('platform.alerts.events')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.alerts.eventsHint')}</p>
        <ul className="mt-4 divide-y divide-border">
          {PLATFORM_ALERT_EVENTS.map((evento) => {
            const regra = rascunho.events[evento]
            return (
              <li key={evento} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={regra.enabled}
                    disabled={!perfil.canSave}
                    onChange={(e) => mudarEvento(evento, { enabled: e.target.checked })}
                  />
                  {t(ALERT_EVENT_LABELS[evento])}
                </label>
                <div className="flex gap-4 pl-6 sm:pl-0" role="group" aria-label={t('platform.alerts.channels')}>
                  {PLATFORM_ALERT_CHANNELS.map((canal) => (
                    <label key={canal} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={regra.channels.includes(canal)}
                        disabled={!perfil.canSave || !regra.enabled}
                        onChange={() => mudarEvento(evento, { channel: canal })}
                      />
                      {t(ROTULO_CANAL[canal])}
                    </label>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="alerts-threshold" className="field-label">{t('platform.alerts.threshold')}</label>
            <input
              id="alerts-threshold"
              inputMode="decimal"
              className="modern-input w-full min-w-0"
              value={limite}
              disabled={!perfil.canSave}
              aria-describedby="alerts-threshold-hint"
              onChange={(e) => setLimite(e.target.value)}
            />
            <p id="alerts-threshold-hint" className="field-hint">{t('platform.alerts.thresholdHint')}</p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={rascunho.dailyDigest.enabled}
                disabled={!perfil.canSave}
                onChange={(e) => setRascunho((r) => (r ? { ...r, dailyDigest: { ...r.dailyDigest, enabled: e.target.checked } } : r))}
              />
              {t('platform.alerts.digest')}
            </label>
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor="alerts-digest-hour" className="text-sm text-muted-foreground">{t('platform.alerts.digestHour')}</label>
              <select
                id="alerts-digest-hour"
                className="modern-input w-24"
                value={rascunho.dailyDigest.hour}
                disabled={!perfil.canSave || !rascunho.dailyDigest.enabled}
                onChange={(e) => setRascunho((r) => (r ? { ...r, dailyDigest: { ...r.dailyDigest, hour: Number(e.target.value) } } : r))}
              >
                {HORAS.map((h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
              </select>
            </div>
            <p className="field-hint">{t('platform.alerts.digestHint')}</p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="modern-button" disabled={salvando || !perfil.canSave}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className="modern-button-secondary" disabled={testando || semDestino} onClick={() => void testar()}>
          {testando ? t('platform.alerts.testing') : t('platform.alerts.test')}
        </button>
      </div>
    </form>
  )
}

export default PlatformAlertsSettings
