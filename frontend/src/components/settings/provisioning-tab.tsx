'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  provisioningAPI,
  type ProvisioningConfig,
  type ProvisioningProfile,
  type ProvisioningProfileInput,
  type ProvisioningRun,
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

const EMPTY_PROFILE: ProvisioningProfileInput = {
  name: '',
  planPatterns: [],
  isDefault: false,
  priority: 10,
  enabled: true,
  applyWan: true,
  applyPppoePassword: true,
  wanName: null,
  wanVlanId: null,
  wanServiceList: null,
  applyWifi: true,
  wifiIndexes: [1, 5],
  wifiSsidTemplate: '',
  wifiPasswordMode: 'random',
  applyCredentials: false,
  credentialTargets: 'super',
}

/** Comma or newline separated input, stored as a list. */
function toList(value: string): string[] {
  return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
}

function toIndexes(value: string): number[] {
  return toList(value).map(Number).filter((index) => Number.isInteger(index) && index >= 1 && index <= 8)
}

export function ProvisioningTab() {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [config, setConfig] = useState<ProvisioningConfig | null>(null)
  const [profiles, setProfiles] = useState<ProvisioningProfile[]>([])
  const [runs, setRuns] = useState<ProvisioningRun[]>([])
  const [draft, setDraft] = useState<ProvisioningProfileInput>(EMPTY_PROFILE)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [configRes, profileRes, runRes] = await Promise.all([
      provisioningAPI.getConfig(),
      provisioningAPI.listProfiles(),
      provisioningAPI.listRuns({ limit: 15 }),
    ])
    if (configRes.success && configRes.data) setConfig(configRes.data)
    if (profileRes.success && profileRes.data) setProfiles(profileRes.data.profiles)
    if (runRes.success && runRes.data) setRuns(runRes.data.runs)
  }, [])

  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  const saveConfig = async (patch: Partial<ProvisioningConfig>) => {
    const res = await provisioningAPI.updateConfig(patch)
    if (res.success && res.data) {
      setConfig(res.data)
      toast.success(res.message || t('settings.provisioning.saved'))
      return
    }
    toast.error(res.message || t('settings.provisioning.saveFailed'))
    // The server refused, so the switch must not keep the value it rejected.
    void load().catch(() => undefined)
  }

  const startEdit = (profile: ProvisioningProfile) => {
    setEditingId(profile.id)
    setDraft({
      name: profile.name,
      planPatterns: profile.planPatterns,
      isDefault: profile.isDefault,
      priority: profile.priority,
      enabled: profile.enabled,
      applyWan: profile.applyWan,
      applyPppoePassword: profile.applyPppoePassword,
      wanName: profile.wanName,
      wanVlanId: profile.wanVlanId,
      wanServiceList: profile.wanServiceList,
      applyWifi: profile.applyWifi,
      wifiIndexes: profile.wifiIndexes,
      wifiSsidTemplate: profile.wifiSsidTemplate ?? '',
      wifiPasswordMode: profile.wifiPasswordMode,
      applyCredentials: profile.applyCredentials,
      credentialTargets: profile.credentialTargets,
    })
  }

  const submitProfile = async () => {
    setSaving(true)
    try {
      const res = editingId
        ? await provisioningAPI.updateProfile(editingId, draft)
        : await provisioningAPI.createProfile(draft)
      if (!res.success) {
        toast.error(res.message || t('settings.provisioning.profileSaveFailed'))
        return
      }
      toast.success(res.message || t('settings.provisioning.profileSaved'))
      setDraft(EMPTY_PROFILE)
      setEditingId(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const removeProfile = async (profile: ProvisioningProfile) => {
    if (!window.confirm(t('settings.provisioning.profileDeleteConfirm', { name: profile.name }))) return
    const res = await provisioningAPI.deleteProfile(profile.id)
    if (res.success) {
      toast.success(res.message || t('settings.provisioning.profileDeleted'))
      await load()
      return
    }
    toast.error(res.message || t('settings.provisioning.profileSaveFailed'))
  }

  const runNow = async () => {
    const res = await provisioningAPI.runPass()
    if (res.success && res.data) {
      toast.success(t('settings.provisioning.passSummary', {
        executed: res.data.executed,
        verified: res.data.verified,
        queued: res.data.queued,
      }))
      await load()
      return
    }
    toast.error(res.message || t('settings.provisioning.passFailed'))
  }

  return (
    <div className="modern-card max-w-4xl p-5 sm:p-6">
      <p className="page-kicker">{t('settings.provisioning.kicker')}</p>
      <h2 className="section-heading">{t('settings.provisioning.title')}</h2>
      <p className="section-description mb-6">{t('settings.provisioning.description')}</p>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className={config?.enabled ? 'modern-badge-success' : 'modern-badge'}>
          {t(config?.enabled ? 'settings.provisioning.statusActive' : 'settings.provisioning.statusInactive')}
        </span>
        <span className="text-xs text-muted-foreground">
          {config?.updatedAt
            ? t('settings.provisioning.updatedAt', { time: formatDateTime(config.updatedAt) })
            : t('settings.provisioning.neverConfigured')}
        </span>
      </div>

      <div className="space-y-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config?.enabled ?? false}
            onChange={(event) => void saveConfig({ enabled: event.target.checked })}
          />
          <span>
            <span className="field-label">{t('settings.provisioning.enable')}</span>
            <span className="field-hint block">{t('settings.provisioning.enableHint')}</span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="prov-interval" className="field-label">
              {t('settings.provisioning.interval')}
            </label>
            <input
              id="prov-interval"
              type="number"
              min={60}
              max={86400}
              className="modern-input w-full"
              value={config?.intervalSeconds ?? 300}
              onChange={(event) => setConfig((current) => (current
                ? { ...current, intervalSeconds: Number(event.target.value) }
                : current))}
              onBlur={(event) => void saveConfig({ intervalSeconds: Number(event.target.value) })}
            />
            <p className="field-hint">{t('settings.provisioning.intervalHint')}</p>
          </div>
          <div>
            <label htmlFor="prov-batch" className="field-label">
              {t('settings.provisioning.batchSize')}
            </label>
            <input
              id="prov-batch"
              type="number"
              min={1}
              max={50}
              className="modern-input w-full"
              value={config?.batchSize ?? 5}
              onChange={(event) => setConfig((current) => (current
                ? { ...current, batchSize: Number(event.target.value) }
                : current))}
              onBlur={(event) => void saveConfig({ batchSize: Number(event.target.value) })}
            />
            <p className="field-hint">{t('settings.provisioning.batchSizeHint')}</p>
          </div>
          <div>
            <label htmlFor="prov-window" className="field-label">
              {t('settings.provisioning.informWindow')}
            </label>
            <input
              id="prov-window"
              type="number"
              min={1}
              max={720}
              className="modern-input w-full"
              value={config?.informWindowHours ?? 24}
              onChange={(event) => setConfig((current) => (current
                ? { ...current, informWindowHours: Number(event.target.value) }
                : current))}
              onBlur={(event) => void saveConfig({ informWindowHours: Number(event.target.value) })}
            />
            <p className="field-hint">{t('settings.provisioning.informWindowHint')}</p>
          </div>
          <div>
            <label htmlFor="prov-tag" className="field-label">
              {t('settings.provisioning.markerTag')}
            </label>
            <input
              id="prov-tag"
              type="text"
              className="modern-input w-full"
              value={config?.markerTag ?? 'SkyGenProvisioned'}
              onChange={(event) => setConfig((current) => (current
                ? { ...current, markerTag: event.target.value }
                : current))}
              onBlur={(event) => void saveConfig({ markerTag: event.target.value })}
            />
            <p className="field-hint">{t('settings.provisioning.markerTagHint')}</p>
          </div>
        </div>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config?.verifyEnabled ?? true}
            onChange={(event) => void saveConfig({ verifyEnabled: event.target.checked })}
          />
          <span>
            <span className="field-label">{t('settings.provisioning.verify')}</span>
            <span className="field-hint block">{t('settings.provisioning.verifyHint')}</span>
          </span>
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config?.requirePppoePassword ?? false}
            onChange={(event) => void saveConfig({ requirePppoePassword: event.target.checked })}
          />
          <span>
            <span className="field-label">{t('settings.provisioning.requirePppoePassword')}</span>
            <span className="field-hint block">
              {t('settings.provisioning.requirePppoePasswordHint')}
            </span>
          </span>
        </label>

        <button type="button" className="modern-button-secondary" onClick={() => void runNow()}>
          {t('settings.provisioning.runNow')}
        </button>
      </div>

      <hr className="my-8 border-border" />

      <h3 className="section-heading text-base">{t('settings.provisioning.profiles')}</h3>
      <p className="section-description mb-4">{t('settings.provisioning.profilesHint')}</p>

      {profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.provisioning.profilesEmpty')}</p>
      ) : (
        <ul className="mb-6 space-y-2">
          {profiles.map((profile) => (
            <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
              <div>
                <p className="font-medium">
                  {profile.name}
                  {profile.isDefault && (
                    <span className="modern-badge ms-2">{t('settings.provisioning.profileDefaultBadge')}</span>
                  )}
                  {!profile.enabled && (
                    <span className="modern-badge ms-2">{t('settings.provisioning.profileDisabledBadge')}</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {profile.planPatterns.length > 0
                    ? profile.planPatterns.join(' · ')
                    : t('settings.provisioning.profileNoPatterns')}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="modern-button-secondary" onClick={() => startEdit(profile)}>
                  {t('common.edit')}
                </button>
                <button type="button" className="modern-button-danger" onClick={() => void removeProfile(profile)}>
                  {t('common.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-4 rounded-md border border-border p-4">
        <h4 className="field-label mb-4">
          {t(editingId ? 'settings.provisioning.profileEdit' : 'settings.provisioning.profileNew')}
        </h4>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-name" className="field-label">{t('settings.provisioning.profileName')}</label>
            <input
              id="profile-name"
              type="text"
              className="modern-input w-full"
              value={draft.name ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="profile-priority" className="field-label">{t('settings.provisioning.profilePriority')}</label>
            <input
              id="profile-priority"
              type="number"
              className="modern-input w-full"
              value={draft.priority ?? 10}
              onChange={(event) => setDraft((current) => ({ ...current, priority: Number(event.target.value) }))}
            />
          </div>
        </div>

        <div>
          <label htmlFor="profile-patterns" className="field-label">{t('settings.provisioning.profilePatterns')}</label>
          <textarea
            id="profile-patterns"
            rows={2}
            className="modern-input w-full"
            value={(draft.planPatterns ?? []).join('\n')}
            onChange={(event) => setDraft((current) => ({ ...current, planPatterns: toList(event.target.value) }))}
          />
          <p className="field-hint">{t('settings.provisioning.profilePatternsHint')}</p>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex min-h-10 items-center gap-2 lg:min-h-0">
            <input
              type="checkbox"
              checked={draft.enabled ?? true}
              onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
            />
            <span className="field-label">{t('settings.provisioning.profileEnabled')}</span>
          </label>
          <label className="flex min-h-10 items-center gap-2 lg:min-h-0">
            <input
              type="checkbox"
              checked={draft.isDefault ?? false}
              onChange={(event) => setDraft((current) => ({ ...current, isDefault: event.target.checked }))}
            />
            <span className="field-label">{t('settings.provisioning.profileDefault')}</span>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-vlan" className="field-label">{t('settings.provisioning.wanVlan')}</label>
            <input
              id="profile-vlan"
              type="number"
              className="modern-input w-full"
              value={draft.wanVlanId ?? ''}
              onChange={(event) => setDraft((current) => ({
                ...current,
                wanVlanId: event.target.value === '' ? null : Number(event.target.value),
              }))}
            />
            <p className="field-hint">{t('settings.provisioning.wanVlanHint')}</p>
          </div>
          <div>
            <label htmlFor="profile-service" className="field-label">{t('settings.provisioning.wanServiceList')}</label>
            <input
              id="profile-service"
              type="text"
              className="modern-input w-full"
              value={draft.wanServiceList ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, wanServiceList: event.target.value }))}
            />
          </div>
        </div>

        <label className="flex min-h-10 items-center gap-2 lg:min-h-0">
          <input
            type="checkbox"
            checked={draft.applyWifi ?? true}
            onChange={(event) => setDraft((current) => ({ ...current, applyWifi: event.target.checked }))}
          />
          <span className="field-label">{t('settings.provisioning.applyWifi')}</span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-wifi-indexes" className="field-label">{t('settings.provisioning.wifiIndexes')}</label>
            <input
              id="profile-wifi-indexes"
              type="text"
              className="modern-input w-full"
              value={(draft.wifiIndexes ?? []).join(', ')}
              onChange={(event) => setDraft((current) => ({ ...current, wifiIndexes: toIndexes(event.target.value) }))}
            />
            <p className="field-hint">{t('settings.provisioning.wifiIndexesHint')}</p>
          </div>
          <div>
            <label htmlFor="profile-ssid" className="field-label">{t('settings.provisioning.wifiSsidTemplate')}</label>
            <input
              id="profile-ssid"
              type="text"
              className="modern-input w-full"
              value={draft.wifiSsidTemplate ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, wifiSsidTemplate: event.target.value }))}
            />
            <p className="field-hint">{t('settings.provisioning.wifiSsidTemplateHint')}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-wifi-mode" className="field-label">{t('settings.provisioning.wifiPasswordMode')}</label>
            <select
              id="profile-wifi-mode"
              className="modern-input w-full"
              value={draft.wifiPasswordMode ?? 'random'}
              onChange={(event) => setDraft((current) => ({
                ...current,
                wifiPasswordMode: event.target.value as ProvisioningProfile['wifiPasswordMode'],
              }))}
            >
              <option value="random">{t('settings.provisioning.wifiPasswordModeRandom')}</option>
              <option value="fixed">{t('settings.provisioning.wifiPasswordModeFixed')}</option>
              <option value="keep">{t('settings.provisioning.wifiPasswordModeKeep')}</option>
            </select>
            <p className="field-hint">{t('settings.provisioning.wifiPasswordModeHint')}</p>
          </div>
          {draft.wifiPasswordMode === 'fixed' && (
            <div>
              <label htmlFor="profile-wifi-password" className="field-label">{t('settings.provisioning.wifiPassword')}</label>
              <input
                id="profile-wifi-password"
                type="password"
                autoComplete="new-password"
                className="modern-input w-full"
                value={draft.wifiPassword ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, wifiPassword: event.target.value }))}
              />
            </div>
          )}
        </div>

        <label className="flex min-h-10 items-center gap-2 lg:min-h-0">
          <input
            type="checkbox"
            checked={draft.applyCredentials ?? false}
            onChange={(event) => setDraft((current) => ({ ...current, applyCredentials: event.target.checked }))}
          />
          <span className="field-label">{t('settings.provisioning.applyCredentials')}</span>
        </label>

        {draft.applyCredentials && (
          <div>
            <label htmlFor="profile-cpe-password" className="field-label">{t('settings.provisioning.cpePassword')}</label>
            <input
              id="profile-cpe-password"
              type="password"
              autoComplete="new-password"
              className="modern-input w-full"
              value={draft.cpePassword ?? ''}
              onChange={(event) => setDraft((current) => ({ ...current, cpePassword: event.target.value }))}
            />
            <p className="field-hint">{t('settings.provisioning.cpePasswordHint')}</p>
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            className="modern-button"
            disabled={saving || !draft.name}
            onClick={() => void submitProfile()}
          >
            {t(editingId ? 'common.save' : 'settings.provisioning.profileCreate')}
          </button>
          {editingId && (
            <button
              type="button"
              className="modern-button-secondary"
              onClick={() => { setEditingId(null); setDraft(EMPTY_PROFILE) }}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      <hr className="my-8 border-border" />

      <h3 className="section-heading text-base">{t('settings.provisioning.runsTitle')}</h3>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.provisioning.runsEmpty')}</p>
      ) : (
        <>
          <ul className="mobile-card-list divide-y divide-border border-y border-border">
            {runs.map((run) => (
              <li key={run.id} className="space-y-1 py-2.5 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 font-mono text-xs wrap-anywhere">{run.deviceId}</span>
                  <span className="shrink-0 font-semibold">{run.status}</span>
                </div>
                {(run.errorMessage ?? run.error) && (
                  <p className="text-xs text-muted-foreground wrap-anywhere">{run.errorMessage ?? run.error}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {run.profileName ?? '—'} · {run.updatedAt ? formatDateTime(run.updatedAt) : '—'}
                </p>
              </li>
            ))}
          </ul>
          <div className="desktop-table overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-start text-xs uppercase text-muted-foreground">
                  <th className="py-2 pe-4">{t('settings.provisioning.runDevice')}</th>
                  <th className="py-2 pe-4">{t('settings.provisioning.runStatus')}</th>
                  <th className="py-2 pe-4">{t('settings.provisioning.runProfile')}</th>
                  <th className="py-2">{t('settings.provisioning.runUpdated')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-border">
                    <td className="py-2 pe-4 font-mono text-xs">{run.deviceId}</td>
                    <td className="py-2 pe-4">
                      {run.status}
                      {(run.errorMessage ?? run.error) && (
                        <span className="block text-xs text-muted-foreground">{run.errorMessage ?? run.error}</span>
                      )}
                    </td>
                    <td className="py-2 pe-4">{run.profileName ?? '—'}</td>
                    <td className="py-2">{run.updatedAt ? formatDateTime(run.updatedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export default ProvisioningTab
