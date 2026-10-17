import AuditLog from '../models/AuditLog.js';
import ContactProfileService, { ContactProfileError } from '../services/contactProfileService.js';
import ContactSheetService, { IMPORT_MAX_BYTES } from '../services/contactSheetService.js';
import ContactSyncService from '../services/contactSyncService.js';
import ContactServiceStatusService from '../services/contactServiceStatusService.js';
import { roleHas } from '../config/permissions.js';
import ContactGoogleImportService from '../services/contactGoogleImportService.js';
import ContactWhatsappImportService from '../services/contactWhatsappImportService.js';
import ContactFocusChatImportService from '../services/contactFocusChatImportService.js';
import { FocusChatError } from '../services/focusChatService.js';
import ContactInvoiceService from '../services/contactInvoiceService.js';
import ContactOnboardingService from '../services/contactOnboardingService.js';
import ContactTeiahService from '../services/contactTeiahService.js';
import { TeiahError } from '../services/teiahService.js';
import { WaError } from '../services/whatsappConfigService.js';
import { SgpError } from '../services/sgpService.js';
import { translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof ContactProfileError || error instanceof SgpError || error instanceof WaError || error instanceof FocusChatError || error instanceof TeiahError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/** Who edited, as the record keeps it: the operator's name, never a token. */
function actorOf(req) {
  return req.user?.username ?? (req.user?.userId ? `#${req.user.userId}` : null);
}

class ContactController {
  static async get(req, res) {
    try {
      const profile = await ContactProfileService.get(req.params.key);
      if (!profile) {
        return res.status(404).json({ ...createErrorResponse(req.t('contacts.error.notFound'), 'not_found'), code: 'not_found' });
      }
      return res.json(createResponse(req.t('contacts.loaded'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.loadFailed');
    }
  }

  static async invoices(req, res) {
    try {
      return res.json(createResponse(req.t('contacts.loaded'), await ContactProfileService.invoices(req.params.key)));
    } catch (error) {
      return handleError(req, res, error, 'contacts.loadFailed');
    }
  }

  /** What each contract's ONT says about the line now: asked of the ACS, stored nowhere. */
  static async serviceStatus(req, res) {
    try {
      return res.json(createResponse(req.t('contacts.loaded'), await ContactServiceStatusService.forClient(req.params.key)));
    } catch (error) {
      return handleError(req, res, error, 'contacts.loadFailed');
    }
  }

  /** The suggested WhatsApp text for one open invoice; nothing is sent. */
  static async invoiceMessage(req, res) {
    try {
      const data = await ContactInvoiceService.preview(req.params.key, req.params.invoiceId, req.t);
      return res.json(createResponse(req.t('contacts.loaded'), data));
    } catch (error) {
      return handleError(req, res, error, 'contacts.invoiceSendFailed');
    }
  }

  /** "Receber": the invoice settled on the SGP and, when asked, a receipt over WhatsApp. */
  static async settleInvoice(req, res) {
    try {
      const body = req.body ?? {};
      const result = await ContactInvoiceService.settle(
        req.params.key,
        req.params.invoiceId,
        { amount: body.amount, paidAt: body.paidAt, method: body.method, receipt: body.receipt === true },
        { userId: req.user?.userId ?? null, t: req.t, canSendReceipt: roleHas(req.user?.role, 'whatsapp.send') }
      );
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_INVOICE_SETTLED,
        subjectType: 'contact',
        subjectId: String(req.params.key).slice(0, 64),
        detail: {
          contract: result.contract,
          invoiceId: result.invoiceId,
          sgpId: result.sgpId,
          amount: result.amount,
          paidAt: result.paidAt,
          method: result.method,
          receipt: result.receipt ? result.receipt.sent : null
        }
      });
      return res.json(createResponse(req.t('contacts.invoiceSettled'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.invoiceSettleFailed');
    }
  }

  static async sendInvoice(req, res) {
    try {
      const result = await ContactInvoiceService.send(
        req.params.key,
        req.params.invoiceId,
        { text: req.body?.text },
        req.user?.userId ?? null
      );
      // Which invoice went to whom, never the text: it carries the PIX code.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_INVOICE_SENT,
        subjectType: 'contact',
        subjectId: String(req.params.key).slice(0, 64),
        detail: { contract: result.contract, invoiceId: result.invoiceId, conversationId: result.conversationId }
      });
      return res.status(201).json(createResponse(req.t('contacts.invoiceSent'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.invoiceSendFailed');
    }
  }

  /** "Sincronizar": this client asked of the SGP again, and its ONTs summoned. */
  static async sync(req, res) {
    try {
      // The ONT half needs the device page's capability; without it the
      // record still refreshes from the SGP and the answer says the ONTs were
      // left alone.
      const canSummon = roleHas(req.user?.role, 'devices.write');
      const result = await ContactSyncService.syncOne(req.params.key, { t: req.t, canSummon });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_SYNCED,
        subjectType: 'contact',
        subjectId: String(req.params.key).slice(0, 64),
        detail: {
          contracts: result.profile.contracts.map((entry) => entry.contract),
          sgp: result.sgp.error ? 'error' : (result.sgp.skipped ? 'skipped' : 'ok'),
          devices: result.devices ? result.devices.length : null
        }
      });
      return res.json(createResponse(req.t('contacts.synced'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.syncFailed');
    }
  }

  static async update(req, res) {
    try {
      const { profile, changed } = await ContactProfileService.update(req.params.key, req.body, actorOf(req));
      if (changed.length > 0) {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.CONTACT_UPDATED,
          subjectType: 'contact',
          subjectId: String(req.params.key).slice(0, 64),
          detail: { fields: changed }
        });
      }
      return res.json(createResponse(req.t('contacts.updated'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }

  static async create(req, res) {
    try {
      const profile = await ContactProfileService.create(req.body, actorOf(req));
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_CREATED,
        subjectType: 'contact',
        subjectId: profile.key,
        detail: { fields: Object.keys(profile.fields).filter((field) => profile.fields[field].edited) }
      });
      return res.status(201).json(createResponse(req.t('contacts.created'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }

  /** `POST /api/contacts/:key/teiah` — asks the TeiaH about this client and files the answer on the record. */
  static async teiahConsult(req, res) {
    try {
      const result = await ContactTeiahService.consult(req.params.key, { fresh: req.body?.fresh === true });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_TEIAH_LOOKUP,
        subjectType: 'contact',
        subjectId: req.params.key,
        detail: { found: result.teiah.found, origin: 'profile', cached: result.cached }
      });
      return res.json(createResponse(req.t('contacts.lookupDone'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.lookupFailed');
    }
  }

  /** `POST /api/contacts/:key/teiah/apply` — merges what the TeiaH found into the record. */
  static async teiahApply(req, res) {
    try {
      const result = await ContactTeiahService.apply(req.params.key, actorOf(req));
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_TEIAH_APPLIED,
        subjectType: 'contact',
        subjectId: req.params.key,
        detail: { clients: 1, phones: result.phonesAdded, emails: result.emailsAdded, whatsapp: result.whatsappSet }
      });
      return res.json(createResponse(req.t('contacts.updated'), { ...result, profile: await ContactProfileService.get(req.params.key) }));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }

  /** `POST /api/contacts/teiah/phones/scan` — the next clients with no phone, asked of the TeiaH. */
  static async teiahScan(req, res) {
    try {
      const result = await ContactTeiahService.scan();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_TEIAH_LOOKUP,
        subjectType: 'contact',
        subjectId: null,
        detail: { origin: 'bulk', processed: result.processed, failed: result.failed, fromCache: result.fromCache }
      });
      return res.json(createResponse(req.t('contacts.lookupDone'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.lookupFailed');
    }
  }

  /** `GET /api/contacts/teiah/phones` — the clients with no phone that the TeiaH has a phone for. */
  static async teiahPending(req, res) {
    try {
      return res.json(createResponse(req.t('contacts.loaded'), { rows: await ContactTeiahService.pending() }));
    } catch (error) {
      return handleError(req, res, error, 'contacts.loadFailed');
    }
  }

  /** `POST /api/contacts/teiah/phones/apply` — `{ keys }`: merges the ticked clients. */
  static async teiahApplyMany(req, res) {
    try {
      const result = await ContactTeiahService.applyMany(req.body?.keys, actorOf(req));
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_TEIAH_APPLIED,
        subjectType: 'contact',
        subjectId: null,
        detail: { clients: result.clients, phones: result.phonesAdded, emails: result.emailsAdded, whatsapp: result.whatsappSet, skipped: result.skipped }
      });
      return res.json(createResponse(req.t('contacts.updated'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }

  /**
   * `GET /api/contacts/lookup/document?document=` — before the form: is this
   * CPF/CNPJ already a client (in the SGP or typed here), and, for a company
   * nobody has, what the Receita says. Writes only what the SGP lookup files.
   */
  static async lookupDocument(req, res) {
    try {
      const result = await ContactOnboardingService.lookupDocument(req.query?.document, { fresh: req.query?.fresh === '1' });
      if (result.teiahConsulted) {
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.CONTACT_TEIAH_LOOKUP,
          subjectType: 'contact',
          subjectId: null,
          detail: { found: Boolean(result.prefill?.source === 'teiah'), error: result.prefillError, cached: result.teiahCached }
        });
      }
      return res.json(createResponse(req.t('contacts.lookupDone'), result));
    } catch (error) {
      return handleError(req, res, error, 'contacts.lookupFailed');
    }
  }

  /** `GET /api/contacts/lookup/cep?cep=` — the address of a CEP, to fill the form. */
  static async lookupCep(req, res) {
    try {
      const result = await ContactOnboardingService.lookupCep(req.query?.cep);
      if (!result.found) {
        return res.status(404).json({ ...createErrorResponse(req.t('contacts.cepNotFound')), code: 'cep_not_found' });
      }
      return res.json(createResponse(req.t('contacts.lookupDone'), result.data));
    } catch (error) {
      if (error instanceof ContactProfileError) return handleError(req, res, error, 'contacts.lookupFailed');
      return res.status(502).json({ ...createErrorResponse(req.t('contacts.lookupFailed')), code: 'cep_lookup_failed' });
    }
  }

  /** `POST /api/contacts/sgp` — the client created in the SGP, then filed here. */
  static async createInSgp(req, res) {
    try {
      const { profile, clientId } = await ContactOnboardingService.createInSgp(req.body);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.CONTACT_CREATED,
        subjectType: 'contact',
        subjectId: profile.key,
        // Where it was created and the SGP's id — never the values typed.
        detail: { sgp: true, sgpClientId: clientId }
      });
      return res.status(201).json(createResponse(req.t('contacts.createdInSgp'), profile));
    } catch (error) {
      return handleError(req, res, error, 'contacts.saveFailed');
    }
  }
}

/** The day in the file name, so two exports of the same day sort together. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

ContactController.exportSheet = async function exportSheet(req, res) {
  try {
    const filters = {
      search: String(req.query.search ?? ''),
      state: String(req.query.state ?? ''),
      noPhone: req.query.noPhone === 'true',
      imported: req.query.imported === 'true',
      device: String(req.query.device ?? '')
    };
    const { csv, count } = await ContactSheetService.exportCsv(filters);
    await AuditLog.fromRequest(req, {
      action: AuditLog.ACTIONS.CONTACTS_EXPORTED,
      subjectType: 'contacts',
      subjectId: null,
      detail: { count, search: filters.search ? true : false, state: filters.state || null }
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contatos-${today()}.csv"`);
    return res.send(csv);
  } catch (error) {
    return handleError(req, res, error, 'contacts.exportFailed');
  }
};

/**
 * `?mode=preview` reads the sheet and says what it would do; `?mode=apply`
 * does it. The body is the CSV itself, as `text/csv`: a 5 MB sheet does not
 * fit the JSON parser's limit, and does not need to.
 */
async function importGoogle(req, res, text, format) {
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
    return res.status(413).json({
      ...createErrorResponse(req.t('contacts.import.tooLarge', { megabytes: IMPORT_MAX_BYTES / 1024 / 1024 }), 'too_large'),
      code: 'too_large'
    });
  }
  if (req.query.mode !== 'apply') {
    const plan = await ContactGoogleImportService.plan(text, format);
    return res.json(createResponse(req.t('contacts.import.googlePreviewed'), ContactGoogleImportService.summary(plan)));
  }
  const result = await ContactGoogleImportService.apply(text, format, actorOf(req));
  await AuditLog.fromRequest(req, {
    action: AuditLog.ACTIONS.CONTACTS_IMPORTED,
    subjectType: 'contacts',
    subjectId: null,
    detail: { source: 'google', format, total: result.total, created: result.created, existing: result.existing, invalid: result.invalid }
  });
  return res.json(createResponse(req.t('contacts.import.googleApplied', { created: result.created }), result));
}

ContactController.importSheet = async function importSheet(req, res) {
  try {
    const text = typeof req.body === 'string' ? req.body : '';
    // A file exported from Google Contacts (CSV, Outlook CSV or vCard) only
    // brings new people in; the panel's own sheet edits and creates.
    const googleFormat = ContactGoogleImportService.detect(text);
    if (googleFormat) return importGoogle(req, res, text, googleFormat);
    const translate = (plan) => ({
      ...plan,
      errors: plan.errors.map((error) => ({ line: error.line, message: req.t(error.key, error.vars ?? undefined) }))
    });
    if (req.query.mode !== 'apply') {
      const plan = await ContactSheetService.plan(text);
      return res.json(createResponse(req.t('contacts.import.previewed'), translate(ContactSheetService.summary(plan))));
    }
    const result = await ContactSheetService.apply(text, actorOf(req));
    await AuditLog.fromRequest(req, {
      action: AuditLog.ACTIONS.CONTACTS_IMPORTED,
      subjectType: 'contacts',
      subjectId: null,
      detail: { total: result.total, updated: result.updated, created: result.created, errors: result.errors.length }
    });
    return res.json(createResponse(
      req.t('contacts.import.applied', { updated: result.updated, created: result.created }),
      translate(result)
    ));
  } catch (error) {
    return handleError(req, res, error, 'contacts.importFailed');
  }
};

/**
 * The phone book of the connected WhatsApp number. `preview` lists who would
 * become a client; `apply` creates them. Existing contacts are never touched.
 */
ContactController.importWhatsapp = async function importWhatsapp(req, res) {
  try {
    if (req.query.mode !== 'apply') {
      const plan = await ContactWhatsappImportService.plan();
      return res.json(createResponse(req.t('contacts.import.whatsappPreviewed'), ContactWhatsappImportService.summary(plan)));
    }
    const result = await ContactWhatsappImportService.apply(actorOf(req));
    await AuditLog.fromRequest(req, {
      action: AuditLog.ACTIONS.CONTACTS_IMPORTED,
      subjectType: 'contacts',
      subjectId: null,
      detail: { source: 'whatsapp', total: result.total, created: result.created, existing: result.existing }
    });
    return res.json(createResponse(req.t('contacts.import.whatsappApplied', { created: result.created }), result));
  } catch (error) {
    return handleError(req, res, error, 'contacts.importFailed');
  }
};

/**
 * The Focus Chat contact book, same rule as the WhatsApp one: `preview` lists
 * who would become a client; `apply` creates them. Existing contacts are
 * never touched.
 */
ContactController.importFocusChat = async function importFocusChat(req, res) {
  try {
    if (req.query.mode !== 'apply') {
      const plan = await ContactFocusChatImportService.plan();
      return res.json(createResponse(req.t('contacts.import.focusChatPreviewed'), ContactFocusChatImportService.summary(plan)));
    }
    const result = await ContactFocusChatImportService.apply(actorOf(req));
    await AuditLog.fromRequest(req, {
      action: AuditLog.ACTIONS.CONTACTS_IMPORTED,
      subjectType: 'contacts',
      subjectId: null,
      detail: { source: 'focuschat', total: result.total, created: result.created, existing: result.existing }
    });
    return res.json(createResponse(req.t('contacts.import.focusChatApplied', { created: result.created }), result));
  } catch (error) {
    return handleError(req, res, error, 'contacts.importFailed');
  }
};

export default ContactController;
