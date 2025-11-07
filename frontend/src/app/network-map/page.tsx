'use client'

import { useState, useEffect, useRef } from 'react'
import { useTheme } from '@/contexts/theme-context'

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

export default function NetworkMap() {
  const [nodes, setNodes] = useState<MapNode[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedNode, setSelectedNode] = useState<MapNode | null>(null)
  const [mapView, setMapView] = useState<'map' | 'list'>('map')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const { isDarkMode } = useTheme()

  // Leaflet map refs
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markersLayerRef = useRef<any>(null)
  const tileLayerRef = useRef<any>(null)
  const leafletRef = useRef<any>(null)
  const refreshTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      const mockNodes: MapNode[] = [
        {
          id: 1,
          node_id: 'SRV-001',
          type: 'server',
          name: 'Main Server',
          latitude: -6.2088,
          longitude: 106.8456,
          status: 'online'
        },
        {
          id: 2,
          node_id: 'ODC-001',
          type: 'odc',
          name: 'Central Distribution Cabinet',
          latitude: -6.2108,
          longitude: 106.8476,
          capacity: 144,
          status: 'online'
        },
        {
          id: 3,
          node_id: 'ODP-001',
          type: 'odp',
          name: 'Distribution Point A',
          latitude: -6.2128,
          longitude: 106.8496,
          splitter: '1:16',
          status: 'online'
        },
        {
          id: 4,
          node_id: 'ODP-002',
          type: 'odp',
          name: 'Distribution Point B',
          latitude: -6.2148,
          longitude: 106.8436,
          splitter: '1:8',
          status: 'warning'
        },
        {
          id: 5,
          node_id: 'ONT-001',
          type: 'ont',
          name: 'Customer A',
          latitude: -6.2138,
          longitude: 106.8506,
          pppoe: 'customer-a@isp.com',
          status: 'online'
        },
        {
          id: 6,
          node_id: 'ONT-002',
          type: 'ont',
          name: 'Customer B',
          latitude: -6.2158,
          longitude: 106.8426,
          pppoe: 'customer-b@isp.com',
          status: 'offline'
        },
        {
          id: 7,
          node_id: 'ONT-003',
          type: 'ont',
          name: 'Customer C',
          latitude: -6.2118,
          longitude: 106.8516,
          pppoe: 'customer-c@isp.com',
          status: 'online'
        }
      ]
      setNodes(mockNodes)
      setLoading(false)
    }, 1500)

    return () => clearTimeout(timer)
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
    setLastRefresh(new Date())
  }, [])
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markersLayerRef.current = null
        tileLayerRef.current = null
      }
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [])

  const getTileUrlAndAttrib = (dark: boolean) => {
    if (dark) {
      return {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
      }
    }
    return {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors'
    }
  }

  const updateTileLayer = () => {
    const L: any = leafletRef.current
    const map: any = mapRef.current
    if (!L || !map) return
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
      tileLayerRef.current = null
    }
    const { url, attribution } = getTileUrlAndAttrib(isDarkMode)
    tileLayerRef.current = L.tileLayer(url, { attribution })
    tileLayerRef.current.addTo(map)
  }

  const updateMarkers = () => {
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
      const html = `<div style="font-size:22px;line-height:22px;position:relative;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${getNodeIcon(n.type)}<span style="position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;background:${getStatusHex(n.status)};border-radius:9999px;border:2px solid ${isDarkMode ? '#111827' : '#ffffff'};"></span></div>`
      const icon = L.divIcon({
        className: '',
        html,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      })
      const marker = L.marker([n.latitude, n.longitude], { icon })
      marker.addTo(group)
      marker.bindTooltip(
        `<div><strong>${n.name}</strong><br/>${getTypeLabel(n.type)} · ${n.status}</div>`,
        { direction: 'top', sticky: true, opacity: isDarkMode ? 0.95 : 0.9 }
      )
      marker.on('click', () => setSelectedNode(n))
      bounds.extend([n.latitude, n.longitude])
    })

    if (nodes.length > 0) {
      map.fitBounds(bounds.pad(0.2))
    }
  }

  // Initialize Leaflet map when switching to Map view
  useEffect(() => {
    if (mapView !== 'map') return
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
        const center: [number, number] = [-6.2088, 106.8456] // Jakarta
        const map = L.map(mapContainerRef.current, {
          center,
          zoom: 12,
        })
        mapRef.current = map
        updateTileLayer()
        markersLayerRef.current = L.layerGroup().addTo(map)
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
  }, [mapView])

  // Update tile layer on theme change
  useEffect(() => {
    if (mapRef.current && mapView === 'map') {
      updateTileLayer()
    }
  }, [isDarkMode, mapView])

  // Update markers when nodes change
  useEffect(() => {
    if (mapRef.current && mapView === 'map') {
      updateMarkers()
    }
  }, [nodes, mapView])

  const handleRefresh = () => {
    setLoading(true)
    setLastRefresh(new Date())
    // Simulate API call to refresh network nodes
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
    }
    refreshTimerRef.current = window.setTimeout(() => {
      const mockNodes: MapNode[] = [
        {
          id: 1,
          node_id: 'SRV-001',
          type: 'server',
          name: 'Main Server',
          latitude: -6.2088,
          longitude: 106.8456,
          status: 'online'
        },
        {
          id: 2,
          node_id: 'ODC-001',
          type: 'odc',
          name: 'Central Distribution Cabinet',
          latitude: -6.2108,
          longitude: 106.8476,
          capacity: 144,
          status: 'online'
        },
        {
          id: 3,
          node_id: 'ODP-001',
          type: 'odp',
          name: 'Distribution Point A',
          latitude: -6.2128,
          longitude: 106.8496,
          splitter: '1:16',
          status: 'online'
        },
        {
          id: 4,
          node_id: 'ODP-002',
          type: 'odp',
          name: 'Distribution Point B',
          latitude: -6.2148,
          longitude: 106.8436,
          splitter: '1:8',
          status: 'warning'
        },
        {
          id: 5,
          node_id: 'ONT-001',
          type: 'ont',
          name: 'Customer A',
          latitude: -6.2138,
          longitude: 106.8506,
          pppoe: 'customer-a@isp.com',
          status: 'online'
        },
        {
          id: 6,
          node_id: 'ONT-002',
          type: 'ont',
          name: 'Customer B',
          latitude: -6.2158,
          longitude: 106.8426,
          pppoe: 'customer-b@isp.com',
          status: 'offline'
        },
        {
          id: 7,
          node_id: 'ONT-003',
          type: 'ont',
          name: 'Customer C',
          latitude: -6.2118,
          longitude: 106.8516,
          pppoe: 'customer-c@isp.com',
          status: 'online'
        }
      ]
      setNodes(mockNodes)
      setLoading(false)
      refreshTimerRef.current = null
    }, 1000)
  }

  const getNodeIcon = (type: string) => {
    switch (type) {
      case 'server':
        return '🖥️'
      case 'odc':
        return '🏢'
      case 'odp':
        return '📦'
      case 'ont':
        return '🏠'
      default:
        return '📍'
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500'
      case 'offline':
        return 'bg-red-500'
      case 'warning':
        return 'bg-yellow-500'
      default:
        return 'bg-gray-500'
    }
  }

  const getStatusHex = (status: string) => {
    switch (status) {
      case 'online':
        return '#22c55e' // green-500
      case 'offline':
        return '#ef4444' // red-500
      case 'warning':
        return '#f59e0b' // amber-500
      default:
        return '#6b7280' // gray-500
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

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'server':
        return 'Server'
      case 'odc':
        return 'ODC'
      case 'odp':
        return 'ODP'
      case 'ont':
        return 'ONT'
      default:
        return 'Unknown'
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
              className="px-4 py-2 rounded-lg font-medium transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : '🔄 Refresh'}
            </button>
            <button
              onClick={() => setMapView('map')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                mapView === 'map'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Map View
            </button>
            <button
              onClick={() => setMapView('list')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
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
              <div className="text-3xl">🌐</div>
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
              <div className="text-3xl">✅</div>
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
              <div className="text-3xl">❌</div>
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
              <div className="text-3xl">⚠️</div>
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
                <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Network Topology</h2>
                <div className="h-[500px] rounded-lg overflow-hidden">
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
                              <span>{getNodeIcon(node.type)}</span>
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
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {selectedNode.name}
                </h3>
                <button
                  onClick={() => setSelectedNode(null)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  ✕
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
              <div className="flex justify-end space-x-2 mt-6">
                <button
                  onClick={() => setSelectedNode(null)}
                  className="modern-button-secondary"
                >
                  Close
                </button>
                <button className="modern-button">
                  Edit Node
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}