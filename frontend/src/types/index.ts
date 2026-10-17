// Authentication Types

/**
 * Os quatro papéis vivem em `@/lib/permissions`, junto da matriz que diz o que
 * cada um alcança. Reexportado aqui porque este é o módulo onde o resto do
 * painel já procura os tipos, e um papel escrito solto ao lado da matriz seria
 * a primeira coisa a divergir dela.
 */
export type { OperatorRole } from '@/lib/permissions'
import type { OperatorRole } from '@/lib/permissions'

export interface User {
  id: number
  username: string
  /**
   * O e-mail de login, que pode ser `null`.
   *
   * Nulo não é ausência de dado: é uma conta anterior a esta versão, criada
   * quando a coluna não existia e nenhuma migração podia adivinhar o endereço.
   * São essas contas que a tela de operadores precisa deixar visíveis, porque é
   * o número delas que decide quando o login pode passar a exigir e-mail.
   *
   * Opcional porque nem toda resposta do backend traz o campo: `GET
   * /api/auth/user` responde sem ele.
   */
  email?: string | null
  /**
   * Se o endereço acima foi PROVADO — alguém abriu o que foi mandado para ele.
   *
   * Cadastrar um endereço prova que se controla a conta, não que se controla o
   * endereço, e a diferença é o que decide se a redefinição de senha por e-mail
   * vai funcionar para esta pessoa no dia em que ela precisar — um dia em que
   * ela, por definição, não vai poder resolver. Daí a tela de conta insistir
   * enquanto isto for falso.
   *
   * Opcional pelo mesmo motivo de `email`: nem toda resposta traz o campo.
   */
  emailVerified?: boolean
  /** Se o login em duas etapas está ligado — só isso; o segredo nunca vem. */
  mfaEnabled?: boolean
  /**
   * O provedor desta sessão exige o 2FA e esta pessoa ainda não ativou: a
   * casca do painel dá lugar à ativação até ela ativar.
   */
  mfaEnrollmentRequired?: boolean
  /**
   * O papel NO PROVEDOR desta sessão — e `null` quando ela não tem provedor.
   *
   * A sessão do console é esse caso: ela não trabalha em provedor nenhum, então
   * não há papel a reportar. Nulo e não um papel de reserva, porque um papel de
   * reserva é o que uma tela acaba consultando como se valesse.
   */
  role: OperatorRole | null
  /**
   * Whether this person is on the SaaS control plane's roster.
   *
   * NOT the same thing as being an administrator here: a provider's own
   * administrator — `owner` included — is at the provider's level, and the
   * control plane is above them, since minting providers and reaching between
   * them is exactly what a provider's admin must not do.
   * Gating the menu on `role` would put the link in front of most of the
   * panel's admins, pointing at routes that answer 404 for them.
   *
   * Always false on a self-hosted install, where those routes are not mounted
   * at all — so the screen hides itself without the browser having to know
   * which edition it is talking to.
   */
  isPlatformAdmin?: boolean
  /**
   * Presente só na sessão do console: esta sessão é DA PLATAFORMA e não de um
   * provedor.
   *
   * Separado de `isPlatformAdmin`, que responde outra pergunta — quem tem a
   * chave do console também trabalha em provedores, e ali a sessão é comum. É
   * isto, e não um `tenantId` nulo, que diz à casca qual árvore de telas montar:
   * deduzir de uma ausência é a dedução que um dia alguém faz errado.
   */
  platform?: boolean
  /**
   * O provedor DESTA sessão, lido do token pelo backend — o que o topo do menu
   * mostra. Nulo na sessão do console. Opcional porque só `GET /api/auth/user`
   * traz o campo; até ele responder, a tela usa o perfil público do host.
   */
  tenant?: { slug: string | null; name: string } | null
  /** O id do provedor desta sessão; nulo na sessão do console. */
  tenantId?: number | null
  /**
   * Presente só numa sessão de personificação: quem, do plano de controle,
   * está olhando este painel.
   *
   * É o que a faixa no alto da tela lê. `isPlatformAdmin` vem `false` junto,
   * de propósito e sem contradição: dentro de uma personificação o console
   * responde 404, então acender o menu dele seria apontar para uma tela que
   * não abre.
   */
  impersonation?: {
    platformUsername: string
    /**
     * O provedor que está sendo olhado, pelo NOME que a sessão carrega.
     *
     * Não vem do perfil público porque aquele é resolvido pelo endereço, e numa
     * instalação de host único o endereço nomeia sempre o primeiro provedor —
     * a faixa diria o nome errado justamente na tela onde ela existe para dizer
     * o certo. Opcional porque uma sessão aberta antes desta mudança não o traz.
     */
    tenantName?: string
    tenantSlug?: string
  } | null
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
  softwareId?: string | null
  customerId?: string | null
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
