import WaSubscriberPanelService from '../services/waSubscriberPanelService.js';
import { SgpError } from '../services/sgpService.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof SgpError || error instanceof WaError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/** A part that failed on its own carries a key; the browser gets the sentence. */
function translatePart(req, part) {
  if (!part?.error) return part;
  const { key, ...rest } = part.error;
  return { ...part, error: { ...rest, message: key ? req.t(key) : rest.message } };
}

function present(req, panel) {
  if (!panel.ready) return panel;
  return {
    ...panel,
    contracts: translatePart(req, panel.contracts),
    router: translatePart(req, panel.router),
    invoices: translatePart(req, panel.invoices)
  };
}

/**
 * The SGP side panel of a WhatsApp thread. Reading needs both the inbox and
 * the ERP; every act on the ERP needs `sgp.act`, exactly as on the device page.
 */
class WhatsAppSubscriberController {
  static async get(req, res) {
    try {
      const panel = await WaSubscriberPanelService.build(req.params?.id, {
        contract: req.query?.contract || null,
        document: req.query?.document || null
      });
      return res.json(createResponse(req.t('sgp.dataLoaded'), present(req, panel)));
    } catch (error) {
      return handleError(req, res, error, 'sgp.dataLoadFailed');
    }
  }

  static async bind(req, res) {
    try {
      const panel = await WaSubscriberPanelService.bind(req.params?.id, {
        contract: req.body?.contract,
        document: req.body?.document || null
      });
      return res.json(createResponse(req.t('sgp.contractLinked'), present(req, panel)));
    } catch (error) {
      return handleError(req, res, error, 'sgp.linkFailed');
    }
  }

  static async unlock(req, res) {
    try {
      const result = await WaSubscriberPanelService.unlock(req.params?.id, { contract: req.body?.contract });
      return res.json(createResponse(result.message, { contract: result.contract }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.unlockFailed');
    }
  }

  /** "Retomar régua": a próxima passada volta a cobrar o contrato. */
  static async resumeDunning(req, res) {
    try {
      const result = await WaSubscriberPanelService.resumeDunning(req.params?.id, { contract: req.body?.contract });
      return res.json(createResponse(req.t('whatsapp.dunning.resumed'), result));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.dunning.resumeFailed');
    }
  }

  static async secondCopy(req, res) {
    try {
      const result = await WaSubscriberPanelService.secondCopy(req.params?.id, {
        contract: req.body?.contract,
        template: req.body?.template
      });
      return res.json(createResponse(req.t('sgp.dataLoaded'), result));
    } catch (error) {
      return handleError(req, res, error, 'sgp.dataLoadFailed');
    }
  }

  static async sendInvoice(req, res) {
    try {
      const result = await WaSubscriberPanelService.sendInvoice(req.params?.id, {
        contract: req.body?.contract,
        invoiceId: req.body?.invoiceId
      }, { userId: req.user?.userId ?? null, req });
      return res.status(201).json(createResponse(req.t('whatsapp.invoiceSend.sent'), result));
    } catch (error) {
      return handleError(req, res, error, 'sgp.dataLoadFailed');
    }
  }

  static async savePhone(req, res) {
    try {
      const panel = await WaSubscriberPanelService.savePhone(req.params?.id, { contract: req.body?.contract });
      return res.json(createResponse(req.t('whatsapp.phoneSaved'), present(req, panel)));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.phoneSaveFailed');
    }
  }

  static async ticket(req, res) {
    try {
      const body = req.body ?? {};
      const result = await WaSubscriberPanelService.ticket(req.params?.id, {
        contract: body.contract,
        content: body.content,
        note: body.note
      });
      return res.json(createResponse(result.message || req.t('sgp.ticketOpened'), result));
    } catch (error) {
      return handleError(req, res, error, 'sgp.ticketFailed');
    }
  }
}

export default WhatsAppSubscriberController;
