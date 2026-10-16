import SgpClient from '../models/SgpClient.js';
import SgpContact from '../models/SgpContact.js';
import { tdb } from '../config/database.js';
import TeiahService, { TeiahError } from './teiahService.js';
import ContactProfileService, { ContactProfileError, shownValue, whatsappPhoneOf } from './contactProfileService.js';
import WaContactService, { contactKey } from './waContactService.js';
import { personTypeOf } from './contactOnboardingService.js';

/** One scan reads this many clients: each is a paid call to the TeiaH. */
export const SCAN_LIMIT = 30;
/** A client the TeiaH answered about is not asked again for this long. */
const RECONSULT_DAYS = 30;
const SCAN_CONCURRENCY = 3;
/** The most clients one "apply" writes. */
export const APPLY_LIMIT = 200;
const PENDING_LIMIT = 500;

const MOBILE = /^55\d{2}9\d{8}$/;

function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** The consultation as the record keeps it: what the TeiaH said, with the day it said it. */
function snapshotOf(found, consultedAt) {
  return {
    consultedAt: consultedAt ?? new Date().toISOString(),
    found: found.found === true,
    score: found.score ?? null,
    motherName: found.motherName ?? null,
    deceased: found.deceased === true,
    addresses: found.addresses ?? (found.address ? [found.address] : []),
    phones: found.phones ?? [],
    emails: found.emails ?? []
  };
}

function recent(snapshot) {
  const at = Date.parse(snapshot?.consultedAt ?? '');
  return Number.isFinite(at) && Date.now() - at < RECONSULT_DAYS * 86_400_000;
}

/** Runs `task` over `items`, `size` at a time, keeping the order of the results. */
async function pool(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker takes the next item only when its last is done
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/**
 * What the TeiaH knows about a client already in the panel: asked by CPF/CNPJ,
 * kept on the client's record (`sgp_clients.teiah`) as a snapshot, and only
 * then — by an operator's decision — merged into the record.
 *
 * Keeping the snapshot is what makes "preview, then apply" cheap and honest:
 * applying reads what was already paid for and shown, never asks again, and
 * never takes numbers from the browser.
 */
class ContactTeiahService {
  /** The TeiaH of one client: the CPF/CNPJ the record shows, and the record it lands on. */
  static async consult(key, { fresh = false } = {}) {
    const row = await ContactProfileService.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const existing = await ContactProfileService.clientFor(row);
    const document = digitsOf(shownValue('document', existing, row));
    if (!personTypeOf(document)) {
      throw new ContactProfileError('contacts.error.invalidDocument', { code: 'invalid_document' });
    }
    TeiahService.requireReady(await TeiahService.getConfig());
    // The panel's memory first: a consultation younger than 30 days is not paid
    // for twice, whoever made it (this record, "Novo cliente" or the bulk run).
    const consulted = await TeiahService.consultCached(document, { fresh });
    const client = await ContactProfileService.ensureClient(row);
    const teiah = snapshotOf(consulted.result, consulted.consultedAt);
    await SgpClient.setTeiah(client.id, teiah);
    return { teiah, cached: consulted.cached };
  }

  /**
   * Merges the snapshot's phones and e-mails into the record, the way an
   * operator's edit does (restorable, nothing removed), and gives the contracts
   * that have no WhatsApp number the first mobile.
   */
  static async apply(key, actor) {
    const row = await ContactProfileService.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const client = await ContactProfileService.clientFor(row);
    const teiah = client?.teiah;
    if (!teiah) throw new ContactProfileError('contacts.error.teiahNotConsulted', { code: 'teiah_not_consulted', status: 409 });

    const phones = shownValue('phones', client, row) ?? [];
    const emails = shownValue('emails', client, row) ?? [];
    const newPhones = [...new Set(teiah.phones ?? [])].filter((phone) => !phones.includes(phone));
    const newEmails = [...new Set(teiah.emails ?? [])].filter((email) => !emails.includes(email));

    const body = {};
    if (newPhones.length) body.phones = [...phones, ...newPhones];
    if (newEmails.length) body.emails = [...emails, ...newEmails];

    // The number WhatsApp reaches: a mobile when the TeiaH has one.
    const best = (teiah.phones ?? []).find((phone) => MOBILE.test(phone)) ?? (teiah.phones ?? [])[0] ?? null;
    let whatsappSet = 0;
    if (best) {
      if (!(await ContactProfileService.get(key))?.whatsappPhone) {
        body.whatsappPhone = best;
        whatsappSet += 1;
      }
      // The client's other contracts, when they have no number either.
      const others = await SgpContact.getByClient(client.sgp_client_id);
      for (const other of others) {
        if (!other.contract || other.id === row.id) continue;
        if (whatsappPhoneOf(null, other).phone) continue;
        // eslint-disable-next-line no-await-in-loop -- a handful of contracts per client
        await SgpContact.setManualPhoneById(other.id, best);
        whatsappSet += 1;
      }
    }

    if (Object.keys(body).length > 0) {
      await ContactProfileService.update(key, body, actor ? `${actor} · TeiaH` : 'TeiaH');
    }
    return { phonesAdded: newPhones.length, emailsAdded: newEmails.length, whatsappSet };
  }

  /** Active clients with no phone, each with the key the list gives it and its document. */
  static async withoutPhone() {
    const subscribers = await WaContactService.collect({ state: 'active', noPhone: true });
    return subscribers
      .map((subscriber) => ({
        key: contactKey(subscriber),
        name: subscriber.clientName,
        document: digitsOf(subscriber.document)
      }))
      .filter((entry) => personTypeOf(entry.document));
  }

  /** The snapshots the panel holds, by document. */
  static async snapshotsByDocument(documents) {
    const wanted = [...new Set(documents)];
    const map = new Map();
    if (wanted.length === 0) return map;
    for (let at = 0; at < wanted.length; at += 500) {
      // eslint-disable-next-line no-await-in-loop -- pages of an IN list
      const rows = await tdb('sgp_clients').whereIn('document', wanted.slice(at, at + 500)).whereNotNull('teiah').select('document', 'teiah');
      for (const row of rows) map.set(row.document, SgpClient.parse(row).teiah);
    }
    return map;
  }

  /**
   * Asks the TeiaH about the next clients with no phone — at most `SCAN_LIMIT`
   * a call — and files each answer on its record. Nothing is merged: that is
   * `applyMany`, after the operator saw `pending`.
   */
  static async scan() {
    const candidates = await this.withoutPhone();
    const snapshots = await this.snapshotsByDocument(candidates.map((entry) => entry.document));
    const todo = candidates.filter((entry) => !recent(snapshots.get(entry.document)));
    const batch = todo.slice(0, SCAN_LIMIT);
    if (batch.length > 0) TeiahService.requireReady(await TeiahService.getConfig());

    let failed = 0;
    let fromCache = 0;
    await pool(batch, SCAN_CONCURRENCY, async (entry) => {
      try {
        const done = await this.consult(entry.key);
        if (done.cached) fromCache += 1;
      } catch (error) {
        // A refused key or an integration turned off ends the run for everyone;
        // one client the TeiaH could not answer is only counted.
        if (error instanceof TeiahError && ['unauthorized', 'credentials_rejected', 'not_configured'].includes(error.code)) throw error;
        failed += 1;
      }
    });
    return {
      eligible: candidates.length,
      processed: batch.length,
      failed,
      // Answered from what the panel already held: no call to the TeiaH, no credits.
      fromCache,
      remaining: todo.length - batch.length
    };
  }

  /** The clients with no phone for whom the TeiaH has one, to show before applying. */
  static async pending() {
    const candidates = await this.withoutPhone();
    const snapshots = await this.snapshotsByDocument(candidates.map((entry) => entry.document));
    const rows = [];
    for (const entry of candidates) {
      const teiah = snapshots.get(entry.document);
      if (!teiah?.phones?.length) continue;
      rows.push({ key: entry.key, name: entry.name, phones: teiah.phones, emails: teiah.emails ?? [], consultedAt: teiah.consultedAt ?? null });
      if (rows.length >= PENDING_LIMIT) break;
    }
    return rows;
  }

  /** Applies the snapshots of the clients the operator ticked. */
  static async applyMany(keys, actor) {
    const list = [...new Set((Array.isArray(keys) ? keys : []).map(String))].slice(0, APPLY_LIMIT);
    const total = { clients: 0, phonesAdded: 0, emailsAdded: 0, whatsappSet: 0, skipped: 0 };
    for (const key of list) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each client is written with its own record
        const done = await this.apply(key, actor);
        total.clients += 1;
        total.phonesAdded += done.phonesAdded;
        total.emailsAdded += done.emailsAdded;
        total.whatsappSet += done.whatsappSet;
      } catch (error) {
        if (!(error instanceof ContactProfileError)) throw error;
        total.skipped += 1;
      }
    }
    return total;
  }
}

export default ContactTeiahService;
