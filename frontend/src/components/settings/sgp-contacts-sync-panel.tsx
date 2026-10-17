'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  sgpAPI,
  type SgpConfig,
  type SgpContactsSyncResult,
  type SgpContactsSyncStatus,
  type SgpContactsTestResult
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'

const SYNC_POLL_MS = 3000

/** A test page slower than this leaves little room under the 90 s a page may take. */
const SLOW_PAGE_MS = 30_000

/** A page size that answers in about 20 s at the speed the test measured, never under 10. */
function suggestedPageSize(test: SgpContactsTestResult) {
  const perClient = test.durationMs / Math.max(test.received, 1)
  return Math.max(10, Math.min(test.pageSize, Math.floor(20_000 / Math.max(perClient, 1) / 10) * 10))
}

/** Where the section sits, so the WhatsApp tab and the contacts screen can link to it. */
export const SGP_CONTACTS_ANCHOR = 'sgp-contacts-sync'

/** The address that opens Settings on the SGP tab, scrolled to this section. */
export const SGP_CONTACTS_HREF = `/settings?tab=sgp#${SGP_CONTACTS_ANCHOR}`

/**
 * The same section, announced where people look for it first: the WhatsApp
 * tab of Settings. Only a summary and the way there — the form stays in one
 * place, next to the SGP credentials it depends on.
 */
export function SgpContactsShortcut({ onOpen }: { onOpen: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const [lastRun, setLastRun] = useState<SgpContactsSyncResult | null>(null)

  useEffect(() => {
    let alive = true
    void sgpAPI.getContactsSync().then((res) => {
      if (alive && res.success) setLastRun(res.data?.lastRun ?? null)
    })
    return () => { alive = false }
  }, [])

  return (
    <div className="mt-6 border-t border-border pt-5" data-testid="sgp-contacts-shortcut">
      <h3 className="font-semibold">{t('settings.whatsapp.sgpContacts.title')}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.whatsapp.sgpContacts.hint')}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {lastRun
          ? t('settings.sgp.syncFinished', {
            time: formatDateTime(lastRun.finishedAt),
            seconds: (lastRun.durationMs / 1000).toFixed(1)
          })
          : t('settings.sgp.syncNever')}
      </p>
      <button type="button" className="modern-button-secondary mt-3" onClick={onOpen}>
        <Icon name="external" size={16} />
        {t('settings.whatsapp.sgpContacts.open')}
      </button>
    </div>
  )
}

interface Props {
  config: SgpConfig | null
  onConfigChange: (config: SgpConfig) => void
}

/**
 * Every SGP client into the WhatsApp contacts — with or without a contract,
 * with or without equipment.
 *
 * The URA reference has no "list every client" call and the path differs
 * between SGP versions, so the listing path is a setting here, proved by the
 * test button before anything is written. Its own form and its own save, so
 * the integration form above is never saved with half of this in it.
 */
export function SgpContactsSyncPanel({ config, onConfigChange }: Props) {
  const { t, formatDateTime } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()

  const [form, setForm] = useState({
    path: '',
    enabled: false,
    intervalHours: 24,
    pageSize: 100,
    paging: 'offset' as 'offset' | 'page',
    offsetParam: 'offset',
    limitParam: 'limit'
  })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [test, setTest] = useState<SgpContactsTestResult | null>(null)
  const [lastRun, setLastRun] = useState<SgpContactsSyncResult | null>(null)
  const [lastError, setLastError] = useState<SgpContactsSyncStatus['lastError']>(null)

  const canConfigure = can('sgp.config')
  const canSync = can('sgp.act')

  // The form follows the saved config the first time it arrives, and after
  // every save of this panel — never while the operator is typing.
  const configKey = config?.updatedAt ?? null
  useEffect(() => {
    if (!config) return
    setForm({
      path: config.endpoints.customerList || '',
      enabled: config.contactsSyncEnabled,
      intervalHours: config.contactsSyncIntervalHours,
      pageSize: config.contactsPageSize,
      paging: config.contactsPaging,
      offsetParam: config.contactsOffsetParam,
      limitParam: config.contactsLimitParam
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey])

  const loadStatus = useCallback(async () => {
    const res = await sgpAPI.getContactsSync()
    if (!res.success || !res.data) return null
    setLastRun(res.data.lastRun)
    setLastError(res.data.lastError)
    return res.data
  }, [])

  // A sync already running when the screen opens (the timer's, or one started
  // before a reload) is followed like one started here.
  useEffect(() => {
    void loadStatus().then((status) => { if (status?.running) setSyncing(true) })
  }, [loadStatus])

  // The sync runs in the background: while it does, the screen asks how it
  // went every few seconds instead of holding one request open past the proxy.
  useEffect(() => {
    if (!syncing) return undefined
    const timer = window.setInterval(() => {
      void loadStatus().then((status) => {
        if (!status || status.running) return
        setSyncing(false)
        const failed = status.lastError
          && (!status.lastRun || status.lastError.at > status.lastRun.finishedAt)
        if (failed) toast.error(status.lastError?.message || t('settings.sgp.contacts.syncFailed'))
        else toast.success(t('settings.sgp.contacts.syncDone'))
      })
    }, SYNC_POLL_MS)
    return () => window.clearInterval(timer)
  }, [syncing, loadStatus, toast, t])

  const save = async () => {
    setSaving(true)
    try {
      const res = await sgpAPI.updateConfig({
        endpoints: { customerList: form.path.trim() } as SgpConfig['endpoints'],
        contactsSyncEnabled: form.enabled,
        contactsSyncIntervalHours: form.intervalHours,
        contactsPageSize: form.pageSize,
        contactsPaging: form.paging,
        contactsOffsetParam: form.offsetParam.trim(),
        contactsLimitParam: form.limitParam.trim()
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.sgp.saveFailed'))
        return
      }
      onConfigChange(res.data)
      toast.success(t('settings.sgp.saved'))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      const res = await sgpAPI.testContacts()
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.sgp.contacts.testFailed'))
        return
      }
      setTest(res.data)
    } finally {
      setTesting(false)
    }
  }

  const runSync = async () => {
    setSyncing(true)
    const res = await sgpAPI.syncContacts()
    if (!res.success) {
      setSyncing(false)
      toast.error(res.message || t('settings.sgp.contacts.syncFailed'))
    }
  }

  const savedPath = config?.endpoints.customerList || ''
  // Test and sync read the SAVED path; an edited but unsaved one would test
  // something other than what the timer will run.
  const dirtyPath = form.path.trim() !== savedPath
  // The integration itself (address, app, token) is saved in the form above.
  // Until it is, nothing here can reach the SGP — said on screen instead of
  // hiding the section, which is how it went unfound.
  const ready = Boolean(config?.ready)

  return (
    <div id={SGP_CONTACTS_ANCHOR} className="mt-6 scroll-mt-6 border-t border-border pt-5" data-testid="sgp-contacts-sync">
      <h3 className="font-semibold">{t('settings.sgp.contacts.title')}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.sgp.contacts.hint')}</p>
      {!ready && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <Icon name="info" size={16} />
          <span>{t('settings.sgp.contacts.notReady')}</span>
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="field-label" htmlFor="sgp-contacts-path">{t('settings.sgp.contacts.path')}</label>
          <input
            id="sgp-contacts-path"
            className="modern-input font-mono"
            value={form.path}
            disabled={!canConfigure}
            placeholder="/api/ura/clientes/"
            onChange={(event) => setForm((current) => ({ ...current, path: event.target.value }))}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.sgp.contacts.pathHint')}</p>
          {/\{\{|\}\}/.test(form.path) && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" role="alert" data-testid="sgp-contacts-path-placeholder">
              {t('settings.sgp.contacts.pathPlaceholder')}
            </p>
          )}
        </div>
        <div>
          <label className="field-label" htmlFor="sgp-contacts-paging">{t('settings.sgp.contacts.paging')}</label>
          <select
            id="sgp-contacts-paging"
            className="modern-input"
            value={form.paging}
            disabled={!canConfigure}
            onChange={(event) => setForm((current) => ({
              ...current,
              paging: event.target.value === 'page' ? 'page' : 'offset'
            }))}
          >
            <option value="offset">{t('settings.sgp.contacts.pagingOffset')}</option>
            <option value="page">{t('settings.sgp.contacts.pagingPage')}</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="sgp-contacts-size">{t('settings.sgp.contacts.pageSize')}</label>
          <input
            id="sgp-contacts-size"
            type="number"
            min={10}
            max={500}
            className="modern-input"
            value={form.pageSize}
            disabled={!canConfigure}
            onChange={(event) => setForm((current) => ({ ...current, pageSize: Number(event.target.value) || 100 }))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="sgp-contacts-offset">{t('settings.sgp.contacts.offsetParam')}</label>
          <input
            id="sgp-contacts-offset"
            className="modern-input font-mono"
            value={form.offsetParam}
            disabled={!canConfigure}
            onChange={(event) => setForm((current) => ({ ...current, offsetParam: event.target.value }))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="sgp-contacts-limit">{t('settings.sgp.contacts.limitParam')}</label>
          <input
            id="sgp-contacts-limit"
            className="modern-input font-mono"
            value={form.limitParam}
            disabled={!canConfigure}
            onChange={(event) => setForm((current) => ({ ...current, limitParam: event.target.value }))}
          />
        </div>
        <label className="flex items-start gap-3 sm:col-span-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={form.enabled}
            disabled={!canConfigure}
            onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
          />
          <span className="text-sm">
            <span className="block font-semibold">{t('settings.sgp.contacts.enabled')}</span>
            <span className="text-muted-foreground">{t('settings.sgp.contacts.enabledHint')}</span>
          </span>
        </label>
        {form.enabled && (
          <div>
            <label className="field-label" htmlFor="sgp-contacts-interval">{t('settings.sgp.contacts.interval')}</label>
            <input
              id="sgp-contacts-interval"
              type="number"
              min={1}
              max={168}
              className="modern-input"
              value={form.intervalHours}
              disabled={!canConfigure}
              onChange={(event) => setForm((current) => ({
                ...current,
                intervalHours: Number(event.target.value) || 24
              }))}
            />
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {canConfigure && (
          <button type="button" className="modern-button" disabled={saving} onClick={() => void save()}>
            {t('common.save')}
          </button>
        )}
        {canConfigure && (
          <button
            type="button"
            className="modern-button-secondary"
            disabled={!ready || testing || !savedPath || dirtyPath}
            title={dirtyPath ? t('settings.sgp.contacts.saveFirst') : undefined}
            onClick={() => void runTest()}
          >
            <Icon name="search" size={16} className={testing ? 'animate-spin' : ''} />
            {t('settings.sgp.contacts.test')}
          </button>
        )}
        {canSync && (
          <button
            type="button"
            className="modern-button-secondary"
            disabled={!ready || syncing || !savedPath || dirtyPath}
            title={dirtyPath ? t('settings.sgp.contacts.saveFirst') : undefined}
            onClick={() => void runSync()}
          >
            <Icon name="refresh" size={16} className={syncing ? 'animate-spin' : ''} />
            {syncing ? t('settings.sgp.syncing') : t('settings.sgp.contacts.syncNow')}
          </button>
        )}
      </div>

      {test && (
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <p className="font-semibold">
            {t('settings.sgp.contacts.testResult', {
              received: test.received,
              withContract: test.withContract,
              withPhone: test.withPhone
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.sgp.contacts.testDuration', { seconds: (test.durationMs / 1000).toFixed(1) })}
          </p>
          {test.durationMs > SLOW_PAGE_MS && (
            <p className="mt-1 flex items-start gap-2 text-xs text-[hsl(var(--status-warning))]">
              <Icon name="warning" size={14} />
              {t('settings.sgp.contacts.testSlow', {
                seconds: Math.round(test.durationMs / 1000),
                suggested: suggestedPageSize(test)
              })}
            </p>
          )}
          {test.fields.length > 0 && (
            <p className="mt-1 wrap-break-word font-mono text-xs text-muted-foreground">
              {t('settings.sgp.contacts.testFields')}: {test.fields.join(', ')}
            </p>
          )}
          {Object.entries(test.shape ?? {}).map(([field, description]) => (
            <p key={field} className="mt-1 wrap-break-word font-mono text-xs text-muted-foreground">
              {field}: {description}
            </p>
          ))}
          {test.sample.length > 0 && (
            <ul className="mt-2 list-disc ps-5 text-xs text-muted-foreground">
              {test.sample.map((row, index) => (
                <li key={`${row.contract ?? 'none'}-${index}`}>
                  {row.name || '—'} · {row.contract || t('whatsapp.contacts.noContract')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lastRun ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {([
              ['settings.sgp.contacts.total', lastRun.total],
              ['settings.sgp.contacts.created', lastRun.created],
              ['settings.sgp.contacts.updated', lastRun.updated],
              ['settings.sgp.contacts.withoutContract', lastRun.withoutContract]
            ] as const).map(([labelKey, value]) => (
              <div key={labelKey}>
                <dt className="metric-label">{t(labelKey)}</dt>
                <dd className="data-value mt-1">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            {t('settings.sgp.syncFinished', {
              time: formatDateTime(lastRun.finishedAt),
              seconds: (lastRun.durationMs / 1000).toFixed(1)
            })}
          </p>
          {lastRun.note === 'all_at_once' && (
            <p className="mt-2 text-xs text-muted-foreground">{t('settings.sgp.contacts.allAtOnce')}</p>
          )}
          {lastRun.partial && (
            <p className="mt-2 flex items-start gap-2 text-xs text-[hsl(var(--status-warning))]">
              <Icon name="warning" size={14} />
              {t(lastRun.reason === 'paging_ignored'
                ? 'settings.sgp.contacts.partialPaging'
                : lastRun.reason === 'empty'
                  ? 'settings.sgp.contacts.partialEmpty'
                  : lastRun.reason === 'error'
                    ? 'settings.sgp.contacts.partialError'
                    : 'settings.sgp.contacts.partialCeiling')}
            </p>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{t('settings.sgp.syncNever')}</p>
      )}
      {syncing && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">{t('settings.sgp.contacts.running')}</p>
      )}
      {!syncing && lastError && (!lastRun || lastError.at > lastRun.finishedAt) && (
        <p className="mt-2 flex items-start gap-2 text-xs text-destructive" role="alert" data-testid="sgp-contacts-last-error">
          <Icon name="warning" size={14} />
          {t('settings.sgp.contacts.lastError', { time: formatDateTime(lastError.at), message: lastError.message })}
        </p>
      )}
    </div>
  )
}
