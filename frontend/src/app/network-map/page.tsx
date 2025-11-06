'use client'

import { useState, useEffect } from 'react'
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
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const { isDarkMode } = useTheme()

  useEffect(() => {
    // Simulate API call to fetch network nodes
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

  const handleRefresh = () => {
    setLoading(true)
    setLastRefresh(new Date())
    // Simulate API call to refresh network nodes
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
    }, 1000)

    return () => clearTimeout(timer)
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
          Last refreshed: {lastRefresh.toLocaleTimeString()}
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
                <div className="h-96 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center relative overflow-hidden">
                  {/* Simple network visualization */}
                  <div className="absolute inset-0 p-8">
                    <div className="relative w-full h-full">
                      {/* Server */}
                      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                        <div className="relative">
                          <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-2xl border-2 border-blue-500">
                            🖥️
                          </div>
                          <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white dark:border-gray-900"></div>
                        </div>
                        <p className="text-xs text-center mt-2 font-medium">Main Server</p>
                      </div>

                      {/* ODC */}
                      <div className="absolute top-1/4 left-1/4">
                        <div className="relative">
                          <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center text-xl border-2 border-gray-500">
                            🏢
                          </div>
                          <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-gray-900"></div>
                        </div>
                        <p className="text-xs text-center mt-1">ODC</p>
                      </div>

                      {/* ODP */}
                      <div className="absolute top-3/4 left-1/4">
                        <div className="relative">
                          <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center text-lg border-2 border-gray-500">
                            📦
                          </div>
                          <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full border-2 border-white dark:border-gray-900"></div>
                        </div>
                        <p className="text-xs text-center mt-1">ODP</p>
                      </div>

                      {/* ONTs */}
                      <div className="absolute top-1/4 right-1/4">
                        <div className="relative">
                          <div className="w-8 h-8 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center text-base border-2 border-gray-500">
                            🏠
                          </div>
                          <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-green-500 rounded-full border-2 border-white dark:border-gray-900"></div>
                        </div>
                        <p className="text-xs text-center mt-1">ONT</p>
                      </div>

                      <div className="absolute top-3/4 right-1/4">
                        <div className="relative">
                          <div className="w-8 h-8 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center text-base border-2 border-gray-500">
                            🏠
                          </div>
                          <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-red-500 rounded-full border-2 border-white dark:border-gray-900"></div>
                        </div>
                        <p className="text-xs text-center mt-1">ONT</p>
                      </div>

                      {/* Connection lines */}
                      <svg className="absolute inset-0 w-full h-full pointer-events-none">
                        <line x1="50%" y1="50%" x2="25%" y2="25%" stroke="#9CA3AF" strokeWidth="2" />
                        <line x1="25%" y1="25%" x2="25%" y2="75%" stroke="#9CA3AF" strokeWidth="2" />
                        <line x1="25%" y1="75%" x2="75%" y2="75%" stroke="#9CA3AF" strokeWidth="2" />
                        <line x1="25%" y1="25%" x2="75%" y2="25%" stroke="#9CA3AF" strokeWidth="2" />
                      </svg>
                    </div>
                  </div>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-4 text-center">
                  Interactive network topology visualization. Click on nodes for details.
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