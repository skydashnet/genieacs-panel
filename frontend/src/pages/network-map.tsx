'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useTheme } from '@/contexts/theme-context'
import { mappingAPI, mapSettingsAPI } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import 'leaflet/dist/leaflet.css'

// Start fetching the map engine as soon as this route chunk is evaluated. The
// topology request and Leaflet download can then run in parallel.
const leafletModulePromise = import('leaflet')

type NodeType = 'htb' | 'olt' | 'odc' | 'odp' | 'ont' | 'server'
type FiberType = 'backbone' | 'feeder' | 'distribution' | 'drop' | 'patch'
type Basemap = 'osm' | 'google'

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

const NODE_TYPES: { value: NodeType; label: string }[] = [
  { value: 'htb', label: 'HTB' },
  { value: 'olt', label: 'OLT' },
  { value: 'odc', label: 'ODC' },
  { value: 'odp', label: 'ODP' },
  { value: 'ont', label: 'ONT' },
  { value: 'server', label: 'Server' },
]

const FIBER_TYPES: { value: FiberType; label: string; color: string }[] = [
  { value: 'backbone', label: 'Backbone', color: '#8b5cf6' },
  { value: 'feeder', label: 'Feeder', color: '#0ea5e9' },
  { value: 'distribution', label: 'Distribution', color: '#22c55e' },
  { value: 'drop', label: 'Drop cable', color: '#f59e0b' },
  { value: 'patch', label: 'Patch', color: '#94a3b8' },
]

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function getTypeLabel(type: NodeType) {
  return NODE_TYPES.find((entry) => entry.value === type)?.label || type.toUpperCase()
}

function getFiberMeta(type: FiberType) {
  return FIBER_TYPES.find((entry) => entry.value === type) || FIBER_TYPES[2]
}

function getTileUrlAndAttrib(basemap: Basemap, dark: boolean) {
  if (basemap === 'google') {
    return {
      url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=id&gl=id',
      attribution: 'Map data &copy; Google'
    }
  }
  if (dark) {
    return {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
  }
  return {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors'
  }
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

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[2200] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true">
      <div className="modern-card max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="section-heading">{title}</h2>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close">
            <Icon name="x" size={20} />
          </button>
        </div>
        {children}
      </div>
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
  const [form, setForm] = useState(initial)
  const set = <K extends keyof NodeForm>(key: K, value: NodeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  return (
    <ModalShell title={editing ? `Edit ${initial.node_id}` : 'Add network node'} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); onSave(form) }} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold">
            Node ID
            <input className="modern-input w-full font-mono" required maxLength={128}
              pattern="[A-Za-z0-9._:-]+" disabled={editing} value={form.node_id}
              onChange={(event) => set('node_id', event.target.value)} placeholder="ODP-ZONE-001" />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Type
            <select className="modern-input w-full" value={form.type}
              onChange={(event) => set('type', event.target.value as NodeType)}>
              {NODE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            Name
            <input className="modern-input w-full" required maxLength={255} value={form.name}
              onChange={(event) => set('name', event.target.value)} placeholder="ODP Jalan Merdeka" />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Latitude
            <input className="modern-input w-full font-mono" required type="number" min={-90} max={90} step="any"
              value={form.latitude} onChange={(event) => set('latitude', Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Longitude
            <input className="modern-input w-full font-mono" required type="number" min={-180} max={180} step="any"
              value={form.longitude} onChange={(event) => set('longitude', Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Capacity
            <input className="modern-input w-full" type="number" min={0} step={1}
              value={form.capacity ?? ''} onChange={(event) => set('capacity', event.target.value === '' ? null : Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Splitter
            <input className="modern-input w-full" maxLength={64} value={form.splitter ?? ''}
              onChange={(event) => set('splitter', event.target.value)} placeholder="1:8" />
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            PPPoE / subscriber reference
            <input className="modern-input w-full" maxLength={255} value={form.pppoe ?? ''}
              onChange={(event) => set('pppoe', event.target.value)} />
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            Notes
            <textarea className="modern-input min-h-24 w-full" maxLength={5000} value={form.notes ?? ''}
              onChange={(event) => set('notes', event.target.value)} />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="modern-button" disabled={saving}>
            <Icon name={saving ? 'refresh' : 'check'} size={17} className={saving ? 'animate-spin' : ''} />
            {saving ? 'Saving…' : 'Save node'}
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
  const [form, setForm] = useState(initial)
  const set = <K extends keyof EdgeForm>(key: K, value: EdgeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  return (
    <ModalShell title={editing ? `Edit ${initial.edge_id}` : 'Draw fiber cable'} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); onSave(form) }} className="space-y-5">
        {nodes.length < 2 && (
          <div className="rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-3 text-sm">
            Add at least two nodes before drawing a cable.
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            Cable ID
            <input className="modern-input w-full font-mono" required maxLength={128}
              pattern="[A-Za-z0-9._:-]+" disabled={editing} value={form.edge_id}
              onChange={(event) => set('edge_id', event.target.value)} placeholder="FBR-ODC01-ODP01" />
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Source node
            <select className="modern-input w-full" required value={form.source}
              onChange={(event) => set('source', event.target.value)}>
              <option value="">Select source</option>
              {nodes.map((node) => <option key={node.node_id} value={node.node_id}>{node.name} ({node.node_id})</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Target node
            <select className="modern-input w-full" required value={form.target}
              onChange={(event) => set('target', event.target.value)}>
              <option value="">Select target</option>
              {nodes.map((node) => <option key={node.node_id} value={node.node_id}>{node.name} ({node.node_id})</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Fiber type
            <select className="modern-input w-full" value={form.fiber_type}
              onChange={(event) => set('fiber_type', event.target.value as FiberType)}>
              {FIBER_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Distance (meter)
            <input className="modern-input w-full" type="number" min={0} step="any"
              value={form.distance ?? ''} onChange={(event) => set('distance', event.target.value === '' ? null : Number(event.target.value))} />
          </label>
          <label className="space-y-2 text-sm font-semibold sm:col-span-2">
            Notes
            <textarea className="modern-input min-h-24 w-full" maxLength={5000} value={form.notes ?? ''}
              onChange={(event) => set('notes', event.target.value)} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          The cable is drawn automatically between both nodes. Existing route waypoints are preserved when editing.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="modern-button" disabled={saving || nodes.length < 2 || form.source === form.target}>
            <Icon name={saving ? 'refresh' : 'check'} size={17} className={saving ? 'animate-spin' : ''} />
            {saving ? 'Saving…' : 'Save cable'}
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
  const [mapView, setMapView] = useState<'map' | 'list'>('map')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [mapCenter, setMapCenter] = useState<[number, number]>([-6.2088, 106.8456])
  const [defaultZoom, setDefaultZoom] = useState(12)
  const [minZoom, setMinZoom] = useState(5)
  const [maxZoom, setMaxZoom] = useState(18)
  const [basemap, setBasemap] = useState<Basemap>('osm')
  const { isDarkMode } = useTheme()
  const { user } = useAuth()
  const toast = useToast()
  const isAdmin = user?.role === 'admin'

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
      if (!nodesRes.success || !edgesRes.success) throw new Error('Topology data could not be loaded')
      setNodes(normalizeNodes(nodesRes.data))
      setEdges(normalizeEdges(edgesRes.data))
      const settings = settingsRes?.data as any
      if (settings) {
        const center: [number, number] = [Number(settings.center_lat), Number(settings.center_lng)]
        if (center.every(Number.isFinite)) setMapCenter(center)
        if (Number.isFinite(Number(settings.default_zoom))) setDefaultZoom(Number(settings.default_zoom))
        if (Number.isFinite(Number(settings.max_zoom_out))) setMinZoom(Number(settings.max_zoom_out))
        if (Number.isFinite(Number(settings.max_zoom_in))) setMaxZoom(Number(settings.max_zoom_in))
      }
      setLastRefresh(new Date())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed loading network topology')
    } finally {
      setLoading(false)
    }
  }, [toast])

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
    const tile = getTileUrlAndAttrib(basemap, isDarkMode)
    tileLayerRef.current = L.tileLayer(tile.url, { attribution: tile.attribution }).addTo(map)
  }, [basemap, isDarkMode])

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
      line.bindTooltip(`<strong>${escapeHtml(edge.edge_id)}</strong><br>${escapeHtml(meta.label)} · ${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}`)
      line.on('click', () => { setSelectedEdge(edge); setSelectedNode(null) })
    })

    nodes.forEach((node) => {
      const iconColor = isDarkMode ? '#f4f3ed' : '#173f35'
      const html = `<div style="width:28px;height:28px;padding:3px;border-radius:8px;background:${isDarkMode ? '#17211c' : '#fff'};border:1px solid ${isDarkMode ? '#53615a' : '#bdc9c2'};box-shadow:0 2px 6px rgba(0,0,0,.2)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${getNodeSvg(node.type)}</svg></div>`
      const marker = L.marker([node.latitude, node.longitude], {
        icon: L.divIcon({ className: '', html, iconSize: [28, 28], iconAnchor: [14, 14] })
      }).addTo(markersLayerRef.current)
      marker.bindTooltip(`<strong>${escapeHtml(node.name)}</strong><br>${escapeHtml(getTypeLabel(node.type))} · ${escapeHtml(node.node_id)}`)
      marker.on('click', () => { setSelectedNode(node); setSelectedEdge(null) })
    })
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
  }, [edges, isDarkMode, maxZoom, minZoom, nodes])

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

  const openNewNode = () => {
    const center = mapRef.current?.getCenter()
    setEditingNode(false)
    setNodeEditor({
      node_id: '', type: 'odp', name: '',
      latitude: Number(center?.lat ?? mapCenter[0]),
      longitude: Number(center?.lng ?? mapCenter[1]),
      capacity: null, splitter: '', pppoe: '', notes: ''
    })
  }
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
      if (!response.success) throw new Error(response.message || 'Node could not be saved')
      toast.success(editingNode ? 'Node updated' : 'Node added')
      setNodeEditor(null)
      setSelectedNode(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Node could not be saved')
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
      if (!response.success) throw new Error(response.message || 'Cable could not be saved')
      toast.success(editingEdge ? 'Cable updated' : 'Cable drawn')
      setEdgeEditor(null)
      setSelectedEdge(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cable could not be saved')
    } finally {
      setSaving(false)
    }
  }
  const deleteNode = async (node: MapNode) => {
    if (!window.confirm(`Delete ${node.node_id}? Every cable connected to this node will also be deleted.`)) return
    try {
      const response = await mappingAPI.deleteNode(node.node_id)
      if (!response.success) throw new Error(response.message || 'Node could not be deleted')
      toast.success('Node deleted')
      setSelectedNode(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Node could not be deleted')
    }
  }
  const deleteEdge = async (edge: MapEdge) => {
    if (!window.confirm(`Delete cable ${edge.edge_id}?`)) return
    try {
      const response = await mappingAPI.deleteEdge(edge.edge_id)
      if (!response.success) throw new Error(response.message || 'Cable could not be deleted')
      toast.success('Cable deleted')
      setSelectedEdge(null)
      await loadData(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cable could not be deleted')
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
            <p className="page-kicker">Outside plant</p>
            <h1 className="page-title">Network topology</h1>
            <p className="page-description">Kelola HTB, OLT, ODC, ODP, ONT, dan jalur kabel fiber langsung pada peta.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && <button type="button" className="modern-button" onClick={openNewNode}><Icon name="pin" size={17} />Add node</button>}
            {isAdmin && <button type="button" className="modern-button-secondary" onClick={openNewEdge}><Icon name="signal" size={17} />Draw cable</button>}
            <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void loadData(false)}>
              <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />Refresh
            </button>
          </div>
        </header>

        <section className="mb-4 grid grid-cols-2 overflow-hidden rounded-[var(--radius)] border border-border bg-card sm:grid-cols-4">
          <div className="border-b border-r border-border p-4 sm:border-b-0"><p className="metric-label">Nodes</p><p className="metric-value">{nodes.length}</p></div>
          <div className="border-b border-border p-4 sm:border-b-0 sm:border-r"><p className="metric-label">Fiber cables</p><p className="metric-value">{edges.length}</p></div>
          <div className="border-r border-border p-4"><p className="metric-label">OLT / ODC</p><p className="metric-value">{nodes.filter((n) => n.type === 'olt' || n.type === 'odc').length}</p></div>
          <div className="p-4"><p className="metric-label">Last refresh</p><p className="mt-2 font-mono text-sm font-semibold">{lastRefresh?.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) || '—'}</p></div>
        </section>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {nodeCounts.map((entry) => <span key={entry.value} className="modern-badge">{entry.label} {entry.count}</span>)}
          </div>
          <div className="flex rounded-md border border-border bg-card p-1">
            {(['map', 'list'] as const).map((view) => (
              <button key={view} type="button" onClick={() => setMapView(view)}
                className={`min-h-9 rounded px-3 text-sm font-semibold ${mapView === view ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                {view === 'map' ? 'Map' : 'Inventory'}
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <section className={`modern-card overflow-hidden ${mapView === 'map' ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="section-heading">Physical fiber map</h2>
                <p className="text-xs text-muted-foreground">Click a node or cable to inspect and edit it.</p>
              </div>
              <div className="inline-flex rounded-md border border-border bg-muted p-1">
                {([['osm', 'OpenStreetMap'], ['google', 'Google Maps']] as const).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => { setBasemap(value); localStorage.setItem('networkMapBasemap', value) }}
                    className={`min-h-9 rounded px-3 text-xs font-semibold ${basemap === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-[62vh] min-h-[28rem] max-h-[54rem]"><div ref={mapContainerRef} className="h-full w-full" /></div>
          </section>

          <section className={`space-y-4 ${mapView === 'list' ? '' : 'hidden'}`}>
            <div className="modern-card overflow-hidden">
              <div className="border-b border-border px-5 py-4"><h2 className="section-heading">Nodes</h2></div>
              <div className="overflow-x-auto">
                <table className="modern-table">
                  <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Coordinates</th><th>Action</th></tr></thead>
                  <tbody>
                    {nodes.map((node) => (
                      <tr key={node.node_id}>
                        <td className="font-mono text-sm">{node.node_id}</td>
                        <td>{node.name}</td>
                        <td><span className="flex items-center gap-2"><Icon name={nodeIconName(node.type)} size={17} />{getTypeLabel(node.type)}</span></td>
                        <td className="font-mono text-xs">{node.latitude.toFixed(6)}, {node.longitude.toFixed(6)}</td>
                        <td><button className="min-h-11 font-semibold text-primary hover:underline" onClick={() => setSelectedNode(node)}>Details</button></td>
                      </tr>
                    ))}
                    {!nodes.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No nodes mapped yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modern-card overflow-hidden">
              <div className="border-b border-border px-5 py-4"><h2 className="section-heading">Fiber cables</h2></div>
              <div className="overflow-x-auto">
                <table className="modern-table">
                  <thead><tr><th>ID</th><th>Route</th><th>Type</th><th>Distance</th><th>Action</th></tr></thead>
                  <tbody>
                    {edges.map((edge) => (
                      <tr key={edge.edge_id}>
                        <td className="font-mono text-sm">{edge.edge_id}</td>
                        <td>{edge.source} → {edge.target}</td>
                        <td><span className="flex items-center gap-2"><span className="h-2 w-6 rounded" style={{ background: getFiberMeta(edge.fiber_type).color }} />{getFiberMeta(edge.fiber_type).label}</span></td>
                        <td>{edge.distance == null ? '—' : `${edge.distance} m`}</td>
                        <td><button className="min-h-11 font-semibold text-primary hover:underline" onClick={() => setSelectedEdge(edge)}>Details</button></td>
                      </tr>
                    ))}
                    {!edges.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No fiber cables drawn yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          {loading && (
            <div className="pointer-events-none absolute right-3 top-3 z-[500] flex items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-2 text-xs font-semibold shadow-sm">
              <Icon name="refresh" size={15} className="animate-spin" />
              Loading topology…
            </div>
          )}
        </div>

        {selectedNode && (
          <ModalShell title={selectedNode.name} onClose={() => setSelectedNode(null)}>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="metric-label">Node ID</dt><dd className="mt-1 font-mono">{selectedNode.node_id}</dd></div>
              <div><dt className="metric-label">Type</dt><dd className="mt-1">{getTypeLabel(selectedNode.type)}</dd></div>
              <div><dt className="metric-label">Coordinates</dt><dd className="mt-1 font-mono text-sm">{selectedNode.latitude}, {selectedNode.longitude}</dd></div>
              <div><dt className="metric-label">Capacity</dt><dd className="mt-1">{selectedNode.capacity ?? '—'}</dd></div>
              <div><dt className="metric-label">Splitter</dt><dd className="mt-1">{selectedNode.splitter || '—'}</dd></div>
              <div><dt className="metric-label">PPPoE</dt><dd className="mt-1">{selectedNode.pppoe || '—'}</dd></div>
              {selectedNode.notes && <div className="sm:col-span-2"><dt className="metric-label">Notes</dt><dd className="mt-1 whitespace-pre-wrap">{selectedNode.notes}</dd></div>}
            </dl>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {isAdmin && <button className="modern-button-secondary" onClick={() => { setEditingNode(true); setNodeEditor({ ...selectedNode }); setSelectedNode(null) }}><Icon name="edit" size={17} />Edit</button>}
              {isAdmin && <button className="modern-button-secondary text-[hsl(var(--status-danger))]" onClick={() => void deleteNode(selectedNode)}><Icon name="trash" size={17} />Delete</button>}
              <button className="modern-button" onClick={() => setSelectedNode(null)}>Close</button>
            </div>
          </ModalShell>
        )}
        {selectedEdge && (
          <ModalShell title={selectedEdge.edge_id} onClose={() => setSelectedEdge(null)}>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div><dt className="metric-label">Route</dt><dd className="mt-1">{selectedEdge.source} → {selectedEdge.target}</dd></div>
              <div><dt className="metric-label">Fiber type</dt><dd className="mt-1">{getFiberMeta(selectedEdge.fiber_type).label}</dd></div>
              <div><dt className="metric-label">Distance</dt><dd className="mt-1">{selectedEdge.distance == null ? '—' : `${selectedEdge.distance} m`}</dd></div>
              <div><dt className="metric-label">Waypoints</dt><dd className="mt-1">{selectedEdge.waypoints?.length || 0}</dd></div>
              {selectedEdge.notes && <div className="sm:col-span-2"><dt className="metric-label">Notes</dt><dd className="mt-1 whitespace-pre-wrap">{selectedEdge.notes}</dd></div>}
            </dl>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {isAdmin && <button className="modern-button-secondary" onClick={() => { setEditingEdge(true); setEdgeEditor({ ...selectedEdge }); setSelectedEdge(null) }}><Icon name="edit" size={17} />Edit</button>}
              {isAdmin && <button className="modern-button-secondary text-[hsl(var(--status-danger))]" onClick={() => void deleteEdge(selectedEdge)}><Icon name="trash" size={17} />Delete</button>}
              <button className="modern-button" onClick={() => setSelectedEdge(null)}>Close</button>
            </div>
          </ModalShell>
        )}
        {nodeEditor && <NodeEditor initial={nodeEditor} editing={editingNode} saving={saving} onClose={() => setNodeEditor(null)} onSave={(value) => void saveNode(value)} />}
        {edgeEditor && <EdgeEditor initial={edgeEditor} nodes={nodes} editing={editingEdge} saving={saving} onClose={() => setEdgeEditor(null)} onSave={(value) => void saveEdge(value)} />}
      </div>
    </div>
  )
}
