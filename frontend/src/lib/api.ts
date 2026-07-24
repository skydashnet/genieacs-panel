const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || ''

export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  error?: string
  code?: string
}

class ApiClient {
  private baseURL: string
  private token: string | null = null
  private refreshToken: string | null = null
  private refreshPromise: Promise<boolean> | null = null

  constructor(baseURL: string) {
    this.baseURL = baseURL
    this.token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
    this.refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryAfterRefresh = true
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseURL}/api${endpoint}`
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      })

      const contentType = response.headers.get('content-type') || ''
      const data = contentType.includes('application/json')
        ? await response.json()
        : { message: await response.text() }

      if (
        response.status === 403 &&
        data.code === 'invalid_token' &&
        retryAfterRefresh &&
        !['/auth/refresh', '/auth/login', '/auth/setup'].includes(endpoint)
      ) {
        const refreshed = await this.refreshAccessToken()
        if (refreshed) {
          return this.request<T>(endpoint, options, false)
        }
      }

      if (!response.ok) {
        return {
          success: false,
          message: data.message || 'Request failed',
          error: data.error || 'Unknown error',
          code: data.code,
        }
      }

      return data
    } catch (error) {
      return {
        success: false,
        message: 'Network error occurred',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false
    if (this.refreshPromise) return this.refreshPromise

    this.refreshPromise = (async () => {
      try {
        const response = await fetch(`${this.baseURL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        })
        const data = await response.json()
        if (!response.ok || !data.success || !data.data?.token || !data.data?.refreshToken) {
          this.clearTokens()
          return false
        }
        this.setTokens(data.data.token, data.data.refreshToken)
        return true
      } catch {
        this.clearTokens()
        return false
      } finally {
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
  }

  async get<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: any): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: any): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }

  async requestWithBody<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    endpoint: string,
    data?: unknown
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
    })
  }

  setTokens(token: string, refreshToken?: string) {
    this.token = token
    if (refreshToken !== undefined) {
      this.refreshToken = refreshToken
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token)
      if (refreshToken !== undefined) {
        localStorage.setItem('refreshToken', refreshToken)
      }
    }
  }

  clearTokens() {
    this.token = null
    this.refreshToken = null
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
  }
}

export const apiClient = new ApiClient(API_BASE_URL)

// Authentication API
export const authAPI = {
  getSetupStatus: () =>
    apiClient.get('/auth/setup-status'),

  setupAdmin: (username: string, password: string) =>
    apiClient.post('/auth/setup', { username, password }),

  login: (username: string, password: string) =>
    apiClient.post('/auth/login', { username, password }),
  
  getCurrentUser: () =>
    apiClient.get('/auth/user'),
  
  logout: () =>
    apiClient.post('/auth/logout'),
  
  refreshToken: (refreshToken: string) =>
    apiClient.post('/auth/refresh', { refreshToken }),
  
  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.post('/auth/change-password', { currentPassword, newPassword }),
  
  changeUsername: (currentUsername: string, newUsername: string) =>
    apiClient.post('/auth/change-username', { currentUsername, newUsername }),
}

// Devices API
export const devicesAPI = {
  getDevices: () =>
    apiClient.get('/devices'),
  
  getDevice: (deviceId: string) =>
    apiClient.get(`/devices/${encodeURIComponent(deviceId)}`),
  
  deleteDevice: (deviceId: string) =>
    apiClient.delete(`/devices/${encodeURIComponent(deviceId)}`),
  
  rebootDevice: (deviceId: string) =>
    apiClient.post('/devices/reboot', { deviceId }),
  
  summonDevice: (deviceId: string, parameters?: string[]) =>
    apiClient.post('/devices/summon', { deviceId, parameters }),

  updateWanConfig: (deviceId: string, wanIndex: string, formData: any) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-wan`, { wanIndex, formData });
  },

  updateCredentials: (deviceId: string, type: 'super' | 'user', password: string) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-credentials`, { type, password });
  }
}

// Settings API
export const settingsAPI = {
  getAll: () =>
    apiClient.get('/settings'),
  
  get: (key: string) =>
    apiClient.get(`/settings/${key}`),
  
  create: (key: string, value: string) =>
    apiClient.post('/settings', { key, value }),
  
  update: (key: string, value: string) =>
    apiClient.put(`/settings/${key}`, { value }),
  
  delete: (key: string) =>
    apiClient.delete(`/settings/${key}`),
  
  testGenieAcs: (url: string) =>
    apiClient.post('/settings/test-genieacs', { url }),
}

/* Vendors API */
export const vendorsAPI = {
  getAll: () =>
    apiClient.get('/vendor-management'),

  get: (id: number) =>
    apiClient.get(`/vendor-management/${id}`),

  create: (vendorData: any) =>
    apiClient.post('/vendor-management', vendorData),

  update: (id: number, vendorData: any) =>
    apiClient.put(`/vendor-management/${id}`, vendorData),

  delete: (id: number) =>
    apiClient.delete(`/vendor-management/${id}`),

  // WiFi security mappings per vendor
  getWifiSecurityMappings: (vendorId: number) =>
    apiClient.get(`/vendor-management/${vendorId}/wifi-security`),

  createWifiSecurityMapping: (vendorId: number, mappingData: any) =>
    apiClient.post(`/vendor-management/${vendorId}/wifi-security`, mappingData),

  updateWifiSecurityMapping: (id: number, mappingData: any) =>
    apiClient.put(`/vendor-management/wifi-security/${id}`, mappingData),

  deleteWifiSecurityMapping: (id: number) =>
    apiClient.delete(`/vendor-management/wifi-security/${id}`),

  // WiFi security configs (by product class)
  getAllWifiSecurityConfigs: () =>
    apiClient.get('/vendor-management/wifi-security-configs'),

  getWifiSecurityConfig: (id: number) =>
    apiClient.get(`/vendor-management/wifi-security-configs/${id}`),

  getWifiSecurityConfigByProductClass: (productClass: string) =>
    apiClient.get(`/vendor-management/wifi-security-configs/by-product-class/${encodeURIComponent(productClass)}`),

  createWifiSecurityConfig: (configData: any) =>
    apiClient.post('/vendor-management/wifi-security-configs', configData),

  updateWifiSecurityConfig: (id: number, configData: any) =>
    apiClient.put(`/vendor-management/wifi-security-configs/${id}`, configData),

  deleteWifiSecurityConfig: (id: number) =>
    apiClient.delete(`/vendor-management/wifi-security-configs/${id}`),
}

// Mapping API
export const mappingAPI = {
  getNodes: () =>
    apiClient.get('/mapping-data/nodes'),
  
  getNode: (nodeId: string) =>
    apiClient.get(`/mapping-data/nodes/${nodeId}`),
  
  createNode: (nodeData: any) =>
    apiClient.post('/mapping-data/nodes', nodeData),
  
  updateNode: (nodeId: string, nodeData: any) =>
    apiClient.put(`/mapping-data/nodes/${nodeId}`, nodeData),
  
  deleteNode: (nodeId: string) =>
    apiClient.delete(`/mapping-data/nodes/${nodeId}`),
  
  getEdges: () =>
    apiClient.get('/mapping-data/edges'),
  
  getEdge: (edgeId: string) =>
    apiClient.get(`/mapping-data/edges/${edgeId}`),
  
  createEdge: (edgeData: any) =>
    apiClient.post('/mapping-data/edges', edgeData),
  
  updateEdge: (edgeId: string, edgeData: any) =>
    apiClient.put(`/mapping-data/edges/${edgeId}`, edgeData),
  
  deleteEdge: (edgeId: string) =>
    apiClient.delete(`/mapping-data/edges/${edgeId}`),
  
  syncData: (data: { nodes: any[], edges: any[] }) =>
    apiClient.post('/mapping-data/sync', data),
  
  resetData: (password: string) =>
    apiClient.requestWithBody('DELETE', '/mapping-data/reset', { password }),
}

// Map Settings API
export const mapSettingsAPI = {
  get: () =>
    apiClient.get('/map-settings'),
  
  update: (settings: any) =>
    apiClient.put('/map-settings', settings),
  
  reset: () =>
    apiClient.post('/map-settings/reset'),
}

export interface DbConfigPayload {
  client: 'sqlite3' | 'mysql2'
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  migrateData?: boolean
}

export const databaseAPI = {
  getConfig: () =>
    apiClient.get('/database/config'),

  test: (config: DbConfigPayload) =>
    apiClient.post('/database/test', config),

  switch: (config: DbConfigPayload) =>
    apiClient.post('/database/switch', config),
}
