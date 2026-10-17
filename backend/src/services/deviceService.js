import Setting from '../models/Setting.js';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import VendorService from './vendorService.js';
import {
  PPPOE_FALLBACK_PATHS,
  RX_POWER_FALLBACK_PATHS,
  TEMPERATURE_FALLBACK_PATHS,
  WAN_SERVICE_NAMES,
  WAN_VLAN_NAMES,
  findPppoeUsername,
  findRxPowerReading,
  findTemperatureReading,
  findWanParameterByName,
  listDocumentParameters,
  normalizeRxPowerReading,
  normalizeTemperatureReading,
  opticalReadingLeaves,
  pppoeLoginLeaves,
  VENDOR_OPTICAL_OBJECTS
} from './deviceParameterFallbacks.js';
import {
  DIAGNOSTIC_KINDS,
  DIAGNOSTIC_OBJECTS,
  PING_COUNT_DEFAULT,
  PING_COUNT_MAX,
  diagnosticRequest,
  diagnosticRoot,
  isValidDiagnosticHost,
  readDiagnosticResult
} from './deviceDiagnostics.js';
import {
  FIRMWARE_FILE_TYPE,
  compatibleFirmware,
  currentFirmwareVersion,
  filesOwnedBy,
  firmwareCatalog,
  isInstalledVersion
} from './firmwareFiles.js';
import { mapWithLimit } from './deviceBatch.js';
import Vendor from '../models/Vendor.js';
import WifiSecurityConfig from '../models/WifiSecurityConfig.js';
import AppState from '../models/AppState.js';
import { DEFAULT_SETTINGS } from '../config/seed.js';
import { TranslatableError } from '../i18n/index.js';
import { currentTenantId } from '../config/tenantContext.js';
import { connectorFor } from './genieacs/connector.js';
import { UNASSIGNED_SCOPE_TAG } from './genieacs/direct.js';

/** A página da coleção `files`, e quantas no máximo (10 000 arquivos). */
const FIRMWARE_PAGE_SIZE = 500;
const FIRMWARE_MAX_PAGES = 20;

const WAN_PARAMETER_CANDIDATES = Object.freeze({
  vlan: [
    'X_ZTE-COM_VLANID',
    'X_HW_VLAN',
    'X_CMCC_VLANIDMark',
    'VLANID',
    'X_CT-COM_WANEponLinkConfig.VLANIDMark'
  ],
  serviceList: [
    'X_ZTE-COM_ServiceList',
    'X_HW_SERVICELIST',
    'X_FH_ServiceList',
    'ServiceList'
  ],
  bindings: [
    'X_HW_LANBIND'
  ]
});



class DeviceService {
  /**
   * One dashboard cache per provider.
   *
   * The shape is unchanged; what changed is that there is no longer a single
   * one. It holds device and fault counts — a provider's own subscribers — and
   * `promise` collapses concurrent refreshes onto one. Shared, the second
   * provider to ask did not merely read stale numbers: it awaited the first
   * provider's in-flight refresh and was handed that result.
   */
  static dashboardCaches = new Map();

  static dashboardCacheFor() {
    const id = currentTenantId();
    let cache = this.dashboardCaches.get(id);
    if (!cache) {
      cache = { data: null, scope: null, expiresAt: 0, promise: null, hydrated: false };
      this.dashboardCaches.set(id, cache);
    }
    return cache;
  }

  /** This provider's dashboard is stale — something it owns just changed. */
  static invalidateDashboard() {
    this.dashboardCacheFor().expiresAt = 0;
  }

  /** Every provider's. For a reset between tests. */
  static forgetDashboards() {
    this.dashboardCaches.clear();
  }

  static dashboardCacheTtlMs = 60_000;

  static getParameterNode(obj, parameterPath) {
    if (!obj || !parameterPath) return null;
    let current = obj;
    for (const part of String(parameterPath).split('.')) {
      if (!current || typeof current !== 'object') return null;
      current = current[part];
    }
    return current ?? null;
  }

  static getParameterValue(obj, parameterPath) {
    return this.readNodeValue(this.getParameterNode(obj, parameterPath));
  }

  /** The display value of a node the caller already holds. */
  static readNodeValue(node) {
    if (node && typeof node === 'object' && '_value' in node) {
      return this.normalizeParameterValue(node._value);
    }
    return this.normalizeParameterValue(node);
  }

  /** A parameter GenieACS answers with an empty string has told us nothing. */
  static hasReportedValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
  }

  /**
   * The subscriber login, and where it was read.
   *
   * The operator's VirtualParameter is authoritative and is tried first; the
   * ONT's own WAN tree is consulted only when it answered with nothing, which
   * is what a GenieACS without the panel's VirtualParameter scripts does for
   * every device in the fleet.
   */
  static resolvePppoeUsername(item, virtualParams) {
    const configured = this.getParameterValue(item, virtualParams.vpPppoeUsername);
    if (this.hasReportedValue(configured)) {
      return { value: configured, path: virtualParams.vpPppoeUsername };
    }
    const found = findPppoeUsername(item, (node) => this.readNodeValue(node));
    return found || { value: null, path: virtualParams.vpPppoeUsername };
  }

  /**
   * The optical RX power in dBm, and where it was read. Same order as the
   * login: the configured VirtualParameter first, and its value untouched —
   * only a vendor reading has to be normalized, because only there does the
   * panel not know what unit it asked for.
   *
   * `learnedPaths` are the paths this installation was seen to publish the
   * reading at (see `ensureRxPowerPaths`). They are tried before the
   * catalogue because they are known to be right for this fleet rather than
   * for some fleet.
   */
  static resolveRxPower(item, virtualParams, learnedPaths = []) {
    const configured = this.getParameterValue(item, virtualParams.vpRxPower);
    if (this.hasReportedValue(configured)) {
      return { value: configured, path: virtualParams.vpRxPower };
    }
    for (const path of [...learnedPaths, ...RX_POWER_FALLBACK_PATHS]) {
      if (!path) continue;
      const normalized = normalizeRxPowerReading(this.getParameterValue(item, path));
      if (normalized !== null) return { value: normalized, path };
    }
    // Nothing the panel could name; fall back to reading the document for
    // anything that calls itself an RX power. Only the detail page and the
    // discovery probe project enough of the tree for this to find something.
    const scanned = findRxPowerReading(item, (node) => this.readNodeValue(node));
    if (scanned) return scanned;
    return { value: null, path: virtualParams.vpRxPower };
  }

  static normalizeParameterValue(value) {
    if (value === null || value === undefined) return null;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[1] === 'string' &&
      /^(?:xsd:|xs:)/i.test(value[1])
    ) {
      return this.normalizeParameterValue(value[0]);
    }
    // GenieACS returns metadata-only nodes such as {_object, _writable} when a
    // projected parameter has no current value. These are not display values.
    if (typeof value === 'object') return null;
    return value;
  }

  static isEnabledValue(value) {
    const normalized = this.normalizeParameterValue(value);
    if (normalized === true || normalized === 1) return true;
    if (typeof normalized !== 'string') return false;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(
      normalized.trim().toLowerCase()
    );
  }

  /**
   * Parameters, besides `Enable`, that say whether a WLAN instance is on.
   * Some ONTs (Nokia among them) leave `Enable` unfetched while `Status` or
   * `RadioEnabled` are known; without them the panel shows every SSID as
   * "unknown state".
   */
  static WLAN_STATE_FIELDS = Object.freeze(['Enable', 'RadioEnabled', 'Status']);

  /**
   * On, off, or `null` when nothing the ONT reported says. `Enable` wins;
   * `Status` counts only when it is one of the TR-098 values that decide it
   * ("Up" / "Disabled"), since "Error" says nothing about the setting.
   */
  static resolveWlanEnabled(getValue, index) {
    const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}`;
    for (const field of ['Enable', 'RadioEnabled']) {
      const value = getValue(`${base}.${field}`);
      if (this.hasReportedValue(value)) return this.isEnabledValue(value);
    }
    const status = getValue(`${base}.Status`);
    if (typeof status !== 'string') return null;
    const normalized = status.trim().toLowerCase();
    if (normalized === 'up') return true;
    if (normalized === 'disabled') return false;
    return null;
  }

  static resolveParameterPath(basePath, configuredPath) {
    if (!configuredPath) return null;
    if (
      configuredPath.startsWith('InternetGatewayDevice.') ||
      configuredPath.startsWith('Device.') ||
      configuredPath.startsWith('VirtualParameters.')
    ) {
      return configuredPath;
    }
    return `${basePath}.${configuredPath.replace(/^\.+/, '')}`;
  }

  static findWanParameter(item, basePath, configuredPath, candidates = []) {
    const requested = [configuredPath, ...candidates].filter(Boolean);
    const unique = [...new Set(requested)];
    for (const parameterPath of unique) {
      const fullPath = this.resolveParameterPath(basePath, parameterPath);
      const node = this.getParameterNode(item, fullPath);
      if (node === null) continue;
      const writableValue = node && typeof node === 'object'
        ? this.normalizeParameterValue(node._writable)
        : null;
      return {
        path: fullPath,
        node,
        value: this.getParameterValue(item, fullPath),
        writable: writableValue !== false && writableValue !== 0
      };
    }
    return null;
  }

  /**
   * A URL configurada, para quem precisa exibi-la ou compará-la.
   *
   * Continua aqui porque a tela de configurações e o botão de testar conexão
   * perguntam por ela; o que saiu foi a construção de destino, que agora é do
   * conector. Este serviço não monta mais URL nenhuma — ver o comentário em
   * `services/genieacs/connector.js`.
   */
  static async getGenieAcsUrl() {
    return (await connectorFor()).baseUrl();
  }

  static async getGenieAcsRootUrl() {
    return (await connectorFor()).rootUrl();
  }

  static async getVirtualParameters() {
    const settings = await Setting.getAll();

    return Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS)
        .filter((key) => key.startsWith('vp'))
        .map((key) => [key, settings[key] ?? DEFAULT_SETTINGS[key]])
    );
  }

  /**
   * Mantida porque `settingsController` a usa para comparar origens no teste de
   * conexão. Não monta destino: pede a raiz ao conector e acrescenta a coleção.
   */
  static async getDevicesBaseUrl() {
    return `${await this.getGenieAcsRootUrl()}/devices`;
  }

  /**
   * The failure a GenieACS response should be reported as.
   *
   * The upstream body never reaches the caller. It is written by whatever host
   * answers at the configured URL, so relaying it turns any failed request into
   * a read oracle: point the base URL at an internal service and the panel
   * hands its response straight back over the API. The status stays, because an
   * operator has to tell a misconfiguration from an outage, and the body is
   * logged here, truncated, where only the server can see it.
   *
   * A 3xx is called out on its own: `GenieAcsEgress` never follows a redirect,
   * which is what `redirect: 'manual'` at the call sites asks for, so one
   * arrives as a not-ok response and would otherwise read as an upstream bug
   * rather than as what it is — an allowed host trying to walk the request
   * somewhere we never agreed to reach.
   *
   * `knownBody` is for the one caller that already consumed the body; a second
   * read of it yields nothing.
   */
  static async genieAcsError(label, response, knownBody = undefined) {
    const body = knownBody === undefined
      ? await response.text().catch(() => '')
      : knownBody;
    if (body) {
      console.error(`${label} failed with status ${response.status}: ${String(body).slice(0, 200)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      return new Error(
        `${label} answered with a redirect (status: ${response.status}); the configured GenieACS URL must serve the request itself`
      );
    }
    return new Error(`${label} responded with status: ${response.status}`);
  }

  static async fetchGenieAcsCollection(collection, query = {}, method = 'GET', body = null, timeoutMs = 15_000) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) {
      throw new Error('Invalid GenieACS collection name');
    }
    const connector = await connectorFor();
    const response = await connector.request(
      connector.collectionPath(collection),
      { query, method, body, timeoutMs }
    );
    if (!response.ok) {
      throw await this.genieAcsError(`GenieACS ${collection} API`, response);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * O caminho de um recurso DENTRO da coleção de dispositivos.
   *
   * Substitui `buildGenieAcsUrl`, e a diferença é o que a Fase 4 pede: aquela
   * devolvia uma URL — host e tudo —, esta devolve um caminho relativo que o
   * conector resolve. Este serviço não escolhe mais destino nenhum, e é por
   * isso que um modo novo (agente, túnel) não precisa tocar em nada aqui.
   *
   * A barra inicial é retirada porque quem monta o caminho às vezes a inclui;
   * deixá-la faria o conector receber algo que parece absoluto.
   */
  static devicePath(endpoint = '') {
    const trecho = String(endpoint ?? '').replace(/^\/+/, '');
    // Um caminho não carrega busca nem fragmento: quem tem parâmetros passa
    // `query`, que o conector codifica. A recusa é aqui porque a forma antiga
    // (`?projection=...` como endpoint) concatenava sem erro nenhum e o
    // destino saía `/devices/?projection=...` — a barra a mais muda a rota da
    // NBI, e nada no caminho até o socket teria reclamado.
    if (/[?#]/.test(trecho)) {
      throw new Error('GenieACS device path must not carry a query string');
    }
    return trecho ? `devices/${trecho}` : 'devices';
  }

  static async fetchFromGenieAcs(endpoint, query = {}, method = 'GET', body = null, { timeoutMs } = {}) {
    try {
      const connector = await connectorFor();
      const response = await connector.request(this.devicePath(endpoint), {
        query, method, body, ...(timeoutMs ? { timeoutMs } : {})
      });
      if (!response.ok) {
        throw await this.genieAcsError('GenieACS API', response);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      // O log fica; o `catch` existe por ele. Sem o log, este bloco seria um
      // relançamento puro — e o prazo, que era o outro motivo de ele existir,
      // agora é fechado pelo conector.
      console.error('Error fetching from GenieACS:', error);
      throw error;
    }
  }

  /** Full device document, the shape the vendor-aware writers need. */
  static async fetchDeviceDocument(deviceId) {
    const rawDeviceData = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId })
    });
    if (!Array.isArray(rawDeviceData) || rawDeviceData.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }
    return rawDeviceData[0];
  }

  static ONLINE_WINDOW_MS = 10 * 60 * 1000;

  /** Past this, a silent ONT is equipment gone rather than an outage. */
  static STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

  static DEVICE_PAGE_SIZE_DEFAULT = 25;

  static DEVICE_PAGE_SIZE_MAX = 100;

  static DEVICE_SEARCH_MAX_LENGTH = 128;

  /** A janela do "novos em 24h" do painel, e por isso a mesma constante dele. */
  static NEW_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

  /**
   * Os recortes que o painel aponta — UM parâmetro, vocabulário fechado.
   *
   * Cada valor daqui é um número que o painel mostra, e por isso é um número
   * que o operador pode conferir: ele clica em "4 quentes" e conta quatro
   * linhas. Quatro eixos combináveis dariam `hot` + `many-clients` numa mesma
   * URL, e a contagem dessa lista não aparece em tela nenhuma — filtro que
   * ninguém consegue conferir é como o painel já mentiu antes.
   *
   * `new24h` é o único que o GenieACS resolve sozinho (`_registered` é campo
   * dele); os outros três saem de parâmetros TR-069 que cada fabricante põe
   * num caminho diferente, e a lista já os normaliza de um jeito que uma
   * consulta ao NBI não tem como repetir.
   */
  static DEVICE_FOCUS_FILTERS = ['new24h', 'weak-signal', 'hot', 'many-clients'];

  /**
   * Every listing parameter arrives from the browser, so each one is coerced and
   * clamped here instead of being trusted. `page` is only bounded from below:
   * the real upper bound depends on the total, which is known further down.
   */
  static normalizeDeviceListQuery(query = {}) {
    const rawPage = Number.parseInt(String(query.page ?? ''), 10);
    const rawPageSize = Number.parseInt(String(query.pageSize ?? ''), 10);
    const rawStatus = String(query.status ?? 'all').trim().toLowerCase();
    const rawFocus = String(query.focus ?? 'all').trim().toLowerCase();

    return {
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
      pageSize: Number.isFinite(rawPageSize) && rawPageSize > 0
        ? Math.min(rawPageSize, this.DEVICE_PAGE_SIZE_MAX)
        : this.DEVICE_PAGE_SIZE_DEFAULT,
      search: String(query.search ?? '').trim().slice(0, this.DEVICE_SEARCH_MAX_LENGTH),
      status: ['online', 'offline', 'stale'].includes(rawStatus) ? rawStatus : 'all',
      focus: this.DEVICE_FOCUS_FILTERS.includes(rawFocus) ? rawFocus : 'all'
    };
  }

  static buildDeviceListProjection(
    virtualParams,
    learnedRxPaths = [],
    learnedPppoePaths = [],
    learnedTemperaturePaths = []
  ) {
    return [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._SerialNumber',
      '_deviceId._Manufacturer',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      virtualParams.vpPppoeUsername,
      virtualParams.vpWanBridge,
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      // GenieACS returns only what a projection names, so the fallbacks have
      // to be asked for even when the VirtualParameters do answer — whether
      // they did is only known once the response is in hand.
      ...PPPOE_FALLBACK_PATHS,
      ...learnedPppoePaths,
      ...RX_POWER_FALLBACK_PATHS,
      ...learnedRxPaths,
      ...TEMPERATURE_FALLBACK_PATHS,
      ...learnedTemperaturePaths,
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
      '_lastInform',
      '_registered'
    ].filter(Boolean);
  }

  /**
   * Online/offline is purely a `_lastInform` comparison, and GenieACS owns that
   * field, so the whole status filter can be evaluated by the NBI. The window
   * moves with wall-clock time, hence the cutoff is recomputed per request.
   */
  static buildDeviceStatusQuery(status, now = Date.now()) {
    // `stale`: silent long enough that it is no outage but equipment gone —
    // swapped, unplugged for good, or taken away. Same window as the SGP
    // overview's "active contract, ONT silent" list.
    if (status === 'stale') {
      return { _lastInform: { $lt: new Date(now - this.STALE_AFTER_MS).toISOString() } };
    }
    if (status !== 'online' && status !== 'offline') return null;
    const cutoff = new Date(now - this.ONLINE_WINDOW_MS).toISOString();
    return status === 'online'
      ? { _lastInform: { $gte: cutoff } }
      : { _lastInform: { $lt: cutoff } };
  }

  /**
   * A consulta que o GenieACS resolve: janela de inform e janela de cadastro.
   *
   * Duas condições sobre campos que são DELE, então as duas descem juntas e a
   * paginação continua no NBI. O teto do cadastro não é enfeite: o painel conta
   * `agora - cadastro >= 0`, e um ACS com o relógio adiantado grava data no
   * futuro. Sem o `$lte` a lista traria linhas que o número não contou.
   */
  static buildDeviceListQuery(status, focus, now = Date.now()) {
    const query = { ...(this.buildDeviceStatusQuery(status, now) || {}) };
    if (focus === 'new24h') {
      query._registered = {
        $gte: new Date(now - this.NEW_DEVICE_WINDOW_MS).toISOString(),
        $lte: new Date(now).toISOString()
      };
    }
    return Object.keys(query).length > 0 ? query : null;
  }

  /**
   * Se o recorte precisa da passagem local — a mesma que a busca já faz.
   *
   * RX, temperatura e clientes vêm de parâmetros TR-069 que o painel resolve
   * com caminho configurado, catálogo de alternativas e caminho APRENDIDO
   * desta instalação, normalizando a leitura no meio do caminho. Mandar isso
   * para o NBI seria reescrever essa resolução em sintaxe de consulta, sobre
   * valores cujo tipo o GenieACS guardou como o aparelho mandou.
   */
  static focusNeedsLocalPass(focus) {
    return focus !== 'all' && focus !== 'new24h';
  }

  /** Se o aparelho está no recorte pedido, pelas faixas que o painel conta. */
  static deviceMatchesFocus(device, focus) {
    if (focus === 'weak-signal') {
      const faixa = this.rxBucket(device?.rxpower);
      return faixa === 'Poor' || faixa === 'Danger';
    }
    if (focus === 'hot') return this.temperatureBucket(device?.temperature) === 'Hot';
    if (focus === 'many-clients') return this.clientBucket(device?.activedevices) === '16+';
    // `new24h` já veio recortado pela consulta, e qualquer outro valor virou
    // 'all' na normalização — nenhum dos dois tem o que decidir aqui.
    return true;
  }

  static isDeviceOnline(device, now = Date.now()) {
    const lastInform = device?._lastInform ? new Date(device._lastInform).getTime() : Number.NaN;
    const ageMs = now - lastInform;
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < this.ONLINE_WINDOW_MS;
  }

  /**
   * As faixas que o painel CONTA e que a lista RECORTA — escritas uma vez só.
   *
   * Os números do painel viraram links, e o que torna um desses links honesto
   * não é o filtro existir: é a lista devolver exatamente as linhas que o
   * número contou. Dois limiares iguais em dois arquivos concordam no dia em
   * que são escritos e divergem na primeira vez que alguém mexe num deles — e
   * o sintoma é o pior que este painel tem: o operador clica em "7 com sinal
   * fraco", conta 6 linhas, e conclui que o número mente.
   *
   * As chaves devolvidas são as do payload do painel (`Excellent`, `Hot`,
   * `16+`, …), porque o frontend traduz a faixa pelo nome dela.
   *
   * Leitura ausente é `Unknown` nas três, e `hasReportedValue` é quem decide —
   * o mesmo predicado que o resto do serviço usa. Sem ele, `Number('')` é zero:
   * uma temperatura vazia virava `Normal` e um RX vazio virava `Excellent`,
   * isto é, o painel afirmava saúde sobre um aparelho que não respondeu nada.
   */
  static rxBucket(value) {
    const rx = Number(value);
    if (!this.hasReportedValue(value) || !Number.isFinite(rx)) return 'Unknown';
    if (rx >= -21.99) return 'Excellent';
    if (rx >= -24.99) return 'Good';
    if (rx >= -26.99) return 'Poor';
    return 'Danger';
  }

  static temperatureBucket(value) {
    const temperature = Number(value);
    if (!this.hasReportedValue(value) || !Number.isFinite(temperature)) return 'Unknown';
    if (temperature < 50) return 'Normal';
    if (temperature < 70) return 'Warm';
    return 'Hot';
  }

  static clientBucket(value) {
    const clients = Number(value);
    if (!this.hasReportedValue(value) || !Number.isFinite(clients)) return 'Unknown';
    if (clients <= 0) return '0';
    if (clients <= 5) return '1–5';
    if (clients <= 15) return '6–15';
    return '16+';
  }

  static async fetchGenieAcsWithHeaders(query = {}) {
    const connector = await connectorFor();
    const response = await connector.request(this.devicePath(''), { query });
    if (!response.ok) {
      throw await this.genieAcsError('GenieACS API', response);
    }
    // A `Response` acompanha o corpo porque quem chama lê o header `total` dela:
    // é o único ponto do serviço que precisa de mais do que o JSON.
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : null };
  }

  /**
   * The NBI reports the unpaged match count in a `total` response header. Older
   * or proxied deployments may drop it, so fall back to an `_id`-only scan,
   * which still keeps the payload tiny compared with a full projection.
   */
  static async countDevicesFromGenieAcs(queryParam) {
    const baseQuery = queryParam ? { query: queryParam } : {};
    const { response, data } = await this.fetchGenieAcsWithHeaders({
      ...baseQuery,
      projection: '_id',
      limit: 1
    });
    const rawTotal = response.headers.get('total');
    const reported = rawTotal === null || rawTotal.trim() === '' ? Number.NaN : Number(rawTotal);
    if (Number.isInteger(reported) && reported >= 0) return reported;
    if (Array.isArray(data) && data.length === 0) return 0;

    const all = await this.fetchFromGenieAcs('', { ...baseQuery, projection: '_id' });
    return Array.isArray(all) ? all.length : 0;
  }

  /**
   * Where this GenieACS was seen to publish the PPPoE login outside the
   * catalogue in `PPPOE_FALLBACK_PATHS`.
   *
   * The catalogue names WAN connections 1–2 because a listing cannot project
   * whole WAN subtrees for every row. An ONT whose Internet service sits on a
   * higher index — ZTE's F-series puts TR-069, VoIP and Internet on separate
   * connection objects — read "Não informado" everywhere, and with no login
   * the SGP link never formed. The path is found once, on one device's full
   * tree, and from then on the listing and the fleet sync ask for it by name.
   */
  static PPPOE_PATH_KEY = 'pppoe_path';

  /** Same bound as the RX paths, for the same reason. */
  static PPPOE_PATH_LIMIT = 4;

  static async readPppoePaths() {
    try {
      const raw = await AppState.get(this.PPPOE_PATH_KEY);
      if (!raw) return [];
      const paths = JSON.parse(raw)?.paths;
      return Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path) : [];
    } catch {
      return [];
    }
  }

  /** Files a login path the catalogue does not already ask for. Never throws. */
  static async rememberPppoePath(path) {
    if (!path || PPPOE_FALLBACK_PATHS.includes(path)) return;
    try {
      const known = await this.readPppoePaths();
      if (known.includes(path)) return;
      await AppState.upsert(
        this.PPPOE_PATH_KEY,
        JSON.stringify({ paths: [path, ...known].slice(0, this.PPPOE_PATH_LIMIT) })
      );
    } catch (error) {
      console.warn(`Unable to record the PPPoE login path: ${error.message}`);
    }
  }

  /**
   * Where this GenieACS was seen to publish optical RX, kept per provider
   * because two providers run two fleets.
   *
   * Stored as `{ paths, checkedAt }`. A set rather than one path because an
   * ISP's fleet is rarely one vendor, and each vendor named its own object;
   * `checkedAt` with an empty set records a probe that found nothing, so a
   * fleet that reports no optical at all is not probed again on every page.
   */
  static RX_POWER_PATH_KEY = 'rx_power_path';

  /** How long a fruitless probe is trusted before the fleet is asked again. */
  static RX_POWER_REPROBE_MS = 30 * 60 * 1000;

  /** Device documents to sample when probing. Offline ONTs report nothing. */
  static RX_POWER_PROBE_SAMPLE = 5;

  /**
   * Enough for a mixed fleet, few enough that a GenieACS that renames the
   * object every firmware cannot grow the listing's projection without end.
   */
  static RX_POWER_PATH_LIMIT = 4;

  static async readRxPowerState() {
    try {
      const raw = await AppState.get(this.RX_POWER_PATH_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      const paths = Array.isArray(state?.paths)
        ? state.paths.filter((path) => typeof path === 'string' && path)
        : [];
      return {
        paths,
        checkedAt: Number(state?.checkedAt) || 0,
        eagerUntil: Number(state?.eagerUntil) || 0
      };
    } catch {
      return null;
    }
  }

  static async writeRxPowerState(paths, extra = {}) {
    try {
      await AppState.upsert(
        this.RX_POWER_PATH_KEY,
        JSON.stringify({ paths, checkedAt: Date.now(), ...extra })
      );
    } catch (error) {
      // Losing the note only costs another probe later; it must never cost
      // the operator the page they asked for.
      console.warn(`Unable to record the optical RX paths: ${error.message}`);
    }
  }

  /** Files a newly seen path, newest first, without growing without bound. */
  static async rememberRxPowerPath(path, state = null) {
    const known = (state ?? await this.readRxPowerState())?.paths ?? [];
    if (known.includes(path)) return known;
    const paths = [path, ...known].slice(0, this.RX_POWER_PATH_LIMIT);
    await this.writeRxPowerState(paths);
    return paths;
  }

  /**
   * The paths this installation publishes optical RX at, probing for them
   * once if the panel does not know yet.
   *
   * The listing cannot simply scan for the reading the way the detail page
   * does: GenieACS returns only what a projection names, and projecting whole
   * WAN subtrees for every row of every page to find one number is not a
   * trade worth making. So the shape of the fleet is learned from a handful
   * of documents, once, and from then on the listing asks for those paths by
   * name and pays nothing.
   *
   * Never throws. A fleet whose optical path cannot be discovered is a column
   * reading N/A, which is what it already reads; it is not a broken listing.
   */
  static async ensureRxPowerPaths() {
    const state = await this.readRxPowerState();
    if (state?.paths.length) return state.paths;
    const eager = state ? Date.now() < state.eagerUntil : false;
    if (state && !eager && Date.now() - state.checkedAt < this.RX_POWER_REPROBE_MS) return [];

    const found = [];
    try {
      const rows = await this.fetchDeviceListPage(
        null,
        ['_id', 'InternetGatewayDevice.WANDevice', 'Device.Optical', ...VENDOR_OPTICAL_OBJECTS],
        { limit: this.RX_POWER_PROBE_SAMPLE }
      );
      for (const row of rows) {
        const reading = findRxPowerReading(row, (node) => this.readNodeValue(node));
        if (reading && !found.includes(reading.path)) found.push(reading.path);
      }
      await this.writeRxPowerState(
        found.slice(0, this.RX_POWER_PATH_LIMIT),
        // A summon's refresh only lands when the ONT next informs, which is
        // usually after the page the operator is looking at has already
        // loaded. Dropping the window on the first probe that came back empty
        // would put the answer back behind the half-hour cooldown.
        found.length === 0 && state?.eagerUntil ? { eagerUntil: state.eagerUntil } : {}
      );
    } catch (error) {
      console.warn(`Unable to probe for the optical RX paths: ${error.message}`);
    }
    return found;
  }

  static async fetchDeviceListPage(queryParam, projection, { skip, limit } = {}) {
    const data = await this.fetchFromGenieAcs('', {
      ...(queryParam ? { query: queryParam } : {}),
      projection: projection.join(','),
      ...(Number.isInteger(skip) ? { skip } : {}),
      ...(Number.isInteger(limit) ? { limit } : {})
    });
    if (!Array.isArray(data)) {
      throw new Error('Invalid API response');
    }
    return data;
  }

  /**
   * Minúsculas e sem acento: quem procura "Antônia" digita "antonia", e o SGP
   * guarda o nome em maiúsculas, com ou sem acento, conforme quem cadastrou.
   */
  static normalizeSearchText(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  static deviceMatchesSearch(device, needle) {
    if (!needle) return true;
    const alvo = this.normalizeSearchText(needle);
    return [
      device._id,
      device.SerialNumber,
      device.productclass,
      device.manufacturer,
      device.pppoe,
      device.customerId,
      // O assinante do SGP: é pelo nome que o atendente procura quem ligou.
      device.sgpClientName,
      device.sgpContract
    ].some((field) => this.normalizeSearchText(field).includes(alvo));
  }

  /**
   * Returns one page of the inventory plus the paging metadata the UI needs.
   * Paging is pushed to GenieACS whenever nothing has to be filtered locally;
   * a free-text search always matches against the panel's own Customer IDs, so
   * that path fetches the (status-filtered) match set and pages it here.
   *
   * Um recorte de RX, temperatura ou clientes toma o mesmo caminho da busca, e
   * pelo mesmo motivo: quem sabe a resposta é o painel, não o NBI. O custo é o
   * mesmo que a busca já paga — uma leitura da frota por página — e é o preço
   * de a contagem bater com o número que mandou o operador para cá.
   */
  static async getDevicesPage(options = {}) {
    const { page, pageSize, search, status, focus } = this.normalizeDeviceListQuery(options);
    const virtualParams = await this.getVirtualParameters();
    const learnedRxPaths = await this.ensureRxPowerPaths();
    const learnedTemperaturePaths = await this.readTemperaturePaths();
    const projection = this.buildDeviceListProjection(
      virtualParams,
      learnedRxPaths,
      await this.readPppoePaths(),
      learnedTemperaturePaths
    );
    const listQuery = this.buildDeviceListQuery(status, focus);
    const queryParam = listQuery ? JSON.stringify(listQuery) : null;
    const passagemLocal = Boolean(search) || this.focusNeedsLocalPass(focus);

    if (!passagemLocal) {
      const total = await this.countDevicesFromGenieAcs(queryParam);
      const totalPages = Math.ceil(total / pageSize);
      const currentPage = totalPages > 0 ? Math.min(page, totalPages) : 1;
      // The listing has always been shown newest-first, i.e. the natural
      // GenieACS order reversed. Mapping the page onto a skip/limit taken from
      // the tail keeps that order without asking the NBI to sort.
      const end = total - (currentPage - 1) * pageSize;
      const skip = Math.max(0, end - pageSize);
      const limit = Math.max(0, end - skip);
      const rows = limit > 0
        ? await this.fetchDeviceListPage(queryParam, projection, { skip, limit })
        : [];
      return {
        devices: rows
          .map((item) => this.processDeviceData(
            item, virtualParams, learnedRxPaths, learnedTemperaturePaths
          ))
          .reverse(),
        page: currentPage,
        pageSize,
        total,
        totalPages
      };
    }

    const rows = await this.fetchDeviceListPage(queryParam, projection);
    let matches = rows
      .map((item) => this.processDeviceData(
        item, virtualParams, learnedRxPaths, learnedTemperaturePaths
      ))
      .reverse()
      .filter((device) => this.deviceMatchesFocus(device, focus));

    if (search) {
      // O Customer ID é do painel, não do GenieACS, e por isso a busca é a
      // única que precisa dele — sobre o que o recorte já deixou passar.
      const ids = matches.map((device) => device._id);
      const [customerIds, sgpLinks] = await Promise.all([
        this.lookupCustomerIds(ids),
        this.lookupSgpLinks(ids)
      ]);
      const needle = search.toLowerCase();
      matches = matches.filter((device) => this.deviceMatchesSearch(
        {
          ...device,
          customerId: customerIds.get(String(device._id)) || null,
          sgpClientName: sgpLinks.get(String(device._id))?.clientName ?? null,
          sgpContract: sgpLinks.get(String(device._id))?.contract ?? null
        },
        needle
      ));
    }

    const total = matches.length;
    const totalPages = Math.ceil(total / pageSize);
    const currentPage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const offset = (currentPage - 1) * pageSize;
    return {
      devices: matches.slice(offset, offset + pageSize),
      page: currentPage,
      pageSize,
      total,
      totalPages
    };
  }

  /**
   * A frota como o ACS a tem — serial, PPPoE e tags de cada equipamento.
   *
   * Para a ferramenta da plataforma que marca equipamentos com a tag de um
   * provedor: quem chama roda dentro de `withoutDeviceScope`, porque o que se
   * procura são justamente os equipamentos que ainda não têm tag.
   */
  static async listFleetIdentity() {
    const virtualParams = await this.getVirtualParameters();
    const learnedRxPaths = (await this.readRxPowerState())?.paths ?? [];
    const learnedTemperaturePaths = await this.readTemperaturePaths();
    const projection = this.buildDeviceListProjection(
      virtualParams,
      learnedRxPaths,
      await this.readPppoePaths(),
      learnedTemperaturePaths
    );
    const rows = await this.fetchDeviceListPage(null, [...projection, '_tags']);
    return rows.map((item) => {
      const device = this.processDeviceData(item, virtualParams, learnedRxPaths, learnedTemperaturePaths);
      return {
        _id: String(item._id),
        serial: String(device.SerialNumber ?? '').trim(),
        pppoe: String(device.pppoe ?? '').trim(),
        tags: Array.isArray(item._tags) ? item._tags.map(String) : []
      };
    });
  }

  /** Quantas linhas a planilha leva, no máximo. Acima disso, a resposta pede um recorte. */
  static DEVICE_EXPORT_MAX = 5000;
  /**
   * Prazo da leitura da frota inteira na sincronização de IDs de cliente. Os
   * 15 s do conector servem a um aparelho; a frota toda, numa rede grande,
   * passa disso e a sincronização caía sempre no mesmo erro genérico.
   */
  static CUSTOMER_IDENTITY_TIMEOUT_MS = 60_000;

  /**
   * O recorte da lista inteiro, sem paginar — o que a planilha leva.
   *
   * Os mesmos filtros e a mesma ordem de `getDevicesPage`, e por isso as mesmas
   * linhas que a tela mostraria página por página. Com uma diferença que é o
   * motivo deste método não chamar aquele: a lista decora cada página com
   * `CustomerService.decorateDevices`, que CRIA a conta do assinante que falta.
   * Aqui não se escreve nada — o ID do cliente vem da leitura de
   * `lookupCustomerIds`, e o aparelho sem conta sai com a coluna vazia.
   *
   * Sem busca e sem recorte local, a contagem do NBI vem antes da leitura: um
   * recorte grande demais é recusado sem trazer a frota.
   */
  static async getDevicesForExport(options = {}) {
    const { search, status, focus } = this.normalizeDeviceListQuery(options);
    const max = this.DEVICE_EXPORT_MAX;
    const grandeDemais = () => new TranslatableError('device.exportTooLarge', { max: String(max) }, {
      status: 413,
      code: 'export_too_large'
    });
    const virtualParams = await this.getVirtualParameters();
    const learnedRxPaths = await this.ensureRxPowerPaths();
    const learnedTemperaturePaths = await this.readTemperaturePaths();
    const projection = this.buildDeviceListProjection(
      virtualParams,
      learnedRxPaths,
      await this.readPppoePaths(),
      learnedTemperaturePaths
    );
    const listQuery = this.buildDeviceListQuery(status, focus);
    const queryParam = listQuery ? JSON.stringify(listQuery) : null;

    if (!search && !this.focusNeedsLocalPass(focus)) {
      if ((await this.countDevicesFromGenieAcs(queryParam)) > max) throw grandeDemais();
    }

    const rows = await this.fetchDeviceListPage(queryParam, projection);
    let matches = rows
      .map((item) => this.processDeviceData(
        item, virtualParams, learnedRxPaths, learnedTemperaturePaths
      ))
      .reverse()
      .filter((device) => this.deviceMatchesFocus(device, focus));
    const customerIds = await this.lookupCustomerIds(matches.map((device) => device._id));
    matches = matches.map((device) => ({ ...device, customerId: customerIds.get(String(device._id)) || null }));
    if (search) {
      // O nome do assinante entra só para filtrar: a planilha continua com as
      // mesmas colunas, e bate linha a linha com o que a tela mostrou.
      const sgpLinks = await this.lookupSgpLinks(matches.map((device) => device._id));
      const needle = search.toLowerCase();
      matches = matches.filter((device) => this.deviceMatchesSearch({
        ...device,
        sgpClientName: sgpLinks.get(String(device._id))?.clientName ?? null,
        sgpContract: sgpLinks.get(String(device._id))?.contract ?? null
      }, needle));
    }
    if (matches.length > max) throw grandeDemais();
    return { devices: matches, filters: { search, status, focus } };
  }

  /**
   * O contrato e o nome do assinante do SGP de cada aparelho, só para a busca.
   * Uma leitura em lotes, do provedor atual (`sgp_links` passa por `tdb`).
   */
  static async lookupSgpLinks(deviceIds) {
    const ids = deviceIds.map((id) => String(id ?? '')).filter(Boolean);
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await SgpLink.getByDeviceIds(ids.slice(offset, offset + 500));
      for (const row of rows) {
        found.set(String(row.device_id), { clientName: row.client_name || null, contract: row.contract || null });
      }
    }
    return found;
  }

  /**
   * Read-only Customer ID lookup used while matching a search term. Account
   * creation stays in CustomerService and is only run over the returned page.
   */
  static async lookupCustomerIds(deviceIds) {
    const ids = deviceIds.map((id) => String(id ?? '')).filter(Boolean);
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await CustomerAccount.getIdsByDeviceIds(ids.slice(offset, offset + 500));
      for (const row of rows) found.set(row.device_id, row.customer_id);
    }
    return found;
  }

  /**
   * A frota como o painel a conta — pelos MESMOS caminhos que a lista lê.
   *
   * Os caminhos aprendidos entram aqui de propósito, e a falta deles era um
   * defeito calado: numa instalação que publica o RX óptico num caminho fora
   * do catálogo, a lista mostrava o valor (ela projeta o aprendido) e o painel
   * contava `Unknown`, porque o que não é projetado não volta. Duas telas, a
   * mesma frota, respostas diferentes — e o painel errava para baixo, isto é,
   * escondia risco óptico. Agora o número e a lista que ele abre leem igual.
   *
   * LÊ o que foi aprendido, e não `ensureRxPowerPaths` — a sonda fica onde ela
   * é paga, que é a listagem. Esta função é o muro de escala do painel: ela
   * busca a coleção inteira, a cada minuto, vezes o número de provedores, e
   * quem a chama é o agendador. Uma segunda requisição de saída aqui é uma
   * requisição por provedor que ninguém pediu. O preço é que uma instalação
   * onde ninguém abriu a lista de equipamentos ainda conta `Unknown` — até a
   * primeira listagem, e não para sempre, que era o estado anterior.
   */
  static async getDashboardDevices() {
    const virtualParams = await this.getVirtualParameters();
    const learnedRxPaths = (await this.readRxPowerState())?.paths ?? [];
    const learnedTemperaturePaths = await this.readTemperaturePaths();
    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._Manufacturer',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      ...RX_POWER_FALLBACK_PATHS,
      ...learnedRxPaths,
      ...TEMPERATURE_FALLBACK_PATHS,
      ...learnedTemperaturePaths,
      '_lastInform',
      '_registered'
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs('', { projection: projection.join(',') });
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS dashboard response');
    }
    return data.map((item) => this.processDeviceData(
      item, virtualParams, learnedRxPaths, learnedTemperaturePaths
    ));
  }

  /**
   * The cheapest whole-fleet telemetry read: four parameters, one request.
   *
   * Deliberately not `fetchGenieAcsWithHeaders` — that exists to read the
   * `total` header for paging, and there is no paging here.
   *
   * `_lastInform` is part of the projection because it is the sample's time
   * axis: GenieACS only refreshes a parameter when the device informs, so the
   * inform is when the reading was actually taken.
   */
  static async getTelemetryFleet() {
    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_lastInform',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      ...RX_POWER_FALLBACK_PATHS,
      ...TEMPERATURE_FALLBACK_PATHS,
      'InternetGatewayDevice.DeviceInfo.UpTime'
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs('', { projection: projection.join(',') });
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS telemetry response');
    }
    return data.map((item) => ({
      deviceId: item._id || null,
      lastInform: item._lastInform ?? null,
      rxPower: this.resolveRxPower(item, virtualParams).value,
      temperature: this.resolveTemperature(item, virtualParams).value,
      uptime: this.getParameterValue(item, 'InternetGatewayDevice.DeviceInfo.UpTime')
    }));
  }

  static processDeviceData(item, virtualParams, learnedRxPaths = [], learnedTemperaturePaths = []) {
    const pppsecret = this.resolvePppoeUsername(item, virtualParams).value;
    const wanbridge = this.getParameterValue(item, virtualParams.vpWanBridge);
    const rxpower = this.resolveRxPower(item, virtualParams, learnedRxPaths).value;
    const gettemp = this.resolveTemperature(item, virtualParams, learnedTemperaturePaths).value;
    const activedevices = this.getParameterValue(item, virtualParams.vpActiveDevices);

    const deviceId = item._id || null;
    const serialNumber = item._deviceId?._SerialNumber || null;
    const typeont = item._deviceId?._ProductClass || null;
    const manufacturer = item._deviceId?._Manufacturer || null;
    const softwareId = this.getParameterValue(
      item,
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion'
    );

    const wlan = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
    const ssid1 = wlan['1']?.SSID?._value ?? null;
    const ssid2 = wlan['2']?.SSID?._value ?? null;
    const ssid3 = wlan['3']?.SSID?._value ?? null;
    const ssid4 = wlan['4']?.SSID?._value ?? null;
    const ssid5 = wlan['5']?.SSID?._value ?? null;
    const ssid6 = wlan['6']?.SSID?._value ?? null;
    const ssid7 = wlan['7']?.SSID?._value ?? null;
    const ssid8 = wlan['8']?.SSID?._value ?? null;

    return {
      _id: deviceId,
      SerialNumber: serialNumber,
      productclass: typeont,
      manufacturer,
      softwareId,
      pppoe: pppsecret,
      wanbridge: wanbridge,
      rxpower: rxpower,
      temperature: gettemp,
      activedevices: activedevices,
      ssid1: ssid1,
      ssid2: ssid2,
      ssid3: ssid3,
      ssid4: ssid4,
      ssid5: ssid5,
      ssid6: ssid6,
      ssid7: ssid7,
      ssid8: ssid8,
      _lastInform: item._lastInform || null,
      _registered: item._registered || null
    };
  }

  static async getDetailDevice(deviceId) {
    if (!deviceId) {
      throw new Error('Device ID is required');
    }

    const virtualParams = await this.getVirtualParameters();
    const vendorConfigurations = await Vendor.getEnabled();

    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._SerialNumber',
      '_deviceId._Manufacturer',
      '_deviceId._OUI',
      virtualParams.vpPppoeUsername,
      virtualParams.vpWanBridge,
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      virtualParams.vpSuperAdmin,
      virtualParams.vpSuperPassword,
      virtualParams.vpUserAdmin,
      virtualParams.vpUserPassword,
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.3.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.4.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.TotalAssociations',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.7.Channel',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Enable',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.RadioEnabled',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Status',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.BeaconType',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.TotalAssociations',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.8.Channel',
        'VirtualParameters.SSID1-Name',
        'VirtualParameters.SSID1-Password',
        'VirtualParameters.SSID1-Security',
        'VirtualParameters.SSID5-Name',
        'VirtualParameters.SSID5-Password',
        'VirtualParameters.SSID5-Security',
        'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
      'InternetGatewayDevice.LANDevice.1.Hosts.Host',
      'Device.Hosts.Host',
      'InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress',
      'InternetGatewayDevice.WANDevice',
      ...VENDOR_OPTICAL_OBJECTS,
      ...TEMPERATURE_FALLBACK_PATHS,
      // `InternetGatewayDevice.WANDevice` above already carries the TR-098
      // fallbacks; these are the TR-181 ones, which sit outside it.
      ...PPPOE_FALLBACK_PATHS.filter((path) => path.startsWith('Device.')),
      ...RX_POWER_FALLBACK_PATHS.filter((path) => path.startsWith('Device.')),
      '_lastInform',
      '_lastBoot',
      '_registered'
    ];

    vendorConfigurations.forEach(vendor => {
      if (vendor.http_wan_enable_path) {
        projection.push(vendor.http_wan_enable_path);
      }
      if (vendor.firewall_level_path) {
        projection.push(vendor.firewall_level_path);
      }
    });

    const data = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: projection.filter(Boolean).join(',')
    });

    if (!Array.isArray(data) || data.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }

    const detail = await this.processDetailDeviceData(data[0], virtualParams);
    // This page projects the whole WAN subtree, so it can find the reading by
    // scanning where the listing can only ask for paths by name. When it does,
    // the listing gets told: opening one ONT teaches the panel the fleet's
    // optical path, which is the fallback for a probe that sampled five
    // devices that happened to have nothing to report.
    await this.noteRxPowerPath(detail.virtualParameters?.rxpower);
    await this.requestUnreadOptics(deviceId, data[0], detail.virtualParameters);
    return detail;
  }

  /**
   * Queues a read of the optical leaves GenieACS knows by name and never read,
   * when the page came out without a signal or a temperature.
   *
   * The same gap the PPPoE login had on the ZTE fleet: a Nokia G-series lists
   * `X_ALU_OntOpticalParam` on its first inform, and nothing ever asks for the
   * values under it, so the page reads N/D until someone does.
   */
  static async requestUnreadOptics(deviceId, item, virtualParameters) {
    const missing = [virtualParameters?.rxpower, virtualParameters?.temperature]
      .some((reading) => reading?.value === null || reading?.value === undefined);
    if (!missing) return;
    const unread = opticalReadingLeaves(item)
      .filter((leaf) => !this.holdsValue(leaf.node))
      .map((leaf) => leaf.path);
    if (unread.length > 0) await this.requestParameterRead(deviceId, 'optics', unread);
  }

  /**
   * Records the path a resolved reading came from, when it is a path the
   * listing could ask GenieACS for. A VirtualParameter is not one of those —
   * the listing already projects it — and neither is a reading that never
   * resolved.
   */
  static async noteRxPowerPath(resolved) {
    const path = resolved?.value === null || resolved?.value === undefined
      ? null
      : resolved?.path;
    if (!path || path.startsWith('VirtualParameters.')) return;
    const state = await this.readRxPowerState();
    if (state?.paths.includes(path)) return;
    await this.rememberRxPowerPath(path, state);
  }

  /**
   * The WAN MAC the ONT's Internet connection uses.
   *
   * The PPPoE connection the login was read from comes first: an ONT with
   * TR-069, VoIP and Internet on separate connections has a MAC on each, and
   * only the Internet one is what the RADIUS — and the SGP — sees. Then the
   * first connection that reports one, then the WAN port itself.
   */
  static resolveWanMacAddress(item, pppoePath = null) {
    const read = (path) => {
      const value = this.getParameterValue(item, path);
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    if (pppoePath && /\.WANPPPConnection\.\d+\.Username$/.test(pppoePath)) {
      const own = read(pppoePath.replace(/\.Username$/, '.MACAddress'));
      if (own) return own;
    }
    const wanDevices = item?.InternetGatewayDevice?.WANDevice;
    for (const [wanKey, wanDevice] of Object.entries(wanDevices || {})) {
      if (!/^\d+$/.test(wanKey)) continue;
      for (const [connKey, connection] of Object.entries(wanDevice?.WANConnectionDevice || {})) {
        if (!/^\d+$/.test(connKey)) continue;
        for (const type of ['WANPPPConnection', 'WANIPConnection']) {
          for (const key of Object.keys(connection?.[type] || {})) {
            if (!/^\d+$/.test(key)) continue;
            const found = read(
              `InternetGatewayDevice.WANDevice.${wanKey}.WANConnectionDevice.${connKey}.${type}.${key}.MACAddress`
            );
            if (found) return found;
          }
        }
      }
    }
    return read('InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.MACAddress');
  }

  /**
   * The optics' temperature, and where it was read: the VirtualParameter
   * first and untouched, then the paths this installation was seen to use,
   * then a scan by name — the same order the RX power is read in.
   */
  static resolveTemperature(item, virtualParams, learnedPaths = []) {
    const configured = this.getParameterValue(item, virtualParams.vpTemperature);
    if (this.hasReportedValue(configured)) {
      return { value: configured, path: virtualParams.vpTemperature };
    }
    const read = (node) => this.readNodeValue(node);
    for (const path of [...learnedPaths, ...TEMPERATURE_FALLBACK_PATHS]) {
      const value = normalizeTemperatureReading(this.getParameterValue(item, path));
      if (value !== null) return { value, path };
    }
    return findTemperatureReading(item, read) || { value: null, path: virtualParams.vpTemperature };
  }

  static TEMPERATURE_PATH_KEY = 'temperature_path';

  static async readTemperaturePaths() {
    try {
      const raw = await AppState.get(this.TEMPERATURE_PATH_KEY);
      const paths = raw ? JSON.parse(raw)?.paths : [];
      return Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path) : [];
    } catch {
      return [];
    }
  }

  /** Files a temperature path the detail page found, for the listing. Never throws. */
  static async rememberTemperaturePath(path) {
    try {
      const known = await this.readTemperaturePaths();
      if (!path || known.includes(path)) return;
      await AppState.upsert(
        this.TEMPERATURE_PATH_KEY,
        JSON.stringify({ paths: [path, ...known].slice(0, 4) })
      );
    } catch (error) {
      console.warn(`Unable to record the temperature path: ${error.message}`);
    }
  }

  /** Every parameter GenieACS holds for one ONT, filtered by `search`. */
  static async listDeviceParameters(deviceId, search = '') {
    const item = await this.fetchDeviceDocument(deviceId);
    return {
      ...listDocumentParameters(item, String(search ?? '').slice(0, 128)),
      lastInform: item._lastInform ?? null
    };
  }

  static async processDetailDeviceData(item, virtualParams) {
    const getValue = (path) => {
      return this.getParameterValue(item, path);
    };

    const getVPValue = getValue;

    const getRelativeNode = (obj, path) => {
      if (!path || !obj) return null;
      const parts = path.split('.');
      let current = obj;
      for (const part of parts) {
        if (current && typeof current === 'object') {
          current = current[part];
        } else {
          return null;
        }
      }
      return current ?? null;
    };

    const getRelativeValue = (obj, path) => {
      const current = getRelativeNode(obj, path);
      if (current && typeof current === 'object' && '_value' in current) {
        return this.normalizeParameterValue(current._value);
      }
      return this.normalizeParameterValue(current);
    };

    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    const vendor = vendorObj ? vendorObj.name.toLowerCase() : 'unknown';
    const vendorId = vendorObj ? vendorObj.id : null;

    const temperature = this.resolveTemperature(item, virtualParams);
    if (temperature.value !== null && temperature.path !== virtualParams.vpTemperature) {
      await this.rememberTemperaturePath(temperature.path);
    }
    const pppoeUsername = this.resolvePppoeUsername(item, virtualParams);
    const lanMacAddress = getValue('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress');
    const wanMacAddress = this.resolveWanMacAddress(item, pppoeUsername.value ? pppoeUsername.path : null);

    const deviceInfo = {
      productclass: productClass,
      serialNumber: item._deviceId?._SerialNumber || null,
      manufacturer: manufacturer,
      oui: item._deviceId?._OUI || null,
      hardwareVersion: getValue('InternetGatewayDevice.DeviceInfo.HardwareVersion'),
      softwareVersion: getValue('InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
      upTime: getValue('InternetGatewayDevice.DeviceInfo.UpTime'),
      macAddress: lanMacAddress || wanMacAddress || null,
      lanMacAddress: lanMacAddress || null,
      // The address the ONT dials from — the one the SGP shows on the PPPoE
      // session, and so the one that ties this ONT to a subscriber there.
      wanMacAddress
    };

    // The detail page projects the whole WAN tree, so it is where an ONT
    // model's login path is most often seen first.
    if (pppoeUsername.value && pppoeUsername.path !== virtualParams.vpPppoeUsername) {
      await this.rememberPppoePath(pppoeUsername.path);
    }

    const virtualParameters = {
      // The path is the one the value was actually read at, not always the
      // configured VirtualParameter: when a fallback answered, this is what
      // tells support where the panel got it.
      pppoeUsername,
      wanBridge: {
        path: virtualParams.vpWanBridge,
        value: getVPValue(virtualParams.vpWanBridge)
      },
      rxpower: this.resolveRxPower(item, virtualParams),
      temperature,
      activedevices: {
        path: virtualParams.vpActiveDevices,
        value: getVPValue(virtualParams.vpActiveDevices)
      },
      superAdmin: {
        path: virtualParams.vpSuperAdmin,
        value: getVPValue(virtualParams.vpSuperAdmin)
      },
      superPassword: {
        path: virtualParams.vpSuperPassword,
        value: getVPValue(virtualParams.vpSuperPassword)
      },
      userAdmin: {
        path: virtualParams.vpUserAdmin,
        value: getVPValue(virtualParams.vpUserAdmin)
      },
      userPassword: {
        path: virtualParams.vpUserPassword,
        value: getVPValue(virtualParams.vpUserPassword)
      }
    };

    const wifi = [];
    const wlanConfig = item.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;

    if (wlanConfig) {
      for (let i = 1; i <= 8; i++) {
        const ssidData = wlanConfig[i];
        if (ssidData && typeof ssidData === 'object' && !String(i).startsWith('_')) {
          const virtualPrefix = i === 1 ? 'SSID1' : i === 5 ? 'SSID5' : null;
          const virtualNamePath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Name` : null;
          const virtualPasswordPath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Password` : null;
          const virtualSecurityPath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Security` : null;
          const hasVirtualMapping = Boolean(
            virtualNamePath && this.getParameterNode(item, virtualNamePath)
          );
          wifi.push({
            index: i,
            enable: this.resolveWlanEnabled(getValue, i),
            ssid: (virtualNamePath ? getValue(virtualNamePath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`),
            password: (virtualPasswordPath ? getValue(virtualPasswordPath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.KeyPassphrase`) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.PreSharedKey`),
            security: (virtualSecurityPath ? getValue(virtualSecurityPath) : null) ??
              getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.BeaconType`),
            channel: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Channel`),
            totalAssociations: getValue(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.TotalAssociations`),
            usesVirtualParameters: hasVirtualMapping
          });
        }
      }
    }
    
    const wan = [];
    const wanContainers = [];
    const wanDevice = item.InternetGatewayDevice?.WANDevice;

    if (wanDevice) {
      for (const devKey in wanDevice) {
        if (devKey.startsWith('_')) continue;
        if (!wanDevice[devKey] || !wanDevice[devKey].WANConnectionDevice) continue;
        
        for (const connKey in wanDevice[devKey].WANConnectionDevice) {
          if (connKey.startsWith('_')) continue;
          const connDev = wanDevice[devKey].WANConnectionDevice[connKey];
          if (!connDev) continue;
          wanContainers.push({
            path: `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}`,
            label: `WAN ${devKey} / connection device ${connKey}`
          });

          const connections = [];
          for (const [collection, connType, indexType] of [
            ['WANIPConnection', 'IP', 'ip'],
            ['WANPPPConnection', 'PPPoE', 'ppp']
          ]) {
            const connectionCollection = connDev[collection];
            if (!connectionCollection) continue;
            for (const instanceKey in connectionCollection) {
              if (instanceKey.startsWith('_') || !connectionCollection[instanceKey]) continue;
              connections.push({
                connection: connectionCollection[instanceKey],
                connType,
                index: `${devKey}.${connKey}.${indexType}.${instanceKey}`,
                connPath: `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.${collection}.${instanceKey}`
              });
            }
          }

          for (const { connection, connType, connPath, index } of connections) {
            
            // The catalogue first; then by name, which is how a Nokia's
            // `X_ALU-COM_…` VLAN — or any prefix nobody listed — is found.
            const vlanParameter = this.findWanParameter(
              item,
              connPath,
              vendorObj?.vlan_id_path,
              WAN_PARAMETER_CANDIDATES.vlan
            ) || this.findWanParameter(
              item,
              connPath,
              findWanParameterByName(item, connPath, WAN_VLAN_NAMES)
            );
            const serviceParameter = this.findWanParameter(
              item,
              connPath,
              vendorObj?.service_list_path,
              WAN_PARAMETER_CANDIDATES.serviceList
            ) || this.findWanParameter(
              item,
              connPath,
              findWanParameterByName(item, connPath, WAN_SERVICE_NAMES)
            );
            const nameParameter = this.findWanParameter(item, connPath, 'Name');
            const usernameParameter = this.findWanParameter(item, connPath, 'Username');
            const passwordParameter = this.findWanParameter(item, connPath, 'Password');
            const connectionTypeParameter = this.findWanParameter(item, connPath, 'ConnectionType');
            const natParameter = this.findWanParameter(item, connPath, 'NATEnabled');

            let bindings = null;
            const bindingParameter = this.findWanParameter(
              item,
              connPath,
              vendorObj?.lan_binding_path,
              WAN_PARAMETER_CANDIDATES.bindings
            );
            if (bindingParameter) {
              const bindingObj = bindingParameter.node;
              if (bindingObj && typeof bindingObj === 'object') {
                bindings = { lan: [], ssid: [] };
                for (let i = 1; i <= 4; i++) {
                  if (this.isEnabledValue(getRelativeValue(bindingObj, `Lan${i}Enable`))) {
                    bindings.lan.push(`LAN${i}`);
                  }
                }
                for (let i = 1; i <= 8; i++) {
                  if (this.isEnabledValue(getRelativeValue(bindingObj, `SSID${i}Enable`))) {
                    bindings.ssid.push(`SSID${i}`);
                  }
                }
              }
            }
            const bindingConfigurable = bindingParameter
              ? [...Array(4)].some((_, offset) => Boolean(
                  this.findWanParameter(item, bindingParameter.path, `Lan${offset + 1}Enable`)?.writable
                )) || [...Array(8)].some((_, offset) => Boolean(
                  this.findWanParameter(item, bindingParameter.path, `SSID${offset + 1}Enable`)?.writable
                ))
              : false;

            wan.push({
              index,
              connType: connType,
              name: nameParameter?.value ?? null,
              status: getValue(`${connPath}.ConnectionStatus`),
              ipAddress: getValue(`${connPath}.ExternalIPAddress`),
              macAddress: getValue(`InternetGatewayDevice.WANDevice.${devKey}.WANEthernetInterfaceConfig.MACAddress`),
              vlanId: vlanParameter?.value ?? null,
              username: usernameParameter?.value ?? null,
              serviceList: serviceParameter?.value ?? null,
              connectionType: connectionTypeParameter?.value ?? null,
              natEnabled: natParameter?.value ?? null,
              bindings,
              editable: connType === 'PPPoE',
              nameConfigurable: Boolean(nameParameter?.writable),
              usernameConfigurable: Boolean(usernameParameter?.writable),
              passwordConfigurable: Boolean(passwordParameter?.writable),
              vlanConfigurable: Boolean(vlanParameter?.writable),
              serviceListConfigurable: Boolean(serviceParameter?.writable),
              connectionTypeConfigurable: Boolean(connectionTypeParameter?.writable),
              natConfigurable: Boolean(natParameter?.writable),
              bindingsConfigurable: bindingConfigurable
            });
          }
        }
      }
    }

    const clients = [];
    const seenClients = new Set();
    const collectHosts = (hostCollection, dataModel) => {
      if (!hostCollection || typeof hostCollection !== 'object') return;
      for (const [instance, host] of Object.entries(hostCollection)) {
        if (instance.startsWith('_') || !host || typeof host !== 'object') continue;
        const value = (key) => getRelativeValue(host, key);
        const macAddress = value('MACAddress') || value('PhysAddress');
        const ipAddress = value('IPAddress');
        const hostName = value('HostName');
        const identity = String(macAddress || `${dataModel}:${instance}:${ipAddress || hostName || ''}`).toUpperCase();
        if (seenClients.has(identity)) continue;
        seenClients.add(identity);
        const activeValue = value('Active');
        clients.push({
          instance: String(instance),
          dataModel,
          hostName,
          ipAddress,
          macAddress,
          interfaceType: value('InterfaceType') || value('Layer2Interface'),
          addressSource: value('AddressSource'),
          leaseTimeRemaining: value('LeaseTimeRemaining'),
          active: activeValue === null ? null : this.isEnabledValue(activeValue)
        });
      }
    };
    collectHosts(item.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host, 'TR-098');
    collectHosts(item.Device?.Hosts?.Host, 'TR-181');
    clients.sort((left, right) => Number(right.active === true) - Number(left.active === true));

    return {
      _id: item._id,
      _lastInform: item._lastInform,
      _lastBoot: item._lastBoot,
      _registered: item._registered,
      vendor: vendor,
      deviceInfo,
      virtualParameters,
      wifi, 
      wan,
      wanContainers,
      clients,
      vendorDetection: {
        vendor: vendor,
        vendorId: vendorId,
        vendorName: vendorObj?.name || 'Unknown',
        parameterPrefix: vendorObj?.parameter_prefix || null
      }
    };
  }

  static async getCustomerIdentityDevices() {
    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_lastInform',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      virtualParams.vpPppoeUsername,
      // Same reason the listing projects them: an install whose
      // VirtualParameters were never written answers with nothing, and the
      // login was in the ONT's own tree the whole time.
      ...PPPOE_FALLBACK_PATHS,
      ...await this.readPppoePaths()
    ].filter(Boolean);
    // A frota inteira numa resposta: com milhares de ONTs, os 15 s padrão do
    // conector não bastam e a sincronização de IDs morria com "aborted".
    const data = await this.fetchFromGenieAcs('', { projection: projection.join(',') }, 'GET', null, {
      timeoutMs: this.CUSTOMER_IDENTITY_TIMEOUT_MS
    });
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS customer identity response');
    }
    return data.map((item) => ({
      _id: item._id || null,
      _lastInform: item._lastInform || null,
      softwareId: this.getParameterValue(
        item,
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion'
      ),
      pppoe: this.resolvePppoeUsername(item, virtualParams).value
    }));
  }

  /**
   * A frota do jeito que o mapa da rede precisa: login PPPoE, se está online
   * e o sinal óptico de cada equipamento — nada mais. É o que pinta os pontos
   * da Topologia que têm PPPoE cadastrado.
   *
   * Uma consulta só, com projeção, como a telemetria; o prazo é o mesmo da
   * sincronização de IDs, porque é a frota inteira numa resposta.
   */
  static async getMapStatusFleet() {
    const virtualParams = await this.getVirtualParameters();
    const learnedRxPaths = (await this.readRxPowerState())?.paths ?? [];
    const projection = [
      '_id',
      '_lastInform',
      virtualParams.vpPppoeUsername,
      virtualParams.vpRxPower,
      ...PPPOE_FALLBACK_PATHS,
      ...await this.readPppoePaths(),
      ...RX_POWER_FALLBACK_PATHS,
      ...learnedRxPaths
    ].filter(Boolean);
    const data = await this.fetchFromGenieAcs('', { projection: [...new Set(projection)].join(',') }, 'GET', null, {
      timeoutMs: this.CUSTOMER_IDENTITY_TIMEOUT_MS
    });
    if (!Array.isArray(data)) {
      throw new Error('Invalid GenieACS map status response');
    }
    const now = Date.now();
    return data.map((item) => {
      const rx = Number(this.resolveRxPower(item, virtualParams, learnedRxPaths).value);
      return {
        deviceId: item._id || null,
        lastInform: item._lastInform || null,
        online: this.isDeviceOnline(item, now),
        pppoe: this.resolvePppoeUsername(item, virtualParams).value,
        rxPower: Number.isFinite(rx) && rx !== 0 ? rx : null
      };
    });
  }

  /**
   * The PPPoE login one ONT reports, and nothing else.
   *
   * For a caller that holds a device id and needs the subscriber's login
   * without the rest of the document — the SGP link above all, whose whole
   * job is to match an ONT to a contract by that login. Null for a bridged
   * ONT, or one that has not reported a login.
   */
  static async getReportedPppoe(deviceId) {
    return (await this.inspectReportedPppoe(deviceId)).login;
  }

  /**
   * The login one ONT reports, and — when there is none — why.
   *
   * `state` is `found` with a login; `requested` when the ONT has PPPoE
   * connections whose `Username` GenieACS never read, and a read of exactly
   * those leaves has been queued for its next Inform; `empty` when the ONT was
   * asked and answered with nothing (a WAN the OLT configures over OMCI keeps
   * the login out of TR-069); `absent` when it has no PPPoE connection at all.
   */
  static async inspectReportedPppoe(deviceId) {
    if (!deviceId) return { login: null, state: 'absent' };
    const virtualParams = await this.getVirtualParameters();
    const query = JSON.stringify({ _id: deviceId });
    const rows = await this.fetchDeviceListPage(
      query,
      [
        '_id',
        virtualParams.vpPppoeUsername,
        ...PPPOE_FALLBACK_PATHS,
        ...await this.readPppoePaths()
      ].filter(Boolean)
    );
    if (rows.length === 0) return { login: null, state: 'absent' };
    const login = this.resolvePppoeUsername(rows[0], virtualParams).value;
    if (typeof login === 'string' && login.trim()) return { login: login.trim(), state: 'found' };

    // Nothing at the paths the panel knows. One device's whole WAN tree is a
    // cheap read, and the path it turns up is kept for the listing.
    const [full] = await this.fetchDeviceListPage(
      query,
      ['_id', 'InternetGatewayDevice.WANDevice', 'Device.PPP.Interface']
    );
    const found = full ? findPppoeUsername(full, (node) => this.readNodeValue(node)) : null;
    if (found) {
      await this.rememberPppoePath(found.path);
      return { login: found.value, state: 'found' };
    }

    const leaves = full ? pppoeLoginLeaves(full) : [];
    if (leaves.length === 0) return { login: null, state: 'absent' };
    const unread = leaves.filter((leaf) => !this.holdsValue(leaf.node)).map((leaf) => leaf.path);
    if (unread.length === 0) return { login: null, state: 'empty' };
    await this.requestPppoeLogin(deviceId, unread);
    return { login: null, state: 'requested' };
  }

  /** Whether GenieACS read this leaf's value, as opposed to only its name. */
  static holdsValue(node) {
    return Boolean(node && typeof node === 'object' && '_value' in node);
  }

  /** How often one ONT is asked for the same kind of reading, at most. */
  static PPPOE_READ_INTERVAL_MS = 60 * 60 * 1000;

  /** Beyond this many leaves one task is a sweep, not a read. */
  static PPPOE_READ_LIMIT = 8;

  /** `${tenant}\0${device}\0${kind}` → when that reading was last asked for. */
  static parameterReadRequests = new Map();

  static pppoeReadKey(deviceId) {
    return `${currentTenantId()}\0${deviceId}`;
  }

  static async requestPppoeLogin(deviceId, paths) {
    return this.requestParameterRead(deviceId, 'pppoe', paths);
  }

  /**
   * Queues a read of the named leaves for the ONT's next Inform.
   *
   * Explicit leaves, because that is what a ZTE F-series answers reliably: it
   * is the `refreshObject` of a whole WAN subtree it faults on, which is how a
   * summon can leave the login unread. No connection request — this runs on
   * the way to a page, and the next periodic Inform is soon enough. Asked at
   * most once an hour per ONT and kind, so a page opened ten times queues one
   * task. Never throws: a GenieACS that refuses leaves the ONT where it was.
   */
  static async requestParameterRead(deviceId, kind, paths) {
    const key = `${this.pppoeReadKey(deviceId)}\0${kind}`;
    const now = Date.now();
    const last = this.parameterReadRequests.get(key);
    if (last && now - last < this.PPPOE_READ_INTERVAL_MS) return false;
    if (this.parameterReadRequests.size > 10000) {
      for (const [entry, at] of this.parameterReadRequests) {
        if (now - at >= this.PPPOE_READ_INTERVAL_MS) this.parameterReadRequests.delete(entry);
      }
    }
    this.parameterReadRequests.set(key, now);
    try {
      await this.fetchFromGenieAcs(`${encodeURIComponent(deviceId)}/tasks`, {}, 'POST', {
        name: 'getParameterValues',
        parameterNames: paths.slice(0, this.PPPOE_READ_LIMIT)
      });
      return true;
    } catch (error) {
      console.warn(`Unable to queue the ${kind} read of ${deviceId}: ${error.message}`);
      return false;
    }
  }

  /**
   * The WAN addresses one ONT reports, for the operator's "router access".
   *
   * The ERP never had this: SGP knows the contract and the login, not the
   * address the CPE is holding right now, which is why an attendant working
   * from the ERP alone reads "IP not available". The ONT itself answers it,
   * from `ExternalIPAddress` on each WAN connection (TR-098) or the IPv4
   * addresses of each IP interface (TR-181).
   *
   * Only addresses, status and names come back — never a password, even
   * though the PPP subtree holding them is the one being read.
   */
  static async getWanAddresses(deviceId) {
    if (!deviceId) return [];
    const [item] = await this.fetchDeviceListPage(
      JSON.stringify({ _id: deviceId }),
      ['_id', 'InternetGatewayDevice.WANDevice', 'Device.IP.Interface']
    );
    if (!item) return [];

    const read = (node, key) => this.readNodeValue(node?.[key]);
    const children = (node) => Object.entries(node && typeof node === 'object' ? node : {})
      .filter(([key, value]) => /^\d+$/.test(key) && value && typeof value === 'object');
    const connections = [];

    for (const [, wanDevice] of children(item.InternetGatewayDevice?.WANDevice)) {
      for (const [, connDevice] of children(wanDevice?.WANConnectionDevice)) {
        for (const [kind, type] of [['WANPPPConnection', 'PPPoE'], ['WANIPConnection', 'IP']]) {
          for (const [, conn] of children(connDevice?.[kind])) {
            const address = read(conn, 'ExternalIPAddress');
            connections.push({
              type,
              name: read(conn, 'Name'),
              status: read(conn, 'ConnectionStatus'),
              ipAddress: this.hasReportedValue(address) ? String(address).trim() : null
            });
          }
        }
      }
    }

    for (const [, iface] of children(item.Device?.IP?.Interface)) {
      const name = read(iface, 'Name') ?? read(iface, 'Alias');
      // The LAN bridge carries an IPv4 address too, and it is the gateway's own
      // address on the subscriber's side — not the one anyone asked for.
      if (name && /lan|^br/i.test(String(name))) continue;
      for (const [, entry] of children(iface?.IPv4Address)) {
        const address = read(entry, 'IPAddress');
        if (!this.hasReportedValue(address)) continue;
        connections.push({
          type: 'IP',
          name,
          status: read(iface, 'Status'),
          ipAddress: String(address).trim()
        });
      }
    }

    return connections;
  }

  static async getCustomerPortalOverview(deviceId) {
    if (!deviceId) throw new Error('Device ID is required');

    const virtualParams = await this.getVirtualParameters();
    const projection = [
      '_id',
      '_deviceId._ProductClass',
      '_deviceId._SerialNumber',
      '_deviceId._Manufacturer',
      'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'InternetGatewayDevice.DeviceInfo.UpTime',
      virtualParams.vpRxPower,
      virtualParams.vpTemperature,
      virtualParams.vpActiveDevices,
      '_lastInform',
      '_lastBoot',
      '_registered'
    ];
    for (let index = 1; index <= 8; index += 1) {
      projection.push(
        ...this.WLAN_STATE_FIELDS.map(
          (field) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.${field}`
        ),
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.SSID`,
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.TotalAssociations`
      );
    }

    const data = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: projection.filter(Boolean).join(',')
    });
    if (!Array.isArray(data) || data.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }

    const item = data[0];
    const getValue = (parameterPath) => this.getParameterValue(item, parameterPath);
    const wifi = [];
    for (let index = 1; index <= 8; index += 1) {
      const ssid = getValue(
        `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.SSID`
      );
      if (ssid === null || ssid === '') continue;
      wifi.push({
        index,
        ssid,
        enabled: this.resolveWlanEnabled(getValue, index),
        connectedDevices: getValue(
          `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.TotalAssociations`
        )
      });
    }

    const lastInform = item._lastInform || null;
    const lastInformMs = lastInform ? new Date(lastInform).getTime() : Number.NaN;
    const ageMs = Date.now() - lastInformMs;
    return {
      status: Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60 * 1000
        ? 'online'
        : 'offline',
      lastInform,
      lastBoot: item._lastBoot || null,
      registered: item._registered || null,
      ont: {
        manufacturer: item._deviceId?._Manufacturer || null,
        model: item._deviceId?._ProductClass || null,
        serialNumber: item._deviceId?._SerialNumber || null,
        hardwareVersion: getValue('InternetGatewayDevice.DeviceInfo.HardwareVersion'),
        softwareVersion: getValue('InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
        uptimeSeconds: getValue('InternetGatewayDevice.DeviceInfo.UpTime')
      },
      optical: {
        rxPower: getValue(virtualParams.vpRxPower),
        temperature: getValue(virtualParams.vpTemperature)
      },
      connectedDevices: getValue(virtualParams.vpActiveDevices),
      wifi,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * `connectionRequest: false` only queues the task for the ONT's next
   * periodic Inform, without GenieACS trying to reach it first — the way to
   * post follow-up tasks once one request has already found it unreachable.
   */
  static async postTask(deviceId, task, { connectionRequest = true } = {}) {
    const endpoint = `${encodeURIComponent(deviceId)}/tasks`;
    return this.fetchFromGenieAcs(
      endpoint,
      connectionRequest ? { connection_request: 1 } : {},
      'POST',
      task
    );
  }

  /**
   * Posts a task and says whether the ONT was reached.
   *
   * GenieACS answers 200 when the connection request got through and the
   * task ran, and 202 when it could only queue it — with the reason in the
   * status line ("Device is offline" for an ONT behind CGNAT it cannot call
   * back). `fetchFromGenieAcs` drops both, which is how "Solicitar Inform"
   * came to report success for ONTs it never reached.
   */
  static async postTaskWithStatus(deviceId, task, { connectionRequest = true } = {}) {
    const connector = await connectorFor();
    const response = await connector.request(
      this.devicePath(`${encodeURIComponent(deviceId)}/tasks`),
      { query: connectionRequest ? { connection_request: 1 } : {}, method: 'POST', body: task }
    );
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw await this.genieAcsError('GenieACS API', response, text);
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const reached = response.status === 200;
    return {
      status: response.status,
      reached,
      reason: reached ? null : (response.statusText || null),
      body
    };
  }

  /**
   * Posts a task and reports how GenieACS took it. `fetchFromGenieAcs`
   * discards the status code, but provisioning has to tell the two cases
   * apart: 200 means the connection request reached the CPE and the task ran,
   * 202 means it was only queued for some later inform. Recording a 202 as
   * "applied" would mark a device provisioned that never received anything.
   */
  static async postProvisioningTask(deviceId, task) {
    const { status, reached, body } = await this.postTaskWithStatus(deviceId, task);
    if (body?.fault?.faultString) {
      throw new Error(`GenieACS reported a fault: ${body.fault.faultString}`);
    }
    return { status, applied: reached, body };
  }

  /**
   * The WAN index provisioning should write to, in the `dev.conn.ppp.instance`
   * form `updateWanConfig` expects. An instance that already carries a PPPoE
   * username wins, since that is the one the CPE is actually dialling with.
   */
  static findPppoeWanIndex(item) {
    const wanDevice = item?.InternetGatewayDevice?.WANDevice;
    if (!wanDevice || typeof wanDevice !== 'object') return null;
    let fallback = null;
    for (const devKey of Object.keys(wanDevice)) {
      if (devKey.startsWith('_')) continue;
      const connectionDevices = wanDevice[devKey]?.WANConnectionDevice;
      if (!connectionDevices || typeof connectionDevices !== 'object') continue;
      for (const connKey of Object.keys(connectionDevices)) {
        if (connKey.startsWith('_')) continue;
        const pppConnections = connectionDevices[connKey]?.WANPPPConnection;
        if (!pppConnections || typeof pppConnections !== 'object') continue;
        for (const instanceKey of Object.keys(pppConnections)) {
          if (instanceKey.startsWith('_') || !pppConnections[instanceKey]) continue;
          const index = `${devKey}.${connKey}.ppp.${instanceKey}`;
          const basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${instanceKey}`;
          const username = this.findWanParameter(item, basePath, 'Username')?.value;
          if (username) return index;
          if (!fallback) fallback = index;
        }
      }
    }
    return fallback;
  }

  static installationTag(installationDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(installationDate))) {
      throw new Error('Invalid installation date');
    }
    return `Installed_${String(installationDate).replaceAll('-', '')}`;
  }

  static async mutateDeviceTag(deviceId, tag, method) {
    if (!deviceId || !/^[A-Za-z0-9_]+$/.test(String(tag))) {
      throw new Error('Invalid device tag');
    }
    const connector = await connectorFor();
    const response = await connector.request(
      this.devicePath(`${encodeURIComponent(String(deviceId))}/tags/${encodeURIComponent(String(tag))}`),
      { method }
    );
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw await this.genieAcsError('GenieACS tag API', response);
    }
    return true;
  }

  static async syncInstallationTag(deviceId, installationDate, previousTag = null) {
    const nextTag = this.installationTag(installationDate);
    await this.mutateDeviceTag(deviceId, nextTag, 'POST');
    if (previousTag && previousTag !== nextTag && /^[A-Za-z0-9_]+$/.test(String(previousTag))) {
      await this.mutateDeviceTag(deviceId, previousTag, 'DELETE');
    }
    return nextTag;
  }

  static discoverWanContainers(item) {
    const containers = [];
    const wanDevices = item?.InternetGatewayDevice?.WANDevice;
    if (!wanDevices || typeof wanDevices !== 'object') return containers;
    for (const [wanIndex, wanDevice] of Object.entries(wanDevices)) {
      if (wanIndex.startsWith('_') || !wanDevice || typeof wanDevice !== 'object') continue;
      const connectionDevices = wanDevice.WANConnectionDevice;
      if (!connectionDevices || typeof connectionDevices !== 'object') continue;
      for (const [connectionIndex, connectionDevice] of Object.entries(connectionDevices)) {
        if (connectionIndex.startsWith('_') || !connectionDevice || typeof connectionDevice !== 'object') continue;
        containers.push(`InternetGatewayDevice.WANDevice.${wanIndex}.WANConnectionDevice.${connectionIndex}`);
      }
    }
    return containers;
  }

  static async addWanConnection(deviceId, containerPath, type) {
    if (!['ppp', 'ip'].includes(type)) {
      throw new Error('Invalid WAN connection type');
    }
    const rawDeviceData = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: '_id,InternetGatewayDevice.WANDevice'
    });
    if (!Array.isArray(rawDeviceData) || rawDeviceData.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }
    const allowedContainers = this.discoverWanContainers(rawDeviceData[0]);
    if (!allowedContainers.includes(containerPath)) {
      throw new Error('Invalid WAN connection container');
    }
    const objectName = `${containerPath}.${type === 'ppp' ? 'WANPPPConnection' : 'WANIPConnection'}`;
    const task = await this.postTask(deviceId, { name: 'addObject', objectName });
    return {
      task,
      objectName,
      messageKey: 'device.service.wanCreateQueued',
      messageVars: { type: type === 'ppp' ? 'PPPoE' : 'IP' }
    };
  }

  /**
   * Apaga o cadastro da ONT no GenieACS — com a mesma conferência de série do
   * reset de fábrica, e pelo mesmo motivo: não tem volta, e a tela pode ter
   * ficado aberta noutro aparelho.
   */
  static async deleteDevice(deviceId, confirmSerial) {
    await this.assertSerialConfirmed(deviceId, confirmSerial);
    const connector = await connectorFor();
    const response = await connector.request(
      this.devicePath(encodeURIComponent(deviceId)),
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw await this.genieAcsError('GenieACS delete API', response);
    }

    return true;
  }

  /**
   * Devolve a ONT à configuração de fábrica — conferindo antes que quem pediu
   * digitou o número de série DESTE aparelho.
   *
   * A conferência mora aqui, e não só na tela, porque é o que separa um reset
   * pedido de propósito de uma requisição com o id errado: a tela pode ter
   * ficado aberta noutro aparelho, e a API é chamada por quem não usa a tela.
   * Sem série no documento (ACS que não a reporta), vale o id do aparelho.
   */
  static async factoryResetDevice(deviceId, confirmSerial) {
    await this.assertSerialConfirmed(deviceId, confirmSerial);
    return this.postTask(deviceId, { name: 'factoryReset' });
  }

  /**
   * Que `confirmSerial` é o número de série DESTE aparelho — sem ligar para
   * maiúsculas nem espaços nas pontas, e o id do aparelho quando o ACS não
   * reporta série. 404 para o aparelho que o ACS não conhece.
   */
  static async assertSerialConfirmed(deviceId, confirmSerial) {
    const rows = await this.fetchFromGenieAcs('', {
      query: JSON.stringify({ _id: deviceId }),
      projection: '_deviceId._SerialNumber'
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new TranslatableError('device.notFound', null, { status: 404 });
    }
    const esperado = String(rows[0]?._deviceId?._SerialNumber || deviceId).trim().toUpperCase();
    const digitado = String(confirmSerial ?? '').trim().toUpperCase();
    if (!digitado || digitado !== esperado) {
      throw new TranslatableError('device.factoryResetSerialMismatch', null, {
        status: 400,
        code: 'serial_mismatch'
      });
    }
  }

  static async rebootDevice(deviceId) {
    return this.postTask(deviceId, { name: 'reboot' });
  }

  /** Quantas ONTs do lote recebem a tarefa ao mesmo tempo. O teto do ACS fica por baixo. */
  static BATCH_PARALLEL = 4;

  /** Quantos ids cabem numa consulta de existência sem esticar demais a URL. */
  static BATCH_LOOKUP_CHUNK = 50;

  /**
   * Uma ação em vários aparelhos, com o resultado de cada um.
   *
   * Primeiro confere quais existem no ACS, numa leitura por bloco: mandar
   * tarefa para um id que o ACS não conhece é um 404 que se leria como falha
   * do ACS. Se essa leitura falhar, o lote inteiro para ANTES de mandar
   * qualquer coisa — o ACS está fora, e mandar metade seria pior.
   *
   * Depois, cada aparelho recebe a tarefa por conta própria: uma ONT que
   * recusa, ou uma chamada que cai, vira `failed` naquele aparelho e o resto
   * segue. `sent` é o ACS ter aplicado na hora (200); `queued`, a tarefa
   * esperando a ONT se conectar (202).
   *
   * No firmware, cada ONT é conferida contra o arquivo com a mesma regra da
   * troca de um aparelho só: outro modelo, ou a versão que ela já roda, vira
   * `failed` com o motivo, sem tarefa — um lote misturado não manda firmware
   * errado para ninguém.
   *
   * @param {'reboot'|'firmware'} action
   * @param {string[]} deviceIds já normalizados por `normalizeBatchIds`
   */
  static async runBatch(action, deviceIds, { fileId = null } = {}) {
    // Firmware: o arquivo é resolvido UMA vez, antes de qualquer tarefa. Um
    // arquivo que não existe ou não é firmware recusa o lote inteiro — não há
    // ONT para a qual ele sirva.
    let arquivo = null;
    if (action === 'firmware') {
      const { files } = await this.listFirmwareCatalog();
      arquivo = files.find((file) => file.id === String(fileId ?? '').trim()) ?? null;
      if (!arquivo) {
        throw new TranslatableError('device.firmwareNotCompatible', null, { status: 400, code: 'firmware_not_compatible' });
      }
    }

    const existentes = new Map();
    const projecao = action === 'firmware'
      ? ['_id', '_deviceId', 'InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'Device.DeviceInfo.SoftwareVersion']
      : ['_id'];
    for (let inicio = 0; inicio < deviceIds.length; inicio += this.BATCH_LOOKUP_CHUNK) {
      const bloco = deviceIds.slice(inicio, inicio + this.BATCH_LOOKUP_CHUNK);
      // eslint-disable-next-line no-await-in-loop -- um bloco por vez, para não disputar o ACS consigo mesmo
      const rows = await this.fetchDeviceListPage(JSON.stringify({ _id: { $in: bloco } }), projecao);
      for (const row of rows) existentes.set(String(row._id), row);
    }

    const results = await mapWithLimit(deviceIds, this.BATCH_PARALLEL, async (deviceId) => {
      const row = existentes.get(deviceId);
      if (!row) return { deviceId, outcome: 'failed', reason: 'not_found' };

      let task = { name: 'reboot' };
      if (action === 'firmware') {
        // A mesma regra da troca de um aparelho só: o modelo da ONT tem que ser
        // o do arquivo, e a versão que ela já roda não é reinstalada.
        const device = { oui: row?._deviceId?._OUI ?? null, productClass: row?._deviceId?._ProductClass ?? null };
        const { compatible } = compatibleFirmware([{ _id: arquivo.id, metadata: {
          fileType: FIRMWARE_FILE_TYPE, oui: arquivo.oui, productClass: arquivo.productClass, version: arquivo.version
        } }], device);
        if (compatible.length === 0) return { deviceId, outcome: 'failed', reason: 'firmware_not_compatible' };
        if (isInstalledVersion(arquivo, currentFirmwareVersion(row))) {
          return { deviceId, outcome: 'failed', reason: 'firmware_already_installed' };
        }
        task = { name: 'download', file: arquivo.id };
      }

      try {
        if (action === 'inform') {
          // The summon of the device page, queued: no connection request, so
          // a fleet behind CGNAT does not make the batch wait out the ACS's
          // timeout once per ONT. Each one reports at its next periodic Inform.
          const { reached } = await this.summonDevice(deviceId, [], { connectionRequest: false });
          return { deviceId, outcome: reached ? 'sent' : 'queued', reason: null };
        }
        const { applied } = await this.postProvisioningTask(deviceId, task);
        return { deviceId, outcome: applied ? 'sent' : 'queued', reason: null };
      } catch (error) {
        return {
          deviceId,
          outcome: 'failed',
          reason: /reported a fault/i.test(String(error?.message)) ? 'refused' : 'acs_error'
        };
      }
    });
    const normalizados = results.map((result, indice) => (result && !result.error
      ? result
      : { deviceId: deviceIds[indice], outcome: 'failed', reason: 'acs_error' }));
    return { results: normalizados, file: arquivo };
  }

  /**
   * Os arquivos de firmware do GenieACS que este provedor pode ver e usar.
   *
   * Com o ACS só dele (`scopeTag()` nulo), a coleção inteira, como sempre. Num
   * ACS compartilhado, a coleção `files` é de todos os provedores: só passam
   * os arquivos com o prefixo da tag dele no nome (`firmwareOwner`). Os sem
   * dono — enviados antes desta regra — ficam escondidos de todo provedor; só
   * a plataforma os vê, no próprio GenieACS. Sem tag ainda (a tag "sem dono"),
   * nenhum.
   *
   * É por aqui que passam a lista da ficha, a do lote E a conferência antes de
   * mandar o `download` (`upgradeFirmware`, `runBatch`): um arquivo de outro
   * provedor não aparece e, pedido pelo nome, é "não serve" — nunca "é de
   * outro", para não confirmar que o nome existe.
   */
  static async fetchScopedFirmwareFiles() {
    const connector = await connectorFor();
    const tag = (await connector.scopeTag?.()) ?? null;
    if (tag === UNASSIGNED_SCOPE_TAG) return [];
    // Com tag, o GenieACS já devolve só os do dono (o prefixo `<tag>--`): a
    // coleção é de todos, e paginar pela de todos para jogar fora a dos outros
    // faria o corte de páginas cair sobre arquivos alheios. `filesOwnedBy`
    // continua como defesa — a NBI é de terceiro.
    const filtro = { 'metadata.fileType': FIRMWARE_FILE_TYPE };
    if (tag) filtro._id = { $regex: `^${tag}--` };
    const files = await this.fetchFirmwareFilePages(filtro);
    return filesOwnedBy(files, tag, { unassignedTag: UNASSIGNED_SCOPE_TAG });
  }

  /**
   * Todos os arquivos que casam com `filter`, página por página.
   *
   * Antes era UMA página de 500, e o 501º firmware simplesmente não existia
   * para o painel — nem na lista, nem na conferência antes do `download`.
   * Agora vai até a página vir incompleta, com teto de `FIRMWARE_MAX_PAGES`
   * páginas para que uma NBI que ignora `skip` (e devolve sempre a mesma
   * página cheia) não prenda a requisição para sempre.
   *
   * `unscoped` é só da plataforma (os arquivos sem dono de um ACS
   * compartilhado, que o escopo do provedor esconde por definição).
   */
  static async fetchFirmwareFilePages(filter, { unscoped = false } = {}) {
    const connector = await connectorFor();
    const todos = [];
    for (let pagina = 0; pagina < FIRMWARE_MAX_PAGES; pagina += 1) {
      // eslint-disable-next-line no-await-in-loop -- uma página depois da outra: o `skip` depende da anterior
      const response = await connector.request(connector.collectionPath('files'), {
        unscoped,
        query: {
          query: JSON.stringify(filter),
          sort: JSON.stringify({ _id: 1 }),
          skip: pagina * FIRMWARE_PAGE_SIZE,
          limit: FIRMWARE_PAGE_SIZE
        }
      });
      if (!response.ok) {
        // eslint-disable-next-line no-await-in-loop -- sai do laço
        throw await this.genieAcsError('GenieACS files API', response);
      }
      // eslint-disable-next-line no-await-in-loop -- idem
      const text = await response.text();
      const rows = text ? JSON.parse(text) : [];
      if (!Array.isArray(rows)) throw new Error('Invalid API response');
      todos.push(...rows);
      if (rows.length < FIRMWARE_PAGE_SIZE) break;
    }
    return todos;
  }

  /** Todos os firmwares do GenieACS que dizem o modelo — a lista do lote. */
  static async listFirmwareCatalog() {
    return firmwareCatalog(await this.fetchScopedFirmwareFiles());
  }

  /**
   * Os firmwares do GenieACS que servem para esta ONT, e a versão que ela roda.
   *
   * A regra de quem serve para quem está em `firmwareFiles.js`; aqui só se lê
   * o que ela precisa — a identidade da ONT e a coleção `files`.
   */
  static async listFirmware(deviceId) {
    const rows = await this.fetchDeviceListPage(
      JSON.stringify({ _id: deviceId }),
      ['_id', '_deviceId', 'InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'Device.DeviceInfo.SoftwareVersion']
    );
    if (rows.length === 0) throw new TranslatableError('device.notFound', null, { status: 404 });
    const row = rows[0];
    const device = {
      oui: row?._deviceId?._OUI ?? null,
      productClass: row?._deviceId?._ProductClass ?? null
    };
    const files = await this.fetchScopedFirmwareFiles();
    const { compatible, otherModels } = compatibleFirmware(files, device);
    const current = currentFirmwareVersion(row);
    return {
      current,
      productClass: device.productClass,
      files: compatible.map((file) => ({ ...file, installed: isInstalledVersion(file, current) })),
      otherModels
    };
  }

  /**
   * Manda a ONT baixar e instalar um firmware do GenieACS.
   *
   * O arquivo é conferido de novo aqui, com a mesma regra da lista: a tela
   * pode estar velha, e a API é chamada por quem não usa a tela. Um firmware
   * de outro modelo pode deixar a ONT sem subir, e isso não tem volta pelo
   * painel. Reinstalar a versão que ela já roda também é recusado — só
   * derrubaria o assinante durante a gravação e o reinício.
   */
  static async upgradeFirmware(deviceId, fileId) {
    const alvo = String(fileId ?? '').trim();
    if (!alvo) {
      throw new TranslatableError('device.firmwareNotCompatible', null, { status: 400, code: 'firmware_not_compatible' });
    }
    const listing = await this.listFirmware(deviceId);
    const file = listing.files.find((candidate) => candidate.id === alvo);
    if (!file) {
      throw new TranslatableError('device.firmwareNotCompatible', null, { status: 400, code: 'firmware_not_compatible' });
    }
    if (file.installed) {
      throw new TranslatableError('device.firmwareAlreadyInstalled', null, { status: 400, code: 'firmware_already_installed' });
    }
    const { applied } = await this.postProvisioningTask(deviceId, { name: 'download', file: file.id });
    return { file, from: listing.current, queued: !applied };
  }

  /**
   * Pede à ONT um ping ou um traceroute, no modelo de dados que ela fala.
   *
   * O modelo vem de `readSummonShape`, o mesmo que já decide o que o forçar
   * contato pede: um detector só, para as duas perguntas não divergirem.
   *
   * `queued` diz se a ONT recebeu o pedido agora (200) ou se ele ficou na fila
   * do ACS até ela se conectar (202). Com a fila, o documento continua com o
   * resultado da vez anterior, e a tela não pode esperar por ele como novo.
   */
  static async startDiagnostic(deviceId, { kind, host, count } = {}) {
    if (!DIAGNOSTIC_KINDS.includes(kind)) {
      throw new TranslatableError('device.diagnosticInvalid', null, { status: 400, code: 'invalid_kind' });
    }
    if (!isValidDiagnosticHost(host)) {
      throw new TranslatableError('device.diagnosticInvalidHost', null, { status: 400, code: 'invalid_host' });
    }
    const repeticoes = count === undefined || count === null || count === '' ? PING_COUNT_DEFAULT : Number(count);
    if (!Number.isInteger(repeticoes) || repeticoes < 1 || repeticoes > PING_COUNT_MAX) {
      throw new TranslatableError('device.diagnosticInvalid', null, { status: 400, code: 'invalid_count' });
    }
    const { roots } = await this.readSummonShape(deviceId);
    const root = diagnosticRoot(roots);
    const { parameterValues } = diagnosticRequest(root, kind, host, { count: repeticoes });
    const { applied } = await this.postProvisioningTask(deviceId, { name: 'setParameterValues', parameterValues });
    return { kind, root, host: String(host).trim(), queued: !applied };
  }

  /**
   * Se o ACS ainda tem tarefa esperando por este aparelho.
   *
   * Uma ONT fora do ar não executa nada, e cada consulta da tela que pedisse
   * outra leitura empilharia mais uma tarefa na fila dela — até dezenas, todas
   * rodando de uma vez quando ela voltasse. Com tarefa na fila, não se pede
   * outra.
   */
  static async hasPendingTask(deviceId) {
    try {
      const tasks = await this.fetchGenieAcsCollection('tasks', {
        query: JSON.stringify({ device: deviceId }),
        projection: '_id'
      });
      return Array.isArray(tasks) && tasks.length > 0;
    } catch (error) {
      // Sem saber, não pede: é a escolha que não empilha.
      console.warn(`Unable to read the pending tasks of ${deviceId}: ${error.message}`);
      return true;
    }
  }

  /**
   * O resultado do último diagnóstico, buscando-o na ONT quando ela já pode tê-lo.
   *
   * A ONT avisa "8 DIAGNOSTICS COMPLETE" ao terminar, mas o GenieACS não busca
   * o resultado sozinho: o documento continua dizendo `Requested` até alguém
   * pedir o objeto de novo. É o que esta leitura faz, uma vez por consulta e
   * só sem tarefa na fila.
   */
  static async readDiagnostic(deviceId, kind) {
    if (!DIAGNOSTIC_KINDS.includes(kind)) {
      throw new TranslatableError('device.diagnosticInvalid', null, { status: 400, code: 'invalid_kind' });
    }
    const ler = async () => {
      const rows = await this.fetchDeviceListPage(
        JSON.stringify({ _id: deviceId }),
        [
          '_id',
          'InternetGatewayDevice.DeviceInfo',
          'Device.DeviceInfo',
          DIAGNOSTIC_OBJECTS.InternetGatewayDevice[kind],
          DIAGNOSTIC_OBJECTS.Device[kind]
        ]
      );
      if (rows.length === 0) throw new TranslatableError('device.notFound', null, { status: 404 });
      const row = rows[0];
      const root = diagnosticRoot(Object.keys(this.SUMMON_REFRESH_OBJECTS).filter((name) => row?.[name]));
      return readDiagnosticResult(row, root, kind);
    };

    const result = await ler();
    if (result.state !== 'running' || await this.hasPendingTask(deviceId)) return result;
    try {
      const { applied } = await this.postProvisioningTask(deviceId, {
        name: 'refreshObject',
        objectName: DIAGNOSTIC_OBJECTS[result.root][kind]
      });
      return applied ? await ler() : result;
    } catch (error) {
      console.warn(`Unable to read the ${kind} result of ${deviceId}: ${error.message}`);
      return result;
    }
  }

  /**
   * Objects a summon asks the ONT to re-report.
   *
   * GenieACS only stores parameters it has been told to fetch, so a fleet
   * whose provision script never asked for the GPON diagnostics has no
   * optical reading in any document — and no amount of reading the document
   * more cleverly will produce one. `refreshObject` on the parent is what
   * makes the ONT enumerate its own children, vendor extensions included, so
   * the reading is there from the next inform on.
   */
  static SUMMON_REFRESH_OBJECTS = Object.freeze({
    // WLANConfiguration too: many provision scripts fetch only the SSID
    // names, which leaves every network's on/off state unknown.
    // TemperatureStatus too: GenieACS lists the sensor on the first inform but
    // never reads its value unless asked, and that read is what a summon is for.
    InternetGatewayDevice: [
      'InternetGatewayDevice.WANDevice',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration',
      'InternetGatewayDevice.DeviceInfo.TemperatureStatus'
    ],
    Device: ['Device.Optical', 'Device.DeviceInfo.TemperatureStatus']
  });

  /** How long after a summon every listing looks again for the reading. */
  static RX_POWER_EAGER_MS = 15 * 60 * 1000;

  /**
   * Which data model this device answers on, so a summon asks it only for
   * objects its own tree could hold.
   *
   * Worth the extra read: nearly every ONT here speaks TR-098, and posting
   * the TR-181 refresh to all of them would have each one refuse a task it
   * was never going to accept. A refused task is a fault recorded against
   * the device, and in GenieACS a device's faults are in the way of the
   * tasks queued behind them — an operator's problem, days later, with no
   * obvious connection to a bell someone pressed.
   *
   * A read that fails falls back to TR-098 alone rather than to asking for
   * everything: guessing wide is what this exists to avoid. The same read
   * says which vendor objects this ONT's make has — see `vendorSummonObjects`.
   */
  static async readSummonShape(deviceId) {
    try {
      const rows = await this.fetchDeviceListPage(
        JSON.stringify({ _id: deviceId }),
        ['_id', '_deviceId', 'InternetGatewayDevice.DeviceInfo', 'Device.DeviceInfo', ...VENDOR_OPTICAL_OBJECTS]
      );
      const roots = Object.keys(this.SUMMON_REFRESH_OBJECTS).filter((root) => rows[0]?.[root]);
      if (roots.length > 0) {
        // Nokia's object is a TR-098 one; a TR-181 Nokia has no place for it.
        const vendorObjects = roots.includes('InternetGatewayDevice')
          ? this.vendorSummonObjects(rows[0])
          : [];
        return { roots, vendorObjects };
      }
    } catch (error) {
      console.warn(`Unable to read the data model of ${deviceId}: ${error.message}`);
    }
    return { roots: ['InternetGatewayDevice'], vendorObjects: [] };
  }

  /**
   * Nokia's optics object, for a Nokia whose document holds none of its
   * readings yet. Asked by make, never by guess: the object is Nokia's own,
   * and posting its refresh to any other ONT is a task it was always going
   * to refuse — a fault in the way of everything queued after it.
   */
  static vendorSummonObjects(row) {
    const make = `${row?._deviceId?._Manufacturer ?? ''} ${row?._deviceId?._OUI ?? ''}`;
    if (!/nokia|alcl|alcatel/i.test(make)) return [];
    const [objectName] = VENDOR_OPTICAL_OBJECTS;
    const known = opticalReadingLeaves(row)
      .some((leaf) => leaf.path.startsWith(`${objectName}.`));
    return known ? [] : [objectName];
  }

  /**
   * Asks the device to re-report each object, and reports which it accepted.
   *
   * Best effort even after the model check: an ONT can carry the root and
   * still not implement the object. That is one branch of a tree not
   * existing, not a summon that failed, and it must not cost the operator
   * the inform they actually asked for.
   */
  static async refreshSummonObjects(deviceId, { connectionRequest = true } = {}) {
    const { roots, vendorObjects } = await this.readSummonShape(deviceId);
    const objects = [
      ...roots.flatMap((root) => this.SUMMON_REFRESH_OBJECTS[root] ?? []),
      ...vendorObjects
    ];

    const refreshed = [];
    for (const objectName of objects) {
      try {
        const result = await this.postTask(
          deviceId,
          { name: 'refreshObject', objectName },
          { connectionRequest }
        );
        if (result?.fault?.faultString) {
          console.warn(`${deviceId} refused to refresh ${objectName}: ${result.fault.faultString}`);
          continue;
        }
        refreshed.push(objectName);
      } catch (error) {
        console.warn(`Unable to refresh ${objectName} on ${deviceId}: ${error.message}`);
      }
    }
    return refreshed;
  }

  /**
   * Asks the ONT, by name, for every PPPoE login and optical leaf its
   * document names.
   *
   * The `refreshObject` above is supposed to bring these too, but a ZTE
   * F-series faults on it and the login stays unread — so the SGP link, which
   * matches on that login, never forms — and a Nokia keeps its optics outside
   * the objects refreshed. A separate task, so a leaf the ONT no longer has
   * costs this read and not the summon the operator asked for.
   */
  static async readSummonLeaves(deviceId, { connectionRequest = true } = {}) {
    try {
      const [full] = await this.fetchDeviceListPage(
        JSON.stringify({ _id: deviceId }),
        [
          '_id',
          'InternetGatewayDevice.WANDevice',
          'Device.PPP.Interface',
          'Device.Optical.Interface',
          ...VENDOR_OPTICAL_OBJECTS
        ]
      );
      const paths = full
        ? [...pppoeLoginLeaves(full), ...opticalReadingLeaves(full)].map((leaf) => leaf.path)
        : [];
      if (paths.length === 0) return;
      const result = await this.postTask(deviceId, {
        name: 'getParameterValues',
        parameterNames: [...new Set(paths)].slice(0, this.SUMMON_READ_LIMIT)
      }, { connectionRequest });
      if (result?.fault?.faultString) {
        console.warn(`${deviceId} refused to report its login and optics: ${result.fault.faultString}`);
      }
    } catch (error) {
      console.warn(`Unable to read the login and optics of ${deviceId}: ${error.message}`);
    }
  }

  /** Login and optics together: a few connections plus a few readings. */
  static SUMMON_READ_LIMIT = 12;

  /**
   * Keeps every listing looking for the optical path for a while.
   *
   * A summon is the operator asking for a value the panel does not have yet,
   * and the refresh it queues only lands when the ONT next informs — after
   * the page they are looking at has loaded. Without this, a probe that ran
   * one second too early would record "this fleet reports no optical" and sit
   * on that answer for half an hour, hiding the very reading the summon was
   * for.
   */
  static async expectFreshRxPower() {
    const state = await this.readRxPowerState();
    if (state?.paths.length) return;
    await this.writeRxPowerState([], { eagerUntil: Date.now() + this.RX_POWER_EAGER_MS });
  }

  static async summonDevice(deviceId, parameters = [], { connectionRequest = true } = {}) {
    if (!Array.isArray(parameters) || parameters.length > 100) {
      throw new Error('Parameters must be an array with at most 100 entries');
    }
    if (parameters.some((parameter) => typeof parameter !== 'string' || parameter.length > 512)) {
      throw new Error('Every parameter path must be a string of at most 512 characters');
    }

    // The inform the operator asked for goes first: its answer says whether
    // the ONT can be reached at all. When it cannot, every task after it is
    // only queued — asking GenieACS to call an ONT behind CGNAT again for each
    // one would make the button wait out the same timeout several times over.
    const { reached, reason, body: data } = await this.postTaskWithStatus(deviceId, {
      name: 'getParameterValues',
      parameterNames: [
        'InternetGatewayDevice.DeviceInfo.SerialNumber',
        ...parameters
      ]
    }, { connectionRequest });

    if (data && data.fault && data.fault.faultString) {
      throw new Error(data.fault.faultString);
    }

    const refreshed = await this.refreshSummonObjects(deviceId, { connectionRequest: reached });
    await this.readSummonLeaves(deviceId, { connectionRequest: reached });
    if (refreshed.length > 0) await this.expectFreshRxPower();

    return {
      ...(data && typeof data === 'object' ? data : {}),
      refreshed,
      reached,
      reason,
      // Only when the ONT was actually tried: a batch that just queues has
      // nobody reading how long each one has been silent.
      ...(reached || !connectionRequest ? {} : await this.summonSilence(deviceId))
    };
  }

  /**
   * How long an ONT that could not be reached has been silent.
   *
   * "Queued for its next Inform" reads as minutes; for an ONT that stopped
   * informing twelve days ago it is whenever it comes back, if ever, and the
   * operator should be told which. Best effort: without the read the summon
   * still answers, only less precisely.
   */
  static async summonSilence(deviceId, now = Date.now()) {
    try {
      const [row] = await this.fetchDeviceListPage(
        JSON.stringify({ _id: deviceId }),
        ['_id', '_lastInform']
      );
      const lastInform = row?._lastInform || null;
      const informedAt = lastInform ? new Date(lastInform).getTime() : Number.NaN;
      return {
        lastInform,
        stale: !(now - informedAt < this.STALE_AFTER_MS)
      };
    } catch (error) {
      console.warn(`Unable to read when ${deviceId} last informed: ${error.message}`);
      return {};
    }
  }

  /**
   * `options.item` lets a caller that already holds the full device document
   * reuse it, so one provisioning run does not fetch the same document once
   * per step. `options.dryRun` returns the parameter list without queueing a
   * task, which is what lets the preview and the real run share one path.
   */
  static async updateWanConfig(deviceId, wanIndex, formData, options = {}) {
    const item = options.item ?? await this.fetchDeviceDocument(deviceId);
    const manufacturer = item._deviceId?._Manufacturer || null;
    const productClass = item._deviceId?._ProductClass || null;
    const vendorObj = await VendorService.detectVendor(manufacturer, productClass, item);
    
    if (!/^\d+\.\d+(?:\.ppp\.\d+)?$/.test(String(wanIndex))) {
      throw new Error('Invalid WAN connection index.');
    }
    const [devKey, connKey, indexType, instanceKey] = wanIndex.split('.');
    const connDev = item.InternetGatewayDevice?.WANDevice?.[devKey]?.WANConnectionDevice?.[connKey];
    
    if (!connDev) throw new Error('WAN Connection path not found in raw data.');

    let basePath = null;

    if (indexType === 'ppp' && connDev.WANPPPConnection?.[instanceKey]) {
      basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${instanceKey}`;
    } else if (!indexType && connDev.WANPPPConnection) {
      for (const pppKey in connDev.WANPPPConnection) {
        if (pppKey.startsWith('_')) continue;
        basePath = `InternetGatewayDevice.WANDevice.${devKey}.WANConnectionDevice.${connKey}.WANPPPConnection.${pppKey}`;
        break;
      }
    }

    if (!basePath) {
      throw new Error('Only PPPoE connections are editable for now.');
    }
    const parameterValues = [];
    const {
      name,
      vlanEnabled,
      vlanId,
      username,
      password,
      serviceList,
      connectionType,
      natEnabled,
      bindings = {}
    } = formData;
    const nameParameter = this.findWanParameter(item, basePath, 'Name');
    const usernameParameter = this.findWanParameter(item, basePath, 'Username');
    const passwordParameter = this.findWanParameter(item, basePath, 'Password');
    const vlanParameter = this.findWanParameter(
      item,
      basePath,
      vendorObj?.vlan_id_path,
      WAN_PARAMETER_CANDIDATES.vlan
    );
    const serviceParameter = this.findWanParameter(
      item,
      basePath,
      vendorObj?.service_list_path,
      WAN_PARAMETER_CANDIDATES.serviceList
    );
    const connectionTypeParameter = this.findWanParameter(item, basePath, 'ConnectionType');
    const natParameter = this.findWanParameter(item, basePath, 'NATEnabled');
    const bindingParameter = this.findWanParameter(
      item,
      basePath,
      vendorObj?.lan_binding_path,
      WAN_PARAMETER_CANDIDATES.bindings
    );

    if (nameParameter?.writable && name !== undefined && name !== nameParameter.value) {
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > 256) {
        throw new Error('WAN name must contain 1 to 256 characters.');
      }
      parameterValues.push([nameParameter.path, name.trim(), 'xsd:string']);
    }
    if (vlanParameter?.writable) {
      const parsedVlanId = Number(vlanId);
      if (vlanEnabled && (!Number.isInteger(parsedVlanId) || parsedVlanId < 1 || parsedVlanId > 4094)) {
        throw new Error('VLAN ID must be an integer between 1 and 4094.');
      }
      const nextVlan = vlanEnabled ? parsedVlanId : 0;
      if (String(nextVlan) !== String(vlanParameter.value ?? '')) {
        parameterValues.push([vlanParameter.path, nextVlan, 'xsd:unsignedInt']);
      }
    }

    if (usernameParameter?.writable && username !== undefined && username !== usernameParameter.value) {
      if (typeof username !== 'string' || username.length > 256) {
        throw new Error('PPP username must be a string of at most 256 characters.');
      }
      parameterValues.push([usernameParameter.path, username, 'xsd:string']);
    }
    if (passwordParameter?.writable && password) {
      if (typeof password !== 'string' || password.length > 256) {
        throw new Error('PPP password must be a string of at most 256 characters.');
      }
      parameterValues.push([passwordParameter.path, password, 'xsd:string']);
    }
    if (
      serviceParameter?.writable &&
      serviceList !== undefined &&
      serviceList !== serviceParameter.value
    ) {
      if (typeof serviceList !== 'string' || serviceList.length > 128) {
        throw new Error('WAN service list must be a string of at most 128 characters.');
      }
      parameterValues.push([serviceParameter.path, serviceList, 'xsd:string']);
    }
    if (
      connectionTypeParameter?.writable &&
      connectionType !== undefined &&
      connectionType !== connectionTypeParameter.value
    ) {
      if (!['IP_Routed', 'PPPoE_Bridged'].includes(connectionType)) {
        throw new Error('Invalid WAN connection type.');
      }
      parameterValues.push([connectionTypeParameter.path, connectionType, 'xsd:string']);
    }
    if (
      natParameter?.writable &&
      typeof natEnabled === 'boolean' &&
      natEnabled !== this.isEnabledValue(natParameter.value)
    ) {
      parameterValues.push([natParameter.path, natEnabled, 'xsd:boolean']);
    }
    
    if (bindingParameter) {
      for (let i = 1; i <= 4; i++) {
        const parameter = this.findWanParameter(item, bindingParameter.path, `Lan${i}Enable`);
        if (parameter?.writable) {
          const next = Boolean(bindings[`LAN${i}`]);
          if (next !== this.isEnabledValue(parameter.value)) {
            parameterValues.push([parameter.path, next, 'xsd:boolean']);
          }
        }
      }
      for (let i = 1; i <= 8; i++) {
        const parameter = this.findWanParameter(item, bindingParameter.path, `SSID${i}Enable`);
        if (parameter?.writable) {
          const next = Boolean(bindings[`SSID${i}`]);
          if (next !== this.isEnabledValue(parameter.value)) {
            parameterValues.push([parameter.path, next, 'xsd:boolean']);
          }
        }
      }
    }

    if (parameterValues.length === 0) {
      return { success: true, messageKey: 'device.service.wanNoChanges', parameterCount: 0 };
    }

    if (options.dryRun) {
      return { success: true, dryRun: true, parameterValues, parameterCount: parameterValues.length };
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });

    return {
      success: true,
      messageKey: 'device.service.wanUpdateQueued',
      parameterCount: parameterValues.length,
      parameterValues
    };
  }

  static async updateCredentials(deviceId, type, password, options = {}) {
    if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
      throw new Error('Password must be between 1 and 256 characters.');
    }
    const settings = await Setting.getAll();
    let passPath;

    if (type === 'super') {
      passPath = settings.vpSuperPassword;
    } else if (type === 'user') {
      passPath = settings.vpUserPassword;
    } else {
      throw new Error('Invalid credential type specified.');
    }

    if (!passPath) {
      throw new Error(`VirtualParameter path for ${type} password is not set in settings.`);
    }

    const parameterValues = [[passPath, password, 'xsd:string']];
    if (options.dryRun) {
      return { success: true, dryRun: true, parameterValues, parameterCount: parameterValues.length };
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });

    return { success: true, messageKey: 'device.service.credentialQueued', messageVars: { type } };
  }

  static resolveWifiConfiguredPath(basePath, configuredPath, index) {
    if (!configuredPath) return null;
    const expanded = String(configuredPath)
      .replaceAll('{index}', String(index))
      .replaceAll('{i}', String(index))
      .replace('*', String(index));
    return this.resolveParameterPath(basePath, expanded);
  }

  static async updateWifiConfig(deviceId, index, formData, options = {}) {
    const wifiIndex = Number(index);
    if (!Number.isInteger(wifiIndex) || wifiIndex < 1 || wifiIndex > 8) {
      throw new TranslatableError('device.service.wifiIndexInvalid', null, { status: 400 });
    }
    const ssid = String(formData?.ssid ?? '').trim();
    const password = formData?.password === undefined ? '' : String(formData.password);
    const security = String(formData?.security ?? '').trim();
    const channelRaw = formData?.channel;
    if (!ssid || ssid.length > 32) {
      throw new TranslatableError('device.service.wifiSsidInvalid', null, { status: 400 });
    }
    if (password && (password.length < 8 || password.length > 63)) {
      throw new TranslatableError('device.service.wifiPasswordInvalid', null, { status: 400 });
    }
    if (security.length > 128) {
      throw new TranslatableError('device.service.wifiSecurityTooLong', null, { status: 400 });
    }
    if (
      channelRaw !== '' && channelRaw !== null && channelRaw !== undefined &&
      (!Number.isInteger(Number(channelRaw)) || Number(channelRaw) < 0 || Number(channelRaw) > 196)
    ) {
      throw new TranslatableError('device.service.wifiChannelInvalid', null, { status: 400 });
    }

    const item = options.item ?? await this.fetchDeviceDocument(deviceId);
    const basePath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${wifiIndex}`;
    const virtualPrefix = wifiIndex === 1 ? 'SSID1' : wifiIndex === 5 ? 'SSID5' : null;
    const virtualNamePath = virtualPrefix ? `VirtualParameters.${virtualPrefix}-Name` : null;
    const useVirtual = Boolean(virtualNamePath && this.getParameterNode(item, virtualNamePath));
    const productClass = this.normalizeParameterValue(item._deviceId?._ProductClass);
    const manufacturer = this.normalizeParameterValue(item._deviceId?._Manufacturer);
    const [productConfig, vendor] = await Promise.all([
      productClass ? WifiSecurityConfig.getByProductClass(productClass) : null,
      VendorService.detectVendor(manufacturer, productClass, item)
    ]);

    const parameterValues = [];
    const enablePath = `${basePath}.Enable`;
    if (typeof formData?.enable === 'boolean' && this.getParameterNode(item, enablePath)) {
      parameterValues.push([enablePath, formData.enable, 'xsd:boolean']);
    }
    parameterValues.push([
      useVirtual ? `VirtualParameters.${virtualPrefix}-Name` : `${basePath}.SSID`,
      ssid,
      'xsd:string'
    ]);
    if (password) {
      let passwordPath = useVirtual ? `VirtualParameters.${virtualPrefix}-Password` : null;
      if (!passwordPath) {
        passwordPath = this.resolveWifiConfiguredPath(
          basePath,
          productConfig?.password_param_path || vendor?.wifi_password_path,
          wifiIndex
        );
      }
      if (!passwordPath) {
        const candidates = [
          `${basePath}.PreSharedKey.1.KeyPassphrase`,
          `${basePath}.KeyPassphrase`,
          `${basePath}.PreSharedKey.1.PreSharedKey`
        ];
        passwordPath = candidates.find((path) => this.getParameterNode(item, path)) || candidates[0];
      }
      parameterValues.push([passwordPath, password, 'xsd:string']);
    }
    if (security) {
      parameterValues.push([
        useVirtual ? `VirtualParameters.${virtualPrefix}-Security` : `${basePath}.BeaconType`,
        security,
        'xsd:string'
      ]);
    }
    if (channelRaw !== '' && channelRaw !== null && channelRaw !== undefined) {
      const channelPath = `${basePath}.Channel`;
      if (this.getParameterNode(item, channelPath)) {
        parameterValues.push([channelPath, Number(channelRaw), 'xsd:unsignedInt']);
      }
    }

    if (options.dryRun) {
      return { success: true, dryRun: true, parameterValues, parameterCount: parameterValues.length };
    }

    await this.postTask(deviceId, {
      name: 'setParameterValues',
      parameterValues
    });
    return {
      success: true,
      parameterValues,
      messageKey: 'device.service.wifiQueued',
      messageVars: { index: wifiIndex },
      parameterCount: parameterValues.length
    };
  }

  static normalizeFault(fault) {
    if (!fault || typeof fault !== 'object') return null;
    const scalar = (value) => {
      const direct = this.normalizeParameterValue(value);
      if (direct !== null) return direct;
      if (!value || typeof value !== 'object') return null;
      for (const key of ['$oid', '$date', '_value', 'value', 'id']) {
        if (value[key] !== undefined && value[key] !== value) {
          const nested = scalar(value[key]);
          if (nested !== null) return nested;
        }
      }
      return null;
    };
    const id = scalar(fault._id);
    if (!id) return null;
    const detail = fault.detail && typeof fault.detail === 'object' ? fault.detail : {};
    const deviceId = scalar(fault.device) || String(id).split(':')[0] || null;
    const timestamp = scalar(fault.timestamp) ||
      scalar(fault.retryTimestamp) ||
      scalar(fault._timestamp) ||
      null;
    return {
      id: String(id),
      deviceId: deviceId ? String(deviceId) : null,
      channel: String(scalar(fault.channel) || String(id).split(':').slice(1).join(':') || 'default'),
      code: String(
        scalar(fault.code) ||
        scalar(detail.faultCode) ||
        scalar(detail.code) ||
        'FAULT'
      ),
      message: String(
        scalar(fault.message) ||
        scalar(detail.faultString) ||
        scalar(detail.message) ||
        scalar(fault.faultString) ||
        'GenieACS reported a provisioning fault'
      ),
      timestamp: timestamp ? String(timestamp) : null,
      retries: Number(scalar(fault.retries) || scalar(fault.retryCount) || 0)
    };
  }

  static async getFaults(limit = 50, timeoutMs = 15_000) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    // Num ACS compartilhado as falhas são de todos: só as dos equipamentos do
    // provedor passam. Lê-se mais do que o limite para que o recorte ainda
    // devolva uma lista cheia, e a lista de equipamentos vem pelo filtro normal.
    const connector = await connectorFor();
    const tag = await connector.scopeTag();
    const donos = tag
      ? new Set(((await this.fetchFromGenieAcs('', { projection: '_id' })) || []).map((row) => String(row._id)))
      : null;
    const data = await this.fetchGenieAcsCollection(
      'faults',
      {
        limit: donos ? Math.min(safeLimit * 10, 2000) : safeLimit
      },
      'GET',
      null,
      timeoutMs
    );
    if (!Array.isArray(data)) {
      throw new Error('Invalid faults API response');
    }
    const doProvedor = (fault) => {
      if (!donos) return true;
      const id = String(fault?._id ?? '');
      const corte = id.lastIndexOf(':');
      const device = fault?.device ?? (corte > 0 ? id.slice(0, corte) : id);
      return donos.has(String(device));
    };
    return data
      .filter(doProvedor)
      .map((fault) => this.normalizeFault(fault))
      .filter(Boolean)
      .sort((left, right) => {
        const a = left.timestamp ? new Date(left.timestamp).getTime() : 0;
        const b = right.timestamp ? new Date(right.timestamp).getTime() : 0;
        return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
      })
      .slice(0, safeLimit);
  }

  static async deleteFault(faultId) {
    if (!faultId || String(faultId).length > 512) {
      throw new Error('Invalid fault ID');
    }
    const connector = await connectorFor();
    const response = await connector.request(
      `faults/${encodeURIComponent(String(faultId))}`,
      { method: 'DELETE' }
    );
    if (!response.ok && response.status !== 404) {
      throw await this.genieAcsError('GenieACS fault API', response);
    }
    return true;
  }

  static buildDashboardSummary(devices, faults = [], faultsError = null) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stats = { total: devices.length, online: 0, offline: 0, new24h: 0 };
    const rxDistribution = { Excellent: 0, Good: 0, Poor: 0, Danger: 0, Unknown: 0 };
    const informFreshness = { 'Under 10m': 0, '10–60m': 0, '1–24h': 0, 'Over 24h': 0 };
    const temperatureDistribution = { Normal: 0, Warm: 0, Hot: 0, Unknown: 0 };
    const clientDistribution = { '0': 0, '1–5': 0, '6–15': 0, '16+': 0, Unknown: 0 };
    const productClasses = new Map();
    const manufacturers = new Map();
    const registrationDays = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(now - (6 - offset) * dayMs);
      return {
        key: date.toISOString().slice(0, 10),
        name: date.toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit' }),
        value: 0
      };
    });
    const registrationByKey = new Map(registrationDays.map((entry) => [entry.key, entry]));

    for (const device of devices) {
      const lastInformMs = device._lastInform ? new Date(device._lastInform).getTime() : Number.NaN;
      const informAge = now - lastInformMs;
      if (Number.isFinite(informAge) && informAge >= 0 && informAge < 10 * 60 * 1000) {
        stats.online += 1;
        informFreshness['Under 10m'] += 1;
      } else {
        stats.offline += 1;
        if (Number.isFinite(informAge) && informAge >= 0 && informAge < 60 * 60 * 1000) {
          informFreshness['10–60m'] += 1;
        } else if (Number.isFinite(informAge) && informAge >= 0 && informAge < dayMs) {
          informFreshness['1–24h'] += 1;
        } else {
          informFreshness['Over 24h'] += 1;
        }
      }

      const registeredMs = device._registered ? new Date(device._registered).getTime() : Number.NaN;
      // A mesma janela que `focus=new24h` recorta, pelo mesmo motivo das
      // faixas: o número e a lista que ele abre têm que responder a mesma
      // pergunta. Data no futuro fica de fora nos dois lados.
      if (
        Number.isFinite(registeredMs) &&
        now - registeredMs >= 0 &&
        now - registeredMs < this.NEW_DEVICE_WINDOW_MS
      ) {
        stats.new24h += 1;
      }
      if (Number.isFinite(registeredMs)) {
        const registrationKey = new Date(registeredMs).toISOString().slice(0, 10);
        const registrationEntry = registrationByKey.get(registrationKey);
        if (registrationEntry) registrationEntry.value += 1;
      }

      const productClass = String(device.productclass || 'Unknown');
      const manufacturer = String(device.manufacturer || 'Unknown');
      productClasses.set(productClass, (productClasses.get(productClass) || 0) + 1);
      manufacturers.set(manufacturer, (manufacturers.get(manufacturer) || 0) + 1);

      // As mesmas faixas que a lista recorta, e por isso lidas de lá: o link
      // do painel promete "estes", e quem responde por "estes" é o filtro.
      rxDistribution[this.rxBucket(device.rxpower)] += 1;
      temperatureDistribution[this.temperatureBucket(device.temperature)] += 1;
      clientDistribution[this.clientBucket(device.activedevices)] += 1;
    }

    const topEntries = (map, limit) => Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, limit);

    return {
      generatedAt: new Date(now).toISOString(),
      stats,
      rxDistribution,
      informFreshness,
      temperatureDistribution,
      clientDistribution,
      productClasses: topEntries(productClasses, 10),
      manufacturers: topEntries(manufacturers, 8),
      registrations: registrationDays,
      faults,
      faultsError
    };
  }

  /**
   * O escopo de equipamentos em que o painel foi montado: a tag do provedor,
   * a tag "sem dono" de um ACS compartilhado sem tag, ou `''` com o ACS só
   * dele. Um painel montado noutro escopo é descartado, não servido — foi
   * assim que um provedor recém-separado continuava vendo a frota de todos.
   */
  static async dashboardScope() {
    const connector = await connectorFor();
    return String((await connector.scopeTag?.()) ?? '');
  }

  static async hydrateDashboardCache() {
    const cache = this.dashboardCacheFor();
    if (cache.hydrated) return;
    cache.hydrated = true;
    try {
      const stored = await AppState.get('dashboard_snapshot');
      if (!stored) return;
      const snapshot = JSON.parse(stored);
      if (!snapshot?.data?.stats || !snapshot?.data?.generatedAt) return;
      // Instantâneo sem escopo é de antes da separação por tag: não serve.
      if (typeof snapshot.scope !== 'string') return;
      cache.data = snapshot.data;
      cache.scope = snapshot.scope;
      cache.expiresAt = Number(snapshot.expiresAt) || 0;
    } catch (error) {
      console.warn('Ignoring invalid dashboard snapshot:', error.message);
    }
  }

  static async persistDashboardCache() {
    const cache = this.dashboardCacheFor();
    if (!cache.data) return;
    try {
      await AppState.upsert('dashboard_snapshot', JSON.stringify({
        data: cache.data,
        expiresAt: cache.expiresAt,
        scope: cache.scope ?? ''
      }));
    } catch (error) {
      console.warn('Unable to persist dashboard snapshot:', error.message);
    }
  }

  /**
   * @param {{ ttlMs?: number }} [opts] Por quanto tempo o resultado vale.
   *   O padrão é a cadência de quem tem operador na tela; o job agendado passa
   *   a cadência ociosa quando ninguém entrou na última hora. Sem este
   *   parâmetro o prazo do cache seria sempre 60s, e uma requisição feita 61s
   *   depois de uma atualização ociosa disparava, do caminho da requisição,
   *   exatamente a busca que o job acabara de decidir que podia esperar.
   */
  static async refreshDashboardData({ ttlMs } = {}) {
    const cache = this.dashboardCacheFor();
    const scope = await this.dashboardScope();
    const devices = await this.getDashboardDevices();
    // As falhas do painel anterior só valem se ele era do mesmo escopo.
    const anterior = cache.scope === scope ? cache.data : null;
    const previousFaults = Array.isArray(anterior?.faults) ? anterior.faults : [];
    const data = this.buildDashboardSummary(devices, previousFaults, anterior?.faultsError || null);
    cache.data = data;
    cache.scope = scope;
    cache.expiresAt = Date.now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.dashboardCacheTtlMs);
    await this.persistDashboardCache();
    return data;
  }

  static async mergeDashboardFaults(faults, faultsError = null) {
    const cache = this.dashboardCacheFor();
    await this.hydrateDashboardCache();
    if (!cache.data) return;
    if (cache.scope !== await this.dashboardScope()) return;
    cache.data = { ...cache.data, faults, faultsError };
    await this.persistDashboardCache();
  }

  static async getDashboardData(force = false) {
    const cache = this.dashboardCacheFor();
    await this.hydrateDashboardCache();
    if (cache.data && cache.scope !== await this.dashboardScope()) {
      cache.data = null;
      cache.expiresAt = 0;
    }

    const startRefresh = () => {
      if (cache.promise) return cache.promise;
      const work = this.refreshDashboardData();
      cache.promise = work;
      work.catch((error) => {
        console.error('Dashboard background refresh failed:', error.message);
      }).finally(() => {
        if (cache.promise === work) cache.promise = null;
      });
      return work;
    };

    if (!force && cache.data) {
      if (cache.expiresAt <= Date.now()) startRefresh();
      return cache.data;
    }
    if (cache.promise) return cache.promise;

    const work = startRefresh();
    cache.promise = work;
    try {
      return await work;
    } finally {
      if (cache.promise === work) cache.promise = null;
    }
  }
}

export default DeviceService;
