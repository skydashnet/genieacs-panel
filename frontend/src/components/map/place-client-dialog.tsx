import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { LocationPicker } from '@/components/location-picker'
import { mappingAPI, type ClientLocation } from '@/lib/api'
import { MapAddressSearch } from '@/components/map-address-search'
import { allBoxOccupancy, type OccupancyEdge, type OccupancyNode } from '@/lib/box-occupancy'
import { haversineMeters, slugify } from '@/lib/kml-import'
import { nearestBoxes, SUGGEST_METERS } from '@/lib/nearest-box'

/**
 * "Colocar no mapa": cria o ponto do cliente (ONT) já com o PPPoE e, se o
 * técnico escolher a caixa, o cabo drop até ela — é isso que liga o cliente
 * ao estado ao vivo, às portas da caixa e ao alerta de rompimento.
 *
 * As caixas vêm ordenadas pela distância ao ponto marcado, com as portas
 * livres de cada uma, para a escolha ser a da caixa certa e não a primeira
 * da lista.
 */
export interface PlaceClientTarget {
  pppoe: string
  name?: string
  /** Onde o mapa do diálogo abre. */
  center?: [number, number]
  /** O equipamento, para achar o contrato pelo vínculo do SGP quando o login não basta. */
  deviceId?: string | null
}

const uniqueId = (base: string, taken: Set<string>) => {
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
  return id
}

export function PlaceClientDialog<T extends OccupancyNode>({
  target, nodes, edgeIds, edges, center, onClose, onDone
}: {
  target: PlaceClientTarget
  nodes: T[]
  edgeIds: string[]
  edges: OccupancyEdge[]
  center: [number, number]
  onClose: () => void
  onDone: (nodeId: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(target.name || target.pppoe)
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null)
  const [boxId, setBoxId] = useState('')
  // Enquanto o técnico não escolhe, vale a sugestão: a caixa livre mais próxima.
  const [boxTouched, setBoxTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // O endereço do cliente no SGP: o marcador já abre na casa dele quando dá.
  const [location, setLocation] = useState<ClientLocation | null>(null)
  const [locating, setLocating] = useState(true)
  useEffect(() => {
    let cancelled = false
    void mappingAPI.clientLocation(target.pppoe, target.deviceId)
      .then((response) => {
        if (cancelled || !response.success || !response.data) return
        const found = response.data
        setLocation(found)
        if (typeof found.lat === 'number' && typeof found.lng === 'number') {
          setPoint((current) => current ?? { lat: found.lat as number, lng: found.lng as number })
        }
        if (found.clientName) setName((current) => (current === target.pppoe ? found.clientName as string : current))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLocating(false) })
    return () => { cancelled = true }
  }, [target.pppoe, target.deviceId])
  const precisionKey = location?.precision === 'sgp' ? 'map.place.fromSgp'
    : location?.precision === 'address' ? 'map.place.fromAddress'
      : location?.precision === 'city' ? 'map.place.fromCity'
        : null

  const rows = useMemo(() => allBoxOccupancy(nodes, edges), [edges, nodes])
  const suggestion = useMemo(() => (point ? nearestBoxes(point, rows, { maxMeters: SUGGEST_METERS, limit: 1 })[0] ?? null : null), [point, rows])
  const selectedBoxId = boxTouched ? boxId : suggestion?.box.node_id ?? ''
  const boxes = useMemo(() => {
    return rows
      .map((row) => ({ ...row, distance: point ? Math.round(haversineMeters([point.lat, point.lng], [row.box.latitude, row.box.longitude])) : null }))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.box.name.localeCompare(b.box.name))
  }, [point, rows])

  const save = async () => {
    if (!point) { setError(t('map.place.needPoint')); return }
    setSaving(true)
    setError(null)
    try {
      const nodeId = uniqueId(slugify(target.pppoe, 'cliente'), new Set(nodes.map((node) => node.node_id)))
      const created = await mappingAPI.createNode({
        node_id: nodeId, type: 'ont', name: name.trim() || target.pppoe,
        latitude: point.lat, longitude: point.lng, pppoe: target.pppoe
      })
      if (!created.success) throw new Error(created.message || t('map.place.failed'))
      const box = boxes.find((row) => row.box.node_id === selectedBoxId)
      if (box) {
        const cable = await mappingAPI.createEdge({
          edge_id: uniqueId(`drop-${nodeId}`, new Set(edgeIds)),
          source: box.box.node_id, target: nodeId, fiber_type: 'drop',
          distance: box.distance ?? null
        })
        if (!cable.success) throw new Error(cable.message || t('map.place.failed'))
      }
      onDone(nodeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('map.place.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop z-2300 bg-black/65" role="dialog" aria-modal="true">
      <div className="modal-panel modern-card max-w-2xl p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="section-heading min-w-0 wrap-break-word">{t('map.place.title', { pppoe: target.pppoe })}</h2>
          <button type="button" onClick={onClose} className="icon-button shrink-0" aria-label={t('common.close')} disabled={saving}><Icon name="x" size={20} /></button>
        </div>
        <label className="field-label" htmlFor="place-name">{t('map.table.name')}</label>
        <input id="place-name" className="modern-input w-full" maxLength={255} value={name} onChange={(event) => setName(event.target.value)} />
        <p className="field-label mt-4">{t('map.place.where')}</p>
        <div className="mb-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3 text-sm" aria-live="polite">
          {locating ? (
            <p className="flex items-center gap-2 text-muted-foreground"><Icon name="refresh" size={15} className="animate-spin" />{t('map.place.locating')}</p>
          ) : (
            <>
              {location?.address
                ? <p><span className="font-semibold">{t('map.place.address')}</span> {location.address}</p>
                : <p className="text-muted-foreground">{t('map.place.noAddress')}</p>}
              {precisionKey && (
                <p className={`mt-1 flex items-center gap-1.5 text-xs ${location?.precision === 'sgp' ? 'text-emerald-600' : 'text-amber-600'}`}>
                  <Icon name={location?.precision === 'sgp' ? 'check' : 'warning'} size={13} />{t(precisionKey)}
                </p>
              )}
              {location?.precision !== 'sgp' && (
                <div className="mt-2">
                  <p className="mb-1 text-xs text-muted-foreground">{t('map.place.search')}</p>
                  <MapAddressSearch className="relative w-full" initialQuery={location?.address?.replace(/ · /g, ', ') ?? ''}
                    onPick={(place) => setPoint({ lat: place.lat, lng: place.lng })} />
                </div>
              )}
            </>
          )}
        </div>
        <LocationPicker lat={point?.lat ?? null} lng={point?.lng ?? null} fallback={center} fallbackZoom={16} onChange={(lat, lng) => setPoint({ lat, lng })} />
        <p className="field-hint">{point ? `${point.lat}, ${point.lng}` : t('map.place.clickHint')}</p>
        <label className="field-label mt-4" htmlFor="place-box">{t('map.place.box')}</label>
        <select id="place-box" className="modern-input w-full" value={selectedBoxId} onChange={(event) => { setBoxId(event.target.value); setBoxTouched(true) }}>
          <option value="">{t('map.place.noBox')}</option>
          {boxes.map((row) => (
            <option key={row.box.node_id} value={row.box.node_id} disabled={row.free === 0}>
              {row.box.name}
              {row.distance !== null ? ` · ${row.distance} m` : ''}
              {row.capacity !== null ? ` · ${t('map.place.freePorts', { free: row.free ?? 0, capacity: row.capacity })}` : ''}
            </option>
          ))}
        </select>
        {!boxTouched && suggestion
          ? <p className="field-hint text-emerald-700 dark:text-emerald-400">{t('map.place.suggested', { meters: suggestion.distance })}</p>
          : <p className="field-hint">{t('map.place.boxHint')}</p>}
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" onClick={() => void save()} disabled={saving || !point}>
            <Icon name="pin" size={17} />{saving ? t('common.saving') : t('map.place.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
