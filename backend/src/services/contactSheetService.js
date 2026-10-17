import { tdb } from '../config/database.js';
import SgpClient from '../models/SgpClient.js';
import ContactProfileService, { ContactProfileError, checkField, shownValue } from './contactProfileService.js';
import WaContactService from './waContactService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { toCsvWith } from '../utils/csv.js';

/** The largest spreadsheet the import reads: well over the biggest base this panel serves. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_MAX_ROWS = 20000;
/** How many changed rows the preview lists one by one; the counts cover all of them. */
const PREVIEW_ROWS = 200;

/**
 * The columns of the spreadsheet, in order. The header is Portuguese because
 * the people opening it in Excel read Portuguese; the import also accepts the
 * field name itself (`name`, `street`…), so a sheet built by a script works.
 *
 * `editable` columns are the ones an import may change; the rest come from the
 * SGP (or the panel) and are there to be read.
 */
const COLUMNS = [
  { field: 'key', header: 'Chave' },
  { field: 'contract', header: 'Contrato' },
  { field: 'name', header: 'Nome', editable: true },
  { field: 'personType', header: 'Tipo', editable: true },
  { field: 'document', header: 'CPF/CNPJ', editable: true },
  { field: 'birthDate', header: 'Nascimento', editable: true },
  { field: 'gender', header: 'Sexo', editable: true },
  { field: 'street', header: 'Logradouro', address: true },
  { field: 'number', header: 'Número', address: true },
  { field: 'complement', header: 'Complemento', address: true },
  { field: 'district', header: 'Bairro', address: true },
  { field: 'city', header: 'Cidade', address: true },
  { field: 'state', header: 'UF', address: true },
  { field: 'zip', header: 'CEP', address: true },
  { field: 'reference', header: 'Referência', address: true },
  { field: 'whatsappPhone', header: 'WhatsApp', editable: true },
  { field: 'phones', header: 'Telefones', editable: true, list: true },
  { field: 'emails', header: 'E-mails', editable: true, list: true },
  { field: 'plan', header: 'Plano' },
  { field: 'dueDay', header: 'Vencimento' },
  { field: 'status', header: 'Situação' },
  { field: 'hasDevice', header: 'Tem ONT' },
  { field: 'notes', header: 'Observações', editable: true }
];

const ADDRESS_PARTS = COLUMNS.filter((column) => column.address).map((column) => column.field);
const LIST_SEPARATOR = ', ';

function sheetError(key, vars = null, status = 400) {
  return new ContactProfileError(key, { code: key.split('.').pop(), status, vars });
}

// ── CSV ───────────────────────────────────────────────────────────────────

/** A CSV as Excel in Portuguese opens it — the rules live in `utils/csv.js`. */
export function toCsv(rows) {
  return toCsvWith(COLUMNS, rows);
}

/**
 * Parses a CSV the way Excel and LibreOffice write one: quoted cells with
 * doubled quotes, line breaks inside quotes, and `;` or `,` as the separator —
 * whichever the header line uses.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

const HEADER_INDEX = new Map(COLUMNS.flatMap((column) => [
  [normalizeHeader(column.header), column],
  [normalizeHeader(column.field), column]
]));

function unescapeCell(value) {
  const text = String(value ?? '').trim();
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

/** A value as the comparison sees it: object keys sorted, an address's one-line form as its street. */
function comparable(field, value) {
  let shaped = value ?? null;
  if (field === 'address' && shaped) {
    const { line, ...parts } = shaped;
    shaped = line && !parts.street ? { ...parts, street: line } : parts;
  }
  if (shaped && typeof shaped === 'object' && !Array.isArray(shaped)) {
    return JSON.stringify(Object.fromEntries(Object.entries(shaped).sort(([a], [b]) => a.localeCompare(b))));
  }
  return JSON.stringify(shaped);
}

const splitList = (value) => String(value ?? '').split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);

// ── The service ───────────────────────────────────────────────────────────

/**
 * The contacts as a spreadsheet, out and back in.
 *
 * Export writes one row per contract (and one per client with none), with
 * what the record shows — an operator's edit where there is one. Import reads
 * the same columns back: every changed cell becomes an edit of the record,
 * exactly as if typed in the panel, so the next sync leaves it alone. An empty
 * cell means "leave as is", never "clear": a sheet with fewer columns must not
 * wipe what it did not carry.
 */
class ContactSheetService {
  static COLUMNS = COLUMNS;

  /** The rows of the export, for the contacts the list shows with this search and state. */
  static async exportRows({ search = '', state = '', noPhone = false, imported = false, device = '' } = {}) {
    const subscribers = await WaContactService.collect({ search, state, noPhone, imported, device });
    if (subscribers.length === 0) return [];

    const contacts = await tdb('sgp_contacts');
    const byContract = new Map(contacts.filter((row) => row.contract).map((row) => [String(row.contract), row]));
    const byId = new Map(contacts.map((row) => [Number(row.id), row]));
    const links = await tdb('sgp_links').select('contract', 'plan', 'device_id');
    const linkByContract = new Map(links.map((link) => [String(link.contract), link]));
    const clients = (await tdb('sgp_clients')).map((client) => SgpClient.parse(client));
    const clientByKey = new Map(clients.map((client) => [client.sgp_client_id, client]));
    const clientByDocument = new Map(clients.filter((client) => client.document).map((client) => [client.document, client]));

    return subscribers.map((subscriber) => {
      const row = subscriber.contract
        ? byContract.get(String(subscriber.contract)) ?? {
          contract: subscriber.contract, client_name: subscriber.clientName, document: subscriber.document
        }
        : byId.get(Number(subscriber.contactId)) ?? {};
      const clientKey = row.client_ref || (!row.contract ? row.sgp_client_id : null);
      const client = (clientKey && clientByKey.get(clientKey))
        || (row.document && clientByDocument.get(row.document))
        || null;
      const address = shownValue('address', client, row) ?? {};
      const link = subscriber.contract ? linkByContract.get(String(subscriber.contract)) : null;
      return {
        key: subscriber.contract ? String(subscriber.contract) : `c:${subscriber.contactId}`,
        contract: subscriber.contract ?? '',
        name: shownValue('name', client, row) ?? subscriber.clientName ?? '',
        personType: shownValue('personType', client, row) ?? '',
        document: shownValue('document', client, row) ?? '',
        birthDate: shownValue('birthDate', client, row) ?? '',
        gender: shownValue('gender', client, row) ?? '',
        ...Object.fromEntries(ADDRESS_PARTS.map((part) => [
          part, part === 'street' && !address.street && address.line ? address.line : (address[part] ?? '')
        ])),
        whatsappPhone: subscriber.phone ?? '',
        phones: (shownValue('phones', client, row) ?? []).join(LIST_SEPARATOR),
        emails: (shownValue('emails', client, row) ?? []).join(LIST_SEPARATOR),
        plan: row.plan ?? link?.plan ?? '',
        dueDay: row.due_day ?? '',
        status: row.status_label || row.status || subscriber.state || '',
        hasDevice: subscriber.deviceId ? 'sim' : 'não',
        notes: client?.notes ?? ''
      };
    });
  }

  static async exportCsv(filters) {
    const rows = await this.exportRows(filters);
    return { csv: toCsv(rows), count: rows.length };
  }

  /**
   * Reads the sheet and works out what each row would do. Nothing is written:
   * `apply` runs the same plan and then writes it.
   */
  static async plan(text) {
    if (Buffer.byteLength(String(text ?? ''), 'utf8') > IMPORT_MAX_BYTES) {
      throw sheetError('contacts.import.tooLarge', { megabytes: IMPORT_MAX_BYTES / 1024 / 1024 }, 413);
    }
    const [header, ...lines] = parseCsv(text);
    if (!header || lines.length === 0) throw sheetError('contacts.import.empty');
    if (lines.length > IMPORT_MAX_ROWS) throw sheetError('contacts.import.tooManyRows', { rows: IMPORT_MAX_ROWS });
    const columns = header.map((name) => HEADER_INDEX.get(normalizeHeader(name)) ?? null);
    const known = new Set(columns.filter(Boolean).map((column) => column.field));
    if (!known.has('key') && !known.has('contract') && !known.has('document') && !known.has('name')) {
      throw sheetError('contacts.import.badHeader');
    }

    const plan = { total: lines.length, updates: [], creates: [], unchanged: 0, errors: [] };
    for (let index = 0; index < lines.length; index += 1) {
      const line = index + 2; // the header is line 1, as the spreadsheet numbers it
      const cells = {};
      columns.forEach((column, position) => {
        if (column) cells[column.field] = unescapeCell(lines[index][position]);
      });
      try {
        // eslint-disable-next-line no-await-in-loop -- one row at a time: each looks up its own record
        const step = await this.planRow(cells);
        if (step.kind === 'create') plan.creates.push({ line, ...step });
        else if (step.changed.length > 0) plan.updates.push({ line, ...step });
        else plan.unchanged += 1;
      } catch (error) {
        if (!(error instanceof ContactProfileError)) throw error;
        plan.errors.push({ line, key: error.translationKey, vars: error.translationVars });
      }
    }
    return plan;
  }

  /** What one row would do: update which fields of which record, or create one. */
  static async planRow(cells) {
    const row = await this.findRow(cells);
    const patch = this.patchFrom(cells);

    if (!row) {
      if (cells.key || cells.contract) throw sheetError('contacts.import.rowNotFound');
      if (!patch.name) throw sheetError('contacts.import.rowNoName');
      return { kind: 'create', name: patch.name, patch, changed: Object.keys(patch) };
    }

    const key = row.contract ? String(row.contract) : `c:${row.id}`;
    const profile = await ContactProfileService.get(key);
    const changed = Object.keys(patch).filter((field) => {
      if (field === 'notes') return (patch.notes ?? null) !== (profile.notes ?? null);
      if (field === 'whatsappPhone') return patch.whatsappPhone !== profile.whatsappPhone;
      return comparable(field, patch[field]) !== comparable(field, profile.fields[field]?.value);
    });
    return {
      kind: 'update',
      key,
      name: profile.fields.name.value,
      patch: Object.fromEntries(changed.map((field) => [field, patch[field]])),
      changed
    };
  }

  /** The record a row names: by its key, its contract, or — lacking both — its CPF/CNPJ. */
  static async findRow(cells) {
    if (cells.key) return ContactProfileService.rowFor(cells.key);
    if (cells.contract) return ContactProfileService.rowFor(cells.contract);
    const digits = String(cells.document ?? '').replace(/\D/g, '');
    if (!digits) return null;
    const client = await SgpClient.getByDocument(digits);
    if (client) {
      const [row] = await tdb('sgp_contacts')
        .where((query) => query.where({ client_ref: client.sgp_client_id })
          .orWhere((inner) => inner.whereNull('contract').where({ sgp_client_id: client.sgp_client_id })))
        .orderBy('id')
        .limit(1);
      if (row) return row;
    }
    return (await tdb('sgp_contacts').where({ document: digits }).orderBy('id').first()) || null;
  }

  /** The edit a row carries, checked like a PATCH. Empty cells are left out. */
  static patchFrom(cells) {
    const patch = {};
    for (const column of COLUMNS) {
      if (!column.editable) continue;
      const value = cells[column.field];
      if (value === undefined || value === '') continue;
      if (column.field === 'notes') {
        patch.notes = value.slice(0, 5000);
      } else if (column.field === 'whatsappPhone') {
        const phone = normalizarTelefoneBr(value);
        if (!phone) throw sheetError('contacts.error.invalidField', { field: 'whatsappPhone' });
        patch.whatsappPhone = phone;
      } else {
        patch[column.field] = checkField(column.field, column.list ? splitList(value) : value);
      }
    }
    const parts = ADDRESS_PARTS.filter((part) => cells[part]);
    if (parts.length > 0) {
      patch.address = checkField('address', Object.fromEntries(parts.map((part) => [part, cells[part]])));
    }
    return patch;
  }

  /** Writes a plan: every update as an edit of the record, every new client as one typed in the panel. */
  static async apply(text, actor) {
    const plan = await this.plan(text);
    let updated = 0;
    let created = 0;
    for (const step of plan.updates) {
      // eslint-disable-next-line no-await-in-loop -- each edit reads and writes its own record
      await ContactProfileService.update(step.key, step.patch, actor);
      updated += 1;
    }
    for (const step of plan.creates) {
      // eslint-disable-next-line no-await-in-loop -- same
      await ContactProfileService.create(step.patch, actor, { importSource: 'sheet' });
      created += 1;
    }
    return { ...this.summary(plan), updated, created };
  }

  /** The plan as the screen shows it: counts, errors, and the first changed rows. */
  static summary(plan) {
    return {
      total: plan.total,
      updates: plan.updates.length,
      creates: plan.creates.length,
      unchanged: plan.unchanged,
      errors: plan.errors,
      rows: [...plan.updates, ...plan.creates]
        .sort((left, right) => left.line - right.line)
        .slice(0, PREVIEW_ROWS)
        .map((step) => ({ line: step.line, kind: step.kind, key: step.key ?? null, name: step.name ?? null, fields: step.changed }))
    };
  }
}

export default ContactSheetService;
