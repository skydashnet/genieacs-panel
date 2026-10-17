import SgpService, { SgpError } from './sgpService.js';
import SgpContact from '../models/SgpContact.js';
import SgpClient from '../models/SgpClient.js';
import AppState from '../models/AppState.js';
import { tdb } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';

const STATE_KEY = 'sgp_contacts_sync_last_run';
/** Why the last run failed, if it did; cleared by the next run that finishes. */
const ERROR_KEY = 'sgp_contacts_sync_last_error';

/** A pause between pages, so a sync of thousands of clients does not hammer the SGP. */
const PAGE_PACE_MS = 200;

/**
 * The ceilings that keep a misconfigured listing from running forever.
 *
 * An SGP that ignores the paging parameters answers every request with the
 * same first page; without a stop the sync would read it until the process
 * died. The repeat check catches that on the second page, and the ceilings
 * catch anything subtler. 2 000 pages of 500 is a million rows — no provider
 * this panel serves is close to it.
 */
const MAX_PAGES = 2000;
const MAX_ROWS = 1_000_000;

function readJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The identity of a normalized row, for spotting a page the SGP served twice. */
function rowKey(row) {
  return row ? `${row.contract ?? ''}|${row.clientId ?? ''}|${row.document ?? ''}` : '';
}

/**
 * Every client of the SGP, into `sgp_contacts` — with or without a contract,
 * with or without equipment in the panel.
 *
 * The listing path is `endpoints.customerList`, `/api/ura/clientes/` by
 * default and adjustable per install. Whether it lists everyone without a
 * filter depends on the SGP; a first page that comes back empty is reported as
 * `partial`/`empty` instead of as a sync that found nobody. Nothing runs on a
 * timer until `contactsSyncEnabled` is switched on.
 *
 * Nothing is ever deleted. A client that disappears from the SGP keeps its row
 * with an old `last_seen_at`, which the contacts screen shows; conversations
 * and a manually corrected phone stay attached to it.
 */
class SgpContactSyncService {
  /** Providers with a sync in flight, so a timer tick and a button press never overlap. */
  static running = new Set();

  static async getLastRun() {
    return readJson(await AppState.get(STATE_KEY));
  }

  /**
   * What the settings screen shows: the last finished run, whether one is in
   * flight right now, and why the last attempt failed if it did. The error
   * keeps its translation key, so each reader sees it in their own language.
   */
  static async getStatus() {
    return {
      lastRun: await this.getLastRun(),
      running: this.running.has(currentTenantId()),
      lastError: readJson(await AppState.get(ERROR_KEY))
    };
  }

  /**
   * The button's entry point: checks what can be checked at once, then lets
   * the run go on in the background. A base of thousands of clients — or an
   * SGP that builds all of them into one answer — takes longer than the proxy
   * in front of the panel waits for a response, so the screen asks
   * `getStatus` until it is done instead of holding the request open. The
   * tenant scope travels with the promise.
   */
  static async start() {
    SgpService.requireReady(await SgpService.getConfig());
    if (this.running.has(currentTenantId())) {
      throw new SgpError('sgp.error.contactsSyncRunning', { code: 'contacts_sync_running', status: 409 });
    }
    void this.syncAll().catch((error) => {
      console.warn(`SGP contacts sync failed: ${error.code || error.message}`);
    });
  }

  /**
   * The first page only, written nowhere. What the settings screen's test
   * button shows, so an operator can tell a right path from a wrong one before
   * the sync runs.
   */
  static async test() {
    const config = await SgpService.getConfig();
    const started = Date.now();
    const page = await SgpService.listCustomersPage(0, config);
    return {
      // How long one page takes is what the page size should be chosen by: an
      // SGP that computes each client's invoices answers slower per client.
      durationMs: Date.now() - started,
      pageSize: config.contactsPageSize,
      shape: page.shape,
      received: page.received,
      rows: page.rows.length,
      withContract: page.rows.filter((row) => row.contract).length,
      withPhone: page.rows.filter((row) => row.phone).length,
      fields: page.fields,
      sample: page.rows.slice(0, 3).map((row) => ({
        contract: row.contract ?? null,
        name: row.name ?? null,
        hasPhone: Boolean(row.phone)
      }))
    };
  }

  static async syncAll() {
    const tenantId = currentTenantId();
    if (this.running.has(tenantId)) {
      throw new SgpError('sgp.error.contactsSyncRunning', { code: 'contacts_sync_running', status: 409 });
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

  static async run() {
    const config = SgpService.requireReady(await SgpService.getConfig());
    const startedAt = new Date();
    const summary = { total: 0, created: 0, updated: 0, withoutContract: 0, pages: 0, partial: false };

    let previousFirst = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (page > 0) await sleep(PAGE_PACE_MS);
      let listed;
      try {
        listed = await this.readPage(page, config);
      } catch (error) {
        // What was stored so far stays stored, and is said as such: a run that
        // dies on page 40 has still brought 3 900 clients in.
        if (summary.pages > 0) {
          summary.partial = true;
          summary.reason = 'error';
          await this.saveRun(summary, startedAt);
        }
        throw error;
      }
      const { rows, received, clients = [] } = listed;
      summary.pages += 1;
      if (received === 0) {
        // Nothing at all on the first page: most likely an endpoint that only
        // answers with a filter. Said as such, so an empty run does not read
        // as "the SGP has no clients".
        if (page === 0) {
          summary.partial = true;
          summary.reason = 'empty';
        }
        break;
      }

      // The same first row as the previous page: the SGP is not paging.
      const first = rowKey(rows[0]);
      if (page > 0 && first && first === previousFirst) {
        summary.partial = true;
        summary.reason = 'paging_ignored';
        break;
      }
      previousFirst = first;

      // The record of each client first: who they are, where they live, every
      // phone and e-mail. The contracts below point at it by `client_ref`.
      for (const profile of clients) {
        await SgpClient.upsertFromSgp(profile, { seenAt: startedAt });
      }

      for (const row of rows) {
        const outcome = await this.store(row, startedAt);
        if (!outcome) continue;
        summary.total += 1;
        summary[outcome] += 1;
        if (!row.contract) summary.withoutContract += 1;
      }

      if (received < config.contactsPageSize) break;
      // More than was asked for: the SGP ignored the limit and sent its whole
      // base in one answer. Everything is stored already; asking for the next
      // page would only fetch the same list again.
      if (received > config.contactsPageSize) {
        summary.note = 'all_at_once';
        break;
      }
      if (summary.total >= MAX_ROWS || page === MAX_PAGES - 1) {
        summary.partial = true;
        summary.reason = 'ceiling';
        break;
      }
    }

    return this.saveRun(summary, startedAt);
  }

  static async saveRun(summary, startedAt) {
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

  /** One page, asked twice when the first answer did not come in time: a slow SGP is often slow once. */
  static async readPage(page, config) {
    try {
      return await SgpService.listCustomersPage(page, config);
    } catch (error) {
      if (error?.code !== 'timeout') throw error;
      await sleep(PAGE_PACE_MS * 5);
      return SgpService.listCustomersPage(page, config);
    }
  }

  /** @returns {Promise<'created'|'updated'|null>} */
  static async store(row, seenAt) {
    const record = SgpService.contractToContactRow(row);
    if (!record.contract && !record.sgp_client_id && !record.document) return null;

    const existing = record.contract
      ? await SgpContact.getByContract(record.contract)
      : (record.sgp_client_id ? await SgpContact.getClientRow(record.sgp_client_id) : null);
    const stored = await SgpContact.upsertFromSgp(record, { seenAt });

    // A client that gained a contract: the row it had without one is retired,
    // and what hung on it moves to the contract.
    if (record.contract && row.clientId && stored) await this.retireClientRow(row.clientId, stored);
    // O número do contrato mudou no SGP: a conversa no número antigo deixa de
    // ser a do contrato. Uma falha aqui não derruba a sincronização.
    if (record.contract && existing?.phone_e164 && existing.phone_e164 !== stored?.phone_e164
      && await tdb('wa_conversations').where({ contract: record.contract }).first('id')) {
      try {
        const { default: WaConversationService } = await import('./waConversationService.js');
        await WaConversationService.retireStaleBindings(record.contract, { oldPhones: [existing.phone_e164] });
      } catch (error) {
        console.warn('[sgp-contacts] conversa antiga não solta do contrato:', error?.message || error);
      }
    }
    return existing ? 'updated' : 'created';
  }

  static async retireClientRow(clientId, contractRow) {
    const old = await SgpContact.getClientRow(clientId);
    if (!old) return;
    await tdb('wa_conversations')
      .where({ sgp_contact_id: old.id })
      .update({ sgp_contact_id: null, contract: contractRow.contract, updated_at: new Date() });
    // The operator's correction survives the move, unless the contract already
    // carries one of its own.
    if (old.phone_manual && !contractRow.phone_manual) {
      await SgpContact.setManualPhoneById(contractRow.id, old.phone_manual);
    }
    await tdb('sgp_contacts').where({ id: old.id }).del();
  }
}

export default SgpContactSyncService;
