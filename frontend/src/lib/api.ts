const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  error?: string
}

class ApiClient {
  private baseURL: string
  private token: string | null = null

  constructor(baseURL: string) {
    this.baseURL = baseURL
    this.token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
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

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          message: data.message || 'Request failed',
          error: data.error || 'Unknown error',
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

  setToken(token: string) {
    this.token = token
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token)
    }
  }

  removeToken() {
    this.token = null
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token')
    }
  }
}

export const apiClient = new ApiClient(API_BASE_URL)

// Authentication API
export const authAPI = {
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
    apiClient.get(`/devices/${deviceId}`),
  
  deleteDevice: (deviceId: string) =>
    apiClient.delete(`/devices/${deviceId}`),
  
  rebootDevice: (deviceId: string) =>
    apiClient.post('/devices/reboot', { deviceId }),
  
  summonDevice: (deviceId: string, parameters?: string[]) =>
    apiClient.post('/devices/summon', { deviceId, parameters }),
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

// Vendors API
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
  
  getWifiSecurityMappings: (vendorId: number) =>
    apiClient.get(`/vendor-management/${vendorId}/wifi-security`),
  
  createWifiSecurityMapping: (mappingData: any) =>
    apiClient.post('/vendor-management/wifi-security', mappingData),
  
  updateWifiSecurityMapping: (id: number, mappingData: any) =>
    apiClient.put(`/vendor-management/wifi-security/${id}`, mappingData),
  
  deleteWifiSecurityMapping: (id: number) =>
    apiClient.delete(`/vendor-management/wifi-security/${id}`),
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
    apiClient.post('/mapping-data/reset', { password }),
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