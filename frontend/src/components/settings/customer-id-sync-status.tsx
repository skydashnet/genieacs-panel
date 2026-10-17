import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { settingsAPI, type CustomerIdSyncStatus } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'

/**
 * Como está a sincronização de IDs de cliente, na aba "Portal do cliente".
 *
 * Numa rede grande a passada continua em segundo plano depois que o salvar
 * responde; sem este quadro o operador não tinha como saber se terminou,
 * quantos IDs gerou ou por que falhou. Enquanto há passada em curso, relê a
 * cada poucos segundos.
 */
export function CustomerIdSyncStatusPanel({ canWrite, refreshKey = 0 }: { canWrite: boolean; refreshKey?: number }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<CustomerIdSyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await settingsAPI.customerIdSyncStatus()
      if (response.success && response.data) setStatus(response.data)
    } catch {
      // Quadro informativo: sem resposta, fica o que já estava.
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  useEffect(() => {
    if (!status?.running) return
    const timer = window.setInterval(() => void load(), 4_000)
    return () => window.clearInterval(timer)
  }, [load, status?.running])

  const syncNow = async () => {
    setSyncing(true)
    try {
      const response = await settingsAPI.syncCustomerIds()
      if (response.success) toast.success(response.message || t('settings.syncSuccess'))
      else toast.error(response.message || t('settings.syncError'))
    } catch {
      toast.error(t('settings.syncError'))
    } finally {
      setSyncing(false)
      void load()
    }
  }

  if (!status) return null
  const last = status.last
  const when = (value?: string | null) => (value ? formatDateTime(value, { dateStyle: 'short', timeStyle: 'short' }) : '—')

  return (
    <div className="mt-5 rounded-md border border-border p-4" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="metric-label">{t('settings.portal.syncStatus.title')}</p>
          {status.running ? (
            <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
              <Icon name="refresh" size={16} className="animate-spin" />
              {t('settings.portal.syncStatus.running', { time: when(status.startedAt) })}
            </p>
          ) : !last ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('settings.portal.syncStatus.never')}</p>
          ) : last.ok ? (
            <>
              <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
                <Icon name="check" size={16} className="text-emerald-500" />
                {t('settings.portal.syncStatus.ok', { time: when(last.finishedAt) })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.portal.syncStatus.counts', {
                  total: last.total ?? 0, generated: last.generated ?? 0, existing: last.existing ?? 0, pending: last.pending ?? 0
                })}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-destructive">
                <Icon name="warning" size={16} />
                {t('settings.portal.syncStatus.failed', { time: when(last.finishedAt) })}
              </p>
              {last.message && <p className="mt-1 text-xs text-muted-foreground">{last.message}</p>}
            </>
          )}
          {!status.enabled && <p className="mt-1 text-xs text-muted-foreground">{t('settings.portal.syncStatus.disabled')}</p>}
        </div>
        {canWrite && status.enabled && (
          <button type="button" className="modern-button-secondary shrink-0" disabled={syncing || status.running} onClick={() => void syncNow()}>
            <Icon name="refresh" size={16} className={syncing ? 'animate-spin' : ''} />
            {t('settings.portal.syncStatus.syncNow')}
          </button>
        )}
      </div>
    </div>
  )
}
