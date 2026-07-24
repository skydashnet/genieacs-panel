// Authentication Types
export interface User {
  id: number
  username: string
  role: string
  createdAt: string
  updatedAt: string
}

export interface LoginResponse {
  user: User
  token: string
  refreshToken: string
}

// Device Types
export interface Device {
  _id: string
  SerialNumber: string | null
  productclass: string | null
  pppoe?: string
  wanbridge?: string
  rxpower?: number | null
  temperature?: number | null
  activedevices?: number | null
  ssid1?: string | null
  ssid2?: string | null
  ssid3?: string | null
  ssid4?: string | null
  ssid5?: string | null
  ssid6?: string | null
  ssid7?: string | null
  ssid8?: string | null
  _lastInform?: string
  manufacturer?: string | null
  _registered?: string | null
}

export interface DeviceDetail {
  _id: string
  _deviceId: {
    _Manufacturer?: string
    _OUI?: string
    _ProductClass?: string
    _SerialNumber?: string
  }
  InternetGatewayDevice?: any
  _lastInform?: string
  [key: string]: any
}

// Dashboard Types
export interface DashboardMetric {
  name: string
  value: number
  status: 'up' | 'down' | 'warning'
  change: number
}

export interface ConnectionHistoryData {
  labels: string[]
  series: {
    name: string
    data: number[]
  }[]
}

export interface ConnectionType {
  name: string
  value: number
}

export interface Event {
  id: number
  event: string
  count: number
}

export interface RecentDevice {
  id: string
  model: string
  serial: string
  provisionDate: string
}

export interface RxPowerDistribution {
  labels: string[]
  series: number[]
  colors: string[]
}

export interface DashboardData {
  metrics: DashboardMetric[]
  connectionHistory: ConnectionHistoryData
  connectionTypes: ConnectionType[]
  connectionTypesChart: {
    labels: string[]
    series: {
      name: string
      data: number[]
    }[]
    colors: string[]
    totalDevices: number
  }
  events: Event[]
  recentDevices: RecentDevice[]
  rxPowerDistribution: RxPowerDistribution
}

// Vendor Management Types
export interface Vendor {
  id: number
  name: string
  manufacturer_patterns: string[]
  product_patterns: string[]
  parameter_prefix?: string
  service_list_path?: string
  lan_binding_path?: string
  vlan_id_path?: string
  wifi_password_path?: string
  http_wan_enable_path?: string
  firewall_level_path?: string
  priority: number
  enabled: number
  description?: string
  created_at: string
  updated_at: string
}

export interface VendorSubType {
  id: number
  vendor_id: number
  sub_type_name: string
  detection_patterns: Record<string, any>
  parameter_prefix?: string
  priority: number
  enabled: number
  description?: string
  created_at: string
  updated_at: string
}

export interface VendorParameter {
  id: number
  vendor_id: number
  sub_type_id?: number
  category: string
  param_name: string
  parameter_path: string
  priority: number
  enabled: number
  fallback_to_null: number
  description?: string
  created_at: string
  updated_at: string
}

export interface WifiSecurityMapping {
  id: number
  vendor_id: number
  raw_security_value: string
  normalized_security: string
  description?: string
  created_at: string
  updated_at: string
}

export interface WifiSecurityConfig {
  id: number
  product_class: string
  security_types: string
  security_types_array: string[]
  password_param_path: string
  created_at: string
  updated_at: string
}

// Settings Types
export interface Settings {
  appName: string
  genieAcsUrl: string
  [key: string]: string
}

export interface VirtualParameters {
  vpPppoeUsername: string
  vpWanBridge: string
  vpRxPower: string
  vpTemperature: string
  vpActiveDevices: string
  vpSuperAdmin: string
  vpSuperPassword: string
  vpUserAdmin: string
  vpUserPassword: string
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  error?: string
  details?: any
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// Form Types
export interface DeviceConfigForm {
  deviceId: string
  parameters: {
    path: string
    value: any
    type?: string
  }[]
}

export interface WifiConfigForm {
  deviceId: string
  ssid?: string
  password?: string
  security?: string
  enabled?: boolean
}

export interface WanConfigForm {
  deviceId: string
  serviceList?: string
  vlanId?: string
  lanBinding?: string
}

// Map Types
export interface MapSettings {
  center_lat: string
  center_lng: string
  max_zoom_in: string
  max_zoom_out: string
  default_zoom: string
}

export interface MapNode {
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
  created_at: string
  updated_at: string
}

export interface MapEdge {
  id: number
  edge_id: string
  source: string
  target: string
  fiber_type?: 'feeder' | 'distribution' | 'drop'
  distance?: number
  waypoints?: string
  notes?: string
  created_at: string
  updated_at: string
}

// Task Types
export interface Task {
  _id: string
  name: string
  device: string
  timestamp: string
  status: string
  [key: string]: any
}

export interface Fault {
  _id: string
  device: string
  fault_code: string
  message: string
  timestamp: string
  severity: string
  [key: string]: any
}
