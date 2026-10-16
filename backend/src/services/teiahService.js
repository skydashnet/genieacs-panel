import AppState from '../models/AppState.js';
import TeiahConsultation from '../models/TeiahConsultation.js';
import { createSecretBox } from '../utils/secretBox.js';
import { PinnedTransport, RESPONSE_TOO_LARGE } from '../utils/net/pinnedFetch.js';
import { deploymentIsShared } from './genieacsEgress.js';
import { TenantCache } from '../config/tenantCache.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/**
 * TeiaH Valid — a shared base of addresses that left a provider owing money.
 *
 * The panel feeds it: every SGP contract that was cancelled with invoices
 * still open goes to `POST /api/import/addresses` as an `ImportAddressDto`
 * (street, number, district, city, UF, CEP, the amount owed and the start and
 * cancellation months). What goes is the ADDRESS and the debt — never a name,
 * a document or a phone: the DTO has no field for them, and the panel does not
 * add one. `teiahExportService.js` decides what to send; this file only holds
 * the configuration and speaks to the API.
 *
 * The API authenticates with an `x-api-key` header. The key is the provider's
 * own, per tenant, and is stored encrypted like the SGP token.
 */

const CONFIG_KEY = 'teiah_integration_config';
const CONFIG_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const DEFAULT_BASE_URL = 'https://api.valid.teiah.ai';
export const IMPORT_ONE_PATH = '/api/import/address';
export const IMPORT_MANY_PATH = '/api/import/addresses';
export const CONSULT_DOCUMENT_PATH = '/api/whatsapp/consulta-cpf';
/**
 * Each consultation is a paid call: an answer is reused for this long before
 * the panel asks again. "Not found" is kept for less, since the TeiaH may come
 * to know the document.
 */
export const CONSULT_CACHE_DAYS = 30;
export const CONSULT_MISS_CACHE_DAYS = 7;

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: DEFAULT_BASE_URL,
  exportEnabled: false,
  exportIntervalHours: 24,
  batchSize: 50,
  rentalDefault: 'omit'
});

/** What `aluguel` says when the SGP does not: leave it out, or always false/true. */
export const RENTAL_DEFAULTS = Object.freeze(['omit', 'false', 'true']);

const apiKeyBox = createSecretBox('skygenpanel-teiah-apikey-v1');

function encryptApiKey(key) {
  return { v: 1, ...apiKeyBox.encrypt(key) };
}

function decryptApiKey(box) {
  return box ? (apiKeyBox.decrypt(box) ?? '') : '';
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** Same contract as `SgpError`: the message is a translation key unless `raw`. */
export class TeiahError extends Error {
  constructor(message, { code = 'teiah_error', status = 502, details = null, vars = null, raw = false } = {}) {
    super(message);
    this.name = 'TeiahError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (!raw) {
      this.translationKey = message;
      this.translationVars = vars;
    }
  }
}

/** The API's own words for a refusal, when it sent any (NestJS: `message`, a string or a list). */
function apiMessage(data) {
  const message = data && typeof data === 'object' ? (data.message ?? data.error ?? data.msg) : null;
  if (Array.isArray(message)) return message.map(String).join('; ').slice(0, 500) || null;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : null;
}

/** A key compared the way the SGP's `pick` does: accents, case and punctuation aside. */
function normalizeKey(key) {
  return String(key).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(source, names) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const index = new Map(Object.entries(source).map(([key, value]) => [normalizeKey(key), value]));
  for (const name of names) {
    const value = index.get(normalizeKey(name));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function text(value, max = 255) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/** A section of the `mix`: `{ data: ... }` or the data itself. */
function section(mix, names) {
  const found = pick(mix, names);
  if (found && typeof found === 'object' && !Array.isArray(found) && 'data' in found) return found.data;
  return found;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

/** DD/MM/AAAA, AAAA-MM-DD or an ISO moment → AAAA-MM-DD. */
function isoDate(value) {
  const raw = text(value, 40);
  if (!raw) return null;
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

function truthy(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 's', 'sim', 'y', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

function addressFrom(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const type = text(pick(entry, ['tipoLogradouro', 'tipo_logradouro', 'tipo']), 40);
  const street = text(pick(entry, ['logradouro', 'endereco', 'rua', 'street']));
  const address = {
    street: street && type && !street.toLowerCase().startsWith(type.toLowerCase()) ? `${type} ${street}` : street,
    number: text(pick(entry, ['numero', 'num', 'number']), 32),
    complement: text(pick(entry, ['complemento', 'complement'])),
    district: text(pick(entry, ['bairro', 'district'])),
    city: text(pick(entry, ['cidade', 'municipio', 'city'])),
    state: text(pick(entry, ['uf', 'estado', 'state']), 2)?.toUpperCase() ?? null,
    zip: String(pick(entry, ['cep', 'zip']) ?? '').replace(/\D/g, '').slice(0, 8) || null
  };
  return Object.values(address).some(Boolean)
    ? Object.fromEntries(Object.entries(address).filter(([, value]) => value))
    : null;
}

const ADDRESS_KEYS = ['cep', 'zip', 'logradouro', 'bairro', 'cidade', 'municipio', 'uf'];

/**
 * Every address-looking object of an answer (max 5): the net under the lookups
 * by name. The sections' names were guessed from a partial sample, and a
 * company's record keeps its address elsewhere than a person's. Bounded in
 * depth and width: the answer is 25 KB at most. Every object of an answer (max 5), in the order the answer holds them. */
function findAddresses(root) {
  const found = [];
  walk(root, (node) => {
    if (Array.isArray(node) || found.length >= 5) return;
    const keys = new Set(Object.keys(node).map(normalizeKey));
    if (keys.has('cep') || keys.has('logradouro') || ADDRESS_KEYS.filter((key) => keys.has(key)).length >= 2) {
      const address = addressFrom(node);
      if (address) found.push(address);
    }
  });
  return found;
}

/** Every object and array in an answer, depth-first, bounded like `findAddresses`. */
function walk(node, visit, depth = 0, budget = { left: 2000 }) {
  if (!node || typeof node !== 'object' || depth > 6 || budget.left <= 0) return;
  budget.left -= 1;
  visit(node);
  for (const value of Array.isArray(node) ? node.slice(0, 50) : Object.values(node).slice(0, 60)) {
    walk(value, visit, depth + 1, budget);
  }
}

/** Phones the named sections did not carry: entries with `ddd`+number or a phone-named field. */
function scanPhones(root) {
  const found = [];
  walk(root, (node) => {
    if (Array.isArray(node)) return;
    const keys = new Set(Object.keys(node).map(normalizeKey));
    const looksLikePhone = (keys.has('ddd') && (keys.has('numero') || keys.has('telefone')))
      || keys.has('telefone') || keys.has('celular') || keys.has('fone');
    if (looksLikePhone) {
      const phone = phoneFrom(node);
      if (phone) found.push(phone);
    }
  });
  return found;
}

/** E-mails the named sections did not carry: any string under an `email`-named key. */
function scanEmails(root) {
  const found = [];
  walk(root, (node) => {
    if (Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (!normalizeKey(key).includes('email')) continue;
      const email = text(value)?.toLowerCase();
      if (email && /^[^\s@]+@[^\s@]+$/.test(email)) found.push(email);
    }
  });
  return found;
}

function phoneFrom(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== 'object') return normalizarTelefoneBr(entry);
  const ddd = String(pick(entry, ['ddd', 'codigoArea']) ?? '').replace(/\D/g, '');
  const number = String(pick(entry, ['numero', 'telefone', 'fone', 'phone', 'celular']) ?? '').replace(/\D/g, '');
  return normalizarTelefoneBr(number.length <= 9 && ddd ? `${ddd}${number}` : number);
}

/**
 * What the "Novo cliente" form uses out of a `consulta-cpf` answer — the rest
 * of it (25 KB of a person's life) is neither kept nor sent to the browser.
 *
 * The answer's shape as seen: `resultado.mix.{score,emails,pessoa}.data`; the
 * address and phone sections were not in view, so every section and field is
 * looked up under several names, the way the SGP's are.
 */
export function normalizeConsult(payload) {
  const root = pick(payload, ['resultado', 'result', 'data']) ?? payload;
  const mix = pick(root, ['mix']) ?? root;
  if (!mix || typeof mix !== 'object') return { found: false };

  const person = section(mix, ['pessoa', 'pessoaFisica', 'dadosCadastrais', 'cadastro']) ?? {};
  const company = section(mix, ['empresa', 'pessoaJuridica', 'dadosEmpresa']) ?? {};
  const scoreData = section(mix, ['score']) ?? {};

  const name = text(pick(person, ['nome', 'nomeCompleto', 'name']))
    ?? text(pick(company, ['razaoSocial', 'razao_social', 'nome']));
  const tradeName = text(pick(company, ['nomeFantasia', 'nome_fantasia', 'fantasia']));

  const namedEmails = asList(section(mix, ['emails', 'email']))
    .map((entry) => text(typeof entry === 'object' ? pick(entry, ['email', 'endereco', 'valor']) : entry)?.toLowerCase())
    .filter((email) => email && /^[^\s@]+@[^\s@]+$/.test(email));
  const emails = [...new Set(namedEmails.length ? namedEmails : scanEmails(mix))];

  // Mobiles first: the form's number is the one WhatsApp reaches.
  const namedPhones = asList(section(mix, ['telefones', 'celulares', 'telefone', 'phones'])).map(phoneFrom).filter(Boolean);
  const phones = [...new Set(namedPhones.length ? namedPhones : scanPhones(mix))]
    .sort((a, b) => Number(b.length === 13) - Number(a.length === 13));

  const namedAddresses = asList(section(mix, ['enderecos', 'endereco', 'addresses']))
    .map(addressFrom)
    .filter(Boolean);
  const seenAddress = new Set();
  const addresses = (namedAddresses.length ? namedAddresses : findAddresses(mix)).filter((address) => {
    const key = [address.zip, address.street, address.number].join('|').toLowerCase();
    if (seenAddress.has(key)) return false;
    seenAddress.add(key);
    return true;
  }).slice(0, 5);

  const scoreValue = Number(pick(scoreData, ['score', 'pontuacao']));
  const score = Number.isFinite(scoreValue) || text(pick(scoreData, ['risco', 'descricaoPagamento']))
    ? {
      score: Number.isFinite(scoreValue) ? scoreValue : null,
      risk: text(pick(scoreData, ['risco', 'faixaRisco'])),
      paymentDescription: text(pick(scoreData, ['descricaoPagamento'])),
      paymentProbability: text(pick(scoreData, ['probabilidadePagamento']))
    }
    : null;

  const result = {
    found: Boolean(name || emails.length || phones.length || addresses.length),
    name,
    tradeName,
    birthDate: isoDate(pick(person, ['dataNascimento', 'nascimento', 'data_nascimento', 'dataNasc']))
      ?? isoDate(pick(company, ['dataAbertura', 'dataFundacao', 'fundacao'])),
    motherName: text(pick(person, ['nomeMae', 'nome_mae', 'mae'])),
    deceased: truthy(pick(person, ['obito', 'falecido'])),
    emails,
    phones,
    address: addresses[0] ?? null,
    addresses,
    score
  };
  return result;
}

class TeiahService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /** Read by `this`, so a test can prove the deadline without waiting for it. */
  static REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static normalizeBaseUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return DEFAULT_BASE_URL;
    let url;
    try {
      url = new URL(text.includes('://') ? text : `https://${text}`);
    } catch {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    if (url.username || url.password) {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    // The paths are the API's, not the operator's: a base pasted with `/api`
    // (or the Swagger's `/api/docs`) at the end is the same server.
    const path = url.pathname.replace(/\/+$/, '').replace(/\/api(\/docs)?$/i, '');
    return `${url.origin}${path}`;
  }

  /** Same API address, compared normalized (host case, trailing slash, `/api`). */
  static sameBaseUrl(a, b) {
    return this.normalizeBaseUrl(a) === this.normalizeBaseUrl(b);
  }

  static keyRequiredForNewUrl() {
    return new TeiahError('teiah.error.apiKeyRequiredForNewUrl', { code: 'api_key_required_for_new_url', status: 400 });
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, apiKey: null };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG, apiKey: null };
    }
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const stored = await this.readStoredConfig();
    const config = {
      enabled: stored.enabled === true,
      baseUrl: String(stored.baseUrl || DEFAULT_BASE_URL),
      apiKey: decryptApiKey(stored.apiKey),
      exportEnabled: stored.exportEnabled === true,
      exportIntervalHours: clampNumber(stored.exportIntervalHours, 1, 168, DEFAULT_CONFIG.exportIntervalHours),
      batchSize: clampNumber(stored.batchSize, 1, 500, DEFAULT_CONFIG.batchSize),
      rentalDefault: RENTAL_DEFAULTS.includes(stored.rentalDefault) ? stored.rentalDefault : DEFAULT_CONFIG.rentalDefault,
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  static async getPublicConfig() {
    const config = await this.getConfig();
    const { apiKey, ...rest } = config;
    return {
      ...rest,
      apiKeyConfigured: Boolean(apiKey),
      ready: this.isReady(config)
    };
  }

  static isReady(config) {
    return Boolean(config?.enabled && config.baseUrl && config.apiKey);
  }

  static requireReady(config) {
    if (!this.isReady(config)) {
      throw new TeiahError('teiah.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    return config;
  }

  /**
   * An absent field keeps its value; `apiKey: ""` clears the key, which is how
   * an operator revokes the integration without losing the rest of the setup.
   */
  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const stored = await this.readStoredConfig();
    const baseUrl = patch.baseUrl === undefined ? current.baseUrl : this.normalizeBaseUrl(patch.baseUrl);
    // Moving the base URL without sending the key would hand the stored key
    // to the new host: the key is only kept for the address it was saved for.
    if (patch.apiKey === undefined && stored.apiKey && !this.sameBaseUrl(baseUrl, current.baseUrl)) {
      throw this.keyRequiredForNewUrl();
    }
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      baseUrl,
      exportEnabled: patch.exportEnabled === undefined ? current.exportEnabled : patch.exportEnabled === true,
      exportIntervalHours: patch.exportIntervalHours === undefined
        ? current.exportIntervalHours
        : clampNumber(patch.exportIntervalHours, 1, 168, DEFAULT_CONFIG.exportIntervalHours),
      batchSize: patch.batchSize === undefined
        ? current.batchSize
        : clampNumber(patch.batchSize, 1, 500, DEFAULT_CONFIG.batchSize),
      rentalDefault: RENTAL_DEFAULTS.includes(patch.rentalDefault) ? patch.rentalDefault : current.rentalDefault,
      updatedAt: new Date().toISOString()
    };

    if (patch.apiKey === undefined) {
      next.apiKey = stored.apiKey ?? null;
    } else {
      const key = String(patch.apiKey ?? '').trim();
      if (key.length > 512) {
        throw new TeiahError('teiah.error.apiKeyInvalid', { code: 'invalid_api_key', status: 400 });
      }
      next.apiKey = key ? encryptApiKey(key) : null;
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify(next));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /**
   * One call to the API. The egress guard is the SGP's: in a shared deployment
   * the base URL cannot point into the panel's own network, and the refusal
   * names nothing it learned.
   *
   * @returns {Promise<{ status: number, data: any }>}
   */
  static async request(path, body, configOverride = null) {
    const config = this.requireReady(configOverride || await this.getConfig());
    let url;
    try {
      url = new URL(`${config.baseUrl}${path}`);
    } catch {
      throw new TeiahError('teiah.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    let response;
    try {
      const addresses = await PinnedTransport.vetTarget(hostname, {
        signal: controller.signal,
        allowPrivateAddresses: !deploymentIsShared(),
        refuse: () => new TeiahError('teiah.error.blockedHost', { code: 'blocked_host', status: 400 })
      });
      controller.signal.throwIfAborted();
      if (addresses.length === 0) {
        throw new TeiahError('teiah.error.unreachable', { code: 'unreachable', status: 502 });
      }
      response = await PinnedTransport.request({
        url,
        hostname,
        addresses,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': config.apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        maxBytes: MAX_RESPONSE_BYTES
      });
    } catch (error) {
      if (error instanceof TeiahError) throw error;
      if (error.name === 'AbortError' || error.name === 'TimeoutError' || controller.signal.aborted) {
        throw new TeiahError('teiah.error.timeout', { code: 'timeout', status: 504 });
      }
      if (error.code === RESPONSE_TOO_LARGE) {
        throw new TeiahError('teiah.error.invalidResponse', { code: 'invalid_response', status: 502 });
      }
      throw new TeiahError('teiah.error.unreachable', { code: 'unreachable', status: 502 });
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await response.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }

  /** A non-2xx answer as the error it means. */
  static failure(status, data) {
    if (status === 401 || status === 403) {
      return new TeiahError('teiah.error.credentialsRejected', { code: 'unauthorized', status: 502 });
    }
    if (status === 429) {
      return new TeiahError('teiah.error.rateLimited', { code: 'rate_limited', status: 502 });
    }
    return new TeiahError('teiah.error.status', {
      vars: { status },
      code: status >= 400 && status < 500 ? 'rejected' : 'http_error',
      status: 502,
      details: apiMessage(data) || undefined
    });
  }

  static async importOne(item, configOverride = null) {
    const { status, data } = await this.request(IMPORT_ONE_PATH, item, configOverride);
    if (status < 200 || status >= 300) throw this.failure(status, data);
    return data;
  }

  /**
   * A batch, and what to do when the batch is refused.
   *
   * The Swagger documents the batch body as `string[]`, which is almost
   * certainly an annotation slip for `ImportAddressDto[]` — but if a release
   * validates it literally, a batch answers 400 while the same items go
   * through one by one. So a batch refused with a 400/422 is retried item by
   * item, and each item's own outcome is what is recorded. A 401 or a 5xx is
   * not a shape problem, and is raised for the whole batch.
   *
   * @returns {Promise<Array<{ ok: boolean, error?: TeiahError }>>} one entry per item, in order
   */
  static async importMany(items, configOverride = null) {
    if (!items.length) return [];
    const config = configOverride || await this.getConfig();
    const { status, data } = await this.request(IMPORT_MANY_PATH, items, config);
    if (status >= 200 && status < 300) return items.map(() => ({ ok: true }));
    if (status !== 400 && status !== 422) throw this.failure(status, data);

    const outcomes = [];
    for (const item of items) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one at a time, it is the fallback
        await this.importOne(item, config);
        outcomes.push({ ok: true });
      } catch (error) {
        if (!(error instanceof TeiahError) || error.code === 'unauthorized' || error.code === 'timeout') throw error;
        outcomes.push({ ok: false, error });
      }
    }
    return outcomes;
  }

  /**
   * The TeiaH's record of a CPF/CNPJ, normalized — see `normalizeConsult`.
   * Asked only by an operator filling "Novo cliente" for someone the SGP does
   * not know.
   */
  /**
   * `consultDocument` behind the panel's memory of what it already paid for:
   * an answer younger than `CONSULT_CACHE_DAYS` (a miss, `CONSULT_MISS_CACHE_DAYS`)
   * comes back without calling the API. `fresh` asks anyway and replaces what
   * was kept. A failure is thrown and never kept.
   *
   * @returns {Promise<{ result: object, consultedAt: string, cached: boolean }>}
   */
  static async consultCached(document, { fresh = false } = {}) {
    const digits = String(document ?? '').replace(/\D/g, '');
    if (!fresh) {
      const stored = await TeiahConsultation.get(digits);
      if (stored) {
        const days = stored.data.found === false ? CONSULT_MISS_CACHE_DAYS : CONSULT_CACHE_DAYS;
        if (Date.now() - stored.consultedAt.getTime() < days * 86_400_000) {
          return { result: stored.data, consultedAt: stored.consultedAt.toISOString(), cached: true };
        }
      }
    }
    const result = await this.consultDocument(digits);
    const saved = await TeiahConsultation.save(digits, result);
    return { result, consultedAt: saved.consultedAt.toISOString(), cached: false };
  }

  static async consultDocument(document, configOverride = null) {
    const digits = String(document ?? '').replace(/\D/g, '');
    const { status, data } = await this.request(CONSULT_DOCUMENT_PATH, { cpf: digits }, configOverride);
    if (status === 404) return { found: false };
    if (status < 200 || status >= 300) throw this.failure(status, data);
    const result = normalizeConsult(data);
    if (result.found && !result.address) {
      // Only the names of the sections, never their content: enough to see where
      // an address hides without logging a person's record.
      const mix = pick(pick(data, ['resultado', 'result', 'data']) ?? data, ['mix']) ?? {};
      console.warn(`TeiaH answer without an address; sections: ${Object.keys(mix).join(', ') || '-'}`);
    }
    return result;
  }

  /**
   * Whether the key is accepted, WITHOUT writing anything to the TeiaH base:
   * an empty batch. A key the API refuses answers 401/403 before the body is
   * looked at; any other answer — 201 for an empty import, or 400 for "empty
   * list not allowed" — means the server is there and the key went through.
   */
  static async testConnection(patch = {}) {
    const current = await this.getConfig();
    const typed = String(patch.apiKey ?? '').trim();
    // An empty field means "the one already configured", as the screen sends it.
    const baseUrl = patch.baseUrl === undefined || String(patch.baseUrl ?? '').trim() === ''
      ? current.baseUrl
      : this.normalizeBaseUrl(patch.baseUrl);
    // The stored key only goes to the address it was saved for; anywhere else
    // needs a key typed on the screen, refused before any request leaves.
    if (!typed && current.apiKey && !this.sameBaseUrl(baseUrl, current.baseUrl)) {
      throw this.keyRequiredForNewUrl();
    }
    const apiKey = typed || current.apiKey;
    if (!apiKey) {
      throw new TeiahError('teiah.error.apiKeyMissing', { code: 'not_configured', status: 400 });
    }
    const config = { ...current, enabled: true, baseUrl, apiKey };
    const started = Date.now();
    const { status } = await this.request(IMPORT_MANY_PATH, [], config);
    // A 404 is a base URL that is not the API's — not a working connection.
    const accepted = (status >= 200 && status < 300) || status === 400 || status === 422;
    if (!accepted) throw this.failure(status, null);
    return { ok: true, status, durationMs: Date.now() - started };
  }
}

export default TeiahService;
