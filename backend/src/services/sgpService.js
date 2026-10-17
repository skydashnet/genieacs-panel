import { randomBytes } from 'node:crypto';
import AppState from '../models/AppState.js';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpLink from '../models/SgpLink.js';
import SgpContact from '../models/SgpContact.js';
import DeviceService from './deviceService.js';
import DeviceTagService from './deviceTagService.js';
import DeviceSwapService from './deviceSwapService.js';
import { createSecretBox } from '../utils/secretBox.js';
import { PinnedTransport, RESPONSE_TOO_LARGE } from '../utils/net/pinnedFetch.js';
import { deploymentIsShared } from './genieacsEgress.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { TenantCache } from '../config/tenantCache.js';
import { SGP_EVENT_RETENTION } from '../config/retention.js';

const CONFIG_KEY = 'sgp_integration_config';
const SYNC_STATE_KEY = 'sgp_sync_last_run';
const CONFIG_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * How much of an SGP answer this process will hold in memory.
 *
 * There was no ceiling: `response.text()` on a raw `fetch` reads whatever the
 * far end sends, and the far end is an address the operator typed. The biggest
 * legitimate answer here is a contract's invoice list, which is kilobytes.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * The client listing is the one call that is not about a single client. An
 * SGP that ignores `offset`/`limit` builds its whole base into one answer,
 * which takes far longer than an URA lookup and weighs far more. 90 s keeps
 * the settings screen's test button under the proxy's 120 s.
 */
const LIST_TIMEOUT_MS = 90_000;
const LIST_MAX_BYTES = 64 * 1024 * 1024;
// A cached contract keeps plan, status and holder name frozen, so it is only
// trusted for a day before the next read refreshes it from the SGP.
const LINK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// The provider's SGP is a production billing system shared with the call
// centre, so a fleet sync never opens more than a handful of connections.
const SYNC_CONCURRENCY = 5;
// Same freshness rule the customer portal overview uses for "online".
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const DIVERGENCE_LIMIT = 50;

// SGP exposes the URA (self-service) endpoints below on every provider
// instance. They stay configurable because deployments occasionally publish
// the integration under a custom prefix.
export const DEFAULT_ENDPOINTS = Object.freeze({
  customer: '/api/ura/consultacliente/',
  invoices: '/api/ura/titulos/',
  // `liberacaopromessa` is the route SGP documents for the trust unlock (the
  // "liberação por promessa de pagamento"). The panel shipped `/liberacao/`
  // first, which SGP does not serve — see LEGACY_UNLOCK_ENDPOINT.
  unlock: '/api/ura/liberacaopromessa/',
  ticket: '/api/ura/chamado/',
  // The client listing behind the WhatsApp contacts sync. It takes the same
  // `app`/`token` and accepts `cpfcnpj` as a filter; whether it lists everyone
  // without one depends on the install, which is what the test button in
  // Settings answers before any sync runs.
  customerList: '/api/ura/clientes/',
  // Client creation (the SGP's CRM API): `F` or `J` is appended for a person or
  // a company — `/api/crm/cliente/F`. Answers `{ cliente_id, message }`.
  crmClient: '/api/crm/cliente/',
  // The settlement of one invoice ("baixa"), from the SGP's banking API: the
  // invoice's own SGP id goes where `{id}` is.
  invoiceSettle: '/api/banco/titulo/{id}/baixar/'
});

/** What `forma_pagamento` carries when the operator has not listed the install's own. */
export const DEFAULT_SETTLE_PAYMENT_METHODS = Object.freeze(['Dinheiro', 'PIX', 'Cartão de débito', 'Cartão de crédito']);

/** How a listing page is addressed: by row offset, or by page number from 1. */
export const CONTACTS_PAGING = Object.freeze(['offset', 'page']);

/** A request parameter name the operator may configure: an identifier, nothing else. */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

function paramName(value, fallback) {
  const text = String(value ?? '').trim();
  return PARAM_NAME.test(text) ? text : fallback;
}

/**
 * The Tipo de Ocorrência a ticket is filed under when the operator has not set
 * one. 5 is the value SGP's own reference gives as the default; every install
 * still has its own catalogue, which is why it is configurable.
 */
export const DEFAULT_TICKET_OCCURRENCE_TYPE = 5;

/**
 * The unlock path the panel used to default to, and which SGP never served.
 *
 * Saving the SGP settings writes every endpoint back, defaults included, so
 * every provider that ever pressed Save has this path stored as if it had been
 * chosen. It was not: it was the panel's wrong default. Reading it back as the
 * right one is what makes the fix reach them without asking each operator to
 * find a field they never touched. A path anyone typed on purpose is left alone.
 */
const LEGACY_UNLOCK_ENDPOINT = '/api/ura/liberacao/';

/**
 * A path pasted from a Postman collection starts with its base-address
 * variable — `{{url}}/api/ura/clientes/`. The base address is the integration's
 * own URL field, so a leading `{{...}}` is dropped instead of being sent to the
 * SGP as part of the path.
 */
function stripLeadingPlaceholders(path) {
  if (typeof path !== 'string') return path;
  const stripped = path.trim().replace(/^\/?(?:\{\{[^{}]*\}\}\/?)+/, '');
  if (stripped === path.trim()) return path;
  if (!stripped) return '';
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function withEndpointDefaults(stored) {
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(stored || {}) };
  for (const [key, value] of Object.entries(endpoints)) {
    const cleaned = stripLeadingPlaceholders(value);
    if (cleaned !== value) endpoints[key] = cleaned || DEFAULT_ENDPOINTS[key];
  }
  if (endpoints.unlock === LEGACY_UNLOCK_ENDPOINT) endpoints.unlock = DEFAULT_ENDPOINTS.unlock;
  // Saved empty by the release that had no default for it: an empty value is
  // "not chosen", not "switched off" — `contactsSyncEnabled` is what switches
  // the sync off.
  endpoints.customerList = endpoints.customerList || DEFAULT_ENDPOINTS.customerList;
  return endpoints;
}

export const LINK_MODES = Object.freeze(['pppoe', 'customer_id', 'manual']);

/** Public path SGP posts to. Fixed, so the Settings page can show it verbatim. */
export const WEBHOOK_PATH = '/api/sgp/events/webhook';

/** Normalized event vocabulary the dispatcher understands. */
export const EVENT_TYPES = Object.freeze([
  'payment_confirmed', 'unblocked', 'blocked', 'cancelled', 'activated',
  'contract_changed', 'unknown'
]);

/**
 * Maps what SGP calls an event onto that vocabulary. Both sides are compared
 * through `normalizeKey`, so accents, case and separators do not matter, and
 * an operator can extend the map from Settings when their install uses a
 * wording that is not covered here.
 */
export const DEFAULT_EVENT_TYPE_MAP = Object.freeze({
  pagamentoconfirmado: 'payment_confirmed',
  pagamento: 'payment_confirmed',
  pagamentorecebido: 'payment_confirmed',
  pago: 'payment_confirmed',
  baixatitulo: 'payment_confirmed',
  quitado: 'payment_confirmed',
  liberado: 'unblocked',
  liberacao: 'unblocked',
  liberacaoconfianca: 'unblocked',
  desbloqueado: 'unblocked',
  desbloqueio: 'unblocked',
  bloqueado: 'blocked',
  bloqueio: 'blocked',
  suspenso: 'blocked',
  suspensao: 'blocked',
  cancelado: 'cancelled',
  cancelamento: 'cancelled',
  rescindido: 'cancelled',
  rescisao: 'cancelled',
  encerrado: 'cancelled',
  ativado: 'activated',
  ativacao: 'activated',
  habilitado: 'activated',
  instalado: 'activated',
  instalacaoconcluida: 'activated',
  alteracaoplano: 'contract_changed',
  mudancaplano: 'contract_changed',
  planoalterado: 'contract_changed',
  trocaplano: 'contract_changed'
});

// A title's status is free text, worded by each provider. See `isOpenInvoice`.
const INVOICE_CANCELLED_PATTERN = /cancel|estorn|exclu|anulad/;
const INVOICE_OPEN_PATTERN = /abert|pendent|vencid|vencer|atras|gerad|emitid|aguard/;

export const CONTRACT_STATES = Object.freeze(['active', 'blocked', 'cancelled', 'unknown']);

const CONTRACT_STATE_PATTERNS = Object.freeze({
  cancelled: /cancelad|encerrad|desativad|inativ/,
  blocked: /bloquead|suspens|inadimplen/,
  active: /ativo/
});

const tokenBox = createSecretBox('skygenpanel-sgp-token-v1');
// A separate context, so the webhook secret's ciphertext can never be read
// with the integration token's key.
const webhookSecretBox = createSecretBox('skygenpanel-sgp-webhook-secret-v1');

/**
 * The message is a translation key so the controller can answer in the
 * caller's language. Text SGP itself returned is passed through with
 * `raw: true`, since only the provider can phrase those.
 */
export class SgpError extends Error {
  constructor(message, { code = 'sgp_error', status = 502, details = null, vars = null, raw = false } = {}) {
    super(message);
    this.name = 'SgpError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (!raw) {
      this.translationKey = message;
      this.translationVars = vars;
    }
  }
}

// SGP answers "no such customer" the same way it answers a real failure: a
// rejected status with a message. Telling them apart keeps a fleet sync from
// reporting every unregistered ONT as a provider error.
const NOT_FOUND_PATTERN = /nao encontrad|inexistente|not found|nenhum (cliente|contrato)|sem (cliente|contrato)/;

function isNotFound(error) {
  return error instanceof SgpError
    && error.code === 'sgp_rejected'
    && NOT_FOUND_PATTERN.test(stripAccents(error.message).toLowerCase());
}

function encryptToken(token) {
  return { v: 1, ...tokenBox.encrypt(token) };
}

function decryptToken(box) {
  return box ? (tokenBox.decrypt(box) ?? '') : '';
}

function encryptWebhookSecret(secret) {
  return { v: 1, ...webhookSecretBox.encrypt(secret) };
}

function decryptWebhookSecret(box) {
  return box ? (webhookSecretBox.decrypt(box) ?? '') : '';
}

function normalizeKey(key) {
  return String(key)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A PPPoE login as something to compare, not to display.
 *
 * The two sides are written by different systems — one is what the ONT
 * reports, the other what the ERP stored — so case and stray spacing differ
 * between them routinely and mean nothing.
 */
function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

// SGP field names differ between releases and between provider setups
// (`linhadigitavel`, `linha_digitavel`, `linhaDigitavel`), so every read goes
// through a normalized lookup instead of a fixed key.
function pick(source, names) {
  if (!source || typeof source !== 'object') return null;
  const index = new Map();
  for (const [key, value] of Object.entries(source)) {
    index.set(normalizeKey(key), value);
  }
  for (const name of names) {
    const value = index.get(normalizeKey(name));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function asText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function asAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().replace(/[^\d,.-]/g, '');
  // Brazilian formatting arrives as 1.234,56 while the JSON API may send 1234.56.
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function asDate(value) {
  const text = asText(value);
  if (!text) return null;
  const brazilian = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brazilian) return `${brazilian[3]}-${brazilian[2]}-${brazilian[1]}`;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/**
 * Like `asDate`, but keeps the time of day. Event payloads carry a moment, not
 * a due date, and SGP writes it as `DD/MM/YYYY HH:mm:ss`, as ISO, or as an
 * epoch, depending on where in the system it came from.
 */
function asDateTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = value > 1e11 ? value : value * 1000;
    const parsed = new Date(epoch);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const text = asText(value);
  if (!text) return null;
  if (/^\d{9,13}$/.test(text)) return asDateTime(Number(text));
  const brazilian = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (brazilian) {
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = brazilian;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function firstArray(payload, names) {
  const direct = pick(payload, names);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === 'object') return [direct];
  if (Array.isArray(payload)) return payload;
  return [];
}

// The PPPoE password is the one field of a contract that must never reach a
// browser: `normalizeContract` output is returned verbatim by the operator
// lookup endpoint. Reading it is therefore opt-in, and only provisioning asks.
/**
 * Where SGP keeps a subscriber's mobile number.
 *
 * Every install spells it differently and several return more than one, so the
 * read goes through the same normalized lookup as everything else. WhatsApp is
 * the only reason the panel wants this: it had no phone number anywhere before.
 */
const PHONE_NAMES = Object.freeze([
  'celular', 'telefonecelular', 'telefone_celular', 'fonecelular',
  'telefone', 'fone', 'telefone1', 'telefoneprincipal', 'telefonecontato',
  'whatsapp', 'celular1', 'phone', 'mobile'
]);

const PPPOE_PASSWORD_NAMES = Object.freeze([
  'senha', 'senhaPppoe', 'senha_pppoe', 'senhaPPPoE', 'senhaLogin', 'senhaAcesso',
  'senhaConexao', 'senhaUsuario', 'senhaRadius', 'password', 'pppoePassword',
  'pppoe_password', 'passwordPppoe', 'clave'
]);

/**
 * An address as the SGP sends it — an object with its parts under names that
 * vary by version, or one line of text — as the parts the client record shows.
 * `null` when there is nothing to show.
 */
function normalizeAddress(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    const line = asText(value);
    return line ? { line } : null;
  }
  const parts = {
    street: asText(pick(value, ['logradouro', 'rua', 'endereco', 'street'])),
    number: asText(pick(value, ['numero', 'num', 'number'])),
    complement: asText(pick(value, ['complemento', 'complement'])),
    district: asText(pick(value, ['bairro', 'district'])),
    city: asText(pick(value, ['cidade', 'municipio', 'city'])),
    state: asText(pick(value, ['uf', 'estado', 'state'])),
    zip: asText(pick(value, ['cep', 'zip', 'zipcode'])),
    reference: asText(pick(value, ['pontoReferencia', 'ponto_referencia', 'referencia'])),
    latitude: asCoordinate(pick(value, ['latitude', 'lat']), 90),
    longitude: asCoordinate(pick(value, ['longitude', 'lng', 'lon']), 180)
  };
  return Object.values(parts).some(Boolean)
    ? Object.fromEntries(Object.entries(parts).filter(([, part]) => part))
    : null;
}

/**
 * A coordinate as a number, or null. SGP sends it as a number, as "-23.55" or
 * as "-23,55"; zero is what an empty map pin saves, and is no place anyone lives.
 */
function asCoordinate(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(number) || number === 0 || Math.abs(number) > limit) return null;
  return number;
}

/** One line of an address, for a contract row and for the listing. */
function addressLine(address) {
  if (!address) return null;
  if (address.line) return address.line;
  const street = [address.street, address.number].filter(Boolean).join(', ');
  const place = [address.district, [address.city, address.state].filter(Boolean).join('/')].filter(Boolean).join(' - ');
  return [street, address.complement, place, address.zip].filter(Boolean).join(' · ') || null;
}

/**
 * Whether the contract's equipment stayed with the customer on rent or loan
 * (comodato) — the TeiaH Valid `aluguel`. A flag under one of several names, or
 * a list of loaned equipment where non-empty means yes. `null` is "the SGP does
 * not say", which is not the same as "no".
 */
const RENTAL_FLAG_NAMES = Object.freeze([
  'comodato', 'emComodato', 'possuiComodato', 'equipamentoComodato',
  'aluguel', 'aluguelEquipamento', 'equipamentoAlugado', 'locacao', 'locacaoEquipamento'
]);
const RENTAL_LIST_NAMES = Object.freeze(['comodatos', 'equipamentosComodato', 'equipamentosAlugados']);

function equipmentRentedFrom(entry) {
  const list = pick(entry, RENTAL_LIST_NAMES);
  if (Array.isArray(list)) return list.length > 0;
  const value = pick(entry, RENTAL_FLAG_NAMES);
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'object') return Array.isArray(value) ? value.length > 0 : null;
  const text = stripAccents(value).trim();
  if (['1', 'true', 'sim', 's', 'yes', 'y'].includes(text)) return true;
  if (['0', 'false', 'nao', 'n', 'no'].includes(text)) return false;
  return null;
}

const CONTRACT_ADDRESS_NAMES = Object.freeze(['endereco', 'enderecoCompleto', 'contratoEndereco', 'enderecoInstalacao']);

function normalizeContract(entry, { includeSecrets = false } = {}) {
  const contract = asText(pick(entry, ['contrato', 'contratoId', 'idContrato', 'contract']));
  if (!contract) return null;
  const addressParts = normalizeAddress(pick(entry, CONTRACT_ADDRESS_NAMES));
  return {
    contract,
    ...(includeSecrets
      ? { loginPassword: asText(pick(entry, PPPOE_PASSWORD_NAMES)) }
      : {}),
    status: asText(pick(entry, ['contratoStatus', 'status', 'situacao'])),
    statusLabel: asText(pick(entry, [
      'contratoStatusDisplay', 'statusDisplay', 'situacaoDisplay', 'statusDescricao'
    ])),
    plan: asText(pick(entry, ['planoInternet', 'plano', 'planoDescricao', 'servico'])),
    name: asText(pick(entry, ['razaoSocial', 'nome', 'nomeCliente', 'cliente'])),
    // Only a field that says it is the client's: a contract row's own `id` is
    // the contract's, and a wrong client id opens someone else's page in SGP.
    clientId: asText(pick(entry, ['clienteId', 'idCliente', 'cliente_id', 'codigoCliente'])),
    document: asText(pick(entry, ['cpfcnpj', 'cpfCnpj', 'documento'])),
    address: addressLine(addressParts),
    // The same address in parts, for what needs the street apart from the city
    // (the TeiaH Valid import). Null when the SGP only sent one line of text.
    addressParts: addressParts && !addressParts.line ? addressParts : null,
    dueDay: asText(pick(entry, ['vencimento', 'diaVencimento', 'dia_vencimento', 'vencimentoDia'])),
    statusReason: asText(pick(entry, ['motivo_status', 'motivoStatus', 'motivoSituacao'])),
    createdAt: asText(pick(entry, ['dataCadastro', 'data_cadastro', 'dataAtivacao', 'dataInicio'])),
    cancelledAt: asText(pick(entry, [
      'dataCancelamento', 'data_cancelamento', 'dataCancelado', 'dataInativacao',
      'dataEncerramento', 'dataRescisao', 'data_rescisao'
    ])),
    login: asText(pick(entry, ['login', 'usuario', 'pppoe', 'loginPppoe'])),
    // Normalized to sendable digits here rather than at send time, so a cadastre
    // that stores "(93) 98111-0449" and one that stores "5593981110449" reach
    // the outbox as the same value. The ninth digit is never invented — see
    // utils/wa/waDestino.js for why guessing it addresses a stranger.
    phone: normalizarTelefoneBr(pick(entry, PHONE_NAMES)) || null,
    equipmentRented: equipmentRentedFrom(entry),
    blocked: (() => {
      const value = pick(entry, ['bloqueado', 'contratoBloqueado', 'bloqueio']);
      if (value === null) return null;
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'sim', 's'].includes(String(value).trim().toLowerCase());
    })()
  };
}

/**
 * A phone out of a client record that may keep it in a list rather than a
 * field — `telefones: ['...']` or `contatos: [{ tipo, contato }]`, depending on
 * the install. A mobile (the one WhatsApp can reach) is preferred when the list
 * has several; the first usable number otherwise.
 */
const PHONE_LIST_NAMES = Object.freeze(['telefones', 'contatos', 'fones', 'phones', 'celulares']);
/** Inside a `contatos` object: the lists that hold numbers — never `emails`. */
const PHONE_GROUP_NAMES = Object.freeze([
  'celulares', 'celular', 'whatsapp', 'whatsapps', 'telefones', 'telefone', 'fones', 'fone', 'phones'
]);

/** Every value a contacts field may hold, flattened: a list, or an object of lists by kind. */
function phoneCandidates(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    return PHONE_GROUP_NAMES.flatMap((name) => {
      const group = pick(value, [name]);
      if (group === null || group === undefined) return [];
      return Array.isArray(group) ? group : [group];
    });
  }
  return [value];
}

function phoneFrom(entry) {
  const direct = normalizarTelefoneBr(pick(entry, PHONE_NAMES));
  if (direct) return direct;
  const list = PHONE_LIST_NAMES.flatMap((name) => phoneCandidates(pick(entry, [name])));
  if (list.length === 0) return null;
  const numbers = list
    .map((item) => normalizarTelefoneBr(
      item && typeof item === 'object'
        ? pick(item, ['numero', 'contato', 'telefone', 'celular', 'fone', 'valor', 'number'])
        : item
    ))
    .filter(Boolean);
  // 55 + DDD + 9 + eight digits: the shape of a mobile today.
  return numbers.find((n) => /^55\d{2}9\d{8}$/.test(n)) || numbers[0] || null;
}

const CLIENT_ID_NAMES = Object.freeze(['clienteId', 'idCliente', 'cliente_id', 'codigoCliente', 'id']);

const EMAIL_LIST_NAMES = Object.freeze(['emails', 'email', 'e_mails', 'mails']);

/** Every e-mail a client record carries, in a field of its own or in a contacts list. */
function emailsFrom(entry) {
  const found = [];
  const add = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      add(pick(value, ['email', 'contato', 'valor', 'endereco']));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    const text = asText(value);
    if (text && /^[^\s@]+@[^\s@]+$/.test(text)) found.push(text.toLowerCase());
  };
  add(pick(entry, EMAIL_LIST_NAMES));
  const contacts = pick(entry, ['contatos']);
  if (Array.isArray(contacts)) contacts.forEach(add);
  else if (contacts && typeof contacts === 'object') add(pick(contacts, EMAIL_LIST_NAMES));
  return [...new Set(found)].slice(0, 20);
}

/** Every phone a client record carries — `phoneFrom` picks one of these. */
function phonesFrom(entry) {
  const numbers = [];
  for (const name of PHONE_NAMES) {
    const phone = normalizarTelefoneBr(pick(entry, [name]));
    if (phone) numbers.push(phone);
  }
  for (const name of PHONE_LIST_NAMES) {
    for (const item of phoneCandidates(pick(entry, [name]))) {
      const phone = normalizarTelefoneBr(
        item && typeof item === 'object'
          ? pick(item, ['numero', 'contato', 'telefone', 'celular', 'fone', 'valor', 'number'])
          : item
      );
      if (phone) numbers.push(phone);
    }
  }
  return [...new Set(numbers)].slice(0, 20);
}

const PERSON_TYPES = Object.freeze({ f: 'PF', pf: 'PF', fisica: 'PF', j: 'PJ', pj: 'PJ', juridica: 'PJ' });

/**
 * The client behind one listing entry, as the record `sgp_clients` keeps: who
 * the person is, where they live and every way to reach them. `null` for an
 * entry that names no client — a contract row with no client id and no
 * document says nothing about who holds it.
 */
function clientProfile(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // A contract row's own `id` is the contract's: only a field that says it is
  // the client's names the client there.
  const nested = pick(entry, ['contratos', 'contracts']);
  const isContractRow = !Array.isArray(nested) && Boolean(normalizeContract(entry));
  const clientId = asText(pick(entry, isContractRow
    ? CLIENT_ID_NAMES.filter((name) => name !== 'id')
    : CLIENT_ID_NAMES));
  const documentDigits = String(asText(pick(entry, ['cpfcnpj', 'cpfCnpj', 'documento', 'cpf', 'cnpj'])) ?? '')
    .replace(/\D/g, '') || null;
  if (!clientId && !documentDigits) return null;
  const type = stripAccents(asText(pick(entry, ['tipo', 'tipoPessoa', 'tipo_pessoa', 'personType'])) ?? '');
  return {
    clientId,
    document: documentDigits,
    name: asText(pick(entry, ['nome', 'razaoSocial', 'nomeCliente', 'cliente'])),
    personType: PERSON_TYPES[type] || (type ? type.toUpperCase().slice(0, 16) : null),
    gender: asText(pick(entry, ['sexo', 'genero', 'gender'])),
    birthDate: asText(pick(entry, ['dataNascimento', 'data_nascimento', 'nascimento', 'dataFundacao'])),
    registeredAt: isContractRow ? null : asText(pick(entry, ['dataCadastro', 'data_cadastro', 'clienteDesde'])),
    address: normalizeAddress(pick(entry, ['endereco', 'enderecoCompleto', 'enderecoCobranca'])),
    phones: phonesFrom(entry),
    emails: emailsFrom(entry)
  };
}

/**
 * One entry of the client listing, as the rows `sgp_contacts` stores.
 *
 * The listing is not standardised across SGP versions, so three shapes are
 * read: a client carrying its contracts in a nested list (one row per
 * contract), a contract row with the client inlined (one row), and a client
 * with no contract at all (one row, contract `null`). A contract row falls back
 * to its client's name, document and phone when it has none of its own.
 */
/**
 * The field NAMES inside a listing's nested contracts and contacts — never a
 * value — so the test button shows at once why a page read no contract or no
 * phone, and the next version can learn the shape without anyone pasting a
 * client's data anywhere.
 */
function describeValue(value) {
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined);
    if (first === undefined) return '[]';
    return first && typeof first === 'object'
      ? `[{ ${Object.keys(first).slice(0, 20).join(', ')} }]`
      : `[${typeof first}]`;
  }
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).slice(0, 20).map(([key, inner]) => `${key}: ${describeValue(inner)}`).join(', ')} }`;
  }
  return value === null || value === undefined ? 'null' : typeof value;
}

function listingShape(entries) {
  const shape = {};
  for (const name of ['contratos', 'contatos', 'telefones']) {
    // The first client that has something there: an empty list says nothing.
    const withValue = entries.find((entry) => {
      const value = entry && typeof entry === 'object' ? entry[name] : undefined;
      return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';
    });
    if (withValue) shape[name] = describeValue(withValue[name]);
  }
  return shape;
}

function normalizeCustomer(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const clientId = asText(pick(entry, CLIENT_ID_NAMES));
  const client = {
    clientId,
    name: asText(pick(entry, ['nome', 'razaoSocial', 'nomeCliente', 'cliente'])),
    document: asText(pick(entry, ['cpfcnpj', 'cpfCnpj', 'documento', 'cpf', 'cnpj'])),
    phone: phoneFrom(entry)
  };

  const nested = pick(entry, ['contratos', 'contracts']);
  if (Array.isArray(nested) && nested.length > 0) {
    const rows = nested
      .map((item) => {
        // Inside a client's `contratos` list an item's own `id` IS the
        // contract's — the one place a bare `id` may be read as one.
        const contract = normalizeContract(item)
          || (item && typeof item === 'object' && asText(pick(item, ['id']))
            ? normalizeContract({ ...item, contrato: pick(item, ['id']) })
            : null);
        if (!contract) return null;
        const clientAddress = contract.addressParts ? null : normalizeAddress(pick(entry, CONTRACT_ADDRESS_NAMES));
        return {
          ...contract,
          // A contract that carries no address of its own is at its client's.
          ...(clientAddress && !contract.address ? { address: addressLine(clientAddress) } : {}),
          ...(clientAddress && !clientAddress.line && !contract.address ? { addressParts: clientAddress } : {}),
          clientId: client.clientId,
          name: contract.name || client.name,
          document: contract.document || client.document,
          phone: contract.phone || phoneFrom(item) || client.phone
        };
      })
      .filter(Boolean);
    // Contracts in a shape none of the names above read: the client is still a
    // client, and is kept without a contract instead of vanishing.
    if (rows.length > 0) return rows;
  }

  const contract = normalizeContract(entry);
  if (contract) {
    // A contract row: its own `id` is the contract's, not the client's, so only
    // an explicitly named client id is kept.
    const explicitClient = asText(pick(entry, CLIENT_ID_NAMES.filter((name) => name !== 'id')));
    return [{ ...contract, clientId: explicitClient, phone: contract.phone || client.phone }];
  }

  if (!client.clientId && !client.document) return [];
  return [{
    contract: null,
    clientId: client.clientId,
    name: client.name,
    document: client.document,
    phone: client.phone,
    status: asText(pick(entry, ['status', 'situacao'])),
    statusLabel: null,
    blocked: null
  }];
}

function stripAccents(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Every install words its contract statuses differently, so the panel derives a
// stable state instead of grouping by the label itself. The order of the checks
// is the whole point: a cancellation is matched first because "Inativo" and
// "Desativado" contain "ativo", and an explicit `bloqueado` flag outranks a
// label that still reads "Ativo". The two fields are matched separately, never
// concatenated, so no pattern can straddle the boundary between them.
function deriveContractState(contract) {
  const labels = [contract?.statusLabel, contract?.status].map(stripAccents);
  const matches = (pattern) => labels.some((label) => pattern.test(label));
  if (matches(CONTRACT_STATE_PATTERNS.cancelled)) return 'cancelled';
  if (contract?.blocked === true || matches(CONTRACT_STATE_PATTERNS.blocked)) return 'blocked';
  if (matches(CONTRACT_STATE_PATTERNS.active)) return 'active';
  return 'unknown';
}

function normalizeInvoice(entry) {
  const dueDate = asDate(pick(entry, ['vencimento', 'dataVencimento', 'datavencimento', 'dueDate']));
  const paidAt = asDate(pick(entry, ['dataPagamento', 'datapagamento', 'pagamento']));
  return {
    id: asText(pick(entry, ['numerodocumento', 'numeroDocumento', 'id', 'titulo', 'documento'])),
    // The SGP's own id of the invoice, which the settlement route is addressed
    // by — not the document number above. Digits only, or none.
    sgpId: (() => {
      const value = asText(pick(entry, ['id', 'titulo_id', 'tituloId', 'idTitulo', 'idtitulo', 'fatura_id', 'faturaId']));
      return value && /^\d{1,18}$/.test(value) ? value : null;
    })(),
    description: asText(pick(entry, ['descricaomodelo', 'descricao', 'observacao', 'modelo'])),
    amount: asAmount(pick(entry, ['valor', 'valordocumento', 'valorDocumento', 'valorTotal'])),
    dueDate,
    paidAt,
    status: asText(pick(entry, ['status', 'situacao', 'statusDisplay'])),
    digitableLine: asText(pick(entry, ['linhadigitavel', 'linhaDigitavel', 'linha'])),
    barcode: asText(pick(entry, ['codigodebarras', 'codigoBarras', 'barras'])),
    link: asText(pick(entry, ['link', 'linkboleto', 'linkBoleto', 'url', 'urlBoleto'])),
    pix: asText(pick(entry, ['pix', 'pixCopiaECola', 'pixcopiaecola', 'codigoPix', 'codigopix', 'pixCopiaCola', 'pix_copia_cola', 'qrcodePix', 'qrcode'])),
    paid: (() => {
      const status = asText(pick(entry, ['status', 'situacao', 'statusDisplay']));
      if (paidAt) return true;
      return status ? /pago|quitad|liquidad/i.test(status) : false;
    })()
  };
}

function maskDocument(document) {
  const digits = String(document ?? '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * Operator-supplied additions to the event vocabulary. Keys are normalized the
 * same way the payload's type is, so `Pagamento Confirmado` and
 * `pagamento_confirmado` are one entry, and an unknown target type is dropped
 * rather than silently routing an event to a handler that does not exist.
 */
function normalizeEventTypeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const map = {};
  for (const [key, target] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    const normalizedTarget = String(target ?? '').trim();
    if (!normalizedKey || !EVENT_TYPES.includes(normalizedTarget)) continue;
    map[normalizedKey] = normalizedTarget;
  }
  return map;
}

/**
 * Event payloads may put the interesting fields at the top level or nest them
 * under a wrapper. Every lookup walks these scopes in order, so one shape does
 * not have to be guessed correctly up front.
 */
function candidateScopes(body) {
  if (!body || typeof body !== 'object') return [];
  const scopes = [body];
  for (const key of ['dados', 'data', 'payload', 'evento', 'contrato', 'contract', 'cliente', 'customer']) {
    const nested = body[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) scopes.push(nested);
  }
  return scopes;
}

function pickScoped(scopes, names) {
  for (const scope of scopes) {
    const value = pick(scope, names);
    if (value !== null) return value;
  }
  return null;
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  baseUrl: '',
  app: '',
  linkMode: 'pppoe',
  portalBilling: true,
  portalUnlock: false,
  invoiceLimit: 6,
  ticketEnabled: false,
  ticketOccurrenceType: DEFAULT_TICKET_OCCURRENCE_TYPE,
  endpoints: DEFAULT_ENDPOINTS,
  webhookEnabled: false,
  webhookRequireTimestamp: false,
  webhookToleranceSeconds: 300,
  reconcileEnabled: false,
  reconcileIntervalMinutes: 15,
  reconcileBatchSize: 25,
  eventRetentionDays: SGP_EVENT_RETENTION.defaultDays,
  eventTypeMap: {},
  contactsSyncEnabled: false,
  contactsSyncIntervalHours: 24,
  contactsPageSize: 100,
  contactsPaging: 'offset',
  contactsOffsetParam: 'offset',
  contactsLimitParam: 'limit',
  settleReceivingPoint: 0,
  settlePaymentMethods: DEFAULT_SETTLE_PAYMENT_METHODS,
  settleFees: 0
});

/**
 * The one way this module reaches the SGP.
 *
 * `baseUrl` is request data: it arrives in the body of `POST /api/sgp/test`,
 * behind the `sgp.config` permission that every provider admin holds — and on
 * a multi-provider deployment that admin is a TENANT, not the host operator.
 * It used to go straight into a bare `fetch` with no address check, no
 * redirect policy and no ceiling on the body, and `SgpController.testConnection`
 * hands the far end's own message back to the caller. Pointed at an internal
 * service, the probe answered with that service's response body.
 *
 * So it goes through the shared transport instead, which resolves with the
 * resolver the socket will use, refuses the address classes in
 * `utils/net/blockedRanges.js`, connects only to the address it vetted, and
 * stops reading at `MAX_RESPONSE_BYTES`. Nothing follows a redirect: a 3xx
 * arrives as an ordinary not-ok answer, so an SGP that answers 302 towards
 * somewhere else cannot move the request there.
 *
 * The address classes are refused whenever the deployment is shared, for the
 * same reason `genieacsEgress` does the same: a self-hosted install with one
 * provider runs its SGP on the operator's own LAN, a private address is the
 * normal case there, and the person who typed the URL owns the box. The
 * pinning and the ceiling apply in both cases — one transport that behaves the
 * same everywhere.
 *
 * "Compartilhado" é `deploymentIsShared()`, e não `IS_SAAS`: `EDITION` tem
 * default `selfhosted`, e um deploy com vários provedores que suba sem a
 * variável deixava qualquer administrador de provedor apontar o `baseUrl` do
 * SGP para `127.0.0.1`, para a VPC ou para o serviço de metadados da nuvem — o
 * mesmo modo de falha que `genieacsEgress` já tinha fechado para o ACS. A
 * leitura é síncrona e de memória (a contagem de provedores é refeita no boot
 * e a cada passada do agendador), então não pesa no caminho de cada chamada.
 *
 * Used by every SGP call, not just the probe: the portal's billing lookups and
 * the reconcile job go through `SgpService.request` too.
 */
async function sgpFetch(url, { headers, body, signal, maxBytes = MAX_RESPONSE_BYTES }) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    throw new SgpError('sgp.error.urlInvalid', { code: 'invalid_base_url', status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SgpError('sgp.error.urlScheme', { code: 'invalid_base_url', status: 400 });
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  // The refusal names nothing it learned. `genieacsEgress` quotes the address
  // it refused because its reader is the operator of the whole deployment;
  // here the reader is one tenant of it, and "resolves to 10.0.0.5" would be
  // the panel mapping its own private network on request.
  // O `signal` vale para a RESOLUÇÃO também, e não só para a requisição abaixo.
  // O prazo de 15 s é armado em `request` com um AbortController, mas ele só
  // alcança o que já começou: um resolvedor que aceita a consulta e nunca
  // responde prende quem chamou antes de existir socket para abortar, e a
  // chamada passa dos 15 s sem que nada a encerre. É o mesmo prazo que o
  // `safeFetch` já estende à resolução, pelo mesmo motivo — aqui pesa mais,
  // porque na edição SaaS o `baseUrl` é escolhido pelo administrador do
  // provedor, e as consultas de fatura do portal e o job de reconciliação
  // passam por aqui.
  //
  // Ele limita a ESPERA, não a consulta: `getaddrinfo` não tem `cancel()`, então
  // o aborto solta quem chamou e deixa a consulta terminar no vazio. Prender
  // quem chamou é o dano que o prazo existe para evitar.
  const addresses = await PinnedTransport.vetTarget(hostname, {
    signal,
    allowPrivateAddresses: !deploymentIsShared(),
    refuse: () => new SgpError('sgp.error.blockedHost', { code: 'blocked_host', status: 400 })
  });
  // O prazo pode ter vencido DENTRO da resolução acima, e aí o motivo de parar é
  // ele: sem esta linha um nome que não respondeu a tempo sairia daqui como
  // `unreachable`, que é uma frase sobre a rede para um problema de relógio.
  signal?.throwIfAborted();
  if (addresses.length === 0) {
    throw new SgpError('sgp.error.unreachable', { code: 'unreachable', status: 502 });
  }

  return PinnedTransport.request({
    url: parsed,
    hostname,
    addresses,
    method: 'POST',
    headers,
    body,
    signal,
    maxBytes
  });
}

const MIN_RECONCILE_INTERVAL_MINUTES = 5;

class SgpService {
  static configCache = new TenantCache(CONFIG_CACHE_TTL_MS);

  /**
   * Quanto uma chamada ao SGP pode levar, da resolução do nome ao último byte.
   *
   * Campo de classe, e lido por `this`, pelo mesmo motivo que `ALLOWED_PORTS`
   * em `genieacsEgress`: o limite que a classe anuncia é o limite que ela
   * aplica, e um teste consegue provar o prazo sem esperar quinze segundos.
   */
  static REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
  static LIST_TIMEOUT_MS = LIST_TIMEOUT_MS;

  /**
   * Forget the provider in scope — its own configuration changed.
   * To forget every provider's, reach for `configCache.clear()`; that is a
   * reset, not a save, and the two must not share a name.
   */
  static invalidateConfigCache() {
    this.configCache.invalidate();
  }

  static normalizeBaseUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    let url;
    try {
      url = new URL(text.includes('://') ? text : `https://${text}`);
    } catch {
      throw new SgpError('sgp.error.urlInvalid', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new SgpError('sgp.error.urlScheme', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    if (url.username || url.password) {
      throw new SgpError('sgp.error.urlCredentials', {
        code: 'invalid_base_url',
        status: 400
      });
    }
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  /** Se os dois endereços têm a mesma origem (esquema, host e porta). */
  static sameOrigin(a, b) {
    if (!a || !b) return false;
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return false;
    }
  }

  static normalizeEndpoint(value, fallback) {
    const text = stripLeadingPlaceholders(String(value ?? '').trim());
    if (!text) return fallback;
    if (text.includes('{{') || text.includes('}}')) {
      throw new SgpError('sgp.error.pathPlaceholder', {
        code: 'invalid_endpoint',
        status: 400
      });
    }
    if (/^https?:\/\//i.test(text) || text.includes('..')) {
      throw new SgpError('sgp.error.pathsRelative', {
        code: 'invalid_endpoint',
        status: 400
      });
    }
    return text.startsWith('/') ? text : `/${text}`;
  }

  /**
   * The settlement path names the invoice in the middle — `/titulo/{id}/baixar/`.
   * Pasted from Postman it reads `{{fatura_id}}`; any one placeholder there is
   * the invoice id, and a path without exactly one is refused.
   */
  static normalizeSettleEndpoint(value) {
    const raw = stripLeadingPlaceholders(String(value ?? '').trim());
    if (!raw) return DEFAULT_ENDPOINTS.invoiceSettle;
    const unified = raw.replace(/\{\{?\s*[A-Za-z_][A-Za-z0-9_]*\s*\}?\}/g, '{id}');
    if ((unified.match(/\{id\}/g) || []).length !== 1) {
      throw new SgpError('sgp.error.settlePathId', { code: 'invalid_endpoint', status: 400 });
    }
    return this.normalizeEndpoint(unified, DEFAULT_ENDPOINTS.invoiceSettle);
  }

  static async readStoredConfig() {
    const raw = await AppState.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG, token: null };
    try {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        endpoints: withEndpointDefaults(parsed.endpoints)
      };
    } catch {
      return { ...DEFAULT_CONFIG, token: null };
    }
  }

  static async getConfig() {
    const cached = this.configCache.get();
    if (cached) return cached;
    const stored = await this.readStoredConfig();
    const config = {
      enabled: stored.enabled === true,
      baseUrl: String(stored.baseUrl || ''),
      app: String(stored.app || ''),
      token: decryptToken(stored.token),
      linkMode: LINK_MODES.includes(stored.linkMode) ? stored.linkMode : 'pppoe',
      portalBilling: stored.portalBilling !== false,
      portalUnlock: stored.portalUnlock === true,
      invoiceLimit: Number(stored.invoiceLimit) > 0 ? Math.min(Number(stored.invoiceLimit), 24) : 6,
      endpoints: withEndpointDefaults(stored.endpoints),
      webhookSecret: decryptWebhookSecret(stored.webhookSecret),
      webhookEnabled: stored.webhookEnabled === true,
      webhookRequireTimestamp: stored.webhookRequireTimestamp === true,
      webhookToleranceSeconds: clampNumber(stored.webhookToleranceSeconds, 30, 3600, 300),
      reconcileEnabled: stored.reconcileEnabled === true,
      reconcileIntervalMinutes: clampNumber(
        stored.reconcileIntervalMinutes, MIN_RECONCILE_INTERVAL_MINUTES, 1440, 15
      ),
      reconcileBatchSize: clampNumber(stored.reconcileBatchSize, 1, 200, 25),
      eventRetentionDays: clampNumber(stored.eventRetentionDays, SGP_EVENT_RETENTION.minDays, SGP_EVENT_RETENTION.maxDays, SGP_EVENT_RETENTION.defaultDays),
      eventTypeMap: normalizeEventTypeMap(stored.eventTypeMap),
      ticketEnabled: stored.ticketEnabled === true,
      ticketOccurrenceType: clampNumber(
        stored.ticketOccurrenceType, 1, 999999, DEFAULT_TICKET_OCCURRENCE_TYPE
      ),
      ...this.readContactsSync(stored),
      ...this.readSettle(stored),
      updatedAt: stored.updatedAt || null
    };
    this.configCache.set(config);
    return config;
  }

  /**
   * The contacts-sync settings, clamped. Shared by the reader and the writer so
   * a stored value and a patched one go through the same bounds.
   */
  static readContactsSync(source, fallback = DEFAULT_CONFIG) {
    return {
      contactsSyncEnabled: source.contactsSyncEnabled === undefined
        ? fallback.contactsSyncEnabled === true
        : source.contactsSyncEnabled === true,
      contactsSyncIntervalHours: clampNumber(
        source.contactsSyncIntervalHours ?? fallback.contactsSyncIntervalHours, 1, 168, 24
      ),
      contactsPageSize: clampNumber(source.contactsPageSize ?? fallback.contactsPageSize, 10, 500, 100),
      contactsPaging: CONTACTS_PAGING.includes(source.contactsPaging)
        ? source.contactsPaging
        : (CONTACTS_PAGING.includes(fallback.contactsPaging) ? fallback.contactsPaging : 'offset'),
      contactsOffsetParam: paramName(
        source.contactsOffsetParam, paramName(fallback.contactsOffsetParam, 'offset')
      ),
      contactsLimitParam: paramName(
        source.contactsLimitParam, paramName(fallback.contactsLimitParam, 'limit')
      )
    };
  }

  /** The invoice-settlement settings, bounded. Shared by the reader and the writer. */
  static readSettle(source, fallback = DEFAULT_CONFIG) {
    const methods = Array.isArray(source.settlePaymentMethods)
      ? source.settlePaymentMethods
      : (typeof source.settlePaymentMethods === 'string' ? source.settlePaymentMethods.split(/[,;\n]/) : null);
    const cleanMethods = methods
      ? [...new Set(methods.map((method) => String(method ?? '').trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
      : null;
    const fees = Number(source.settleFees ?? fallback.settleFees);
    return {
      settleReceivingPoint: clampNumber(source.settleReceivingPoint ?? fallback.settleReceivingPoint, 0, 999999, 0),
      settlePaymentMethods: cleanMethods && cleanMethods.length > 0
        ? cleanMethods
        : (Array.isArray(fallback.settlePaymentMethods) && fallback.settlePaymentMethods.length > 0
          ? [...fallback.settlePaymentMethods]
          : [...DEFAULT_SETTLE_PAYMENT_METHODS]),
      settleFees: Number.isFinite(fees) && fees >= 0 ? Math.min(Math.round(fees * 100) / 100, 99999) : 0
    };
  }

  /** Whether the panel may settle invoices: the integration up and a receiving point chosen. */
  static canSettle(config) {
    return this.isReady(config) && Number(config.settleReceivingPoint) > 0 && Boolean(config.endpoints?.invoiceSettle);
  }

  static async getPublicConfig() {
    const config = await this.getConfig();
    const { token, webhookSecret, ...rest } = config;
    return {
      ...rest,
      tokenConfigured: Boolean(token),
      webhookSecretConfigured: Boolean(webhookSecret),
      webhookPath: WEBHOOK_PATH,
      ready: this.isReady(config),
      settleReady: this.canSettle(config)
    };
  }

  static isReady(config) {
    return Boolean(config.enabled && config.baseUrl && config.app && config.token);
  }

  static requireReady(config) {
    if (!this.isReady(config)) {
      throw new SgpError('sgp.error.notConfigured', {
        code: 'not_configured',
        status: 409
      });
    }
    return config;
  }

  static async saveConfig(patch = {}) {
    const current = await this.getConfig();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      baseUrl: patch.baseUrl === undefined
        ? current.baseUrl
        : this.normalizeBaseUrl(patch.baseUrl),
      app: patch.app === undefined ? current.app : String(patch.app).trim().slice(0, 128),
      linkMode: LINK_MODES.includes(patch.linkMode) ? patch.linkMode : current.linkMode,
      portalBilling: patch.portalBilling === undefined
        ? current.portalBilling
        : patch.portalBilling === true,
      portalUnlock: patch.portalUnlock === undefined
        ? current.portalUnlock
        : patch.portalUnlock === true,
      invoiceLimit: patch.invoiceLimit === undefined
        ? current.invoiceLimit
        : Math.min(Math.max(Number(patch.invoiceLimit) || 6, 1), 24),
      webhookEnabled: patch.webhookEnabled === undefined
        ? current.webhookEnabled
        : patch.webhookEnabled === true,
      webhookRequireTimestamp: patch.webhookRequireTimestamp === undefined
        ? current.webhookRequireTimestamp
        : patch.webhookRequireTimestamp === true,
      webhookToleranceSeconds: patch.webhookToleranceSeconds === undefined
        ? current.webhookToleranceSeconds
        : clampNumber(patch.webhookToleranceSeconds, 30, 3600, 300),
      reconcileEnabled: patch.reconcileEnabled === undefined
        ? current.reconcileEnabled
        : patch.reconcileEnabled === true,
      reconcileIntervalMinutes: patch.reconcileIntervalMinutes === undefined
        ? current.reconcileIntervalMinutes
        : clampNumber(patch.reconcileIntervalMinutes, MIN_RECONCILE_INTERVAL_MINUTES, 1440, 15),
      reconcileBatchSize: patch.reconcileBatchSize === undefined
        ? current.reconcileBatchSize
        : clampNumber(patch.reconcileBatchSize, 1, 200, 25),
      eventRetentionDays: patch.eventRetentionDays === undefined
        ? current.eventRetentionDays
        : clampNumber(patch.eventRetentionDays, SGP_EVENT_RETENTION.minDays, SGP_EVENT_RETENTION.maxDays, SGP_EVENT_RETENTION.defaultDays),
      eventTypeMap: patch.eventTypeMap === undefined
        ? current.eventTypeMap
        : normalizeEventTypeMap(patch.eventTypeMap),
      ticketEnabled: patch.ticketEnabled === undefined
        ? current.ticketEnabled
        : patch.ticketEnabled === true,
      // The upper bound is generous on purpose: this is an id in the install's
      // own catalogue, not an enum we get to define.
      ticketOccurrenceType: patch.ticketOccurrenceType === undefined
        ? current.ticketOccurrenceType
        : clampNumber(patch.ticketOccurrenceType, 1, 999999, DEFAULT_TICKET_OCCURRENCE_TYPE),
      endpoints: {
        customer: this.normalizeEndpoint(
          patch.endpoints?.customer ?? current.endpoints.customer, DEFAULT_ENDPOINTS.customer
        ),
        invoices: this.normalizeEndpoint(
          patch.endpoints?.invoices ?? current.endpoints.invoices, DEFAULT_ENDPOINTS.invoices
        ),
        unlock: this.normalizeEndpoint(
          patch.endpoints?.unlock ?? current.endpoints.unlock, DEFAULT_ENDPOINTS.unlock
        ),
        ticket: this.normalizeEndpoint(
          patch.endpoints?.ticket ?? current.endpoints.ticket, DEFAULT_ENDPOINTS.ticket
        ),
        customerList: this.normalizeEndpoint(
          patch.endpoints?.customerList ?? current.endpoints.customerList, DEFAULT_ENDPOINTS.customerList
        ),
        crmClient: this.normalizeEndpoint(
          patch.endpoints?.crmClient ?? current.endpoints.crmClient, DEFAULT_ENDPOINTS.crmClient
        ),
        invoiceSettle: this.normalizeSettleEndpoint(
          patch.endpoints?.invoiceSettle ?? current.endpoints.invoiceSettle
        )
      },
      ...this.readContactsSync(patch, current),
      ...this.readSettle(patch, current),
      updatedAt: new Date().toISOString()
    };

    // An omitted token keeps the stored secret; an explicit empty string clears
    // it so an operator can revoke the integration without wiping the setup.
    let token = current.token;
    if (patch.token !== undefined) {
      token = String(patch.token).trim();
    } else if (token && !this.sameOrigin(next.baseUrl, current.baseUrl)) {
      // Trocar o endereço e manter o token entregaria o segredo, na próxima
      // chamada do painel, a quem o endereço novo apontar.
      throw new SgpError('sgp.error.tokenForNewUrl', {
        code: 'token_required',
        status: 400
      });
    }

    if (next.enabled && (!next.baseUrl || !next.app || !token)) {
      throw new SgpError('sgp.error.configIncomplete', {
        code: 'incomplete_config',
        status: 400
      });
    }

    // Same semantics as the token: omitted keeps the stored secret, an empty
    // string clears it. The secret is only ever set through the rotate action.
    let webhookSecret = current.webhookSecret;
    if (patch.webhookSecret !== undefined) {
      webhookSecret = String(patch.webhookSecret).trim();
    }

    if (next.webhookEnabled && !webhookSecret) {
      throw new SgpError('sgp.error.webhookSecretRequired', {
        code: 'webhook_secret_required',
        status: 400
      });
    }

    await AppState.upsert(CONFIG_KEY, JSON.stringify({
      ...next,
      token: token ? encryptToken(token) : null,
      webhookSecret: webhookSecret ? encryptWebhookSecret(webhookSecret) : null
    }));
    this.invalidateConfigCache();
    return this.getPublicConfig();
  }

  /**
   * Maps an arbitrary SGP event body onto the internal vocabulary. Nothing
   * about the payload shape is assumed: the type may be called `evento`,
   * `tipo`, `acao` or `status`, and the fields may be nested one level down.
   * An unrecognised event is deliberately returned as `unknown` rather than
   * dropped, so an operator can read the stored body and add a mapping.
   */
  static normalizeEvent(body, typeMap = {}) {
    const scopes = candidateScopes(body);
    const rawType = asText(pickScoped(scopes, [
      'evento', 'event', 'eventType', 'tipo', 'tipoEvento', 'type',
      'acao', 'action', 'ocorrencia', 'status', 'situacao'
    ]));
    const merged = { ...DEFAULT_EVENT_TYPE_MAP, ...normalizeEventTypeMap(typeMap) };
    const type = rawType ? (merged[normalizeKey(rawType)] ?? 'unknown') : 'unknown';
    const document = asText(pickScoped(scopes, ['cpfcnpj', 'cpfCnpj', 'documento', 'document']));
    return {
      type,
      rawType,
      contract: asText(pickScoped(scopes, ['contrato', 'contratoId', 'idContrato', 'contract'])),
      document: document ? document.replace(/\D/g, '').slice(0, 32) || null : null,
      login: asText(pickScoped(scopes, ['login', 'usuario', 'pppoe', 'loginPppoe'])),
      occurredAt: asDateTime(pickScoped(scopes, [
        'data', 'dataEvento', 'dataHora', 'datahora', 'timestamp', 'occurredAt', 'criadoEm'
      ])),
      eventId: asText(pickScoped(scopes, [
        'id', 'eventoId', 'evento_id', 'eventId', 'uuid', 'notificacaoId', 'protocolo'
      ]))
    };
  }

  /**
   * Generates a new webhook secret and returns it once. Nothing else ever
   * hands the plaintext back, so an operator who loses it must rotate again.
   */
  static async rotateWebhookSecret() {
    const secret = randomBytes(32).toString('hex');
    await this.saveConfig({ webhookSecret: secret });
    return secret;
  }

  /**
   * @param {object} [limits] - `listing: true` for the client listing: its own
   *   deadline and body ceiling, and errors that say it was the listing.
   */
  static async request(endpointKey, payload = {}, configOverride = null, { listing = false, pathSuffix = '', pathId = null, acceptText = false } = {}) {
    const config = this.requireReady(configOverride || await this.getConfig());

    let endpoint = config.endpoints[endpointKey] || DEFAULT_ENDPOINTS[endpointKey];
    if (endpoint.includes('{id}')) {
      // Only an id the SGP itself sent, and only digits: nothing an operator
      // typed reaches the path.
      if (!/^\d{1,18}$/.test(String(pathId ?? ''))) {
        throw new SgpError('sgp.error.invoiceIdMissing', { code: 'invoice_id_missing', status: 409 });
      }
      endpoint = endpoint.replace('{id}', String(pathId));
    }
    // A suffix is a fixed segment the caller names (`F`/`J`), never input.
    const suffix = pathSuffix ? `${endpoint.endsWith('/') ? '' : '/'}${pathSuffix}` : '';
    const url = `${config.baseUrl}${endpoint}${suffix}`;
    const body = { app: config.app, token: config.token, ...payload };

    const controller = new AbortController();
    const timeoutMs = listing ? this.LIST_TIMEOUT_MS : this.REQUEST_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await sgpFetch(url, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        maxBytes: listing ? LIST_MAX_BYTES : MAX_RESPONSE_BYTES
      });
    } catch (error) {
      // A refusal `sgpFetch` raised is already the right answer, and it is
      // deliberately vague. Falling through to `unreachable` below would
      // relabel it AND copy its text into `details`, which the controller
      // reflects — the exact shape this guard exists to close.
      if (error instanceof SgpError) throw error;
      if (error.name === 'AbortError' || controller.signal.aborted) {
        throw new SgpError(listing ? 'sgp.error.contactsListTimeout' : 'sgp.error.timeout', {
          vars: listing ? { seconds: Math.round(timeoutMs / 1000) } : undefined,
          code: 'timeout',
          status: 504
        });
      }
      if (error.code === RESPONSE_TOO_LARGE) {
        throw new SgpError(listing ? 'sgp.error.contactsListTooLarge' : 'sgp.error.invalidResponse', {
          code: 'invalid_response',
          status: 502
        });
      }
      throw new SgpError('sgp.error.unreachable', {
        code: 'unreachable',
        status: 502,
        details: error.message
      });
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

    if (response.status === 401 || response.status === 403) {
      throw new SgpError('sgp.error.credentialsRejected', {
        code: 'unauthorized',
        status: 502
      });
    }
    if (!response.ok) {
      throw new SgpError('sgp.error.status', {
        vars: { status: response.status },
        code: 'http_error',
        status: 502,
        details: asText(pick(data || {}, ['msg', 'mensagem', 'message', 'erro'])) || undefined
      });
    }
    if (data === null && acceptText) {
      // A 2xx from a write route is the write done, whatever the body: some
      // SGP routes answer a bare sentence ("... gerado com sucesso"), the
      // settlement answers nothing at all (or a 204), and a page of HTML is no
      // message to show anyone.
      const body = text.trim();
      if (!body || body.startsWith('<')) return { message: null };
      return { message: body.replace(/^['"]|['"]$/g, '').slice(0, 300) };
    }
    if (data === null) {
      throw new SgpError('sgp.error.invalidResponse', {
        code: 'invalid_response',
        status: 502
      });
    }

    const statusFlag = pick(data, ['status']);
    const message = asText(pick(data, ['msg', 'mensagem', 'message', 'erro']));
    const failed = statusFlag !== null &&
      ['0', 'erro', 'error', 'false'].includes(String(statusFlag).trim().toLowerCase());
    if (failed) {
      throw new SgpError(message || 'sgp.error.queryFailed', {
        code: 'sgp_rejected',
        status: 502,
        raw: Boolean(message)
      });
    }

    return data;
  }

  static buildLookupPayload({ document, contract, login } = {}) {
    const payload = {};
    const cleanDocument = String(document ?? '').replace(/\D/g, '');
    if (cleanDocument) payload.cpfcnpj = cleanDocument;
    const cleanContract = asText(contract);
    if (cleanContract) payload.contrato = cleanContract;
    const cleanLogin = asText(login);
    if (cleanLogin) payload.login = cleanLogin;
    if (Object.keys(payload).length === 0) {
      throw new SgpError('sgp.error.identifierRequired', {
        code: 'missing_filter',
        status: 400
      });
    }
    return payload;
  }

  /**
   * Asks the SGP for a customer, and asks again with the login in lower case
   * when the first answer found nothing.
   *
   * The ONT and the RADIUS disagree about case and neither cares: an ONT
   * configured with `TA100.021` authenticates against a cadastre holding
   * `ta100.021`, so the subscriber is online. The SGP lookup matches the
   * login exactly, though, and answered "no contract" for every such ONT —
   * which left it without an SGP link for no reason the operator could see.
   */
  static async lookupCustomer(filters, configOverride = null, options = {}) {
    const login = asText(filters?.login);
    const lowered = login ? login.toLowerCase() : null;
    if (!login || lowered === login) {
      return this.lookupCustomerOnce(filters, configOverride, options);
    }
    try {
      const result = await this.lookupCustomerOnce(filters, configOverride, options);
      if (result.contracts.length > 0) return result;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return this.lookupCustomerOnce({ ...filters, login: lowered }, configOverride, options);
  }

  static async lookupCustomerOnce(filters, configOverride = null, { includeSecrets = false } = {}) {
    const data = await this.request(
      'customer',
      this.buildLookupPayload(filters),
      configOverride
    );
    const contracts = firstArray(data, ['contratos', 'contrato', 'dados', 'data', 'clientes'])
      .map((entry) => normalizeContract(entry, { includeSecrets }))
      .filter(Boolean);
    return {
      contracts,
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }

  /**
   * A contract without its secret, for anything that leaves the process.
   * `lookupContractForProvisioning` is the only source of a contract that
   * carries `loginPassword`, and this is how that value is dropped again.
   */
  static publicContract(contract) {
    if (!contract) return null;
    const { loginPassword, ...rest } = contract;
    return rest;
  }

  /**
   * Contract lookup for the provisioning path, which is the only caller allowed
   * to read the PPPoE password. The result must never be returned by a route,
   * written to `sgp_links`, or logged.
   */
  static async lookupContractForProvisioning(filters, configOverride = null) {
    const { contracts } = await this.lookupCustomer(filters, configOverride, { includeSecrets: true });
    return this.pickContract(contracts, filters?.contract ?? null);
  }

  /**
   * Whether an invoice is really open: not settled, not cancelled, and — when
   * SGP names a status at all — one that reads as open.
   *
   * The SGP does not honour `apenas_titulos_em_aberto` everywhere, and what it
   * sends back regardless includes cancelled titles, with a free-text status
   * and no payment. Counted as open, a cancelled 2024 title was the "oldest
   * open invoice" the SGP module highlighted and the second copy billed.
   * Same rule, same order, as the device page's `lib/invoice-filter.ts`:
   * cancellation first, so "cancelado" can never fall into "aberto".
   */
  static isOpenInvoice(invoice) {
    if (!invoice || invoice.paid) return false;
    const status = stripAccents(invoice.status);
    if (INVOICE_CANCELLED_PATTERN.test(status)) return false;
    return !status || INVOICE_OPEN_PATTERN.test(status);
  }

  /**
   * @param {object} options
   * @param {boolean} [options.onlyOpen] ask SGP for open titles, and keep only
   *   those `isOpenInvoice` agrees are open.
   * @param {boolean} [options.includeClosed] with `onlyOpen`, still drop only
   *   the settled ones — for the device page, whose status tabs show the
   *   cancelled and the rest on purpose.
   */
  static async listInvoices({ contract, document, onlyOpen = true, includeClosed = false, limit } = {}) {
    const config = await this.getConfig();
    const payload = this.buildLookupPayload({ contract, document });
    payload.limit = Math.min(Math.max(Number(limit) || config.invoiceLimit, 1), 24);
    if (onlyOpen) {
      payload.apenas_titulos_em_aberto = true;
    }
    const data = await this.request('invoices', payload, config);
    const invoices = firstArray(data, ['titulos', 'titulo', 'faturas', 'dados', 'data'])
      .map((entry) => normalizeInvoice(entry))
      .filter((invoice) => invoice.amount !== null || invoice.dueDate || invoice.id)
      // Not every SGP install honours the "open only" flag, so settled
      // invoices are dropped here as well.
      .filter((invoice) => !onlyOpen || !invoice.paid)
      .filter((invoice) => !onlyOpen || includeClosed || this.isOpenInvoice(invoice));
    invoices.sort((left, right) => String(left.dueDate || '').localeCompare(String(right.dueDate || '')));
    return {
      invoices,
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }

  /**
   * One invoice settled ("baixa") on the SGP: paid on `paidAt`, `amount`
   * received through `method` at the configured receiving point.
   */
  static async settleInvoice({ sgpId, paidAt, amount, method }) {
    const config = await this.getConfig();
    if (!this.canSettle(config)) {
      throw new SgpError('sgp.error.settleNotConfigured', { code: 'settle_not_configured', status: 409 });
    }
    const data = await this.request('invoiceSettle', {
      data_pagamento: paidAt,
      valor_pago: amount,
      forma_pagamento: method,
      ponto_recebimento: config.settleReceivingPoint,
      tarifas: config.settleFees
    }, config, { pathId: sgpId, acceptText: true });
    // A refusal without a `status` flag still names itself: `{ erro: "..." }`.
    const refusal = asText(pick(data || {}, ['erro', 'error', 'errors']));
    if (refusal) {
      throw new SgpError(refusal.slice(0, 300), { code: 'sgp_rejected', status: 502, raw: true });
    }
    const message = typeof data === 'string'
      ? data
      : asText(pick(data || {}, ['msg', 'mensagem', 'message']));
    return { message: message ? String(message).slice(0, 300) : null };
  }

  /**
   * The client's page in the SGP web app, where an attendant goes to do what the
   * panel does not: `/admin/cliente/{id}/contratos/`. Only from a client id the
   * SGP itself sent (or the contacts sync stored), never a guess from the
   * contract number — a wrong id opens someone else's page.
   */
  static clientPageUrl(config, clientId) {
    const id = String(clientId ?? '').trim();
    const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/, '');
    if (!baseUrl || !/^\d+$/.test(id)) return null;
    return `${baseUrl}/admin/cliente/${id}/contratos/`;
  }

  /**
   * The SGP page of the client behind a contract, or null. The contacts sync
   * already stored the client id for most contracts; only when it has not does
   * this ask SGP, and a failure there is a missing button, never a failed page.
   */
  static async clientPageUrlForContract(contract) {
    if (!contract) return null;
    const config = await this.getConfig();
    const stored = await SgpContact.getByContract(contract);
    if (stored?.sgp_client_id) return this.clientPageUrl(config, stored.sgp_client_id);
    try {
      const { contracts } = await this.lookupCustomer({ contract }, config);
      return this.clientPageUrl(config, this.exactContract(contracts, contract)?.clientId);
    } catch {
      return null;
    }
  }

  static async requestTrustUnlock({ contract }) {
    const cleanContract = asText(contract);
    if (!cleanContract) {
      throw new SgpError('sgp.error.contractRequired', {
        code: 'missing_contract',
        status: 400
      });
    }
    const data = await this.request('unlock', { contrato: cleanContract });
    const message = asText(pick(data, ['msg', 'mensagem', 'message']));
    // SGP answers a refused promise (contract not suspended, promise already
    // used this month) with `liberado: false` and a status that is NOT one of
    // the failure flags `request` recognises. Read as success, the operator was
    // told the subscriber was back online when nothing had changed.
    const released = pick(data, ['liberado']);
    if (released !== null && ['0', 'false', 'nao', 'não', 'n'].includes(String(released).trim().toLowerCase())) {
      throw new SgpError(message || 'sgp.error.unlockRefused', {
        code: 'unlock_refused',
        status: 409,
        raw: Boolean(message)
      });
    }
    const days = Number(pick(data, ['liberado_dias', 'liberadoDias', 'dias']));
    return {
      message: message || 'Liberação em confiança solicitada ao SGP',
      protocol: asText(pick(data, ['protocolo', 'protocol'])),
      days: Number.isFinite(days) && days > 0 ? days : null
    };
  }

  /**
   * Opens a support ticket (a "chamado", and the occurrence plus service order
   * behind it) against a contract.
   *
   * The body carries only the fields SGP's own reference documents for this
   * route: `contrato`, `conteudo`, `observacao` and `ocorrenciatipo`, with
   * `app` and `token` added by `request`. Two nearby fields are deliberately
   * absent. `setor` belongs to `/api/ura/central/chamado/`, the subscriber's
   * self-service variant that authenticates with cpfcnpj+senha rather than
   * app+token, so sending it here is at best a field the server ignores.
   * `conteudolimpo` only suppresses SGP's default opening line, and the two
   * references disagree on its spelling — a cosmetic field whose name cannot be
   * settled is not worth the chance of being wrong.
   *
   * The response shape is the half that is not documented anywhere, which is
   * exactly the half tolerant reading covers: whatever the install calls the
   * protocol number, `pick` looks for it under the spellings the other three
   * routes already use, and an unrecognised body is a success with a generic
   * message rather than an error.
   */
  static async openTicket({ contract, content, note = null, occurrenceType = null }) {
    const cleanContract = asText(contract);
    if (!cleanContract) {
      throw new SgpError('sgp.error.contractRequired', {
        code: 'missing_contract',
        status: 400
      });
    }

    const cleanContent = asText(content);
    if (!cleanContent) {
      throw new SgpError('sgp.error.ticketContentRequired', {
        code: 'missing_content',
        status: 400
      });
    }

    const config = this.requireReady(await this.getConfig());
    if (!config.ticketEnabled) {
      throw new SgpError('sgp.error.ticketDisabled', {
        code: 'ticket_disabled',
        status: 409
      });
    }

    const payload = {
      contrato: cleanContract,
      // Trimmed rather than rejected: a technician's note running long is not a
      // reason to refuse to open the ticket.
      conteudo: cleanContent.slice(0, 4000),
      ocorrenciatipo: Number(occurrenceType) > 0
        ? Number(occurrenceType)
        : config.ticketOccurrenceType
    };
    const cleanNote = asText(note);
    if (cleanNote) payload.observacao = cleanNote.slice(0, 2000);

    const data = await this.request('ticket', payload);
    return {
      contract: cleanContract,
      ticket: asText(pick(data, [
        'chamado', 'protocolo', 'ocorrencia', 'os', 'ordemservico', 'id', 'numero'
      ])),
      // Null rather than a hardcoded sentence when the ERP says nothing: the
      // panel speaks eleven languages and the service has no request to
      // translate against, so the caller supplies the wording.
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }

  /**
   * The subscribers the SGP holds under a document or a contract, for the
   * WhatsApp contacts screen.
   *
   * "No such customer" is an empty answer here, not a failure: the operator
   * typed a number and the honest reply is that the SGP has nobody under it.
   */
  static async lookupContacts(filters) {
    try {
      const { contracts } = await this.lookupCustomer(filters);
      return contracts;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /**
   * One page of the full client listing (`endpoints.customerList`).
   *
   * Same transport, credentials and ceilings as every other SGP call. `page`
   * counts from 0 here; the request says whichever the install expects — a row
   * offset, or a page number from 1.
   *
   * @returns {Promise<{ rows: object[], received: number }>} `received` is how
   *   many entries the SGP returned, which is what tells the caller whether the
   *   page was the last one; `rows` can be more (one per contract) or fewer.
   */
  static async listCustomersPage(page, configOverride = null) {
    const config = this.requireReady(configOverride || await this.getConfig());
    if (!config.endpoints.customerList) {
      throw new SgpError('sgp.error.customerListNotConfigured', {
        code: 'customer_list_not_configured',
        status: 409
      });
    }
    const size = config.contactsPageSize;
    const position = config.contactsPaging === 'page' ? page + 1 : page * size;
    const data = await this.request('customerList', {
      [config.contactsOffsetParam]: position,
      [config.contactsLimitParam]: size
    }, config, { listing: true });
    const entries = firstArray(data, ['clientes', 'contratos', 'dados', 'data', 'results', 'items']);
    return {
      rows: entries.flatMap((entry) => normalizeCustomer(entry)),
      received: entries.length,
      // For the test button: which fields the install actually sends, so an
      // operator can see at once whether the path is the right one.
      fields: entries[0] && typeof entries[0] === 'object' ? Object.keys(entries[0]).slice(0, 40) : [],
      shape: listingShape(entries),
      clients: entries.map((entry) => clientProfile(entry)).filter(Boolean)
    };
  }

  /**
   * The listing endpoint's answer for one document, as `listCustomersPage`
   * gives a page: the contract rows and the client profiles. The one-client
   * refresh of the Contacts screen stores both, the way the full sync does.
   */
  static async lookupClientsWithProfiles({ document }) {
    const digits = String(document ?? '').replace(/\D/g, '');
    if (!digits) return { rows: [], clients: [] };
    const config = this.requireReady(await this.getConfig());
    if (!config.endpoints.customerList) return { rows: [], clients: [] };
    try {
      const data = await this.request('customerList', { cpfcnpj: digits }, config, { listing: true });
      const entries = firstArray(data, ['clientes', 'contratos', 'dados', 'data', 'results', 'items'])
        // Only the client asked for: an install that ignores the filter must
        // not refresh a page of strangers.
        .filter((entry) => normalizeCustomer(entry)
          .some((row) => String(row.document ?? '').replace(/\D/g, '') === digits));
      return {
        rows: entries.flatMap((entry) => normalizeCustomer(entry)),
        clients: entries.map((entry) => clientProfile(entry)).filter(Boolean)
      };
    } catch (error) {
      if (isNotFound(error)) return { rows: [], clients: [] };
      throw error;
    }
  }

  /**
   * The clients the listing endpoint holds under one document — the lookup
   * that also finds a client with NO contract, which `consultacliente` (a
   * contract lookup) cannot. Rows as `listCustomersPage` gives them.
   */
  static async lookupClients({ document }) {
    const digits = String(document ?? '').replace(/\D/g, '');
    if (!digits) return [];
    const config = this.requireReady(await this.getConfig());
    if (!config.endpoints.customerList) return [];
    try {
      const data = await this.request('customerList', { cpfcnpj: digits }, config, { listing: true });
      return firstArray(data, ['clientes', 'contratos', 'dados', 'data', 'results', 'items'])
        .flatMap((entry) => normalizeCustomer(entry))
        // Only the client asked for: an install that ignores the filter and
        // answers with a page of everyone must not turn a CPF search into a
        // list of strangers.
        .filter((row) => String(row.document ?? '').replace(/\D/g, '') === digits);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /**
   * The body of `POST /api/crm/cliente/{F|J}`, as the SGP documents it: the
   * address nested under `endereco`, the document and the CEP punctuated, the
   * dates as DD/MM/AAAA and the mobile as national digits. Empty fields are
   * left out rather than sent blank, so the SGP's own defaults apply.
   *
   * @param {object} input
   * @param {'PF'|'PJ'} input.personType
   * @param {string} input.document digits
   * @param {string} input.name the person's name, or the company's legal name
   * @param {object} input.address `{ street, number, complement, district, city, state, zip, reference, latitude, longitude }`
   */
  static buildCrmClientBody(input) {
    const digits = String(input.document ?? '').replace(/\D/g, '');
    const cpfcnpj = digits.length === 14
      ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
      : digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    const zip = String(input.address?.zip ?? '').replace(/\D/g, '');
    const brDate = (value) => {
      const text = String(value ?? '').trim();
      const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
      return /^\d{2}\/\d{2}\/\d{4}$/.test(text) ? text : '';
    };
    // National digits: the SGP formats it itself, and "55" in front would read
    // as a two-digit area code.
    const phone = normalizarTelefoneBr(input.phone);
    const celular = phone ? phone.replace(/^55/, '') : '';
    const number = String(input.address?.number ?? '').trim();
    const lat = Number(input.address?.latitude);
    const lng = Number(input.address?.longitude);

    const endereco = {
      logradouro: input.address?.street,
      // An integer to the SGP: "S/N" and "120A" are left to the complement.
      numero: /^\d+$/.test(number) ? number : '',
      complemento: [input.address?.complement, /^\d+$/.test(number) ? '' : number]
        .map((part) => String(part ?? '').trim()).filter(Boolean).join(' - '),
      bairro: input.address?.district,
      cidade: input.address?.city,
      cep: zip.length === 8 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip,
      uf: String(input.address?.state ?? '').toUpperCase(),
      pais: 'BR',
      pontoreferencia: input.address?.reference,
      map_ll: Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 ? `${lat},${lng}` : ''
    };
    const body = {
      nome: input.name,
      cpfcnpj,
      email: input.email,
      celular,
      endereco,
      observacao: input.notes
    };
    if (input.personType === 'PJ') {
      Object.assign(body, {
        nomefantasia: input.tradeName,
        respempresa: input.responsibleName,
        respcpf: String(input.responsibleDocument ?? '').replace(/\D/g, ''),
        datafundacao: brDate(input.birthDate)
      });
    } else {
      Object.assign(body, { datanasc: brDate(input.birthDate) });
    }
    const compact = (object) => Object.fromEntries(Object.entries(object)
      .map(([key, value]) => [key, value && typeof value === 'object' ? compact(value) : value])
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim?.() !== ''
        && !(typeof value === 'object' && Object.keys(value).length === 0)));
    return compact(body);
  }

  /**
   * Creates the client in the SGP and answers its id.
   *
   * The only proof of success is the `cliente_id`: an install that answers a
   * refusal as HTTP 200 with a `message` and no status flag would otherwise
   * read as a client created.
   *
   * @returns {Promise<{ clientId: string, message: string|null }>}
   */
  static async createClient(input) {
    const body = this.buildCrmClientBody(input);
    let data;
    try {
      data = await this.request('crmClient', body, null, { pathSuffix: input.personType === 'PJ' ? 'J' : 'F' });
    } catch (error) {
      // The SGP's own words on a refusal ("CPF já cadastrado", a missing
      // field) are what the operator needs, and only it can phrase them.
      if (error instanceof SgpError && error.code === 'http_error' && error.details) {
        throw new SgpError(String(error.details), { code: 'sgp_rejected', status: 502, raw: true });
      }
      throw error;
    }
    const clientId = asText(pick(data || {}, ['cliente_id', 'clienteId', 'id']));
    const message = asText(pick(data || {}, ['message', 'msg', 'mensagem']));
    if (!clientId) {
      throw message
        ? new SgpError(message, { code: 'sgp_rejected', status: 502, raw: true })
        : new SgpError('sgp.error.clientCreateFailed', { code: 'client_create_failed', status: 502 });
    }
    return { clientId, message };
  }

  /** The `sgp_contacts` row for one contract — `contractToLinkRow` without the equipment. */
  static contractToContactRow(contract) {
    if (!contract.contract) {
      // A client with no contract: nothing to derive a contract state from.
      return {
        contract: null,
        sgp_client_id: contract.clientId ? String(contract.clientId).slice(0, 64) : null,
        document: contract.document ? String(contract.document).replace(/\D/g, '').slice(0, 32) : null,
        client_name: contract.name ? String(contract.name).slice(0, 255) : null,
        status: contract.status ? String(contract.status).slice(0, 64) : null,
        status_label: null,
        state: 'none',
        phone_e164: contract.phone || null,
        client_ref: contract.clientId ? String(contract.clientId).slice(0, 64) : null
      };
    }
    // No `sgp_client_id` on a contract row: one client can hold several
    // contracts, and the column is unique — it is the key of the row WITHOUT a
    // contract only. The sync uses the client id to retire that row once the
    // client gains a contract.
    return {
      contract: contract.contract,
      document: contract.document ? String(contract.document).replace(/\D/g, '').slice(0, 32) : null,
      client_name: contract.name ? String(contract.name).slice(0, 255) : null,
      status: contract.status ? String(contract.status).slice(0, 64) : null,
      status_label: contract.statusLabel ? String(contract.statusLabel).slice(0, 128) : null,
      state: deriveContractState(contract),
      phone_e164: contract.phone || null,
      client_ref: contract.clientId ? String(contract.clientId).slice(0, 64) : null,
      plan: contract.plan ? String(contract.plan).slice(0, 255) : null,
      due_day: contract.dueDay ? String(contract.dueDay).slice(0, 32) : null,
      status_reason: contract.statusReason ? String(contract.statusReason).slice(0, 255) : null,
      login: contract.login ? String(contract.login).slice(0, 128) : null,
      address: contract.address ? String(contract.address).slice(0, 2000) : null,
      contract_created_at: contract.createdAt ? String(contract.createdAt).slice(0, 32) : null,
      address_parts: contract.addressParts ? JSON.stringify(contract.addressParts).slice(0, 4000) : null,
      contract_cancelled_at: contract.cancelledAt ? String(contract.cancelledAt).slice(0, 32) : null,
      equipment_rented: typeof contract.equipmentRented === 'boolean' ? contract.equipmentRented : null
    };
  }

  static contractToLinkRow(contract, { deviceId, accountId, linkMode }) {
    return {
      device_id: deviceId,
      account_id: accountId ?? null,
      contract: contract.contract,
      document: contract.document ? String(contract.document).replace(/\D/g, '').slice(0, 32) : null,
      client_name: contract.name ? String(contract.name).slice(0, 255) : null,
      plan: contract.plan ? String(contract.plan).slice(0, 255) : null,
      status: contract.status ? String(contract.status).slice(0, 64) : null,
      status_label: contract.statusLabel ? String(contract.statusLabel).slice(0, 128) : null,
      state: deriveContractState(contract),
      login: contract.login ? String(contract.login).slice(0, 255) : null,
      // `phone_manual` is deliberately absent from this row: a sync must never
      // overwrite the correction an operator made by hand. The reader prefers
      // the manual value; this only refreshes what the ERP believes.
      phone_e164: contract.phone || null,
      link_mode: linkMode,
      last_synced_at: new Date()
    };
  }

  /**
   * O contrato que uma PESSOA escolheu, ou nada.
   *
   * `pickContract` existe para responder "qual destes serve", e ali um palpite
   * — o primeiro não bloqueado — é a resposta certa. Quando o número veio de
   * alguém, o palpite é a pior resposta possível: o vínculo governa VLAN e
   * PPPoE no provisionamento, e a troca não aparece em canto nenhum. A tela diz
   * "contrato vinculado", e o número que ela mostra é outro.
   *
   * A regra não é nova neste arquivo: `syncAccount` já a aplica no vínculo
   * manual, com o comentário que a explica — "o operador escolheu aquele
   * contrato". O que faltava era aplicá-la nos dois outros lugares em que um
   * número escolhido a mão passa por `pickContract`.
   */
  static exactContract(contracts, wanted) {
    return contracts.find((entry) => entry.contract === String(wanted)) || null;
  }

  static pickContract(contracts, preferredContract = null) {
    if (contracts.length === 0) return null;
    if (preferredContract) {
      const exact = contracts.find((entry) => entry.contract === String(preferredContract));
      if (exact) return exact;
    }
    return contracts.find((entry) => entry.blocked === false)
      || contracts.find((entry) => /ativo/i.test(entry.statusLabel || ''))
      || contracts[0];
  }

  static isLinkExpired(link, now = Date.now()) {
    const syncedAt = link?.last_synced_at ? new Date(link.last_synced_at).getTime() : Number.NaN;
    if (!Number.isFinite(syncedAt)) return true;
    return now - syncedAt >= LINK_CACHE_TTL_MS;
  }

  /**
   * The login the ONT reports and why there is none, never an error — see
   * `DeviceService.inspectReportedPppoe` for the states.
   *
   * A GenieACS that is unreachable must not turn "this ONT has no contract
   * yet" into a failed page: the caller falls back to having no identifier,
   * which is the state it was already handling.
   */
  static async reportedPppoeLogin(deviceId) {
    try {
      return await DeviceService.inspectReportedPppoe(deviceId);
    } catch (error) {
      console.warn(`Unable to read the reported PPPoE login of ${deviceId}: ${error.message}`);
      return { login: null, state: 'unknown' };
    }
  }

  /**
   * The error for an ONT with no identifier to look up, saying which gap it
   * is. "Check the PPPoE login" sent operators to the SGP cadastre while the
   * login was simply never read off the ONT — every ZTE F-series whose WAN the
   * GenieACS provision never fetched.
   */
  static unlinkedError(reported) {
    if (reported?.state === 'requested') {
      return new SgpError('sgp.error.loginRequested', { code: 'unlinked', status: 404 });
    }
    if (reported?.state === 'empty') {
      return new SgpError('sgp.error.loginNotReported', { code: 'unlinked', status: 404 });
    }
    return new SgpError('sgp.error.deviceUnlinked', { code: 'unlinked', status: 404 });
  }

  // Resolves the SGP contract bound to a panel device. A stored link always
  // wins; otherwise the configured link mode decides which identifier is sent
  // to the SGP lookup, and a successful match is cached in sgp_links.
  static async resolveDeviceContract(deviceId, { refresh = false } = {}) {
    const config = this.requireReady(await this.getConfig());
    const stored = await SgpLink.getByDeviceId(deviceId);
    const account = await CustomerAccount.getByDeviceId(deviceId);

    // A link recorded for a different account belongs to the previous
    // subscriber of this ONT. Never serve it: drop it and look the contract up
    // again for whoever holds the device now.
    const staleOwner = Boolean(
      stored && stored.account_id !== null && account && stored.account_id !== account.id
    );
    if (staleOwner) {
      await SgpLink.deleteByDeviceId(deviceId);
    }

    const usable = staleOwner ? null : stored;
    // Read off `usable`, not `stored`: a manual pin that belonged to the
    // previous subscriber died with the link above, and this ONT is to be
    // resolved afresh rather than reported as having no contract.
    const manual = usable?.link_mode === 'manual' || config.linkMode === 'manual';

    // The login the ONT itself reports, read only when it is the only
    // identifier there is. The mode is called "the ONT's PPPoE login" and the
    // panel has had it since the device listing learned to read it; making it
    // wait for a customer account tied the SGP link to whether the operator
    // wants generated Customer IDs, which is an unrelated decision about the
    // subscriber portal. An account-backed device already carries a login, so
    // this costs nothing there — and the portal, the one caller on a
    // subscriber's critical path, always has an account.
    const reported = !manual
      && config.linkMode === 'pppoe'
      && !normalizeLogin(account?.pppoe_username)
      ? await this.reportedPppoeLogin(deviceId)
      : null;
    const reportedLogin = reported?.login || null;

    // The same protection where there is no account to compare. An ONT whose
    // reported login no longer matches the contract on file is an ONT that
    // changed hands, and the cached contract — with the invoices hanging off
    // it — is the previous subscriber's. The row is left alone rather than
    // deleted, so an operator's corrected phone survives being overwritten by
    // the next successful lookup; it simply stops being an answer.
    const staleLogin = Boolean(
      usable
      && !manual
      && usable.account_id === null
      && reportedLogin
      && usable.login
      && normalizeLogin(usable.login) !== normalizeLogin(reportedLogin)
    );
    const cacheable = Boolean(usable) && !staleLogin;

    if (cacheable && !refresh && !this.isLinkExpired(usable)) {
      return { link: usable, account, source: 'cache' };
    }

    const preferredContract = cacheable ? usable.contract || null : null;
    const filters = manual
      ? { contract: preferredContract }
      : config.linkMode === 'customer_id'
        ? { contract: account?.customer_id }
        : { login: account?.pppoe_username || reportedLogin };

    if (!filters.contract && !filters.login) {
      if (cacheable) return { link: usable, account, source: 'cache' };
      throw this.unlinkedError(reported);
    }

    const { contracts } = await this.lookupCustomer(filters, config);
    // A consulta manual é FILTRADA pelo contrato, e o ERP responde com o
    // cliente inteiro — todos os contratos dele. Deixar `pickContract` escolher
    // aí re-aponta o vínculo que alguém fixou a mão para outro contrato do
    // mesmo cliente, silenciosamente e a cada refresh, que é exatamente o que
    // `syncAccount` se recusa a fazer três métodos abaixo.
    const contract = manual
      ? this.exactContract(contracts, preferredContract)
      : this.pickContract(contracts, preferredContract);
    if (!contract) {
      // A stale cache is better than no answer, but only while it still
      // belongs to the subscriber holding the device.
      if (cacheable) return { link: usable, account, source: 'cache' };
      throw new SgpError('sgp.error.noContractForDevice', {
        code: 'not_found',
        status: 404
      });
    }

    const link = await SgpLink.upsert(this.contractToLinkRow(contract, {
      deviceId,
      accountId: account?.id ?? null,
      linkMode: usable?.link_mode === 'manual' ? 'manual' : 'auto'
    }));
    // Only when the contract changed: a refresh that confirms the same one
    // has nothing new to tell GenieACS.
    if (link?.contract !== usable?.contract) await DeviceTagService.safeReconcile(deviceId);
    return { link, account, contract, source: 'sgp' };
  }

  static async linkDevice(deviceId, { contract, document }) {
    const config = this.requireReady(await this.getConfig());
    const { contracts } = await this.lookupCustomer({ contract, document }, config);
    // Com um contrato nas mãos, só ele serve. Sem ele — a busca foi por
    // documento — a escolha é do painel, e aí `pickContract` é quem responde.
    const selected = contract
      ? this.exactContract(contracts, contract)
      : this.pickContract(contracts);
    if (!selected) {
      throw new SgpError('sgp.error.contractNotFound', { code: 'not_found', status: 404 });
    }
    const account = await CustomerAccount.getByDeviceId(deviceId);
    const link = await SgpLink.upsert(this.contractToLinkRow(selected, {
      deviceId,
      accountId: account?.id ?? null,
      linkMode: 'manual'
    }));
    await DeviceTagService.safeReconcile(deviceId);
    return link;
  }

  static async unlinkDevice(deviceId) {
    const removed = await SgpLink.deleteByDeviceId(deviceId);
    await DeviceTagService.safeReconcile(deviceId);
    return removed;
  }

  // Rows written before the `state` column existed carry no value at all, so the
  // reader always falls back instead of trusting what is stored.
  static linkState(link) {
    return CONTRACT_STATES.includes(link?.state) ? link.state : 'unknown';
  }

  static publicLink(link) {
    if (!link) return null;
    return {
      contract: link.contract,
      clientName: link.client_name,
      document: link.document,
      plan: link.plan,
      status: link.status,
      statusLabel: link.status_label,
      state: this.linkState(link),
      login: link.login,
      linkMode: link.link_mode,
      lastSyncedAt: link.last_synced_at
        ? new Date(link.last_synced_at).toISOString()
        : null
    };
  }

  // The customer portal must never expose the full document of an account.
  static portalLink(link) {
    const base = this.publicLink(link);
    if (!base) return null;
    return { ...base, document: maskDocument(base.document) };
  }

  static async listLinks() {
    this.requireReady(await this.getConfig());
    const links = await SgpLink.getAll();
    return links.map((link) => ({
      deviceId: link.device_id,
      contract: link.contract,
      clientName: link.client_name,
      plan: link.plan,
      status: link.status,
      statusLabel: link.status_label,
      state: this.linkState(link),
      linkMode: link.link_mode,
      lastSyncedAt: link.last_synced_at
        ? new Date(link.last_synced_at).toISOString()
        : null
    }));
  }

  // Refreshes one account during a fleet sync. A manual link is never
  // re-pointed: the operator chose that contract, so only its cached fields are
  // refreshed even when SGP would now answer with a different one.
  static async syncAccount(account, stored, config) {
    const manual = stored?.link_mode === 'manual';
    const filters = manual || config.linkMode === 'manual'
      ? { contract: stored?.contract }
      : config.linkMode === 'customer_id'
        ? { contract: account.customer_id }
        : { login: account.pppoe_username };
    if (!filters.contract && !filters.login) return 'skipped';

    const { contracts } = await this.lookupCustomer(filters, config);
    const contract = manual
      ? contracts.find((entry) => entry.contract === stored.contract) || null
      : this.pickContract(contracts, stored?.contract || null);
    if (!contract) return 'skipped';

    await SgpLink.upsert(this.contractToLinkRow(contract, {
      deviceId: account.device_id,
      accountId: account.id,
      linkMode: manual ? 'manual' : 'auto'
    }));
    return stored ? 'updated' : 'created';
  }

  /**
   * Every device this run should try to link.
   *
   * The accounts, plus — in the mode that matches on the ONT's own login —
   * the devices that have none. Without those the sweep only ever reaches
   * devices some other feature happened to create an account for, and an
   * operator who does not generate Customer IDs would see the contract column
   * fill one ONT at a time, as someone opened each page.
   *
   * Shaped like accounts because that is all `syncAccount` reads: a device
   * with no account carries a null id, which `contractToLinkRow` already
   * stores — `sgp_links.account_id` has been nullable since the table existed.
   */
  static async syncTargets(config) {
    const accounts = await CustomerAccount.getSyncTargets();
    if (config.linkMode !== 'pppoe') return accounts;

    let devices;
    try {
      devices = await DeviceService.getCustomerIdentityDevices();
    } catch (error) {
      // A sweep that reaches the accounts is worth more than no sweep.
      console.warn(`SGP fleet sync could not read the ONT fleet: ${error.message}`);
      return accounts;
    }

    const covered = new Set(accounts.map((account) => String(account.device_id)));
    const uncovered = devices.filter((device) => device._id && !covered.has(String(device._id)));
    const probed = await this.probeUnreadLogins(
      uncovered.filter((device) => !normalizeLogin(device.pppoe))
    );
    const extra = uncovered
      .map((device) => ({
        ...device,
        pppoe: normalizeLogin(device.pppoe) ? device.pppoe : probed.get(device._id)
      }))
      .filter((device) => normalizeLogin(device.pppoe))
      .map((device) => ({
        id: null,
        device_id: device._id,
        customer_id: null,
        pppoe_username: device.pppoe
      }));
    return [...accounts, ...extra];
  }

  /** ONTs without a login one sweep looks into, at most. */
  static LOGIN_PROBE_BATCH = 25;

  /** `${tenant}\0${device}` → when a sweep last looked into its login. */
  static loginProbes = new Map();

  /**
   * Looks into the ONTs the identity read found no login for, a batch per
   * sweep, and returns the logins that turned up.
   *
   * The identity read projects named paths only, so an ONT whose login sits
   * elsewhere — or was never read off it — is invisible to it. Inspecting one
   * finds the first kind now and queues a read for the second, so the next
   * sweep after its Inform links it. Each ONT is looked into once an hour at
   * most, which is what lets a fleet of bridged ONTs rotate through the batch
   * instead of holding it forever.
   */
  static async probeUnreadLogins(devices) {
    const found = new Map();
    const now = Date.now();
    const due = devices.filter((device) => {
      const last = this.loginProbes.get(DeviceService.pppoeReadKey(device._id));
      return !last || now - last >= DeviceService.PPPOE_READ_INTERVAL_MS;
    }).slice(0, this.LOGIN_PROBE_BATCH);
    for (const device of due) {
      this.loginProbes.set(DeviceService.pppoeReadKey(device._id), now);
      const reported = await this.reportedPppoeLogin(device._id);
      if (reported.login) found.set(device._id, reported.login);
    }
    return found;
  }

  // Fleet-wide refresh of every device this install can identify — see
  // `syncTargets` for which those are.
  // `linked` counts the devices that hold a link once the run is over, so it
  // also covers the ones whose refresh failed but whose cached link survived.
  // `skipped` covers devices with no identifier for the configured link mode
  // and lookups that matched no contract, however SGP phrased that answer;
  // `failed` covers real SGP errors only.
  static async syncFleet() {
    const config = this.requireReady(await this.getConfig());
    const startedAt = new Date();
    // First, so the refresh below confirms the links where they now are.
    let relinked = 0;
    let stranded = new Set();
    try {
      ({ relinked, stranded } = await this.relinkStale());
    } catch (error) {
      console.warn(`SGP fleet sync could not look for stranded links: ${error.message}`);
    }
    const targets = (await this.syncTargets(config))
      .filter((target) => !stranded.has(String(target.device_id)));
    const stored = new Map(
      (await SgpLink.getAll()).map((link) => [link.device_id, link])
    );
    const summary = {
      total: targets.length,
      linked: 0,
      created: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      relinked
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const account = targets[cursor];
        cursor += 1;
        const link = stored.get(account.device_id) || null;
        let outcome;
        try {
          outcome = await this.syncAccount(account, link, config);
        } catch (error) {
          // One unreachable contract must never cost the operator the run.
          outcome = isNotFound(error) ? 'skipped' : 'failed';
          if (!(error instanceof SgpError)) {
            console.error(`SGP fleet sync failed for ${account.device_id}:`, error);
          }
        }
        summary[outcome] += 1;
        if (outcome === 'created' || outcome === 'updated' || link) summary.linked += 1;
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(SYNC_CONCURRENCY, targets.length) },
      () => worker()
    ));

    const finishedAt = new Date();
    const result = {
      ...summary,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString()
    };
    // After the links are settled, so the tags describe where this run left
    // them — and this is what tags a fleet linked before tagging existed.
    await DeviceTagService.safeReconcileFleet();
    await AppState.upsert(SYNC_STATE_KEY, JSON.stringify(result));
    return result;
  }

  /**
   * The equipment that most likely took over from a silent ONT: another
   * device reporting the same PPPoE login, or one already linked to the same
   * contract, that informed more recently. The most recent wins; null when
   * there is none, which means the ONT is unplugged or its replacement never
   * reached this GenieACS.
   */
  static findSuccessor(device, link, devices, links) {
    const deviceId = String(device?._id || '');
    const login = normalizeLogin(link?.login) || normalizeLogin(device?.pppoe);
    const since = device?._lastInform ? new Date(device._lastInform).getTime() : Number.NEGATIVE_INFINITY;
    let best = null;
    for (const other of devices) {
      const otherId = String(other?._id || '');
      if (!otherId || otherId === deviceId || !other._lastInform) continue;
      const informedAt = new Date(other._lastInform).getTime();
      if (!(informedAt > since)) continue;
      const matchedBy = login && normalizeLogin(other.pppoe) === login
        ? 'pppoe'
        : link?.contract && links.get(otherId)?.contract === link.contract
          ? 'contract'
          : null;
      if (!matchedBy) continue;
      if (!best || informedAt > best.informedAt) {
        best = { deviceId: otherId, lastInform: other._lastInform, matchedBy, informedAt };
      }
    }
    if (!best) return null;
    const { informedAt, ...successor } = best;
    return successor;
  }

  /**
   * Moves the links stranded on ONTs that went silent days ago onto the ONT
   * now informing with the same PPPoE login.
   *
   * The swap detection in `CustomerService.ensureAccount` only runs with
   * generated Customer IDs and only once the new ONT's login was read, so an
   * operator without either kept seeing the contract on the old ONT — N/D
   * everywhere — while the subscriber browsed through the new one, and every
   * fleet sync confirmed the stale link again. `DeviceSwapService.record`
   * moves the link, reconciles the tags, logs the swap for the dashboard and
   * holds a pair that keeps trading the login. A manual link is the
   * operator's and is never moved.
   *
   * Returns the stranded ONTs too, so the sweep that follows does not look
   * their login up again and write the contract straight back onto them.
   */
  static async relinkStale() {
    const devices = await DeviceService.getCustomerIdentityDevices();
    const links = new Map((await SgpLink.getAll()).map((link) => [link.device_id, link]));
    const now = Date.now();
    const ageOf = (device) => (device?._lastInform
      ? now - new Date(device._lastInform).getTime()
      : Number.POSITIVE_INFINITY);
    let relinked = 0;
    const stranded = new Set();
    for (const device of devices) {
      const deviceId = String(device._id || '');
      const link = links.get(deviceId);
      if (link?.link_mode === 'manual') continue;
      if (ageOf(device) < DeviceService.STALE_AFTER_MS) continue;
      const successor = this.findSuccessor(device, link, devices, links);
      if (!successor || successor.matchedBy !== 'pppoe') continue;
      if (!(ageOf({ _lastInform: successor.lastInform }) < ONLINE_WINDOW_MS)) continue;
      stranded.add(deviceId);
      if (!link) continue;
      try {
        const account = await CustomerAccount.getByDeviceId(deviceId);
        const swap = await DeviceSwapService.record(account, deviceId, successor.deviceId, 'stale_pppoe');
        if (swap && swap.link_action !== 'held') relinked += 1;
        links.delete(deviceId);
      } catch (error) {
        console.warn(`Unable to move the SGP link off stale ONT ${deviceId}: ${error.message}`);
      }
    }
    return { relinked, stranded };
  }

  static async getLastSync() {
    const raw = await AppState.get(SYNC_STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Cross-references what GenieACS knows (is the ONT informing?) with what SGP
  // knows (is the contract payable?). Neither system can see these two on its
  // own: an ONT online on a blocked contract is a possible unauthorised
  // reconnection, and an active contract with a silent ONT is a customer with a
  // problem who has not called yet.
  static async getFleetOverview() {
    this.requireReady(await this.getConfig());
    const devices = await DeviceService.getCustomerIdentityDevices();
    const links = new Map(
      (await SgpLink.getAll()).map((link) => [link.device_id, link])
    );
    const deviceIds = devices.map((device) => String(device._id || '')).filter(Boolean);
    const customerIds = new Map(
      (await CustomerAccount.getIdsByDeviceIds(deviceIds))
        .map((row) => [row.device_id, row.customer_id])
    );

    const now = Date.now();
    const byState = { active: 0, blocked: 0, cancelled: 0, unknown: 0 };
    const onlineBlocked = [];
    const offlineActive = [];
    const staleActive = [];
    const unlinked = [];
    let linked = 0;

    for (const device of devices) {
      const deviceId = String(device._id || '');
      if (!deviceId) continue;
      const link = links.get(deviceId);
      if (!link) {
        unlinked.push({
          deviceId,
          customerId: customerIds.get(deviceId) || null,
          pppoe: device.pppoe || null
        });
        continue;
      }

      linked += 1;
      const state = this.linkState(link);
      byState[state] += 1;
      const lastInform = device._lastInform || null;
      const age = lastInform ? now - new Date(lastInform).getTime() : Number.NaN;
      const online = Number.isFinite(age) && age >= 0 && age < ONLINE_WINDOW_MS;
      const entry = {
        deviceId,
        contract: link.contract,
        clientName: link.client_name,
        statusLabel: link.status_label,
        state,
        lastInform
      };
      if (online && (state === 'blocked' || state === 'cancelled')) {
        onlineBlocked.push(entry);
      } else if (!online && state === 'active') {
        offlineActive.push(entry);
        if (!(age < DeviceService.STALE_AFTER_MS)) {
          staleActive.push({
            ...entry,
            successor: this.findSuccessor(device, link, devices, links)
          });
        }
      }
    }

    // GenieACS timestamps are ISO strings, so they order lexicographically.
    // The most recent reconnection and the longest silence come first.
    const informOrder = (left, right) => String(left.lastInform || '')
      .localeCompare(String(right.lastInform || ''));
    onlineBlocked.sort((left, right) => informOrder(right, left));
    offlineActive.sort(informOrder);
    staleActive.sort(informOrder);

    return {
      enabled: true,
      totals: {
        devices: deviceIds.length,
        linked,
        unlinked: unlinked.length,
        onlineBlocked: onlineBlocked.length,
        offlineActive: offlineActive.length,
        staleActive: staleActive.length
      },
      byState,
      // The lists are samples capped at DIVERGENCE_LIMIT; `totals` always
      // carries the full counts.
      divergences: {
        onlineBlocked: onlineBlocked.slice(0, DIVERGENCE_LIMIT),
        offlineActive: offlineActive.slice(0, DIVERGENCE_LIMIT),
        staleActive: staleActive.slice(0, DIVERGENCE_LIMIT),
        unlinked: unlinked.slice(0, DIVERGENCE_LIMIT)
      },
      lastSync: await this.getLastSync(),
      generatedAt: new Date().toISOString()
    };
  }

  static async testConnection(overrides = {}) {
    const current = await this.getConfig();
    const baseUrl = overrides.baseUrl === undefined
      ? current.baseUrl
      : this.normalizeBaseUrl(overrides.baseUrl);
    const config = {
      ...current,
      baseUrl,
      app: overrides.app === undefined ? current.app : String(overrides.app).trim(),
      // O token salvo vai no corpo da requisição. Testar um endereço vindo do
      // navegador com ele faria deste botão um jeito de LER o segredo — aponte
      // para um servidor seu e leia o corpo. Contra a origem já salva não há o
      // que extrair; para uma nova, o token tem que ser digitado.
      token: overrides.token
        ? String(overrides.token).trim()
        : (this.sameOrigin(baseUrl, current.baseUrl) ? current.token : null),
      // A connectivity probe must run even before the integration is switched on.
      enabled: true,
      endpoints: { ...current.endpoints, ...(overrides.endpoints || {}) }
    };
    if (!config.baseUrl || !config.app || !config.token) {
      throw new SgpError('sgp.error.testCredentialsRequired', {
        code: 'incomplete_config',
        status: 400
      });
    }
    // SGP requires at least one filter, so a probe without a sample customer
    // asks for a document that cannot exist. A "customer not found" answer
    // still proves the URL, app and token are valid.
    const hasSample = Boolean(overrides.document || overrides.contract || overrides.login);
    const filters = hasSample
      ? this.buildLookupPayload({
        document: overrides.document,
        contract: overrides.contract,
        login: overrides.login
      })
      : { cpfcnpj: '00000000000' };

    let data;
    try {
      data = await this.request('customer', filters, config);
    } catch (error) {
      if (error instanceof SgpError && error.code === 'sgp_rejected') {
        if (/token|app|autoriza|credenc|permiss/i.test(error.message)) {
          throw new SgpError('sgp.error.credentialsRejected', {
            code: 'unauthorized',
            status: 502
          });
        }
        return {
          contracts: 0,
          probe: hasSample ? 'filtered' : 'anonymous',
          messageKey: 'sgp.testAccepted',
          // A rejection SGP itself phrased is quoted; our own errors are
          // identified by code so no untranslated key reaches the operator.
          messageVars: { error: error.translationKey ? error.code : error.message }
        };
      }
      throw error;
    }

    const contracts = firstArray(data, ['contratos', 'contrato', 'dados', 'data', 'clientes'])
      .map((entry) => normalizeContract(entry))
      .filter(Boolean);
    return {
      contracts: contracts.length,
      probe: hasSample ? 'filtered' : 'anonymous',
      message: asText(pick(data, ['msg', 'mensagem', 'message']))
    };
  }
}

export { deriveContractState, maskDocument, normalizeContract, normalizeInvoice };
export default SgpService;
