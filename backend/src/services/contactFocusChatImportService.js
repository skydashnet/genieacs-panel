import FocusChatService from './focusChatService.js';
import ContactProfileService from './contactProfileService.js';
import ContactWhatsappImportService from './contactWhatsappImportService.js';
import { normalizarTelefoneBr, variantesTelefoneBr } from '../utils/wa/waDestino.js';

/** The most new clients one import creates. */
const MAX_CREATES = 10000;
/** How many new contacts the preview lists one by one; the counts cover all of them. */
const PREVIEW_ROWS = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Brings the Focus Chat contact book into the Contacts screen — the same rule
 * as the WhatsApp and Google imports: only people the panel does not know yet
 * become clients (a number already on any contact is skipped, in either
 * spelling of the ninth digit), nothing existing is edited, and nothing is
 * written before `apply`. Groups and contacts from channels without a phone
 * (Facebook, Instagram…) are counted and left out.
 */
export default class ContactFocusChatImportService {
  static async plan() {
    const contacts = await FocusChatService.listContacts();
    const known = await ContactWhatsappImportService.knownNumbers();
    const seen = new Set();
    const plan = { total: contacts.length, creates: [], existing: 0, invalid: 0, duplicated: 0, ignored: 0, truncated: false };

    for (const contact of contacts) {
      if (contact.isGroup || contact.type !== 0) {
        plan.ignored += 1;
        continue;
      }
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
      plan.creates.push({
        phone,
        // A contact saved without a name is filed under its number.
        name: contact.name || phone,
        email: contact.email && EMAIL.test(contact.email) ? contact.email : null,
        notes: notesOf(contact)
      });
    }
    return plan;
  }

  static async apply(actor) {
    const plan = await this.plan();
    let created = 0;
    for (const step of plan.creates) {
      // eslint-disable-next-line no-await-in-loop -- each client is written with its own list row
      await ContactProfileService.create({
        name: step.name,
        whatsappPhone: step.phone,
        ...(step.email ? { emails: [step.email] } : {}),
        ...(step.notes ? { notes: step.notes } : {})
      }, actor, { importSource: 'focuschat' });
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
      ignored: plan.ignored,
      truncated: plan.truncated,
      maxCreates: MAX_CREATES,
      rows: plan.creates.slice(0, PREVIEW_ROWS).map((step) => ({ name: step.name, phone: step.phone }))
    };
  }
}

/** The Focus Chat observation, and its tags as a line of their own. */
function notesOf(contact) {
  const parts = [];
  if (contact.observation) parts.push(contact.observation);
  if (contact.tags.length) parts.push(`Etiquetas do Focus Chat: ${contact.tags.join(', ')}`);
  const notes = parts.join('\n').trim();
  return notes ? notes.slice(0, 2000) : null;
}
