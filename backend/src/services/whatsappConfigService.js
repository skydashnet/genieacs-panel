import crypto from 'node:crypto';
import AppState from '../models/AppState.js';
import { WA_WEBHOOK_PATH, withWebhookPath } from '../config/waWebhookPath.js';
import { createSecretBox } from '../utils/secretBox.js';
import { normalizeEvoUrl, parseAllowedHosts } from '../utils/wa/evolutionPolicy.js';
import { TenantCache } from '../config/tenantCache.js';
import { MAX_RETENTION_DAYS } from '../config/retention.js';
import { IS_SAAS } from '../config/edition.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';
import { WA_SERVER_FIELDS, platformManagesCurrentTenant } from '../config/platformManaged.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService from './subscriptionService.js';
import { CADENCIA_PADRAO, lerCadencia } from '../utils/wa/waCadencia.js';

const CONFIG_KEY = 'whatsapp_evolution_config';
const CONFIG_CACHE_TTL_MS = 30_000;

/** What kind of traffic a connected number carries. */
export const PURPOSES = Object.freeze(['general', 'billing', 'support', 'sales', 'alerts']);

/** The lifecycle of a connected number, as the panel sees it. */
export const ACCOUNT_STATUSES = Object.freeze(['pending', 'connecting', 'connected', 'disconnected', 'expired']);

/**
 * Two independent secret boxes.
 *
 * They are separate because the two secrets have different blast radii: the
 * webhook token travels in a URL and is stored on the Evolution server, so it
 * appears in logs on both ends; the instance token sends messages as the
 * provider and reads its contacts. A ciphertext from one context can never be
 * decrypted as the other.
 */
const instanceTokenBox = createSecretBox('skygenpanel-evolution-instance-token-v1');
const webhookTokenBox = createSecretBox('skygenpanel-evolution-webhook-token-v1');
const adminKeyBox = createSecretBox('skygenpanel-evolution-admin-key-v1');
const metaVerifyBox = createSecretBox('skygenpanel-evolution-meta-verify-token-v1');

/** Caminho do Evolution v2 que recebe os eventos da Meta (API oficial). */
export const META_WEBHOOK_SUFFIX = '/webhook/meta';

/**
 * The panel's own error shape for everything WhatsApp, mirroring SgpError so the
 * controllers can translate it the same way.
 *
 * `code` is a machine string the frontend switches on to show an actionable
 * message; dumping the server's response body at the operator is what the
 * source system did before, and it sent people to check a URL and a key that
 * were already correct.
 */
export class WaError extends Error {
  constructor(message, { code = 'wa_error', status = 502, details = null, vars = null, raw = false } = {}) {
    super(message);
    this.name = 'WaError';
    this.code = code;
    this.status = status;
    this.details = details;
    // `message` is a translation key unless the caller says it is already text
    // — the shape SgpError established, so one `translateError` handles both.
    if (!raw) {
      this.translationKey = message;
      this.translationVars = vars;
    }
  }
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  // Empty allowlist = any public host. The SSRF guard still blocks internal
  // networks, so this is "any server the provider chose", not "anything".
  allowedHosts: [],
  // The public HTTPS URL where the Evolution server reaches this panel. The
  // panel cannot guess it: it sits behind a tunnel or a reverse proxy whose
  // external hostname is nowhere in the process.
  webhookBaseUrl: '',
  rejectCallMessage: 'Este número não recebe chamadas. Envie sua mensagem por escrito.',
  // Where a subscriber reaches the customer portal from outside.
  //
  // The bot needs this and cannot derive it: the portal is a SEPARATE app on a
  // separate port (`portalApp`), so the panel's own address is only the same
  // hostname when a reverse proxy fronts both. Guessing it produces a link that
  // 404s for the one person the bot exists to help, so an empty value makes the
  // bot hand off to a human instead of sending a broken link.
  portalPublicUrl: '',
  // O atendimento automático (`WaBotService`). Ligado por padrão: era o
  // comportamento antes de existir a chave, e um provedor que nunca abriu a
  // tela não pode perder o bot por uma atualização.
  botEnabled: true,
  // O bot pedir a liberação em confiança ao SGP sozinho. Desligado por
  // padrão: é a única ação que o bot faz no serviço do assinante, e ligar é
  // decisão do provedor.
  botUnlockEnabled: false,
  // Per-minute ceiling for outbound messages, shared by the outbox worker and
  // any campaign that does not set its own.
  rateLimitPerMin: 20,
  // O ritmo das mensagens automáticas (`source='campaign'`): um intervalo
  // sorteado entre uma e outra e uma pausa longa a cada tantas. Respostas de
  // operador, bot e alertas não esperam por ele. Ver `utils/wa/waCadencia.js`.
  ...CADENCIA_PADRAO,
  // How many days a stored attachment is kept before the sweeper deletes it.
  //
  // Zero means forever, and forever is the default because this setting arrived
  // after installs already had files: deleting a provider's history because
  // they upgraded would be the panel destroying data nobody asked it to touch.
  mediaRetentionDays: 0,
  // How many days a message row is kept before the history sweeper deletes it.
  //
  // Zero means forever, same as above and for the same reason. This one is the
  // heavier of the two: an attachment that goes leaves the words of the
  // conversation behind, and this deletes the words. It is off unless an
  // operator turns it on and can see the number they turned it on to.
  messageRetentionDays: 0,
  managedUrl: '',
  // Para onde a Meta manda os eventos de um número oficial — o
  // `/webhook/meta` do servidor Evolution. Vazio usa `managedUrl` + o caminho;
  // existe separado para quem publica o servidor atrás de outro endereço.
  cloudCallbackUrl: '',
  updatedAt: null
});

/**
 * Days of retention, or zero for forever.
 *
 * Anything unreadable reads as zero — the safe direction here is the one that
 * deletes nothing. A typo in a settings form must not be able to mean "sweep
 * the archive tonight".
 */
function normalizeRetentionDays(value) {
  const days = Math.trunc(Number(value));
  if (!Number.isFinite(days) || days <= 0) return 0;
  // Ten years. Past that the number is a mistake, not a policy.
  return Math.min(days, MAX_RETENTION_DAYS);
}

function encryptSecret(box, value) {
  return { v: 1, ...box.encrypt(value) };
}

function decryptSecret(box, stored) {
  return stored ? (box.decrypt(stored) ?? '') : '';
}

/** 32 bytes of CSPRNG, hex. Used for both the instance and the webhook token. */
export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

class WhatsAppConfigService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /**
   * Forget the provider in scope — its own configuration changed.
   * To forget every provider's, reach for `configCache.clear()`; that is a
   * reset, not a save, and the two must not share a name.
   */
  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, managedAdminKey: null, cloudVerifyToken: null };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG, managedAdminKey: null, cloudVerifyToken: null };
    }
  }

  /**
   * O que está guardado, com o SERVIDOR vindo de quem manda nele.
   *
   * Na SaaS, o servidor Evolution (endereço, chave, hosts permitidos, URL do
   * webhook) é um só para todos os provedores e mora no `app_state` da caixa
   * da plataforma — é lá que o administrador da plataforma o configura, na
   * tela de WhatsApp dela. O provedor guarda só o uso que faz dele: se está
   * ligado, a mensagem de recusa, o portal, o ritmo e a retenção. Sem caixa da
   * plataforma, o servidor sai vazio, e a integração fica sem ter para onde
   * criar número — que é o estado honesto de um deploy que ainda não o
   * configurou.
   */
  static async readEffectiveConfig() {
    const stored = await this.readStoredConfig();
    if (!(await platformManagesCurrentTenant())) return { ...stored, platformManaged: false };
    const platform = await Tenant.platform();
    const server = platform
      ? await runInTenant(platform.id, () => this.readStoredConfig())
      : { ...DEFAULT_CONFIG, managedAdminKey: null, cloudVerifyToken: null };
    const merged = { ...stored, platformManaged: true };
    for (const field of WA_SERVER_FIELDS) merged[field] = server[field];
    return merged;
  }

  /** Só o que ESTE tenant guardou, decodificado, sem o servidor da plataforma. */
  static async readOwnConfig() {
    const stored = await this.readStoredConfig();
    return {
      enabled: stored.enabled === true,
      allowedHosts: parseAllowedHosts(stored.allowedHosts),
      webhookBaseUrl: String(stored.webhookBaseUrl || ''),
      rejectCallMessage: String(stored.rejectCallMessage || DEFAULT_CONFIG.rejectCallMessage),
      portalPublicUrl: String(stored.portalPublicUrl || ''),
      botEnabled: stored.botEnabled !== false,
      botUnlockEnabled: stored.botUnlockEnabled === true,
      rateLimitPerMin: Number(stored.rateLimitPerMin) > 0
        ? Math.min(Number(stored.rateLimitPerMin), 120)
        : DEFAULT_CONFIG.rateLimitPerMin,
      ...lerCadencia(stored),
      mediaRetentionDays: normalizeRetentionDays(stored.mediaRetentionDays),
      messageRetentionDays: normalizeRetentionDays(stored.messageRetentionDays),
      managedUrl: normalizeEvoUrl(stored.managedUrl || ''),
      managedAdminKey: decryptSecret(adminKeyBox, stored.managedAdminKey),
      cloudCallbackUrl: String(stored.cloudCallbackUrl || ''),
      cloudVerifyToken: decryptSecret(metaVerifyBox, stored.cloudVerifyToken)
    };
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const stored = await this.readEffectiveConfig();
    // Um plano ilegível não pode derrubar o WhatsApp: sem teto é o que valia
    // antes de existir teto.
    const caps = await SubscriptionService.retentionCaps().catch(() => ({ media: null, messages: null }));
    const config = {
      enabled: stored.enabled === true,
      allowedHosts: parseAllowedHosts(stored.allowedHosts),
      webhookBaseUrl: String(stored.webhookBaseUrl || ''),
      rejectCallMessage: String(stored.rejectCallMessage || DEFAULT_CONFIG.rejectCallMessage),
      portalPublicUrl: String(stored.portalPublicUrl || ''),
      botEnabled: stored.botEnabled !== false,
      botUnlockEnabled: stored.botUnlockEnabled === true,
      rateLimitPerMin: Number(stored.rateLimitPerMin) > 0
        ? Math.min(Number(stored.rateLimitPerMin), 120)
        : DEFAULT_CONFIG.rateLimitPerMin,
      ...lerCadencia(stored),
      // O que vale, e não só o que foi escolhido: com teto no plano, é o
      // menor dos dois — e é este número que as duas varreduras leem.
      mediaRetentionDays: SubscriptionService.capRetention(
        normalizeRetentionDays(stored.mediaRetentionDays), caps.media
      ),
      messageRetentionDays: SubscriptionService.capRetention(
        normalizeRetentionDays(stored.messageRetentionDays), caps.messages
      ),
      retentionCaps: { media: caps.media, messages: caps.messages },
      managedUrl: normalizeEvoUrl(stored.managedUrl || ''),
      managedAdminKey: decryptSecret(adminKeyBox, stored.managedAdminKey),
      cloudCallbackUrl: String(stored.cloudCallbackUrl || ''),
      cloudVerifyToken: decryptSecret(metaVerifyBox, stored.cloudVerifyToken),
      platformManaged: stored.platformManaged === true,
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  /** The shape the browser is allowed to see: no secret, ever. */
  static async getPublicConfig() {
    const config = await this.getConfig();
    const { managedAdminKey, cloudVerifyToken, ...rest } = config;
    return {
      ...rest,
      managed: Boolean(config.managedUrl),
      managedAdminKeyConfigured: Boolean(managedAdminKey),
      // O webhook da API oficial. Na SaaS o servidor Evolution é da
      // plataforma, e o token de verificação dele (WA_BUSINESS_TOKEN_WEBHOOK)
      // é um só para todos os provedores: ele NÃO sai. O painel registra o
      // webhook na conta WABA de cada número pela Graph API
      // (`MetaWebhookService`), e a tela só mostra o resultado (`auto`).
      //
      // No self-host o servidor é de quem opera o painel, e o token sai como
      // sempre saiu: é dele, e ele pode querer colá-lo à mão no app da Meta.
      cloudWebhook: config.platformManaged
        ? { auto: true }
        : {
          callbackUrl: this.cloudCallbackUrl(config),
          verifyToken: cloudVerifyToken || ''
        },
      ready: this.isReady(config)
    };
  }

  /** Para onde a Meta deve mandar os eventos de um número oficial. */
  static cloudCallbackUrl(config, baseUrl = '') {
    if (config.cloudCallbackUrl) return config.cloudCallbackUrl;
    const servidor = String(baseUrl || config.managedUrl || '').replace(/\/+$/, '');
    return servidor ? `${servidor}${META_WEBHOOK_SUFFIX}` : '';
  }

  static isReady(config) {
    return Boolean(config.enabled && config.webhookBaseUrl);
  }

  static async saveConfig(input = {}) {
    // Provedor gerenciado não escreve o servidor: os campos dele são ignorados
    // em vez de recusados, porque a tela manda o formulário inteiro e o que
    // importa é que eles não sejam gravados — nem aqui, nem por cima dos da
    // plataforma.
    const managed = await platformManagesCurrentTenant();
    const patch = { ...input };
    if (managed) for (const field of WA_SERVER_FIELDS) delete patch[field];
    // O que ESTE tenant guardou, e não o efetivo: o efetivo já vem limitado
    // pelo teto do plano, e regravá-lo trocaria em silêncio a escolha do
    // provedor pelo teto.
    const current = await this.readOwnConfig();

    // Acima do teto do plano é recusado, e não cortado: o provedor precisa
    // saber que o número que ele digitou não é o que vai valer. "Para sempre"
    // (zero) com teto é acima dele por definição.
    const caps = await SubscriptionService.retentionCaps().catch(() => ({ media: null, messages: null }));
    for (const [field, cap] of [['mediaRetentionDays', caps.media], ['messageRetentionDays', caps.messages]]) {
      if (patch[field] === undefined || cap === null) continue;
      const days = normalizeRetentionDays(patch[field]);
      if (days === 0 || days > cap) {
        throw new WaError('whatsapp.error.retentionAboveCap', {
          code: 'retention_above_cap',
          status: 422,
          vars: { max: cap }
        });
      }
    }
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      allowedHosts: patch.allowedHosts === undefined
        ? current.allowedHosts
        : parseAllowedHosts(patch.allowedHosts),
      webhookBaseUrl: patch.webhookBaseUrl === undefined
        ? current.webhookBaseUrl
        : this.normalizeWebhookBaseUrl(patch.webhookBaseUrl),
      rejectCallMessage: patch.rejectCallMessage === undefined
        ? current.rejectCallMessage
        : String(patch.rejectCallMessage).trim().slice(0, 300),
      portalPublicUrl: patch.portalPublicUrl === undefined
        ? current.portalPublicUrl
        : this.normalizePublicUrl(
          patch.portalPublicUrl,
          'whatsapp.error.invalidPortalUrl',
          'invalid_portal_url'
        ),
      botEnabled: patch.botEnabled === undefined
        ? current.botEnabled
        : patch.botEnabled !== false,
      botUnlockEnabled: patch.botUnlockEnabled === undefined
        ? current.botUnlockEnabled
        : patch.botUnlockEnabled === true,
      mediaRetentionDays: patch.mediaRetentionDays === undefined
        ? current.mediaRetentionDays
        : normalizeRetentionDays(patch.mediaRetentionDays),
      messageRetentionDays: patch.messageRetentionDays === undefined
        ? current.messageRetentionDays
        : normalizeRetentionDays(patch.messageRetentionDays),
      rateLimitPerMin: patch.rateLimitPerMin === undefined
        ? current.rateLimitPerMin
        : Math.min(Math.max(Number(patch.rateLimitPerMin) || DEFAULT_CONFIG.rateLimitPerMin, 1), 120),
      // Campo a campo sobre o que já vale, para que um PATCH que só fala do
      // intervalo não devolva a pausa ao padrão.
      ...lerCadencia(patch, lerCadencia(current)),
      managedUrl: patch.managedUrl === undefined
        ? current.managedUrl
        : normalizeEvoUrl(patch.managedUrl),
      cloudCallbackUrl: patch.cloudCallbackUrl === undefined
        ? current.cloudCallbackUrl
        : this.normalizePublicUrl(
          patch.cloudCallbackUrl,
          'whatsapp.error.invalidCloudCallbackUrl',
          'invalid_cloud_callback_url'
        ),
      updatedAt: new Date().toISOString()
    };

    // An omitted key keeps the stored secret; an explicit empty string clears
    // it, so the integration can be revoked without wiping the setup.
    let managedAdminKey = current.managedAdminKey;
    if (patch.managedAdminKey !== undefined) managedAdminKey = String(patch.managedAdminKey).trim();
    let cloudVerifyToken = current.cloudVerifyToken;
    if (patch.cloudVerifyToken !== undefined) cloudVerifyToken = String(patch.cloudVerifyToken).trim().slice(0, 255);

    // O servidor do provedor gerenciado é o da plataforma: é ELE que precisa
    // de webhook. O que o provedor tinha guardado de antes fica como estava —
    // não é lido enquanto a plataforma manda, e apagar seria destruir o que
    // ninguém pediu para destruir.
    const webhookEfetivo = managed ? (await this.getConfig()).webhookBaseUrl : next.webhookBaseUrl;
    if (next.enabled && !webhookEfetivo) {
      throw new WaError('whatsapp.error.incompleteConfig', {
        code: 'incomplete_config',
        status: 400
      });
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      ...next,
      managedAdminKey: managedAdminKey ? encryptSecret(adminKeyBox, managedAdminKey) : null,
      cloudVerifyToken: cloudVerifyToken ? encryptSecret(metaVerifyBox, cloudVerifyToken) : null
    }));
    // A caixa da plataforma, na SaaS, acabou de trocar o servidor de TODO
    // provedor — cada um guarda a sua cópia mesclada no cache, então aqui é
    // `clear` e não `invalidate`.
    if (IS_SAAS && !managed && (await Tenant.findById(currentTenantId()))?.kind === 'platform') {
      this.configCache.clear();
    } else {
      this.invalidateConfigCache();
    }
    return this.getPublicConfig();
  }

  /**
   * The webhook URL has to be absolute and reachable from outside — it is
   * written into the Evolution server, not into a browser.
   *
   * Plain http is accepted because a lab Evolution on the same LAN is a real
   * setup, but the host still goes through the SSRF literal check at use time.
   */
  /**
   * O endereço do webhook, com o caminho do painel garantido.
   *
   * Ao contrário da URL do portal, ESTE endereço não é só um host: é a rota
   * exata que o servidor Evolution vai chamar. A tela pedia um host — rótulo
   * "URL pública", exemplo `https://painel.exemplo.com`, ajuda falando de
   * hostname — e o código usava o que fosse digitado como endereço completo.
   * Quem seguia a tela gravava um endereço apontando para a RAIZ do painel: o
   * POST cai no frontend, que responde 200 com HTML, e o Evolution registra
   * entrega bem-sucedida enquanto nada chega. Aconteceu em produção.
   *
   * Agora a origem sozinha recebe o caminho, e um caminho que não seja o do
   * painel é recusado com o sufixo na mensagem.
   */
  static normalizeWebhookBaseUrl(raw) {
    const limpo = this.normalizePublicUrl(raw, 'whatsapp.error.invalidWebhookUrl', 'invalid_webhook_url');
    if (!limpo) return '';
    const { origin, pathname } = new URL(limpo);
    const resultado = withWebhookPath(origin, pathname);
    if (resultado.erro) {
      throw new WaError('whatsapp.error.webhookUrlPath', {
        code: 'invalid_webhook_url',
        status: 400,
        vars: { path: WA_WEBHOOK_PATH }
      });
    }
    return resultado.url;
  }

  /**
   * An address that has to work from outside this process.
   *
   * Shared by the webhook URL and the portal URL because the checks are the
   * same ones for both reasons: an address that is not absolute, not http(s),
   * or carries credentials is not something to write into a third-party server
   * or to send to a customer.
   *
   * The `code` stays per FIELD rather than per check, so all three failures on
   * the portal URL say `invalid_portal_url` and the form can put the message on
   * the input that caused it. The message itself is per check, because "must be
   * http or https" is the useful sentence and "invalid" is not.
   */
  static normalizePublicUrl(raw, key, code) {
    const text = String(raw || '').trim();
    if (!text) return '';
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new WaError(key, { code, status: 400 });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new WaError('whatsapp.error.publicUrlProtocol', { code, status: 400 });
    }
    if (url.username || url.password) {
      throw new WaError('whatsapp.error.publicUrlCredentials', { code, status: 400 });
    }
    // Query and hash are stripped because the secret is appended as `?t=` later;
    // an existing query would make the token stop parsing as one.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }

  // ── Per-account secrets ────────────────────────────────────────────

  static encryptInstanceToken(token) {
    const box = encryptSecret(instanceTokenBox, token);
    return {
      token_ciphertext: box.password_ciphertext,
      token_iv: box.password_iv,
      token_tag: box.password_tag,
      token_key_version: box.password_key_version
    };
  }

  static decryptInstanceToken(row) {
    return instanceTokenBox.decrypt({
      password_ciphertext: row?.token_ciphertext,
      password_iv: row?.token_iv,
      password_tag: row?.token_tag,
      password_key_version: row?.token_key_version
    }) ?? '';
  }

  static encryptWebhookToken(token) {
    const box = encryptSecret(webhookTokenBox, token);
    return {
      webhook_token_ciphertext: box.password_ciphertext,
      webhook_token_iv: box.password_iv,
      webhook_token_tag: box.password_tag,
      webhook_token_key_version: box.password_key_version
    };
  }

  static decryptWebhookToken(row) {
    return webhookTokenBox.decrypt({
      password_ciphertext: row?.webhook_token_ciphertext,
      password_iv: row?.webhook_token_iv,
      password_tag: row?.webhook_token_tag,
      password_key_version: row?.webhook_token_key_version
    }) ?? '';
  }

  /**
   * The account shape the browser may see.
   *
   * Built field by field rather than by deleting keys from the row — the same
   * reason `evolutionApi.readInstances()` does it, and the reason is that a
   * column added later would otherwise leak by default.
   */
  static publicAccount(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      label: row.label || null,
      purpose: row.purpose,
      // A cor do número na caixa de entrada. Não é segredo: sai para quem lê.
      color: row.color || null,
      flavor: row.flavor,
      // `cloud` é o número oficial da Meta; os ids da Meta não são segredo —
      // o token, que é, não sai daqui.
      integration: row.integration === 'cloud' ? 'cloud' : 'baileys',
      metaPhoneNumberId: row.meta_phone_number_id || null,
      metaWabaId: row.meta_waba_id || null,
      metaTemplatesSyncedAt: row.meta_templates_synced_at || null,
      metaTemplatesError: row.meta_templates_error || null,
      // O registro do webhook na Meta (`MetaWebhookService`): o resultado da
      // última tentativa, nunca o token de verificação.
      metaWebhookStatus: row.meta_webhook_status === 'ok' || row.meta_webhook_status === 'error'
        ? row.meta_webhook_status
        : null,
      metaWebhookError: row.meta_webhook_error || null,
      metaWebhookAt: row.meta_webhook_at || null,
      baseUrl: row.base_url,
      status: row.status,
      // O QR NÃO sai daqui.
      //
      // Este serializador serve `GET /accounts` e `/accounts/:id/status`, que
      // pedem `whatsapp.read` — e a rota dedicada ao QR pede `whatsapp.config`,
      // de propósito. Deixar o código aqui desfazia essa decisão: um `tech`,
      // que tem `read` e não tem `config`, fazia polling na listagem durante
      // uma reconexão, lia o QR e pareava o próprio celular ao número do
      // provedor — passando a receber a caixa de entrada dos assinantes e a
      // falar COMO o provedor.
      //
      // `qrUpdatedAt` fica: é carimbo de tempo, não credencial, e é o que
      // deixa a tela mostrar a idade real do código em vez de sessenta
      // segundos cheios por um instante.

      qrUpdatedAt: row.qr_updated_at || null,
      phoneE164: row.phone_e164 || null,
      isDefault: Boolean(row.is_default),
      lastSeenAt: row.last_seen_at || null,
      lastError: row.last_error || null,
      // A conferência do webhook. `webhook_server_url` já está guardada com o
      // token redigido — ver a coluna —, então ela pode sair daqui; a URL
      // esperada NÃO sai, porque essa carrega o token inteiro.
      webhookVerdict: row.webhook_verdict || null,
      webhookServerUrl: row.webhook_server_url || null,
      webhookCheckedAt: row.webhook_checked_at || null,
      // A volta. Separada do veredito de configuração porque responde outra
      // pergunta, e porque as duas se contradizendo é o que o operador precisa
      // ver: `ok` aqui em cima com `wrong_target` aqui embaixo significa que o
      // servidor tem exatamente o endereço que o painel mandou — e que aquele
      // endereço não chega no painel.
      webhookProbeVerdict: row.webhook_probe_verdict || null,
      webhookProbedAt: row.webhook_probed_at || null,
      webhookRefusedAt: row.webhook_refused_at || null,
      webhookRefusedReason: row.webhook_refused_reason || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }
}

export { CONFIG_KEY, DEFAULT_CONFIG };
export default WhatsAppConfigService;
