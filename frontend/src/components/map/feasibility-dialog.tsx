import { useMemo, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { LocationPicker } from '@/components/location-picker'
import { MapAddressSearch } from '@/components/map-address-search'
import { allBoxOccupancy, BOX_TYPES, type OccupancyEdge, type OccupancyNode } from '@/lib/box-occupancy'
import { DROP_LIMITS, FEASIBILITY_DEFAULT_METERS, feasibility, type Point } from '@/lib/nearest-box'

/**
 * Consulta de viabilidade, para quem vende: o endereço do interessado (ou um
 * clique no mapa) e a resposta — a CTO livre mais próxima, a que distância,
 * e se cabe no limite do drop.
 */
const VERDICT_STYLE = {
  viable: { icon: 'check', color: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-500/50 bg-emerald-500/10' },
  tooFar: { icon: 'warning', color: 'text-amber-700 dark:text-amber-400', border: 'border-amber-500/50 bg-amber-500/10' },
  noBox: { icon: 'x', color: 'text-destructive', border: 'border-destructive/50 bg-destructive/10' }
} as const

export function FeasibilityDialog<T extends OccupancyNode>({ nodes, edges, center, onClose, onShowBox }: {
  nodes: T[]
  edges: OccupancyEdge[]
  center: [number, number]
  onClose: () => void
  onShowBox: (nodeId: string) => void
}) {
  const { t } = useTranslation()
  const [point, setPoint] = useState<Point | null>(null)
  const [maxMeters, setMaxMeters] = useState<number>(FEASIBILITY_DEFAULT_METERS)
  const rows = useMemo(() => allBoxOccupancy(nodes, edges), [edges, nodes])
  // O mapa da consulta abre no meio das caixas, não no centro salvo do mapa.
  const start = useMemo<[number, number]>(() => {
    const boxes = nodes.filter((node) => BOX_TYPES.has(node.type))
    if (!boxes.length) return center
    return [
      boxes.reduce((sum, node) => sum + node.latitude, 0) / boxes.length,
      boxes.reduce((sum, node) => sum + node.longitude, 0) / boxes.length
    ]
  }, [center, nodes])
  const result = useMemo(() => (point ? feasibility(point, rows, maxMeters) : null), [maxMeters, point, rows])
  const nearest = result?.boxes[0]
  const style = result ? VERDICT_STYLE[result.verdict] : null
  const freeText = (free: number | null) => (free === null ? t('map.feasibility.unknownPorts') : t('map.feasibility.freePorts', { count: free }))

  return (
    <div className="modal-backdrop z-2300 bg-black/65" role="dialog" aria-modal="true">
      <div className="modal-panel modern-card max-w-2xl p-5 sm:p-6">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="section-heading">{t('map.feasibility.title')}</h2>
          <button type="button" onClick={onClose} className="icon-button" aria-label={t('common.close')}><Icon name="x" size={20} /></button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">{t('map.feasibility.hint')}</p>
        <MapAddressSearch className="relative mb-3 w-full" onPick={(place) => setPoint({ lat: place.lat, lng: place.lng })} />
        <LocationPicker lat={point?.lat ?? null} lng={point?.lng ?? null} fallback={start} fallbackZoom={16} onChange={(lat, lng) => setPoint({ lat, lng })} />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="feasibility-limit" className="font-semibold">{t('map.feasibility.limit')}</label>
          <select id="feasibility-limit" className="modern-input w-auto" value={maxMeters} onChange={(event) => setMaxMeters(Number(event.target.value))}>
            {DROP_LIMITS.map((meters) => <option key={meters} value={meters}>{t('map.link.meters', { meters })}</option>)}
          </select>
        </div>
        <div className="mt-4" aria-live="polite">
          {!result && <p className="text-sm text-muted-foreground">{t('map.feasibility.pick')}</p>}
          {result && style && (
            <>
              <p className={`flex items-center gap-2 rounded-md border p-3 font-semibold ${style.border} ${style.color}`}>
                <Icon name={style.icon} size={18} />
                {result.verdict === 'noBox'
                  ? t('map.feasibility.noBox')
                  : t(result.verdict === 'viable' ? 'map.feasibility.viable' : 'map.feasibility.tooFar', {
                    box: nearest?.box.name ?? '', meters: nearest?.distance ?? 0, ports: freeText(nearest?.free ?? null)
                  })}
              </p>
              {result.boxes.length > 0 && (
                <ul className="mt-3 divide-y divide-border rounded-md border border-border">
                  {result.boxes.map((entry) => (
                    <li key={entry.box.node_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{entry.box.name}</span>
                        <span className="block text-xs text-muted-foreground">{t('map.link.meters', { meters: entry.distance })} · {freeText(entry.free)}</span>
                      </span>
                      <button type="button" className="shrink-0 text-sm font-semibold text-primary hover:underline" onClick={() => onShowBox(entry.box.node_id)}>
                        {t('map.outage.show')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">{t('map.feasibility.straightLine')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
