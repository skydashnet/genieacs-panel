'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useTheme } from '@/contexts/theme-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { mappingAPI, mapSettingsAPI, subscriptionAPI } from '@/lib/api'
import { useTenant } from '@/contexts/tenant-context'
import { DEFAULT_MAP_CENTER, isDefaultCenter } from '@/lib/provider-location'
import { Icon } from '@/components/ui/icon'
import { getTileSpec, type Basemap } from '@/lib/map-tiles'
import { useToast } from '@/components/ui/toast'
import { MapAddressSearch } from '@/components/map-address-search'
import type { PlaceResult } from '@/lib/api'
import {
  buildImportPlan, chunkImportPlan, parseKml, readKmlFile, type ParsedKml
} from '@/lib/kml-import'
import { buildKml, kmlFileName } from '@/lib/kml-export'
import { LIVE_COLORS, LIVE_REFRESH_MS, LIVE_STATES, liveLabelKey, type LiveItem, type LiveOutage, type LiveStatus } from '@/lib/map-status'
import { Link, useSearchParams } from 'react-router'
import { BoxOccupancyView } from '@/components/map/box-occupancy-view'
import { OutageHistoryView } from '@/components/map/outage-history-view'
import { PlaceClientDialog, type PlaceClientTarget } from '@/components/map/place-client-dialog'
import { UnmappedDialog } from '@/components/map/unmapped-dialog'
import { BulkPlaceDialog } from '@/components/map/bulk-place-dialog'
import { BulkLinkDialog } from '@/components/map/bulk-link-dialog'
import { FeasibilityDialog } from '@/components/map/feasibility-dialog'
import { weakBoxes } from '@/lib/nearest-box'
import { BOX_TYPES, NEARBY_METERS, boxOccupancy, capacityOf } from '@/lib/box-occupancy'
import 'leaflet/dist/leaflet.css'
import { MaintenanceForm } from '@/components/maintenance/maintenance-panel'

// Start fetching the map engine as soon as this route chunk is evaluated. The
// topology request and Leaflet download can then run in parallel.
const leafletModulePromise = import('leaflet')

type NodeType = 'htb' | 'olt' | 'odc' | 'odp' | 'ont' | 'server'
type FiberType = 'backbone' | 'feeder' | 'distribution' | 'drop' | 'patch'

interface MapNode {
  id: number
  node_id: string
  type: NodeType
  name: string
  latitude: number
  longitude: number
  capacity?: number | null
  splitter?: string | null
  pppoe?: string | null
  notes?: string | null
}

interface MapEdge {
  id: number
  edge_id: string
  source: string
  target: string
  fiber_type: FiberType
  distance?: number | null
  waypoints?: [number, number][] | null
  notes?: string | null
}

type NodeForm = Omit<MapNode, 'id'>
type EdgeForm = Omit<MapEdge, 'id'>

const NODE_TYPES: { value: NodeType; labelKey: TranslationKey }[] = [
  { value: 'htb', labelKey: 'map.nodeType.htb' },
  { value: 'olt', labelKey: 'map.nodeType.olt' },
  { value: 'odc', labelKey: 'map.nodeType.odc' },
  { value: 'odp', labelKey: 'map.nodeType.odp' },
  { value: 'ont', labelKey: 'map.nodeType.ont' },
  { value: 'server', labelKey: 'map.nodeType.server' },
]

const FIBER_TYPES: { value: FiberType; labelKey: TranslationKey; color: string }[] = [
  { value: 'backbone', labelKey: 'map.fiberType.backbone', color: '#8b5cf6' },
  { value: 'feeder', labelKey: 'map.fiberType.feeder', color: '#0ea5e9' },
  { value: 'distribution', labelKey: 'map.fiberType.distribution', color: '#22c55e' },
  { value: 'drop', labelKey: 'map.fiberType.drop', color: '#f59e0b' },
  { value: 'patch', labelKey: 'map.fiberType.patch', color: '#94a3b8' },
]

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function getTypeLabelKey(type: NodeType) {
  return NODE_TYPES.find((entry) => entry.value === type)?.labelKey
}

function getFiberMeta(type: FiberType) {
  return FIBER_TYPES.find((entry) => entry.value === type) || FIBER_TYPES[2]
}

function getNodeSvg(type: NodeType) {
  const paths: Record<NodeType, string> = {
    htb: '<path d="M5 20V8l7-4 7 4v12"/><path d="M8 20v-6h8v6"/><path d="M9 9h6"/>',
    olt: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h4M15 13h2"/><circle cx="7" cy="16" r=".5"/>',
    odc: '<path d="M6 22V4a1 1 0 011-1h10a1 1 0 011 1v18"/><path d="M10 7h.01M14 7h.01M10 11h.01M14 11h.01"/>',
    odp: '<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4"/><path d="M12 11v10"/>',
    ont: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 001 1h14a1 1 0 001-1V10"/><path d="M9 17h6"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/>',
  }
  return paths[type]
}

function nodeIconName(type: NodeType) {
  if (type === 'server' || type === 'olt') return 'server'
  if (type === 'odc' || type === 'htb') return 'building'
  if (type === 'odp') return 'box'
  return 'home'
}

/** Os nós que agrupam clientes: só neles cabe uma manutenção programada. */
const MAINTENANCE_NODE_TYPES = new Set(['olt', 'odc', 'odp', 'htb'])

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="modal-backdrop z-2200 bg-black/65" role="dialog" aria-modal="true">
      <div className="modal-panel modern-card max-w-2xl p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="section-heading min-w-0 wrap-break-word">{title}</h2>
          <button type="button" onClick={onClose} className="icon-button" aria-label={t('common.close')}>
            <Icon name="x" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const KML_ERRORS = ['kml_invalid', 'kmz_invalid', 'kmz_no_kml', 'kmz_unsupported'] as const
const MAX_KML_BYTES = 50 * 1024 * 1024

/**
 * Importar KML/KMZ: o arquivo é lido aqui mesmo, a prévia diz o que vai entrar
 * e só então os pontos e cabos vão ao servidor, em lotes. Acrescenta; nada do
 * que já está no mapa é apagado ou alterado.
 */
function ImportDialog({
  nodes, edges, onClose, onDone
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedKml | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [defaultType, setDefaultType] = useState<NodeType>('odp')
  const [fiberType, setFiberType] = useState<FiberType>('distribution')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const plan = useMemo(() => parsed && buildImportPlan(parsed, {
    defaultType,
    fiberType,
    existingNodes: nodes,
    existingEdgeIds: edges.map((edge) => edge.edge_id),
    endpointName: (name, end) => t(end === 'start' ? 'map.import.endpointStart' : 'map.import.endpointEnd', { name })
  }), [defaultType, edges, fiberType, nodes, parsed, t])

  const pick = async (file: File | undefined) => {
    setParsed(null)
    setError(null)
    if (!file) return
    setFileName(file.name)
    if (file.size > MAX_KML_BYTES) {
      setError(t('map.import.tooBig'))
      return
    }
    setReading(true)
    try {
      setParsed(parseKml(await readKmlFile(file)))
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      setError(t((KML_ERRORS as readonly string[]).includes(code) ? `map.import.error.${code}` as TranslationKey : 'map.import.error.kml_invalid'))
    } finally {
      setReading(false)
    }
  }

  const submit = async () => {
    if (!plan) return
    const batches = chunkImportPlan(plan)
    const total = { nodes: 0, edges: 0, skipped: 0, errors: 0 }
    setProgress({ done: 0, total: batches.length })
    try {
      for (const [index, batch] of batches.entries()) {
        const response = await mappingAPI.importData(batch)
        if (!response.success || !response.data) throw new Error(response.message || t('map.import.failed'))
        total.nodes += response.data.createdNodes
        total.edges += response.data.createdEdges
        total.skipped += response.data.skippedNodes + response.data.skippedEdges
        total.errors += response.data.errors.length
        setProgress({ done: index + 1, total: batches.length })
      }
      toast.success(t('map.import.done', { nodes: total.nodes, edges: total.edges }))
      if (total.skipped) toast.info(t('map.import.doneSkipped', { count: total.skipped }))
      if (total.errors) toast.error(t('map.import.doneErrors', { count: total.errors }))
      onDone()
    } catch (err) {
      // Lotes já gravados ficam: a importação só acrescenta, e repetir o
      // arquivo pula o que já entrou.
      toast.error(err instanceof Error ? err.message : t('map.import.failed'))
      if (total.nodes || total.edges) onDone()
      else setProgress(null)
    }
  }

  const busy = reading || progress !== null
  const empty = parsed && !parsed.points.length && !parsed.lines.length

  return (
    <ModalShell title={t('map.import.title')} onClose={busy ? () => undefined : onClose}>
      <p className="mb-4 text-sm leading-6 text-muted-foreground">{t('map.import.description')}</p>
      <label className="field-label" htmlFor="kml-file">{t('map.import.file')}</label>
      <input id="kml-file" type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
        className="modern-input w-full" disabled={busy} onChange={(event) => void pick(event.target.files?.[0])} />
      {reading && <p className="mt-3 text-sm text-muted-foreground">{t('map.import.reading')}</p>}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {empty && <p className="mt-3 text-sm text-muted-foreground">{t('map.import.empty')}</p>}

      {plan && parsed && !empty && (
        <div className="mt-5 space-y-4">
          <p className="break-all font-semibold">{fileName} · {t('map.import.summary', { points: parsed.points.length, cables: parsed.lines.length })}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label" htmlFor="kml-node-type">{t('map.import.defaultType')}</label>
              <select id="kml-node-type" className="modern-input w-full" value={defaultType} disabled={busy}
                onChange={(event) => setDefaultType(event.target.value as NodeType)}>
                {NODE_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.labelKey)}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="kml-fiber-type">{t('map.import.fiberType')}</label>
              <select id="kml-fiber-type" className="modern-input w-full" value={fiberType} disabled={busy}
                onChange={(event) => setFiberType(event.target.value as FiberType)}>
                {FIBER_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.labelKey)}</option>)}
              </select>
            </div>
          </div>
          <p className="field-hint">{t('map.import.typeHint')}</p>
          <ul className="space-y-1 text-sm">
            {plan.snappedEnds > 0 && <li className="flex gap-2"><Icon name="check" size={16} className="mt-0.5 shrink-0 text-emerald-500" />{t('map.import.snapped', { count: plan.snappedEnds })}</li>}
            {plan.endpointNodes > 0 && <li className="flex gap-2"><Icon name="info" size={16} className="mt-0.5 shrink-0" />{t('map.import.endpoints', { count: plan.endpointNodes })}</li>}
            {plan.outsideBrazil > 0 && <li className="flex gap-2"><Icon name="warning" size={16} className="mt-0.5 shrink-0 text-amber-500" />{t('map.import.outside', { count: plan.outsideBrazil })}</li>}
            {parsed.ignored > 0 && <li className="flex gap-2"><Icon name="info" size={16} className="mt-0.5 shrink-0" />{t('map.import.ignored', { count: parsed.ignored })}</li>}
          </ul>
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            {([['map.import.previewNodes', plan.nodes.map((node) => `${node.name} · ${t(getTypeLabelKey(node.type) ?? 'map.nodeType.odp')}`)],
              ['map.import.previewCables', plan.edges.map((edge) => `${edge.edge_id}${edge.distance ? ` · ${edge.distance} m` : ''}`)]] as const).map(([label, items]) => (
              <div key={label} className="rounded-md border border-border p-3">
                <p className="metric-label">{t(label)} ({items.length})</p>
                <ul className="mt-2 space-y-1">
                  {items.slice(0, 6).map((item, index) => <li key={index} className="truncate" title={item}>{item}</li>)}
                  {items.length > 6 && <li className="text-muted-foreground">{t('map.import.more', { count: items.length - 6 })}</li>}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button type="button" className="modern-button" disabled={busy || !plan || Boolean(empty)} onClick={() => void submit()}>
          <Icon name={progress ? 'refresh' : 'check'} size={17} className={progress ? 'animate-spin' : ''} />
          {progress ? t('map.import.progress', { done: progress.done, total: progress.total }) : t('map.import.submit')}
        </button>
      </div>
    </ModalShell>
  )
}

/**
 * O miolo do detalhe de uma caixa: portas usadas e livres, os clientes
 * ligados por cabo (com o estado ao vivo, quando há) e os clientes próximos
 * que ainda não têm cabo desenhado.
 */
function BoxClients({
  box, nodes, edges, live, onSelect
}: {
  box: MapNode
  nodes: MapNode[]
  edges: MapEdge[]
  live: Map<string, LiveItem>
  onSelect: (node: MapNode) => void
}) {
  const { t } = useTranslation()
  const occupancy = useMemo(() => boxOccupancy(box, nodes, edges), [box, edges, nodes])
  const percent = occupancy.capacity ? Math.min(100, Math.round((occupancy.used / occupancy.capacity) * 100)) : 0
  const row = (node: MapNode, extra?: string) => {
    const state = live.get(node.node_id)
    return (
      <li key={node.node_id}>
        <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted sm:min-h-0" onClick={() => onSelect(node)}>
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: state ? LIVE_COLORS[state.state] : 'transparent', border: state ? 'none' : '1px solid hsl(var(--border))' }}
            title={state ? t(liveLabelKey(state.state)) : undefined} />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.pppoe && <span className="min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground">{node.pppoe}</span>}
          {extra && <span className="shrink-0 text-xs text-muted-foreground">{extra}</span>}
        </button>
      </li>
    )
  }
  return (
    <div className="mt-5 space-y-4 border-t border-border pt-4">
      <div>
        <p className="metric-label">{t('map.box.ports')}</p>
        {occupancy.capacity === null ? (
          <p className="mt-1 text-sm">{t('map.box.noCapacity', { used: occupancy.used })}</p>
        ) : (
          <>
            <p className={`mt-1 text-sm font-semibold ${occupancy.over ? 'text-[hsl(var(--status-danger))]' : ''}`}>
              {t(occupancy.over ? 'map.box.over' : 'map.box.usage', { used: occupancy.used, capacity: occupancy.capacity, free: occupancy.free ?? 0 })}
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={occupancy.used} aria-valuemin={0} aria-valuemax={occupancy.capacity}>
              <div className="h-full rounded" style={{ width: `${percent}%`, background: occupancy.over ? LIVE_COLORS.offline : percent >= 85 ? LIVE_COLORS.weak : LIVE_COLORS.online }} />
            </div>
          </>
        )}
      </div>
      <div>
        <p className="metric-label">{t('map.box.clients', { count: occupancy.clients.length })}</p>
        {occupancy.clients.length
          ? <ul className="mt-1 max-h-56 overflow-y-auto">{occupancy.clients.map((node) => row(node))}</ul>
          : <p className="mt-1 text-sm text-muted-foreground">{t('map.box.noClients')}</p>}
      </div>
      {occupancy.nearby.length > 0 && (
        <div>
          <p className="metric-label">{t('map.box.nearby', { meters: NEARBY_METERS })}</p>
          <ul className="mt-1 max-h-40 overflow-y-auto">{occupancy.nearby.map((entry) => row(entry.node, `${entry.distance} m`))}</ul>
        </div>
      )}
    </div>
  )
}

function NodeEditor({
  initial, editing, saving, onClose, onSave
}: {
  initial: NodeForm
  editing: boolean
  saving: boolean
  onClose: () => void
  onSave: (value: NodeForm) => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState(initial)
  const set = <K extends keyof NodeForm>(key: K, value: NodeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  return (
    <ModalShell title={editing ? t('map.editor.editEntry', { id: initial.node_id }) : t('map.editor.addNode')} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); onSave(form) }} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold">
            {t('map.node.id')}
            <input className="modern-input w-full font-mono" required maxLength={128}
              pattern="[A-Za-z0-9._:-]+" disabled={editing} value={form.node_id}
              onChange={(event) => set('node_id', event.target.value)} placeholder={t('map.node.idPlaceholder')} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.table.type')}
            <select className="modern-input w-full" value={form.type}
              onChange={(event) => set('type', event.target.value as NodeType)}>
              {NODE_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.labelKey)}</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            {t('map.node.name')}
            <input className="modern-input w-full" required maxLength={255} value={form.name}
              onChange={(event) => set('name', event.target.value)} placeholder={t('map.node.namePlaceholder')} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.node.latitude')}
            <input className="modern-input w-full font-mono" required type="number" min={-90} max={90} step="any"
              value={form.latitude} onChange={(event) => set('latitude', Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.node.longitude')}
            <input className="modern-input w-full font-mono" required type="number" min={-180} max={180} step="any"
              value={form.longitude} onChange={(event) => set('longitude', Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.node.capacity')}
            <input className="modern-input w-full" type="number" min={0} step={1}
              value={form.capacity ?? ''} onChange={(event) => set('capacity', event.target.value === '' ? null : Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.node.splitter')}
            <input className="modern-input w-full" maxLength={64} value={form.splitter ?? ''}
              onChange={(event) => set('splitter', event.target.value)} placeholder="1:8" />
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            {t('map.node.pppoe')}
            <input className="modern-input w-full" maxLength={255} value={form.pppoe ?? ''}
              onChange={(event) => set('pppoe', event.target.value)} />
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            {t('map.node.notes')}
            <textarea className="modern-input min-h-24 w-full" maxLength={5000} value={form.notes ?? ''}
              onChange={(event) => set('notes', event.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="modern-button" disabled={saving}>
            <Icon name={saving ? 'refresh' : 'check'} size={17} className={saving ? 'animate-spin' : ''} />
            {saving ? t('common.saving') : t('map.editor.saveNode')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function EdgeEditor({
  initial, nodes, editing, saving, onClose, onSave
}: {
  initial: EdgeForm
  nodes: MapNode[]
  editing: boolean
  saving: boolean
  onClose: () => void
  onSave: (value: EdgeForm) => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState(initial)
  const set = <K extends keyof EdgeForm>(key: K, value: EdgeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  return (
    <ModalShell title={editing ? t('map.editor.editEntry', { id: initial.edge_id }) : t('map.editor.drawCable')} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); onSave(form) }} className="space-y-5">
        {nodes.length < 2 && (
          <div className="rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-3 text-sm">
            {t('map.edge.needTwoNodes')}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            {t('map.edge.id')}
            <input className="modern-input w-full font-mono" required maxLength={128}
              pattern="[A-Za-z0-9._:-]+" disabled={editing} value={form.edge_id}
              onChange={(event) => set('edge_id', event.target.value)} placeholder={t('map.edge.idPlaceholder')} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.edge.source')}
            <select className="modern-input w-full" required value={form.source}
              onChange={(event) => set('source', event.target.value)}>
              <option value="">{t('map.edge.selectSource')}</option>
              {nodes.map((node) => <option key={node.node_id} value={node.node_id}>{node.name} ({node.node_id})</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.edge.target')}
            <select className="modern-input w-full" required value={form.target}
              onChange={(event) => set('target', event.target.value)}>
              <option value="">{t('map.edge.selectTarget')}</option>
              {nodes.map((node) => <option key={node.node_id} value={node.node_id}>{node.name} ({node.node_id})</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.edge.fiberType')}
            <select className="modern-input w-full" value={form.fiber_type}
              onChange={(event) => set('fiber_type', event.target.value as FiberType)}>
              {FIBER_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.labelKey)}</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            {t('map.edge.distance')}
            <input className="modern-input w-full" type="number" min={0} step="any"
              value={form.distance ?? ''} onChange={(event) => set('distance', event.target.value === '' ? null : Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            {t('map.node.notes')}
            <textarea className="modern-input min-h-24 w-full" maxLength={5000} value={form.notes ?? ''}
              onChange={(event) => set('notes', event.target.value)} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('map.edge.autoDrawHint')}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="modern-button" disabled={saving || nodes.length < 2 || form.source === form.target}>
            <Icon name={saving ? 'refresh' : 'check'} size={17} className={saving ? 'animate-spin' : ''} />
            {saving ? t('common.saving') : t('map.editor.saveCable')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

export default function NetworkMap() {
  const [nodes, setNodes] = useState<MapNode[]>([])
  const [edges, setEdges] = useState<MapEdge[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selectedNode, setSelectedNode] = useState<MapNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<MapEdge | null>(null)
  const [nodeEditor, setNodeEditor] = useState<NodeForm | null>(null)
  const [edgeEditor, setEdgeEditor] = useState<EdgeForm | null>(null)
  const [editingNode, setEditingNode] = useState(false)
  const [editingEdge, setEditingEdge] = useState(false)
  const [mapView, setMapView] = useState<'map' | 'list' | 'boxes' | 'outages'>('map')
  const [unmappedOpen, setUnmappedOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [feasibilityOpen, setFeasibilityOpen] = useState(false)
  const [weakExpanded, setWeakExpanded] = useState(false)
  const [placeTarget, setPlaceTarget] = useState<PlaceClientTarget | null>(null)
  // `?place=<pppoe>` vem do botão "Colocar no mapa" da tela do equipamento.
  const [searchParams, setSearchParams] = useSearchParams()
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [mapCenter, setMapCenter] = useState<[number, number]>(DEFAULT_MAP_CENTER)
  // A sede do provedor: o centro salvo, quando alguém o escolheu (não é o
  // padrão de Brasília). `address` só com `settings.read`, que é quem lê o cadastro.
  const [headquarters, setHeadquarters] = useState<{ lat: number; lng: number; address: string } | null>(null)
  const { name: tenantName, tenant } = useTenant()
  const canReadBilling = useAuth().can('settings.read')
  const [defaultZoom, setDefaultZoom] = useState(12)
  const [minZoom, setMinZoom] = useState(5)
  const [maxZoom, setMaxZoom] = useState(18)
  const [basemap, setBasemap] = useState<Basemap>('osm')
  /** O lugar achado pela busca, marcado no mapa até ser fechado. */
  const [foundPlace, setFoundPlace] = useState<PlaceResult | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  /** Estado ao vivo dos pontos com PPPoE, por `node_id`. */
  const [live, setLive] = useState<LiveStatus | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const searchMarkerRef = useRef<any>(null)
  const { isDarkMode } = useTheme()
  const { can, user } = useAuth()
  // O slug da sessão, não o do `TenantProvider`: no host compartilhado aquele
  // é o do primeiro provedor, e o arquivo sairia com o nome de outro.
  const providerSlug = user?.tenant?.slug || tenant?.slug
  const { t, formatTime } = useTranslation()
  const toast = useToast()
  // A tela abre com `map.read`, que o `viewer` tem; desenhar e apagar é
  // `map.write`, que a matriz dá ao plantão. Era `role === 'admin'`, o que
  // trancava o mapa para quem sobe em poste.
  const canEditMap = can('map.write')
  // Agendar manutenção manda mensagem ao assinante: é de quem manda mensagem.
  const canScheduleMaintenance = can('whatsapp.send')
  const [maintenanceNode, setMaintenanceNode] = useState<MapNode | null>(null)

  const nodeTypeLabel = useCallback(
    (type: NodeType) => {
      const labelKey = getTypeLabelKey(type)
      return labelKey ? t(labelKey) : type.toUpperCase()
    },
    [t],
  )

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markersLayerRef = useRef<any>(null)
  const cablesLayerRef = useRef<any>(null)
  const tileLayerRef = useRef<any>(null)
  const leafletRef = useRef<any>(null)
  const hasCenteredAssetsRef = useRef(false)

  const normalizeNodes = (data: unknown): MapNode[] =>
    (Array.isArray(data) ? data : []).map((raw: any) => ({
      id: Number(raw.id),
      node_id: String(raw.node_id),
      type: raw.type as NodeType,
      name: String(raw.name),
      latitude: Number(raw.latitude),
      longitude: Number(raw.longitude),
      capacity: raw.capacity === null ? null : Number(raw.capacity),
      splitter: raw.splitter || null,
      pppoe: raw.pppoe || null,
      notes: raw.notes || null,
    })).filter((node) => Number.isFinite(node.latitude) && Number.isFinite(node.longitude))

  const normalizeEdges = (data: unknown): MapEdge[] =>
    (Array.isArray(data) ? data : []).map((raw: any) => ({
      id: Number(raw.id),
      edge_id: String(raw.edge_id),
      source: String(raw.source),
      target: String(raw.target),
      fiber_type: raw.fiber_type as FiberType,
      distance: raw.distance === null ? null : Number(raw.distance),
      waypoints: Array.isArray(raw.waypoints) ? raw.waypoints : null,
      notes: raw.notes || null,
    }))

  const loadData = useCallback(async (withSettings = true) => {
    try {
      setLoading(true)
      const requests: Promise<any>[] = [mappingAPI.getNodes(), mappingAPI.getEdges()]
      if (withSettings) requests.push(mapSettingsAPI.get())
      const [nodesRes, edgesRes, settingsRes] = await Promise.all(requests)
      if (!nodesRes.success || !edgesRes.success) throw new Error(t('map.toast.topologyLoadFailed'))
      setNodes(normalizeNodes(nodesRes.data))
      setEdges(normalizeEdges(edgesRes.data))
      const settings = settingsRes?.data as any
      if (settings) {
        const center: [number, number] = [Number(settings.center_lat), Number(settings.center_lng)]
        if (center.every(Number.isFinite)) {
          setMapCenter(center)
          if (!isDefaultCenter(center[0], center[1])) {
            let address = ''
            if (canReadBilling) {
              const sub = await subscriptionAPI.current()
              const b = sub.success ? sub.data?.billing : null
              if (b) {
                const street = [b.addressLine, b.addressNumber].filter(Boolean).join(', ')
                const place = [b.city, b.state].filter(Boolean).join(' - ')
                address = [street, b.district, place].filter(Boolean).join(' · ')
              }
            }
            setHeadquarters({ lat: center[0], lng: center[1], address })
          } else {
            setHeadquarters(null)
          }
        }
        if (Number.isFinite(Number(settings.default_zoom))) setDefaultZoom(Number(settings.default_zoom))
        if (Number.isFinite(Number(settings.max_zoom_out))) setMinZoom(Number(settings.max_zoom_out))
        if (Number.isFinite(Number(settings.max_zoom_in))) setMaxZoom(Number(settings.max_zoom_in))
      }
      setLastRefresh(new Date())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('map.toast.topologyLoadError'))
    } finally {
      setLoading(false)
    }
  }, [canReadBilling, t, toast])

  useEffect(() => { void loadData() }, [loadData])
  useEffect(() => {
    const saved = localStorage.getItem('networkMapBasemap')
    if (saved === 'osm' || saved === 'google') setBasemap(saved)
  }, [])
  useEffect(() => () => {
    mapRef.current?.remove()
    mapRef.current = null
    markersLayerRef.current = null
    cablesLayerRef.current = null
    tileLayerRef.current = null
  }, [])

  const updateTileLayer = useCallback(() => {
    const L = leafletRef.current
    const map = mapRef.current
    if (!L || !map) return
    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current)
    const { url, ...options } = getTileSpec(basemap, isDarkMode)
    tileLayerRef.current = L.tileLayer(url, options).addTo(map)
  }, [basemap, isDarkMode])

  const liveByNode = useMemo(() => new Map((live?.items ?? []).map((item) => [item.node_id, item])), [live])
  const outageByBox = useMemo(() => new Map((live?.outages ?? []).map((outage) => [outage.node_id, outage])), [live])
  // Caixas com vários clientes de sinal fraco: costuma ser a caixa, não a casa.
  const weak = useMemo(() => weakBoxes(nodes, edges, liveByNode), [edges, liveByNode, nodes])
  // A lista de logins é o que decide se vale perguntar ao ACS: mudar só a
  // posição de um ponto não pede releitura.
  const pppoeKey = useMemo(() => nodes.filter((node) => node.pppoe).map((node) => `${node.node_id}=${node.pppoe}`).sort().join('|'), [nodes])
  const loadLive = useCallback(async () => {
    if (!pppoeKey) { setLive(null); setLiveError(null); return }
    try {
      const response = await mappingAPI.liveStatus()
      if (response.success && response.data) { setLive(response.data); setLiveError(null) }
      else setLiveError(response.message || t('map.live.failed'))
    } catch {
      setLiveError(t('map.live.failed'))
    }
  }, [pppoeKey, t])
  useEffect(() => {
    void loadLive()
    const timer = window.setInterval(() => void loadLive(), LIVE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loadLive])

  const liveText = useCallback((item: LiveItem) => [
    t(liveLabelKey(item.state)),
    item.rxPower !== null ? `RX ${item.rxPower} dBm` : null
  ].filter(Boolean).join(' · '), [t])

  const outageLine = useCallback((outage: LiveOutage) => t(outage.since ? 'map.outage.line' : 'map.outage.lineNoTime', {
    count: outage.count,
    total: outage.total,
    time: outage.since ? formatTime(new Date(outage.since)) : ''
  }), [formatTime, t])

  const focusBox = (nodeId: string) => {
    const node = nodes.find((item) => item.node_id === nodeId)
    if (!node) return
    setMapView('map')
    mapRef.current?.flyTo([node.latitude, node.longitude], Math.min(maxZoom, 17), { duration: 0.8 })
    setSelectedNode(node)
  }

  const updateMapObjects = useCallback(() => {
    const L = leafletRef.current
    const map = mapRef.current
    if (!L || !map) return
    markersLayerRef.current ||= L.layerGroup().addTo(map)
    cablesLayerRef.current ||= L.layerGroup().addTo(map)
    markersLayerRef.current.clearLayers()
    cablesLayerRef.current.clearLayers()

    const byId = new Map(nodes.map((node) => [node.node_id, node]))
    edges.forEach((edge) => {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (!source || !target) return
      const points: [number, number][] = [
        [source.latitude, source.longitude],
        ...(edge.waypoints || []),
        [target.latitude, target.longitude],
      ]
      const meta = getFiberMeta(edge.fiber_type)
      const line = L.polyline(points, {
        color: meta.color,
        weight: edge.fiber_type === 'backbone' ? 5 : 3,
        opacity: 0.9,
        dashArray: edge.fiber_type === 'drop' ? '7 7' : undefined,
      }).addTo(cablesLayerRef.current)
      line.bindTooltip(`<strong>${escapeHtml(edge.edge_id)}</strong><br>${escapeHtml(t(meta.labelKey))} · ${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}`)
      line.on('click', () => { setSelectedEdge(edge); setSelectedNode(null) })
    })

    // Clientes por caixa numa passada só pelos cabos: calcular a ocupação
    // caixa a caixa percorreria o mapa inteiro para cada uma.
    const clientsPerBox = new Map<string, Set<string>>()
    const link = (box: MapNode, client: MapNode) => {
      if (client.type !== 'ont' || !BOX_TYPES.has(box.type)) return
      const set = clientsPerBox.get(box.node_id) ?? new Set<string>()
      set.add(client.node_id)
      clientsPerBox.set(box.node_id, set)
    }
    edges.forEach((edge) => {
      const a = byId.get(edge.source)
      const b = byId.get(edge.target)
      if (!a || !b) return
      link(a, b)
      link(b, a)
    })

    nodes.forEach((node) => {
      const iconColor = isDarkMode ? '#f4f3ed' : '#173f35'
      const state = liveByNode.get(node.node_id)
      const outage = outageByBox.get(node.node_id)
      // O estado ao vivo é uma bolinha no canto e a borda na mesma cor.
      const border = state ? LIVE_COLORS[state.state] : (isDarkMode ? '#53615a' : '#bdc9c2')
      const dot = state ? `<span style="position:absolute;top:-4px;right:-4px;width:11px;height:11px;border-radius:50%;background:${LIVE_COLORS[state.state]};border:2px solid ${isDarkMode ? '#17211c' : '#fff'}"></span>` : ''
      // Caixa com provável rompimento: borda vermelha grossa e halo, para ser
      // a primeira coisa que o olho encontra no mapa.
      const halo = outage ? `0 0 0 5px ${LIVE_COLORS.offline}55,0 2px 6px rgba(0,0,0,.2)` : '0 2px 6px rgba(0,0,0,.2)'
      const html = `<div style="position:relative;width:28px;height:28px;padding:3px;border-radius:8px;background:${isDarkMode ? '#17211c' : '#fff'};border:${outage ? 3 : state ? 2 : 1}px solid ${outage ? LIVE_COLORS.offline : border};box-shadow:${halo}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${getNodeSvg(node.type)}</svg>${dot}</div>`
      const marker = L.marker([node.latitude, node.longitude], {
        icon: L.divIcon({ className: '', html, iconSize: [28, 28], iconAnchor: [14, 14] })
      }).addTo(markersLayerRef.current)
      const capacity = BOX_TYPES.has(node.type) ? capacityOf(node) : null
      const portsText = capacity !== null ? `<br>${escapeHtml(t('map.box.tooltip', { used: clientsPerBox.get(node.node_id)?.size ?? 0, capacity }))}` : ''
      const outageText = outage ? `<br><strong style="color:${LIVE_COLORS.offline}">${escapeHtml(outageLine(outage))}</strong>` : ''
      marker.bindTooltip(`<strong>${escapeHtml(node.name)}</strong><br>${escapeHtml(nodeTypeLabel(node.type))} · ${escapeHtml(node.node_id)}${state ? `<br>${escapeHtml(liveText(state))}` : ''}${portsText}${outageText}`)
      marker.on('click', () => { setSelectedNode(node); setSelectedEdge(null) })
    })
    // A sede por cima de tudo: é o ponto de referência de quem olha a rede.
    if (headquarters) {
      const html = `<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#10b981;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg></div>`
      const hq = L.marker([headquarters.lat, headquarters.lng], {
        icon: L.divIcon({ className: '', html, iconSize: [32, 32], iconAnchor: [16, 16] }),
        zIndexOffset: 1000,
        keyboard: false
      }).addTo(markersLayerRef.current)
      const title = `<strong>${escapeHtml(t('map.headquarters'))}</strong> · ${escapeHtml(tenantName)}`
      hq.bindTooltip(headquarters.address ? `${title}<br>${escapeHtml(headquarters.address)}` : title)
    }
    if (nodes.length && !hasCenteredAssetsRef.current) {
      const center = nodes.reduce(
        (total, node) => [total[0] + node.latitude, total[1] + node.longitude] as [number, number],
        [0, 0] as [number, number]
      )
      map.setView(
        [center[0] / nodes.length, center[1] / nodes.length],
        Math.min(maxZoom, Math.max(minZoom, 15))
      )
      hasCenteredAssetsRef.current = true
    }
  }, [edges, headquarters, isDarkMode, liveByNode, liveText, maxZoom, minZoom, nodeTypeLabel, nodes, outageByBox, outageLine, t, tenantName])

  useEffect(() => {
    if (mapView !== 'map') return
    let cancelled = false
    void (async () => {
      if (!leafletRef.current) {
        const module = await leafletModulePromise
        leafletRef.current = (module as any).default ?? module
      }
      if (cancelled || !mapContainerRef.current) return
      const L = leafletRef.current
      if (!mapRef.current) {
        mapRef.current = L.map(mapContainerRef.current, { center: mapCenter, zoom: defaultZoom, minZoom, maxZoom })
        markersLayerRef.current = L.layerGroup().addTo(mapRef.current)
        cablesLayerRef.current = L.layerGroup().addTo(mapRef.current)
        updateTileLayer()
      }
      mapRef.current.setMinZoom(minZoom)
      mapRef.current.setMaxZoom(maxZoom)
      if (!nodes.length) mapRef.current.setView(mapCenter, defaultZoom)
      updateMapObjects()
      window.setTimeout(() => mapRef.current?.invalidateSize(), 80)
    })()
    return () => { cancelled = true }
  }, [defaultZoom, mapCenter, mapView, maxZoom, minZoom, nodes.length, updateMapObjects, updateTileLayer])
  useEffect(() => { if (mapRef.current) updateTileLayer() }, [updateTileLayer])
  useEffect(() => { if (mapRef.current) updateMapObjects() }, [updateMapObjects])

  const openNewNode = (at?: { lat: number; lng: number }) => {
    const center = at ?? mapRef.current?.getCenter()?.wrap()
    setEditingNode(false)
    setNodeEditor({
      node_id: '', type: 'odp', name: '',
      latitude: Number(center?.lat ?? mapCenter[0]),
      longitude: Number(center?.lng ?? mapCenter[1]),
      capacity: null, splitter: '', pppoe: '', notes: ''
    })
  }
  // O marcador da busca fica fora das camadas de pontos e cabos, que são
  // redesenhadas a cada recarga: ele some só quando o operador fecha.
  useEffect(() => {
    const L = leafletRef.current
    const map = mapRef.current
    searchMarkerRef.current?.remove()
    searchMarkerRef.current = null
    if (!L || !map || !foundPlace) return
    const html = '<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>'
    searchMarkerRef.current = L.marker([foundPlace.lat, foundPlace.lng], {
      icon: L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 26] }),
      zIndexOffset: 2000,
      keyboard: false
    }).addTo(map)
    searchMarkerRef.current.bindTooltip(escapeHtml(foundPlace.label))
    map.flyTo([foundPlace.lat, foundPlace.lng], Math.min(maxZoom, 17), { duration: 0.8 })
  }, [foundPlace, maxZoom])

  // O arquivo é montado aqui mesmo, a partir do que a tela já carregou.
  const exportKml = () => {
    const kml = buildKml(nodes, edges, {
      document: `${tenantName} · ${t('map.title')}`,
      nodeType: (type) => nodeTypeLabel(type as NodeType),
      fiberType: (type) => t(getFiberMeta(type as FiberType).labelKey)
    })
    const url = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = kmlFileName(providerSlug || tenantName)
    link.click()
    URL.revokeObjectURL(url)
  }

  // O diálogo abre onde o mapa está olhando agora — lido no clique, não no render.
  const openPlace = (pppoe: string, name?: string, deviceId?: string | null) => {
    // Com o mapa escondido (outra aba), o centro dele pode ser qualquer coisa;
    // o centro dos pontos da rede é uma aposta melhor.
    const current = mapView === 'map' ? mapRef.current?.getCenter() : null
    const middle = nodes.length
      ? [nodes.reduce((sum, node) => sum + node.latitude, 0) / nodes.length, nodes.reduce((sum, node) => sum + node.longitude, 0) / nodes.length] as [number, number]
      : undefined
    setPlaceTarget({ pppoe, name, deviceId, center: current ? [current.lat, current.lng] : middle })
  }

  // Depois de colocar um cliente, a recarga traz o ponto novo: abre-o.
  const pendingFocusRef = useRef<string | null>(null)
  useEffect(() => {
    const wanted = pendingFocusRef.current
    if (!wanted) return
    const node = nodes.find((item) => item.node_id === wanted)
    if (!node) return
    pendingFocusRef.current = null
    focusBox(node.node_id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  // `?place=<pppoe>`: se o cliente já está no mapa, abre o ponto dele; se não,
  // o diálogo de colocar. Uma vez só, depois que o mapa carregou.
  const placeParamHandled = useRef(false)
  useEffect(() => {
    const pppoe = searchParams.get('place')?.trim()
    if (!pppoe || placeParamHandled.current || loading || !lastRefresh) return
    placeParamHandled.current = true
    const existing = nodes.find((node) => String(node.pppoe ?? '').trim().toLowerCase() === pppoe.toLowerCase())
    if (existing) focusBox(existing.node_id)
    else if (canEditMap) openPlace(pppoe, searchParams.get('name') || undefined, searchParams.get('device'))
    const next = new URLSearchParams(searchParams)
    next.delete('place')
    next.delete('name')
    next.delete('device')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, loading, lastRefresh, nodes, canEditMap])

  const openNewEdge = () => {
    setEditingEdge(false)
    setEdgeEditor({
      edge_id: '', source: nodes[0]?.node_id || '', target: nodes[1]?.node_id || '',
      fiber_type: 'distribution', distance: null, waypoints: null, notes: ''
    })
  }

  const saveNode = async (form: NodeForm) => {
    try {
      setSaving(true)
      const response = editingNode
        ? await mappingAPI.updateNode(form.node_id, form)
        : await mappingAPI.createNode(form)
      if (!response.success) throw new Error(response.message || t('map.toast.nodeSaveFailed'))
      toast.success(editingNode ? t('map.toast.nodeUpdated') : t('map.toast.nodeAdded'))
      setNodeEditor(null)
      setSelectedNode(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('map.toast.nodeSaveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const saveEdge = async (form: EdgeForm) => {
    try {
      setSaving(true)
      const response = editingEdge
        ? await mappingAPI.updateEdge(form.edge_id, form)
        : await mappingAPI.createEdge(form)
      if (!response.success) throw new Error(response.message || t('map.toast.cableSaveFailed'))
      toast.success(editingEdge ? t('map.toast.cableUpdated') : t('map.toast.cableDrawn'))
      setEdgeEditor(null)
      setSelectedEdge(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('map.toast.cableSaveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const deleteNode = async (node: MapNode) => {
    if (!window.confirm(t('map.confirm.deleteNode', { id: node.node_id }))) return
    try {
      const response = await mappingAPI.deleteNode(node.node_id)
      if (!response.success) throw new Error(response.message || t('map.toast.nodeDeleteFailed'))
      toast.success(t('map.toast.nodeDeleted'))
      setSelectedNode(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('map.toast.nodeDeleteFailed'))
    }
  }
  const deleteEdge = async (edge: MapEdge) => {
    if (!window.confirm(t('map.confirm.deleteCable', { id: edge.edge_id }))) return
    try {
      const response = await mappingAPI.deleteEdge(edge.edge_id)
      if (!response.success) throw new Error(response.message || t('map.toast.cableDeleteFailed'))
      toast.success(t('map.toast.cableDeleted'))
      setSelectedEdge(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('map.toast.cableDeleteFailed'))
    }
  }

  const nodeCounts = useMemo(() => NODE_TYPES.map((type) => ({
    ...type, count: nodes.filter((node) => node.type === type.value).length
  })), [nodes])

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('map.kicker')}</p>
            <h1 className="page-title">{t('map.title')}</h1>
            <p className="page-description">{t('map.description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEditMap && <button type="button" className="modern-button" onClick={() => openNewNode()}><Icon name="pin" size={17} />{t('map.addNode')}</button>}
            {canEditMap && <button type="button" className="modern-button-secondary" onClick={openNewEdge}><Icon name="signal" size={17} />{t('map.drawCable')}</button>}
            <button type="button" className="modern-button-secondary" onClick={() => setUnmappedOpen(true)} title={t('map.unmapped.hint')}>
              <Icon name="devices" size={17} />{t('map.unmapped.button')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={!nodes.length} onClick={() => setFeasibilityOpen(true)} title={t('map.feasibility.hint')}>
              <Icon name="search" size={17} />{t('map.feasibility.button')}
            </button>
            {canEditMap && <button type="button" className="modern-button-secondary" onClick={() => setImportOpen(true)}><Icon name="document" size={17} />{t('map.import.button')}</button>}
            <button type="button" className="modern-button-secondary" disabled={!nodes.length} onClick={exportKml} title={t('map.export.hint')}>
              <Icon name="external" size={17} />{t('map.export.button')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => { void loadData(false); void loadLive() }}>
              <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />{t('common.refresh')}
            </button>
          </div>
        </header>

        <section className="mb-4 grid grid-cols-2 overflow-hidden rounded-(--radius) border border-border bg-card sm:grid-cols-4">
          <div className="border-b border-e border-border p-4 sm:border-b-0"><p className="metric-label">{t('map.metric.nodes')}</p><p className="metric-value">{nodes.length}</p></div>
          <div className="border-b border-border p-4 sm:border-b-0 sm:border-e"><p className="metric-label">{t('map.metric.cables')}</p><p className="metric-value">{edges.length}</p></div>
          <div className="border-e border-border p-4"><p className="metric-label">{t('map.metric.oltOdc')}</p><p className="metric-value">{nodes.filter((n) => n.type === 'olt' || n.type === 'odc').length}</p></div>
          <div className="p-4"><p className="metric-label">{t('map.metric.lastRefresh')}</p><p className="mt-2 font-mono text-sm font-semibold">{lastRefresh ? formatTime(lastRefresh) : '—'}</p></div>
        </section>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {nodeCounts.map((entry) => <span key={entry.value} className="modern-badge">{t(entry.labelKey)} {entry.count}</span>)}
            {live && live.items.length > 0 && LIVE_STATES.filter((state) => live.summary[state] > 0).map((state) => (
              <span key={state} className="modern-badge" title={t('map.live.hint')}>
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LIVE_COLORS[state] }} />
                {t(liveLabelKey(state))} {live.summary[state]}
              </span>
            ))}
            {liveError && <span className="modern-badge text-[hsl(var(--status-danger))]" title={liveError}><Icon name="warning" size={14} />{t('map.live.unavailable')}</span>}
          </div>
          {/* No celular as quatro vistas ocupam a linha inteira e dividem a
              largura; o rolar de lado só entra numa língua de rótulos longos. */}
          <div className="flex w-full overflow-x-auto rounded-md border border-border bg-card p-1 sm:w-auto">
            {(['map', 'list', 'boxes', 'outages'] as const).map((view) => (
              <button key={view} type="button" onClick={() => setMapView(view)}
                className={`min-h-10 flex-auto rounded px-2 text-sm font-semibold sm:min-h-9 sm:flex-none sm:px-3 ${mapView === view ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                {t(`map.view.${view}` as const)}
              </button>
            ))}
          </div>
        </div>

        {(live?.outages ?? []).length > 0 && (
          <div className="mb-3 rounded-(--radius) border-2 p-3" style={{ borderColor: LIVE_COLORS.offline, background: `${LIVE_COLORS.offline}14` }} role="alert">
            <p className="flex items-center gap-2 font-semibold" style={{ color: LIVE_COLORS.offline }}>
              <Icon name="warning" size={18} />{t('map.outage.title', { count: live?.outages?.length ?? 0 })}
            </p>
            <ul className="mt-2 space-y-1">
              {(live?.outages ?? []).map((outage) => (
                <li key={outage.node_id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{outage.name}</span>
                  <span className="text-muted-foreground">{outageLine(outage)}</span>
                  <button type="button" className="min-h-10 font-semibold text-primary hover:underline sm:min-h-0" onClick={() => focusBox(outage.node_id)}>
                    {t('map.outage.show')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {weak.length > 0 && (
          <div className="mb-3 rounded-(--radius) border-2 p-3" style={{ borderColor: LIVE_COLORS.weak, background: `${LIVE_COLORS.weak}14` }}>
            <button type="button" className="flex w-full items-center gap-2 text-start font-semibold" style={{ color: LIVE_COLORS.weak }}
              aria-expanded={weak.length <= 3 || weakExpanded} onClick={() => setWeakExpanded((value) => !value)}>
              <Icon name="signal" size={18} />{t('map.weak.title', { count: weak.length })}
              {weak.length > 3 && <span className="ms-auto text-xs font-normal text-muted-foreground">{t(weakExpanded ? 'map.weak.collapse' : 'map.weak.expand')}</span>}
            </button>
            {(weak.length <= 3 || weakExpanded) && (
              <ul className="mt-2 space-y-1">
                {weak.map((entry) => (
                  <li key={entry.box.node_id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{entry.box.name}</span>
                    <span className="text-muted-foreground">
                      {t('map.weak.line', { weak: entry.weak, measured: entry.measured })}
                      {entry.averageRx !== null ? ` · ${t('map.weak.average', { rx: entry.averageRx.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}` : ''}
                    </span>
                    <button type="button" className="min-h-10 font-semibold text-primary hover:underline sm:min-h-0" onClick={() => focusBox(entry.box.node_id)}>
                      {t('map.outage.show')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{t('map.weak.hint')}</p>
          </div>
        )}

        <div className="relative">
          <section className={`modern-card overflow-hidden ${mapView === 'map' ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="section-heading">{t('map.physicalMap')}</h2>
                <p className="text-xs text-muted-foreground">{t('map.physicalMapHint')}</p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <MapAddressSearch onPick={(place) => { setMapView('map'); setFoundPlace(place) }} />
              <div className="inline-flex rounded-md border border-border bg-muted p-1">
                {([['osm', 'OpenStreetMap'], ['google', 'Google Maps']] as const).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => { setBasemap(value); localStorage.setItem('networkMapBasemap', value) }}
                    className={`min-h-10 rounded px-3 text-xs font-semibold sm:min-h-9 ${basemap === value ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'}`}>
                    {label}
                  </button>
                ))}
              </div>
              </div>
            </div>
            {/* No celular a altura sai da viewport dinâmica e o piso é menor: com
                28rem fixos o mapa engolia a tela deitada, e arrastar nele não rola
                a página. `isolate` prende os z-index do Leaflet (até 1000) aqui
                dentro, abaixo do cabeçalho fixo e da gaveta. */}
            <div className="relative h-[60dvh] min-h-72 max-h-216 sm:h-[62vh] sm:min-h-112">
              <div ref={mapContainerRef} className="isolate h-full w-full" />
              {foundPlace && (
                <div className="absolute bottom-3 inset-s-3 z-500 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-2 text-xs shadow-xs sm:max-w-md">
                  <Icon name="pin" size={15} className="shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate" title={foundPlace.label}>{foundPlace.label}</span>
                  {canEditMap && (
                    <button type="button" className="modern-button min-h-10 px-2 text-xs sm:min-h-8" onClick={() => openNewNode(foundPlace)}>
                      {t('map.search.addHere')}
                    </button>
                  )}
                  <button type="button" className="inline-flex min-h-10 min-w-10 items-center justify-center px-1 text-muted-foreground hover:text-foreground sm:min-h-8 sm:min-w-0" onClick={() => setFoundPlace(null)} aria-label={t('common.close')}>
                    <Icon name="x" size={15} />
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className={`space-y-4 ${mapView === 'list' ? '' : 'hidden'}`}>
            <div className="modern-card overflow-hidden">
              <div className="border-b border-border px-5 py-4"><h2 className="section-heading">{t('map.metric.nodes')}</h2></div>
              <ul className="mobile-card-list divide-y divide-border">
                {nodes.map((node) => (
                  <li key={node.node_id}>
                    <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-start hover:bg-[hsl(var(--surface-subtle))]" onClick={() => setSelectedNode(node)}>
                      <Icon name={nodeIconName(node.type)} size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block wrap-break-word font-semibold">{node.name}</span>
                        <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">{node.node_id} · {nodeTypeLabel(node.type)}</span>
                        <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{node.latitude.toFixed(6)}, {node.longitude.toFixed(6)}</span>
                      </span>
                      <Icon name="chevron-right" size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
                {!nodes.length && <li className="px-4 py-10 text-center text-sm text-muted-foreground">{t('map.nodes.empty')}</li>}
              </ul>
              <div className="desktop-table overflow-x-auto">
                <table className="modern-table">
                  <thead><tr><th>{t('map.table.id')}</th><th>{t('map.table.name')}</th><th>{t('map.table.type')}</th><th>{t('map.table.coordinates')}</th><th>{t('common.actions')}</th></tr></thead>
                  <tbody>
                    {nodes.map((node) => (
                      <tr key={node.node_id}>
                        <td className="font-mono text-sm">{node.node_id}</td>
                        <td>{node.name}</td>
                        <td><span className="flex items-center gap-2"><Icon name={nodeIconName(node.type)} size={17} />{nodeTypeLabel(node.type)}</span></td>
                        <td className="font-mono text-xs">{node.latitude.toFixed(6)}, {node.longitude.toFixed(6)}</td>
                        <td><button className="min-h-11 font-semibold text-primary hover:underline" onClick={() => setSelectedNode(node)}>{t('common.details')}</button></td>
                      </tr>
                    ))}
                    {!nodes.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">{t('map.nodes.empty')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modern-card overflow-hidden">
              <div className="border-b border-border px-5 py-4"><h2 className="section-heading">{t('map.metric.cables')}</h2></div>
              <ul className="mobile-card-list divide-y divide-border">
                {edges.map((edge) => (
                  <li key={edge.edge_id}>
                    <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-start hover:bg-[hsl(var(--surface-subtle))]" onClick={() => setSelectedEdge(edge)}>
                      <span className="mt-2 h-2 w-6 shrink-0 rounded" style={{ background: getFiberMeta(edge.fiber_type).color }} />
                      <span className="min-w-0 flex-1">
                        <span className="block break-all font-mono text-sm font-semibold">{edge.edge_id}</span>
                        <span className="mt-0.5 block break-all text-xs text-muted-foreground">{edge.source} → {edge.target}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t(getFiberMeta(edge.fiber_type).labelKey)}{edge.distance == null ? '' : ` · ${edge.distance} m`}
                        </span>
                      </span>
                      <Icon name="chevron-right" size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
                {!edges.length && <li className="px-4 py-10 text-center text-sm text-muted-foreground">{t('map.cables.empty')}</li>}
              </ul>
              <div className="desktop-table overflow-x-auto">
                <table className="modern-table">
                  <thead><tr><th>{t('map.table.id')}</th><th>{t('map.table.route')}</th><th>{t('map.table.type')}</th><th>{t('map.table.distance')}</th><th>{t('common.actions')}</th></tr></thead>
                  <tbody>
                    {edges.map((edge) => (
                      <tr key={edge.edge_id}>
                        <td className="font-mono text-sm">{edge.edge_id}</td>
                        <td>{edge.source} → {edge.target}</td>
                        <td><span className="flex items-center gap-2"><span className="h-2 w-6 rounded" style={{ background: getFiberMeta(edge.fiber_type).color }} />{t(getFiberMeta(edge.fiber_type).labelKey)}</span></td>
                        <td>{edge.distance == null ? '—' : `${edge.distance} m`}</td>
                        <td><button className="min-h-11 font-semibold text-primary hover:underline" onClick={() => setSelectedEdge(edge)}>{t('common.details')}</button></td>
                      </tr>
                    ))}
                    {!edges.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">{t('map.cables.empty')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          {mapView === 'boxes' && (
            <BoxOccupancyView nodes={nodes} edges={edges} outageIds={new Set(outageByBox.keys())} onSelect={(node) => setSelectedNode(node)}
              weakIds={new Set(weak.map((entry) => entry.box.node_id))}
              onBulkLink={canEditMap ? () => setLinkOpen(true) : undefined}
              fileName={kmlFileName(providerSlug || tenantName).replace(/^topologia-/, 'ocupacao-').replace(/\.kml$/, '.csv')} />
          )}
          {mapView === 'outages' && <OutageHistoryView onSelectBox={(nodeId) => focusBox(nodeId)} />}
          {loading && (
            <div className="pointer-events-none absolute inset-e-3 top-3 z-500 flex items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-2 text-xs font-semibold shadow-xs">
              <Icon name="refresh" size={15} className="animate-spin" />
              {t('map.loadingTopology')}
            </div>
          )}
        </div>

        {selectedNode && (
          <ModalShell title={selectedNode.name} onClose={() => setSelectedNode(null)}>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="metric-label">{t('map.node.id')}</dt><dd className="mt-1 break-all font-mono">{selectedNode.node_id}</dd></div>
              <div><dt className="metric-label">{t('map.table.type')}</dt><dd className="mt-1">{nodeTypeLabel(selectedNode.type)}</dd></div>
              <div><dt className="metric-label">{t('map.table.coordinates')}</dt><dd className="mt-1 font-mono text-sm">{selectedNode.latitude}, {selectedNode.longitude}</dd></div>
              <div><dt className="metric-label">{t('map.node.capacity')}</dt><dd className="mt-1">{selectedNode.capacity ?? '—'}</dd></div>
              <div><dt className="metric-label">{t('map.node.splitter')}</dt><dd className="mt-1">{selectedNode.splitter || '—'}</dd></div>
              <div><dt className="metric-label">PPPoE</dt><dd className="mt-1 break-all">{selectedNode.pppoe || '—'}</dd></div>
              {liveByNode.get(selectedNode.node_id) && (() => {
                const state = liveByNode.get(selectedNode.node_id) as LiveItem
                return (
                  <div className="sm:col-span-2">
                    <dt className="metric-label">{t('map.live.title')}</dt>
                    <dd className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LIVE_COLORS[state.state] }} />
                      <span className="font-semibold">{liveText(state)}</span>
                      {state.deviceId && (
                        <Link className="text-sm font-semibold text-primary hover:underline" to={`/devices/detail?id=${encodeURIComponent(state.deviceId)}`}>
                          {t('map.live.openDevice')}
                        </Link>
                      )}
                    </dd>
                  </div>
                )
              })()}
              {selectedNode.notes && <div className="sm:col-span-2"><dt className="metric-label">{t('map.node.notes')}</dt><dd className="mt-1 whitespace-pre-wrap wrap-break-word">{selectedNode.notes}</dd></div>}
            </dl>
            {outageByBox.get(selectedNode.node_id) && (
              <p className="mt-4 flex items-start gap-2 rounded-md border-2 p-3 text-sm font-semibold" style={{ borderColor: LIVE_COLORS.offline, color: LIVE_COLORS.offline }} role="alert">
                <Icon name="warning" size={17} className="mt-0.5 shrink-0" />
                {t('map.outage.boxNotice', { line: outageLine(outageByBox.get(selectedNode.node_id) as LiveOutage) })}
              </p>
            )}
            {BOX_TYPES.has(selectedNode.type) && (
              <BoxClients box={selectedNode} nodes={nodes} edges={edges} live={liveByNode} onSelect={(node) => setSelectedNode(node)} />
            )}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {canEditMap && <button className="modern-button-secondary" onClick={() => { setEditingNode(true); setNodeEditor({ ...selectedNode }); setSelectedNode(null) }}><Icon name="edit" size={17} />{t('common.edit')}</button>}
              {canEditMap && <button className="modern-button-secondary text-[hsl(var(--status-danger))]" onClick={() => void deleteNode(selectedNode)}><Icon name="trash" size={17} />{t('common.delete')}</button>}
              <a className="modern-button-secondary" target="_blank" rel="noopener noreferrer"
                href={`https://www.google.com/maps/dir/?api=1&destination=${selectedNode.latitude},${selectedNode.longitude}`}>
                <Icon name="map" size={17} />{t('map.directions.google')}
              </a>
              <a className="modern-button-secondary" target="_blank" rel="noopener noreferrer"
                href={`https://waze.com/ul?ll=${selectedNode.latitude},${selectedNode.longitude}&navigate=yes`}>
                <Icon name="external" size={17} />Waze
              </a>
              <a className="modern-button-secondary" target="_blank" rel="noopener noreferrer"
                href={`https://wa.me/?text=${encodeURIComponent(t('map.directions.shareText', {
                  name: selectedNode.name,
                  link: `https://maps.google.com/?q=${selectedNode.latitude},${selectedNode.longitude}`
                }))}`}>
                <Icon name="chat" size={17} />{t('map.directions.share')}
              </a>
              {canScheduleMaintenance && MAINTENANCE_NODE_TYPES.has(selectedNode.type) && (
                <button className="modern-button-secondary" onClick={() => { setMaintenanceNode(selectedNode); setSelectedNode(null) }}>
                  <Icon name="settings" size={17} />{t('maintenance.mapButton')}
                </button>
              )}
              <button className="modern-button" onClick={() => setSelectedNode(null)}>{t('common.close')}</button>
            </div>
          </ModalShell>
        )}
        {maintenanceNode && (
          <ModalShell title={t('maintenance.formTitleFor', { node: maintenanceNode.name })} onClose={() => setMaintenanceNode(null)}>
            <MaintenanceForm
              presetNodeId={maintenanceNode.node_id}
              onCancel={() => setMaintenanceNode(null)}
              onDone={() => setMaintenanceNode(null)}
            />
          </ModalShell>
        )}
        {selectedEdge && (
          <ModalShell title={selectedEdge.edge_id} onClose={() => setSelectedEdge(null)}>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="metric-label">{t('map.table.route')}</dt><dd className="mt-1 break-all">{selectedEdge.source} → {selectedEdge.target}</dd></div>
              <div><dt className="metric-label">{t('map.edge.fiberType')}</dt><dd className="mt-1">{t(getFiberMeta(selectedEdge.fiber_type).labelKey)}</dd></div>
              <div><dt className="metric-label">{t('map.table.distance')}</dt><dd className="mt-1">{selectedEdge.distance == null ? '—' : `${selectedEdge.distance} m`}</dd></div>
              <div><dt className="metric-label">{t('map.edge.waypoints')}</dt><dd className="mt-1">{selectedEdge.waypoints?.length || 0}</dd></div>
              {selectedEdge.notes && <div className="sm:col-span-2"><dt className="metric-label">{t('map.node.notes')}</dt><dd className="mt-1 whitespace-pre-wrap wrap-break-word">{selectedEdge.notes}</dd></div>}
            </dl>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {canEditMap && <button className="modern-button-secondary" onClick={() => { setEditingEdge(true); setEdgeEditor({ ...selectedEdge }); setSelectedEdge(null) }}><Icon name="edit" size={17} />{t('common.edit')}</button>}
              {canEditMap && <button className="modern-button-secondary text-[hsl(var(--status-danger))]" onClick={() => void deleteEdge(selectedEdge)}><Icon name="trash" size={17} />{t('common.delete')}</button>}
              <button className="modern-button" onClick={() => setSelectedEdge(null)}>{t('common.close')}</button>
            </div>
          </ModalShell>
        )}
        {nodeEditor && <NodeEditor initial={nodeEditor} editing={editingNode} saving={saving} onClose={() => setNodeEditor(null)} onSave={(value) => void saveNode(value)} />}
        {unmappedOpen && (
          <UnmappedDialog canWrite={canEditMap} onClose={() => setUnmappedOpen(false)}
            onPlace={(device) => { setUnmappedOpen(false); openPlace(device.pppoe, undefined, device.deviceId) }}
            onPlaceAll={() => { setUnmappedOpen(false); setBulkOpen(true) }} />
        )}
        {bulkOpen && (
          <BulkPlaceDialog existingIds={nodes.map((node) => node.node_id)} onClose={() => setBulkOpen(false)}
            onDone={(created) => {
              setBulkOpen(false)
              toast.success(t('map.bulk.done', { count: created }))
              hasCenteredAssetsRef.current = false
              // Os pontos entram sem cabo: em seguida, a prévia de ligar cada um à caixa.
              void loadData(false).then(() => { if (created > 0) setLinkOpen(true) })
              void loadLive()
            }} />
        )}
        {linkOpen && (
          <BulkLinkDialog nodes={nodes} edges={edges} edgeIds={edges.map((edge) => edge.edge_id)} onClose={() => setLinkOpen(false)}
            onDone={(created) => {
              setLinkOpen(false)
              toast.success(t('map.link.done', { count: created }))
              void loadData(false)
              void loadLive()
            }} />
        )}
        {feasibilityOpen && (
          <FeasibilityDialog nodes={nodes} edges={edges} center={mapCenter} onClose={() => setFeasibilityOpen(false)}
            onShowBox={(nodeId) => { setFeasibilityOpen(false); focusBox(nodeId) }} />
        )}
        {placeTarget && (
          <PlaceClientDialog target={placeTarget} nodes={nodes} edges={edges} edgeIds={edges.map((edge) => edge.edge_id)}
            center={placeTarget.center ?? mapCenter}
            onClose={() => setPlaceTarget(null)}
            onDone={(nodeId) => {
              setPlaceTarget(null)
              toast.success(t('map.place.done'))
              pendingFocusRef.current = nodeId
              void loadData(false)
            }} />
        )}
        {importOpen && <ImportDialog nodes={nodes} edges={edges} onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); hasCenteredAssetsRef.current = false; void loadData(false) }} />}
        {edgeEditor && <EdgeEditor initial={edgeEditor} nodes={nodes} editing={editingEdge} saving={saving} onClose={() => setEdgeEditor(null)} onSave={(value) => void saveEdge(value)} />}
      </div>
    </div>
  )
}
