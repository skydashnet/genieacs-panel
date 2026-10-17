'use client'

import { useCallback, useEffect, useState } from 'react'
import { sgpAPI, type SgpConfig, type SgpEvent } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

interface Props {
  config: SgpConfig | null
  onConfigChange: (config: SgpConfig) => void
}

export function SgpEventsPanel({ config, onConfigChange }: Props) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [events, setEvents] = useState<SgpEvent[]>([])
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  const loadEvents = useCallback(async () => {
    const res = await sgpAPI.listEvents({ limit: 20 })
    if (res.success && res.data) setEvents(res.data.events)
  }, [])

  useEffect(() => {
    void loadEvents().catch(() => undefined)
  }, [loadEvents])

  const patchConfig = async (patch: Partial<SgpConfig>) => {
    const res = await sgpAPI.updateConfig(patch)
    if (res.success && res.data) {
      onConfigChange(res.data)
      toast.success(res.message || t('settings.sgp.events.saved'))
      return
    }
    toast.error(res.message || t('settings.sgp.events.saveFailed'))
  }

  const rotateSecret = async () => {
    if (!window.confirm(t('settings.sgp.events.secretRotateConfirm'))) return
    const res = await sgpAPI.rotateWebhookSecret()
    if (res.success && res.data) {
      setRevealedSecret(res.data.secret)
      toast.success(res.message || t('settings.sgp.events.secretRotated'))
      const refreshed = await sgpAPI.getConfig()
      if (refreshed.success && refreshed.data) onConfigChange(refreshed.data)
      return
    }
    toast.error(res.message || t('settings.sgp.events.secretRotateFailed'))
  }

  const reconcileNow = async () => {
    const res = await sgpAPI.reconcile()
    if (res.success && res.data) {
      toast.success(t('settings.sgp.events.reconcileSummary', {
        checked: res.data.checked,
        changed: res.data.changed,
      }))
      await loadEvents()
      return
    }
    toast.error(res.message || t('settings.sgp.events.reconcileFailed'))
  }

  const retry = async (event: SgpEvent) => {
    const res = await sgpAPI.retryEvent(event.id)
    if (res.success) {
      toast.success(res.message || t('settings.sgp.events.retried'))
      await loadEvents()
      return
    }
    toast.error(res.message || t('settings.sgp.events.retryFailed'))
  }

  // The panel shows the full URL because the path alone is not what an
  // operator has to paste into SGP.
  const webhookUrl = config?.webhookPath
    ? `${window.location.origin}${config.webhookPath}`
    : ''

  return (
    <div className="mt-8 border-t border-border pt-6">
      <h3 className="section-heading text-base">{t('settings.sgp.events.title')}</h3>
      <p className="section-description mb-4">{t('settings.sgp.events.description')}</p>

      <div className="space-y-4">
        <div>
          <label htmlFor="sgp-webhook-url" className="field-label">
            {t('settings.sgp.events.webhookUrl')}
          </label>
          <div className="flex gap-2">
            <input
              id="sgp-webhook-url"
              type="text"
              readOnly
              className="modern-input w-full font-mono text-xs"
              value={webhookUrl}
            />
            <button
              type="button"
              className="modern-button-secondary shrink-0"
              onClick={() => {
                void navigator.clipboard?.writeText(webhookUrl)
                toast.success(t('common.copied'))
              }}
            >
              {t('common.copy')}
            </button>
          </div>
          <p className="field-hint">{t('settings.sgp.events.webhookUrlHint')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className={config?.webhookSecretConfigured ? 'modern-badge-success' : 'modern-badge'}>
            {t(config?.webhookSecretConfigured
              ? 'settings.sgp.events.secretConfigured'
              : 'settings.sgp.events.secretMissing')}
          </span>
          <button type="button" className="modern-button-secondary" onClick={() => void rotateSecret()}>
            {t('settings.sgp.events.secretRotate')}
          </button>
        </div>

        {revealedSecret && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="field-label">{t('settings.sgp.events.secretRevealWarning')}</p>
            <code className="mt-1 block break-all font-mono text-xs">{revealedSecret}</code>
          </div>
        )}

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config?.webhookEnabled ?? false}
            onChange={(event) => void patchConfig({ webhookEnabled: event.target.checked })}
          />
          <span>
            <span className="field-label">{t('settings.sgp.events.webhookEnable')}</span>
            <span className="field-hint block">{t('settings.sgp.events.webhookEnableHint')}</span>
          </span>
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config?.webhookRequireTimestamp ?? false}
            onChange={(event) => void patchConfig({ webhookRequireTimestamp: event.target.checked })}
          />
          <span>
            <span className="field-label">{t('settings.sgp.events.requireTimestamp')}</span>
            <span className="field-hint block">{t('settings.sgp.events.requireTimestampHint')}</span>
          </span>
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config?.reconcileEnabled ?? false}
            onChange={(event) => void patchConfig({ reconcileEnabled: event.target.checked })}
          />
          <span>
            <span className="field-label">{t('settings.sgp.events.reconcileEnable')}</span>
            <span className="field-hint block">{t('settings.sgp.events.reconcileEnableHint')}</span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="sgp-reconcile-interval" className="field-label">
              {t('settings.sgp.events.reconcileInterval')}
            </label>
            <input
              id="sgp-reconcile-interval"
              type="number"
              min={5}
              max={1440}
              className="modern-input w-full"
              defaultValue={config?.reconcileIntervalMinutes ?? 15}
              onBlur={(event) => void patchConfig({ reconcileIntervalMinutes: Number(event.target.value) })}
            />
          </div>
          <div>
            <label htmlFor="sgp-reconcile-batch" className="field-label">
              {t('settings.sgp.events.reconcileBatch')}
            </label>
            <input
              id="sgp-reconcile-batch"
              type="number"
              min={1}
              max={200}
              className="modern-input w-full"
              defaultValue={config?.reconcileBatchSize ?? 25}
              onBlur={(event) => void patchConfig({ reconcileBatchSize: Number(event.target.value) })}
            />
            <p className="field-hint">{t('settings.sgp.events.reconcileBatchHint')}</p>
          </div>
        </div>

        <div>
          <button type="button" className="modern-button-secondary" onClick={() => void reconcileNow()}>
            {t('settings.sgp.events.reconcileNow')}
          </button>
          <p className="field-hint">{t('settings.sgp.events.reconcileNowHint')}</p>
        </div>
      </div>

      <h4 className="section-heading mt-8 text-sm">{t('settings.sgp.events.eventsTitle')}</h4>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.sgp.events.eventsEmpty')}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {event.type}
                    {event.rawType && event.rawType !== event.type && (
                      <span className="ms-2 text-xs text-muted-foreground">({event.rawType})</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {event.source} · {event.contract ?? '—'} ·{' '}
                    {event.receivedAt ? formatDateTime(event.receivedAt) : '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="modern-badge">{event.status}</span>
                  {event.status === 'failed' && (
                    <button type="button" className="modern-button-secondary" onClick={() => void retry(event)}>
                      {t('settings.sgp.events.eventRetry')}
                    </button>
                  )}
                  {event.payload && (
                    <button
                      type="button"
                      className="modern-button-secondary"
                      onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                    >
                      {t('settings.sgp.events.eventPayload')}
                    </button>
                  )}
                </div>
              </div>
              {event.type === 'unknown' && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('settings.sgp.events.eventUnknownHint')}
                </p>
              )}
              {expanded === event.id && event.payload && (
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{event.payload}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SgpEventsPanel
