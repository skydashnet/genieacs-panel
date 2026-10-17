import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import SgpService from './sgpService.js';
import WaContactService from './waContactService.js';
import WaSendService from './waSendService.js';
import { translateError } from '../i18n/index.js';

/** Longer than any invoice text, short enough that a pasted book is refused. */
export const INVOICE_MESSAGE_MAX = 4000;

function notFound() {
  return new ContactProfileError('contacts.error.invoiceNotFound', { code: 'invoice_not_found', status: 404 });
}

function brl(amount) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return null;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(amount));
}

/** `2026-10-15` → `15/10/2026`; anything else as the SGP sent it. */
function brDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : (value || null);
}

/**
 * One open invoice of a client record, sent to the client over WhatsApp.
 *
 * The digitable line, the PIX code and the link are read from the SGP again on
 * every call, never taken from the browser: what reaches the customer is what
 * the SGP says they owe. The text itself is the operator's — the preview is a
 * suggestion they may edit before sending.
 */
class ContactInvoiceService {
  /** The invoice, looked up among the open invoices of the record's own contracts. */
  static async find(key, invoiceId) {
    const wanted = String(invoiceId ?? '').trim();
    if (!wanted) throw notFound();
    const profile = await ContactProfileService.get(key);
    if (!profile) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    for (const contract of profile.contracts) {
      // eslint-disable-next-line no-await-in-loop -- few contracts per client, and the SGP answers one at a time
      const { invoices } = await SgpService.listInvoices({ contract: contract.contract, onlyOpen: true });
      const invoice = invoices.find((entry) => entry.id !== null && String(entry.id) === wanted);
      if (invoice) return { profile, contract: contract.contract, invoice };
    }
    throw notFound();
  }

  /** The suggested text, one line per field the SGP sent and none for what it did not. */
  static compose(t, { profile, contract, invoice }) {
    const name = profile.fields?.name?.value || '';
    // SGP names are often all capitals; "JOAO" reads as shouting in a greeting.
    const first = String(name).trim().split(/\s+/)[0] || '';
    const firstName = first ? first.charAt(0).toLocaleUpperCase('pt-BR') + first.slice(1).toLocaleLowerCase('pt-BR') : '';
    const lines = [
      firstName ? t('contacts.invoiceMessage.greeting', { name: firstName }) : t('contacts.invoiceMessage.greetingNoName'),
      t('contacts.invoiceMessage.intro', {
        amount: brl(invoice.amount) ?? '—',
        date: brDate(invoice.dueDate) ?? '—',
        contract
      })
    ];
    if (invoice.digitableLine) lines.push('', t('contacts.invoiceMessage.line'), invoice.digitableLine);
    if (invoice.pix) lines.push('', t('contacts.invoiceMessage.pix'), invoice.pix);
    if (invoice.link) lines.push('', `${t('contacts.invoiceMessage.link')} ${invoice.link}`);
    return lines.join('\n');
  }

  static async preview(key, invoiceId, t) {
    const found = await this.find(key, invoiceId);
    return {
      contract: found.contract,
      invoiceId: String(found.invoice.id),
      phone: found.profile.whatsappPhone,
      text: this.compose(t, found)
    };
  }

  /**
   * Into the thread with this client — the one that exists, or a new one — and
   * out through the same queue as any reply: opt-out, account and all.
   */
  static async send(key, invoiceId, { text } = {}, userId = null) {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body || body.length > INVOICE_MESSAGE_MAX) {
      throw new ContactProfileError('contacts.error.invalidField', { code: 'invalid_field', vars: { field: 'text' } });
    }
    const found = await this.find(key, invoiceId);
    const { conversation } = await WaContactService.openConversation(String(key));
    const message = await WaSendService.enqueue({
      conversationId: conversation.id,
      body,
      userId,
      source: 'operator'
    });
    return {
      contract: found.contract,
      invoiceId: String(found.invoice.id),
      conversationId: conversation.id,
      messageId: message.id,
      // Decorated as the inbox lists it, so the page can hand the thread over.
      conversation
    };
  }

  /**
   * The invoice settled on the SGP ("Receber"): found again among the open
   * invoices of this record — a paid one is gone from there, which is what
   * keeps a double click from settling twice — and, when asked, a receipt to
   * the client over WhatsApp. A receipt that cannot go out does not undo the
   * settlement; it comes back as `receipt.error`.
   */
  static async settle(key, invoiceId, { amount, paidAt, method, receipt } = {}, { userId = null, t = (k) => k, canSendReceipt = false } = {}) {
    // Whose record first: someone else's key is "not found", never a hint
    // about how this provider's settlement is set up.
    if (!await ContactProfileService.get(key)) {
      throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    }
    const config = await SgpService.getConfig();
    if (!SgpService.canSettle(config)) {
      throw new ContactProfileError('sgp.error.settleNotConfigured', { code: 'settle_not_configured', status: 409 });
    }
    const value = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) throw invalid('amount');
    const date = String(paidAt ?? '').trim() || today();
    if (!validPastDate(date)) throw invalid('paidAt');
    const chosen = String(method ?? '').trim();
    if (!config.settlePaymentMethods.includes(chosen)) throw invalid('method');

    const found = await this.find(key, invoiceId);
    if (!found.invoice.sgpId) {
      throw new ContactProfileError('sgp.error.invoiceIdMissing', { code: 'invoice_id_missing', status: 409 });
    }
    const { message } = await SgpService.settleInvoice({ sgpId: found.invoice.sgpId, paidAt: date, amount: value, method: chosen });

    const result = {
      contract: found.contract,
      invoiceId: String(found.invoice.id),
      sgpId: found.invoice.sgpId,
      amount: value,
      paidAt: date,
      method: chosen,
      message,
      receipt: null
    };
    if (receipt && canSendReceipt) {
      try {
        const { conversation } = await WaContactService.openConversation(String(key));
        const sent = await WaSendService.enqueue({
          conversationId: conversation.id,
          body: this.receiptText(t, { ...found, amount: value, paidAt: date, method: chosen }),
          userId,
          source: 'operator'
        });
        result.receipt = { sent: true, conversationId: conversation.id, messageId: sent.id, error: null };
      } catch (error) {
        result.receipt = { sent: false, error: translateError(t, error) };
      }
    }
    return result;
  }

  static receiptText(t, { profile, contract, invoice, amount, paidAt, method }) {
    const name = profile.fields?.name?.value || '';
    const first = String(name).trim().split(/\s+/)[0] || '';
    const firstName = first ? first.charAt(0).toLocaleUpperCase('pt-BR') + first.slice(1).toLocaleLowerCase('pt-BR') : '';
    return [
      firstName ? t('contacts.invoiceMessage.greeting', { name: firstName }) : t('contacts.invoiceMessage.greetingNoName'),
      t('contacts.settleReceipt.text', {
        amount: brl(amount) ?? '—',
        due: brDate(invoice.dueDate) ?? '—',
        contract,
        date: brDate(paidAt),
        method
      })
    ].join('\n');
  }
}

function invalid(field) {
  return new ContactProfileError('contacts.error.invalidField', { code: 'invalid_field', status: 400, vars: { field } });
}

/** Today in Brazil, where the SGP keeps its books. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** `AAAA-MM-DD`, a real day, and not after today. */
function validPastDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCDate() !== Number(match[3]) || date.getUTCMonth() !== Number(match[2]) - 1) return false;
  return value >= '2000-01-01' && value <= today();
}

export default ContactInvoiceService;
