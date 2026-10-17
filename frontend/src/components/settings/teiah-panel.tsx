'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  teiahAPI,
  type TeiahConfig,
  type TeiahExportItem,
  type TeiahExportStatus,
  type TeiahPreviewItem,
  type TeiahRentalDefault,
  type TeiahSkipReason
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import type { TranslationKey } from '@/lib/i18n'

const EXPORT_POLL_MS = 3000

const RENTAL_DEFAULTS: TeiahRentalDefault[] = ['omit', 'false', 'true']

const REASON_KEYS: Record<TeiahSkipReason, TranslationKey> = {
  missing_address: 'settings.teiah.reason.missing_address',
  missing_start: 'settings.teiah.reason.missing_start',
  missing_cancellation: 'settings.teiah.reason.missing_cancellation',
  no_debt: 'settings.teiah.reason.no_debt',
  invoices_failed: 'settings.teiah.reason.invoices_failed',
  rejected: 'settings.teiah.reason.rejected'
}

type ItemFilter = 'skipped' | 'error' | 'sent'

const FILTER_KEYS: Record<ItemFilter, TranslationKey> = {
  skipped: 'settings.teiah.export.filterSkipped',
  error: 'settings.teiah.export.filterError',
  sent: 'settings.teiah.export.filterSent'
}

/**
 * TeiaH Valid: the provider's API key, and the export of the SGP contracts
 * that were cancelled with invoices still open.
 *
 * The export reads the SGP (the cancelled contracts the contacts sync keeps,
 * and each one's open invoices), so it only works once the SGP tab is set up;
 * the server says so if it is not. What leaves the panel is the address, the
 * amount owed and two months — the screen says that before anyone turns it on.
 */
export function TeiahPanel() {
  const { t, formatDateTime, formatNumber } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()

  const canConfigure = can('teiah.config')
  const canRun = can('teiah.act')

  const [config, setConfig] = useState<TeiahConfig | null>(null)
  const [form, setForm] = useState({
    enabled: false,
    baseUrl: '',
    apiKey: '',
    exportEnabled: false,
    exportIntervalHours: 24,
    batchSize: 50,
    rentalDefault: 'omit' as TeiahRentalDefault
  })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<TeiahExportStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<TeiahPreviewItem[] | null>(null)
  const [filter, setFilter] = useState<ItemFilter>('skipped')
  const [items, setItems] = useState<TeiahExportItem[]>([])

  const applyConfig = useCallback((next: TeiahConfig) => {
    setConfig(next)
    setForm({
      enabled: next.enabled,
      baseUrl: next.baseUrl,
      apiKey: '',
      exportEnabled: next.exportEnabled,
      exportIntervalHours: next.exportIntervalHours,
      batchSize: next.batchSize,
      rentalDefault: next.rentalDefault
    })
  }, [])

  const loadStatus = useCallback(async () => {
    const res = await teiahAPI.getExport()
    if (!res.success || !res.data) return null
    setStatus(res.data)
    return res.data
  }, [])

  const loadItems = useCallback(async (which: ItemFilter) => {
    const res = await teiahAPI.listExportItems(which)
    if (res.success && res.data) setItems(res.data.items)
  }, [])

  useEffect(() => {
    if (canConfigure) {
      void teiahAPI.getConfig().then((res) => { if (res.success && res.data) applyConfig(res.data) })
    }
    void loadStatus().then((current) => { if (current?.running) setRunning(true) })
  }, [canConfigure, applyConfig, loadStatus])

  useEffect(() => {
    void loadItems(filter)
  }, [filter, loadItems])

  // The export runs in the background; the screen asks how it went until it is done.
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => {
      void loadStatus().then((current) => {
        if (!current || current.running) return
        setRunning(false)
        void loadItems(filter)
        const failed = current.lastError
          && (!current.lastRun || current.lastError.at > current.lastRun.finishedAt)
        if (failed) toast.error(current.lastError?.message || t('settings.teiah.export.failed'))
        else toast.success(t('settings.teiah.export.done'))
      })
    }, EXPORT_POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, loadStatus, loadItems, filter, toast, t])

  const save = async (clearKey = false) => {
    setSaving(true)
    try {
      const res = await teiahAPI.updateConfig({
        enabled: form.enabled,
        baseUrl: form.baseUrl.trim(),
        exportEnabled: form.exportEnabled,
        exportIntervalHours: form.exportIntervalHours,
        batchSize: form.batchSize,
        rentalDefault: form.rentalDefault,
        // Blank keeps the stored key; the clear button sends "" on purpose.
        ...(clearKey ? { apiKey: '' } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.teiah.saveFailed'))
        return
      }
      applyConfig(res.data)
      toast.success(t('settings.teiah.saved'))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await teiahAPI.test({
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.apiKey.trim() || undefined
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.teiah.testFailed'))
        return
      }
      toast.success(t('settings.teiah.testOk', { seconds: (res.data.durationMs / 1000).toFixed(1) }))
    } finally {
      setTesting(false)
    }
  }

  const runPreview = async () => {
    setPreviewing(true)
    setPreview(null)
    try {
      const res = await teiahAPI.previewExport()
      if (!res.success || !res.data) {
        toast.error(res.message || t('settings.teiah.export.failed'))
        return
      }
      setPreview(res.data.items)
    } finally {
      setPreviewing(false)
    }
  }

  const runExport = async () => {
    setRunning(true)
    const res = await teiahAPI.runExport()
    if (!res.success) {
      setRunning(false)
      toast.error(res.message || t('settings.teiah.export.failed'))
    }
  }

  const ready = Boolean(config?.ready)
  const lastRun = status?.lastRun ?? null
  const lastError = status?.lastError ?? null
  const money = (value: number | null) => (value === null
    ? '—'
    : formatNumber(value, { style: 'currency', currency: 'BRL' }))

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6" data-testid="teiah-panel">
      <p className="page-kicker">{t('settings.teiah.kicker')}</p>
      <h2 className="section-heading">{t('settings.teiah.title')}</h2>
      <p className="section-description mb-4">{t('settings.teiah.description')}</p>
      <p className="mb-6 flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <Icon name="lock" size={16} />
        <span>{t('settings.teiah.privacy')}</span>
      </p>

      {canConfigure && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-start gap-3 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.enabled}
              onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.teiah.enabled')}</span>
              <span className="text-muted-foreground">{t('settings.teiah.enabledHint')}</span>
            </span>
          </label>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="teiah-api-key">{t('settings.teiah.apiKey')}</label>
            <input
              id="teiah-api-key"
              type="password"
              autoComplete="off"
              className="modern-input font-mono"
              value={form.apiKey}
              placeholder={config?.apiKeyConfigured ? t('settings.teiah.apiKeyConfigured') : t('settings.teiah.apiKeyPlaceholder')}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="teiah-base-url">{t('settings.teiah.baseUrl')}</label>
            <input
              id="teiah-base-url"
              className="modern-input font-mono"
              value={form.baseUrl}
              placeholder="https://api.valid.teiah.ai"
              onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.teiah.baseUrlHint')}</p>
          </div>

          <h3 className="mt-2 font-semibold sm:col-span-2">{t('settings.teiah.export.title')}</h3>
          <p className="-mt-2 text-sm leading-6 text-muted-foreground sm:col-span-2">{t('settings.teiah.export.hint')}</p>
          <label className="flex items-start gap-3 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.exportEnabled}
              onChange={(event) => setForm((current) => ({ ...current, exportEnabled: event.target.checked }))}
            />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.teiah.export.enabled')}</span>
              <span className="text-muted-foreground">{t('settings.teiah.export.enabledHint')}</span>
            </span>
          </label>
          {form.exportEnabled && (
            <div>
              <label className="field-label" htmlFor="teiah-interval">{t('settings.teiah.export.interval')}</label>
              <input
                id="teiah-interval"
                type="number"
                min={1}
                max={168}
                className="modern-input"
                value={form.exportIntervalHours}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  exportIntervalHours: Number(event.target.value) || 24
                }))}
              />
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="teiah-batch">{t('settings.teiah.export.batchSize')}</label>
            <input
              id="teiah-batch"
              type="number"
              min={1}
              max={500}
              className="modern-input"
              value={form.batchSize}
              onChange={(event) => setForm((current) => ({ ...current, batchSize: Number(event.target.value) || 50 }))}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="teiah-rental">{t('settings.teiah.export.rental')}</label>
            <select
              id="teiah-rental"
              className="modern-input"
              value={form.rentalDefault}
              onChange={(event) => setForm((current) => ({
                ...current,
                rentalDefault: RENTAL_DEFAULTS.includes(event.target.value as TeiahRentalDefault)
                  ? event.target.value as TeiahRentalDefault
                  : 'omit'
              }))}
            >
              <option value="omit">{t('settings.teiah.export.rentalOmit')}</option>
              <option value="false">{t('settings.teiah.export.rentalFalse')}</option>
              <option value="true">{t('settings.teiah.export.rentalTrue')}</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.teiah.export.rentalHint')}</p>
          </div>
        </div>
      )}

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
            disabled={testing || (!config?.apiKeyConfigured && !form.apiKey.trim())}
            onClick={() => void runTest()}
          >
            <Icon name="search" size={16} className={testing ? 'animate-spin' : ''} />
            {t('settings.teiah.test')}
          </button>
        )}
        {canConfigure && config?.apiKeyConfigured && (
          <button type="button" className="modern-button-secondary" disabled={saving} onClick={() => void save(true)}>
            <Icon name="trash" size={16} />
            {t('settings.teiah.apiKeyClear')}
          </button>
        )}
        <button
          type="button"
          className="modern-button-secondary"
          disabled={previewing || running}
          onClick={() => void runPreview()}
        >
          <Icon name="eye" size={16} className={previewing ? 'animate-pulse' : ''} />
          {t('settings.teiah.export.preview')}
        </button>
        {canRun && (
          <button
            type="button"
            className="modern-button-secondary"
            disabled={running || (config !== null && !config.ready)}
            onClick={() => void runExport()}
          >
            <Icon name="refresh" size={16} className={running ? 'animate-spin' : ''} />
            {running ? t('settings.teiah.export.running') : t('settings.teiah.export.runNow')}
          </button>
        )}
      </div>
      {config && !ready && (
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <Icon name="info" size={14} />
          {t('settings.teiah.notReady')}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('settings.teiah.export.sgpRequired')}</p>

      {preview && (
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="teiah-preview">
          <p className="font-semibold">{t('settings.teiah.export.previewTitle')}</p>
          {preview.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.teiah.export.previewEmpty')}</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {preview.map((entry) => (
                <li key={entry.contract} className="text-xs">
                  <span className="font-semibold">{entry.contract}</span>
                  {entry.clientName ? ` · ${entry.clientName}` : ''}
                  {entry.item ? (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap wrap-break-word font-mono text-muted-foreground">
                      {JSON.stringify(entry.item, null, 2)}
                    </pre>
                  ) : (
                    <span className="ms-2 text-[hsl(var(--status-warning))]">
                      {entry.reason ? t(REASON_KEYS[entry.reason]) : '—'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lastRun ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {([
              ['settings.teiah.export.total', lastRun.total],
              ['settings.teiah.export.sent', lastRun.sent],
              ['settings.teiah.export.unchanged', lastRun.unchanged],
              ['settings.teiah.export.skipped', lastRun.skipped],
              ['settings.teiah.export.errors', lastRun.errors]
            ] as const).map(([labelKey, value]) => (
              <div key={labelKey}>
                <dt className="metric-label">{t(labelKey)}</dt>
                <dd className="data-value mt-1">{value}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(lastRun.reasons ?? {}).length > 0 && (
            <ul className="mt-3 list-disc ps-5 text-xs text-muted-foreground">
              {(Object.entries(lastRun.reasons) as Array<[TeiahSkipReason, number]>).map(([reason, count]) => (
                <li key={reason}>{t(REASON_KEYS[reason])}: {count}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {t('settings.teiah.export.finished', {
              time: formatDateTime(lastRun.finishedAt),
              seconds: (lastRun.durationMs / 1000).toFixed(1)
            })}
          </p>
          {lastRun.partial && (
            <p className="mt-2 flex items-start gap-2 text-xs text-[hsl(var(--status-warning))]">
              <Icon name="warning" size={14} />
              {t('settings.teiah.export.partial')}
            </p>
          )}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">{t('settings.teiah.export.never')}</p>
      )}
      {!running && lastError && (!lastRun || lastError.at > lastRun.finishedAt) && (
        <p className="mt-2 flex items-start gap-2 text-xs text-destructive" role="alert" data-testid="teiah-last-error">
          <Icon name="warning" size={14} />
          {t('settings.teiah.export.lastError', { time: formatDateTime(lastError.at), message: lastError.message })}
        </p>
      )}

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="font-semibold">{t('settings.teiah.export.listTitle')}</h3>
        <div className="mt-3 flex flex-wrap gap-2" role="tablist">
          {(Object.keys(FILTER_KEYS) as ItemFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="tab-button"
              data-active={filter === key}
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(FILTER_KEYS[key])} ({status?.totals?.[key] ?? 0})
            </button>
          ))}
        </div>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('settings.teiah.export.listEmpty')}</p>
        ) : (
          <>
            {/* No celular, uma linha por contrato: na tabela o endereço virava uma coluna estreita. */}
            <ul className="mobile-card-list mt-3 divide-y divide-border border-y border-border">
              {items.map((item) => (
                <li key={item.contract} className="space-y-1 py-2.5 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 font-mono wrap-anywhere">{item.contract}</span>
                    <span className="shrink-0 whitespace-nowrap">{money(item.amount)}</span>
                  </div>
                  {item.clientName && <p className="text-xs text-muted-foreground">{item.clientName}</p>}
                  {item.address && <p className="text-xs text-muted-foreground">{item.address}</p>}
                  <p className="text-xs">
                    {filter === 'sent'
                      ? (item.sentAt ? formatDateTime(item.sentAt) : '—')
                      : (item.reason ? t(REASON_KEYS[item.reason]) : '—')}
                  </p>
                </li>
              ))}
            </ul>
            <div className="desktop-table mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-muted-foreground">
                    <th className="py-2 pe-3 text-start font-medium">{t('settings.teiah.export.contract')}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t('settings.teiah.export.amount')}</th>
                    <th className="py-2 text-start font-medium">
                      {filter === 'sent' ? t('settings.teiah.export.sentAt') : t('settings.teiah.export.reason')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.contract} className="border-t border-border align-top">
                      <td className="py-2 pe-3">
                        <span className="font-mono">{item.contract}</span>
                        {item.clientName && <span className="block text-xs text-muted-foreground">{item.clientName}</span>}
                        {item.address && <span className="block text-xs text-muted-foreground">{item.address}</span>}
                      </td>
                      <td className="py-2 pe-3 whitespace-nowrap">{money(item.amount)}</td>
                      <td className="py-2 text-xs">
                        {filter === 'sent'
                          ? (item.sentAt ? formatDateTime(item.sentAt) : '—')
                          : (item.reason ? t(REASON_KEYS[item.reason]) : '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
