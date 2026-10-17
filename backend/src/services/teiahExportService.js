import { createHash } from 'node:crypto';
import AppState from '../models/AppState.js';
import SgpService from './sgpService.js';
import TeiahService, { TeiahError } from './teiahService.js';
import { tdb, tinsert, withDeadlockRetry } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';

const STATE_KEY = 'teiah_export_last_run';
const ERROR_KEY = 'teiah_export_last_error';

/** A pause between invoice lookups, so a run of hundreds does not hammer the SGP. */
const INVOICE_PACE_MS = 200;

/** A ceiling per run: a base with more cancelled contracts than this finishes on the next run. */
const MAX_CONTRACTS_PER_RUN = 5000;

/** Why a contract did not go. Also the i18n suffix under `teiah.reason.*`. */
export const SKIP_REASONS = Object.freeze([
  'missing_address', 'missing_start', 'missing_cancellation', 'no_debt', 'invoices_failed', 'rejected'
]);

const UF_BY_NAME = Object.freeze({
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO'
});
const UFS = new Set(Object.values(UF_BY_NAME));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function readJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clean(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function stripAccents(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** "SP", "sp" or "São Paulo" → "SP"; anything else → null. */
export function toUf(value) {
  const text = stripAccents(value);
  if (!text) return null;
  if (UFS.has(text.toUpperCase())) return text.toUpperCase();
  return UF_BY_NAME[text] ?? null;
}

/** Eight digits as "01310-100", the Swagger's format; anything else → null. */
export function toCep(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : null;
}

/**
 * A date as the API wants it: "MM/AAAA". SGP writes dates as `DD/MM/AAAA`
 * (with or without a time), as ISO, or as an epoch, depending on the field.
 */
export function toMonthYear(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : `${String(value.getUTCMonth() + 1).padStart(2, '0')}/${value.getUTCFullYear()}`;
  }
  const text = String(value).trim();
  const brazilian = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (brazilian) return `${brazilian[2].padStart(2, '0')}/${brazilian[3]}`;
  const monthYear = text.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) return `${monthYear[1].padStart(2, '0')}/${monthYear[2]}`;
  const iso = text.match(/^(\d{4})-(\d{2})(?:-\d{2})?/);
  if (iso) return `${iso[2]}/${iso[1]}`;
  if (/^\d{9,13}$/.test(text)) {
    const epoch = Number(text);
    return toMonthYear(new Date(epoch > 1e11 ? epoch : epoch * 1000));
  }
  return null;
}

function monthIndex(monthYear) {
  const [month, year] = String(monthYear).split('/').map(Number);
  return year * 12 + month;
}

/**
 * The `ImportAddressDto` for one contract, or the reason there is none.
 *
 * @param {object} input
 * @param {object|null} input.address the address in parts (`normalizeAddress` shape)
 * @param {string|null} input.startedAt the contract's start, as the SGP wrote it
 * @param {string|Date|null} input.cancelledAt its cancellation
 * @param {number} input.amount what is still owed
 * @param {boolean|null} [input.rental] whether the equipment stayed with the
 *   customer on rent or loan (`aluguel`); null leaves the field out
 * @returns {{ item: object } | { reason: string }}
 */
export function buildImportItem({ address, startedAt, cancelledAt, amount, rental = null }) {
  const estado = toUf(address?.state);
  const cep = toCep(address?.zip);
  const cidade = clean(address?.city, 128);
  const bairro = clean(address?.district, 128);
  const rua = clean(address?.street, 255);
  const numero = clean(address?.number, 32);
  if (!estado || !cep || !cidade || !bairro || !rua || !numero) return { reason: 'missing_address' };

  const dataInicio = toMonthYear(startedAt);
  if (!dataInicio) return { reason: 'missing_start' };
  const dataCancelamento = toMonthYear(cancelledAt);
  // A cancellation before the start is two wrong dates, not a contract.
  if (!dataCancelamento || monthIndex(dataCancelamento) < monthIndex(dataInicio)) {
    return { reason: 'missing_cancellation' };
  }

  const valor = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(valor) || valor <= 0) return { reason: 'no_debt' };

  const item = {
    estado,
    cidade,
    cep,
    bairro,
    rua,
    numero,
    inadimplente_valor: valor,
    data_inicio: dataInicio,
    data_cancelamento: dataCancelamento
  };
  const complemento = clean(address?.complement, 128);
  if (complemento) item.complemento = complemento;
  const latitude = Number(address?.latitude);
  const longitude = Number(address?.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    item.latitude = latitude;
    item.longitude = longitude;
  }
  if (typeof rental === 'boolean') item.aluguel = rental;
  return { item };
}

/**
 * `aluguel`: whether the equipment stayed with the customer on rent or loan.
 * The SGP's own answer wins; when it says nothing (`null`), the provider's
 * default from Settings — and `omit`, the default's default, leaves it out.
 */
export function rentalFor(contact, config) {
  const stored = contact?.equipment_rented;
  // SQLite and MySQL hand the boolean back as 0/1, Postgres as false/true.
  if (stored !== null && stored !== undefined) return Boolean(Number(stored));
  if (config?.rentalDefault === 'true') return true;
  if (config?.rentalDefault === 'false') return false;
  return null;
}

/** Stable across key order, so the same item always hashes the same. */
export function hashItem(item) {
  const sorted = Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Sends the provider's cancelled-with-debt contracts to TeiaH Valid.
 *
 * The candidates are the `sgp_contacts` rows in state `cancelled`, which the
 * SGP contacts sync keeps current — so this job reads the SGP only for what
 * the listing does not bring: the open invoices of each candidate, through the
 * same lookup (and the same "really open" rule) as the device page.
 *
 * Every candidate ends with one `teiah_exports` row: `sent`, `skipped` with a
 * reason (an address without a CEP, no cancellation date, nothing owed), or
 * `error`. A contract already sent with the same content is not sent again.
 * Nothing leaves the panel but the DTO: address, amount and two months.
 */
class TeiahExportService {
  static running = new Set();

  static INVOICE_PACE_MS = INVOICE_PACE_MS;

  static async getStatus() {
    const counts = await tdb('teiah_exports').select('status').count({ n: '*' }).groupBy('status');
    return {
      lastRun: readJson(await AppState.get(STATE_KEY)),
      running: this.running.has(currentTenantId()),
      lastError: readJson(await AppState.get(ERROR_KEY)),
      totals: Object.fromEntries(counts.map((row) => [row.status, Number(row.n)]))
    };
  }

  /** The latest rows of one status, with the contract's name, for the settings list. */
  static async listItems({ status = null, limit = 100 } = {}) {
    const query = tdb('teiah_exports').orderBy('updated_at', 'desc').orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
    if (status) query.where({ status: String(status) });
    const rows = await query;
    const contacts = rows.length
      ? await tdb('sgp_contacts').whereIn('contract', rows.map((row) => row.contract)).select('contract', 'client_name', 'address')
      : [];
    const byContract = new Map(contacts.map((row) => [row.contract, row]));
    return rows.map((row) => ({
      contract: row.contract,
      clientName: byContract.get(row.contract)?.client_name ?? null,
      address: byContract.get(row.contract)?.address ?? null,
      status: row.status,
      reason: row.reason,
      amount: row.amount === null ? null : Number(row.amount),
      sentAt: row.sent_at,
      updatedAt: row.updated_at
    }));
  }

  static async start() {
    TeiahService.requireReady(await TeiahService.getConfig());
    SgpService.requireReady(await SgpService.getConfig());
    if (this.running.has(currentTenantId())) {
      throw new TeiahError('teiah.error.exportRunning', { code: 'export_running', status: 409 });
    }
    void this.exportAll().catch((error) => {
      console.warn(`TeiaH export failed: ${error.code || error.message}`);
    });
  }

  static async exportAll() {
    const tenantId = currentTenantId();
    if (this.running.has(tenantId)) {
      throw new TeiahError('teiah.error.exportRunning', { code: 'export_running', status: 409 });
    }
    this.running.add(tenantId);
    try {
      const result = await this.run();
      await AppState.upsert(ERROR_KEY, '');
      return result;
    } catch (error) {
      await AppState.upsert(ERROR_KEY, JSON.stringify({
        at: new Date().toISOString(),
        code: error.code || 'error',
        translationKey: error.translationKey || null,
        translationVars: error.translationVars || null,
        message: error.translationKey ? null : String(error.message || '')
      })).catch(() => {});
      throw error;
    } finally {
      this.running.delete(tenantId);
    }
  }

  static async candidates(limit = MAX_CONTRACTS_PER_RUN) {
    return tdb('sgp_contacts')
      .where({ state: 'cancelled' })
      .whereNotNull('contract')
      .orderBy('id')
      .limit(limit);
  }

  /**
   * The address of a contract in parts: its own, else its client's record.
   * A contract whose SGP only ever sent one line of text has none.
   */
  static async addressFor(contact) {
    const own = readJson(contact.address_parts);
    if (own && typeof own === 'object') return own;
    const client = contact.client_ref
      ? await tdb('sgp_clients').where({ sgp_client_id: contact.client_ref }).first()
      : (contact.document ? await tdb('sgp_clients').where({ document: contact.document }).first() : null);
    const fromClient = readJson(client?.address);
    return fromClient && typeof fromClient === 'object' && !fromClient.line ? fromClient : null;
  }

  /** The SGP's own date, else when the panel saw the contract being cancelled. */
  static async cancelledAtFor(contact) {
    if (contact.contract_cancelled_at) return contact.contract_cancelled_at;
    const event = await tdb('sgp_events')
      .where({ contract: contact.contract, type: 'cancelled' })
      .orderBy('id', 'desc')
      .first();
    return event ? (event.occurred_at || event.received_at || null) : null;
  }

  static async openAmount(contract) {
    const { invoices } = await SgpService.listInvoices({ contract, onlyOpen: true, limit: 24 });
    return invoices.reduce((sum, invoice) => sum + (Number(invoice.amount) || 0), 0);
  }

  /**
   * One contract as an item or a reason, reading the SGP only when the
   * address and dates already allow an item: a contract without a CEP costs no
   * invoice lookup.
   */
  static async prepare(contact, config = null) {
    const address = await this.addressFor(contact);
    const cancelledAt = await this.cancelledAtFor(contact);
    // Checked with a placeholder amount first, so a contract that cannot go
    // anyway does not cost the SGP a lookup.
    const dry = buildImportItem({ address, startedAt: contact.contract_created_at, cancelledAt, amount: 1 });
    if (dry.reason) return dry;
    let amount;
    try {
      amount = await this.openAmount(contact.contract);
    } catch (error) {
      if (error?.code === 'unauthorized') throw error;
      return { reason: 'invoices_failed' };
    }
    const rental = rentalFor(contact, config ?? await TeiahService.getConfig());
    return { ...buildImportItem({ address, startedAt: contact.contract_created_at, cancelledAt, amount, rental }), amount };
  }

  static async record(contract, values) {
    const now = new Date();
    const row = { contract, ...values, updated_at: now };
    await withDeadlockRetry(() => tinsert('teiah_exports', { ...row, created_at: now })
      .onConflict(['tenant_id', 'contract'])
      .merge(row));
  }

  /** What would go, for the first few candidates, sent nowhere and recorded nowhere. */
  static async preview({ limit = 5 } = {}) {
    SgpService.requireReady(await SgpService.getConfig());
    const contacts = await this.candidates(Math.min(Math.max(Number(limit) || 5, 1), 20));
    const config = await TeiahService.getConfig();
    const items = [];
    for (const contact of contacts) {
      // eslint-disable-next-line no-await-in-loop -- paced on purpose
      const prepared = await this.prepare(contact, config);
      items.push({
        contract: contact.contract,
        clientName: contact.client_name ?? null,
        item: prepared.item ?? null,
        reason: prepared.reason ?? null
      });
    }
    return { items };
  }

  static async run() {
    const config = TeiahService.requireReady(await TeiahService.getConfig());
    SgpService.requireReady(await SgpService.getConfig());
    const startedAt = new Date();
    const summary = { total: 0, sent: 0, unchanged: 0, skipped: 0, errors: 0, reasons: {} };

    const contacts = await this.candidates();
    const existing = new Map((await tdb('teiah_exports').select('contract', 'status', 'payload_hash'))
      .map((row) => [row.contract, row]));

    let queue = [];
    const flush = async () => {
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      const outcomes = await TeiahService.importMany(batch.map((entry) => entry.item), config);
      for (const [index, entry] of batch.entries()) {
        const outcome = outcomes[index];
        if (outcome?.ok) {
          summary.sent += 1;
          // eslint-disable-next-line no-await-in-loop
          await this.record(entry.contract, {
            status: 'sent', reason: null, payload_hash: entry.hash, amount: entry.amount, sent_at: new Date()
          });
        } else {
          summary.errors += 1;
          summary.reasons.rejected = (summary.reasons.rejected ?? 0) + 1;
          // eslint-disable-next-line no-await-in-loop
          await this.record(entry.contract, {
            status: 'error', reason: 'rejected', payload_hash: null, amount: entry.amount
          });
        }
      }
    };

    for (const [index, contact] of contacts.entries()) {
      summary.total += 1;
      if (index > 0) await sleep(this.INVOICE_PACE_MS);
      const prepared = await this.prepare(contact, config);
      if (prepared.reason) {
        summary.skipped += 1;
        summary.reasons[prepared.reason] = (summary.reasons[prepared.reason] ?? 0) + 1;
        await this.record(contact.contract, {
          status: 'skipped',
          reason: prepared.reason,
          amount: Number.isFinite(prepared.amount) ? prepared.amount : null
        });
        continue;
      }
      const hash = hashItem(prepared.item);
      const before = existing.get(contact.contract);
      if (before?.status === 'sent' && before.payload_hash === hash) {
        summary.unchanged += 1;
        continue;
      }
      queue.push({ contract: contact.contract, item: prepared.item, hash, amount: prepared.amount });
      if (queue.length >= config.batchSize) await flush();
    }
    await flush();

    if (contacts.length >= MAX_CONTRACTS_PER_RUN) summary.partial = true;
    const finishedAt = new Date();
    const result = {
      ...summary,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString()
    };
    await AppState.upsert(STATE_KEY, JSON.stringify(result));
    return result;
  }
}

export default TeiahExportService;
