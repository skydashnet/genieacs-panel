import crypto from 'node:crypto';
import AppState from '../models/AppState.js';
import CustomerAccount from '../models/CustomerAccount.js';
import SgpEvent from '../models/SgpEvent.js';
import SgpLink from '../models/SgpLink.js';
import ProvisioningService from './provisioningService.js';
import SgpService, { SgpError } from './sgpService.js';
import WaDunningService from './waDunningService.js';

const RECONCILE_STATE_KEY = 'sgp_reconcile_state';
const MAX_PAYLOAD_CHARS = 64_000;
const MAX_EVENT_ATTEMPTS = 5;

/** Values that must never be persisted with the event body. */
const REDACTED_KEY_PATTERN = /token|senha|password|secret|authorization/i;

function redactPayload(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => redactPayload(entry, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACTED_KEY_PATTERN.test(key) ? '••••' : redactPayload(entry, depth + 1);
  }
  return out;
}

function serializePayload(body) {
  try {
    return JSON.stringify(redactPayload(body)).slice(0, MAX_PAYLOAD_CHARS);
  } catch {
    return null;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

class SgpEventService {
  /**
   * Stores an inbound webhook. The dedupe key prefers an id from the payload
   * and falls back to a hash of the body, so a redelivery is recognised even
   * when SGP sends no identifier.
   *
   * The key is only ever unique WITHIN a provider, and it has to be read that
   * way: an SGP event id is a sequential number in one ISP's ERP, so two ISPs
   * reach #12345 and hash it to the same string. `SgpEvent.insertIfNew` matches
   * per provider over 0024's `(tenant_id, dedupe_key)` unique for that reason.
   * The body-hash fallback collides the same way — two ISPs whose SGP posts the
   * same minimal body would otherwise cancel each other out.
   */
  static async ingestWebhook(rawBody, parsedBody, config) {
    const normalized = SgpService.normalizeEvent(parsedBody, config.eventTypeMap);
    const dedupeKey = normalized.eventId
      ? `webhook:${sha256(normalized.eventId).slice(0, 48)}`
      : `webhook:${sha256(rawBody).slice(0, 48)}`;
    return this.store({ ...normalized, source: 'webhook', dedupeKey, payload: parsedBody });
  }

  static async store({
    source, dedupeKey, type, rawType, contract, document, login, occurredAt, payload, deviceId = null
  }) {
    const { created, event } = await SgpEvent.insertIfNew({
      dedupe_key: dedupeKey.slice(0, 128),
      source,
      type,
      raw_type: rawType ? String(rawType).slice(0, 128) : null,
      contract: contract ? String(contract).slice(0, 64) : null,
      document: document ? String(document).slice(0, 32) : null,
      login: login ? String(login).slice(0, 255) : null,
      device_id: deviceId,
      // An event nothing maps to is stored rather than dropped, so an operator
      // can read the real body and extend the type map from Settings.
      status: type === 'unknown' ? 'ignored' : 'pending',
      payload: serializePayload(payload),
      occurred_at: occurredAt ? new Date(occurredAt) : null,
      received_at: new Date()
    });
    return { created, event };
  }

  /** Every device bound to the event's contract, or to its PPPoE login. */
  static async resolveDevices(event) {
    const byContract = await SgpLink.getByContract(event.contract);
    if (byContract.length > 0) return byContract.map((link) => link.device_id);
    if (event.device_id) return [event.device_id];
    if (event.login) {
      const account = await CustomerAccount.getByPppoeUsername(event.login);
      if (account) return [account.device_id];
    }
    return [];
  }

  /**
   * Acts on one stored event.
   *
   * Every status transition is handled by re-reading the contract from SGP and
   * upserting the link: SGP is the source of truth, so "read it again" is
   * always the correct response and cannot record a state SGP does not agree
   * with. Nothing here writes to a CPE — blocking a subscriber is the
   * network's job, not the panel's.
   */
  static async processEvent(event, { skipRefresh = false } = {}) {
    // Pagou, a régua para: a cobrança que ainda está na fila sai dela, e o
    // agradecimento, se configurado, vai. Antes de resolver aparelhos porque
    // não depende deles — um contrato sem ONT no painel também é cobrado — e
    // sem lançar: `onPayment` engole os próprios erros.
    if (event.type === 'payment_confirmed' && event.contract) {
      await WaDunningService.onPayment(event.contract);
    }

    const deviceIds = await this.resolveDevices(event);
    const details = [];

    if (deviceIds.length === 0) {
      return SgpEvent.update(event.id, {
        status: 'ignored',
        error: 'no_linked_device',
        processed_at: new Date()
      });
    }

    for (const deviceId of deviceIds) {
      if (!skipRefresh) {
        await SgpService.resolveDeviceContract(deviceId, { refresh: true });
        details.push(`refreshed:${deviceId}`);
      }

      if (event.type === 'cancelled') {
        // Unlink last, so the final contract state is recorded before the
        // link that pointed at it goes away and the CPE can be reused.
        const removed = await SgpService.unlinkDevice(deviceId);
        if (removed) details.push(`unlinked:${deviceId}`);
      }

      if (event.type === 'activated') {
        const config = await ProvisioningService.getConfig();
        if (config.enabled) {
          await ProvisioningService.enqueue(deviceId, { trigger: 'event' });
          details.push(`provisioning_queued:${deviceId}`);
        } else {
          details.push(`provisioning_disabled:${deviceId}`);
        }
      }
    }

    return SgpEvent.update(event.id, {
      status: 'processed',
      device_id: deviceIds[0] ?? null,
      error: details.length > 0 ? details.join(' ').slice(0, 500) : null,
      processed_at: new Date()
    });
  }

  static async processPending({ limit = 20 } = {}) {
    const pending = await SgpEvent.getPending(limit);
    let processed = 0;
    for (const event of pending) {
      try {
        await this.processEvent(event);
        processed += 1;
      } catch (error) {
        const attempts = (event.attempts ?? 0) + 1;
        await SgpEvent.update(event.id, {
          // A contract SGP cannot answer for right now is worth retrying; one
          // it keeps refusing is not, or a dead contract would be retried for
          // the life of the install.
          status: attempts >= MAX_EVENT_ATTEMPTS ? 'failed' : 'pending',
          attempts,
          error: (error instanceof SgpError ? error.code : error.message)?.slice(0, 500) ?? null
        });
      }
    }
    return { processed, pending: pending.length };
  }

  static async retry(eventId) {
    const event = await SgpEvent.getById(eventId);
    if (!event) return null;
    await SgpEvent.update(eventId, { status: 'pending', attempts: 0, error: null });
    return this.processEvent(await SgpEvent.getById(eventId));
  }

  // ---------------------------------------------------------- reconciliation

  static async readCursor() {
    const raw = await AppState.get(RECONCILE_STATE_KEY);
    if (!raw) return { cursorId: 0, lastRunAt: null };
    try {
      const parsed = JSON.parse(raw);
      return { cursorId: Number(parsed.cursorId) || 0, lastRunAt: parsed.lastRunAt ?? null };
    } catch {
      return { cursorId: 0, lastRunAt: null };
    }
  }

  static async writeCursor(state) {
    await AppState.upsert(RECONCILE_STATE_KEY, JSON.stringify(state));
  }

  /**
   * Detects what changed between two readings of the same link. `blocked` is
   * the reliable signal; the status text is only consulted for cancellation,
   * which SGP does not express as a flag.
   */
  static detectTransition(before, after) {
    const was = SgpService.linkState(before);
    const now = SgpService.linkState(after);
    // A row that has never been read carries `unknown`, so the first pass after
    // an upgrade is a backfill, not a transition. Reporting it would tell an
    // operator a contract just changed when nothing did.
    if (was !== 'unknown' && was !== now) {
      if (now === 'cancelled') return 'cancelled';
      if (now === 'blocked') return 'blocked';
      if (now === 'active') return was === 'blocked' ? 'unblocked' : 'activated';
    }
    if (was === now && (before.plan ?? null) !== (after.plan ?? null)) return 'contract_changed';
    return null;
  }

  /**
   * Re-reads a page of links straight from SGP. This is the path that works
   * even if this provider's SGP cannot emit a webhook at all, and the safety
   * net for a delivery that went missing. Links are walked round-robin from a
   * stored cursor so none is starved, one at a time — the provider's billing
   * system should not be hit in parallel.
   */
  static async reconcile({ batchSize = null } = {}) {
    const config = await SgpService.getConfig();
    if (!SgpService.isReady(config)) {
      throw new SgpError('sgp.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    const limit = batchSize ?? config.reconcileBatchSize;
    const state = await this.readCursor();

    let links = await SgpLink.listAfterId(state.cursorId, limit);
    if (links.length === 0 && state.cursorId > 0) {
      links = await SgpLink.listAfterId(0, limit);
    }

    const summary = { checked: 0, changed: 0, errors: 0 };
    let cursorId = links.length > 0 ? links[links.length - 1].id : 0;

    for (const before of links) {
      summary.checked += 1;
      try {
        const { link: after } = await SgpService.resolveDeviceContract(before.device_id, {
          refresh: true
        });
        const transition = this.detectTransition(before, after);
        if (!transition) continue;
        summary.changed += 1;
        const { created, event } = await this.store({
          source: 'reconcile',
          // A transition seen twice produces the same key, so a repeated pass
          // never duplicates the event.
          dedupeKey: `reconcile:${after.contract}:${transition}:${sha256(
            `${SgpService.linkState(after)}|${after.status_label ?? ''}|${after.plan ?? ''}`
          ).slice(0, 24)}`,
          type: transition,
          rawType: after.status_label ?? after.status ?? null,
          contract: after.contract,
          document: after.document,
          login: after.login,
          deviceId: after.device_id,
          occurredAt: new Date().toISOString(),
          payload: { source: 'reconcile', before: before.status_label, after: after.status_label }
        });
        // The link was just refreshed, so the handler must not read it again.
        if (created && event) await this.processEvent(event, { skipRefresh: true });
      } catch (error) {
        summary.errors += 1;
        console.warn(`SGP reconciliation failed for ${before.device_id}: ${error.message}`);
      }
    }

    await this.writeCursor({ cursorId, lastRunAt: new Date().toISOString() });
    return summary;
  }

  static async prune() {
    const config = await SgpService.getConfig();
    const cutoff = new Date(Date.now() - config.eventRetentionDays * 86_400_000);
    return SgpEvent.pruneOlderThan(cutoff);
  }
}

export default SgpEventService;
