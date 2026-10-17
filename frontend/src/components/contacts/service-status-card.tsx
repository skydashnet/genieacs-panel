import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { contactsAPI, type ContactServiceStatus } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { formatDuration, type DurationLabels } from '@/lib/duration'

/**
 * "Status do serviço": what each contract's ONT says about the line right now,
 * read from the ACS (TR-069) when the record opens and again on demand. Nothing
 * is stored; a contract with no ONT linked says so.
 */
export function ServiceStatusCard({ contactKey, hasContracts }: { contactKey: string; hasContracts: boolean }) {
  const { t, formatDateTime } = useTranslation()
  const [rows, setRows] = useState<ContactServiceStatus['contracts'] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await contactsAPI.serviceStatus(contactKey)
      if (res.success && res.data) setRows(res.data.contracts)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [contactKey])

  useEffect(() => {
    if (hasContracts) void load()
  }, [hasContracts, load])

  if (!hasContracts) return null

  const labels: DurationLabels = {
    seconds: (n) => t('whatsapp.responseTime.seconds', { n }),
    minutes: (n) => t('whatsapp.responseTime.minutes', { n }),
    hours: (h, m) => t('whatsapp.responseTime.hours', { h, m }),
    days: (d, h) => t('whatsapp.responseTime.days', { d, h })
  }

  const line = (label: string, value: string | null | undefined) => (
    value ? (
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">{label}:</dt>
        <dd className="font-medium wrap-anywhere">{value}</dd>
      </div>
    ) : null
  )

  return (
    <section className="modern-card mt-5 p-5 sm:p-6" data-testid="service-status">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-heading">{t('contacts.profile.serviceStatus')}</h2>
        <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} /> {t('common.refresh')}
        </button>
      </div>
      {failed && <p className="text-sm text-[hsl(var(--status-warning))]" role="status">{t('contacts.profile.serviceStatusFailed')}</p>}
      {!failed && rows === null && <p className="text-sm text-muted-foreground">{t('contacts.profile.loading')}</p>}
      {rows && (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.contract} className="py-4 first:pt-0 last:pb-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">{t('contacts.profile.equipmentContract', { contract: row.contract })}</span>
                {row.available ? (
                  <span className={row.status === 'online' ? 'modern-badge-success' : 'modern-badge-error'}>
                    {t(row.status === 'online' ? 'contacts.profile.statusOnline' : 'contacts.profile.statusOffline')}
                  </span>
                ) : (
                  <span className="modern-badge">{t(row.reason === 'unlinked' ? 'contacts.profile.statusUnlinked' : 'contacts.profile.statusUnreachable')}</span>
                )}
              </div>
              {row.available && (
                <dl className="grid gap-1 text-sm sm:grid-cols-2">
                  {line(t('contacts.profile.statusUptime'), row.uptimeSeconds !== null && row.uptimeSeconds !== undefined ? formatDuration(row.uptimeSeconds, labels) : null)}
                  {line(t('contacts.profile.statusLastInform'), row.lastInform ? formatDateTime(row.lastInform) : null)}
                  {line(t('contacts.profile.statusIp'), row.ipAddress)}
                  {line(t('contacts.profile.statusWan'), row.wanStatus)}
                  {line(t('contacts.profile.statusSignal'), row.rxPower !== null && row.rxPower !== undefined ? `${row.rxPower} dBm` : null)}
                  {line(t('contacts.profile.statusClients'), row.connectedDevices !== null && row.connectedDevices !== undefined ? String(row.connectedDevices) : null)}
                  {line(t('contacts.profile.statusModel'), row.model)}
                </dl>
              )}
              {row.deviceId && (
                <Link className="mt-2 inline-block text-sm text-primary hover:underline" to={`/devices/detail?id=${encodeURIComponent(row.deviceId)}`}>
                  {t('contacts.profile.statusOpenDevice')}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ServiceStatusCard
