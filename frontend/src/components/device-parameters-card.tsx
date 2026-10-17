import { useCallback, useState } from 'react'
import { devicesAPI, type DeviceParameterList } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { summonDeferredMessage } from '@/lib/device-actions'

/** What an operator looks for when a field on the page reads N/D. */
const SHORTCUTS = ['RXPower', 'Temperature', 'VLAN', 'ConnectionType', 'Username', 'MACAddress']

interface DeviceParametersCardProps {
  deviceId: string
}

/**
 * Every parameter GenieACS holds for this ONT, searchable.
 *
 * When the page reads N/D there are two different answers — the ONT does not
 * publish the value, or GenieACS never asked it — and only the raw document
 * tells them apart. A parameter that exists but was never read is marked as
 * such, and "Solicitar Inform" is what asks the ONT for it.
 */
export function DeviceParametersCard({ deviceId }: DeviceParametersCardProps) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<DeviceParameterList | null>(null)
  const [loading, setLoading] = useState(false)
  const [summoning, setSummoning] = useState(false)

  const load = useCallback(async (term: string) => {
    setLoading(true)
    try {
      const res = await devicesAPI.getDeviceParameters(deviceId, term.trim())
      if (res.success && res.data) setResult(res.data)
      else toast.error(res.message || t('detail.parameters.failed'))
    } catch {
      toast.error(t('detail.parameters.failed'))
    } finally {
      setLoading(false)
    }
  }, [deviceId, t, toast])

  const pick = (term: string) => {
    setSearch(term)
    void load(term)
  }

  const summon = async () => {
    setSummoning(true)
    try {
      const res = await devicesAPI.summonDevice(deviceId)
      if (res.success && res.data?.reached === false) {
        toast.warning(summonDeferredMessage(res.data, t, formatDateTime, res.message || t('detail.parameters.summoned')))
      }
      else if (res.success) toast.success(t('detail.parameters.summoned'))
      else toast.error(res.message || t('devices.summon.failed'))
    } catch {
      toast.error(t('devices.summon.error'))
    } finally {
      setSummoning(false)
    }
  }

  const copy = async () => {
    if (!result) return
    const text = result.rows
      .map((row) => `${row.path} = ${row.read ? String(row.value ?? '') : t('detail.parameters.notRead')}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('detail.parameters.copied'))
    } catch {
      toast.error(t('detail.parameters.copyFailed'))
    }
  }

  return (
    <div>
      <h3 className="text-md font-medium mb-1 text-gray-900 dark:text-gray-100">{t('detail.parameters.title')}</h3>
      <p className="section-description mb-3">{t('detail.parameters.description')}</p>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void load(search)
        }}
      >
        <input
          className="modern-input min-w-0 flex-1 basis-full sm:basis-0"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('detail.parameters.searchPlaceholder')}
          maxLength={128}
        />
        <button type="submit" className="modern-button" disabled={loading}>
          <Icon name="search" size={16} />
          {t('detail.parameters.search')}
        </button>
        <button type="button" className="modern-button-secondary" disabled={summoning} onClick={() => void summon()}>
          <Icon name="refresh" size={16} />
          {t('detail.parameters.summon')}
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-2">
        {SHORTCUTS.map((term) => (
          <button
            key={term}
            type="button"
            className="min-h-10 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-primary sm:min-h-0 sm:px-2 sm:py-0.5"
            onClick={() => pick(term)}
          >
            {term}
          </button>
        ))}
      </div>

      {result && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {result.total > result.rows.length
                ? t('detail.parameters.countLimited', { shown: result.rows.length, total: result.total })
                : t('detail.parameters.count', { total: result.total })}
            </span>
            {result.rows.length > 0 && (
              <button type="button" className="modern-button-secondary" onClick={() => void copy()}>
                <Icon name="copy" size={14} />
                {t('detail.parameters.copy')}
              </button>
            )}
          </div>
          {result.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('detail.parameters.empty')}</p>
          ) : (
            <div className="max-h-96 overflow-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr>
                    <th className="px-3 py-2">{t('detail.parameters.path')}</th>
                    <th className="px-3 py-2">{t('detail.parameters.value')}</th>
                    <th className="hidden px-3 py-2 sm:table-cell">{t('detail.parameters.readAt')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((row) => (
                    <tr key={row.path}>
                      <td className="break-all px-3 py-1.5 font-mono">
                        {row.path}
                        {/* No celular a coluna da hora sai e ela vem aqui, para o caminho ter largura. */}
                        <span className="mt-0.5 block break-normal font-sans text-muted-foreground sm:hidden">
                          {row.timestamp ? formatDateTime(row.timestamp) : '—'}
                        </span>
                      </td>
                      <td className="break-all px-3 py-1.5 font-mono">
                        {row.read
                          ? String(row.value ?? '')
                          : <span className="whitespace-nowrap text-[hsl(var(--status-warning))]">{t('detail.parameters.notRead')}</span>}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-1.5 text-muted-foreground sm:table-cell">
                        {row.timestamp ? formatDateTime(row.timestamp) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default DeviceParametersCard
