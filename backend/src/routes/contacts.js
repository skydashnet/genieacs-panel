import express from 'express';
import ContactController from '../controllers/contactController.js';
import { IMPORT_MAX_BYTES } from '../services/contactSheetService.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { sgpAdminLimiter, whatsappSendLimiter, whatsappTestLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * The client record behind the Contacts screen. `:key` is the same key the
 * contacts list hands out — a contract, or `c:<id>` for a client with no
 * contract — and every read goes through `tdb`, so a key from another
 * provider finds nothing.
 */
router.post('/', authenticateToken, requirePermission('contacts.edit'), ContactController.create);
// "Novo cliente": the CPF/CNPJ first (the SGP and, for a company, the Receita),
// the CEP next. Both ask outside services by hand, so they take the SGP
// operator budget. Before `/:key`, like `export`.
router.get(
  '/lookup/document',
  authenticateToken,
  requirePermission('contacts.edit'),
  sgpAdminLimiter,
  ContactController.lookupDocument
);
router.get('/lookup/cep', authenticateToken, requirePermission('contacts.edit'), sgpAdminLimiter, ContactController.lookupCep);
// The TeiaH for clients already in the panel — a paid call that sends a CPF/CNPJ
// out, so the integration's own `act` capability on top of editing. The static
// paths come before `/:key`.
router.get(
  '/teiah/phones',
  authenticateToken,
  requirePermission('contacts.edit'),
  requirePermission('teiah.act'),
  ContactController.teiahPending
);
router.post(
  '/teiah/phones/scan',
  authenticateToken,
  requirePermission('contacts.edit'),
  requirePermission('teiah.act'),
  sgpAdminLimiter,
  ContactController.teiahScan
);
router.post(
  '/teiah/phones/apply',
  authenticateToken,
  requirePermission('contacts.edit'),
  requirePermission('teiah.act'),
  ContactController.teiahApplyMany
);
// Writes to the ERP: the contact permission AND the SGP one.
router.post(
  '/sgp',
  authenticateToken,
  requirePermission('contacts.edit'),
  requirePermission('sgp.act'),
  sgpAdminLimiter,
  ContactController.createInSgp
);
// Before `/:key`, or `export` would be read as a key. The whole base in one
// file — admin and owner only, like `tenant.export`.
router.get('/export', authenticateToken, requirePermission('contacts.export'), ContactController.exportSheet);
router.post(
  '/import',
  authenticateToken,
  requirePermission('contacts.import'),
  // The sheet arrives as text; one byte over the limit is a 413 before any row is read.
  express.text({ type: () => true, limit: IMPORT_MAX_BYTES }),
  ContactController.importSheet
);
// The phone book of the connected WhatsApp number. It asks the Evolution server
// by hand, so it takes the same budget as the other manual WhatsApp reads.
router.post(
  '/import/whatsapp',
  authenticateToken,
  requirePermission('contacts.import'),
  whatsappTestLimiter,
  ContactController.importWhatsapp
);
// The Focus Chat contact book: pages through the vendor's API by hand, so the
// same budget as the other manual imports from an outside service.
router.post(
  '/import/focuschat',
  authenticateToken,
  requirePermission('contacts.import'),
  whatsappTestLimiter,
  ContactController.importFocusChat
);
router.get('/:key', authenticateToken, requirePermission('contacts.read'), ContactController.get);
router.post(
  '/:key/teiah',
  authenticateToken,
  requirePermission('contacts.edit'),
  requirePermission('teiah.act'),
  sgpAdminLimiter,
  ContactController.teiahConsult
);
router.post(
  '/:key/teiah/apply',
  authenticateToken,
  requirePermission('contacts.edit'),
  requirePermission('teiah.act'),
  ContactController.teiahApply
);
// Asks the SGP, once per contract: the same limiter as every other SGP read an
// operator can trigger by hand.
router.get(
  '/:key/invoices',
  authenticateToken,
  requirePermission('contacts.read'),
  sgpAdminLimiter,
  ContactController.invoices
);
// The line's status as the ONTs report it: the ACS is asked, so the same
// capability as looking at an ONT.
router.get(
  '/:key/service-status',
  authenticateToken,
  requirePermission('contacts.read'),
  requirePermission('devices.inspect'),
  ContactController.serviceStatus
);
// One open invoice to the client over WhatsApp: the preview asks the SGP, the
// send asks it again and goes out through the ordinary reply queue.
router.get(
  '/:key/invoices/:invoiceId/whatsapp',
  authenticateToken,
  requirePermission('contacts.read'),
  requirePermission('whatsapp.send'),
  sgpAdminLimiter,
  ContactController.invoiceMessage
);
router.post(
  '/:key/invoices/:invoiceId/whatsapp',
  authenticateToken,
  requirePermission('contacts.read'),
  requirePermission('whatsapp.send'),
  whatsappSendLimiter,
  sgpAdminLimiter,
  ContactController.sendInvoice
);
// "Receber": one open invoice settled on the SGP. Money moves, so its own
// capability; the receipt also needs `whatsapp.send`, checked in the handler.
router.post(
  '/:key/invoices/:invoiceId/settle',
  authenticateToken,
  requirePermission('contacts.read'),
  requirePermission('contacts.settle'),
  sgpAdminLimiter,
  ContactController.settleInvoice
);
// One client refreshed from the SGP, its ONTs asked to report: it writes, and
// it asks the SGP and the ACS, so the editor's capability and the SGP limiter.
router.post('/:key/sync', authenticateToken, requirePermission('contacts.edit'), sgpAdminLimiter, ContactController.sync);
router.patch('/:key', authenticateToken, requirePermission('contacts.edit'), ContactController.update);

export default router;
