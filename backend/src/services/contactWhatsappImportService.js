import { tdb } from '../config/database.js';
import EvolutionInstanceService from './evolutionInstanceService.js';
import ContactProfileService from './contactProfileService.js';
import { normalizarTelefoneBr, variantesTelefoneBr } from '../utils/wa/waDestino.js';

/** The most new clients one import creates: a phone book is not an ERP base. */
const MAX_CREATES = 5000;
/** How many new contacts the preview lists one by one; the counts cover all of them. */
const PREVIEW_ROWS = 200;

/**
 * Brings the phone book of the connected WhatsApp number into the Contacts
 * screen.
 *
 * Only people the panel does not know yet become clients: a number already on
 * any contact (SGP, typed by hand, or a link's manual phone) is skipped, in
 * either spelling of the ninth digit. Nothing existing is edited, and nothing
 * is written before `apply`.
 */
export default class ContactWhatsappImportService {
  /** Every number the panel already holds, in every spelling it may be written. */
  static async knownNumbers() {
    const known = new Set();
    const add = (value) => {
      for (const variant of variantesTelefoneBr(value)) known.add(variant);
    };
    for (const table of ['sgp_contacts', 'sgp_links']) {
      // eslint-disable-next-line no-await-in-loop -- two reads, one per table
      const rows = await tdb(table).select('phone_e164', 'phone_manual');
      for (const row of rows) {
        add(row.phone_e164);
        add(row.phone_manual);
      }
    }
    return known;
  }

  /** What the import would do. Writes nothing. */
  static async plan() {
    const contacts = await EvolutionInstanceService.listContacts();
    const known = await this.knownNumbers();
    const seen = new Set();
    const plan = { total: contacts.length, creates: [], existing: 0, invalid: 0, duplicated: 0, truncated: false };

    for (const contact of contacts) {
      const phone = normalizarTelefoneBr(contact.number);
      if (!phone) {
        plan.invalid += 1;
        continue;
      }
      const variants = variantesTelefoneBr(phone);
      if (variants.some((variant) => seen.has(variant))) {
        plan.duplicated += 1;
        continue;
      }
      variants.forEach((variant) => seen.add(variant));
      if (variants.some((variant) => known.has(variant))) {
        plan.existing += 1;
        continue;
      }
      if (plan.creates.length >= MAX_CREATES) {
        plan.truncated = true;
        continue;
      }
      // A contact saved without a name is filed under its number, which the
      // operator can rename later.
      plan.creates.push({ phone, name: contact.name || phone });
    }
    return plan;
  }

  static async apply(actor) {
    const plan = await this.plan();
    let created = 0;
    for (const step of plan.creates) {
      // eslint-disable-next-line no-await-in-loop -- each client is written with its own list row
      await ContactProfileService.create({ name: step.name, whatsappPhone: step.phone }, actor, { importSource: 'whatsapp' });
      created += 1;
    }
    return { ...this.summary(plan), created };
  }

  static summary(plan) {
    return {
      total: plan.total,
      creates: plan.creates.length,
      existing: plan.existing,
      invalid: plan.invalid,
      duplicated: plan.duplicated,
      truncated: plan.truncated,
      maxCreates: MAX_CREATES,
      rows: plan.creates.slice(0, PREVIEW_ROWS).map((step) => ({ name: step.name, phone: step.phone }))
    };
  }
}
