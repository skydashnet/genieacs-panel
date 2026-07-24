'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTheme } from '@/contexts/theme-context'
import { mappingAPI, mapSettingsAPI } from '@/lib/api'
import { useLoading } from '@/components/ui/loading'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'

interface MapNode {
  id: number
  node_id: string
  type: 'server' | 'odc' | 'odp' | 'ont'
  name: string
  latitude: number
  longitude: number
  capacity?: number
  splitter?: string
  pppoe?: string
  notes?: string
  status: 'online' | 'offline' | 'warning'
}

type Basemap = 'osm' | 'google'

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
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

function getNodeSvg(type: string) {
  const paths: Record<string, string> = {
    server: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><line x1="7" y1="7" x2="7" y2="7"/><line x1="7" y1="17" x2="7" y2="17"/>',
    building: '<path d="M6 22V4a1 1 0 011-1h10a1 1 0 011 1v18"/><line x1="10" y1="7" x2="10" y2="7"/><line x1="14" y1="7" x2="14" y2="7"/><line x1="10" y1="22" x2="10" y2="18"/><line x1="14" y1="22" x2="14" y2="18"/>',
    box: '<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4"/><line x1="12" y1="11" x2="12" y2="21"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/>',
    pin: '<path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'
  }
  return paths[type] || paths.pin
}

function getStatusHex(status: string) {
  if (status === 'online') return '#22c55e'
  if (status === 'offline') return '#ef4444'
  if (status === 'warning') return '#f59e0b'
  return '#6b7280'
}

function getTypeLabel(type: string) {
  if (type === 'server') return 'Server'
  if (type === 'odc') return 'ODC'
  if (type === 'odp') return 'ODP'
  if (type === 'ont') return 'ONT'
  return 'Unknown'
}

export default function NetworkMap() {
  const [nodes, setNodes] = useState<MapNode[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedNode, setSelectedNode] = useState<MapNode | null>(null)
  const [mapView, setMapView] = useState<'map' | 'list'>('map')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [mapCenter, setMapCenter] = useState<[number, number]>([-6.2088, 106.8456])
  const [defaultZoom, setDefaultZoom] = useState<number>(12)
  const [minZoom, setMinZoom] = useState<number>(5)
  const [maxZoom, setMaxZoom] = useState<number>(18)
  const [basemap, setBasemap] = useState<Basemap>('osm')
  const { isDarkMode } = useTheme()
  const { show: showLoading, hide: hideLoading } = useLoading()
  const toast = useToast()

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markersLayerRef = useRef<any>(null)
  const tileLayerRef = useRef<any>(null)
  const leafletRef = useRef<any>(null)

  const loadData = useCallback(async (withSettings = true) => {
    try {
      setLoading(true)
      showLoading('Loading network map...')
      const requests: Promise<any>[] = [mappingAPI.getNodes()]
      if (withSettings) requests.push(mapSettingsAPI.get())
      const [nodesRes, settingsRes] = await Promise.all(requests)
      if (!nodesRes.success) {
        throw new Error(nodesRes.message || 'Failed to load map nodes')
      }

      const nodesData = Array.isArray(nodesRes.data) ? nodesRes.data : []
      setNodes(
        (nodesData as any[]).map(n => ({
          id: n.id,
          node_id: n.node_id,
          type: n.type,
          name: n.name,
          latitude: Number(n.latitude),
          longitude: Number(n.longitude),
          capacity: n.capacity || undefined,
          splitter: n.splitter || undefined,
          pppoe: n.pppoe || undefined,
          notes: n.notes || undefined,
          status: (n.status as any) || 'online'
        })).filter(n => Number.isFinite(n.latitude) && Number.isFinite(n.longitude))
      )

      const ms = settingsRes?.data as any
      if (ms && typeof ms === 'object') {
        const lat = Number(ms.center_lat ?? -6.2088)
        const lng = Number(ms.center_lng ?? 106.8456)
        const zoom = Number(ms.default_zoom ?? 12)
        const nextMinZoom = Number(ms.max_zoom_out ?? 5)
        const nextMaxZoom = Number(ms.max_zoom_in ?? 18)
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) setMapCenter([lat, lng])
        if (!Number.isNaN(zoom)) setDefaultZoom(zoom)
        if (!Number.isNaN(nextMinZoom)) setMinZoom(nextMinZoom)
        if (!Number.isNaN(nextMaxZoom)) setMaxZoom(nextMaxZoom)
      }
      setLastRefresh(new Date())
    } catch (e) {
      console.error('Failed loading map data', e)
      toast.error(e instanceof Error ? e.message : 'Failed loading map data')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }, [hideLoading, showLoading, toast])

  useEffect(() => {
    loadData()
  }, [loadData])
  useEffect(() => {
    const savedBasemap = localStorage.getItem('networkMapBasemap')
    if (savedBasemap === 'osm' || savedBasemap === 'google') {
      setBasemap(savedBasemap)
    }
  }, [])
  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
    document.head.appendChild(link)
    return () => {
      if (link.parentNode) {
        document.head.removeChild(link)
      }
    }
  }, [])
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markersLayerRef.current = null
        tileLayerRef.current = null
      }
    }
  }, [])

  const updateTileLayer = useCallback(() => {
    const L: any = leafletRef.current
    const map: any = mapRef.current
    if (!L || !map) return
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
      tileLayerRef.current = null
    }
    const { url, attribution } = getTileUrlAndAttrib(basemap, isDarkMode)
    tileLayerRef.current = L.tileLayer(url, { attribution })
    tileLayerRef.current.addTo(map)
  }, [basemap, isDarkMode])

  const updateMarkers = useCallback(() => {
    const L: any = leafletRef.current
    const map: any = mapRef.current
    if (!L || !map) return

    if (!markersLayerRef.current) {
      markersLayerRef.current = L.layerGroup().addTo(map)
    }
    const group: any = markersLayerRef.current
    group.clearLayers()

    const bounds = L.latLngBounds([])

    nodes.forEach((n) => {
      const iconColor = isDarkMode ? '#e5e7eb' : '#374151'
      const html = `<div style="position:relative;width:24px;height:24px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${getNodeSvg(n.type)}</svg><span style="position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;background:${getStatusHex(n.status)};border-radius:9999px;border:2px solid ${isDarkMode ? '#111827' : '#ffffff'};"></span></div>`
      const icon = L.divIcon({
        className: '',
        html,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })
      const marker = L.marker([n.latitude, n.longitude], { icon })
      marker.addTo(group)
      marker.bindTooltip(
        `<div><strong>${escapeHtml(n.name)}</strong><br/>${escapeHtml(getTypeLabel(n.type))} · ${escapeHtml(n.status)}</div>`,
        { direction: 'top', sticky: true, opacity: isDarkMode ? 0.95 : 0.9 }
      )
      marker.on('click', () => setSelectedNode(n))
      bounds.extend([n.latitude, n.longitude])
    })

    if (nodes.length > 0) {
      map.fitBounds(bounds.pad(0.2))
    }
  }, [isDarkMode, nodes])

  // Initialize Leaflet map when switching to Map view
  useEffect(() => {
    if (mapView !== 'map' || loading) return
    let cancelled = false
    ;(async () => {
      if (!leafletRef.current) {
        const mod = await import('leaflet')
        const L = (mod as any).default ?? mod
        leafletRef.current = L
      }
      const L: any = leafletRef.current
      if (cancelled) return
      if (!mapContainerRef.current) return

      if (!mapRef.current) {
        const center: [number, number] = mapCenter // from Map Settings
        const map = L.map(mapContainerRef.current, {
          center,
          zoom: defaultZoom,
          minZoom,
          maxZoom,
        })
        mapRef.current = map
        updateTileLayer()
        markersLayerRef.current = L.layerGroup().addTo(map)
      }

      mapRef.current.setMinZoom(minZoom)
      mapRef.current.setMaxZoom(maxZoom)
      if (nodes.length === 0) {
        mapRef.current.setView(mapCenter, defaultZoom)
      }
      updateMarkers()
      // ensure proper size after render
      setTimeout(() => {
        mapRef.current?.invalidateSize()
      }, 100)
    })()
    return () => {
      cancelled = true
    }
  }, [mapView, loading, mapCenter, defaultZoom, minZoom, maxZoom, nodes.length, updateMarkers, updateTileLayer])

  // Update tile layer on theme change
  useEffect(() => {
    if (mapRef.current && mapView === 'map') {
      updateTileLayer()
    }
  }, [mapView, updateTileLayer])

  // Update markers when nodes change
  useEffect(() => {
    if (mapRef.current && mapView === 'map') {
      updateMarkers()
    }
  }, [mapView, updateMarkers])

  const handleRefresh = () => {
    loadData(false)
  }

  const handleBasemapChange = (nextBasemap: Basemap) => {
    setBasemap(nextBasemap)
    localStorage.setItem('networkMapBasemap', nextBasemap)
  }

  const getNodeIconName = (type: string) => {
    switch (type) {
      case 'server':
        return 'server'
      case 'odc':
        return 'building'
      case 'odp':
        return 'box'
      case 'ont':
        return 'home'
      default:
        return 'pin'
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'online':
        return <span className="modern-badge-success">Online</span>
      case 'offline':
        return <span className="modern-badge-error">Offline</span>
      case 'warning':
        return <span className="modern-badge-warning">Warning</span>
      default:
        return <span className="modern-badge">Unknown</span>
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Network Map</h1>
            <p className="text-gray-600 dark:text-gray-400">Visualize and manage your network topology</p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              onClick={() => setMapView('map')}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${
                mapView === 'map'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Map View
            </button>
            <button
              onClick={() => setMapView('list')}
              className={`px-4 py-2 rounded-md font-medium transition-colors ${
                mapView === 'list'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              List View
            </button>
          </div>
        </div>

        {/* Last Refresh Info */}
        <div className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Last refreshed: {lastRefresh ? lastRefresh.toLocaleTimeString() : '—'}
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="modern-card p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Nodes</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{nodes.length}</p>
              </div>
              <Icon name="globe" size={28} className="text-gray-400 dark:text-gray-500" />
            </div>
          </div>
          <div className="modern-card p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Online</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {nodes.filter(n => n.status === 'online').length}
                </p>
              </div>
              <Icon name="check" size={28} className="text-green-500" />
            </div>
          </div>
          <div className="modern-card p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Offline</p>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400">
                  {nodes.filter(n => n.status === 'offline').length}
                </p>
              </div>
              <Icon name="x" size={28} className="text-red-500" />
            </div>
          </div>
          <div className="modern-card p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Warning</p>
                <p className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                  {nodes.filter(n => n.status === 'warning').length}
                </p>
              </div>
              <Icon name="warning" size={28} className="text-yellow-500" />
            </div>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin"></div>
            <p className="ml-4 text-gray-500 dark:text-gray-400">Loading network map...</p>
          </div>
        ) : (
          <>
            {mapView === 'map' ? (
              <div className="modern-card p-6">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Network Topology</h2>
                  <div
                    role="group"
                    aria-label="Basemap"
                    className="inline-flex w-fit rounded-lg border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-900"
                  >
                    {([
                      ['osm', 'OpenStreetMap'],
                      ['google', 'Google Maps']
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={basemap === value}
                        onClick={() => handleBasemapChange(value)}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                          basemap === value
                            ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-700 dark:text-blue-300'
                            : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="h-[500px] rounded-md overflow-hidden">
                  <div ref={mapContainerRef} className="w-full h-full" />
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-4 text-center">
                  Hover pin untuk lihat detail cepat. Klik pin untuk membuka detail lengkap.
                </p>
              </div>
            ) : (
              <div className="modern-card p-6">
                <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Network Nodes</h2>
                <div className="overflow-x-auto">
                  <table className="modern-table">
                    <thead>
                      <tr>
                        <th>Node ID</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Details</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodes.map((node) => (
                        <tr key={node.id}>
                          <td className="font-mono text-sm">{node.node_id}</td>
                          <td>{node.name}</td>
                          <td>
                            <div className="flex items-center space-x-2">
                              <Icon name={getNodeIconName(node.type)} size={18} className="text-gray-500 dark:text-gray-400" />
                              <span>{getTypeLabel(node.type)}</span>
                            </div>
                          </td>
                          <td>{getStatusBadge(node.status)}</td>
                          <td className="text-sm">
                            {node.capacity && <div>Capacity: {node.capacity}</div>}
                            {node.splitter && <div>Splitter: {node.splitter}</div>}
                            {node.pppoe && <div>PPPoE: {node.pppoe}</div>}
                          </td>
                          <td>
                            <button
                              onClick={() => setSelectedNode(node)}
                              className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              View Details
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* Node Details Modal */}
        {selectedNode && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-md p-6 max-w-md w-full">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {selectedNode.name}
                </h3>
                <button
                  onClick={() => setSelectedNode(null)}
                  aria-label="Close"
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <Icon name="x" size={20} />
                </button>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Node ID:</span>
                  <span className="font-mono text-sm">{selectedNode.node_id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Type:</span>
                  <span>{getTypeLabel(selectedNode.type)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Status:</span>
                  {getStatusBadge(selectedNode.status)}
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Location:</span>
                  <span className="text-sm">{selectedNode.latitude}, {selectedNode.longitude}</span>
                </div>
                {selectedNode.capacity && (
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Capacity:</span>
                    <span>{selectedNode.capacity}</span>
                  </div>
                )}
                {selectedNode.splitter && (
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Splitter:</span>
                    <span>{selectedNode.splitter}</span>
                  </div>
                )}
                {selectedNode.pppoe && (
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">PPPoE:</span>
                    <span className="text-sm">{selectedNode.pppoe}</span>
                  </div>
                )}
              </div>
              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setSelectedNode(null)}
                  className="modern-button-secondary"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
