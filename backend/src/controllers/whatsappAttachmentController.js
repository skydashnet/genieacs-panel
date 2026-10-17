import WaAttachmentService from '../services/waAttachmentService.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

class WhatsAppAttachmentController {
  /**
   * Takes the raw file and answers with the stored reference.
   *
   * Nothing is written to any table here: the row is written later, by
   * `POST /conversations/:id/messages`, out of the very `{ path, type, name }`
   * this returns. That is why an upload the operator then abandons costs a file
   * on disk and no half-message in the thread — the opposite order would leave
   * a bubble pointing at bytes that never arrived.
   */
  static async upload(req, res) {
    try {
      const stored = await WaAttachmentService.store({
        buffer: req.body,
        contentType: req.get('content-type'),
        fileName: req.get('x-file-name')
      });
      return res.status(201).json(createResponse(req.t('whatsapp.attachmentStored'), stored));
    } catch (error) {
      if (error instanceof WaError) {
        // With the machine `code`, like every refusal on this surface: the
        // screen translates the code and never the message beside it.
        return res.status(error.status).json({
          ...createErrorResponse(translateError(req.t, error), error.details || error.code),
          code: error.code
        });
      }
      // A disk that is full or read-only, and nothing else: every refusal this
      // route knows how to name is a `WaError` above. `common.internalError`
      // rather than a WhatsApp key because that is what this is — no new key
      // was invented for it, the nine dictionaries are already written.
      console.error('[wa] failed to store outbound attachment:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }
}

export default WhatsAppAttachmentController;
