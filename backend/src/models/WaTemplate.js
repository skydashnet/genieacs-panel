import { getDb, tdb, tinsert, tinsertReturningId } from '../config/database.js';

/**
 * Saved message bodies, with `{{variavel}}` placeholders in them.
 *
 * The model deliberately knows nothing about which variables are legal: that
 * rule belongs to `utils/wa/waCobranca.js`, which is also what fills them in.
 * A template is just a named body here — validation lives in
 * `waTemplateService.js`, one layer up, so the rule and the renderer that
 * enforces it stay in the same conversation.
 */
class WaTemplate {
  static async getById(id) {
    return (await tdb('wa_templates').where({ id }).first()) || null;
  }

  /** Names are unique, so a template can be cited by name from a campaign. */
  static async getByName(name) {
    const clean = String(name ?? '').trim();
    if (!clean) return null;
    return (await tdb('wa_templates').where({ name: clean }).first()) || null;
  }

  static async list({ category = null, includeInactive = false } = {}) {
    const query = tdb('wa_templates');
    if (category) query.where({ category });
    // Inactive templates are hidden by default: the picker on a campaign screen
    // must not offer a body the provider retired.
    if (!includeInactive) query.where({ active: true });
    return query.orderBy('name');
  }

  static async create(template) {
    const now = new Date();
    const id = await tinsertReturningId('wa_templates', {
      ...template,
      created_at: now,
      updated_at: now
    });
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('wa_templates')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async remove(id) {
    return tdb('wa_templates').where({ id }).del();
  }
}

export default WaTemplate;
