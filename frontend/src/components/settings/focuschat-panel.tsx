'use client'

import { useCallback, useEffect, useState } from 'react'
import { focusChatAPI, type FocusChatConfig } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * Focus Chat: the channel's API token, so Contacts can import the helpdesk's
 * contact book. The token never comes back from the server; a blank field
 * keeps the one saved.
 */
export function FocusChatPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [config, setConfig] = useState<FocusChatConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const applyConfig = useCallback((next: FocusChatConfig) => {
    setConfig(next)
    setEnabled(next.enabled)
    setToken('')
  }, [])

  useEffect(() => {
    void focusChatAPI.getConfig().then((res) => { if (res.success && res.data) applyConfig(res.data) })
  }, [applyConfig])

  const save = async (clearToken = false) => {
    setSaving(true)
    try {
      const res = await focusChatAPI.updateConfig({
        enabled: clearToken ? false : enabled,
        ...(clearToken ? { token: '' } : token.trim() ? { token: token.trim() } : {})
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.focuschat.saveFailed'))
        return
      }
      applyConfig(res.data)
      toast.success(t('settings.focuschat.saved'))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await focusChatAPI.test({ token: token.trim() || undefined })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.focuschat.testFailed'))
        return
      }
      toast.success(res.message || t('settings.focuschat.testOk'))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6" data-testid="focuschat-panel">
      <p className="page-kicker">{t('settings.focuschat.kicker')}</p>
      <h2 className="section-heading">{t('settings.focuschat.title')}</h2>
      <p className="section-description mb-6">{t('settings.focuschat.description')}</p>

      <div className="grid gap-4">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span className="text-sm">
            <span className="block font-semibold">{t('settings.focuschat.enabled')}</span>
            <span className="text-muted-foreground">{t('settings.focuschat.enabledHint')}</span>
          </span>
        </label>
        <div>
          <label className="field-label" htmlFor="focuschat-token">{t('settings.focuschat.token')}</label>
          <input
            id="focuschat-token"
            type="password"
            autoComplete="off"
            className="modern-input font-mono"
            value={token}
            placeholder={config?.tokenConfigured ? t('settings.focuschat.tokenConfigured') : t('settings.focuschat.tokenPlaceholder')}
            onChange={(event) => setToken(event.target.value)}
          />
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.focuschat.tokenHint')}</p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" className="modern-button" disabled={saving} onClick={() => void save()}>
          <Icon name="check" size={16} /> {saving ? t('settings.focuschat.saving') : t('settings.focuschat.save')}
        </button>
        <button
          type="button"
          className="modern-button-secondary"
          disabled={testing || (!token.trim() && !config?.tokenConfigured)}
          onClick={() => void runTest()}
        >
          <Icon name="refresh" size={16} /> {testing ? t('settings.focuschat.testing') : t('settings.focuschat.test')}
        </button>
        {config?.tokenConfigured && (
          <button type="button" className="modern-button-secondary" disabled={saving} onClick={() => void save(true)}>
            <Icon name="trash" size={16} /> {t('settings.focuschat.clearToken')}
          </button>
        )}
      </div>
    </div>
  )
}

export default FocusChatPanel
