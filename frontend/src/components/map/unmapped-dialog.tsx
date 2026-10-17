import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { mappingAPI, type UnmappedDevice } from '@/lib/api'
import { LIVE_COLORS } from '@/lib/map-status'

/**
 * Os equipamentos que ainda não estão no mapa (pelo PPPoE), com busca e o
 * botão "Colocar" em cada um.
 */
export function UnmappedDialog({ canWrite, onClose, onPlace, onPlaceAll }: {
  canWrite: boolean
  onClose: () => void
  onPlace: (device: UnmappedDevice) => void
  /** "Colocar todos": os que o SGP já dá o endereço, de uma vez. */
  onPlaceAll?: () => void
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<{ total: number; items: UnmappedDevice[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void mappingAPI.unmappedDevices()
      .then((response) => {
        if (cancelled) return
        if (response.success && response.data) setData(response.data)
        else setError(response.message || t('map.unmapped.failed'))
      })
      .catch(() => { if (!cancelled) setError(t('map.unmapped.failed')) })
    return () => { cancelled = true }
  }, [t])

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (data?.items ?? []).filter((item) => !term || item.pppoe.toLowerCase().includes(term) || String(item.deviceId ?? '').toLowerCase().includes(term)).slice(0, 300)
  }, [data, query])

  return (
    <div className="modal-backdrop z-2200 bg-black/65" role="dialog" aria-modal="true">
      <div className="modal-panel modern-card flex max-w-2xl flex-col p-5 sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="section-heading">{t('map.unmapped.title', { count: data?.total ?? 0 })}</h2>
          <button type="button" onClick={onClose} className="icon-button" aria-label={t('common.close')}><Icon name="x" size={20} /></button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">{t('map.unmapped.hint')}</p>
        {canWrite && onPlaceAll && data && data.total > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">{t('map.bulk.offer')}</span>
            <button type="button" className="modern-button min-h-10 shrink-0 px-3 text-sm sm:min-h-9" onClick={onPlaceAll}>
              <Icon name="pin" size={15} />{t('map.bulk.button')}
            </button>
          </div>
        )}
        <input type="search" className="modern-input mb-3 w-full" placeholder={t('map.unmapped.search')} aria-label={t('map.unmapped.search')}
          value={query} onChange={(event) => setQuery(event.target.value)} />
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {!data && !error && <p className="text-sm text-muted-foreground">{t('map.unmapped.loading')}</p>}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((item) => (
            <li key={item.pppoe} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: item.online ? LIVE_COLORS.online : LIVE_COLORS.offline }}
                title={t(item.online ? 'map.live.state.online' : 'map.live.state.offline')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm">{item.pppoe}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.deviceId}{item.rxPower !== null ? ` · RX ${item.rxPower} dBm` : ''}</span>
              </span>
              {canWrite && (
                <button type="button" className="modern-button-secondary min-h-10 shrink-0 px-3 text-sm sm:min-h-9" onClick={() => onPlace(item)}>
                  <Icon name="pin" size={15} />{t('map.unmapped.place')}
                </button>
              )}
            </li>
          ))}
          {data && !visible.length && <li className="py-8 text-center text-sm text-muted-foreground">{t('map.unmapped.empty')}</li>}
        </ul>
        {data && data.total > visible.length && !query && <p className="mt-2 text-xs text-muted-foreground">{t('map.unmapped.more', { shown: visible.length, total: data.total })}</p>}
      </div>
    </div>
  )
}
