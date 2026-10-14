import type { ConversationBilling } from '@/lib/wa-billing-status'
import type { NotificationItem } from '@/lib/wa-notify'
import { getActiveLocale, translate } from '@/lib/i18n'
import type { LoginResponse, OperatorRole, User } from '@/types'
import { MFA_ENROLLMENT_EVENT, isMfaEnrollmentRefusal } from '@/lib/mfa-enrollment'
import type { LiveStatus } from '@/lib/map-status'
import { offlineMessageKey } from '@/lib/genieacs-agent'
import { firmwareUploadHeaders, type FirmwareMeta } from '@/lib/firmware'
import { formatRelativeTime } from '@/lib/utils'
import { clearSessionScopedStorage } from '@/lib/session-owner'
import { crossTabTokenAction } from '@/lib/cross-tab-session'

// Acima de `apiClient`, que o dispara: um `const` de módulo lido antes da
// declaração é uma ReferenceError no primeiro 402.
export const SUBSCRIPTION_BLOCKED_EVENT = 'skygp:subscription-blocked'
export interface SubscriptionBlockedDetail {
  code: SubscriptionGateCode
  message: string
  subscription: SubscriptionView | null
}

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

export type DeviceBatchAction = 'reboot' | 'firmware' | 'inform'

export interface DeviceBatchResult {
  deviceId: string
  /** `sent`: o ACS aplicou; `queued`: espera a ONT se conectar; `failed`: ver `reason`. */
  outcome: 'sent' | 'queued' | 'failed'
  reason: 'not_found' | 'acs_error' | 'refused' | 'firmware_not_compatible' | 'firmware_already_installed' | null
}

export interface DeviceBatchResponse {
  action: DeviceBatchAction
  summary: { total: number; sent: number; queued: number; failed: number }
  results: DeviceBatchResult[]
  /** O arquivo mandado, no firmware em lote. */
  file?: Omit<DeviceFirmwareFile, 'installed'> | null
}

/** Os firmwares que dizem o modelo — a lista do lote — e quantos não dizem. */
export interface DeviceFirmwareCatalog {
  files: Omit<DeviceFirmwareFile, 'installed'>[]
  unclassified: number
}

export interface DeviceFirmwareFile {
  /** O id do arquivo no GenieACS — em geral o nome com que foi subido. */
  id: string
  version: string | null
  oui: string | null
  productClass: string | null
  size: number | null
  uploadedAt: string | null
  /** É a versão que a ONT já roda. */
  installed: boolean
}

/** Um arquivo de firmware do GenieACS como o servidor o mostra (`publicFile`). */
export type FirmwareFileInfo = Omit<DeviceFirmwareFile, 'installed'>

/**
 * Os firmwares do ACS compartilhado que não carregam o prefixo de nenhum
 * provedor — os que existiam antes do escopo. `tag` é a tag deste provedor, que
 * vira o prefixo `<tag>--` no reenvio; `shared` diz se o ACS é dividido.
 */
export interface TenantUnownedFirmware {
  tag: string | null
  shared: boolean
  files: FirmwareFileInfo[]
}

export interface DeviceFirmwareList {
  deviceId: string
  current: string | null
  productClass: string | null
  files: DeviceFirmwareFile[]
  /** Firmwares no GenieACS que ficaram de fora por serem de outro modelo, ou não dizerem o modelo. */
  otherModels: number
}

export interface DeviceFirmwareUpgrade {
  deviceId: string
  file: DeviceFirmwareFile
  from: string | null
  queued: boolean
}

export type DeviceDiagnosticKind = 'ping' | 'traceroute'

export interface DeviceDiagnosticStart {
  deviceId: string
  kind: DeviceDiagnosticKind
  root: 'InternetGatewayDevice' | 'Device'
  host: string
  /** A ONT não recebeu agora: o pedido ficou na fila do ACS até ela se conectar. */
  queued: boolean
}

export interface DeviceDiagnosticHop {
  hop: number
  host: string | null
  address: string | null
  times: number[]
  error: number | null
}

export interface DeviceDiagnosticResult {
  deviceId: string
  kind: DeviceDiagnosticKind
  root: 'InternetGatewayDevice' | 'Device'
  state: 'idle' | 'running' | 'complete' | 'error'
  /** O `Error_*` que a ONT reportou, inteiro. */
  error: string | null
  host: string | null
  /** Quando o ACS leu o estado pela última vez — o resultado pode ser de antes. */
  measuredAt: string | null
  ping: {
    success: number | null
    failure: number | null
    average: number | null
    minimum: number | null
    maximum: number | null
  } | null
  hops: DeviceDiagnosticHop[] | null
  responseTime: number | null
}

export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  error?: string
  code?: string
  /**
   * Only on a refusal, and only where the route has a breakdown to offer: the
   * billing build attaches it to its 409 so "every one of them is on the
   * do-not-disturb list" survives the failure. A refusal has no `data`, so
   * without this the reason is lost inside a bare status code.
   */
  skipped?: Record<string, number>
  /**
   * Only on a 402 from the subscription gate: the provider's plan and state,
   * so the screen that shows the wall can also show what is behind it.
   */
  subscription?: SubscriptionView | null
  /** Only on a 402 for a plan limit: the ceiling and where the provider is. */
  limit?: number
  current?: number
  /**
   * Só no 409 de valor curto: quanto foi cobrado e quanto veio, em centavos.
   * Pelo mesmo motivo de `limit`/`current` logo acima — a tela precisa dizer
   * QUANTO falta, e quanto foi pedido é conta do servidor: refazê-la aqui
   * seria a segunda cópia da regra, que é a que diverge.
   */
  expectedCents?: number
  paidCents?: number
  /**
   * Só no 409 `over_limit` da troca de plano: qual recurso não cabe no plano
   * escolhido, quanto o provedor usa e quanto o plano novo permite. `limit`
   * é o mesmo campo do 402 logo acima.
   */
  resource?: 'operators' | 'subscribers' | 'devices'
  used?: number
  /**
   * Só no 409 do login: para onde esta conta pode entrar. Existe quando o
   * endereço não nomeia provedor e a pessoa trabalha em mais de um — a senha
   * está certa e falta escolher, que é conflito de estado e não credencial.
   */
  destinations?: LoginDestinations
  /**
   * Só no 503 `acs_agent_offline`: quando o agente do GenieACS deste provedor
   * foi visto pela última vez, ou `null` se nunca se conectou. A frase já vem
   * montada em `message`; o campo segue junto para a tela que quiser mostrar a
   * data inteira em vez do "há 3 horas".
   */
  lastSeenAt?: string | null
  /**
   * Só no 502 `gateway_failed` das rotas de cobrança do console: o texto que o
   * gateway devolveu. Quem lê opera a conta de lá, e é essa frase que resolve
   * o chamado — a `message` é a nossa, genérica.
   */
  detail?: string
  /**
   * Só no 409 `not_paid` do estorno quando o gateway discorda: aqui a
   * cobrança está paga, lá ela está neste estado (`PENDING`, por exemplo).
   */
  gatewayStatus?: string
}

/**
 * A frase do agente desconectado, montada AQUI e não no servidor.
 *
 * O 503 `acs_agent_offline` pode vir de qualquer rota que fala com o GenieACS —
 * lista, detalhe, painel, ações —, e cada tela já mostra `res.message` quando a
 * chamada falha. Traduzindo no único cano por onde todas passam, a lista, o
 * detalhe e a tira do painel dizem "agente desconectado" sem que cada uma
 * aprenda o código; e o "há quanto tempo" sai no relógio e no idioma de quem
 * olha, que o servidor não conhece.
 */
export function agentOfflineMessage(lastSeenAt: string | null | undefined): string {
  const key = offlineMessageKey(lastSeenAt)
  return translate(getActiveLocale(), key, key === 'api.acsAgentOffline' && lastSeenAt
    ? { when: formatRelativeTime(lastSeenAt) }
    : undefined)
}

/**
 * O nome do arquivo que o servidor mandou, se ele mandou.
 *
 * Lê `filename="..."` e também o `filename*=UTF-8''...` do RFC 5987, nessa
 * ordem de preferência, porque é o segundo que carrega acento sem quebrar. O
 * que volta é só o nome: qualquer barra é jogada fora, para que um cabeçalho
 * malformado não vire caminho no disco de quem baixa.
 */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const estendido = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  const simples = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)
  let nome: string | undefined
  if (estendido) {
    try { nome = decodeURIComponent(estendido[1]) } catch { nome = estendido[1] }
  } else if (simples) {
    nome = (simples[1] ?? simples[2] ?? '').trim()
  }
  if (!nome) return undefined
  const limpo = nome.split(/[\\/]/).pop()?.trim()
  return limpo || undefined
}

/**
 * A sessão guardada neste navegador, e em qual das duas gavetas ela está.
 *
 * `sessionStorage` é POR ABA; `localStorage` é do navegador inteiro. Uma
 * sessão de personificação mora na primeira: ela nasce e morre na aba que o
 * console abriu, e é isso que deixa o console seguir aberto atrás com a
 * própria sessão intacta — inclusive numa instalação de host único, onde o
 * painel do provedor divide o origin com ele.
 *
 * A gaveta da aba ganha da outra porque é a mais específica: numa aba de
 * personificação as duas estão cheias, e quem manda ali é o bilhete que abriu
 * a aba, não a sessão que o navegador já tinha.
 *
 * Sem refresh token junto do token de aba, nunca: a personificação não tem um,
 * e devolver o do operador — que está na outra gaveta — renovaria a sessão de
 * leitura como se fosse comum.
 */
export function storedSession(): { token: string | null; refreshToken: string | null; tabScoped: boolean } {
  if (typeof window === 'undefined') return { token: null, refreshToken: null, tabScoped: false }
  const daAba = sessionStorage.getItem('token')
  if (daAba) return { token: daAba, refreshToken: null, tabScoped: true }
  return {
    token: localStorage.getItem('token'),
    refreshToken: localStorage.getItem('refreshToken'),
    tabScoped: false
  }
}

/**
 * A text body gzipped in the browser, or null where the browser cannot. A
 * contacts spreadsheet is a megabyte or more, and the proxy in front of a
 * panel often stops request bodies at 1 MB; compressed it is a tenth of that.
 * The server inflates `Content-Encoding: gzip` on its own (body-parser).
 */
async function gzipText(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined' || text.length < 64 * 1024) return null
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    return await new Response(stream).blob()
  } catch {
    return null
  }
}

class ApiClient {
  private baseURL: string
  private token: string | null = null
  private refreshToken: string | null = null
  private refreshPromise: Promise<boolean> | null = null
  /**
   * Quantas vezes a sessão desta aba mudou de dono.
   *
   * Um refresh que sai antes de um logout/login e volta depois não pode
   * gravar nada: os tokens dele são da sessão anterior, e `setTokens` os
   * colocaria por cima da nova — o provedor A de volta na aba onde o B acabou
   * de entrar. Sobe em `clearTokens`, `setTabTokens` e `beginSession`; nunca no
   * `setTokens` que o próprio refresh chama.
   */
  private sessionEpoch = 0
  /** Se a sessão desta aba é só dela — ver `storedSession`. */
  private tabScoped = false

  constructor(baseURL: string) {
    this.baseURL = baseURL
    const guardada = storedSession()
    this.token = guardada.token
    this.refreshToken = guardada.refreshToken
    this.tabScoped = guardada.tabScoped
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (e) => this.handleStorageEvent(e))
    }
  }

  /**
   * Outra aba mexeu no token do navegador. Esta acompanha — ver
   * `crossTabTokenAction`. Pública para os testes, que não têm DOM.
   */
  handleStorageEvent(e: Pick<StorageEvent, 'key' | 'newValue'>) {
    const acao = crossTabTokenAction({
      key: e.key,
      newValue: e.newValue,
      current: this.token,
      tabScoped: this.tabScoped
    })
    if (acao === 'logout') {
      this.clearTokens()
    } else if (acao === 'adopt' && e.newValue) {
      // A mesma sessão renovada na outra aba: o token novo e o refresh token
      // que veio junto. Sem `beginSession` — não é sessão nova, e sem gravar —
      // a outra aba já gravou.
      this.token = e.newValue
      try {
        this.refreshToken = localStorage.getItem('refreshToken') ?? this.refreshToken
      } catch {
        // Sem storage, segue com o refresh token que tinha.
      }
    } else if (acao === 'reload') {
      window.location.reload()
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryAfterRefresh = true
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseURL}/api${endpoint}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // The panel answers in the operator's chosen language, which is not
      // necessarily the browser's, so the backend is told explicitly.
      'Accept-Language': getActiveLocale(),
      ...options.headers as Record<string, string>,
    }

    // Quem já trouxe o próprio token (`postAs`) fala em nome daquela sessão,
    // não da que estiver na aba quando o pedido sair.
    if (this.token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      })

      const contentType = response.headers.get('content-type') || ''
      // A proxy in front of the panel answers its own errors in HTML (nginx's
      // "413 Request Entity Too Large", a 502 page): the operator gets the
      // status line, not the markup.
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text().then((text) => ({
          message: /^\s*</.test(text) ? `${response.status} ${response.statusText}`.trim() : text
        }))

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

      // 402 é a assinatura, nunca a permissão: o operador TEM o papel, é o
      // provedor que está em atraso, suspenso ou cancelado. O evento é o que
      // deixa a casca do app mostrar o aviso sem que cada tela saiba disso.
      if (response.status === 402 && typeof data.code === 'string' && data.code.startsWith('subscription_')) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent<SubscriptionBlockedDetail>(SUBSCRIPTION_BLOCKED_EVENT, {
            detail: { code: data.code, message: data.message || '', subscription: data.subscription ?? null }
          }))
        }
      }

      // O provedor passou a exigir o 2FA e esta pessoa não ativou: quem leva à
      // ativação é a casca do app, que ouve este evento — como o 402 acima.
      if (isMfaEnrollmentRefusal(response.status, data.code) && typeof window !== 'undefined') {
        window.dispatchEvent(new Event(MFA_ENROLLMENT_EVENT))
      }

      if (!response.ok) {
        if (data.code === 'acs_agent_offline') {
          const lastSeenAt = typeof data.lastSeenAt === 'string' ? data.lastSeenAt : null
          return {
            success: false,
            message: agentOfflineMessage(lastSeenAt),
            error: data.error || translate(getActiveLocale(), 'api.unknownError'),
            code: data.code,
            lastSeenAt
          }
        }
        return {
          success: false,
          // `missing_permission` é o 403 de quem tem sessão boa e papel curto.
          // A frase de reserva é a dele e não a genérica: sem isto, uma rota que
          // recusasse sem corpo cairia em "a requisição falhou", que manda a
          // pessoa tentar de novo para sempre falhar igual — e é vizinha do
          // `invalid_token` logo acima, cujo caminho termina em tela de login.
          // Nada aqui derruba a sessão, e é justamente esse o ponto.
          message: data.message || translate(
            getActiveLocale(),
            data.code === 'missing_permission' ? 'api.missingPermission' : 'api.requestFailed'
          ),
          error: data.error || translate(getActiveLocale(), 'api.unknownError'),
          code: data.code,
          // Forwarded, not rebuilt away: see `skipped` above.
          ...(data.skipped ? { skipped: data.skipped } : {}),
          ...(data.subscription !== undefined ? { subscription: data.subscription } : {}),
          ...(typeof data.limit === 'number' ? { limit: data.limit, current: data.current } : {}),
          // O 409 `over_limit` da troca de plano: a tela diz QUAL recurso
          // passa do plano novo e por quanto, e isso só o servidor sabe.
          ...(typeof data.resource === 'string' ? { resource: data.resource } : {}),
          ...(typeof data.used === 'number' ? { used: data.used } : {}),
          // O 409 de valor curto, pelo mesmo desenho do 402 acima: a tela tem
          // que dizer QUANTO falta, e a conta é do servidor — refazê-la aqui
          // seria a segunda cópia de "quanto foi pedido", que é a que diverge.
          ...(typeof data.expectedCents === 'number'
            ? { expectedCents: data.expectedCents, paidCents: data.paidCents }
            : {}),
          // O 409 do login, pelo mesmo desenho: a tela precisa da LISTA para
          // perguntar em qual provedor entrar, e ela só existe no servidor.
          ...(data.destinations ? { destinations: data.destinations } : {}),
          // O 502 do gateway: o motivo dele, literal, para quem opera a conta lá.
          ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
          // O 409 `not_paid` do estorno: o estado que o gateway diz ter.
          ...(typeof data.gatewayStatus === 'string' ? { gatewayStatus: data.gatewayStatus } : {}),
        }
      }

      return data
    } catch (error) {
      return {
        success: false,
        message: translate(getActiveLocale(), 'api.networkError'),
        error: error instanceof Error ? error.message : translate(getActiveLocale(), 'api.unknownError'),
      }
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false
    if (this.refreshPromise) return this.refreshPromise

    const epoch = this.sessionEpoch
    this.refreshPromise = (async () => {
      try {
        const response = await fetch(`${this.baseURL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        })
        const data = await response.json()
        // A sessão mudou enquanto a resposta vinha: ela é de outra sessão, e
        // nem renovar nem derrubar cabe a ela.
        if (epoch !== this.sessionEpoch) return false
        if (!response.ok || !data.success || !data.data?.token || !data.data?.refreshToken) {
          this.clearTokens()
          return false
        }
        this.setTokens(data.data.token, data.data.refreshToken)
        return true
      } catch {
        if (epoch !== this.sessionEpoch) return false
        this.clearTokens()
        return false
      } finally {
        // Só a própria: com a sessão trocada, o lugar já foi esvaziado por
        // quem trocou e pode ser de um refresh da sessão nova.
        if (epoch === this.sessionEpoch) this.refreshPromise = null
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

  async patch<T>(endpoint: string, data?: any): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string, data?: any): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  /**
   * A raw body, not JSON. `request` sets `Content-Type: application/json` and
   * stringifies, which would corrupt a file; this is the one call that needs
   * the bytes to arrive as they are.
   */
  async sendBlob<T>(
    endpoint: string,
    body: Blob,
    headers: Record<string, string>
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'POST', body, headers })
  }

  /**
   * A binary response. `request` reads JSON or text, so a file fetched through
   * it would arrive mangled and silently — hence its own path, with the same
   * Authorization header and the same locale.
   *
   * O que ela NÃO podia continuar deixando de fazer, e por isso os três blocos
   * abaixo: esta função era um `fetch` cru, e tudo que `request` resolve para a
   * API inteira — renovar o token expirado, acender o aviso de assinatura no
   * 402, devolver uma frase em vez de um código — simplesmente não acontecia
   * aqui. Enquanto o único caminho por ela foi baixar um anexo de conversa, o
   * preço era um botão que não fazia nada de vez em quando. Com a exportação
   * do cadastro inteiro do provedor passando pelo mesmo cano, "não fez nada"
   * vira "o provedor acha que não pode exportar os próprios dados".
   */
  async getBlob(
    endpoint: string,
    retryAfterRefresh = true
  ): Promise<{ success: boolean; blob?: Blob; filename?: string; code?: string; message?: string }> {
    const headers: Record<string, string> = { 'Accept-Language': getActiveLocale() }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    try {
      const response = await fetch(`${this.baseURL}/api${endpoint}`, { headers })
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || ''
        const data = contentType.includes('application/json') ? await response.json() : {}

        // A sessão expirou no meio: mesma renovação que `request` faz, e pelo
        // mesmo motivo — sem ela o download simplesmente não acontece, sem erro
        // visível, e a pessoa clica de novo.
        if (response.status === 403 && data.code === 'invalid_token' && retryAfterRefresh) {
          const refreshed = await this.refreshAccessToken()
          if (refreshed) return this.getBlob(endpoint, false)
        }

        // O 402 da assinatura é da casca do app, não desta chamada: quem mostra
        // a tela de bloqueio é quem ouve este evento.
        if (response.status === 402 && typeof data.code === 'string' && data.code.startsWith('subscription_')) {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<SubscriptionBlockedDetail>(SUBSCRIPTION_BLOCKED_EVENT, {
              detail: { code: data.code, message: data.message || '', subscription: data.subscription ?? null }
            }))
          }
        }
        if (isMfaEnrollmentRefusal(response.status, data.code) && typeof window !== 'undefined') {
          window.dispatchEvent(new Event(MFA_ENROLLMENT_EVENT))
        }

        return {
          success: false,
          code: data.code,
          // A planilha de equipamentos passa por aqui e lê o GenieACS: o agente
          // desconectado tem a mesma frase que em `request`.
          message: data.code === 'acs_agent_offline'
            ? agentOfflineMessage(typeof data.lastSeenAt === 'string' ? data.lastSeenAt : null)
            : data.message || translate(
              getActiveLocale(),
              data.code === 'missing_permission' ? 'api.missingPermission' : 'api.requestFailed'
            )
        }
      }
      return {
        success: true,
        blob: await response.blob(),
        // O nome vem do servidor, que é quem o monta (`Content-Disposition`).
        // Remontá-lo aqui seria a segunda cópia da regra, e a segunda cópia é a
        // que diverge. Pode vir vazio quando o painel é servido de outra origem
        // e o deploy não expõe o cabeçalho — daí a reserva de quem chama.
        filename: filenameFromDisposition(response.headers.get('content-disposition'))
      }
    } catch {
      return { success: false, message: translate(getActiveLocale(), 'api.requestFailed') }
    }
  }

  /**
   * Um POST em nome de uma sessão específica, e não da que a aba tiver agora.
   *
   * É o que o logout usa: o aviso de saída sai depois de a aba já ter
   * esquecido os tokens — e, com um login rápido, de já ter os de outra
   * sessão, que um `/auth/logout` comum revogaria no lugar da certa. Sem
   * refresh no meio: um token vencido aqui não tem o que renovar.
   */
  async postAs<T>(token: string, endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data === undefined ? undefined : JSON.stringify(data),
      headers: { Authorization: `Bearer ${token}` }
    }, false)
  }

  /** A body that is not JSON — a CSV sheet, sent as the text it is. */
  async postText<T>(endpoint: string, text: string, contentType = 'text/csv'): Promise<ApiResponse<T>> {
    const gzipped = await gzipText(text)
    return this.request<T>(endpoint, {
      method: 'POST',
      body: gzipped ?? text,
      headers: gzipped ? { 'Content-Type': contentType, 'Content-Encoding': 'gzip' } : { 'Content-Type': contentType }
    })
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
      // Na gaveta do escopo que esta aba já tem: um refresh de sessão de
      // personificação não pode vazar para o `localStorage` do navegador.
      const gaveta = this.tabScoped ? sessionStorage : localStorage
      gaveta.setItem('token', token)
      if (refreshToken !== undefined) {
        gaveta.setItem('refreshToken', refreshToken)
      }
    }
  }

  /**
   * Grava os tokens de uma sessão NOVA — login, convite aceito, setup, MFA.
   *
   * É `setTokens` com uma diferença: avisa que a sessão mudou, para que um
   * refresh da sessão anterior ainda no ar seja descartado quando voltar.
   * O refresh em si continua chamando `setTokens`, que não mexe na contagem.
   */
  beginSession(token: string, refreshToken?: string) {
    this.sessionEpoch++
    this.refreshPromise = null
    this.setTokens(token, refreshToken)
  }

  /**
   * Adota uma sessão que vive SÓ nesta aba.
   *
   * É o que a personificação usa. Não passa por `clearTokens` de propósito:
   * ali a limpeza apagaria o `localStorage`, que numa instalação de host único
   * é o mesmo do console — a aba de trás perderia a sessão justamente por
   * causa da aba nova. O refresh token é zerado aqui, que era o serviço que a
   * limpeza prestava.
   */
  setTabTokens(token: string) {
    this.sessionEpoch++
    this.refreshPromise = null
    this.tabScoped = true
    this.token = token
    this.refreshToken = null
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('token', token)
      sessionStorage.removeItem('refreshToken')
      // A aba nova herdou o `sessionStorage` da aba do console.
      clearSessionScopedStorage()
    }
  }

  clearTokens() {
    // Uma sessão de aba se apaga só da gaveta da aba: sair da personificação —
    // ou ela expirar — não pode derrubar a sessão do console na aba de trás.
    const eraDaAba = this.tabScoped
    this.sessionEpoch++
    this.refreshPromise = null
    this.token = null
    this.refreshToken = null
    this.tabScoped = false
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('token')
      sessionStorage.removeItem('refreshToken')
      clearSessionScopedStorage()
      if (!eraDaAba) {
        localStorage.removeItem('token')
        localStorage.removeItem('refreshToken')
      }
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
  }
}

export const apiClient = new ApiClient(API_BASE_URL)

// Authentication API
/** Um provedor que esta conta pode abrir, como o login os devolve. */
export interface LoginTenantOption {
  id: number
  name: string
  slug: string
  status: string
}

/**
 * A resposta de "em qual deles?".
 *
 * Só existe onde o endereço não nomeia provedor: com subdomínio por provedor o
 * host já respondeu, e o login nunca pergunta.
 */
export interface MfaStatus {
  enabled: boolean
  /** Códigos de recuperação ainda não usados. */
  recoveryRemaining: number
}

export interface MfaSetup {
  /** O segredo em base32, para digitar no app quando não der para ler o QR. */
  secret: string
  /** A URI `otpauth://` que o QR code carrega. */
  uri: string
}

/**
 * A sessão nova que ativar, desligar ou trocar os códigos do 2FA devolve.
 *
 * Mudar o segundo fator derruba toda sessão aberta antes (o servidor sobe o
 * `token_version`), inclusive o token desta aba. A resposta traz o par novo, e
 * `comSessaoNova` o guarda antes de devolver — sem isso a próxima chamada da
 * tela do 2FA levaria a pessoa ao login, com os códigos ainda por anotar.
 */
export interface MfaFreshSession {
  token?: string
  refreshToken?: string
}

export interface MfaRecoveryCodes extends MfaFreshSession {
  recoveryCodes: string[]
}

async function comSessaoNova<T extends MfaFreshSession>(pedido: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const res = await pedido
  if (res.success && res.data?.token) apiClient.beginSession(res.data.token, res.data.refreshToken)
  return res
}

export interface LoginDestinations {
  tenants: LoginTenantOption[]
  console: boolean
}

/** O que a tela escolheu, e reenvia. */
export interface LoginDestination {
  tenantId?: number
  console?: boolean
}

export const authAPI = {
  getSetupStatus: () =>
    apiClient.get('/auth/setup-status'),

  setupAdmin: (username: string, password: string, email: string) =>
    apiClient.post('/auth/setup', { username, password, email }),

  /**
   * O identificador continua chegando como `username` porque é o nome do campo
   * no corpo da rota — mas o que se manda é o que a pessoa digitou, nome OU
   * e-mail. Renomear o parâmetro aqui faria a tela parecer mandar outra coisa
   * do que manda.
   */
  // `totpCode` é o código do app autenticador (ou um de recuperação), quando a
  // conta tem login em duas etapas. Vai junto com a senha em toda ida: o
  // servidor só o gasta quando a sessão nasce.
  login: (identifier: string, password: string, destino?: LoginDestination, totpCode?: string) =>
    apiClient.post('/auth/login', {
      username: identifier,
      password,
      ...(destino?.tenantId ? { tenantId: destino.tenantId } : {}),
      ...(destino?.console ? { destination: 'console' } : {}),
      ...(totpCode ? { totpCode } : {})
    }),

  // Login em duas etapas da própria conta.
  mfaStatus: () => apiClient.get<MfaStatus>('/auth/mfa'),
  mfaSetup: () => apiClient.post<MfaSetup>('/auth/mfa/setup', {}),
  // As três que mudam o segundo fator devolvem sessão nova: ver `comSessaoNova`.
  mfaEnable: (code: string) => comSessaoNova(apiClient.post<MfaRecoveryCodes>('/auth/mfa/enable', { code })),
  mfaDisable: (password: string, code: string) =>
    comSessaoNova(apiClient.post<MfaFreshSession & { enabled: boolean }>('/auth/mfa/disable', { password, code })),
  mfaRegenerateRecovery: (password: string, code: string) =>
    comSessaoNova(apiClient.post<MfaRecoveryCodes>('/auth/mfa/recovery-codes', { password, code })),

  getCurrentUser: () =>
    apiClient.get('/auth/user'),

  /** Com `token`, revoga aquela sessão mesmo que a aba já tenha esquecido dela. */
  logout: (token?: string) =>
    token ? apiClient.postAs(token, '/auth/logout') : apiClient.post('/auth/logout'),

  /** SaaS only; answers 404 on a self-hosted install, where the route is not mounted. */
  signup: (payload: {
    providerName: string; slug: string; username: string; email: string; password: string
    planCode?: string; taxId?: string; phone?: string; legalName?: string; city?: string; state?: string
    /** O código do link de indicação (`?ref=`); inválido é ignorado pelo servidor. */
    referralCode?: string
  }) =>
    apiClient.post<SignupResult>('/auth/signup', payload),

  /**
   * Troca o bilhete do console pela sessão de leitura, no host do provedor.
   *
   * Sem sessão anterior: quem personifica não tem conta neste provedor. Não
   * vem refresh token — a sessão dura meia hora e continuar custa uma volta ao
   * console, que é mais uma linha na trilha.
   */
  redeemImpersonation: (ticket: string) =>
    apiClient.post<{ user: User; tenant: { slug: string; name: string }; token: string }>(
      '/auth/impersonate/redeem', { ticket }
    ),

  refreshToken: (refreshToken: string) =>
    apiClient.post('/auth/refresh', { refreshToken }),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.post('/auth/change-password', { currentPassword, newPassword }),

  changeUsername: (currentUsername: string, newUsername: string) =>
    apiClient.post('/auth/change-username', { currentUsername, newUsername }),

  /**
   * O e-mail de login da própria pessoa.
   *
   * Pede a senha atual pelo mesmo motivo que a troca de senha pede: o endereço
   * é por onde se entra nesta conta, então trocá-lo a partir de uma sessão
   * aberta sem provar a senha seria trocar a fechadura sem a chave.
   */
  changeEmail: (currentPassword: string, email: string) =>
    apiClient.post<{ email: string; verified: boolean; verificationSent: boolean }>(
      '/auth/email', { currentPassword, email }
    ),

  /**
   * Pede a prova do próprio endereço — a mensagem com o link de confirmação.
   *
   * Exige sessão porque é o endereço de quem pede. A resposta pode ser 503
   * quando o deploy não tem transporte de correio configurado, e a tela diz
   * isso em vez de fingir que mandou.
   */
  requestEmailVerification: () =>
    apiClient.post<{ verified: boolean }>('/auth/email/verify', {}),

  /** O link aberto: carimba o endereço. Sem sessão, de propósito. */
  confirmEmailVerification: (token: string) =>
    apiClient.post<{ email: string }>('/auth/email/verify/confirm', { token }),

  /**
   * "Esqueci minha senha".
   *
   * Responde SEMPRE a mesma coisa, exista a conta ou não — é a rota mais
   * exposta do painel, e uma resposta que variasse diria a um estranho quais
   * identificadores têm conta aqui. A tela não tem, e não deve ter, como
   * distinguir os dois casos.
   */
  requestPasswordReset: (identifier: string) =>
    apiClient.post('/auth/password-reset', { identifier }),

  /** O link aberto: escolhe a senha nova. Não devolve sessão. */
  confirmPasswordReset: (token: string, password: string) =>
    apiClient.post('/auth/password-reset/confirm', { token, password }),

  emailReadiness: () =>
    apiClient.get<EmailReadiness>('/auth/email-readiness'),
}

/**
 * Se este deployment já poderia exigir e-mail no login, e quantos ficariam de
 * fora se exigisse hoje.
 *
 * `loginRequiresEmail` é lido do ambiente do servidor (`LOGIN_REQUIRES_EMAIL`),
 * e a tela só o reporta: a chave não tem volta pelo painel — ligá-la com
 * `withoutEmail` acima de zero tranca essa gente do lado de fora —, então
 * oferecê-la como botão seria oferecer um caminho sem retorno.
 */
export interface EmailReadiness {
  loginRequiresEmail: boolean
  total: number
  withoutEmail: number
  ready: boolean
}

// Operator accounts. Every route below is admin-only on the backend.
// An operator and the signed-in user are the same record, e daí o tipo comum —
// com uma diferença que o tipo agora diz: um operador SEMPRE tem papel, porque
// ele é uma linha de `tenant_users`, enquanto a sessão pode não ter (a do
// console não trabalha em provedor nenhum). Sem este estreitamento, toda tela
// que lista operadores teria que tratar um nulo que não acontece ali.
export type Operator = User & { role: OperatorRole }
export type { OperatorRole }

/**
 * What the login screen may know before anybody has signed in.
 *
 * Deliberately two fields. This route is public by necessity — it exists to be
 * read before there is a session — so it carries the provider's name and
 * nothing that would help enumerate: a host that names no provider answers the
 * same 404 as any other unresolvable one, and a suspended provider answers it
 * too, because telling "suspended" from "never existed" tells a prober which
 * slugs are real, and a slug is an ISP's name.
 */
export interface PublicTenant {
  /** Null on the platform's own host, which names no provider and exists to sign one up. */
  slug: string | null
  name: string | null
  /** Which product this deployment is: decides whether signup and the database switcher exist. */
  edition: 'saas' | 'selfhosted'
  /** The domain a provider's panel lives under, or null where providers are not reached by subdomain. */
  panelBaseDomain: string | null
  /**
   * `provider` ou `platform`: se este endereço é o painel de um CLIENTE ou a
   * caixa interna da plataforma.
   *
   * A tela usa para uma coisa só — a caixa interna não gerencia equipamento
   * nenhum, então não é empurrada para o onboarding de GenieACS. Não é fato
   * sobre um cliente; é sobre qual dos endereços do próprio deploy se abriu.
   */
  kind: 'provider' | 'platform'
  /**
   * Whether this address is shared by every provider — a SaaS with no base
   * domain, where the separation comes from the login instead of the host.
   * The screen uses it to NOT wear one ISP's brand on everybody's door.
   */
  shared?: boolean
}

/** What signup answers: no token — the new provider's panel lives at another host. */
export interface SignupResult {
  tenant: { slug: string; name: string }
  panelUrl: string | null
  /**
   * Se a prova do endereço saiu. `false` não é erro: é um deploy sem SMTP, e
   * o cadastro acontece igual — o que muda é a tela mandar a pessoa olhar a
   * caixa de entrada ou não prometer o que não vai chegar.
   */
  emailed: boolean
}

/**
 * The provider the browser's own address resolves to.
 *
 * No parameter: the answer comes from the `Host` the request already carries,
 * which is the whole point — the address names the provider, so a caller
 * cannot ask about one they did not arrive at.
 *
 * Answers 404 where the deployment has no base domain configured, which is
 * every self-hosted install: the login screen then shows the panel's own name,
 * exactly as it does today.
 */
export const publicTenantAPI = {
  current: () => apiClient.get<PublicTenant>('/tenant/public')
}

/**
 * O cadastro fiscal do provedor: o que uma nota fiscal exige e o endereço que
 * recebe a cobrança.
 *
 * Todo campo é opcional — nenhum provedor que já existe tem estes dados, e um
 * ISP se cadastra antes de ter o contador por perto. Campo ausente não é
 * tocado; campo presente e vazio apaga. `taxId` e `postalCode` voltam só com
 * dígitos, porque é assim que o banco os guarda.
 */
export interface TenantBilling {
  legalName: string | null
  taxId: string | null
  stateRegistration: string | null
  postalCode: string | null
  addressLine: string | null
  addressNumber: string | null
  addressExtra: string | null
  district: string | null
  city: string | null
  state: string | null
  email: string | null
  phone: string | null
}

/** What the provider does to itself. */
export const tenantAPI = {
  /** The name on the sidebar, the login screen and the tab — what `settings.appName` used to be. */
  rename: (name: string) =>
    apiClient.requestWithBody<{ name: string; slug: string; billing: TenantBilling }>(
      'PATCH', '/tenant', { name }
    ),

  /**
   * Grava o cadastro fiscal. Manda só o que mudou: a rota distingue campo
   * ausente (não mexe) de campo vazio (apaga), e mandar o formulário inteiro a
   * cada salvamento jogaria fora essa diferença.
   */
  updateBilling: (billing: Partial<TenantBilling>) =>
    apiClient.requestWithBody<{ name: string; slug: string; billing: TenantBilling }>(
      'PATCH', '/tenant', { billing }
    ),

  /**
   * Os dados públicos de um CNPJ (Receita, via BrasilAPI no servidor), no
   * formato do cadastro. Só sugere: nada é gravado até o Salvar.
   */
  lookupCnpj: (cnpj: string) =>
    apiClient.get<Partial<TenantBilling> & { tradeName?: string }>(`/tenant/cnpj?cnpj=${encodeURIComponent(cnpj.replace(/\D/g, ''))}`),

  /**
   * O endereço de um CEP (BrasilAPI/ViaCEP, no servidor). `lat`/`lng` vêm
   * quando a fonte tem o ponto. Só sugere, como o CNPJ.
   */
  lookupCep: (cep: string) =>
    apiClient.get<Partial<TenantBilling> & { lat?: number; lng?: number }>(`/tenant/cep?cep=${encodeURIComponent(cep.replace(/\D/g, ''))}`),

  /**
   * O ponto no mapa de um endereço (Nominatim/OpenStreetMap, no servidor).
   * `precision: 'city'` quando só a cidade foi achada — a tela pede ajuste.
   */
  geocode: (fields: Partial<Pick<TenantBilling, 'addressLine' | 'addressNumber' | 'district' | 'city' | 'state' | 'postalCode'>>) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(fields)) if (value) query.set(key, value)
    return apiClient.get<{ lat: number; lng: number; precision: 'address' | 'city' }>(`/tenant/geocode?${query}`)
  },

  /**
   * Todo o cadastro deste provedor, num arquivo.
   *
   * Não é envelope de API: a rota responde com `Content-Disposition: attachment`
   * e o JSON inteiro no corpo, então vai por `getBlob` e não por `get`. Demora
   * na proporção do histórico do provedor — são trinta tabelas lidas em série,
   * sem teto —, o que é por que quem chama precisa de um estado de espera de
   * verdade e não de um `await` escondido atrás de um clique.
   */
  export: () => apiClient.getBlob('/tenant/export'),

  /** Se o provedor exige o 2FA da equipe, quantos ainda faltam, e se quem pergunta pode mudar. */
  security: () => apiClient.get<TenantSecurity>('/tenant/security'),

  /** Só o dono (ou o admin onde não há dono); ligar pede o 2FA de quem liga. */
  updateSecurity: (requireMfa: boolean) =>
    apiClient.requestWithBody<{ requireMfa: boolean }>('PUT', '/tenant/security', { requireMfa })
}

export interface TenantSecurity {
  requireMfa: boolean
  membersWithoutMfa: number
  canChange: boolean
}

/** O que a exclusão de um assinante devolve: o recibo do que deixou de existir. */
export interface CustomerErasureReceipt {
  accountId: number
  customerId: string | null
  /** Quantas linhas em cada tabela — contagens, nunca conteúdo. */
  rowCounts: Record<string, number>
  /** Quantos arquivos de anexo saíram do disco. */
  attachments: number
  /**
   * A conta estava ativa quando foi apagada? Se estava, a ONT continua na
   * planta e a próxima sincronização recria a conta com um `customer_id` novo —
   * a exclusão se desfaz sozinha em um minuto se o serviço não for cancelado.
   */
  wasActive: boolean
}

/**
 * Os dois direitos do titular, exercidos pelo ISP em nome dele: ver e apagar.
 *
 * As duas rotas endereçam a conta pelo id da LINHA (`accountId`), que a tela do
 * aparelho recebe em `device.customer.accountId` — e não pelo "ID do Cliente"
 * impresso, que é o que o assinante conhece e por isso o pior endereço possível
 * para um ato sem volta.
 */
export const customerAPI = {
  /**
   * O dossiê de um assinante, num arquivo.
   *
   * Por `getBlob` e não por `get` pelo mesmo motivo do export do provedor: a
   * rota responde com `Content-Disposition: attachment` e o JSON no corpo, sem
   * o envelope da API.
   */
  export: (accountId: number) => apiClient.getBlob(`/customers/${accountId}/export`),

  /**
   * Apaga. O `confirmCustomerId` tem que ser o "ID do Cliente" digitado exato —
   * o servidor não normaliza caixa nem espaço, porque um id "quase certo" é
   * precisamente o que um engano parece.
   */
  erase: (accountId: number, confirmCustomerId: string) =>
    apiClient.requestWithBody<CustomerErasureReceipt>(
      'DELETE', `/customers/${accountId}`, { confirmCustomerId }
    )
}

/** Uma linha da trilha, como a tela a recebe. */
export interface AuditEntry {
  id: number
  action: string
  actor: {
    /** Nulo quando a pessoa saiu do deploy: o nome fica, que é a razão de ele ser desnormalizado. */
    userId: number | null
    username: string | null
    kind: 'operator' | 'platform' | 'system'
  }
  subject: { type: string | null; id: string | null }
  /** Já parseado pelo backend, ou nulo — inclusive quando o JSON gravado não voltou inteiro. */
  detail: Record<string, unknown> | null
  ip: string | null
  /**
   * Cru do driver: `Date` no PostgreSQL e no MariaDB, número ou string no
   * SQLite. Quem mostra usa `formatDateTime`, que aceita os três.
   */
  at: string | number | null
}

export interface AuditPage {
  entries: AuditEntry[]
  nextBefore: number | null
  /** As ações que o backend conhece, em toda resposta: é a lista do filtro. */
  actions: string[]
}

/**
 * A trilha deste provedor. Só leitura, e é a rota inteira.
 *
 * O filtro por ação vai no servidor, e não sobre o que já foi carregado: a
 * rota aceita `?action=` com índice por trás (`tenant_id`, `action`), e filtrar
 * no cliente mostraria "nada encontrado" para uma ação que existe três páginas
 * adiante.
 */
export const auditAPI = {
  list: (params: { action?: string | null; limit?: number; before?: number | null } = {}) => {
    const query = new URLSearchParams()
    if (params.action) query.set('action', params.action)
    if (params.limit) query.set('limit', String(params.limit))
    if (params.before) query.set('before', String(params.before))
    const suffix = query.toString()
    return apiClient.get<AuditPage>(`/audit${suffix ? `?${suffix}` : ''}`)
  }
}

/** O que quem abre um link de convite vê antes de decidir. */
export interface InvitePreview {
  tenant: { name: string; slug: string }
  role: OperatorRole
}

export const invitesAPI = {
  /**
   * Cria. Devolve o token UMA vez; o backend guarda só o hash dele.
   *
   * `email` é opcional e só muda uma coisa: com ele, o painel manda o link por
   * e-mail se o deploy tiver transporte. `emailed` diz se foi — e `false` não é
   * erro, é o caso normal de um deploy sem SMTP, onde quem convidou entrega o
   * link como sempre entregou.
   */
  create: (payload: { role: OperatorRole; label?: string; email?: string }) =>
    apiClient.post<{
      invite: { id: number; role: OperatorRole; label: string | null; expiresAt: string }
      token: string
      emailed: boolean
    }>('/invites', payload),

  /** Quem convidou, para qual provedor e com qual papel. Sem sessão: o token é a credencial. */
  preview: (token: string) =>
    // POST apesar de ser consulta: o token vai no CORPO para não acabar no log
    // do servidor, que grava o caminho inteiro. Ver `usableInvite` no backend.
    apiClient.post<InvitePreview>('/invites/token/preview', { token }),

  /** Aceita, com a conta que a pessoa já tem ou com uma nova. Devolve a sessão. */
  accept: (token: string, payload: { username: string; password: string; email?: string; totpCode?: string }) =>
    apiClient.post<LoginResponse>('/invites/token/accept', { ...payload, token })
}

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'canceled'

/** The plan and the state a provider's subscription is in, as the console lists it. */
export interface TenantSubscriptionSummary {
  /** The state that VALUES today: an expired trial reads `past_due` here. */
  status: SubscriptionStatus
  storedStatus: SubscriptionStatus
  planId: number
  planCode: string | null
  planName: string | null
  trialEndsAt: string | null
  renewsAt: string | null
}

/** One provider on the deployment, as the control plane sees it. */
export interface Tenant {
  id: number
  slug: string
  name: string
  status: 'active' | 'suspended'
  /** How many people hold a membership here. */
  operators: number
  /** Null only for a provider the seed has not yet given one — a boot fixes it. */
  subscription: TenantSubscriptionSummary | null
  /**
   * Quem este provedor é dentro do gateway de pagamento — a correlação que o
   * webhook lê para saber de quem é o dinheiro que entrou. Escrita só pelo
   * console: um provedor que pudesse apontar o próprio `customerRef` para o
   * cliente de outro receberia o crédito do pagamento alheio.
   */
  gateway: TenantGateway | null
  createdAt: string | null
  /**
   * Desde quando está suspenso.
   *
   * Nulo tem DOIS significados aqui, e o `status` os separa: num provedor ativo
   * é "não está suspenso"; num suspenso é "foi suspenso antes de esta coluna
   * existir e a trilha da plataforma não guardou". A tela diz que não sabe, em
   * vez de inventar uma data — `updated_at` daria um número plausível e errado.
   */
  suspendedAt: string | null
}

/**
 * Os fatos do DEPLOY, que não são de provedor nenhum.
 *
 * Tudo em `configured` é booleano de propósito: a tela diz se a variável está
 * posta, nunca o que ela vale. Endereço não é segredo e vai inteiro — é para
 * onde as pessoas apontam o navegador.
 */
/** De onde o próximo provedor herda o catálogo de equipamentos, e quem hoje não tem nenhum. */
export interface DefaultCatalogue {
  /** `platform` = a caixa manda; `provider` = recuo para a instalação; `none` = não há catálogo nenhum. */
  source: 'platform' | 'provider' | 'none'
  sourceTenant: CatalogueTenant | null
  /** A caixa da plataforma, quando o deploy tem uma. `null` pede o script de criação. */
  box: CatalogueTenant | null
  defaults: {
    rows: number
    vendors: number
    vendorNames: Array<{ name: string; enabled: boolean }>
  }
  /** Os provedores e quantas linhas de catálogo cada um tem. `rows: 0` é quem nasce cego. */
  providers: Array<{ id: number; name: string; slug: string; rows: number }>
}

/** O que o reenvio do catálogo fez em cada provedor. */
export interface CataloguePropagation {
  tenantId: number
  slug: string
  added: number
  updated: number
}

/**
 * Como o painel chega ao GenieACS de um provedor.
 *
 * `agent`: o GenieACS fica na rede do provedor, e um programa instalado lá (o
 * agente) abre a conexão até o painel — nenhuma porta aberta do lado dele. O
 * console escolhe entre os três; nas Configurações, a instalação própria
 * escolhe entre `direct` e `agent` (ver `GenieAcsConnectionSettings`).
 */
export type GenieAcsConnectionMode = 'direct' | 'tunnel' | 'agent'

/**
 * O estado do agente do GenieACS de um provedor. Nunca a chave: `tokenHint` são
 * os 4 últimos caracteres dela, para conferir qual está instalada.
 */
export interface GenieAcsAgentStatus {
  tokenHint: string | null
  tokenCreatedAt: string | null
  /** Há uma conexão aberta agora. */
  connected: boolean
  /** Desde quando a conexão ATUAL está aberta; `null` sem conexão. */
  connectedAt: string | null
  /** A última vez que o agente esteve conectado; `null` se nunca esteve. */
  lastSeenAt: string | null
  /** A versão que o agente anunciou no `hello`. */
  version: string | null
}

/** A resposta da geração de chave: a ÚNICA vez que a chave inteira sai do servidor. */
export interface GenieAcsAgentToken {
  token: string
  agent: GenieAcsAgentStatus
}

/** Como o painel chega ao GenieACS, visto das Configurações do provedor. */
export interface GenieAcsConnectionSettings {
  mode: GenieAcsConnectionMode
  /** Falso na SaaS: quem escolhe o modo é a plataforma, pelo console. */
  modeEditable: boolean
  agent: GenieAcsAgentStatus
}

/** O GenieACS de um provedor, como o console o vê: sem o segredo. */

/** Quem administra o GenieACS do provedor na SaaS: o console, ou o provedor (servidor próprio). */
export type GenieAcsOwnership = 'platform' | 'own'

export interface TenantGenieAcs {
  /** Os caminhos dos parâmetros virtuais TR-069 deste provedor (`vpRxPower`, …). */
  virtualParameters: Record<string, string>
  url: string
  /**
   * `tunnel`: o GenieACS numa rede privada de cliente, liberada só para este
   * provedor; `agent`: alcançado pelo agente instalado na rede do provedor.
   */
  mode: GenieAcsConnectionMode
  /**
   * O estado do agente — presente em todo modo, porque a chave sobrevive a uma
   * troca de modo e a tela mostra o que há ao voltar para `agent`. Opcional no
   * tipo porque um servidor anterior ao agente não o manda.
   */
  agent?: GenieAcsAgentStatus
  /** `own`: o servidor é do provedor, e ele mesmo grava endereço, credencial e parâmetros TR-069. */
  ownership: GenieAcsOwnership
  auth: GenieAcsAuthConfig
  /** O endereço que o deploy sugere a este provedor, ou nulo. */
  suggestion: string | null
  /** A tag que separa os equipamentos deste provedor num GenieACS compartilhado; `''` sem filtro. */
  deviceTag: string
  /** Prefixos de login PPPoE que o agendador marca sozinho com a tag; vazio desliga. */
  autoTagPrefixes: string[]
  /** A última passada da marcação automática, ou nulo se nunca rodou. */
  lastAutoTag: { at: string; tagged: number; conflictCount: number; error: string | null } | null
  /** Os outros provedores no mesmo GenieACS, e se algum dos que o dividem está sem tag. */
  sharedAcs: {
    providers: { id: number; name: string; deviceTag: string; autoTagPrefixes: string[] }[]
    missingTag: boolean
  }
}

/** O que a marcação em lote achou (e, com `apply`, marcou) na frota do ACS. */
export interface TenantDeviceTagging {
  tag: string
  matched: number
  alreadyTagged: number
  toTag: number
  tagged: number
  conflicts: { id: string; serial: string; pppoe: string; tags: string[] }[]
  conflictCount: number
}

export interface CatalogueTenant {
  id: number
  name: string | null
  slug: string | null
}

export interface DeploymentInfo {
  edition: 'saas' | 'selfhosted'
  database: {
    /** O dialeto em uso. Host, usuário e nome do banco ficam fora de propósito. */
    client: 'better-sqlite3' | 'mysql2' | 'pg'
    /** De onde veio a conexão: `DATABASE_URL` ou `db-config.json`. */
    source: 'env' | 'file'
  }
  addressing: {
    panelBaseDomain: string | null
    portalBaseDomain: string | null
    publicBaseUrl: string | null
    tenantSubdomains: boolean
    /** O molde do endereço de ACS que o onboarding sugere, com `{slug}`/`{id}` crus. */
    genieAcsTemplate: string | null
  }
  configured: {
    mail: boolean
    metricsToken: boolean
    billingWebhookToken: boolean
    billingGateway: boolean
    rls: boolean
  }
}

/**
 * A caixa da plataforma: a linha em `tenants` com `kind = 'platform'`.
 *
 * Existe para a plataforma poder ter o que o schema exige que tenha dono — o
 * WhatsApp com que ela atende os provedores. Viaja separada da lista de
 * clientes, e sem plano nem cadastro fiscal, porque não é cobrada.
 *
 * `null` num deploy que ainda não rodou `scripts/create-platform-tenant.js`.
 */
export interface PlatformBox {
  id: number
  slug: string
  name: string
  operators: number
}

export interface TenantGateway {
  /** O nome do provider (`asaas`), ou nulo quando a cobrança é manual. */
  gateway: string | null
  /** O id do cliente no gateway. Os dois andam juntos: meia correlação não resolve nada. */
  customerRef: string | null
}

/**
 * A integração com a Asaas, como o console a vê.
 *
 * **Configurado sim/não, nunca o valor**: a chave de API e o token do webhook
 * entram pela tela e não voltam por ela. O `*Source` diz de onde o valor que
 * vale veio — `db` é o que foi gravado no painel, `env` é a variável de ambiente
 * que continua valendo enquanto o painel não grava nada por cima.
 */
export interface AsaasIntegration {
  environment: 'sandbox' | 'production'
  apiKeyConfigured: boolean
  apiKeySource: 'db' | 'env' | null
  webhookTokenConfigured: boolean
  webhookTokenSource: 'db' | 'env' | null
  /** O endereço que se cola na Asaas. Montado pelo backend a partir do deploy. */
  webhookUrl: string
  updatedAt: string | null
  /**
   * A NFS-e pela Asaas: ligada, o pagamento confirmado de uma cobrança põe a
   * nota na fila. Opcionais porque servidores antigos não mandam os campos.
   */
  nfseEnabled?: boolean
  serviceDescription?: string | null
  municipalServiceId?: string | null
  municipalServiceCode?: string | null
  municipalServiceName?: string | null
  issPercent?: number
  retainIss?: boolean
  observations?: string | null
  /**
   * Multa (%), juros (% ao mês) e desconto por antecipação das cobranças no
   * Asaas. `discountValue` é % com `percent` e CENTAVOS com `fixed`. Zero é
   * desligado; opcionais porque servidores antigos não mandam os campos.
   */
  finePercent?: number
  interestMonthlyPercent?: number
  discountKind?: 'percent' | 'fixed'
  discountValue?: number
  discountDaysBefore?: number
}

/**
 * O que se grava na integração. Campo ausente não é tocado; campo presente e
 * vazio apaga — o mesmo contrato do cadastro fiscal.
 */
export interface AsaasIntegrationUpdate {
  environment?: 'sandbox' | 'production'
  apiKey?: string
  webhookToken?: string
  nfseEnabled?: boolean
  serviceDescription?: string
  municipalServiceId?: string
  municipalServiceCode?: string
  municipalServiceName?: string
  issPercent?: number
  retainIss?: boolean
  observations?: string
  finePercent?: number
  interestMonthlyPercent?: number
  discountKind?: 'percent' | 'fixed'
  discountValue?: number
  discountDaysBefore?: number
}

/** O estado da NFS-e de uma cobrança. */
export type InvoiceStatus = 'pending' | 'scheduled' | 'authorized' | 'error' | 'canceling' | 'canceled'

/** A NFS-e como o provedor a vê: número e links só quando emitida. */
export interface TenantInvoiceView {
  status: InvoiceStatus
  number: string | null
  pdfUrl: string | null
  xmlUrl: string | null
  issuedAt: string | null
}

/** A NFS-e como o console a vê: com o último erro e as tentativas. */
export interface InvoiceConsoleView extends TenantInvoiceView {
  id: number
  error: string | null
  attempts: number
}

export interface AsaasConnectionTest {
  ok: boolean
  accountName?: string
  environment: 'sandbox' | 'production'
}

/**
 * Até quantos dias o plano deixa o provedor guardar a trilha de auditoria
 * (`audit`), as mensagens (`messages`) e os anexos (`media`) do WhatsApp.
 * Nulo é sem teto — o provedor decide sozinho.
 */
export interface RetentionCaps {
  audit: number | null
  messages: number | null
  media: number | null
}

/** Null means "no limit". */
export interface PlanLimits {
  operators: number | null
  subscribers: number | null
  devices: number | null
}

/**
 * O preço, em centavos, de cada unidade acima do teto (0105). Nulo é "sem
 * preço": o teto barra, como sempre. Com preço, quem passa paga as unidades a
 * mais na fatura da renovação.
 */
export interface PlanOveragePrices {
  operators: number | null
  subscribers: number | null
  devices: number | null
}

/** O que o console manda para mudar os preços de excedente; ausente é "não mexer". */
export interface PlanOveragePayload {
  overagePriceCents?: Partial<PlanOveragePrices> | null
}

/** Uma parcela do excedente: `units` (pico − teto) × `unitCents` = `cents`. */
export interface OverageItem {
  resource: 'operators' | 'subscribers' | 'devices'
  peak: number
  limit: number
  units: number
  unitCents: number
  cents: number
  /** De que período (YYYY-MM-DD) é a parcela — a fatia mensal, no anual. */
  periodKey?: string
  /** `true_up`: o acerto do pico que subiu depois de a fatura do período sair. */
  kind?: 'true_up'
}

/** O excedente do período corrente, como a tela de Plano o mostra. */
export interface SubscriptionOverage {
  prices: PlanOveragePrices
  /** A renovação que fecha o período (YYYY-MM-DD) — nulo sem período pago. No anual, o fim da fatia mensal. */
  periodEnd: string | null
  /** `monthly`: no anual, o excedente sai todo mês numa fatura só dele; `renewal`: na fatura da renovação. */
  billing?: 'renewal' | 'monthly'
  items: OverageItem[]
  totalCents: number
  currency: string
}

/** A conta do valor de uma cobrança: o plano (com o cupom), o excedente e o crédito. */
export interface ChargePricing {
  baseCents: number | null
  overage: OverageItem[]
  overageCents: number
  creditCents: number
}

export interface Plan {
  id: number
  code: string
  name: string
  limits: PlanLimits
  /** Preço por unidade acima do teto (0105). Opcional: servidores antigos não mandam. */
  overagePriceCents?: PlanOveragePrices
  priceCents: number
  currency: string
  trialDays: number
  /**
   * Quanto tempo um pagamento compra, em dias. Trinta é mensal, 365 é anual.
   *
   * Existe desde a migração 0046. Antes, o período pago era um número dentro do
   * serviço de assinatura: o catálogo sabia por quanto vende e não por quanto
   * tempo, e um ISP que pagasse o ano inteiro recebia trinta dias.
   */
  periodDays: number
  /** Tetos de retenção do plano, em dias. */
  retention: RetentionCaps
  active: boolean
  /** A vitrine: se a página pública mostra, em que ordem e com que frases. */
  public: boolean
  featured: boolean
  sortOrder: number
  description: string | null
  features: string[]
  /** Preço COBRADO no ciclo anual (365 dias), em centavos; null é sem opção anual. */
  priceYearlyCents: number | null
  createdAt: string | null
  /** How many providers are on it — only from the console's list. */
  subscribers?: number
}

/** O plano como a página pública o mostra. */
export interface PublicPlan {
  code: string
  name: string
  description: string | null
  features: string[]
  limits: PlanLimits
  priceCents: number
  priceYearlyCents: number | null
  currency: string
  periodDays: number
  trialDays: number
  featured: boolean
}

/** Os campos de Configurações → Dados do SaaS. */
export const PLATFORM_PROFILE_FIELDS = [
  'legalName', 'tradeName', 'taxId', 'address',
  'contactEmail', 'contactWhatsapp',
  'notifyEmail', 'notifyWhatsapp',
  'instagram', 'facebook', 'youtube', 'linkedin'
] as const
export type PlatformProfileField = typeof PLATFORM_PROFILE_FIELDS[number]

export interface PlatformProfile {
  values: Record<PlatformProfileField, string | null>
  /** De onde vem cada valor: gravado no console, do `.env`, ou nenhum. */
  sources: Record<PlatformProfileField, 'db' | 'env' | null>
  /** A política de suspensão automática (0102), já com o padrão aplicado. */
  billing?: PlatformBillingPolicy & PlatformReferralPolicy
  billingDefaults?: PlatformBillingPolicy & PlatformReferralPolicy
  /** Os alertas para quem opera a plataforma (0112). */
  alerts?: PlatformAlertsConfig
  /** Falso quando não há caixa da plataforma onde gravar. */
  canSave: boolean
  updatedAt: string | null
}

/** Os eventos que avisam quem opera a plataforma (0112). */
export const PLATFORM_ALERT_EVENTS = [
  'payment_received',
  'card_refused',
  'cancellation_requested',
  'cancellation_scheduled',
  'referral_signup',
  'nfse_error',
  'auto_suspended',
  'big_overdue'
] as const
export type PlatformAlertEvent = typeof PLATFORM_ALERT_EVENTS[number]
export type PlatformAlertChannel = 'whatsapp' | 'email'

/** Por evento, ligado ou não e por quais canais; o limite do atraso alto; o resumo diário. */
export interface PlatformAlertsConfig {
  events: Record<PlatformAlertEvent, { enabled: boolean; channels: PlatformAlertChannel[] }>
  bigOverdueCents: number
  /** `hour` no horário de Brasília. */
  dailyDigest: { enabled: boolean; hour: number }
}

/** O patch dos alertas: ausente mantém. */
export interface PlatformAlertsUpdate {
  events?: Partial<Record<PlatformAlertEvent, { enabled?: boolean; channels?: PlatformAlertChannel[] }>>
  bigOverdueCents?: number | null
  dailyDigest?: { enabled?: boolean; hour?: number }
}

/** O crédito da indicação de provedores, em centavos (0106); 0 desliga o programa. */
export interface PlatformReferralPolicy {
  referralRewardCents?: number
}

/** Dias de atraso até a suspensão automática (0 desliga) e de aviso antes dela. */
export interface PlatformBillingPolicy {
  autoSuspendDays: number
  autoSuspendWarnDays: number
  /** A retenção no cancelamento (0107): o desconto (% e faturas) e o máximo de meses de pausa. 0 desliga. */
  retentionDiscountPercent: number
  retentionDiscountMonths: number
  retentionPauseMaxMonths: number
}

export interface PublicInfo {
  productName: string
  baseDomain: string | null
  contactWhatsapp: string | null
  /** Onde os provedores entram num deploy de endereço único; null com subdomínios. */
  panelUrl: string | null
  /** Nome fantasia de Configurações → Dados do SaaS; `productName` já o usa. */
  tradeName?: string | null
  /** Links das redes sociais, cada um opcional. */
  social?: { instagram: string | null; facebook: string | null; youtube: string | null; linkedin: string | null }
  /** O rodapé da vitrine; cada um é opcional. */
  contactEmail?: string | null
  legalName?: string | null
  taxId?: string | null
  address?: string | null
  /**
   * Quanto tempo o pedido de contato fica guardado. `0` quer dizer que nada o
   * apaga sozinho. A página de privacidade diz exatamente isto — vem do servidor,
   * da mesma função que a poda lê.
   */
  leadRetentionDays?: number
}

export interface CnpjData {
  taxId: string
  legalName?: string
  tradeName?: string
  postalCode?: string
  addressLine?: string
  addressNumber?: string
  addressExtra?: string
  district?: string
  city?: string
  state?: string
  email?: string
  phone?: string
}

export type LeadStatus = 'new' | 'contacted' | 'won' | 'lost'

export interface Lead {
  id: number
  name: string
  company: string | null
  email: string | null
  phone: string | null
  city: string | null
  devicesEstimate: number | null
  message: string | null
  planCode: string | null
  status: LeadStatus
  notes: string | null
  source: string
  createdAt: string | null
  updatedAt: string | null
}

/** A vitrine do plano, como o console a edita. */
export interface PlanMarketingPayload {
  public?: boolean
  featured?: boolean
  sortOrder?: number
  description?: string | null
  features?: string[]
  priceYearlyCents?: number | null
}

/** Uma linha da trilha do plano de controle. */
export interface PlatformAuditEntry {
  id: number
  action: string
  actor: { userId: number | null; username: string | null }
  /**
   * Nome e slug vêm da própria linha, não de um join.
   *
   * É o que permite ler a trilha de um provedor que não existe mais — e a linha
   * mais importante desta tabela é exatamente essa.
   */
  tenant: { id: number | null; slug: string | null; name: string | null }
  detail: Record<string, unknown> | null
  ip: string | null
  at: string | null
}

export interface PlatformAuditPage {
  entries: PlatformAuditEntry[]
  /** O id da última linha desta página; vira o `before` da próxima. */
  nextBefore: number | null
  /** Todas as ações que a trilha conhece — alimenta o filtro. */
  actions: string[]
}

/** Quem tem o plano de controle. */
export interface PlatformAdminView {
  userId: number
  username: string
  email: string | null
  grantedAt: string | null
}

/** What the provider itself (and the block screen) may see of its subscription. */
export interface SubscriptionView {
  status: SubscriptionStatus
  storedStatus: SubscriptionStatus
  /**
   * Por que o estado que vale difere do gravado. São os dois prazos que vencem
   * sozinhos: o teste e o período pago — e a fatura de pró-rata de uma subida
   * vencida sem pagamento (`proration_overdue`). Nulo quando a coluna é a verdade.
   */
  reason: 'trial_expired' | 'renewal_expired' | 'proration_overdue' | 'auto_nonpayment' | 'paused' | null
  /**
   * Por que está suspensa (0102): `auto_nonpayment` é a suspensão automática
   * por inadimplência, que o pagamento desfaz; `manual` (ou nulo) é o console.
   */
  suspendedReason?: 'auto_nonpayment' | 'manual' | null
  plan: { code: string; name: string; limits: PlanLimits } | null
  trialEndsAt: string | null
  renewsAt: string | null
  canceledAt: string | null
  /** O ciclo de cobrança de agora (0104). Opcional: servidores antigos não mandam. */
  billingCycle?: BillingCycle
  /**
   * A descida de plano agendada para a renovação. Só existe com a assinatura
   * em dia e renovação futura: até `effectiveAt` o plano atual continua
   * valendo. Opcional porque servidores antigos não mandam o campo.
   */
  pendingPlan?: PendingPlan | null
  /**
   * Isento de cobrança: a plataforma manteve a assinatura ativa sem gerar
   * fatura nem vencer, até desligar. Opcional porque servidores antigos não
   * mandam o campo.
   */
  billingExempt?: boolean
  billingExemptSince?: string | null
  billingExemptReason?: string | null
  /** Até quando a isenção vale (ISO), ou nulo: até alguém desligar. */
  billingExemptUntil?: string | null
  /** O cupom de desconto na assinatura. Opcional: servidores antigos não mandam. */
  coupon?: SubscriptionCoupon | null
  /** O cartão recorrente. Opcional: servidores antigos não mandam. */
  card?: SubscriptionCard | null
  /**
   * A retenção no cancelamento (0107): o cancelamento agendado pelo próprio
   * provedor (o fim do período pago) e a pausa — de `renewsAt` até
   * `pausedUntil`, sem cobrança. Opcionais: servidores antigos não mandam.
   */
  cancelAt?: string | null
  pausedUntil?: string | null
  pauseStartedAt?: string | null
}

/**
 * O cartão recorrente: a cobrança automática no cartão salvo pela página do
 * Asaas. Só bandeira, quatro dígitos e datas — o token nunca sai do servidor.
 * `failure` é um código (`charge_refused`, `capture_refused`): enquanto há
 * falha, as faturas saem como Pix/boleto até um novo pagamento com cartão.
 */
export interface SubscriptionCard {
  autopayEnabled: boolean
  autopaySince: string | null
  saved: boolean
  brand: string | null
  last4: string | null
  savedAt: string | null
  failedAt: string | null
  failure: string | null
}

/**
 * O plano para o qual a assinatura desce na renovação. `blockedBy` diz que o
 * uso atual passa de um teto do plano novo: enquanto passar, a troca não se
 * aplica.
 */
/** O ciclo de cobrança (0104): mensal (`price_cents` por `period_days`) ou anual (`price_yearly_cents` por 365 dias). */
export type BillingCycle = 'monthly' | 'annual'

export interface PendingPlan {
  id: number
  name: string
  /** O preço do ciclo agendado — o do ano, quando a troca é para o anual. */
  priceCents: number
  /** O ciclo agendado (0104). Opcional: servidores antigos não mandam. */
  billingCycle?: BillingCycle
  /** ISO 8601. */
  effectiveAt: string
  /**
   * O período já foi pago pelo preço menor: o agendamento não se cancela nem
   * se substitui mais até se aplicar (o backend recusa com 409
   * `pending_locked`). Opcional porque servidores antigos não mandam o campo.
   */
  locked?: boolean
  blockedBy?: {
    resource: 'operators' | 'subscribers' | 'devices'
    used: number
    limit: number
  } | null
}

export interface SubscriptionUsage {
  subscription: SubscriptionView | null
  /** O cadastro fiscal viaja com o plano porque é a mesma tela. */
  billing: TenantBilling | null
  usage: { operators: number; subscribers: number; devices: number | null }
  limits: PlanLimits
  /** Os tetos de retenção do plano. Todos nulos na self-hosted. */
  retention?: RetentionCaps
  over: { operators: boolean; subscribers: boolean; devices: boolean }
  /** O excedente do período (0105) — nulo sem preço de excedente no plano. Opcional: servidores antigos não mandam. */
  overage?: SubscriptionOverage | null
}

/**
 * Um plano do catálogo como o PROVEDOR o vê, para escolher para qual mudar.
 *
 * Só os planos à venda, com o preço e os tetos; `current` marca o que ele
 * assina hoje. Limite nulo é ilimitado.
 */
export interface TenantPlanOption {
  id: number
  code: string
  name: string
  priceCents: number
  currency: string
  periodDays: number
  /**
   * O ciclo anual (0104): o preço por 365 dias, se o plano o oferece, e a
   * economia sobre doze meses (inteira, para baixo). Opcionais: servidores
   * antigos não mandam.
   */
  priceYearlyCents?: number | null
  annualAvailable?: boolean
  annualSavingsPercent?: number | null
  limits: PlanLimits
  /** Preço por unidade acima do teto (0105). Opcional: servidores antigos não mandam. */
  overagePriceCents?: PlanOveragePrices
  current: boolean
  /**
   * Quanto subir para este plano cobraria AGORA, de pró-rata — nulo quando a
   * troca não cobra nada (não é subida, ou não há período pago correndo).
   * `skipped: 'below_minimum'` é a diferença abaixo de R$ 5,00, que não vira
   * fatura. Opcional: servidores antigos não mandam.
   */
  proration?: PlanProrationPreview | null
}

/** A prévia da pró-rata de uma subida, na lista de planos. */
export interface PlanProrationPreview {
  amountCents: number
  remainingDays: number
  currency: string
  skipped?: 'below_minimum'
}

/** O tipo de uma cobrança: a da renovação do período, ou a avulsa da subida. */
export type ChargeKind = 'renewal' | 'proration' | 'overage'

/** A conta de uma fatura de pró-rata, para a tela explicar o valor. */
export interface ChargeProrationDetail {
  fromPlanId: number | null
  toPlanId: number | null
  fromPriceCents: number | null
  toPriceCents: number | null
  remainingDays: number | null
}

/** O que a troca de plano responde sobre a pró-rata que a subida abriu. */
export interface PlanChangeProration {
  amountCents: number
  remainingDays: number
  currency?: string
  issued: boolean
  reason?: string
  skipped?: 'below_minimum'
  charge?: TenantChargeView | null
}

/**
 * Uma cobrança emitida a este provedor, como ele a vê.
 *
 * `invoiceUrl` é a página do gateway onde se paga, e vem nula quando não há o
 * que pagar — cobrança quitada ou cancelada. O backend decide isso; a tela só
 * mostra o botão quando o endereço veio.
 */
export interface TenantChargeView {
  id: number
  periodEnd: string
  amountCents: number
  currency: string
  status: 'pending' | 'paid' | 'canceled' | 'failed' | 'overdue' | 'refunded'
  dueDate: string | null
  invoiceUrl: string | null
  createdAt: string | null
  /** `CREDIT_CARD` quando é cobrada sozinha no cartão salvo. Opcional: servidores antigos não mandam. */
  billingType?: string | null
  /** A nota fiscal desta cobrança. Opcional: servidores antigos não mandam. */
  invoice?: TenantInvoiceView | null
  /** `proration` é a fatura avulsa de uma subida. Opcional: servidores antigos não mandam. */
  kind?: ChargeKind
  proration?: ChargeProrationDetail | null
  /** A conta do valor: plano e excedente (0105). Opcional: servidores antigos não mandam. */
  pricing?: ChargePricing | null
  /** O crédito (indicação, ajuste) abatido nela, em centavos. Opcional: servidores antigos não mandam. */
  creditCents?: number
}

/**
 * Uma cobrança como o CONSOLE a vê: além do que o provedor enxerga, quem a
 * emitiu, quantas vezes se tentou, o último erro do gateway e as cobranças que
 * esta substituiu (valor alterado ou reemissão geram um id novo na Asaas).
 */
export interface ChargeConsoleView {
  id: number
  periodEnd: string
  amountCents: number
  /** O crédito abatido nela (0106). Opcional: servidores antigos não mandam. */
  creditCents?: number
  currency: string
  status: TenantChargeView['status']
  dueDate: string | null
  invoiceUrl: string | null
  provider: string
  /** `CREDIT_CARD` quando saiu no cartão salvo. Opcional: servidores antigos não mandam. */
  billingType?: string | null
  gatewayChargeId: string | null
  attempts: number
  lastError: string | null
  createdAt: string | null
  updatedAt: string | null
  superseded: { gatewayChargeId: string; amountCents: number }[]
  /** A NFS-e desta cobrança. Opcional: servidores antigos não mandam. */
  invoice?: InvoiceConsoleView | null
  /** `proration` é a fatura avulsa de uma subida. Opcional: servidores antigos não mandam. */
  kind?: ChargeKind
  proration?: ChargeProrationDetail | null
  /** A conta do valor: plano e excedente (0105). Opcional: servidores antigos não mandam. */
  pricing?: ChargePricing | null
}

/** A assinatura resumida de uma linha da aba Assinaturas do console. */
export interface SubscriptionConsoleSubscription {
  status: SubscriptionStatus
  storedStatus: SubscriptionStatus
  /** `auto_nonpayment` ganha o selo "Suspenso (inadimplência)". */
  suspendedReason?: 'auto_nonpayment' | 'manual' | null
  planId: number | null
  planCode: string | null
  planName: string | null
  /** O preço de UM ciclo — o do ano, no anual. */
  priceCents: number | null
  /** O ciclo de cobrança (0104). Opcional: servidores antigos não mandam. */
  billingCycle?: BillingCycle
  currency: string | null
  trialEndsAt: string | null
  renewsAt: string | null
  pendingPlan: {
    id: number; name: string; priceCents: number; effectiveAt: string; locked: boolean; billingCycle?: BillingCycle
  } | null
  /**
   * Isento de cobrança: a plataforma manteve a assinatura ativa sem gerar
   * fatura nem vencer, até desligar. Opcional porque servidores antigos não
   * mandam o campo.
   */
  billingExempt?: boolean
  billingExemptSince?: string | null
  billingExemptReason?: string | null
  /** Até quando a isenção vale (ISO), ou nulo: até alguém desligar. */
  billingExemptUntil?: string | null
  /** O cupom de desconto. Opcional: servidores antigos não mandam. */
  coupon?: SubscriptionCoupon | null
  /** O cartão recorrente. Opcional: servidores antigos não mandam. */
  card?: SubscriptionCard | null
  /** Os selos "Cancela em" e "Pausada até" (0107). Opcionais: servidores antigos não mandam. */
  cancelAt?: string | null
  pausedUntil?: string | null
}

export type CouponKind = 'percent' | 'fixed'
export type CouponDuration = 'once' | 'repeating' | 'forever'

/**
 * O cupom de desconto aplicado a uma assinatura. `priceCents` é o que a
 * próxima fatura do plano atual pede, já com o desconto e o piso;
 * `appliesToPlan` falso é o cupom restrito a outros planos (fica, sem
 * desconto). `cyclesLeft` nulo é o `forever`.
 */
export interface SubscriptionCoupon {
  id: number
  code: string
  kind: CouponKind
  /** Percentual (1–99) ou centavos. */
  value: number
  duration: CouponDuration
  durationCycles: number | null
  cyclesLeft: number | null
  planIds: number[] | null
  appliesToPlan: boolean
  priceCents: number
  appliedAt: string | null
}

/** Um cupom do catálogo, como a aba Cupons do console o lê. */
export interface CouponView {
  id: number
  code: string
  kind: CouponKind
  value: number
  duration: CouponDuration
  durationCycles: number | null
  maxRedemptions: number | null
  redemptions: number
  validUntil: string | null
  planIds: number[] | null
  active: boolean
  createdAt: string | null
  /** Quantas assinaturas têm o cupom aplicado agora. */
  inUse: number
}

/** Uma linha da aba Assinaturas: o provedor, a assinatura, o gateway e o boleto em aberto. */
export interface SubscriptionConsoleRow {
  tenant: { id: number; name: string; slug: string; status: string }
  subscription: SubscriptionConsoleSubscription | null
  gateway: { gateway: string | null; linked: boolean }
  openCharge: ChargeConsoleView | null
}

/** O estado de uma linha; `none` é o provedor sem assinatura nenhuma. */
export type SubscriptionConsoleStatus = SubscriptionStatus | 'none'

export interface SubscriptionConsoleSummary {
  byStatus: Record<SubscriptionConsoleStatus, number>
  openTotalCents: number
  overdueCount: number
  /** Quantos estão isentos de cobrança. Opcional: servidores antigos não mandam. */
  exempt?: number
}

export interface BillingEventView {
  id: number
  type: string
  amountCents: number | null
  currency: string | null
  provider: string
  externalId: string | null
  detail: Record<string, unknown> | null
  at: string
  /** No pagamento: a cobrança que ele quitou e a NFS-e dela. Opcionais. */
  chargeId?: number | null
  invoice?: InvoiceConsoleView | null
}

/**
 * Um lembrete de cobrança que a plataforma mandou ao provedor (0092): a etapa
 * da régua, o prazo a que ela se refere (data ISO) e por onde saiu.
 */
export type SubscriptionReminderStep = 'before' | 'due' | 'after' | 'suspension_warning' | 'suspended' | 'manual'

export interface SubscriptionReminderView {
  dueAt: string
  step: SubscriptionReminderStep
  channels: string[]
  sentAt: string
}

/** The codes a 402 carries. Stable: the block screen picks its wording by them. */
export const SUBSCRIPTION_GATE_CODES = [
  'subscription_past_due',
  'subscription_trial_expired',
  'subscription_suspended',
  'subscription_canceled',
  'subscription_missing',
  'subscription_paused'
] as const
export type SubscriptionGateCode = typeof SUBSCRIPTION_GATE_CODES[number]

/** Fired on `window` whenever the API answers 402 for the subscription. */

/** A person's membership at one provider, listed from the control plane. */
export interface TenantMembership {
  userId: number
  username: string
  /** O e-mail e o telefone são da PESSOA, e valem em todo provedor dela. */
  email: string | null
  /** Só dígitos, com DDI (ex.: 5511987654321). */
  phone: string | null
  role: OperatorRole
}

/** O link de definir senha, devolvido uma vez. `url` é nula sem domínio-base. */
export interface MemberPasswordLink {
  url: string | null
  token: string
  emailed: boolean
  expiresInMs: number
}

/**
 * The SaaS control plane.
 *
 * These routes exist only where `EDITION=saas`; on a self-hosted install they
 * are not mounted at all, so a call answers 404. That is deliberate — a 403
 * would tell whoever asked that a control plane is there.
 *
 * Every one of them requires a platform administrator, which is a plane ABOVE a
 * provider's own administrator: minting providers and reaching between them is
 * exactly what a provider's admin must not be able to do.
 */
export const platformAPI = {
  listTenants: () =>
    apiClient.get<{ tenants: Tenant[]; platformBox: PlatformBox | null }>('/platform/tenants'),

  /**
   * Cunha um bilhete para olhar o painel de um provedor.
   *
   * Devolve um ENDEREÇO, não uma sessão: o bilhete vai no fragmento dele, que
   * o navegador nunca manda a servidor nenhum, e quem o troca pelo token é a
   * tela `/impersonate` no host do provedor.
   */
  impersonate: (id: number) =>
    apiClient.post<{
      tenant: { id: number; slug: string; name: string }
      url: string
      expiresInSeconds: number
    }>(`/platform/tenants/${id}/impersonate`, {}),

  /**
   * O cadastro de um provedor num arquivo, visto do console.
   *
   * `getBlob` e não `get`: a rota devolve o arquivo com `Content-Disposition`,
   * sem o envelope da API — a mesma forma da exportação que o provedor faz de
   * dentro do painel dele, porque é o mesmo serviço do outro lado.
   */
  exportTenant: (id: number) => apiClient.getBlob(`/platform/tenants/${id}/export`),

  /**
   * Convida quem ainda NÃO tem login para um provedor.
   *
   * O par de `addMembership`, e a diferença é quem existe: aquela vincula uma
   * pessoa que já tem conta, esta cunha o convite em que a pessoa cria a dela e
   * escolhe a própria senha. É o caminho da PRIMEIRA conta de um provedor
   * recém-criado, que antes não tinha nenhum.
   *
   * `url` vem montado pelo servidor e não é montado aqui: o convite é aceito no
   * host do provedor convidado, e o console vive em outro endereço — é a única
   * parte do link que esta aba não tem como saber. Vem `null` num deploy sem
   * domínio-base, e aí o que se entrega é o token.
   */
  /**
   * Cria a conta direto, para um provedor administrado.
   *
   * A terceira porta da tela de equipe, e a diferença está em `password`: sem
   * ela, a conta nasce com uma senha que ninguém conhece e a resposta traz um
   * link de uso único para a pessoa escolher a dela; com ela, quem opera o
   * console escolheu a senha inicial e é ela que vale.
   */
  createOperator: (
    tenantId: number,
    payload: { username: string; email: string; role: OperatorRole; password?: string; phone?: string }
  ) =>
    apiClient.post<{
      membership: TenantMembership
      url: string | null
      token: string | null
      emailed: boolean
    }>(`/platform/tenants/${tenantId}/operators`, payload),

  inviteMember: (tenantId: number, payload: { role: OperatorRole; email?: string }) =>
    apiClient.post<{
      invite: { id: number; role: OperatorRole; label: string | null; expiresAt: string }
      token: string
      url: string | null
      emailed: boolean
    }>(`/platform/tenants/${tenantId}/invites`, payload),

  createTenant: (payload: { slug: string; name: string }) =>
    apiClient.post<{ tenant: Tenant }>('/platform/tenants', payload),

  /**
   * Suspends or reactivates.
   *
   * Este comentário dizia "não existe exclusão", e isso deixou de ser verdade
   * quando `deleteTenant` entrou logo abaixo. O que continua verdade é o motivo
   * pelo qual a exclusão é em DUAS etapas: as tabelas escopadas apontam para
   * `tenants` sem cascata, então apagar um provedor que ainda tem dado
   * estouraria numa chave estrangeira — e suspender primeiro é o que garante
   * que ninguém esteja trabalhando lá dentro enquanto se apaga.
   */
  setTenantStatus: (id: number, status: 'active' | 'suspended') =>
    apiClient.requestWithBody<{ tenant: Tenant }>('PATCH', `/platform/tenants/${id}`, { status }),

  /**
   * Corrige o cadastro: o nome, o subdomínio, ou os dois. Manda só o que mudou,
   * e nunca junto com o status — a rota recusa as duas intenções no mesmo
   * corpo, porque só uma delas muda o endereço que o ISP já recebeu.
   */
  updateTenant: (id: number, payload: { name?: string; slug?: string }) =>
    apiClient.requestWithBody<{ tenant: Tenant }>('PATCH', `/platform/tenants/${id}`, payload),

  /**
   * Liga (ou desliga) o provedor do gateway de pagamento.
   *
   * Mesma rota do nome e do status, e a rota recusa as três intenções no mesmo
   * corpo — mandar uma de cada vez é o que impede um salvamento de tela mexer em
   * algo que ninguém tinha a intenção de mexer. Os dois campos vazios juntos
   * desligam; um só vazio é recusado, porque meia correlação não resolve
   * provedor nenhum no webhook.
   */
  setTenantGateway: (id: number, gateway: { gateway: string; customerRef: string }) =>
    apiClient.requestWithBody<{ id: number; gateway: TenantGateway }>(
      'PATCH', `/platform/tenants/${id}`, { gateway }
    ),

  /**
   * Cria o cliente deste provedor na Asaas, a partir do cadastro fiscal dele, e
   * já grava a correlação. 400 quando falta CPF/CNPJ; 409 quando o provedor já
   * está ligado a um cliente — trocar de cliente é decisão para a mão.
   */
  createAsaasCustomer: (tenantId: number) =>
    apiClient.post<{ id: number; gateway: TenantGateway }>(
      `/platform/tenants/${tenantId}/gateway/asaas-customer`
    ),

  /** A integração com a Asaas: ambiente e o que está configurado — nunca os segredos. */
  asaasIntegration: () =>
    apiClient.get<AsaasIntegration>('/platform/integrations/asaas'),

  saveAsaasIntegration: (body: AsaasIntegrationUpdate) =>
    apiClient.put<AsaasIntegration>('/platform/integrations/asaas', body),

  /** Chama a Asaas com a chave gravada. `ok: false` vem com o motivo em `message`. */
  // ── Configurações → Dados do SaaS ───────────────────────────────────
  getPlatformProfile: () => apiClient.get<PlatformProfile>('/platform/settings/profile'),

  /** Ausente mantém; vazio apaga o gravado (o `.env` volta a valer). */
  /** Os números da política: `null` volta ao padrão. */
  updatePlatformProfile: (
    payload: Partial<Record<PlatformProfileField, string>>
      & Partial<Record<keyof PlatformBillingPolicy | keyof PlatformReferralPolicy, number | null>>
      & { alerts?: PlatformAlertsUpdate }
  ) =>
    apiClient.put<PlatformProfile & { changed: string[] }>('/platform/settings/profile', payload),

  /**
   * Manda um alerta de teste agora (0112). 409 `no_destination` sem WhatsApp
   * nem e-mail de avisos; 502 `send_failed` quando nenhum canal saiu.
   */
  testPlatformAlert: (channels?: PlatformAlertChannel[]) =>
    apiClient.post<{ channels: Partial<Record<PlatformAlertChannel, boolean | null>> }>(
      '/platform/alerts/test', channels ? { channels } : {}
    ),

  testAsaasIntegration: () =>
    apiClient.post<AsaasConnectionTest>('/platform/integrations/asaas/test'),

  /**
   * Gera um token novo para o webhook e o devolve UMA vez. O anterior deixa de
   * valer na hora: a Asaas precisa receber o novo antes da próxima entrega.
   */
  generateAsaasWebhookToken: () =>
    apiClient.post<{ webhookToken: string }>('/platform/integrations/asaas/webhook-token'),

  listMemberships: (tenantId: number) =>
    apiClient.get<{ memberships: TenantMembership[] }>(`/platform/tenants/${tenantId}/members`),

  /**
   * Attaches a person who already exists to a provider. NEVER touches their
   * password: wave 12 refused this to a provider's own administrator precisely
   * because doing it with a password would reset a stranger's login.
   */
  addMembership: (tenantId: number, payload: { username: string; role: OperatorRole }) =>
    apiClient.post<{ membership: TenantMembership }>(`/platform/tenants/${tenantId}/members`, payload),

  removeMembership: (tenantId: number, userId: number) =>
    apiClient.delete<{ userId: number }>(`/platform/tenants/${tenantId}/members/${userId}`),

  /** Login, e-mail e telefone são da pessoa; o papel é deste provedor. */
  updateMembership: (tenantId: number, userId: number, payload: Partial<{
    username: string; email: string; phone: string; role: OperatorRole
  }>) =>
    apiClient.requestWithBody<{ membership: TenantMembership; sharedAccount: boolean }>(
      'PATCH', `/platform/tenants/${tenantId}/members/${userId}`, payload
    ),

  /** Um link novo de definir senha; o anterior deixa de valer. */
  memberPasswordLink: (tenantId: number, userId: number, sendEmail = false) =>
    apiClient.post<MemberPasswordLink>(
      `/platform/tenants/${tenantId}/members/${userId}/password-link`, { sendEmail }
    ),

  setMemberPassword: (tenantId: number, userId: number, password: string) =>
    apiClient.post<{ userId: number }>(
      `/platform/tenants/${tenantId}/members/${userId}/password`, { password }
    ),

  revokeMemberSessions: (tenantId: number, userId: number) =>
    apiClient.post<{ userId: number }>(
      `/platform/tenants/${tenantId}/members/${userId}/sessions/revoke`, {}
    ),

  // ── A metade comercial: planos, assinatura, pagamento, uso ──────────
  listPlans: () =>
    apiClient.get<{ plans: Plan[] }>('/platform/plans'),

  createPlan: (payload: {
    code: string; name: string; maxOperators: number | null; maxSubscribers: number | null
    maxDevices: number | null; priceCents: number; currency: string; trialDays: number
    periodDays?: number; active?: boolean
    maxAuditRetentionDays?: number | null; maxMessageRetentionDays?: number | null; maxMediaRetentionDays?: number | null
  } & PlanMarketingPayload & PlanOveragePayload) =>
    apiClient.post<{ plan: Plan }>('/platform/plans', payload),

  updatePlan: (id: number, payload: Partial<{
    name: string; maxOperators: number | null; maxSubscribers: number | null; maxDevices: number | null
    priceCents: number; currency: string; trialDays: number; periodDays: number; active: boolean
    maxAuditRetentionDays: number | null; maxMessageRetentionDays: number | null; maxMediaRetentionDays: number | null
  }> & PlanMarketingPayload & PlanOveragePayload) =>
    apiClient.requestWithBody<{ plan: Plan }>('PATCH', `/platform/plans/${id}`, payload),

  // ── Os pedidos de demonstração da página pública ─────────────────────
  listLeads: (status?: LeadStatus) =>
    apiClient.get<{ leads: Lead[]; counts: Partial<Record<LeadStatus, number>> }>(
      `/platform/leads${status ? `?status=${status}` : ''}`
    ),

  updateLead: (id: number, payload: { status?: LeadStatus; notes?: string | null }) =>
    apiClient.requestWithBody<{ lead: Lead }>('PATCH', `/platform/leads/${id}`, payload),

  getSubscription: (tenantId: number) =>
    apiClient.get<{
      subscription: SubscriptionView | null
      planId: number | null
      events: BillingEventView[]
      /** Os lembretes de cobrança já mandados, do mais recente para trás. */
      reminders?: SubscriptionReminderView[]
    }>(
      `/platform/tenants/${tenantId}/subscription`
    ),

  /** `planId` and/or `status`; each becomes its own line on the statement. */
  updateSubscription: (tenantId: number, payload: {
    planId?: number; status?: SubscriptionStatus; reason?: string; trialEndsAt?: string | null; renewsAt?: string | null
  }) =>
    apiClient.requestWithBody<{ subscription: SubscriptionView; planId: number | null }>(
      'PUT', `/platform/tenants/${tenantId}/subscription`, payload
    ),

  /** We mark it paid. `reference` is the Pix id, the boleto number — whatever names the payment. */
  recordPayment: (
    tenantId: number,
    payload: { amountCents: number; currency: string; reference?: string; allowUnderpayment?: boolean }
  ) =>
    // `duplicate` é o que distingue "creditei" de "esta referência já estava
    // creditada". O backend sempre respondeu os dois com 200 — e sem este campo
    // no tipo, a tela não tinha como contar a diferença.
    apiClient.post<{ subscription: SubscriptionView; duplicate?: boolean }>(
      `/platform/tenants/${tenantId}/payments`, payload
    ),

  /**
   * Liga ou desliga a isenção de cobrança: a assinatura fica ativa, não vence
   * e não gera fatura até desligar. Ao ligar, as cobranças abertas são
   * canceladas no gateway (`canceledCharges` diz quantas, `failedCharges`
   * quantas ficaram em aberto porque o gateway recusou). 409 `not_billable`
   * numa assinatura cancelada.
   *
   * `subscription` é o MESMO corpo de `getSubscription` — a tela troca o que
   * mostra sem perguntar de novo.
   */
  setBillingExempt: (tenantId: number, payload: { exempt: boolean; reason?: string; until?: string | null }) =>
    apiClient.requestWithBody<{
      subscription: {
        tenant: { id: number; slug: string; name: string }
        subscription: SubscriptionView | null
        planId: number | null
        events: BillingEventView[]
      }
      canceledCharges: number
      failedCharges: number
      alreadyInState: boolean
      untilChanged?: boolean
    }>(
      'PUT', `/platform/tenants/${tenantId}/subscription/billing-exempt`, payload
    ),

  // ── A aba Assinaturas: a carteira inteira e a mão nas cobranças ─────
  listSubscriptions: () =>
    apiClient.get<{ rows: SubscriptionConsoleRow[]; summary: SubscriptionConsoleSummary }>(
      '/platform/subscriptions'
    ),

  listTenantCharges: (tenantId: number) =>
    apiClient.get<{ charges: ChargeConsoleView[] }>(`/platform/tenants/${tenantId}/charges`),

  /** Mexe nos prazos sem mexer no estado: data exata ou `extendDays` a mais. */
  updateSubscriptionDeadlines: (tenantId: number, payload: {
    renewsAt?: string; trialEndsAt?: string; extendDays?: number; reason?: string
  }) =>
    apiClient.requestWithBody<{ subscription: SubscriptionView }>(
      'PATCH', `/platform/tenants/${tenantId}/subscription/deadlines`, payload
    ),

  /**
   * Dá baixa numa cobrança paga fora do gateway (ou que o webhook perdeu).
   * 409 `underpaid` e `already_recorded_underpaid` trazem
   * `paidCents`/`expectedCents`; reenviar com `allowUnderpayment` registra
   * mesmo assim. 409 `subscription_inactive` (assinatura suspensa ou
   * cancelada) se contorna com `force`.
   */
  settleCharge: (tenantId: number, chargeId: number, payload: {
    paidAt: string; amountCents: number; allowUnderpayment?: boolean; force?: boolean; note?: string
  }) =>
    apiClient.post<{ charge: ChargeConsoleView; subscription: SubscriptionView | null; duplicate: boolean }>(
      `/platform/tenants/${tenantId}/charges/${chargeId}/settle`, payload
    ),

  cancelCharge: (tenantId: number, chargeId: number, payload: { reason?: string }) =>
    apiClient.post<{ charge: ChargeConsoleView }>(
      `/platform/tenants/${tenantId}/charges/${chargeId}/cancel`, payload
    ),

  updateCharge: (tenantId: number, chargeId: number, payload: { dueDate?: string; amountCents?: number }) =>
    apiClient.requestWithBody<{ charge: ChargeConsoleView }>(
      'PATCH', `/platform/tenants/${tenantId}/charges/${chargeId}`, payload
    ),

  /**
   * Estorna a cobrança paga, inteira, e desfaz o período que ela pagou: o
   * `renewsAt` volta os dias que aquele pagamento comprou. `outsideGateway`
   * só registra no painel o estorno já feito fora do gateway. 409 `not_paid`
   * e `busy`, 502 `gateway_failed` (com `detail`), 404 `not_found`.
   */
  refundCharge: (tenantId: number, chargeId: number, payload: { reason?: string; outsideGateway?: boolean }) =>
    apiClient.post<{
      charge: ChargeConsoleView
      subscription: SubscriptionView | null
      renewsAtBefore: string | null
      renewsAtAfter: string | null
      alreadyRefunded: boolean
    }>(
      `/platform/tenants/${tenantId}/charges/${chargeId}/refund`, payload
    ),

  reissueCharge: (tenantId: number, chargeId: number) =>
    apiClient.post<{ charge: ChargeConsoleView }>(
      `/platform/tenants/${tenantId}/charges/${chargeId}/reissue`, {}
    ),

  /**
   * Põe na fila a NFS-e de uma cobrança paga — ou outra no lugar da que deu
   * erro ou foi cancelada. 202; 409 `not_paid`, `no_gateway_payment`,
   * `nfse_disabled`, `invoice_exists`, `busy`; 404 `not_found`.
   */
  issueChargeInvoice: (tenantId: number, chargeId: number) =>
    apiClient.post<{ charge: ChargeConsoleView; invoice: InvoiceConsoleView }>(
      `/platform/tenants/${tenantId}/charges/${chargeId}/invoice`, {}
    ),

  getUsage: (tenantId: number) =>
    apiClient.get<SubscriptionUsage & { tenant: { id: number; slug: string; name: string } }>(
      `/platform/tenants/${tenantId}/usage`
    ),

  /**
   * Apaga um provedor e tudo o que é dele.
   *
   * A rota existe desde a onda 22 e não tinha botão. Não tem volta: leva
   * assinantes, equipamentos, conversas e a trilha DELE junto — o que sobrevive
   * é a linha em `platform_audit` dizendo que isto aconteceu, que é
   * compartilhada de propósito, justamente para não ser apagada com o que
   * registra.
   */
  // `confirmSlug` vai no corpo: o backend confere o slug de novo, exato, e
  // recusa o DELETE sem ele. `apiClient.delete` não manda corpo nenhum.
  deleteTenant: (id: number, confirmSlug: string) =>
    apiClient.requestWithBody<{ tenant: { id: number; slug: string; name: string } }>(
      'DELETE', `/platform/tenants/${id}`, { confirmSlug }
    ),

  /**
   * A trilha do plano de controle: o que quem opera o SaaS fez COM um provedor.
   *
   * Paginada por `before` e não por página numerada, porque a tabela cresce pela
   * frente: um "página 2" calculado por deslocamento pula ou repete linhas
   * quando algo é escrito entre um pedido e o outro.
   */
  listAudit: (params: { limit?: number; before?: number | null } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.before) query.set('before', String(params.before))
    const suffix = query.toString()
    return apiClient.get<PlatformAuditPage>(`/platform/audit${suffix ? `?${suffix}` : ''}`)
  },

  /**
   * Os fatos do deploy — edição, banco, endereços, o que está configurado.
   *
   * Só leitura, e sem escrita nenhuma do outro lado: o que esta tela mostra
   * mora em variáveis de ambiente, e variável de ambiente se muda no servidor
   * e reiniciando. Um formulário aqui prometeria o que a rota não entrega.
   */
  deployment: () =>
    apiClient.get<DeploymentInfo>('/platform/deployment'),

  /**
   * O catálogo de equipamentos que um provedor novo herda, e quem está sem um.
   *
   * Só leitura: editar o catálogo padrão é editar o da caixa da plataforma, nas
   * telas de Configuração que já existem.
   */
  catalogue: () =>
    apiClient.get<DefaultCatalogue>('/platform/catalogue'),

  /**
   * Leva aos provedores o que o catálogo da caixa tem e eles não. Sem
   * `overwrite`, o que o provedor ajustou fica; com ele, os perfis de mesmo
   * nome recebem a versão padrão. Nada é apagado.
   */
  propagateCatalogue: (payload: { tenantIds?: number[]; overwrite?: boolean } = {}) =>
    apiClient.post<{ overwrite: boolean; results: CataloguePropagation[] }>('/platform/catalogue/propagate', payload),

  /** O GenieACS de um provedor: na SaaS é o console quem o configura. */
  getTenantGenieAcs: (tenantId: number) =>
    apiClient.get<TenantGenieAcs>(`/platform/tenants/${tenantId}/genieacs`),

  /** `secret` ausente mantém o guardado; `''` apaga. */
  updateTenantGenieAcs: (tenantId: number, payload: {
    url?: string; mode?: GenieAcsConnectionMode; ownership?: GenieAcsOwnership; authType?: GenieAcsAuthType; username?: string; secret?: string
    virtualParameters?: Record<string, string>; deviceTag?: string; autoTagPrefixes?: string
  }) =>
    apiClient.put<TenantGenieAcs>(`/platform/tenants/${tenantId}/genieacs`, payload),

  /** Sem `apply` é só a prévia: quantos equipamentos seriam marcados. */
  tagTenantDevices: (tenantId: number, payload: { pppoePrefix?: string; serials?: string; apply?: boolean }) =>
    apiClient.post<TenantDeviceTagging>(`/platform/tenants/${tenantId}/genieacs/tag-devices`, payload),

  /**
   * Gera a chave do agente do GenieACS deste provedor. A resposta traz a chave
   * inteira UMA vez; gerar outra desconecta o agente que roda com a atual.
   */
  generateTenantGenieAcsAgentToken: (tenantId: number) =>
    apiClient.post<GenieAcsAgentToken>(`/platform/tenants/${tenantId}/genieacs/agent-token`),

  testTenantGenieAcs: (tenantId: number, url?: string) =>
    apiClient.post<{ deviceCount?: number }>(`/platform/tenants/${tenantId}/genieacs/test`, url ? { url } : {}),

  /** Os firmwares do ACS compartilhado sem o prefixo de provedor nenhum. */
  listUnownedFirmware: (tenantId: number) =>
    apiClient.get<TenantUnownedFirmware>(`/platform/tenants/${tenantId}/genieacs/firmware/unowned`),

  /**
   * Regrava um firmware sem dono como deste provedor (`<tag>--<nome>`), com os
   * metadados do antigo. O painel não baixa do GenieACS: quem manda os bytes é
   * o administrador, com o arquivo original do computador dele. O antigo fica —
   * apagá-lo é o outro botão.
   */
  reassignFirmware: (tenantId: number, originalName: string, file: File) =>
    apiClient.sendBlob<FirmwareFileInfo>(
      `/platform/tenants/${tenantId}/genieacs/firmware/reassign`,
      file,
      { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(originalName) }
    ),

  deleteUnownedFirmware: (tenantId: number, name: string) =>
    apiClient.delete(`/platform/tenants/${tenantId}/genieacs/firmware/unowned/${encodeURIComponent(name)}`),

  /** O cadastro do próprio console: quem tem a chave do plano de controle. */
  listAdmins: () =>
    apiClient.get<{ admins: PlatformAdminView[] }>('/platform/admins'),

  addAdmin: (payload: { username: string }) =>
    apiClient.post<{ admin: PlatformAdminView }>('/platform/admins', payload),

  removeAdmin: (userId: number) =>
    apiClient.delete<{ userId: number }>(`/platform/admins/${userId}`),

  // ── Os cupons de desconto ───────────────────────────────────────────
  listCoupons: () =>
    apiClient.get<{ coupons: CouponView[] }>('/platform/coupons'),

  /** Recusa o de 100% (`coupon_full_discount`) e o código repetido (409 `coupon_code_taken`). */
  createCoupon: (payload: {
    code: string; kind: CouponKind; value: number; duration: CouponDuration; durationCycles?: number | null
    maxRedemptions?: number | null; validUntil?: string | null; planIds?: number[] | null; active?: boolean
  }) =>
    apiClient.post<{ coupon: CouponView }>('/platform/coupons', payload),

  /** Só as portas do resgate mudam; código, desconto e duração são fixos. */
  updateCoupon: (id: number, payload: Partial<{ active: boolean; validUntil: string | null; maxRedemptions: number | null }>) =>
    apiClient.requestWithBody<{ coupon: CouponView }>('PATCH', `/platform/coupons/${id}`, payload),

  /** Apaga o nunca resgatado; o resgatado é desativado (`deactivated: true`). */
  deleteCoupon: (id: number) =>
    apiClient.delete<{ deleted: boolean; deactivated: boolean; coupon: CouponView | null }>(`/platform/coupons/${id}`),

  /**
   * Aplica (`code`, substituindo o que houver) ou tira (`null`) o cupom de um
   * provedor. 409 `coupon_invalid`, `coupon_expired`, `coupon_exhausted`,
   * `coupon_plan_mismatch`, `coupon_already_applied`; 502 `gateway_failed`
   * (o console reaplica mesmo a quem já resgatou o cupom — sem contar outro resgate)
   * quando a fatura em aberto não pôde ser cancelada (nada muda).
   */
  setSubscriptionCoupon: (tenantId: number, code: string | null) =>
    apiClient.requestWithBody<{
      subscription: {
        tenant: { id: number; slug: string; name: string }
        subscription: SubscriptionView | null
        planId: number | null
        events: BillingEventView[]
      }
      charge: 'none' | 'reissued'
      changed: boolean
    }>('PUT', `/platform/tenants/${tenantId}/subscription/coupon`, { code }),

  // ── O painel de inadimplência: quem deve, e as ações em massa ─────────
  listDelinquency: (filters: DelinquencyFilters = {}) => {
    const params = new URLSearchParams()
    for (const [chave, valor] of Object.entries(filters)) {
      if (valor) params.set(chave, String(valor))
    }
    const query = params.toString()
    return apiClient.get<{ rows: DelinquencyRow[]; summary: DelinquencySummary }>(
      `/platform/delinquency${query ? `?${query}` : ''}`
    )
  },

  /**
   * Uma ação sobre muitos provedores (até 200). Cada um responde por si em
   * `results` (`ok` e `code`); o pedido só falha inteiro (400) por ação, lista
   * ou parâmetro inválidos.
   */
  runDelinquencyAction: (payload: {
    tenantIds: number[]
    action: DelinquencyAction
    params?: { reason?: string; until?: string; days?: number; requestId?: string }
  }) =>
    apiClient.post<{
      action: DelinquencyAction
      results: DelinquencyActionResult[]
      okCount: number
      failedCount: number
    }>('/platform/delinquency/actions', payload)
}

/** As faixas de atraso do painel de inadimplência, em dias. */
export type DelinquencyBucket = '1-7' | '8-15' | '16-30' | '30+'

export type DelinquencyAction = 'remind' | 'suspend' | 'exempt' | 'extend'

export type DelinquencyStatusFilter = 'past_due' | 'suspended' | 'auto_suspended' | 'manual_suspended'

export interface DelinquencyFilters {
  bucket?: DelinquencyBucket | ''
  status?: DelinquencyStatusFilter | ''
  q?: string
  sort?: 'amount' | 'days' | ''
  order?: 'asc' | 'desc' | ''
}

/** Um provedor que deve: quanto (por tipo de cobrança), desde quando, e o que vem a seguir. */
export interface DelinquencyRow {
  tenant: { id: number; name: string; slug: string; status: string }
  status: SubscriptionStatus
  storedStatus: SubscriptionStatus
  suspendedReason: string | null
  overdueReason: string | null
  overdueSince: string | null
  daysOverdue: number
  bucket: DelinquencyBucket
  /** A soma das cobranças em aberto JÁ vencidas. */
  amountCents: number
  amountByKind: { renewal: number; proration: number; overage: number }
  /** Todas as em aberto, inclusive as que ainda vão vencer. */
  openCents: number
  currency: string
  overdueCharges: number
  plan: { id: number | null; code: string | null; name: string | null }
  renewsAt: string | null
  trialEndsAt: string | null
  lastReminder: SubscriptionReminderView | null
  /** A previsão da suspensão automática; nula quando já está suspenso ou ela está desligada. */
  autoSuspendAt: string | null
  autoSuspendWarned: boolean
  card: SubscriptionCard
  gateway: { gateway: string | null; linked: boolean }
}

export interface DelinquencySummary {
  count: number
  byBucket: Record<DelinquencyBucket, number>
  totalOverdueCents: number
  totalsByCurrency: Array<{ currency: string; cents: number }>
  autoSuspendDays: number
}

export interface DelinquencyActionResult {
  tenantId: number
  ok: boolean
  code: string
  retryAt?: string
}

/** The provider's own plan, state and usage — the "plan and usage" screen, and what the block screen reads. */
export const subscriptionAPI = {
  current: () => apiClient.get<SubscriptionUsage>('/tenant/subscription'),

  /**
   * As cobranças emitidas, com o link de pagamento das que estão em aberto.
   *
   * Como `/tenant/subscription`, responde a um provedor BLOQUEADO — é a rota
   * que dá a saída do muro do 402, e por isso a tela de bloqueio também a
   * chama.
   */
  charges: () => apiClient.get<{ charges: TenantChargeView[] }>('/tenant/charges'),

  /** Os planos à venda, com o atual marcado. */
  plans: () => apiClient.get<TenantPlanOption[]>('/tenant/plans'),

  /**
   * Troca o plano, sem proporcional: a próxima cobrança já sai com o preço
   * novo. Subir vale na hora; descer com a assinatura `active` e renovação
   * futura fica agendado (`pendingPlan`) para a renovação. Pedir o plano atual
   * com uma descida agendada a cancela. O `message` da resposta, já
   * traduzido, diz qual dos três aconteceu. Recusa com `over_limit` (e
   * `resource`/`used`/`limit`) quando o uso atual não cabe no plano escolhido.
   */
  changePlan: (planId: number, cycle?: BillingCycle) =>
    apiClient.put<SubscriptionUsage & { proration?: PlanChangeProration }>(
      '/tenant/subscription/plan', cycle ? { planId, cycle } : { planId }
    ),

  /**
   * Emite (ou reaproveita) a cobrança do período e devolve o link de
   * pagamento. Recusa sem cadastro fiscal (`missing_tax_id`,
   * `invalid_tax_id`, `missing_name`), em plano grátis (`free_plan`) e com a
   * assinatura isenta de cobrança (409 `billing_exempt`).
   *
   * 201 (cobrança nova) e 200 (reaproveitada) são ambos sucesso: `request`
   * olha `response.ok`, não o número, então os dois chegam iguais aqui.
   */
  payNow: () =>
    apiClient.post<{ charge: TenantChargeView }>('/tenant/charges/pay', {}),

  /**
   * "Tenho um cupom": aplica o código à assinatura e devolve a mesma tela de
   * `current()`, com `subscription.coupon`. 409 na recusa: `coupon_invalid`
   * (inexistente, inativo, vencido, esgotado ou de outro plano — a rota do
   * provedor não diz qual), `coupon_already_applied` e `coupon_already_used`
   * (este provedor já resgatou o cupom).
   */
  applyCoupon: (code: string) =>
    apiClient.post<SubscriptionUsage>('/tenant/subscription/coupon', { code }),

  /**
   * Liga ou desliga a cobrança automática no cartão. Ligar só registra a
   * intenção: o cartão é salvo quando uma fatura é paga com cartão na página
   * do Asaas. Devolve a mesma tela de `current()`. 409 `not_changeable`
   * (assinatura parada) e `not_billable` (outro gateway).
   */
  setCardAutopay: (enabled: boolean) =>
    apiClient.put<SubscriptionUsage>('/tenant/subscription/autopay', { enabled }),

  /** Esquece o cartão salvo; a cobrança de cartão em aberto vira Pix/boleto. */
  removeCard: () =>
    apiClient.delete<SubscriptionUsage>('/tenant/subscription/card'),

  /**
   * A retenção no cancelamento (0107) — só o dono (403 `owner_only` para os
   * outros). `cancellation()` lê os motivos e as ofertas;
   * `requestCancellation` grava o motivo e devolve as ofertas;
   * `acceptRetention` aceita o desconto ou a pausa; `confirmCancellation`
   * recusa e cancela no fim do período pago (ou na hora, sem período pago);
   * `revertCancellation` desfaz o agendado.
   */
  cancellation: () =>
    apiClient.get<CancellationStatus>('/tenant/subscription/cancellation'),
  requestCancellation: (reason: CancellationReason, comment?: string) =>
    apiClient.post<{ request: CancellationRequestView; offers: CancellationOffers }>(
      '/tenant/subscription/cancellation', { reason, ...(comment ? { comment } : {}) }
    ),
  acceptRetention: (offer: 'discount' | 'pause', months?: number) =>
    apiClient.post<{ offer: 'discount' | 'pause'; subscription: SubscriptionView; pausedUntil?: string; priceCents?: number }>(
      '/tenant/subscription/cancellation/accept', { offer, ...(months ? { months } : {}) }
    ),
  confirmCancellation: () =>
    apiClient.post<{ immediate: boolean; cancelAt: string; subscription: SubscriptionView }>(
      '/tenant/subscription/cancellation/confirm', {}
    ),
  revertCancellation: () =>
    apiClient.delete<{ reverted: boolean; subscription: SubscriptionView }>('/tenant/subscription/cancellation')
}

/** Os motivos de cancelamento, na ordem da tela (0107). */
export const CANCELLATION_REASONS = [
  'too_expensive', 'not_using', 'missing_features', 'switching_provider',
  'technical_issues', 'business_closed', 'temporary', 'other'
] as const
export type CancellationReason = typeof CANCELLATION_REASONS[number]

/** As ofertas de retenção e, na que não vale, por quê. */
export interface CancellationOffers {
  discount: {
    available: boolean
    reason: 'disabled' | 'not_eligible' | 'used_recently' | 'better_coupon' | null
    percent: number
    /** Quantas faturas o desconto cobre: no ciclo anual (0104), uma — a anual seguinte. */
    months: number
    billingCycle?: BillingCycle
    priceCents: number
    availableAgainAt: string | null
    /** No anual: a configuração (% por meses) que `percent` traduz para uma fatura anual. */
    configPercent?: number
    configMonths?: number
  }
  pause: {
    available: boolean
    reason: 'disabled' | 'not_eligible' | 'already_paused' | 'pause_cooldown' | null
    /** Na carência (uma pausa a cada doze meses), quando volta a valer. */
    availableAgainAt?: string | null
    maxMonths: number
    /** Quando a pausa começaria: o fim do período pago. */
    from: string | null
  }
}

export interface CancellationRequestView {
  id: number
  reason: CancellationReason
  comment: string | null
  offersPresented: Array<'discount' | 'pause'>
  offer: 'discount' | 'pause' | 'none' | null
  outcome: 'retained_discount' | 'retained_pause' | 'canceled' | 'reverted' | null
  months: number | null
  discountPercent: number | null
  /** O ciclo da fatura que o desconto aceito cobre (0104). */
  billingCycle?: BillingCycle | null
  cancelAt: string | null
  createdAt: string | null
  decidedAt: string | null
  revertedAt: string | null
  revertedBy: 'provider' | 'console' | null
}

export interface CancellationStatus {
  reasons: CancellationReason[]
  canCancel: boolean
  offers: CancellationOffers
  request: CancellationRequestView | null
  scheduled: CancellationRequestView | null
  cancelAt: string | null
  pausedUntil: string | null
  /** Quando o cancelamento valeria se confirmado agora; nulo é na hora. */
  cancelWouldTakeEffectAt: string | null
}

/** O relatório de cancelamentos do console (`GET /platform/reports/cancellations`). */
export interface CancellationReport {
  total: number
  byReason: Record<CancellationReason, number>
  byOutcome: Record<'retained_discount' | 'retained_pause' | 'canceled' | 'reverted' | 'pending', number>
  offers: Record<'discount' | 'pause', { presented: number; accepted: number }>
  retained: number
  decided: number
  /** Retidos ÷ decididos, de 0 a 1; nulo sem nenhum decidido. */
  retentionRate: number | null
  requests: Array<CancellationRequestView & { tenant: { id: number; name: string | null; slug: string | null } }>
}

export const usersAPI = {
  list: () =>
    apiClient.get<{ users: Operator[] }>('/users'),

  /**
   * `email` é obrigatório: conta nova nasce com endereço, e é isso que faz o
   * número de contas sem e-mail parar de crescer enquanto a transição dura.
   */
  create: (payload: { username: string; password: string; email: string; role: OperatorRole }) =>
    apiClient.post<{ user: Operator }>('/users', payload),

  /** Sends only what changes: a role, a new password, or both. */
  update: (id: number, payload: { role?: OperatorRole; password?: string }) =>
    apiClient.requestWithBody<{ user: Operator }>('PATCH', `/users/${id}`, payload),

  remove: (id: number) =>
    apiClient.delete<{ id: number }>(`/users/${id}`),

  /** Desliga o 2FA de quem perdeu o celular e os códigos, e derruba as sessões dela. */
  resetMfa: (id: number) =>
    apiClient.post<{ id: number; mfaEnabled: false }>(`/users/${id}/mfa-reset`, {}),
}

export interface PortalPasswordResponse {
  customerId: string
  password: string
  updatedAt?: string | null
}

// Devices API
export interface DeviceListParams {
  page?: number
  pageSize?: number
  search?: string
  /** `stale`: last Inform older than 3 days, filtered server-side. */
  status?: 'all' | 'online' | 'offline' | 'stale'
  focus?: 'all' | 'new24h' | 'weak-signal' | 'hot' | 'many-clients'
}

export interface DeviceListResponse<T> {
  devices: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface DeviceHistoryPoint {
  /** Seconds since the epoch. */
  t: number
  rx: number | null
  rxMin?: number | null
  rxMax?: number | null
  tc: number | null
  up: number | null
}

export interface DeviceHistory {
  deviceId: string
  /** Which grain the server chose for the requested window. */
  resolution: 'raw' | 'hourly'
  from: string
  to: string
  points: DeviceHistoryPoint[]
}

/** One parameter as GenieACS holds it; `read: false` means it exists but was never read. */
export interface DeviceParameter {
  path: string
  value: string | number | boolean | null
  type: string | null
  writable: boolean | null
  timestamp: string | null
  read: boolean
}

export interface DeviceParameterList {
  rows: DeviceParameter[]
  total: number
  limit: number
  lastInform: string | null
}

export interface DeviceSwap {
  id: number
  customerId: string | null
  pppoeUsername: string | null
  previousDeviceId: string
  deviceId: string
  contract: string | null
  /** Which identity matched: same firmware hashes the same, so most swaps are `identity_hash`. */
  /**
   * `stale_pppoe`: the link was moved automatically because the old ONT had
   * been silent for 3+ days while another ONT with the same PPPoE login was online.
   */
  matchedBy: 'identity_hash' | 'pppoe' | 'stale_pppoe'
  /** What became of the previous ONT's SGP link. `held` means the pair is unstable. */
  linkAction: 'moved' | 'cleared' | 'none' | 'held'
  flapping: boolean
  repeatCount: number
  occurredAt: string | null
  acknowledgedAt: string | null
  /**
   * Quem dispensou o aviso, pelo nome. `null` para a troca que ninguém
   * dispensou ainda e para o operador que já saiu da equipe do provedor — o
   * backend resolve o nome contra a equipe atual, nunca contra o cadastro
   * global de pessoas.
   */
  acknowledgedBy: string | null
}

export interface DeviceSwapList {
  swaps: DeviceSwap[]
  open?: number
}

export interface SummonResult {
  refreshed?: string[]
  reached?: boolean
  reason?: string | null
  /** Only when `reached` is false: when the ONT last informed, and whether that is days ago. */
  lastInform?: string | null
  stale?: boolean
}

export const devicesAPI = {
  getDevices: (params: DeviceListParams = {}) => {
    const query = new URLSearchParams()
    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.pageSize !== undefined) query.set('pageSize', String(params.pageSize))
    if (params.search) query.set('search', params.search)
    if (params.status && params.status !== 'all') query.set('status', params.status)
    if (params.focus && params.focus !== 'all') query.set('focus', params.focus)
    const search = query.toString()
    return apiClient.get(`/devices${search ? `?${search}` : ''}`)
  },

  /** O recorte da lista numa planilha (CSV). A query vem de `deviceExportQuery`. */
  exportSheet: (query: URLSearchParams) => {
    const suffix = query.toString()
    return apiClient.getBlob(`/devices/export${suffix ? `?${suffix}` : ''}`)
  },

  getDashboard: (force = false) =>
    apiClient.get(`/devices/dashboard${force ? '?refresh=1' : ''}`),

  getFaults: (limit = 50) =>
    apiClient.get(`/devices/faults?limit=${encodeURIComponent(limit)}`),

  clearFault: (faultId: string) =>
    apiClient.delete(`/devices/faults/${encodeURIComponent(faultId)}`),

  getDevice: (deviceId: string) =>
    apiClient.get(`/devices/${encodeURIComponent(deviceId)}`),

  getHistory: (deviceId: string, range: { from?: string; to?: string } = {}) => {
    const query = new URLSearchParams()
    if (range.from) query.set('from', range.from)
    if (range.to) query.set('to', range.to)
    const suffix = query.toString()
    return apiClient.get<DeviceHistory>(
      `/devices/${encodeURIComponent(deviceId)}/history${suffix ? `?${suffix}` : ''}`
    )
  },

  getDeviceParameters: (deviceId: string, search = '') => {
    const query = new URLSearchParams({ deviceId })
    if (search) query.set('search', search)
    return apiClient.get<DeviceParameterList>(`/devices/parameters?${query.toString()}`)
  },

  getSwaps: () => apiClient.get<DeviceSwapList>('/devices/swaps'),

  getDeviceSwaps: (deviceId: string) =>
    apiClient.get<DeviceSwapList>(`/devices/${encodeURIComponent(deviceId)}/swaps`),

  acknowledgeSwap: (id: number) =>
    apiClient.post<DeviceSwap>(`/devices/swaps/${encodeURIComponent(id)}/acknowledge`),

  // Remove a ONT do GenieACS. Pede o mesmo que o reset de fábrica: a série
  // digitada e a senha do operador duas vezes, conferidas pelo servidor.
  deleteDevice: (deviceId: string, confirmSerial: string, password: string, passwordConfirm: string) =>
    apiClient.delete(`/devices/${encodeURIComponent(deviceId)}`, { confirmSerial, password, passwordConfirm }),

  rebootDevice: (deviceId: string) =>
    apiClient.post('/devices/reboot', { deviceId }),

  // A série digitada vai junto: o servidor confere que é a DESTE aparelho. E a
  // senha do operador, duas vezes: o servidor confere que as duas são iguais e
  // que é a dele.
  factoryResetDevice: (deviceId: string, confirmSerial: string, password: string, passwordConfirm: string) =>
    apiClient.post('/devices/factory-reset', { deviceId, confirmSerial, password, passwordConfirm }),

  // Ping e traceroute pela ONT. O aparelho vai no corpo, como no reiniciar.
  startDiagnostic: (deviceId: string, kind: DeviceDiagnosticKind, host: string) =>
    apiClient.post<DeviceDiagnosticStart>('/devices/diagnostics', { deviceId, kind, host }),

  readDiagnostic: (deviceId: string, kind: DeviceDiagnosticKind) =>
    apiClient.post<DeviceDiagnosticResult>('/devices/diagnostics/result', { deviceId, kind }),

  // Uma ação em vários aparelhos de uma vez (até 200), com o resultado de cada um.
  runBatch: (action: DeviceBatchAction, deviceIds: string[], filter?: Record<string, string>, fileId?: string) =>
    apiClient.post<DeviceBatchResponse>('/devices/batch', { action, deviceIds, filter, fileId }),

  listFirmwareCatalog: () => apiClient.get<DeviceFirmwareCatalog>('/devices/firmware/files'),

  // O arquivo cru no corpo e os metadados em cabeçalho, como o anexo do
  // WhatsApp (`uploadAttachment`). No ACS compartilhado o servidor põe o
  // prefixo do provedor no nome — a resposta traz o nome final.
  uploadFirmware: (file: File, meta: FirmwareMeta) =>
    apiClient.sendBlob<FirmwareFileInfo>('/devices/firmware/files', file, firmwareUploadHeaders(file.name, meta)),

  deleteFirmware: (name: string) =>
    apiClient.delete(`/devices/firmware/files?name=${encodeURIComponent(name)}`),

  // Os firmwares do GenieACS que servem para o modelo desta ONT.
  listFirmware: (deviceId: string) =>
    apiClient.get<DeviceFirmwareList>(`/devices/firmware?${new URLSearchParams({ deviceId }).toString()}`),

  upgradeFirmware: (deviceId: string, fileId: string) =>
    apiClient.post<DeviceFirmwareUpgrade>('/devices/firmware/upgrade', { deviceId, fileId }),

  // `reached` is false when GenieACS could not call the ONT back (CGNAT, offline)
  // and only queued the tasks for its next periodic Inform.
  summonDevice: (deviceId: string, parameters?: string[]) =>
    apiClient.post<SummonResult>('/devices/summon', { deviceId, parameters }),

  updateWanConfig: (deviceId: string, wanIndex: string, formData: any) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-wan`, { wanIndex, formData });
  },

  addWanConnection: (deviceId: string, containerPath: string, type: 'ppp' | 'ip') =>
    apiClient.post(`/devices/${encodeURIComponent(deviceId)}/add-wan`, { containerPath, type }),

  updateInstallationDate: (deviceId: string, installationDate: string) =>
    apiClient.put(`/devices/${encodeURIComponent(deviceId)}/installation-date`, { installationDate }),

  updateWifiConfig: (deviceId: string, index: number, formData: any) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-wifi`, { index, formData });
  },

  updateCredentials: (deviceId: string, type: 'super' | 'user', password: string) => {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/update-credentials`, { type, password });
  },

  getPortalPassword: (deviceId: string) =>
    apiClient.get<PortalPasswordResponse>(
      `/devices/${encodeURIComponent(deviceId)}/portal-password`
    ),

  resetPortalPassword: (deviceId: string) =>
    apiClient.post<PortalPasswordResponse>(
      `/devices/${encodeURIComponent(deviceId)}/portal-password/reset`
    )
}

// Settings API
export const settingsAPI = {
  getAll: () =>
    apiClient.get('/settings'),

  /** O que muda como o painel se desenha para toda a equipe (hoje, o formato da data). Só pede sessão. */
  display: () =>
    apiClient.get<{ dateFormat: string }>('/settings/display'),

  get: (key: string) =>
    apiClient.get(`/settings/${key}`),

  create: (key: string, value: string) =>
    apiClient.post('/settings', { key, value }),

  update: (key: string, value: string) =>
    apiClient.put(`/settings/${key}`, { value }),

  syncCustomerIds: () =>
    apiClient.post('/settings/sync-customer-ids'),

  /** Como está a sincronização de IDs de cliente (em curso, última passada). */
  customerIdSyncStatus: () =>
    apiClient.get<CustomerIdSyncStatus>('/settings/customer-id-sync'),

  delete: (key: string) =>
    apiClient.delete(`/settings/${key}`),

  testGenieAcs: (url: string) =>
    apiClient.post('/settings/test-genieacs', { url }),

  getGenieAcsAuth: () =>
    apiClient.get<GenieAcsAuthConfig>('/settings/genieacs-auth'),

  updateGenieAcsAuth: (payload: GenieAcsAuthPayload) =>
    apiClient.put<GenieAcsAuthConfig>('/settings/genieacs-auth', payload),

  /** Como o painel chega ao GenieACS deste provedor, e o estado do agente. */
  getGenieAcsConnection: () =>
    apiClient.get<GenieAcsConnectionSettings>('/settings/genieacs-connection'),

  /**
   * Troca o modo. Só a instalação própria: na SaaS o servidor responde 403
   * `platform_managed` (quem escolhe é a plataforma). `tunnel` não é oferecido
   * aqui — fora da SaaS a rede privada já é permitida, e o servidor recusa.
   */
  updateGenieAcsConnection: (payload: { mode: Exclude<GenieAcsConnectionMode, 'tunnel'> }) =>
    apiClient.put<GenieAcsConnectionSettings>('/settings/genieacs-connection', payload),

  /**
   * Gera a chave do agente. Vale nas duas edições (quem instala o agente é o
   * provedor), mas só com o modo gravado em `agent` — senão 409 `mode_not_agent`.
   */
  generateGenieAcsAgentToken: () =>
    apiClient.post<GenieAcsAgentToken>('/settings/genieacs-connection/agent-token'),

  /**
   * O endereço de GenieACS que o deploy sugere a este provedor, ou `null`.
   *
   * `null` é resposta e não falha: um deploy que não hospeda ACS nenhum não
   * configura o template, e a tela se comporta como se comportava antes.
   */
  genieAcsSuggestion: () =>
    apiClient.get<GenieAcsSuggestion>('/settings/genieacs-suggestion'),

  /** Os primeiros passos do provedor: o checklist e se o assistente já foi visto. */
  onboardingStatus: () =>
    apiClient.get<OnboardingStatus>('/settings/onboarding'),

  /** Marca, no provedor, que o assistente foi concluído/pulado ou o checklist ocultado. */
  dismissOnboarding: (what: 'wizard' | 'checklist') =>
    apiClient.post('/settings/onboarding/dismiss', { what }),
}

export type OnboardingItemKey = 'genieacs' | 'firstDevice' | 'provisioning' | 'sgp' | 'whatsapp' | 'team'

/** Conferido no que o provedor TEM, não numa marca clicada. */
export interface OnboardingStatus {
  wizardDone: boolean
  checklistDismissed: boolean
  items: Array<{ key: OnboardingItemKey; done: boolean }>
}

/** O que a rota de sugestão devolve. Nunca um endereço que o painel recusaria ao salvar. */
export interface GenieAcsSuggestion {
  suggestion: string | null
}

export type GenieAcsAuthType = 'none' | 'basic' | 'bearer'

/** O que o servidor conta sobre a credencial da NBI — nunca o segredo, só se existe um. */
export interface GenieAcsAuthConfig {
  authType: GenieAcsAuthType
  username: string
  secretConfigured: boolean
  authTypes: GenieAcsAuthType[]
  /**
   * Se o ACS deste provedor é da plataforma (só leitura na tela). `false` na
   * self-hosted e quando o console marcou que ele usa o próprio servidor.
   */
  platformManaged?: boolean
}

export interface GenieAcsAuthPayload {
  authType?: GenieAcsAuthType
  username?: string
  /**
   * Ausente MANTÉM o segredo guardado; string vazia APAGA.
   *
   * A tela não reexibe o segredo, então um formulário que salvasse o campo em
   * branco como string vazia apagaria a credencial a cada salvamento. Quem
   * chama tem que omitir a chave quando o operador não digitou nada — daí o
   * tipo ser opcional em vez de `string`.
   */
  secret?: string
}

export interface SgpConfig {
  enabled: boolean
  baseUrl: string
  app: string
  linkMode: 'pppoe' | 'customer_id' | 'manual'
  portalBilling: boolean
  portalUnlock: boolean
  invoiceLimit: number
  endpoints: {
    customer: string
    invoices: string
    unlock: string
    ticket: string
    /** The full client listing behind the contacts sync. Empty until set. */
    customerList: string
    /** The settlement route; `{id}` is the invoice's SGP id. */
    invoiceSettle?: string
  }
  tokenConfigured: boolean
  ready: boolean
  updatedAt: string | null
  webhookEnabled: boolean
  webhookRequireTimestamp: boolean
  webhookToleranceSeconds: number
  webhookSecretConfigured: boolean
  webhookPath: string
  reconcileEnabled: boolean
  reconcileIntervalMinutes: number
  reconcileBatchSize: number
  eventRetentionDays: number
  eventTypeMap: Record<string, string>
  ticketEnabled: boolean
  /** The install's own Tipo de Ocorrência id; SGP documents 5 as the default. */
  ticketOccurrenceType: number
  /** The receiving point (cash desk) id settlements go to; 0 = not set. */
  settleReceivingPoint: number
  settlePaymentMethods: string[]
  settleFees: number
  settleReady: boolean
  contactsSyncEnabled: boolean
  contactsSyncIntervalHours: number
  contactsPageSize: number
  contactsPaging: 'offset' | 'page'
  contactsOffsetParam: string
  contactsLimitParam: string
}

/** What one run of the SGP contacts sync did. */
export interface SgpContactsSyncResult {
  total: number
  created: number
  updated: number
  withoutContract: number
  pages: number
  /** True when a ceiling or an SGP that ignores paging stopped the run early. */
  partial: boolean
  reason?: 'paging_ignored' | 'ceiling' | 'empty' | 'error'
  /** The SGP ignored the page size and sent its whole base in one answer — complete, not partial. */
  note?: 'all_at_once'
  durationMs: number
  startedAt: string
  finishedAt: string
}

/** The contacts sync as the settings screen polls it: the sync runs in the background. */
export interface SgpContactsSyncStatus {
  lastRun: SgpContactsSyncResult | null
  running: boolean
  /** Why the last attempt failed, already translated; cleared by the next run that finishes. */
  lastError: { at: string; code: string; message: string } | null
}

/** The first page of the listing, for the test button. Nothing is written. */
export interface SgpContactsTestResult {
  /** How long the page took — what the page size should be chosen by. */
  durationMs: number
  pageSize: number
  /** Field names inside nested `contratos`/`contatos`, never values. */
  shape: Record<string, string>
  received: number
  rows: number
  withContract: number
  withPhone: number
  fields: string[]
  sample: { contract: string | null; name: string | null; hasPhone: boolean }[]
}

export interface SgpTicket {
  contract: string
  /** Null when the install answers in a shape we do not recognise. */
  ticket: string | null
  message: string | null
}

export interface SgpEvent {
  id: number
  source: 'webhook' | 'reconcile' | 'manual'
  type: string
  rawType: string | null
  contract: string | null
  document: string | null
  login: string | null
  deviceId: string | null
  status: 'pending' | 'processed' | 'ignored' | 'failed'
  attempts: number
  payload: string | null
  error: string | null
  occurredAt: string | null
  receivedAt: string | null
  processedAt: string | null
}

export interface SgpContractLink {
  contract: string
  clientName: string | null
  document: string | null
  plan: string | null
  status: string | null
  statusLabel: string | null
  /**
   * A situação classificada pelo servidor — `deriveContractState`, que testa
   * cancelamento ANTES de "ativo" porque "Inativo" contém "ativo".
   *
   * Já vinha no payload desde sempre (`publicLink`); faltava estar declarado
   * aqui, e por isso a tela do aparelho re-derivava na mão com um regex que
   * pintava contrato inativo de verde. A cor do selo sai daqui, nunca do
   * rótulo — ver `lib/sgp.ts`.
   */
  state: SgpContractState
  login: string | null
  blocked: boolean | null
  linkMode: 'auto' | 'manual'
  lastSyncedAt: string | null
}

export type SgpContractState = 'active' | 'blocked' | 'cancelled' | 'unknown'

export interface SgpLinkRow {
  deviceId: string
  contract: string
  clientName: string | null
  plan: string | null
  status: string | null
  statusLabel: string | null
  state: SgpContractState
  linkMode: 'auto' | 'manual'
  lastSyncedAt: string | null
}

export interface SgpDivergenceRow {
  deviceId: string
  contract: string
  clientName: string | null
  statusLabel: string | null
  state: SgpContractState
  lastInform: string | null
}

/** An active contract whose linked ONT has sent no Inform for more than 3 days. */
export interface SgpStaleActiveRow extends SgpDivergenceRow {
  /** The ONT that probably replaced it, when one could be found online. */
  successor: {
    deviceId: string
    lastInform: string | null
    matchedBy: 'pppoe' | 'contract'
  } | null
}

export interface SgpUnlinkedRow {
  deviceId: string
  customerId: string | null
  pppoe: string | null
}

export interface SgpSyncSummary {
  total: number
  linked: number
  created: number
  updated: number
  failed: number
  skipped: number
  /** Links moved off an ONT silent for 3+ days onto the online ONT with the same PPPoE login. */
  relinked?: number
  durationMs: number
  startedAt: string | null
  finishedAt: string | null
}

export interface SgpFleetOverview {
  enabled: boolean
  // `totals` carries the full counts; the `divergences` lists are capped samples.
  totals: {
    devices: number
    linked: number
    unlinked: number
    onlineBlocked: number
    offlineActive: number
    staleActive: number
  }
  byState: Record<SgpContractState, number>
  divergences: {
    onlineBlocked: SgpDivergenceRow[]
    offlineActive: SgpDivergenceRow[]
    staleActive: SgpStaleActiveRow[]
    unlinked: SgpUnlinkedRow[]
  }
  lastSync: SgpSyncSummary | null
  generatedAt: string
}

export interface SgpInvoice {
  id: string | null
  /** The SGP's own id of the invoice, the one a settlement is addressed by. */
  sgpId?: string | null
  description: string | null
  amount: number | null
  dueDate: string | null
  paidAt: string | null
  status: string | null
  digitableLine: string | null
  barcode: string | null
  link: string | null
  pix: string | null
  paid: boolean
}

export interface ContactAddress {
  street?: string
  number?: string
  complement?: string
  district?: string
  city?: string
  state?: string
  zip?: string
  reference?: string
  /** An address the SGP sent as one line of text. */
  line?: string
}

/** One field of a client record: what shows, what the SGP has, and whether an operator changed it. */
export interface ContactField<T> {
  value: T
  sgpValue: T
  edited: boolean
  editedBy: string | null
  editedAt: string | null
}

export interface ContactProfileContract {
  key: string
  contract: string
  state: WhatsAppContactState
  status: string | null
  statusReason: string | null
  plan: string | null
  dueDay: string | null
  login: string | null
  address: string | null
  createdAt: string | null
  deviceId: string | null
  hasDevice: boolean
}

/** The full client record behind the Contacts screen. */
export interface ContactProfile {
  key: string
  /** `panel` for a client typed in the panel, with no SGP behind it. */
  source: 'sgp' | 'panel'
  clientId: string | null
  sgpUrl: string | null
  fields: {
    name: ContactField<string | null>
    personType: ContactField<string | null>
    document: ContactField<string | null>
    gender: ContactField<string | null>
    birthDate: ContactField<string | null>
    address: ContactField<ContactAddress | null>
    phones: ContactField<string[]>
    emails: ContactField<string[]>
  }
  notes: string | null
  registeredAt: string | null
  lastSeenAt: string | null
  whatsappPhone: string | null
  whatsappPhoneSource: 'manual' | 'sgp' | null
  contracts: ContactProfileContract[]
  /** Set when "Receber" can settle on the SGP: the payment methods to pick from. */
  settle?: { methods: string[] } | null
}

export type ContactProfileField = keyof ContactProfile['fields']

/** An edit: a field set to `null` goes back to the SGP's value. */
export type ContactProfilePatch = Partial<{
  name: string | null
  personType: string | null
  document: string | null
  gender: string | null
  birthDate: string | null
  address: ContactAddress | null
  phones: string[] | null
  emails: string[] | null
  notes: string | null
  whatsappPhone: string | null
}>

/** What the panel knows about a CPF/CNPJ before the "Novo cliente" form. */
export interface ContactDocumentLookup {
  document: string
  personType: 'PF' | 'PJ'
  /** Whether the SGP was asked at all (it is not when the integration is off). */
  sgpChecked: boolean
  inSgp: { key: string; name: string | null; contract: string | null; state: string }[]
  inPanel: { key: string; name: string | null } | null
  /** The TeiaH's record (or, for a company, the Receita's), for a document nobody has yet. */
  prefill: {
    source: 'teiah' | 'receita'
    birthDate: string | null
    name: string | null
    tradeName: string | null
    email: string | null
    phone: string | null
    address: ContactAddress
  } | null
  prefillError: boolean
  /** Whether the TeiaH was asked (the document is nobody's yet and the integration is on). */
  teiahConsulted: boolean
  teiahScore: {
    score: number | null
    risk: string | null
    paymentDescription: string | null
    paymentProbability: string | null
  } | null
  /** The TeiaH says the person has died. */
  deceased: boolean
}

/** The body of `POST /contacts/sgp`: the client created in the SGP, then filed here. */
export interface ContactCreateInSgp {
  document: string
  name: string
  tradeName?: string
  responsibleName?: string
  responsibleDocument?: string
  email?: string
  whatsappPhone?: string
  birthDate?: string
  notes?: string
  address: ContactAddress & { latitude?: number; longitude?: number }
}

/** What a spreadsheet import did — or, in a preview, would do. */
export interface ContactImportResult {
  total: number
  updates: number
  creates: number
  unchanged: number
  errors: { line: number; message: string }[]
  rows: { line: number; kind: 'update' | 'create'; key: string | null; name: string | null; fields: string[] }[]
  updated?: number
  created?: number
}

/** What importing the connected WhatsApp's phone book did — or, in a preview, would do. */
export interface ContactWhatsappImportResult {
  total: number
  creates: number
  existing: number
  invalid: number
  duplicated: number
  truncated: boolean
  maxCreates: number
  rows: { name: string; phone: string }[]
  created?: number
}

/** What importing a Google Contacts export (CSV, Outlook CSV or vCard) did — or would do. */
export interface ContactGoogleImportResult extends ContactWhatsappImportResult {
  format: 'google' | 'outlook' | 'vcard'
  /** The DDD given to numbers written without one: the file's most common. */
  defaultDdd: string | null
}

export interface ContactSyncResult {
  profile: ContactProfile
  sgp: { skipped: boolean; contracts: number; error: string | null }
  /** `null` when the operator may not summon devices. */
  devices: { deviceId: string; contract: string; reached: boolean; reason: string | null; error: string | null }[] | null
}

export const contactsAPI = {
  get: (key: string) =>
    apiClient.get<ContactProfile>(`/contacts/${encodeURIComponent(key)}`),

  update: (key: string, patch: ContactProfilePatch) =>
    apiClient.requestWithBody<ContactProfile>('PATCH', `/contacts/${encodeURIComponent(key)}`, patch),

  create: (data: ContactProfilePatch & { name: string }) =>
    apiClient.post<ContactProfile>('/contacts', data),

  /** This client asked of the SGP again, and its ONTs asked to report now. */
  sync: (key: string) =>
    apiClient.post<ContactSyncResult>(`/contacts/${encodeURIComponent(key)}/sync`, {}),

  /** Before the form: the SGP by document and, for a new company, the Receita. */
  lookupDocument: (document: string) =>
    apiClient.get<ContactDocumentLookup>(`/contacts/lookup/document?document=${encodeURIComponent(document.replace(/\D/g, ''))}`),

  /** The address of a CEP, to fill the form. */
  lookupCep: (cep: string) =>
    apiClient.get<{ postalCode?: string; addressLine?: string; district?: string; city?: string; state?: string; lat?: number; lng?: number }>(
      `/contacts/lookup/cep?cep=${encodeURIComponent(cep.replace(/\D/g, ''))}`
    ),

  /** Creates the client in the SGP, then files it here under the SGP's id. */
  createInSgp: (data: ContactCreateInSgp) =>
    apiClient.post<ContactProfile>('/contacts/sgp', data),

  /** The contacts as a CSV, with the list's search and state filter. */
  exportSheet: (filters: { search?: string; state?: string; noPhone?: boolean; imported?: boolean; device?: ContactDeviceFilter } = {}) => {
    const query = new URLSearchParams()
    if (filters.search) query.set('search', filters.search)
    if (filters.state) query.set('state', filters.state)
    if (filters.noPhone) query.set('noPhone', 'true')
    if (filters.imported) query.set('imported', 'true')
    if (filters.device) query.set('device', filters.device)
    const suffix = query.toString()
    return apiClient.getBlob(`/contacts/export${suffix ? `?${suffix}` : ''}`)
  },

  /** `preview` says what the sheet would change; `apply` changes it. */
  importSheet: (csv: string, mode: 'preview' | 'apply') =>
    apiClient.postText<ContactImportResult | ContactGoogleImportResult>(`/contacts/import?mode=${mode}`, csv),

  /** The phone book of the connected WhatsApp: `preview` lists who is new; `apply` creates them. */
  importWhatsapp: (mode: 'preview' | 'apply') =>
    apiClient.post<ContactWhatsappImportResult>(`/contacts/import/whatsapp?mode=${mode}`, {}),

  /** The Focus Chat contact book: same preview/apply as the WhatsApp one, plus groups and other channels left out. */
  importFocusChat: (mode: 'preview' | 'apply') =>
    apiClient.post<ContactWhatsappImportResult & { ignored: number }>(`/contacts/import/focuschat?mode=${mode}`, {}),

  /** What each contract's ONT says about the line now, asked of the ACS. */
  serviceStatus: (key: string) =>
    apiClient.get<ContactServiceStatus>(`/contacts/${encodeURIComponent(key)}/service-status`),

  /** Open invoices of each contract, asked of the SGP now. */
  invoices: (key: string) =>
    apiClient.get<{ contract: string; invoices: SgpInvoice[] }[]>(`/contacts/${encodeURIComponent(key)}/invoices`),

  /** The suggested WhatsApp text for one open invoice; nothing is sent. */
  invoiceMessage: (key: string, invoiceId: string) =>
    apiClient.get<ContactInvoiceMessage>(
      `/contacts/${encodeURIComponent(key)}/invoices/${encodeURIComponent(invoiceId)}/whatsapp`
    ),

  sendInvoice: (key: string, invoiceId: string, text: string) =>
    apiClient.post<ContactInvoiceSent>(
      `/contacts/${encodeURIComponent(key)}/invoices/${encodeURIComponent(invoiceId)}/whatsapp`,
      { text }
    ),

  /** "Receber": the invoice settled on the SGP, and a receipt over WhatsApp when asked. */
  settleInvoice: (key: string, invoiceId: string, body: { amount: number; paidAt: string; method: string; receipt: boolean }) =>
    apiClient.post<ContactInvoiceSettled>(
      `/contacts/${encodeURIComponent(key)}/invoices/${encodeURIComponent(invoiceId)}/settle`,
      body
    )
}

export interface ContactInvoiceSettled {
  contract: string
  invoiceId: string
  sgpId: string
  amount: number
  paidAt: string
  method: string
  message: string | null
  receipt: { sent: boolean; conversationId?: number; messageId?: number; error: string | null } | null
}

export interface ContactServiceStatus {
  contracts: {
    contract: string
    deviceId: string | null
    available: boolean
    reason?: 'unlinked' | 'unreachable' | 'not_found'
    status?: 'online' | 'offline' | null
    lastInform?: string | null
    uptimeSeconds?: number | null
    model?: string | null
    rxPower?: number | null
    connectedDevices?: number | null
    ipAddress?: string | null
    wanStatus?: string | null
  }[]
  generatedAt: string
}

export interface ContactInvoiceMessage {
  contract: string
  invoiceId: string
  phone: string | null
  text: string
}

export interface ContactInvoiceSent {
  contract: string
  invoiceId: string
  conversationId: number
  messageId: number
  conversation: WhatsAppConversation
}

// SGP (Sistema de Gestão de Provedores) integration API
/** What `aluguel` says when the SGP does not. */
export type TeiahRentalDefault = 'omit' | 'false' | 'true'

/** TeiaH Valid: the settings, without the API key. */
export interface TeiahConfig {
  enabled: boolean
  baseUrl: string
  exportEnabled: boolean
  exportIntervalHours: number
  batchSize: number
  rentalDefault: TeiahRentalDefault
  updatedAt: string | null
  apiKeyConfigured: boolean
  ready: boolean
}

/** Why a contract did not go to TeiaH Valid. */
export type TeiahSkipReason =
  | 'missing_address'
  | 'missing_start'
  | 'missing_cancellation'
  | 'no_debt'
  | 'invoices_failed'
  | 'rejected'

export interface TeiahExportResult {
  total: number
  sent: number
  unchanged: number
  skipped: number
  errors: number
  reasons: Partial<Record<TeiahSkipReason, number>>
  partial?: boolean
  durationMs: number
  startedAt: string
  finishedAt: string
}

export interface TeiahExportStatus {
  lastRun: TeiahExportResult | null
  running: boolean
  lastError: { at: string; code: string; message: string } | null
  totals: Partial<Record<'sent' | 'skipped' | 'error', number>>
}

export interface TeiahExportItem {
  contract: string
  clientName: string | null
  address: string | null
  status: 'sent' | 'skipped' | 'error'
  reason: TeiahSkipReason | null
  amount: number | null
  sentAt: string | null
  updatedAt: string
}

/** One `ImportAddressDto`, as it would be sent. */
export interface TeiahImportItem {
  estado: string
  cidade: string
  cep: string
  bairro: string
  rua: string
  numero: string
  complemento?: string
  latitude?: number
  longitude?: number
  /** Equipment left with the customer on rent or loan (comodato). */
  aluguel?: boolean
  inadimplente_valor: number
  data_inicio: string
  data_cancelamento: string
}

export interface TeiahPreviewItem {
  contract: string
  clientName: string | null
  item: TeiahImportItem | null
  reason: TeiahSkipReason | null
}

export interface FocusChatConfig {
  enabled: boolean
  tokenConfigured: boolean
  ready: boolean
  updatedAt: string | null
}

export const focusChatAPI = {
  getConfig: () =>
    apiClient.get<FocusChatConfig>('/focuschat/config'),

  /** An absent token keeps the saved one; `""` clears it. */
  updateConfig: (config: { enabled?: boolean; token?: string }) =>
    apiClient.put<FocusChatConfig>('/focuschat/config', config),

  test: (payload: { token?: string }) =>
    apiClient.post<{ ok: boolean; firstPage: number; durationMs: number }>('/focuschat/test', payload)
}

export const teiahAPI = {
  getConfig: () =>
    apiClient.get<TeiahConfig>('/teiah/config'),

  updateConfig: (config: Partial<Omit<TeiahConfig, 'apiKeyConfigured' | 'ready' | 'updatedAt'>> & { apiKey?: string }) =>
    apiClient.put<TeiahConfig>('/teiah/config', config),

  test: (payload: { baseUrl?: string; apiKey?: string }) =>
    apiClient.post<{ ok: boolean; status: number; durationMs: number }>('/teiah/test', payload),

  getExport: () =>
    apiClient.get<TeiahExportStatus>('/teiah/export'),

  listExportItems: (status?: 'sent' | 'skipped' | 'error') =>
    apiClient.get<{ items: TeiahExportItem[] }>(`/teiah/export/items${status ? `?status=${status}` : ''}`),

  previewExport: () =>
    apiClient.get<{ items: TeiahPreviewItem[] }>('/teiah/export/preview'),

  runExport: () =>
    apiClient.post<{ running: boolean }>('/teiah/export/run')
}

export const sgpAPI = {
  getConfig: () =>
    apiClient.get<SgpConfig>('/sgp/config'),

  updateConfig: (config: Partial<SgpConfig> & { token?: string }) =>
    apiClient.put<SgpConfig>('/sgp/config', config),

  test: (payload: { baseUrl?: string; app?: string; token?: string; document?: string; contract?: string; login?: string }) =>
    apiClient.post<{ contracts: number; probe: string; message: string | null }>('/sgp/test', payload),

  lookup: (filters: { document?: string; contract?: string; login?: string }) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    return apiClient.get<{ contracts: SgpContractLink[] }>(`/sgp/customers?${params.toString()}`)
  },

  getDeviceIntegration: (deviceId: string, options: { refresh?: boolean } = {}) =>
    apiClient.get<{
      link: SgpContractLink
      invoices: SgpInvoice[]
      invoiceError: string | null
      /** The client's page in the SGP web app, or null when SGP gave no client id. */
      sgpUrl: string | null
      ticketEnabled: boolean
    }>(
      `/sgp/devices/${encodeURIComponent(deviceId)}${options.refresh ? '?refresh=1' : ''}`
    ),

  linkDevice: (deviceId: string, payload: { contract: string; document?: string }) =>
    apiClient.post<{ link: SgpContractLink }>(`/sgp/devices/${encodeURIComponent(deviceId)}/link`, payload),

  unlinkDevice: (deviceId: string) =>
    apiClient.delete(`/sgp/devices/${encodeURIComponent(deviceId)}/link`),

  requestTrustUnlock: (deviceId: string) =>
    apiClient.post<{ contract: string }>(`/sgp/devices/${encodeURIComponent(deviceId)}/unlock`),

  openTicket: (deviceId: string, payload: { content: string; note?: string }) =>
    apiClient.post<SgpTicket>(`/sgp/devices/${encodeURIComponent(deviceId)}/ticket`, payload),

  getContactsSync: () =>
    apiClient.get<SgpContactsSyncStatus>('/sgp/contacts/sync'),

  /** Starts the sync and answers at once (202); `getContactsSync` says when it is done. */
  syncContacts: () =>
    apiClient.post<{ running: boolean }>('/sgp/contacts/sync'),

  testContacts: () =>
    apiClient.post<SgpContactsTestResult>('/sgp/contacts/test'),

  getLinks: () =>
    apiClient.get<{ links: SgpLinkRow[] }>('/sgp/links'),

  getOverview: () =>
    apiClient.get<SgpFleetOverview>('/sgp/overview'),

  syncAll: () =>
    apiClient.post<SgpSyncSummary>('/sgp/sync'),

  listEvents: (filters: { status?: string; type?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value))
    })
    const query = params.toString()
    return apiClient.get<{ events: SgpEvent[] }>(`/sgp/events${query ? `?${query}` : ''}`)
  },

  retryEvent: (id: number) =>
    apiClient.post<{ event: SgpEvent }>(`/sgp/events/${id}/retry`),

  // The secret comes back once and is never readable again.
  rotateWebhookSecret: () =>
    apiClient.post<{ secret: string; path: string }>('/sgp/events/secret/rotate'),

  reconcile: () =>
    apiClient.post<{ checked: number; changed: number; errors: number }>('/sgp/reconcile'),
}

export interface ProvisioningConfig {
  enabled: boolean
  intervalSeconds: number
  batchSize: number
  informWindowHours: number
  markerTag: string
  verifyEnabled: boolean
  verifyDelaySeconds: number
  requirePppoePassword: boolean
  runRetentionDays: number
  updatedAt: string | null
}

export interface ProvisioningProfile {
  id: number
  name: string
  planPatterns: string[]
  isDefault: boolean
  priority: number
  enabled: boolean
  applyWan: boolean
  applyPppoePassword: boolean
  wanName: string | null
  wanVlanId: number | null
  wanServiceList: string | null
  wanConnectionType: string | null
  wanNatEnabled: boolean | null
  applyWifi: boolean
  wifiIndexes: number[]
  wifiSsidTemplate: string | null
  wifiPasswordMode: 'fixed' | 'random' | 'keep'
  applyCredentials: boolean
  credentialTargets: 'super' | 'user' | 'both'
  description: string | null
  wifiPasswordConfigured: boolean
  cpePasswordConfigured: boolean
  updatedAt: string | null
}

export type ProvisioningProfileInput = Partial<Omit<ProvisioningProfile,
  'id' | 'wifiPasswordConfigured' | 'cpePasswordConfigured' | 'updatedAt'>>
  & { wifiPassword?: string; cpePassword?: string }

export interface ProvisioningStep {
  step: string
  target: string | number | null
  status: string
  detail: string | null
  parameters: { path: string; value: unknown }[]
  at?: string
}

export interface ProvisioningRun {
  id: number
  deviceId: string
  contract: string | null
  profileId: number | null
  profileName: string | null
  trigger: 'poller' | 'manual' | 'event' | 'dry_run'
  status: string
  attemptCount: number
  nextAttemptAt: string | null
  steps: ProvisioningStep[]
  /** Translation key the run recorded; `errorMessage` is it rendered. */
  error: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string | null
}

export interface ProvisioningPreview {
  deviceId: string
  login: string | null
  contract: SgpContractLink | null
  profile: { id: number; name: string } | null
  pppoePasswordFound?: boolean
  skip?: string
  steps: ProvisioningStep[]
}

/* Automatic provisioning API */
export const provisioningAPI = {
  getConfig: () =>
    apiClient.get<ProvisioningConfig>('/provisioning/config'),

  updateConfig: (config: Partial<ProvisioningConfig>) =>
    apiClient.put<ProvisioningConfig>('/provisioning/config', config),

  listProfiles: () =>
    apiClient.get<{ profiles: ProvisioningProfile[] }>('/provisioning/profiles'),

  createProfile: (profile: ProvisioningProfileInput) =>
    apiClient.post<{ profile: ProvisioningProfile }>('/provisioning/profiles', profile),

  updateProfile: (id: number, profile: ProvisioningProfileInput) =>
    apiClient.put<{ profile: ProvisioningProfile }>(`/provisioning/profiles/${id}`, profile),

  deleteProfile: (id: number) =>
    apiClient.delete(`/provisioning/profiles/${id}`),

  listRuns: (filters: { deviceId?: string; status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value))
    })
    const query = params.toString()
    return apiClient.get<{ runs: ProvisioningRun[] }>(`/provisioning/runs${query ? `?${query}` : ''}`)
  },

  listDeviceRuns: (deviceId: string) =>
    apiClient.get<{ runs: ProvisioningRun[] }>(
      `/provisioning/devices/${encodeURIComponent(deviceId)}/runs`
    ),

  preview: (deviceId: string) =>
    apiClient.post<ProvisioningPreview>(
      `/provisioning/devices/${encodeURIComponent(deviceId)}/preview`
    ),

  provision: (deviceId: string, payload: { force?: boolean } = {}) =>
    apiClient.post<{ run: ProvisioningRun }>(
      `/provisioning/devices/${encodeURIComponent(deviceId)}/provision`, payload
    ),

  runPass: () =>
    apiClient.post<{ executed: number; verified: number; queued: number }>('/provisioning/run'),
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

  /** Volta o perfil ao que está no catálogo padrão da plataforma. */
  reset: (id: number) =>
    apiClient.post(`/vendor-management/${id}/reset`, {}),

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

  resetWifiSecurityConfig: (id: number) =>
    apiClient.post(`/vendor-management/wifi-security-configs/${id}/reset`, {}),
}

// Mapping API
export const mappingAPI = {
  getNodes: () =>
    apiClient.get('/mapping-data/nodes'),

  getNode: (nodeId: string) =>
    apiClient.get(`/mapping-data/nodes/${encodeURIComponent(nodeId)}`),

  createNode: (nodeData: any) =>
    apiClient.post('/mapping-data/nodes', nodeData),

  updateNode: (nodeId: string, nodeData: any) =>
    apiClient.put(`/mapping-data/nodes/${encodeURIComponent(nodeId)}`, nodeData),

  deleteNode: (nodeId: string) =>
    apiClient.delete(`/mapping-data/nodes/${encodeURIComponent(nodeId)}`),

  getEdges: () =>
    apiClient.get('/mapping-data/edges'),

  getEdge: (edgeId: string) =>
    apiClient.get(`/mapping-data/edges/${encodeURIComponent(edgeId)}`),

  createEdge: (edgeData: any) =>
    apiClient.post('/mapping-data/edges', edgeData),

  updateEdge: (edgeId: string, edgeData: any) =>
    apiClient.put(`/mapping-data/edges/${encodeURIComponent(edgeId)}`, edgeData),

  deleteEdge: (edgeId: string) =>
    apiClient.delete(`/mapping-data/edges/${encodeURIComponent(edgeId)}`),

  syncData: (data: { nodes: any[], edges: any[] }) =>
    apiClient.post('/mapping-data/sync', data),

  resetData: (password: string) =>
    apiClient.requestWithBody('DELETE', '/mapping-data/reset', { password }),

  /** Acrescenta pontos e cabos (importação de KML/KMZ); nunca apaga nem sobrescreve. */
  importData: (data: { nodes: unknown[]; edges: unknown[] }) =>
    apiClient.post<MapImportResult>('/mapping-data/import', data),

  /** Estado ao vivo (online, sinal fraco, offline) dos pontos com PPPoE. */
  liveStatus: () =>
    apiClient.get<LiveStatus>('/mapping-data/status'),

  /** Histórico de rompimentos por caixa, nos últimos `days` dias. */
  outageHistory: (days = 90) =>
    apiClient.get<OutageHistory>(`/mapping-data/outages?days=${days}`),

  /** Onde fica a casa do cliente, pelo endereço do SGP (coordenadas ou endereço geocodificado). */
  clientLocation: (pppoe: string, deviceId?: string | null) =>
    apiClient.get<ClientLocation>(`/mapping-data/client-location?${new URLSearchParams({ pppoe, ...(deviceId ? { deviceId } : {}) })}`),

  /** Equipamentos com PPPoE que ainda não estão no mapa. */
  unmappedDevices: () =>
    apiClient.get<{ total: number; items: UnmappedDevice[] }>('/mapping-data/unmapped'),

  /** "Colocar todos no mapa": os fora do mapa, separados pelo que o SGP já guardou. */
  bulkPlacement: () =>
    apiClient.get<BulkPlacement>('/mapping-data/bulk-placement'),

  /** Busca livre de um lugar no Brasil (Nominatim, pelo servidor). */
  searchAddress: (q: string) =>
    apiClient.get<PlaceResult[]>(`/mapping-data/geocode?q=${encodeURIComponent(q)}`),
}

export interface MapImportResult {
  createdNodes: number
  createdEdges: number
  skippedNodes: number
  skippedEdges: number
  errors: string[]
}

export interface CustomerIdSyncStatus {
  enabled: boolean
  running: boolean
  startedAt: string | null
  last: null | {
    ok: boolean
    startedAt: string
    finishedAt: string
    total?: number
    existing?: number
    generated?: number
    pending?: number
    code?: string
    status?: number | null
    message?: string
  }
}

export interface OutageHistory {
  days: number
  events: Array<{
    id: number
    node_id: string
    node_name: string | null
    started_at: string
    ended_at: string | null
    minutes: number | null
    peak_count: number
    total_clients: number
  }>
  byNode: Array<{ node_id: string; node_name: string | null; count: number; minutes: number; last_at: string }>
}

export interface BulkPlacementItem {
  pppoe: string
  deviceId: string | null
  contract?: string | null
  clientName?: string | null
  address?: string | null
  lat?: number
  lng?: number
}

export interface BulkPlacement {
  total: number
  truncated: boolean
  /** Com coordenadas no SGP. */
  ready: (BulkPlacementItem & { lat: number; lng: number })[]
  /** Com endereço (ao menos a cidade), sem coordenadas. */
  needsAddress: BulkPlacementItem[]
  /** Sem contato no SGP, ou o contrato sem nem a cidade. */
  noAddress: (BulkPlacementItem & { reason: 'no_contract' | 'no_address' })[]
}

export interface ClientLocation {
  found: boolean
  contract?: string | null
  clientName?: string | null
  address?: string | null
  lat?: number
  lng?: number
  /** `sgp`: coordenadas do SGP; `address`: achado pela rua; `city`: só a cidade. */
  precision?: 'sgp' | 'address' | 'city'
}

export interface UnmappedDevice {
  deviceId: string | null
  pppoe: string
  online: boolean
  rxPower: number | null
  lastInform: string | null
}

export interface PlaceResult {
  lat: number
  lng: number
  label: string
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

// WhatsApp via Evolution API
export interface WhatsAppConfig {
  enabled: boolean
  allowedHosts: string[]
  webhookBaseUrl: string
  rejectCallMessage: string
  // Where the customer portal answers from outside. Its own field, not the
  // panel's address: the portal is a separate app on a separate port.
  portalPublicUrl: string
  /** O atendimento automático (menu, 2ª via, sinal). Ligado por padrão. */
  botEnabled: boolean
  /** O bot pedir a liberação em confiança ao SGP. Desligado por padrão. */
  botUnlockEnabled: boolean
  /** Days a stored attachment is kept. 0 means forever, and is the default. */
  mediaRetentionDays: number
  /** Days a message row is kept. 0 is forever, and is the default. */
  messageRetentionDays: number
  rateLimitPerMin: number
  /**
   * O ritmo das mensagens automáticas (régua, cobrança avulsa e campanhas):
   * intervalo sorteado entre uma e outra, em segundos, e uma pausa longa, em
   * minutos, a cada `bulkBurstSize` mensagens (0 desliga a pausa).
   */
  bulkIntervalMinSec: number
  bulkIntervalMaxSec: number
  bulkBurstSize: number
  bulkBurstPauseMin: number
  managedUrl: string
  managed: boolean
  managedAdminKeyConfigured: boolean
  /** Para onde a Meta chama (API oficial) e o token que ela confere. */
  cloudCallbackUrl?: string
  /**
   * `auto`: a SaaS, onde o painel registra o webhook na conta WABA sozinho e o
   * token de verificação do servidor NÃO vem. No self-host vêm a URL e o token.
   */
  cloudWebhook?: { auto?: boolean; callbackUrl?: string; verifyToken?: string }
  /**
   * Se o servidor (endereço, chave, hosts, webhook) é o da plataforma. Na SaaS
   * é, para todo provedor: a tela esconde esses campos e mostra só o uso.
   */
  platformManaged?: boolean
  /** Tetos do plano para as duas retenções; nulo é sem teto. */
  retentionCaps?: { media: number | null; messages: number | null }
  ready: boolean
  updatedAt: string | null
}

export type WhatsAppPurpose = 'general' | 'billing' | 'support' | 'sales' | 'alerts'
export type WhatsAppStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'expired'

export interface WhatsAppAccount {
  id: number
  name: string
  label: string | null
  purpose: WhatsAppPurpose
  /**
   * A cor do número na caixa de entrada, uma de `WA_ACCOUNT_COLORS`. Nula só
   * num número anterior a ela; a tela cai numa cor derivada do id.
   */
  color: string | null
  flavor: 'go' | 'v2'
  /** `cloud` é o número da API oficial da Meta: sem QR, com janela de 24 h. */
  integration?: 'baileys' | 'cloud'
  metaPhoneNumberId?: string | null
  metaWabaId?: string | null
  metaTemplatesSyncedAt?: string | null
  metaTemplatesError?: string | null
  /** O último registro do webhook na Meta pelo painel; nulo é "ainda não tentado". */
  metaWebhookStatus?: 'ok' | 'error' | null
  metaWebhookError?: string | null
  metaWebhookAt?: string | null
  baseUrl: string
  status: WhatsAppStatus
  /**
   * O QR não vem mais no objeto da conta.
   *
   * Ele é credencial de pareamento e sai SÓ pela rota dedicada, que exige
   * `whatsapp.config`. Vinha neste serializador, que serve rotas de
   * `whatsapp.read`, e isso punha o código ao alcance de um `tech`.
   */
  qrUpdatedAt: string | null
  phoneE164: string | null
  isDefault: boolean
  lastSeenAt: string | null
  lastError: string | null
  /** O veredito da última conferência do webhook no servidor Evolution. */
  webhookVerdict: WhatsAppWebhookVerdict | null
  /** A URL que o servidor guarda, com o token REDIGIDO (`?t=***`). */
  webhookServerUrl: string | null
  webhookCheckedAt: string | null
  /**
   * O resultado da VOLTA — o painel se chamando pela porta da frente.
   *
   * Separado de `webhookVerdict` porque responde outra pergunta. Aquele diz o
   * que está gravado no servidor Evolution; este diz se uma entrada por aquele
   * endereço chega até aqui. Os dois saem do mesmo `webhookBaseUrl`, então o
   * primeiro responde `ok` para um endereço errado: as duas pontas da
   * comparação dele são a mesma. Só a volta pega isso.
   */
  webhookProbeVerdict: WhatsAppProbeVerdict | null
  webhookProbedAt: string | null
  /** Quando um evento chegou e levou 401, e por quê. */
  webhookRefusedAt: string | null
  webhookRefusedReason: 'bad_token' | 'no_credential' | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Cada jeito de o webhook estar quebrado, e um conserto para cada.
 *
 * Dois estados que se consertam do mesmo jeito seriam um só: `absent` e
 * `token_mismatch` levam à mesma reescrita, mas quem lê "ausente" sabe que a
 * instância já existia antes do painel, e quem lê "token" sabe que o painel já
 * escreveu ali um dia — e isso muda para onde ir quando a reescrita não
 * resolver.
 */
export type WhatsAppWebhookVerdict =
  | 'ok'
  | 'absent'
  | 'url_mismatch'
  | 'token_mismatch'
  | 'disabled'
  | 'by_events'
  | 'events_missing'
  // A URL e o token conferem, e a lista de eventos veio vazia. Não é `ok`:
  // vazia pode ser um v2 antigo que não devolve o campo, ou um webhook que não
  // assina nada, e o painel não distingue os dois. Chamar de `ok` tirava da
  // tela o único botão que conserta os dois.
  | 'events_unknown'
  | 'unreachable'

/** O que a volta encontrou. Cada um é um conserto diferente. */
export type WhatsAppProbeVerdict =
  | 'reached'
  | 'unauthorized'
  | 'wrong_target'
  | 'not_found'
  | 'blocked'
  | 'server_error'
  | 'unreachable'

export interface WhatsAppWebhookProbe {
  account: WhatsAppAccount
  verdict: WhatsAppProbeVerdict
  /** O status HTTP que voltou, ou null quando nem chegou a haver resposta. */
  status: number | null
}

/** Os seis passos do diagnóstico da configuração, na ordem em que a tela os mostra. */
export type WhatsAppTestStep =
  | 'config' | 'webhookPath' | 'server' | 'license' | 'adminKey' | 'instances' | 'roundTrip'

/**
 * Um passo e o que se apurou dele.
 *
 * `veredito` é aberto de propósito: o backend pode ganhar um veredito novo
 * antes deste frontend, e a tela tem que mostrar alguma coisa em vez de sumir
 * com a linha. `skipped` quer dizer "não dá para dizer" — um passo que dependia
 * de outro que não passou —, e nunca ✗.
 */
export interface WhatsAppTestStepResult {
  passo: WhatsAppTestStep
  veredito: string
  /** O sabor do servidor, a URL do manager, a contagem de instâncias: varia por passo. */
  detalhe?: string | number | null
}

export interface WhatsAppConfigTest {
  passos: WhatsAppTestStepResult[]
}

export interface WhatsAppWebhookCheck {
  account: WhatsAppAccount
  verdict: WhatsAppWebhookVerdict | null
  /** false no Evolution GO, que não tem rota que devolva o webhook. */
  supported: boolean
  serverUrl: string
}

/** `pending` with a null `qr` is a "not yet", not a failure — the GO client boots slowly. */
export interface WhatsAppQrResult {
  account: WhatsAppAccount
  qr: string | null
  pending: boolean
}

export interface WhatsAppTemplate {
  id: number
  name: string
  body: string
  category: string
  active: boolean
  /** O modelo aprovado da Meta usado fora da janela de 24 h, num número oficial. */
  metaTemplateName?: string | null
  metaLanguage?: string | null
  /** Nossas variáveis, na ordem de `{{1}}`, `{{2}}`… (`texto` = o texto inteiro). */
  metaParams?: string[]
  /** De onde vem o cabeçalho do modelo da Meta (mídia ou texto com variável). */
  metaHeader?: MetaHeaderBinding | null
  /** A variável que completa a URL do botão dinâmico do modelo da Meta. */
  metaButtonParam?: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * A origem do cabeçalho na ligação de um modelo do painel: o anexo da
 * campanha, uma variável (o link, ex. `link_boleto`, ou o texto do cabeçalho)
 * ou uma URL https fixa.
 */
export interface MetaHeaderBinding {
  source: 'attachment' | 'variable' | 'url'
  value: string | null
}

export type MetaHeaderFormat = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | 'UNKNOWN'

/** Um botão do modelo; `urlHasParam` = URL com `{{1}}`, que pede o sufixo no envio. */
export interface WhatsAppMetaTemplateButton {
  index: number
  type: string
  urlHasParam: boolean
}

/** Um modelo (template) da conta WABA de um número oficial, sincronizado da Meta. */
export interface WhatsAppMetaTemplate {
  id: number
  accountId: number
  name: string
  language: string
  category: string | null
  status: string | null
  bodyText: string
  paramCount: number
  paramFormat: 'positional' | 'named'
  headerFormat: MetaHeaderFormat
  /** Variáveis no cabeçalho de texto (no máximo 1). */
  headerParamCount: number
  buttons: WhatsAppMetaTemplateButton[]
  supported: boolean
  /** Aprovado e com formato que o painel sabe enviar. */
  usable: boolean
  syncedAt: string | null
}

/**
 * Um modelo novo para a Meta revisar. Só o que o painel sabe enviar depois:
 * cabeçalho de texto sem variável, corpo com `{{1}}`, `{{2}}`… posicionais (um
 * exemplo por variável, exigência da revisão) e botões de URL fixa ou resposta
 * rápida.
 */
export interface MetaTemplateCreatePayload {
  name: string
  category: 'UTILITY' | 'MARKETING'
  language: string
  bodyText: string
  examples: string[]
  headerText?: string
  footerText?: string
  buttons: { type: 'URL' | 'QUICK_REPLY'; text: string; url?: string }[]
}

export type MetaNoticeKey = 'maintenance' | 'outage' | 'alert'
export type MetaNoticeBindings = Record<MetaNoticeKey, { name: string; language: string; paramCount: number } | null>

/** Os períodos do relatório de modelos da Meta, em meses (o corrente incluso). */
export type MetaUsagePeriod = 3 | 6 | 12
/** As categorias que a Meta cobra. `UNKNOWN` só aparece no relatório. */
export type MetaPriceCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | 'SERVICE'
/** Preço por mensagem, em reais, que o provedor digitou; `null` = não digitou. */
export type MetaPrices = Record<MetaPriceCategory, number | null>

export interface MetaUsageCount {
  /** Aceitos pela Meta, por categoria (sent/delivered/read). */
  byCategory: Record<string, number>
  total: number
  /** Recusados pela Meta depois do aceite; fora da estimativa. */
  failed: number
}

export interface MetaUsageMonth extends MetaUsageCount {
  /** `YYYY-MM`, no fuso do servidor. */
  month: string
}

export interface MetaUsageTemplate {
  name: string
  language: string
  category: string
  count: number
  failed: number
}

export interface MetaUsageAccount extends MetaUsageCount {
  accountId: number | null
  label: string | null
  name: string | null
}

/** Modelos da Meta enviados pelo painel, por mês e categoria. */
export interface MetaUsageReport {
  months: MetaUsagePeriod
  since: string
  /** O fuso do servidor, onde o mês vira. */
  timezone: string | null
  /** O teto de linhas lidas foi atingido; os números estão incompletos. */
  truncated: boolean
  categories: string[]
  monthly: MetaUsageMonth[]
  totals: MetaUsageCount
  templates: MetaUsageTemplate[]
  accounts: MetaUsageAccount[]
  prices: MetaPrices
  estimate: { byCategory: Partial<Record<MetaPriceCategory, number>>; total: number; currency: 'BRL' } | null
}

/** O modelo da Meta de um envio: nome, idioma e os parâmetros já preenchidos. */
export interface MetaTemplatePayload {
  name: string
  language: string
  params: string[]
  /** Mídia por link https, ou o texto do cabeçalho com a sua variável. */
  header?: { type: 'image' | 'video' | 'document'; link: string; filename?: string } | { type: 'text'; params: string[] }
  /** O sufixo de cada botão de URL dinâmica, pelo índice do botão no modelo. */
  buttons?: { index: number; param: string }[]
}

export interface WhatsAppOptOut {
  id: number
  waPhoneE164: string | null
  waLid: string | null
  origin: 'customer' | 'operator'
  reasonText: string | null
  /** The kinds of message it blocks; `null` is everything. */
  categories: string[] | null
  /** The client this number belongs to, when the SGP records know it. */
  clientName: string | null
  createdAt: string | null
}

/** A subscriber the billing cadence could contact. `daysOverdue` is negative when not yet due. */
export interface WhatsAppOverdueSubscriber {
  contract: string
  clientName: string | null
  document: string | null
  phone: string | null
  phoneSource: 'manual' | 'sgp' | null
  deviceId: string | null
  amount: number | null
  dueDate: string | null
  daysOverdue: number | null
}

export interface WhatsAppSkipCounts {
  noPhone: number
  optOut: number
  noInvoice: number
  futureOnly: number
  sgpRefused: number
  templateIncomplete: number
  /** Which variables the `templateIncomplete` ones lacked: `{ pix: 12 }`. */
  missing?: Record<string, number>
}

/** One day of the automatic cadence's send window. `day` follows `Date#getDay`. */
export interface WhatsAppDunningWindowDay {
  day: number
  closed: boolean
  open: string
  close: string
}

/** One step of the automatic cadence: which template, how many days from the due date. */
export interface WhatsAppDunningStep {
  offsetDays: number
  templateId: number
}

export type WhatsAppDunningSkipReason = 'noPhone' | 'optOut' | 'templateIncomplete' | 'maxReached' | 'interval' | 'paused' | 'sgpRefused'

export interface WhatsAppDunningRunSummary {
  at: string
  manual: boolean
  checked: number
  queued: number
  paid: number
  thanked: number
  skipped: Record<WhatsAppDunningSkipReason, number>
  truncated: boolean
}

/** The automatic billing cadence. It SENDS, so `enabled` has its own route. */
export interface WhatsAppDunningRule {
  enabled: boolean
  steps: WhatsAppDunningStep[]
  maxPerInvoice: number
  minIntervalHours: number
  maxPerRun: number
  /** Dias de pausa quando o cliente manda comprovante; 0 desliga. */
  receiptPauseDays: number
  thanksTemplateId: number | null
  window: { timezone: string; week: WhatsAppDunningWindowDay[] }
  enabledAt: string | null
  updatedAt: string | null
  inWindowNow: boolean
  running: boolean
  lastRun: WhatsAppDunningRunSummary | null
}

export interface WhatsAppDunningPreviewItem {
  contract: string
  clientName: string | null
  phone: string | null
  dueDate: string | null
  amount: number | null
  daysOverdue: number
  stepOffset: number
  templateName: string | null
  status: 'queued' | 'skipped' | 'deferred'
  reason: WhatsAppDunningSkipReason | null
  /** With `templateIncomplete`: the variables the template cites that were empty. */
  missing?: string[]
}

export interface WhatsAppDunningPreview {
  checked: number
  queued: number
  truncated: boolean
  skipped: Record<WhatsAppDunningSkipReason, number>
  items: WhatsAppDunningPreviewItem[]
}

export interface WhatsAppDunningPreviewState {
  status: 'idle' | 'running' | 'done' | 'failed'
  checked: number
  total: number | null
  startedAt?: string | null
  finishedAt?: string | null
  result: WhatsAppDunningPreview | null
  error: { code: string; message: string } | null
}

export interface WhatsAppDunningSend {
  id: number
  kind: 'step' | 'thanks'
  stepOffset: number
  contract: string
  invoiceKey: string
  dueDate: string | null
  amount: number | null
  clientName: string | null
  phone: string | null
  templateName: string | null
  status: 'queued' | 'skipped' | 'canceled'
  reason: string | null
  /** With `template_incomplete`: the variables the template cites that were empty. */
  missing?: string[]
  deliveryStatus: string | null
  paidAt: string | null
  createdAt: string | null
}

export interface WhatsAppDunningStats {
  days: number
  messages: number
  failed: number
  thanks: number
  invoices: number
  invoicesPaid: number
  amountCharged: number
  amountRecovered: number
  recoveryRate: number
  byStep: { offsetDays: number; sent: number; paidAfter: number }[]
  skipped: Record<string, number>
}

/** One person a campaign was addressed to, and what became of the message. */
export interface WhatsAppBroadcastRecipient {
  id: number
  contract: string | null
  clientName: string | null
  phone: string
  status: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed'
  /** `opt_out`, `paid`, `no_destination`, or the send error. */
  error: string | null
  deliveryStatus: string | null
  /** Wrote in the same thread after the send. */
  replied: boolean
  /** Asked to stop after the send. */
  optedOut: boolean
  sentAt: string | null
}

export interface WhatsAppBroadcastSummary {
  total: number
  pending: number
  sent: number
  delivered: number
  read: number
  replied: number
  optedOut: number
  failed: number
  skipped: number
  paid: number
}

export interface WhatsAppBroadcastDetail {
  broadcast: WhatsAppBroadcast
  summary: WhatsAppBroadcastSummary
  items: WhatsAppBroadcastRecipient[]
  total: number
  hasMore: boolean
}

export interface WhatsAppBroadcast {
  id: number
  title: string
  body: string
  status: 'draft' | 'queued' | 'running' | 'paused' | 'done' | 'canceled' | 'failed'
  totalCount: number
  sentCount: number
  failedCount: number
  rateLimitPerMin: number | null
  /** 'general' é a campanha de aviso ("Nova campanha"); 'billing', a da cobrança avulsa. */
  kind?: 'billing' | 'general'
  /** Quando a campanha agendada ('queued') começa sozinha. */
  scheduledAt?: string | null
  attachment?: { name: string | null; type: string | null } | null
  audience?: (Omit<WhatsAppCampaignFilters, 'contracts'> & { contracts: number; contractList?: string[] }) | null
  /** O número que envia, o modelo escolhido e o ritmo próprio (mensagens por hora; nulo é o do WhatsApp). */
  accountId?: number | null
  templateId?: number | null
  pacePerHour?: number | null
  startAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** O público de uma campanha de aviso. Grupos diferentes combinam com E; valores do mesmo grupo, com OU. */
export type WhatsAppReferralStatus = 'new' | 'contacted' | 'won' | 'rewarded' | 'lost'

/** Quem um cliente indicou pelo link dele ("Indique e ganhe"). */
export interface WhatsAppReferral {
  id: number
  referrerContract: string
  referrerName: string | null
  name: string
  phone: string
  neighborhood: string | null
  note: string | null
  status: WhatsAppReferralStatus
  createdAt: string | null
}

export interface WhatsAppReferralList {
  referrals: WhatsAppReferral[]
  counts: Record<WhatsAppReferralStatus, number>
  /** De onde o link abre; nulo enquanto ninguém informou e não há como derivar. */
  baseUrl: string | null
  /** Falso quando o servidor não tem segredo para assinar links. */
  linksReady: boolean
}

export interface WhatsAppCampaignFilters {
  states: string[]
  plans: string[]
  districts: string[]
  cities: string[]
  contracts: string[]
}

export interface WhatsAppCampaignOption {
  value: string
  count: number
}

export interface WhatsAppCampaignAudienceOptions {
  states: WhatsAppCampaignOption[]
  plans: WhatsAppCampaignOption[]
  districts: WhatsAppCampaignOption[]
  cities: WhatsAppCampaignOption[]
  total: number
}

export interface WhatsAppCampaignPreview {
  counts: {
    matched: number
    noPhone: number
    optOut: number
    duplicate: number
    templateIncomplete: number
    reachable: number
  }
  max: number
  sample: { contract: string | null; clientName: string | null; phone: string; body: string }[]
}

export interface WhatsAppCampaignInput {
  title: string
  filters: WhatsAppCampaignFilters
  templateId?: number
  body?: string
  /** Na edição: ausente mantém o anexo, nulo tira, um objeto troca. */
  attachment?: { path: string; name: string } | null
  scheduledAt?: string | null
  /** O número que envia; sem ele, o da cobrança. */
  accountId?: number | null
  /** Só desacelera o ritmo geral: `default` (o do WhatsApp), `slow` (30/h) ou `very_slow` (12/h). */
  pace?: 'default' | 'slow' | 'very_slow'
}

/**
 * One read that answers "is this working?".
 *
 * Every number here is something an operator today can only learn by opening
 * conversations one at a time — which means they learn it from a customer
 * complaining instead.
 */
export interface WhatsAppHealth {
  /** Connected numbers, and how many are not. */
  accounts: { total: number; connected: number; disconnected: number }
  outbox: {
    /** Waiting to go out. A number that only grows is the panel gone quiet. */
    queued: number
    /**
     * The slice of `queued` that is waiting out a retry rather than waiting for
     * the worker. Counted separately because a healthy backoff and a stuck
     * queue look identical from `queued` alone.
     */
    retrying: number
    sending: number
    /** Terminal failures in the last 24 hours. */
    failed24h: number
    /** ISO timestamp of the oldest message still waiting, or null. */
    oldestQueuedAt: string | null
  }
  inbox: { unread: number; openConversations: number }
  /** Nothing has come in or gone out since these, whatever the queue says. */
  lastInboundAt: string | null
  lastOutboundAt: string | null
  media: { files: number; bytes: number; oldestAt: string | null }
  /**
   * Por quanto tempo o que está guardado fica guardado. `0` é para sempre.
   *
   * Viaja ao lado de `media` porque as duas metades da frase só significam
   * alguma coisa juntas: "9,4 KB" é irrelevante e "9,4 KB para sempre" é uma
   * decisão.
   */
  retention: { mediaDays: number; messageDays: number }
  /**
   * A metade que faltava de "nunca chegou nada".
   *
   * `broken` conta os números cuja última conferência encontrou o webhook
   * divergente no servidor Evolution; `unchecked` conta os que nunca foram
   * conferidos — e é por isso que os dois são separados: dizer "quebrado"
   * sobre o que não se olhou manda o operador consertar às cegas.
   * `refusedAt` é a última vez que um evento chegou e levou 401, que é o que
   * distingue "o Evolution não está chamando" de "está chamando e sendo
   * recusado".
   */
  webhook: {
    broken: number
    unchecked: number
    /**
     * A URL e o token conferem, e a lista de eventos veio vazia — que pode ser
     * um v2 antigo que não devolve o campo, ou um webhook que não assina nada.
     * Aviso e não falha: acusar um servidor possivelmente são é o erro mais
     * caro aqui, e chamar de `ok` era calar sobre a única coisa que restava
     * para olhar.
     */
    unverifiable: number
    /**
     * Números cuja VOLTA falhou: o endereço público não chega ao painel. Tem
     * precedência sobre `broken` — um webhook que não é entregável torna
     * irrelevante o que está gravado no servidor Evolution.
     */
    unreachable: number
    refusedAt: string | null
  }
}

export type WhatsAppAlertRule = 'ont_offline' | 'rx_power_low' | 'temperature_high' | 'mass_outage' | 'wa_disconnected' | 'wa_waiting'

/** `GET /whatsapp/waiting`: quem espera gente há mais que o limite da regra. */
export interface WaitingReport {
  thresholdMinutes: number
  withinHours: boolean
  items: Array<{
    conversationId: number
    since: string
    minutes: number
    assignedUserId: number | null
    assignedTo: string | null
    contact: string | null
  }>
}

export interface WhatsAppAlertSettings {
  enabled: boolean
  intervalSeconds: number
  /** 0 = cada alerta na hora; 5, 10, 15 ou 30 = um resumo a cada tantos minutos. */
  digestMinutes?: number
  recipients: string[]
  /** E-mails da equipe: o segundo canal, pelo SMTP do servidor. */
  emailRecipients?: string[]
  /** Só na leitura: se o servidor manda e-mail. Sem isso, o campo avisa. */
  mailConfigured?: boolean
  /** Só na leitura: se há um bot guardado (o token nunca vem) e o grupo. */
  telegram?: { configured: boolean; chatId: string }
  rules: Record<WhatsAppAlertRule, { enabled: boolean; threshold: number | null; cooldownMinutes: number }>
}

export interface WhatsAppConversation {
  id: number
  accountId: number
  waPhoneE164: string | null
  waLid: string | null
  pushName: string | null
  deviceId: string | null
  contract: string | null
  /** The SGP client with no contract this thread is bound to, if any. */
  sgpContactId: number | null
  clientName: string | null
  /** The contact asked not to be contacted. Replying is still allowed. */
  optedOut: boolean
  lastMessageAt: string | null
  lastInboundAt: string | null
  unreadCount: number
  closedAt: string | null
  /** Até quando o bot fica calado porque o assinante pediu um atendente; null fora da pausa. */
  botPausedUntil?: string | null
  /** Quem atende a conversa; null sem dono. */
  assignedUserId?: number | null
  assignedTo?: string | null
  /** Desde quando espera um atendente (a fila da distribuição); null fora dela. */
  waitingSince?: string | null
  /** O cliente falou por último e ninguém respondeu: desde a primeira mensagem sem resposta. */
  awaitingSince?: string | null
  /** Em dia, vence hoje ou atrasado, pela última consulta ao SGP; null sem foto. */
  billing?: ConversationBilling | null
  /** O cadastro do cliente no SGP, quando o id dele já foi sincronizado e o SGP está ligado. */
  sgpUrl?: string | null
  /** As etiquetas da conversa, em ordem de nome. */
  tags?: WhatsAppTag[]
  createdAt: string | null
  updatedAt: string | null
}

/** Uma etiqueta de conversa; a cor é uma da paleta dos números (`WA_ACCOUNT_COLORS`). */
export interface WhatsAppTag {
  id: number
  name: string
  color: string
}

/** `GET /whatsapp/tags/report`: por etiqueta, marcadas no período e abertas agora. */
export interface TagsReport {
  days: 7 | 30 | 90
  tags: Array<WhatsAppTag & { taggedInPeriod: number; openNow: number }>
}

/** Alguém da equipe que atende o WhatsApp: `GET /whatsapp/agents`. */
export interface WhatsAppAgent {
  userId: number
  name: string | null
  /** O interruptor da pessoa. */
  available: boolean
  /** Disponível E com a tela aberta há pouco: só esses recebem conversa. */
  online: boolean
  openConversations: number
}

/** One contract as the SGP lookup returned it, with the state the server derived. */
export interface WaSubscriberContract {
  contract: string
  status: string | null
  statusLabel: string | null
  plan: string | null
  name: string | null
  document: string | null
  address: string | null
  login: string | null
  phone: string | null
  blocked: boolean | null
  state: SgpContractState
}

/** A part of the panel that failed on its own, already in the reader's language. */
export interface WaSubscriberPartError {
  code: string
  message: string | null
}

/**
 * The SGP module beside a WhatsApp thread. Each part answers on its own: the
 * ERP failing leaves the router half standing, and the other way round.
 */
export type WaSubscriberPanel =
  | {
      ready: false
      attendance: WaSubscriberAttendance
      ticketEnabled: false
    }
  | {
      ready: true
      attendance: WaSubscriberAttendance & {
        clientName: string | null
        document: string | null
        /** How the number was recognised; `conversation` when an operator bound it. */
        matchedOn: 'manual' | 'sgp' | 'conversation' | null
      }
      contracts: {
        items: WaSubscriberContract[]
        selected: string | null
        /** The contract asked for is not among the ones found. Nothing was guessed. */
        missing: boolean
        /** False when the number gave the server nothing to search with. */
        searched: boolean
        /** SGP failed and the list is the last stored link. */
        stale: boolean
        error: WaSubscriberPartError | null
      }
      contract: WaSubscriberContract | null
      /** The client's page in the SGP web app, or null when SGP gave no client id. */
      sgpUrl: string | null
      router:
        | { available: false; reason: 'unlinked' | 'unreachable'; deviceId: string | null; deviceIds: string[]; error?: WaSubscriberPartError }
        | {
            available: true
            deviceId: string
            deviceIds: string[]
            status: 'online' | 'offline' | null
            lastInform: string | null
            ont: { manufacturer: string | null; model: string | null; serialNumber: string | null } | null
            rxPower: number | string | null
            connectedDevices: number | string | null
            ipAddress: string | null
            connections: { type: string; name: string | null; status: string | null; ipAddress: string | null }[]
          }
      invoices: {
        items: SgpInvoice[]
        /** The oldest overdue invoice, else the next one due. */
        highlight: string | null
        error: WaSubscriberPartError | null
      }
      /** A régua parada para este contrato (comprovante recebido); null sem pausa. */
      dunningPause: WaDunningPause | null
      ticketEnabled: boolean
    }

export interface WaDunningPause {
  contract: string
  until: string
  reason: 'receipt' | 'manual'
}

export interface WaSubscriberAttendance {
  conversationId: number
  phone: string | null
  pushName: string | null
  contract: string | null
  deviceId: string | null
}

/** An SGP subscriber as a WhatsApp contact — one per contract. */
export type WhatsAppContactState = 'active' | 'blocked' | 'cancelled' | 'unknown' | 'none'

export interface WhatsAppContact {
  /** How the contact is addressed: its contract, or `c:<id>` when it has none. */
  key: string
  contract: string | null
  hasContract: boolean
  /** `none` is a client with no contract. */
  state: WhatsAppContactState
  /** When the SGP sync last saw this client; null for ONT-linked or looked-up rows. */
  lastSeenAt: string | null
  clientName: string | null
  /** CPF/CNPJ as its last digits only. */
  document: string | null
  deviceId: string | null
  /** False for a subscriber found by an SGP lookup that has no ONT in the panel. */
  hasDevice: boolean
  phone: string | null
  phoneSource: 'manual' | 'sgp' | null
  /** Where an imported client came from; null for what the SGP brought or the team typed. */
  importSource?: 'whatsapp' | 'sheet' | 'google' | 'focuschat' | null
  /** Blocked for everything. */
  optedOut: boolean
  /** Blocked only for these kinds; `null` when not blocked or blocked for everything. */
  optOutCategories?: string[] | null
  /** The thread already open with this subscriber, if any. */
  conversationId: number | null
  lastMessageAt: string | null
  /** The client's page in the SGP; null when the SGP is off or has not synced this client. */
  sgpUrl?: string | null
}

/** How many contacts each filter button would show if clicked now (see `WaContactService.counts`). */
export interface WhatsAppContactCounts {
  states: { all: number; active: number; blocked: number; cancelled: number; none: number }
  noPhone: number
  imported: number
  /** With and without a managed ONT linked, under the current tab. */
  withDevice?: number
  withoutDevice?: number
}

/** Only who has, or has not, a managed ONT linked to the contract. */
export type ContactDeviceFilter = '' | 'with' | 'without'

export interface WhatsAppContactPage {
  total: number
  counts: WhatsAppContactCounts
  contacts: WhatsAppContact[]
}

export interface WhatsAppMessage {
  id: number
  conversationId: number
  direction: 'in' | 'out'
  body: string | null
  /**
   * What the panel says about a file, never where it is: the browser fetches
   * the bytes by message id through `fetchAttachment`. The stored path stays on
   * the server side of the wire.
   */
  attachment: { type: string | null; name: string | null } | null
  isNote: boolean
  /**
   * Who produced it. `sentBy` cannot answer that: it is NULL for the bot, for a
   * campaign and for an alert alike, so the three were indistinguishable in the
   * thread and in the bot's own hourly ceiling.
   */
  source: 'operator' | 'bot' | 'campaign' | 'alert'
  externalId: string | null
  deliveryStatus: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | null
  deliveryError: string | null
  attempts: number
  /**
   * When the outbox may try this row again, or null for "now".
   *
   * A failed send is not terminal on the first bounce any more: it waits, and
   * the thread says so instead of showing a red mark the operator would read as
   * final. Null on every row that is not waiting.
   */
  nextAttemptAt: string | null
  sentBy: number | null
  /** `template` quando saiu como modelo aprovado da Meta, fora da janela. */
  sentAs?: 'text' | 'template' | null
  readAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** Os textos do bot que o provedor pode trocar — só os sem variável. */
export type BotMessageKey =
  | 'greeting' | 'askDocument' | 'handoffQueued' | 'handoff' | 'notRecognised' | 'noOpenInvoice' | 'outsideHours'
  | 'surveyQuestion' | 'surveyAskComment' | 'surveyThanks'

export interface BotHoursDay {
  /** 0 é domingo, como `Date#getDay`. */
  day: number
  closed: boolean
  open: string
  close: string
}

/** A aba Chatbot: o que o atendimento automático diz e quando. */
export interface BotConfig {
  enabled: boolean
  unlockEnabled: boolean
  options: { invoice: boolean; signal: boolean; human: boolean; document: boolean }
  /** Vazio usa o padrão. */
  messages: Record<BotMessageKey, string>
  /** Os textos padrão, no idioma de quem olha. */
  defaults: Record<BotMessageKey, string>
  hours: { enabled: boolean; timezone: string; week: BotHoursDay[] }
  /** A pesquisa de satisfação ao encerrar uma conversa com atendente. */
  satisfaction: { enabled: boolean }
  /** A distribuição automática das conversas entre quem está disponível. */
  distribution: { enabled: boolean }
  /** Etiqueta automática pelo assunto do pedido ao bot; ids de `WhatsAppTag`, ou null. */
  autoTags: { enabled: boolean; invoice: number | null; signal: number | null }
  /** Atendimento por IA. A chave nunca volta do servidor: só `hasApiKey`. */
  ai: BotAiConfig
}

export type BotAiProvider = 'openai-compatible' | 'anthropic'

/** Endereço e modelo padrão de cada provedor de IA (o servidor usa os mesmos). */
export const BOT_AI_PROVIDERS: Record<BotAiProvider, { baseUrl: string; model: string }> = {
  'openai-compatible': { baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.5-flash' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
}

export interface BotAiConfig {
  enabled: boolean
  suggest: boolean
  provider: BotAiProvider
  baseUrl: string
  model: string
  instructions: string
  hasApiKey: boolean
  /** Os 4 últimos caracteres da chave salva, para conferir; null se curta demais. */
  keyHint: string | null
  /** A última falha da IA, para dizer por que o cliente recebeu o menu. */
  lastError: { at: string; code: string; detail?: string | null } | null
}

/** O que a tela manda: `apiKey` nova troca a chave, `''` apaga, ausente mantém. */
export interface BotAiInput {
  enabled?: boolean
  suggest?: boolean
  provider?: BotAiProvider
  baseUrl?: string
  model?: string
  instructions?: string
  apiKey?: string
}

/** Quanto o cliente espera por gente: `GET /whatsapp/response-time-report`. Tempos em segundos. */
export interface ResponseTimeReport {
  days: 7 | 30 | 90
  timezone: string
  /** Com horário de atendimento, os números principais contam só as esperas que começaram dentro dele. */
  hoursEnabled: boolean
  answered: number
  medianSeconds: number | null
  p90Seconds: number | null
  averageSeconds: number | null
  /** Fração respondida em até 5, 15 e 60 min. */
  within: Array<{ seconds: number; rate: number | null }>
  outsideHours: { answered: number; medianSeconds: number | null }
  byAgent: Array<{ userId: number | null; name: string | null; answered: number; medianSeconds: number | null }>
  /** 24 posições, pela hora em que o cliente começou a esperar. */
  byHour: Array<{ answered: number; medianSeconds: number | null }>
  waitingNow: { count: number; oldestSince: string | null }
}

/** A pesquisa de satisfação: `GET /whatsapp/satisfaction-report`. */
export interface SatisfactionReport {
  days: 7 | 30 | 90
  asked: number
  answered: number
  /** `null` sem nenhuma pergunta no período. */
  responseRate: number | null
  /** De 1 a 5, uma casa; `null` sem resposta. */
  average: number | null
  /** Notas 4 e 5 sobre as respondidas. */
  satisfiedRate: number | null
  /** Quantas notas 1, 2, 3, 4 e 5. */
  distribution: [number, number, number, number, number]
  byAgent: Array<{ userId: number | null; name: string | null; asked: number; answered: number; average: number | null }>
  lowScores: Array<{
    conversationId: number
    contact: string | null
    contract: string | null
    score: number
    comment: string | null
    answeredAt: string | null
    agent: string | null
  }>
}

/** O relatório do chatbot: `GET /whatsapp/bot-report`. */
export interface BotReport {
  days: 7 | 30 | 90
  timezone: string
  replies: number
  conversations: number
  resolvedWithoutHuman: number
  /** `null` sem nenhuma conversa no período. */
  resolvedRate: number | null
  invoicesSent: number
  noOpenInvoice: number
  signalChecks: number
  outagesInformed: number
  unlocks: number
  identified: number
  documentFailures: number
  humanRequests: number
  /** 24 posições, hora 0 a 23 no fuso do horário de atendimento. */
  humanRequestsByHour: number[]
  daily: { day: string; conversations: number }[]
  intents: Record<string, number>
}

export const whatsappAPI = {
  getConfig: () =>
    apiClient.get<WhatsAppConfig>('/whatsapp/config'),

  getBotConfig: () =>
    apiClient.get<BotConfig>('/whatsapp/bot-config'),

  /** Campo ausente mantém o gravado. */
  updateBotConfig: (config: Partial<Omit<BotConfig, 'defaults' | 'ai'>> & { ai?: BotAiInput }) =>
    apiClient.put<BotConfig>('/whatsapp/bot-config', config),

  /** Uma pergunta curta à IA, com a chave digitada ou a salva. */
  testBotAi: (payload: { provider?: BotAiProvider; baseUrl?: string; model?: string; apiKey?: string }) =>
    apiClient.post<{ reply: string }>('/whatsapp/bot-config/ai-test', payload),

  /** Se o botão "Sugerir (IA)" aparece para quem atende. */
  getAiStatus: () =>
    apiClient.get<{ suggest: boolean; templates?: boolean }>('/whatsapp/ai/status'),

  /** A IA escreve (ou melhora) o texto de um modelo; só rascunho, nada é gravado. */
  draftTemplate: (payload: { category: string; goal: string; tone: string; current: string }) =>
    apiClient.post<{ text: string; warnings: { removed: string[]; mirrors: boolean } }>('/whatsapp/templates/ai-draft', payload),

  /** Um rascunho da IA para a caixa de resposta; nada é enviado. */
  suggestReply: (conversationId: number) =>
    apiClient.post<{ text: string }>(`/whatsapp/conversations/${conversationId}/suggest-reply`, {}),

  getBotReport: (days: 7 | 30 | 90) =>
    apiClient.get<BotReport>(`/whatsapp/bot-report?days=${days}`),

  getResponseTimeReport: (days: 7 | 30 | 90) =>
    apiClient.get<ResponseTimeReport>(`/whatsapp/response-time-report?days=${days}`),

  getSatisfactionReport: (days: 7 | 30 | 90) =>
    apiClient.get<SatisfactionReport>(`/whatsapp/satisfaction-report?days=${days}`),

  // An omitted managedAdminKey keeps the stored one; "" clears it. The server
  // never returns it either way.
  updateConfig: (config: Partial<Omit<WhatsAppConfig, 'allowedHosts'>> & { allowedHosts?: string | string[]; managedAdminKey?: string; cloudVerifyToken?: string }) =>
    apiClient.put<WhatsAppConfig>('/whatsapp/config', config),

  /**
   * O diagnóstico da configuração, que roda com zero números conectados.
   *
   * Sem corpo: ele testa o que está SALVO, não o que está digitado na tela. A
   * chave admin nunca volta ao navegador, então mandar o formulário aqui
   * testaria uma configuração sem chave — que é o oposto de um diagnóstico.
   */
  testConfig: () =>
    apiClient.post<WhatsAppConfigTest>('/whatsapp/test', {}),

  // ── Connected numbers ────────────────────────────────────────────────
  listAccounts: () =>
    apiClient.get<WhatsAppAccount[]>('/whatsapp/accounts'),

  // `baseUrl`/`adminKey` are ignored in managed mode, where the panel owns the
  // server and the operator never sees its address or its key.
  createAccount: (payload: {
    baseUrl?: string
    adminKey?: string
    label?: string
    purpose?: WhatsAppPurpose
    /** `cloud`: número oficial da Meta, com as três credenciais dela. */
    kind?: 'baileys' | 'cloud'
    metaToken?: string
    phoneNumberId?: string
    wabaId?: string
  }) =>
    apiClient.post<WhatsAppQrResult>('/whatsapp/accounts', payload),

  getQr: (id: number) =>
    apiClient.get<WhatsAppQrResult>(`/whatsapp/accounts/${id}/qr`),

  // Asks the server and writes back. This is the escape hatch for a lost
  // connection_update, which otherwise leaves a paired number amber forever.
  getStatus: (id: number) =>
    apiClient.get<{ account: WhatsAppAccount; state: WhatsAppStatus }>(`/whatsapp/accounts/${id}/status`),

  restartAccount: (id: number) =>
    apiClient.post<{ account: WhatsAppAccount }>(`/whatsapp/accounts/${id}/restart`, {}),

  /**
   * O que o servidor Evolution diz que o webhook deste número é.
   *
   * GET confere e POST reescreve, e a diferença de permissão é deliberada:
   * conferir é leitura e quem está de plantão pode; reescrever muda o servidor.
   */
  checkWebhook: (id: number) =>
    apiClient.get<WhatsAppWebhookCheck>(`/whatsapp/accounts/${id}/webhook`),

  reapplyWebhook: (id: number) =>
    apiClient.post<WhatsAppWebhookCheck>(`/whatsapp/accounts/${id}/webhook`, {}),

  /**
   * A volta: o painel manda uma sonda para o próprio endereço público e vê se
   * ela chega. É a única leitura que responde "esse endereço funciona?" em vez
   * de "o servidor tem o que mandamos?".
   */
  probeWebhook: (id: number) =>
    apiClient.post<WhatsAppWebhookProbe>(`/whatsapp/accounts/${id}/webhook/probe`, {}),

  // The only way to force a new QR: a server holding a session resumes it
  // instead of issuing one.
  disconnectAccount: (id: number) =>
    apiClient.post<{ account: WhatsAppAccount }>(`/whatsapp/accounts/${id}/disconnect`, {}),

  // The row goes either way; `serverError` is how the operator learns an
  // instance was left running on the server. No admin key is sent from here:
  // the one stored in the configuration covers a panel pointed at one server,
  // and a browser is the wrong place to be typing a server's master key.
  deleteAccount: (id: number) =>
    apiClient.delete<{ removedOnServer: boolean; serverError: string | null }>(`/whatsapp/accounts/${id}`),

  updateAccount: (id: number, patch: { label?: string; purpose?: WhatsAppPurpose; isDefault?: boolean; color?: string }) =>
    apiClient.requestWithBody<{ account: WhatsAppAccount }>('PATCH', `/whatsapp/accounts/${id}`, patch),

  checkNumbers: (numbers: string[]) =>
    apiClient.post<{ number: string; exists: boolean }[]>('/whatsapp/accounts/check-number', { numbers }),

  // ── Templates ────────────────────────────────────────────────────────
  listTemplates: (params: { category?: string; includeInactive?: boolean } = {}) => {
    const query = new URLSearchParams()
    if (params.category) query.set('category', params.category)
    if (params.includeInactive) query.set('includeInactive', '1')
    const suffix = query.toString()
    return apiClient.get<WhatsAppTemplate[]>(`/whatsapp/templates${suffix ? `?${suffix}` : ''}`)
  },

  createTemplate: (payload: {
    name: string
    body: string
    category?: string
    metaTemplateName?: string
    metaLanguage?: string
    metaParams?: string[]
    metaHeader?: MetaHeaderBinding | null
    metaButtonParam?: string | null
  }) =>
    apiClient.post<WhatsAppTemplate>('/whatsapp/templates', payload),

  updateTemplate: (id: number, patch: Partial<{
    name: string
    body: string
    category: string
    active: boolean
    metaTemplateName: string
    metaLanguage: string
    metaParams: string[]
    metaHeader: MetaHeaderBinding | null
    metaButtonParam: string | null
  }>) =>
    apiClient.put<WhatsAppTemplate>(`/whatsapp/templates/${id}`, patch),

  // ── Modelos aprovados da Meta (número oficial) ───────────────────────
  syncMetaTemplates: (accountId: number) =>
    apiClient.post<WhatsAppMetaTemplate[]>(`/whatsapp/accounts/${accountId}/templates/sync`, {}),

  // Token da Meta vencido ou revogado: o servidor recria a instância com o
  // mesmo nome e o mesmo webhook. A chave admin só vai no self-host — num
  // servidor gerenciado ela é da configuração, e nem aparece na tela.
  updateMetaToken: (id: number, metaToken: string, adminKey?: string) =>
    apiClient.post<{ account: WhatsAppAccount }>(`/whatsapp/accounts/${id}/meta-token`, {
      metaToken,
      ...(adminKey ? { adminKey } : {})
    }),

  /** Registra de novo o webhook da conta WABA na Meta, pelo servidor do painel. */
  registerMetaWebhook: (id: number) =>
    apiClient.post<{ account: WhatsAppAccount }>(`/whatsapp/accounts/${id}/meta-webhook`, {}),

  /** Sai PENDING: a Meta revisa, e só a sincronização depois da aprovação o libera. */
  createMetaTemplate: (accountId: number, payload: MetaTemplateCreatePayload) =>
    apiClient.post<WhatsAppMetaTemplate>(`/whatsapp/accounts/${accountId}/templates`, payload),

  listMetaTemplates: (params: { accountId?: number; usable?: boolean } = {}) => {
    const query = new URLSearchParams()
    if (params.accountId) query.set('accountId', String(params.accountId))
    if (params.usable) query.set('usable', '1')
    const suffix = query.toString()
    return apiClient.get<WhatsAppMetaTemplate[]>(`/whatsapp/meta-templates${suffix ? `?${suffix}` : ''}`)
  },

  getMetaNoticeBindings: () =>
    apiClient.get<MetaNoticeBindings>('/whatsapp/meta-notice-bindings'),

  saveMetaNoticeBindings: (bindings: Partial<Record<MetaNoticeKey, { name: string; language: string } | null>>) =>
    apiClient.put<MetaNoticeBindings>('/whatsapp/meta-notice-bindings', bindings),

  getMetaUsage: (months: MetaUsagePeriod) =>
    apiClient.get<MetaUsageReport>(`/whatsapp/meta-usage?months=${months}`),

  getMetaPrices: () =>
    apiClient.get<MetaPrices>('/whatsapp/meta-prices'),

  saveMetaPrices: (prices: Partial<Record<MetaPriceCategory, number | string | null>>) =>
    apiClient.put<MetaPrices>('/whatsapp/meta-prices', prices),

  deleteTemplate: (id: number) =>
    apiClient.delete(`/whatsapp/templates/${id}`),

  // ── Do not disturb ───────────────────────────────────────────────────
  listOptOuts: () =>
    apiClient.get<WhatsAppOptOut[]>('/whatsapp/opt-outs'),

  createOptOut: (payload: { phone: string; reasonText?: string; categories?: string[] | null }) =>
    apiClient.post<WhatsAppOptOut>('/whatsapp/opt-outs', payload),

  /** Changes which kinds of message an entry blocks; `null` is everything. */
  updateOptOut: (id: number, categories: string[] | null) =>
    apiClient.requestWithBody<WhatsAppOptOut>('PATCH', `/whatsapp/opt-outs/${id}`, { categories }),

  revokeOptOut: (id: number) =>
    apiClient.delete(`/whatsapp/opt-outs/${id}`),

  // ── Billing cadence ──────────────────────────────────────────────────
  // The window is symmetric: a negative `daysMin` means "due within N days".
  listOverdue: (params: { daysMin?: number; daysMax?: number; search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    })
    const suffix = query.toString()
    return apiClient.get<WhatsAppOverdueSubscriber[]>(`/whatsapp/billing/overdue${suffix ? `?${suffix}` : ''}`)
  },

  // Builds the campaign as a DRAFT and returns it. Messaging hundreds of people
  // is never the side effect of a click on a listing screen.
  buildBillingCampaign: (payload: { template: string; contracts: string[]; title?: string }) =>
    apiClient.post<{ broadcast: WhatsAppBroadcast; recipients: number; skipped: WhatsAppSkipCounts }>(
      '/whatsapp/billing/campaign',
      payload
    ),

  // ── Automatic billing cadence ────────────────────────────────────────
  // Unlike the builder above, this one SENDS. Saving never switches it on.
  getDunningRule: () =>
    apiClient.get<WhatsAppDunningRule>('/whatsapp/dunning/rule'),

  saveDunningRule: (payload: Partial<Pick<WhatsAppDunningRule,
    'steps' | 'window' | 'maxPerInvoice' | 'minIntervalHours' | 'maxPerRun' | 'receiptPauseDays' | 'thanksTemplateId'>>) =>
    apiClient.put<WhatsAppDunningRule>('/whatsapp/dunning/rule', payload),

  setDunningEnabled: (enabled: boolean) =>
    apiClient.post<WhatsAppDunningRule>('/whatsapp/dunning/enabled', { enabled }),

  // The preview runs in the background — one ERP round trip per contract is
  // minutes, past what a reverse proxy waits. Start it, then poll.
  startDunningPreview: () =>
    apiClient.post<WhatsAppDunningPreviewState>('/whatsapp/dunning/preview', {}),

  getDunningPreview: () =>
    apiClient.get<WhatsAppDunningPreviewState>('/whatsapp/dunning/preview'),

  // The ready-made templates and, on a cadence with no steps yet, the steps
  // that use them. Never switches the cadence on.
  installDunningStarter: () =>
    apiClient.post<{ created: number; reused: number; stepsFilled: boolean; rule: WhatsAppDunningRule }>(
      '/whatsapp/dunning/starter',
      {}
    ),

  runDunning: () =>
    apiClient.post<{ started: boolean }>('/whatsapp/dunning/run', {}),

  listDunningSends: (params: { contract?: string; status?: string; kind?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    })
    const suffix = query.toString()
    return apiClient.get<{ items: WhatsAppDunningSend[]; hasMore: boolean }>(
      `/whatsapp/dunning/sends${suffix ? `?${suffix}` : ''}`
    )
  },

  getDunningStats: (days = 30) =>
    apiClient.get<WhatsAppDunningStats>(`/whatsapp/dunning/stats?days=${days}`),

  // ── Campaigns ────────────────────────────────────────────────────────
  listBroadcasts: () =>
    apiClient.get<WhatsAppBroadcast[]>('/whatsapp/broadcasts'),

  getBroadcastRecipients: (id: number, params: { status?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    })
    const suffix = query.toString()
    return apiClient.get<WhatsAppBroadcastDetail>(`/whatsapp/broadcasts/${id}/recipients${suffix ? `?${suffix}` : ''}`)
  },

  setBroadcastStatus: (id: number, status: 'running' | 'paused' | 'canceled') =>
    apiClient.post<WhatsAppBroadcast>(`/whatsapp/broadcasts/${id}/status`, { status }),

  // ── Campanha de aviso ("Nova campanha") ──────────────────────────────
  getCampaignAudienceOptions: () =>
    apiClient.get<WhatsAppCampaignAudienceOptions>('/whatsapp/broadcasts/audience-options'),

  previewCampaign: (input: Omit<WhatsAppCampaignInput, 'title' | 'attachment' | 'scheduledAt'>) =>
    apiClient.post<WhatsAppCampaignPreview>('/whatsapp/broadcasts/preview', input),

  listReferrals: (status?: WhatsAppReferralStatus | '') =>
    apiClient.get<WhatsAppReferralList>(`/whatsapp/referrals${status ? `?status=${status}` : ''}`),

  updateReferral: (id: number, patch: { status?: WhatsAppReferralStatus; note?: string }) =>
    apiClient.patch<WhatsAppReferral>(`/whatsapp/referrals/${id}`, patch),

  setReferralBaseUrl: (baseUrl: string) =>
    apiClient.put<{ baseUrl: string | null }>('/whatsapp/referrals/base-url', { baseUrl }),

  updateCampaign: (id: number, input: WhatsAppCampaignInput) =>
    apiClient.put<{ broadcast: WhatsAppBroadcast; recipients: number }>(`/whatsapp/broadcasts/${id}`, input),

  createCampaign: (input: WhatsAppCampaignInput) =>
    apiClient.post<{ broadcast: WhatsAppBroadcast; recipients: number }>('/whatsapp/broadcasts', input),

  // ── The subscriber's number ──────────────────────────────────────────
  // What an operator typed always beats what SGP synced, because the ERP
  // cadastre is stale and the operator is the one holding the correction. An
  // empty string clears the override and hands the contract back to the ERP.
  setSubscriberPhone: (contract: string, phone: string) =>
    apiClient.put<WhatsAppOverdueSubscriber>(
      `/whatsapp/subscribers/${encodeURIComponent(contract)}/phone`,
      { phone }
    ),

  // ── Technical alerts ─────────────────────────────────────────────────
  getAlertSettings: () =>
    apiClient.get<WhatsAppAlertSettings>('/whatsapp/alerts/settings'),

  updateAlertSettings: (
    settings: Partial<Omit<WhatsAppAlertSettings, 'telegram'>> & {
      /** `botToken` omitido mantém o guardado; `''` apaga. */
      telegram?: { botToken?: string; chatId?: string }
    }
  ) =>
    apiClient.put<WhatsAppAlertSettings>('/whatsapp/alerts/settings', settings),

  /** Uma mensagem de teste no grupo do Telegram dos alertas. */
  testAlertTelegram: () =>
    apiClient.post<{ sent: boolean }>('/whatsapp/alerts/telegram/test', {}),

  runAlertScan: () =>
    apiClient.post<{ fired: number; cleared: number }>('/whatsapp/alerts/scan', {}),

  // ── Inbox ────────────────────────────────────────────────────────────
  // `search` matches the phone, the pushed WhatsApp name, the contract and the
  // subscriber's name — an operator looking for a thread has one of those four
  // and does not know which the panel stores. `status` defaults to the open
  // ones: a closed thread is done, and an inbox that shows everything forever
  // stops being a list of what needs answering.
  listConversations: (params: {
    limit?: number
    offset?: number
    search?: string
    /** 'noreply': só envios automáticos, o cliente ainda não respondeu. */
    status?: 'open' | 'noreply' | 'closed' | 'all'
    /** 'me': só as minhas; 'unassigned': sem atendente. */
    assignee?: 'me' | 'unassigned'
    /** Só as conversas com esta etiqueta. */
    tag?: number
  } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.search) query.set('search', params.search)
    if (params.status) query.set('status', params.status)
    if (params.assignee) query.set('assignee', params.assignee)
    if (params.tag) query.set('tag', String(params.tag))
    const suffix = query.toString()
    return apiClient.get<WhatsAppConversation[]>(`/whatsapp/conversations${suffix ? `?${suffix}` : ''}`)
  },

  // Closing is a filing decision, not a deletion: the thread and its history
  // stay, and an inbound message reopens it — a customer who writes again is
  // not answered by an archive.
  setConversationStatus: (conversationId: number, status: 'open' | 'closed') =>
    apiClient.post<WhatsAppConversation>(`/whatsapp/conversations/${conversationId}/status`, { status }),

  /** Assumir (o próprio id), transferir para um colega, ou `null` para soltar. */
  assignConversation: (conversationId: number, userId: number | null) =>
    apiClient.post<WhatsAppConversation>(`/whatsapp/conversations/${conversationId}/assign`, { userId }),

  listTags: () =>
    apiClient.get<WhatsAppTag[]>('/whatsapp/tags'),

  tagsReport: (days: 7 | 30 | 90) =>
    apiClient.get<TagsReport>(`/whatsapp/tags/report?days=${days}`),

  createTag: (tag: { name: string; color: string }) =>
    apiClient.post<WhatsAppTag>('/whatsapp/tags', tag),

  updateTag: (id: number, patch: { name?: string; color?: string }) =>
    apiClient.patch<WhatsAppTag>(`/whatsapp/tags/${id}`, patch),

  deleteTag: (id: number) =>
    apiClient.delete<null>(`/whatsapp/tags/${id}`),

  /** Troca o conjunto inteiro de etiquetas da conversa. */
  setConversationTags: (conversationId: number, tagIds: number[]) =>
    apiClient.put<WhatsAppConversation>(`/whatsapp/conversations/${conversationId}/tags`, { tagIds }),

  getWaiting: () =>
    apiClient.get<WaitingReport>('/whatsapp/waiting'),

  /** As mensagens novas de clientes que pedem aviso, depois do cursor do servidor. */
  getNotifications: (after?: string | null) =>
    apiClient.get<{ cursor: string; items: NotificationItem[] }>(
      `/whatsapp/notifications${after ? `?after=${encodeURIComponent(after)}` : ''}`
    ),

  getConversation: (id: number) =>
    apiClient.get<WhatsAppConversation>(`/whatsapp/conversations/${id}`),

  listAgents: () =>
    apiClient.get<WhatsAppAgent[]>('/whatsapp/agents'),

  /** O interruptor "Disponível"; a tela reenvia a cada minuto como pulso. */
  setAvailability: (available: boolean) =>
    apiClient.post<WhatsAppAgent>('/whatsapp/agents/me', { available }),

  // Says by hand which SGP subscriber a thread belongs to. `savePhone` also
  // writes the thread's number onto the contract, and needs `campaigns.manage`.
  linkConversationSubscriber: (conversationId: number, key: string, savePhone = false) =>
    apiClient.post<WhatsAppConversation>(
      `/whatsapp/conversations/${conversationId}/subscriber`,
      { contract: key, savePhone }
    ),

  // ── SGP contacts ─────────────────────────────────────────────────────
  listContacts: (params: { search?: string; limit?: number; offset?: number; state?: WhatsAppContactState; noPhone?: boolean; imported?: boolean; device?: ContactDeviceFilter } = {}) => {
    const query = new URLSearchParams()
    if (params.search) query.set('search', params.search)
    if (params.state) query.set('state', params.state)
    // Só quem não tem número para mensagem; combina com a situação.
    if (params.noPhone) query.set('noPhone', 'true')
    if (params.imported) query.set('imported', 'true')
    if (params.device) query.set('device', params.device)
    if (params.limit) query.set('limit', String(params.limit))
    if (params.offset) query.set('offset', String(params.offset))
    const suffix = query.toString()
    return apiClient.get<WhatsAppContactPage>(`/whatsapp/contacts${suffix ? `?${suffix}` : ''}`)
  },

  // Asks the SGP itself, by CPF/CNPJ or contract — the way to reach a
  // subscriber with no ONT in the panel. What it finds becomes a contact.
  lookupContacts: (search: string) =>
    apiClient.post<WhatsAppContactPage>('/whatsapp/contacts/lookup', { search }),

  // The existing thread with this subscriber, or a new empty one. Opening sends
  // nothing.
  // `phone`: another of the client's numbers, from its record, instead of its
  // WhatsApp number.
  openContactConversation: (key: string, phone?: string) =>
    apiClient.post<WhatsAppConversation>(
      `/whatsapp/contacts/${encodeURIComponent(key)}/conversation`,
      phone ? { phone } : undefined
    ),

  // Reading a thread clears its unread count server-side — the operator looking
  // at it is the only thing "read" can mean here.
  // `before` is the id of the oldest message already on screen — a cursor, not
  // an offset. The thread grows while it is being read, and an offset page
  // would repeat or skip a message every time a customer answers mid-scroll.
  listMessages: (conversationId: number, params: { limit?: number; before?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.before) query.set('before', String(params.before))
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return apiClient.get<{ conversation: WhatsAppConversation; messages: WhatsAppMessage[] }>(
      `/whatsapp/conversations/${conversationId}/messages${suffix}`
    )
  },

  // ── Is it working? ───────────────────────────────────────────────────
  // A single aggregate read. Cheap on purpose: a screen that polls it must not
  // be the reason the panel is slow.
  getHealth: () =>
    apiClient.get<WhatsAppHealth>('/whatsapp/health'),

  // The attachment sweep, on demand, for the operator who needs the disk back
  // before the next pass six hours from now. It takes no parameters: the window
  // and the rules come from the saved settings, so pressing the button can
  // never delete more than the settings screen already says it will.
  //
  // `skipped` is the answer that matters. "0 files" means one of retention
  // being off, nothing being old enough, or a pass already running — and those
  // read identically unless the reason comes back with the count.
  // Puts one failed message back in the queue, as ITSELF. The old screen-side
  // "resend" read the row's body and sent a new message, which left the failed
  // row behind, produced a duplicate for the subscriber, and did nothing at all
  // when the content was an attachment and the body was empty.
  // ── The SGP module beside a thread ─────────────────────────────────────
  // `contract` is an exact pick from the contracts found; `document` is the
  // manual search for a number the panel does not know. Every act names the
  // contract, and the server refuses one it did not itself find for the thread.
  getSubscriberPanel: (conversationId: number, params: { contract?: string; document?: string } = {}) => {
    const query = new URLSearchParams()
    if (params.contract) query.set('contract', params.contract)
    if (params.document) query.set('document', params.document)
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return apiClient.get<WaSubscriberPanel>(`/whatsapp/conversations/${conversationId}/subscriber${suffix}`)
  },

  bindSubscriber: (conversationId: number, payload: { contract: string; document?: string }) =>
    apiClient.post<WaSubscriberPanel>(`/whatsapp/conversations/${conversationId}/subscriber/bind`, payload),

  /** "Retomar régua": tira a pausa por comprovante do contrato desta conversa. */
  subscriberResumeDunning: (conversationId: number, contract: string) =>
    apiClient.post<{ contract: string; dunningPause: null }>(
      `/whatsapp/conversations/${conversationId}/subscriber/dunning-resume`,
      { contract }
    ),

  subscriberUnlock: (conversationId: number, contract: string) =>
    apiClient.post<{ contract: string }>(`/whatsapp/conversations/${conversationId}/subscriber/unlock`, { contract }),

  // The billing text for the subscriber's invoice, rendered by the server with
  // the same rules as a campaign. It comes back to the composer; nothing is sent.
  /** Manda a fatura ao cliente, em mensagens separadas; o servidor relê tudo no SGP. */
  subscriberSendInvoice: (conversationId: number, payload: { contract: string; invoiceId: string }) =>
    apiClient.post<{ contract: string; invoiceId: string; messages: WhatsAppMessage[] }>(
      `/whatsapp/conversations/${conversationId}/subscriber/invoice`,
      payload
    ),

  subscriberSecondCopy: (conversationId: number, payload: { contract: string; template: string }) =>
    apiClient.post<{ contract: string; invoiceId: string | null; text: string }>(
      `/whatsapp/conversations/${conversationId}/subscriber/second-copy`,
      payload
    ),

  // "This number is theirs": the thread's phone becomes the contract's manual phone.
  subscriberSavePhone: (conversationId: number, contract: string) =>
    apiClient.post<WaSubscriberPanel>(`/whatsapp/conversations/${conversationId}/subscriber/phone`, { contract }),

  subscriberTicket: (conversationId: number, payload: { contract: string; content: string; note?: string }) =>
    apiClient.post<SgpTicket>(`/whatsapp/conversations/${conversationId}/subscriber/ticket`, payload),

  requeueMessage: (id: number) =>
    apiClient.post<WhatsAppMessage>(`/whatsapp/messages/${id}/requeue`, {}),

  // Every message that failed inside the window, back in the queue, for the
  // campaign case: an Evolution restart during a dunning run fails thousands,
  // and requeuing them one at a time is not a recovery.
  requeueFailed: (hours: number) =>
    apiClient.post<{ requeued: number }>('/whatsapp/messages/requeue-failed', { hours }),

  sweepMedia: () =>
    apiClient.post<{ files: number; bytes: number; mb: number; skipped?: string }>(
      '/whatsapp/media/sweep',
      {}
    ),

  // ── Attachments ──────────────────────────────────────────────────────
  // The raw file as the body, its name in a header. No multipart, and so no
  // upload dependency for one screen — the same choice the SGP webhook makes
  // with `express.raw`. Returns the stored reference `sendMessage` takes.
  // `type` é o que a tela resolveu (`resolveAttachmentType`), não o do
  // navegador: a foto HEIC do iPhone chega sem tipo e o Windows chama CSV de
  // planilha do Excel, e o servidor confere o conteúdo contra o que for
  // declarado aqui — declarar errado é ser recusado com razão.
  uploadAttachment: (file: File, type?: string) =>
    apiClient.sendBlob<{ path: string; type: string; name: string }>(
      '/whatsapp/attachments',
      file,
      { 'Content-Type': type || file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }
    ),

  // A blob rather than a URL, because the route is session-authenticated and an
  // `<img src>` cannot carry an Authorization header. The caller makes an object
  // URL from it and revokes that when the bubble goes away.
  fetchAttachment: (messageId: number) =>
    apiClient.getBlob(`/whatsapp/messages/${messageId}/media`),

  // Enqueues and returns; the outbox worker delivers. An internal note is
  // stored and never sent.
  sendMessage: (conversationId: number, payload: { body?: string; attachment?: { url: string; type?: string; name?: string }; isNote?: boolean; metaTemplate?: MetaTemplatePayload }) =>
    apiClient.post<WhatsAppMessage>(`/whatsapp/conversations/${conversationId}/messages`, payload),

  // ── Subscriber phone ─────────────────────────────────────────────────
  // Overrides what SGP returned. An empty string clears the override and falls
  // back to the ERP value.
  setDevicePhone: (deviceId: string, phone: string) =>
    apiClient.put<{ phoneE164: string | null; phoneManual: string | null }>(
      `/whatsapp/devices/${encodeURIComponent(deviceId)}/phone`,
      { phone }
    ),
}

/** Uma queda em massa que o alerta viu, e o aviso aos clientes atingidos. */
export interface OutageIncident {
  id: number
  nodeId: string
  nodeName: string
  status: 'open' | 'resolved'
  startedAt: string
  resolvedAt: string | null
  eta: string | null
  noticeBody: string | null
  noticeSentAt: string | null
  recoverySentAt: string | null
  /** O texto que sai quando o operador não escreve outro. */
  defaultNotice: string
  affected: number
  /** Telefones distintos com WhatsApp entre os atingidos. */
  withPhone: number
  notified: number
}

export interface OutageIncidentDetail extends OutageIncident {
  devices: { deviceId: string; contract: string | null; clientName: string | null; hasPhone: boolean; notifiedAt: string | null }[]
}

export type MaintenanceStatus = 'scheduled' | 'active' | 'done' | 'cancelled'

export interface MaintenanceWindow {
  id: number
  nodeId: string
  nodeName: string
  nodeType: string | null
  startsAt: string
  endsAt: string
  leadHours: number
  /** Quando o aviso automático sai (início menos a antecedência). */
  noticeAt: string
  message: string | null
  status: MaintenanceStatus
  noticeSentAt: string | null
  closingSentAt: string | null
  finishedAt: string | null
  defaultNotice: string
  affected: number
  withPhone: number
  notified: number
}

export interface MaintenanceWindowDetail extends MaintenanceWindow {
  devices: { deviceId: string; contract: string | null; clientName: string | null; hasPhone: boolean; notifiedAt: string | null }[]
}

export interface MaintenanceNode {
  nodeId: string
  name: string
  type: string
}

export interface MaintenancePreview {
  nodeId: string
  nodeName: string
  nodeType: string
  affected: number
  withPhone: number
  sampleNotice: string
}

export interface MaintenanceInput {
  nodeId: string
  startsAt: string
  endsAt: string
  leadHours: number
  message?: string
}

export const maintenanceAPI = {
  list: () => apiClient.get<{ windows: MaintenanceWindow[] }>('/whatsapp/maintenances'),
  nodes: () => apiClient.get<{ nodes: MaintenanceNode[] }>('/whatsapp/maintenances/nodes'),
  /** `startsAt`/`endsAt` só servem para o texto de exemplo sair com o horário escolhido. */
  preview: (nodeId: string, window?: { startsAt: string; endsAt: string }) => {
    const query = new URLSearchParams({ nodeId, ...(window ?? {}) })
    return apiClient.get<MaintenancePreview>(`/whatsapp/maintenances/preview?${query.toString()}`)
  },
  get: (id: number) => apiClient.get<MaintenanceWindowDetail>(`/whatsapp/maintenances/${id}`),
  create: (input: MaintenanceInput) => apiClient.post<MaintenanceWindowDetail>('/whatsapp/maintenances', input),
  notify: (id: number) =>
    apiClient.post<{ sent: number; skippedOptOut: number; window: MaintenanceWindowDetail }>(`/whatsapp/maintenances/${id}/notify`, {}),
  cancel: (id: number) => apiClient.post<MaintenanceWindowDetail>(`/whatsapp/maintenances/${id}/cancel`, {}),
  conclude: (id: number) => apiClient.post<MaintenanceWindowDetail>(`/whatsapp/maintenances/${id}/conclude`, {}),
}

/** Os filtros do quadro "Quedas em massa". */
export interface OutageFilters {
  /** 1, 7, 30 ou 90 dias para trás; um incidente aberto aparece em qualquer período. */
  days?: 1 | 7 | 30 | 90
  status?: '' | 'open' | 'resolved'
  /** Parte do nome do ponto do mapa. */
  search?: string
  /** `pending`: ninguém avisado ainda. */
  notified?: '' | 'pending' | 'sent'
}

export const outagesAPI = {
  /** Sem filtro: abertos e resolvidos nas últimas 24 h. */
  list: (filters: OutageFilters = {}) => {
    const query = new URLSearchParams()
    if (filters.days && filters.days !== 1) query.set('days', String(filters.days))
    if (filters.status) query.set('status', filters.status)
    if (filters.search?.trim()) query.set('search', filters.search.trim())
    if (filters.notified) query.set('notified', filters.notified)
    const suffix = query.toString()
    return apiClient.get<{ incidents: OutageIncident[] }>(`/whatsapp/outages${suffix ? `?${suffix}` : ''}`)
  },
  get: (id: number) => apiClient.get<OutageIncidentDetail>(`/whatsapp/outages/${id}`),
  setEta: (id: number, eta: string) => apiClient.requestWithBody<OutageIncidentDetail>('PATCH', `/whatsapp/outages/${id}`, { eta }),
  /** Avisa quem ainda não foi avisado. `body` vazio usa o texto padrão. */
  notify: (id: number, payload: { eta?: string; body?: string }) =>
    apiClient.post<{ sent: number; skippedOptOut: number; incident: OutageIncidentDetail }>(`/whatsapp/outages/${id}/notify`, payload),
  resolve: (id: number) => apiClient.post<OutageIncidentDetail>(`/whatsapp/outages/${id}/resolve`, {}),
}

/**
 * A página pública do ápice: sem sessão. O catálogo à venda, o subdomínio
 * livre, o CNPJ na Receita e o pedido de demonstração.
 */
export const publicAPI = {
  info: () => apiClient.get<PublicInfo>('/public/info'),
  plans: () => apiClient.get<{ plans: PublicPlan[] }>('/public/plans'),
  slugAvailable: (slug: string) =>
    apiClient.get<{ slug: string; available: boolean; problem: 'invalid' | 'taken' | null }>(
      `/public/slug-available?slug=${encodeURIComponent(slug)}`
    ),
  cnpj: (cnpj: string) => apiClient.get<CnpjData>(`/public/cnpj?cnpj=${encodeURIComponent(cnpj)}`),
  createLead: (payload: {
    name: string; company?: string; email?: string; phone?: string; city?: string
    devicesEstimate?: number | null; message?: string; planCode?: string | null; website?: string
  }) => apiClient.post<{ ok: boolean }>('/public/leads', payload),
}

/** Um mês do relatório de receita: o que entrou e o que voltou nele. */
export interface RevenueMonth {
  /** `YYYY-MM`, em UTC. */
  month: string
  receivedCents: number
  refundedCents: number
  /** Cobranças pagas no mês. */
  count: number
}

/** Uma linha "por plano" do relatório: as ativas pagantes e o recebido no período. */
export interface RevenuePlanRow {
  planId: number | null
  name: string | null
  activeCount: number
  mrrCents: number
  receivedCents: number
}

/**
 * O relatório de receita do console (`GET /platform/reports/revenue`).
 * Recebido e estornado são do período; MRR e em aberto são de agora.
 */
export interface RevenueReport {
  from: string
  to: string
  mrrCents: number
  activeCount: number
  receivedCents: number
  refundedCents: number
  openCents: number
  overdueCents: number
  overdueTenants: number
  monthly: RevenueMonth[]
  byPlan: RevenuePlanRow[]
  discountCents: number
  /** O desconto é estimado contra o preço de hoje dos planos (o da época não é gravado). */
  discountApproximate?: boolean
}

/** Os relatórios do console: a receita, e a planilha das cobranças do período. */
export const platformReportsAPI = {
  revenue: (range: { from: string; to: string }) =>
    apiClient.get<RevenueReport>(
      `/platform/reports/revenue?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
    ),
  revenueCsv: (range: { from: string; to: string }) =>
    apiClient.getBlob(
      `/platform/reports/revenue.csv?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
    ),
  /** Os pedidos de cancelamento (0107), desde `from` (YYYY-MM-DD) ou todos. */
  cancellations: (from?: string) =>
    apiClient.get<CancellationReport>(
      `/platform/reports/cancellations${from ? `?from=${encodeURIComponent(from)}` : ''}`
    ),
  /** O console desfaz o cancelamento agendado de um provedor. 409 `not_scheduled` sem agendamento. */
  revertCancellation: (tenantId: number) =>
    apiClient.delete<{ reverted: boolean }>(`/platform/tenants/${tenantId}/subscription/cancellation`),
}

// ── A indicação de provedores (0106) ─────────────────────────────────────

export type ReferralStatus = 'pending' | 'credited' | 'canceled'

/** Um crédito do saldo do provedor: a recompensa de uma indicação, ou o ajuste do console. */
export interface TenantCreditView {
  id: number
  amountCents: number
  remainingCents: number
  source: 'referral' | 'manual'
  reference: string | null
  canceled: boolean
  canceledAt: string | null
  createdAt: string | null
}

/** A tela de Plano do provedor: o link, o saldo e os indicados (nome mascarado). */
export interface TenantReferrals {
  enabled: boolean
  rewardCents: number
  code: string | null
  /** Nulo quando o deploy não sabe o próprio endereço; a tela monta pela origem. */
  signupUrl: string | null
  balanceCents: number
  reservedCents: number
  referrals: {
    id: number
    name: string
    status: ReferralStatus
    amountCents: number
    createdAt: string | null
    creditedAt: string | null
  }[]
  credits: TenantCreditView[]
}

/** Uma indicação vista do console: o nome inteiro e o pagamento que a pagou. */
export interface ConsoleReferral {
  id: number
  tenantId: number
  name: string | null
  slug: string | null
  status: ReferralStatus
  amountCents: number
  paymentExternalId: string | null
  createdAt: string | null
  creditedAt: string | null
  canceledAt: string | null
}

export interface CreditAllocationView {
  id: number
  creditId: number
  chargeId: number
  amountCents: number
  status: 'reserved' | 'consumed' | 'released'
  createdAt: string | null
  updatedAt: string | null
}

export interface ConsoleReferrals {
  code: string | null
  rewardCents: number
  balanceCents: number
  reservedCents: number
  referredBy: ConsoleReferral | null
  referrals: ConsoleReferral[]
  credits: TenantCreditView[]
  allocations: CreditAllocationView[]
}

export interface CreditAdjustResult {
  creditId: number
  amountCents: number
  balanceBefore: number
  balanceAfter: number
  referrals: ConsoleReferrals
}

export const referralsAPI = {
  /** O link de indicação (o código nasce na primeira leitura), o saldo e os indicados. */
  mine: () =>
    apiClient.get<TenantReferrals>('/tenant/referrals'),

  /** O console: indicações e créditos de um provedor. */
  ofTenant: (tenantId: number) =>
    apiClient.get<ConsoleReferrals>(`/platform/tenants/${tenantId}/referrals`),

  /**
   * O ajuste manual do saldo, com motivo (auditado). Negativo tira do saldo;
   * 409 `insufficient_credit` (com `balanceCents`) quando passa dele, 400
   * `invalid_amount` e `reason_required`.
   */
  adjust: (tenantId: number, payload: { amountCents: number; reason: string }) =>
    apiClient.post<CreditAdjustResult>(`/platform/tenants/${tenantId}/credits`, payload),
}
