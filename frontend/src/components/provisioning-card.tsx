'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  provisioningAPI,
  type ProvisioningPreview,
  type ProvisioningRun,
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

interface Props {
  deviceId: string
}

/**
 * Activation panel for one ONT: the outcome of the last run, a dry run an
 * operator can read before committing, and the run itself.
 */
export function ProvisioningCard({ deviceId }: Props) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [runs, setRuns] = useState<ProvisioningRun[]>([])
  const [preview, setPreview] = useState<ProvisioningPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'provision' | null>(null)

  const loadRuns = useCallback(async () => {
    if (!deviceId) return
    const res = await provisioningAPI.listDeviceRuns(deviceId)
    if (res.success && res.data) setRuns(res.data.runs)
  }, [deviceId])

  useEffect(() => {
    void loadRuns().catch(() => undefined)
  }, [loadRuns])

  const runPreview = async () => {
    setBusy('preview')
    try {
      const res = await provisioningAPI.preview(deviceId)
      if (res.success && res.data) {
        setPreview(res.data)
        return
      }
      toast.error(res.message || t('detail.provisioning.previewFailed'))
    } finally {
      setBusy(null)
    }
  }

  const provision = async () => {
    if (!window.confirm(t('detail.provisioning.provisionConfirm'))) return
    setBusy('provision')
    try {
      const res = await provisioningAPI.provision(deviceId)
      if (res.success && res.data) {
        toast.success(res.message || t('detail.provisioning.provisionQueued'))
        setPreview(null)
        await loadRuns()
        return
      }
      toast.error(res.message || t('detail.provisioning.provisionFailed'))
    } finally {
      setBusy(null)
    }
  }

  const latest = runs[0] ?? null

  return (
    <div className="modern-card p-5 sm:p-6 lg:col-span-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="page-kicker">{t('detail.provisioning.kicker')}</p>
          <h2 className="section-heading">{t('detail.provisioning.title')}</h2>
          <p className="section-description">{t('detail.provisioning.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="modern-button-secondary"
            disabled={busy !== null}
            onClick={() => void runPreview()}
          >
            <Icon name="refresh" size={16} className="me-2" />
            {busy === 'preview' ? t('detail.provisioning.previewing') : t('detail.provisioning.preview')}
          </button>
          <button
            type="button"
            className="modern-button"
            disabled={busy !== null}
            onClick={() => void provision()}
          >
            {busy === 'provision'
              ? t('detail.provisioning.provisioning')
              : t('detail.provisioning.provision')}
          </button>
        </div>
      </div>

      <div className="mt-4">
        {latest ? (
          <div className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="modern-badge">{latest.status}</span>
              <span className="text-xs text-muted-foreground">
                {latest.profileName
                  ? t('detail.provisioning.profileLine', {
                    profile: latest.profileName,
                    contract: latest.contract ?? '—',
                  })
                  : t('detail.provisioning.noProfile')}
              </span>
              <span className="text-xs text-muted-foreground">
                {latest.updatedAt ? formatDateTime(latest.updatedAt) : ''}
              </span>
            </div>
            {(latest.errorMessage ?? latest.error) && (
              <p className="mt-2 text-sm text-muted-foreground wrap-anywhere">
                {latest.errorMessage ?? latest.error}
              </p>
            )}
            {latest.steps.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">
                {latest.steps.map((step, index) => (
                  <li key={`${step.step}-${index}`} className="flex flex-wrap gap-2 wrap-anywhere">
                    <span className="font-medium">{step.step}</span>
                    <span className="text-muted-foreground">{step.status}</span>
                    {step.detail && <span className="min-w-0 text-muted-foreground">· {step.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('detail.provisioning.never')}</p>
        )}
      </div>

      {preview && (
        <div className="mt-4 rounded-md border border-border p-3">
          <h3 className="field-label">{t('detail.provisioning.previewTitle')}</h3>
          {preview.skip ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t('detail.provisioning.previewSkipped', { reason: preview.skip })}
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
                {t('detail.provisioning.previewSummary', {
                  profile: preview.profile?.name ?? '—',
                  contract: preview.contract?.contract ?? '—',
                })}
              </p>
              {preview.pppoePasswordFound === false && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t('detail.provisioning.noPppoePassword')}
                </p>
              )}
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {preview.steps.flatMap((step) => step.parameters.map((parameter, index) => (
                      <tr key={`${step.step}-${parameter.path}-${index}`} className="border-t border-border">
                        <td className="py-1 pe-3 text-muted-foreground">{step.step}</td>
                        <td className="break-all py-1 pe-3 font-mono">{parameter.path}</td>
                        <td className="break-all py-1 font-mono">{String(parameter.value ?? '')}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default ProvisioningCard
