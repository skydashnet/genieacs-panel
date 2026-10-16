import { randomBytes } from 'node:crypto';
import { tdb, tinsert } from '../config/database.js';

/** The columns that hold JSON as text — see `sgpClientsTable` in `config/migrations.js`. */
const JSON_COLUMNS = ['address', 'phones', 'emails', 'overrides', 'teiah'];

function readJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * The record of one SGP client — one row per client, where `sgp_contacts` has
 * one per contract. What the SGP sends lives in the plain columns and is
 * rewritten by every sync; what an operator typed lives in `overrides` and
 * `notes`, which no sync touches.
 */
class SgpClient {
  static parse(row) {
    if (!row) return null;
    const parsed = { ...row };
    parsed.address = readJson(row.address, null);
    parsed.phones = readJson(row.phones, []);
    parsed.emails = readJson(row.emails, []);
    parsed.overrides = readJson(row.overrides, {});
    parsed.teiah = readJson(row.teiah, null);
    return parsed;
  }

  static async getById(id) {
    const numeric = Number.parseInt(String(id ?? ''), 10);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    return this.parse(await tdb('sgp_clients').where({ id: numeric }).first());
  }

  static async getBySgpId(clientId) {
    if (!clientId) return null;
    return this.parse(await tdb('sgp_clients').where({ sgp_client_id: String(clientId) }).first());
  }

  static async getByDocument(document) {
    const digits = String(document ?? '').replace(/\D/g, '');
    if (!digits) return null;
    return this.parse(await tdb('sgp_clients').where({ document: digits }).orderBy('id').first());
  }

  /**
   * The key a listing entry is filed under: the SGP's own client id, or its
   * document when the install sends none.
   */
  static keyFor(profile) {
    if (profile?.clientId) return String(profile.clientId).slice(0, 64);
    if (profile?.document) return `doc:${profile.document}`.slice(0, 64);
    return null;
  }

  /**
   * Writes what the SGP just sent for one client. `overrides`, `notes` and
   * `source` are left alone: an operator's edit outlives every sync.
   */
  static async upsertFromSgp(profile, { seenAt = null } = {}) {
    const key = this.keyFor(profile);
    if (!key) return null;
    const now = new Date();
    const values = {
      sgp_client_id: key,
      document: profile.document ? String(profile.document).slice(0, 32) : null,
      person_type: profile.personType ? String(profile.personType).slice(0, 16) : null,
      name: profile.name ? String(profile.name).slice(0, 255) : null,
      gender: profile.gender ? String(profile.gender).slice(0, 16) : null,
      birth_date: profile.birthDate ? String(profile.birthDate).slice(0, 32) : null,
      registered_at: profile.registeredAt ? String(profile.registeredAt).slice(0, 32) : null,
      address: writeJson(profile.address ?? null),
      phones: writeJson(profile.phones ?? []),
      emails: writeJson(profile.emails ?? []),
      updated_at: now,
      ...(seenAt ? { last_seen_at: seenAt } : {})
    };
    await tinsert('sgp_clients', { ...values, source: 'sgp' })
      .onConflict(['tenant_id', 'sgp_client_id'])
      .merge(values);
    return this.getBySgpId(key);
  }

  /** A client with no SGP behind it, typed in the panel (or imported). */
  static async createFromPanel(fields) {
    const key = `panel:${randomBytes(8).toString('hex')}`;
    const now = new Date();
    await tinsert('sgp_clients', {
      sgp_client_id: key,
      source: 'panel',
      overrides: writeJson(fields.overrides ?? {}),
      notes: fields.notes ?? null,
      created_at: now,
      updated_at: now
    });
    return this.getBySgpId(key);
  }

  static async update(id, { overrides, notes } = {}) {
    const patch = { updated_at: new Date() };
    if (overrides !== undefined) patch.overrides = writeJson(overrides);
    if (notes !== undefined) patch.notes = notes;
    await tdb('sgp_clients').where({ id }).update(patch);
    return this.getById(id);
  }

  /** The TeiaH's answer about this client, as the last consultation left it. */
  static async setTeiah(id, teiah) {
    await tdb('sgp_clients').where({ id }).update({ teiah: writeJson(teiah), updated_at: new Date() });
    return this.getById(id);
  }

  static JSON_COLUMNS = JSON_COLUMNS;
}

export default SgpClient;
