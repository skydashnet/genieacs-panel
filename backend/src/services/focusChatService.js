import AppState from '../models/AppState.js';
import { createSecretBox } from '../utils/secretBox.js';
import { PinnedTransport, RESPONSE_TOO_LARGE } from '../utils/net/pinnedFetch.js';
import { deploymentIsShared } from './genieacsEgress.js';
import { TenantCache } from '../config/tenantCache.js';

/**
 * Focus Chat — the helpdesk the provider talks to its subscribers through.
 *
 * The panel only READS from it: the contact book (`GET /core/v2/api/contacts/list`,
 * paged by a `next` cursor), so the Contacts screen can import the people the
 * provider already talks to. The API authenticates with the channel's token in
 * an `access-token` header; it is stored encrypted, per tenant, like the SGP
 * token. The address is the vendor's and is not configurable, so the token can
 * only ever go there.
 */

const CONFIG_KEY = 'focuschat_integration_config';
const CONFIG_CACHE_TTL_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export const FOCUSCHAT_BASE_URL = 'https://api.focuschat.com.br';
export const CONTACTS_LIST_PATH = '/core/v2/api/contacts/list';
/** A guard against a cursor that never ends; at ~100 per page, far beyond any book. */
const MAX_PAGES = 500;

const tokenBox = createSecretBox('skygenpanel-focuschat-token-v1');

/** Same contract as `SgpError`: the message is a translation key unless `raw`. */
export class FocusChatError extends Error {
  constructor(message, { code = 'focuschat_error', status = 502, details = null, vars = null, raw = false } = {}) {
    super(message);
    this.name = 'FocusChatError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (!raw) {
      this.translationKey = message;
      this.translationVars = vars;
    }
  }
}

function text(value, max = 255) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/** The API's own words for a refusal: `{ status, msg, errorCode }`. */
function apiMessage(data) {
  const message = data && typeof data === 'object' ? (data.msg ?? data.message) : null;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : null;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One contact as the import needs it. */
export function normalizeContact(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((tag) => text(tag?.name ?? tag?.title ?? tag, 60)).filter(Boolean)
    : [];
  return {
    id: text(entry.id, 64),
    name: text(entry.name) || text(entry.nameFromWhatsApp) || text(entry.nickName),
    number: text(entry.number, 40),
    email: text(entry.email, 254),
    observation: text(entry.observation, 1000),
    tags,
    isGroup: entry.isGroup === true,
    // 0 is WhatsApp; a Facebook or Instagram contact has no phone to talk to.
    type: Number.isInteger(entry.type) ? entry.type : 0
  };
}

class FocusChatService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /** Read by `this`, so a test can point it at a stub. */
  static BASE_URL = FOCUSCHAT_BASE_URL;
  static REQUEST_TIMEOUT_MS = 20_000;
  /** Waits before each retry of a 429; a test shortens them. */
  static RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
  /** Pause between pages: the API allows 50 requests a second per token. */
  static PAGE_DELAY_MS = 50;

  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { enabled: false, token: null };
    try {
      return { enabled: false, token: null, ...JSON.parse(raw) };
    } catch {
      return { enabled: false, token: null };
    }
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const stored = await this.readStoredConfig();
    const config = {
      enabled: stored.enabled === true,
      token: stored.token ? (tokenBox.decrypt(stored.token) ?? '') : '',
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  static async getPublicConfig() {
    const { token, ...rest } = await this.getConfig();
    return { ...rest, tokenConfigured: Boolean(token), ready: this.isReady({ ...rest, token }) };
  }

  static isReady(config) {
    return Boolean(config?.enabled && config.token);
  }

  static requireReady(config) {
    if (!this.isReady(config)) {
      throw new FocusChatError('focuschat.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    return config;
  }

  /** An absent field keeps its value; `token: ""` clears the token. */
  static async saveConfig(patch = {}) {
    const stored = await this.readStoredConfig();
    const next = {
      enabled: patch.enabled === undefined ? stored.enabled === true : patch.enabled === true,
      token: stored.token ?? null,
      updatedAt: new Date().toISOString()
    };
    if (patch.token !== undefined) {
      const token = String(patch.token ?? '').trim();
      if (token.length > 1024) {
        throw new FocusChatError('focuschat.error.tokenInvalid', { code: 'invalid_token', status: 400 });
      }
      next.token = token ? { v: 1, ...tokenBox.encrypt(token) } : null;
    }
    if (next.enabled && !next.token) {
      throw new FocusChatError('focuschat.error.tokenMissing', { code: 'not_configured', status: 400 });
    }
    await AppState.upsert(CONFIG_KEY, JSON.stringify(next));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /** One GET, with the egress guard the other integrations use. */
  static async rawGet(path, query, token) {
    let url;
    try {
      url = new URL(`${this.BASE_URL}${path}`);
    } catch {
      throw new FocusChatError('focuschat.error.unreachable', { code: 'unreachable', status: 502 });
    }
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    let response;
    try {
      const addresses = await PinnedTransport.vetTarget(hostname, {
        signal: controller.signal,
        allowPrivateAddresses: !deploymentIsShared(),
        refuse: () => new FocusChatError('focuschat.error.unreachable', { code: 'blocked_host', status: 502 })
      });
      controller.signal.throwIfAborted();
      if (addresses.length === 0) {
        throw new FocusChatError('focuschat.error.unreachable', { code: 'unreachable', status: 502 });
      }
      response = await PinnedTransport.request({
        url,
        hostname,
        addresses,
        method: 'GET',
        headers: { Accept: 'application/json', 'access-token': token },
        signal: controller.signal,
        maxBytes: MAX_RESPONSE_BYTES
      });
    } catch (error) {
      if (error instanceof FocusChatError) throw error;
      if (error.name === 'AbortError' || error.name === 'TimeoutError' || controller.signal.aborted) {
        throw new FocusChatError('focuschat.error.timeout', { code: 'timeout', status: 504 });
      }
      if (error.code === RESPONSE_TOO_LARGE) {
        throw new FocusChatError('focuschat.error.invalidResponse', { code: 'invalid_response', status: 502 });
      }
      throw new FocusChatError('focuschat.error.unreachable', { code: 'unreachable', status: 502 });
    } finally {
      clearTimeout(timeoutId);
    }
    const body = await response.text().catch(() => '');
    let data = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }

  /** A GET that waits out the rate limit and turns a refusal into its error. */
  static async get(path, query, token) {
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- a retry follows the answer before it
      const { status, data } = await this.rawGet(path, query, token);
      if (status === 429 && attempt < this.RETRY_DELAYS_MS.length) {
        // eslint-disable-next-line no-await-in-loop -- backing off is the point
        await sleep(this.RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (status >= 200 && status < 300) {
        if (!data || typeof data !== 'object') {
          throw new FocusChatError('focuschat.error.invalidResponse', { code: 'invalid_response', status: 502 });
        }
        return data;
      }
      throw this.failure(status, data);
    }
  }

  static failure(status, data) {
    const errorCode = String(data?.errorCode ?? '');
    if (status === 401 || status === 403 || errorCode.startsWith('auth')) {
      return new FocusChatError('focuschat.error.tokenRejected', { code: 'unauthorized', status: 502 });
    }
    if (status === 429) {
      return new FocusChatError('focuschat.error.rateLimited', { code: 'rate_limited', status: 502 });
    }
    const message = apiMessage(data);
    if (message) return new FocusChatError(message, { code: 'rejected', status: 502, raw: true });
    return new FocusChatError('focuschat.error.status', { code: 'http_error', status: 502, vars: { status } });
  }

  /** Every contact of the channel's organization, following the cursor to its end. */
  static async listContacts(configOverride = null) {
    const config = this.requireReady(configOverride || await this.getConfig());
    const contacts = [];
    const seenCursors = new Set();
    let next = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (page > 0) {
        // eslint-disable-next-line no-await-in-loop -- pacing, under the API's per-second limit
        await sleep(this.PAGE_DELAY_MS);
      }
      // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before
      const data = await this.get(CONTACTS_LIST_PATH, next ? { next } : {}, config.token);
      const entries = Array.isArray(data.data) ? data.data : [];
      for (const entry of entries) {
        const contact = normalizeContact(entry);
        if (contact) contacts.push(contact);
      }
      const cursor = text(data.paging?.cursors?.next, 2048);
      if (!cursor || entries.length === 0 || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      next = cursor;
    }
    return contacts;
  }

  /** Whether the token works: the first page, nothing written anywhere. */
  static async testConnection(patch = {}) {
    const current = await this.getConfig();
    const token = String(patch.token ?? '').trim() || current.token;
    if (!token) {
      throw new FocusChatError('focuschat.error.tokenMissing', { code: 'not_configured', status: 400 });
    }
    const started = Date.now();
    const data = await this.get(CONTACTS_LIST_PATH, {}, token);
    return {
      ok: true,
      firstPage: Array.isArray(data.data) ? data.data.length : 0,
      durationMs: Date.now() - started
    };
  }
}

export default FocusChatService;
