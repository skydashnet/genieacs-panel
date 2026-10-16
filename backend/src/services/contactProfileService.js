import { tdb, tinsert } from '../config/database.js';
import SgpClient from '../models/SgpClient.js';
import SgpContact from '../models/SgpContact.js';
import SgpLink from '../models/SgpLink.js';
import SgpService from './sgpService.js';
import TeiahService from './teiahService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

const CONTACT_KEY = /^c:(\d+)$/;

// Loaded on demand: the conversation service reaches back to this one.
const waConversations = async () => (await import('./waConversationService.js')).default;

/**
 * The fields of a client record an operator may edit, and where the SGP's own
 * value lives. What an operator typed is kept per field in `overrides` and
 * wins over the SGP's until someone restores it.
 */
export const PROFILE_FIELDS = Object.freeze([
  'name', 'personType', 'document', 'gender', 'birthDate', 'address', 'phones', 'emails'
]);

const ADDRESS_PARTS = Object.freeze([
  'street', 'number', 'complement', 'district', 'city', 'state', 'zip', 'reference', 'line'
]);

/**
 * The WhatsApp number of a contract, from its ONT row (`sgp_links`) and its
 * contacts row (`sgp_contacts`), either of which may be missing: a number
 * corrected by hand wins over one the SGP sent, and between two of the same
 * kind the contacts row's — the one the client record edits — wins. The
 * record and the conversation it opens read it here, so they agree.
 */
export function whatsappPhoneOf(link, contact) {
  const candidates = [
    [contact?.phone_manual, 'manual'],
    [link?.phone_manual, 'manual'],
    [contact?.phone_e164, 'sgp'],
    [link?.phone_e164, 'sgp']
  ];
  for (const [raw, source] of candidates) {
    const phone = normalizarTelefoneBr(raw);
    if (phone) return { phone, phoneSource: source };
  }
  return { phone: null, phoneSource: null };
}

export class ContactProfileError extends Error {
  constructor(message, { code = 'invalid', status = 400, vars = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.translationKey = message;
    this.translationVars = vars;
  }
}

function invalid(field) {
  return new ContactProfileError('contacts.error.invalidField', { code: 'invalid_field', vars: { field } });
}

function text(value, field, max) {
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid(field);
  const trimmed = String(value).trim();
  if (trimmed.length > max) throw invalid(field);
  return trimmed || null;
}

/**
 * One edited field, checked and put in the shape the record keeps. `null`
 * means "restore the SGP's value", and is returned as is.
 */
function cleanField(field, value) {
  if (value === null) return null;
  switch (field) {
    case 'name': return text(value, field, 255);
    case 'personType': return text(value, field, 16)?.toUpperCase() ?? null;
    case 'document': {
      const digits = String(text(value, field, 32) ?? '').replace(/\D/g, '');
      if (value && !digits) throw invalid(field);
      return digits || null;
    }
    case 'gender': return text(value, field, 16);
    case 'birthDate': return text(value, field, 32);
    case 'address': {
      if (typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
      const address = {};
      for (const part of ADDRESS_PARTS) {
        const cleaned = value[part] === undefined ? null : text(value[part], field, 255);
        if (cleaned) address[part] = cleaned;
      }
      return address;
    }
    case 'phones': {
      if (!Array.isArray(value) || value.length > 20) throw invalid(field);
      return [...new Set(value.map((phone) => {
        const normalized = normalizarTelefoneBr(phone);
        if (!normalized) throw invalid(field);
        return normalized;
      }))];
    }
    case 'emails': {
      if (!Array.isArray(value) || value.length > 20) throw invalid(field);
      return [...new Set(value.map((email) => {
        const cleaned = String(text(email, field, 255) ?? '').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+$/.test(cleaned)) throw invalid(field);
        return cleaned;
      }))];
    }
    default: throw invalid(field);
  }
}

/** The SGP's value of one field, from the record and — for the basics — the contract row. */
function sgpValue(field, client, row) {
  switch (field) {
    case 'name': return client?.name ?? row?.client_name ?? null;
    case 'personType': return client?.person_type ?? null;
    case 'document': return client?.document ?? row?.document ?? null;
    case 'gender': return client?.gender ?? null;
    case 'birthDate': return client?.birth_date ?? null;
    case 'address': return client?.address ?? null;
    case 'phones': return client?.phones?.length ? client.phones : (row?.phone_e164 ? [row.phone_e164] : []);
    case 'emails': return client?.emails ?? [];
    default: return null;
  }
}

/** What the record shows for one field: the operator's edit, or the SGP's value. */
export function shownValue(field, client, row) {
  const edit = client?.overrides?.[field];
  return edit ? edit.value : sgpValue(field, client, row);
}

/**
 * One edited field, checked and put in the shape the record keeps — the same
 * check a PATCH goes through, for the spreadsheet import.
 */
export function checkField(field, value) {
  return cleanField(field, value);
}

function isSgpId(clientId) {
  return Boolean(clientId) && !/^(panel|doc):/.test(String(clientId));
}

/**
 * The client record behind the Contacts screen: who the person is, every way
 * to reach them, their contracts, and what an operator corrected by hand.
 *
 * Addressed by the same key as the contacts list — a contract, or `c:<id>` for
 * a client with no contract — so every row of that list opens its record.
 */
class ContactProfileService {
  /** The `sgp_contacts` row a key names, or a stand-in built from `sgp_links`. */
  static async rowFor(key) {
    const raw = String(key ?? '').trim();
    if (!raw) return null;
    const byId = raw.match(CONTACT_KEY);
    if (byId) return SgpContact.getById(byId[1]);
    const contact = await SgpContact.getByContract(raw);
    if (contact) return contact;
    // A contract with an ONT that no contacts sync stored yet: the link row
    // has what a record needs to start from.
    const links = await SgpLink.getByContract(raw);
    const link = links[0];
    if (!link) return null;
    return {
      id: null,
      contract: link.contract,
      document: link.document,
      client_name: link.client_name,
      status: link.status,
      status_label: link.status_label,
      state: link.state,
      phone_e164: link.phone_e164,
      phone_manual: link.phone_manual,
      client_ref: null,
      plan: link.plan,
      login: link.login,
      fromLink: true
    };
  }

  /** The client record a row belongs to, if the sync (or an edit) made one. */
  static async clientFor(row) {
    if (!row) return null;
    const clientKey = row.client_ref || (!row.contract ? row.sgp_client_id : null);
    if (clientKey) {
      const client = await SgpClient.getBySgpId(clientKey);
      if (client) return client;
    }
    return row.document ? SgpClient.getByDocument(row.document) : null;
  }

  static async get(key) {
    const row = await this.rowFor(key);
    if (!row) return null;
    const client = await this.clientFor(row);
    return this.present(String(key), row, client);
  }

  static async present(key, row, client) {
    const overrides = client?.overrides ?? {};
    const fields = {};
    for (const field of PROFILE_FIELDS) {
      const original = sgpValue(field, client, row);
      const edit = overrides[field];
      fields[field] = {
        value: edit ? edit.value : original,
        sgpValue: original,
        edited: Boolean(edit),
        editedBy: edit?.by ?? null,
        editedAt: edit?.at ?? null
      };
    }

    // Every contract of the client when there is a record to gather them by;
    // the one row otherwise.
    const rows = client ? await SgpContact.getByClient(client.sgp_client_id) : [];
    const contractRows = rows.filter((entry) => entry.contract);
    if (row.contract && !contractRows.some((entry) => entry.contract === row.contract)) contractRows.unshift(row);
    const devices = contractRows.length
      ? await tdb('sgp_links').whereIn('contract', contractRows.map((entry) => String(entry.contract))).select('contract', 'device_id')
      : [];

    const link = row.fromLink ? row : (row.contract ? await tdb('sgp_links').where({ contract: String(row.contract) }).first() : null);
    const whatsapp = whatsappPhoneOf(link, row.fromLink ? null : row);

    const config = await SgpService.getConfig().catch(() => null);
    const clientId = client?.sgp_client_id ?? null;
    return {
      key,
      source: client?.source ?? 'sgp',
      clientId: isSgpId(clientId) ? clientId : null,
      sgpUrl: config && isSgpId(clientId) ? SgpService.clientPageUrl(config, clientId) : null,
      // Whether "Receber" can work here: the settlement configured, and the
      // payment methods the operator picks from.
      settle: config && SgpService.canSettle(config) ? { methods: [...config.settlePaymentMethods] } : null,
      fields,
      // What the TeiaH said the last time it was asked, and whether it can be asked.
      teiah: client?.teiah ?? null,
      teiahReady: TeiahService.isReady(await TeiahService.getConfig().catch(() => null)),
      notes: client?.notes ?? null,
      registeredAt: client?.registered_at ?? null,
      lastSeenAt: client?.last_seen_at ?? row.last_seen_at ?? null,
      whatsappPhone: whatsapp.phone,
      whatsappPhoneSource: whatsapp.phoneSource,
      contracts: contractRows.map((entry) => {
        const device = devices.find((link) => String(link.contract) === String(entry.contract));
        return {
          key: String(entry.contract),
          contract: String(entry.contract),
          state: entry.state || 'unknown',
          status: entry.status_label || entry.status || null,
          statusReason: entry.status_reason ?? null,
          plan: entry.plan ?? null,
          dueDay: entry.due_day ?? null,
          login: entry.login ?? null,
          address: entry.address ?? null,
          createdAt: entry.contract_created_at ?? null,
          deviceId: device?.device_id ?? null,
          hasDevice: Boolean(device)
        };
      })
    };
  }

  /**
   * The record a row edits into, made on first edit when the sync has not
   * made one yet (a contract found by a lookup, or before the first sync).
   */
  static async ensureClient(row) {
    const existing = await this.clientFor(row);
    if (existing) return existing;
    const key = row.client_ref
      || (!row.contract && row.sgp_client_id)
      || (row.document ? `doc:${row.document}` : `contract:${row.contract ?? row.id}`);
    const client = await SgpClient.upsertFromSgp({
      clientId: key,
      document: row.document,
      name: row.client_name,
      phones: row.phone_e164 ? [row.phone_e164] : []
    });
    if (row.id && !row.client_ref) {
      await tdb('sgp_contacts').where({ id: row.id }).update({ client_ref: client.sgp_client_id, updated_at: new Date() });
    }
    return client;
  }

  /**
   * Applies an operator's edit. A field set to `null` goes back to the SGP's
   * value; `notes` and `whatsappPhone` are the operator's own and have no SGP
   * value to go back to.
   *
   * @returns {Promise<{ profile: object, changed: string[] }>}
   */
  static async update(key, body, actor) {
    const row = await this.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const input = body && typeof body === 'object' ? body : {};
    const changed = [];

    const edits = {};
    for (const field of PROFILE_FIELDS) {
      if (input[field] !== undefined) edits[field] = cleanField(field, input[field]);
    }
    const notes = input.notes === undefined ? undefined : text(input.notes, 'notes', 5000);
    const whatsappPhone = input.whatsappPhone === undefined
      ? undefined
      : (input.whatsappPhone === null ? null : normalizarTelefoneBr(input.whatsappPhone));
    if (input.whatsappPhone && !whatsappPhone) throw invalid('whatsappPhone');

    if (Object.keys(edits).length > 0 || notes !== undefined) {
      const client = await this.ensureClient(row);
      const overrides = { ...(client.overrides ?? {}) };
      const at = new Date().toISOString();
      const by = actor ?? null;
      for (const [field, value] of Object.entries(edits)) {
        if (value === null) {
          if (overrides[field]) changed.push(field);
          delete overrides[field];
        } else {
          overrides[field] = { value, by, at };
          changed.push(field);
        }
      }
      if (notes !== undefined && notes !== (client.notes ?? null)) changed.push('notes');
      await SgpClient.update(client.id, { overrides, ...(notes !== undefined ? { notes } : {}) });
    }

    if (whatsappPhone !== undefined) {
      const before = row.contract
        ? (await (await waConversations()).contractPhones(row.contract)).current
        : whatsappPhoneOf(null, row).phone;
      if (row.fromLink) {
        await SgpLink.setManualPhone(row.contract, whatsappPhone);
      } else {
        await SgpContact.setManualPhoneById(row.id, whatsappPhone);
      }
      changed.push('whatsappPhone');
      // A conversa presa ao número anterior sai do cliente: abrir a conversa
      // da ficha vai ao número novo.
      if (before && before !== whatsappPhone) {
        await (await waConversations()).retireAfterPhoneEdit({
          contract: row.contract ?? null, contactId: row.id ?? null, oldPhone: before
        });
      }
    }

    return { profile: await this.get(key), changed };
  }

  /** A client with no SGP behind it, typed in the panel. */
  static async create(body, actor, { importSource = null } = {}) {
    const input = body && typeof body === 'object' ? body : {};
    const name = cleanField('name', input.name ?? null);
    if (!name) throw invalid('name');
    const at = new Date().toISOString();
    const overrides = {};
    for (const field of PROFILE_FIELDS) {
      if (input[field] === undefined || input[field] === null) continue;
      overrides[field] = { value: cleanField(field, input[field]), by: actor ?? null, at };
    }
    const whatsappPhone = input.whatsappPhone ? normalizarTelefoneBr(input.whatsappPhone) : null;
    if (input.whatsappPhone && !whatsappPhone) throw invalid('whatsappPhone');
    const notes = input.notes === undefined ? null : text(input.notes, 'notes', 5000);

    const client = await SgpClient.createFromPanel({ overrides, notes });
    // Its row in the contacts list, so the client shows there and can be
    // written to like anyone the SGP sent.
    const now = new Date();
    await tinsert('sgp_contacts', {
      contract: null,
      sgp_client_id: client.sgp_client_id,
      client_ref: client.sgp_client_id,
      document: overrides.document?.value ?? null,
      client_name: name,
      import_source: importSource,
      state: 'none',
      phone_e164: whatsappPhone ?? overrides.phones?.value?.[0] ?? null,
      last_synced_at: now,
      created_at: now,
      updated_at: now
    });
    const row = await SgpContact.getClientRow(client.sgp_client_id);
    return this.get(`c:${row.id}`);
  }

  /**
   * The name an operator gave a client, for the contacts list: one batched
   * read for the page. Only the name — it is what the list shows.
   */
  static async editedNames(rows) {
    const keys = [...new Set(rows.map((row) => row.client_ref || (!row.contract ? row.sgp_client_id : null)).filter(Boolean))];
    if (keys.length === 0) return new Map();
    const clients = await tdb('sgp_clients').whereIn('sgp_client_id', keys).select('sgp_client_id', 'overrides');
    const names = new Map();
    for (const client of clients) {
      const name = SgpClient.parse(client).overrides?.name?.value;
      if (name) names.set(client.sgp_client_id, name);
    }
    return names;
  }

  /** Open invoices of each contract of the client, asked of the SGP now. */
  static async invoices(key) {
    const profile = await this.get(key);
    if (!profile) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const results = [];
    for (const contract of profile.contracts) {
      // eslint-disable-next-line no-await-in-loop -- few contracts per client, and the SGP answers one at a time
      const { invoices } = await SgpService.listInvoices({ contract: contract.contract });
      results.push({ contract: contract.contract, invoices });
    }
    return results;
  }
}

export default ContactProfileService;
