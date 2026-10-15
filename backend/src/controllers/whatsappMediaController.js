import WaMessage from '../models/WaMessage.js';
import { resolveStoredAttachment, streamAttachment } from '../services/waMediaFile.js';
import WaMediaSweeper from '../services/waMediaSweeper.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * The operator's half of the attachment story: `GET /api/whatsapp/messages/:id/media`.
 *
 * Session-authenticated and provider-scoped like everything else under
 * `/api/whatsapp`, which is what makes it a different route from the signed one
 * the Evolution server uses. The two must not merge: this one answers to a
 * human with a session and no token, that one to a server with a token and no
 * session, and the only reason either is safe is that neither accepts the
 * other's credential.
 *
 * What the request may say about the file is: which message. Nothing else. The
 * path is read from the row, and `resolveStoredAttachment` confines it to
 * `DATA_DIR` before anything is opened.
 */
class WhatsAppMediaController {
  static async fetch(req, res) {
    const notFound = () => res.status(404).json(createErrorResponse(
      req.t('whatsapp.error.attachmentNotFound'),
      null,
      'attachment_not_found'
    ));

    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) return notFound();

    try {
      // Scoped read: `WaMessage.getById` goes through `tdb`, so another
      // provider's message is not "forbidden" here — it does not exist, which
      // is both the safer answer and the true one.
      const message = await WaMessage.getById(id);
      if (!message || message.deleted_at) return notFound();

      const resolved = await resolveStoredAttachment(message);
      // A row with no attachment, a path that escapes DATA_DIR and a file that
      // was deleted off the disk all land here, on purpose: the operator can do
      // nothing different about any of them, and telling them apart would tell
      // a prober which paths exist.
      if (!resolved) return notFound();

      return streamAttachment(res, resolved);
    } catch (error) {
      console.error('whatsapp.error.attachmentNotFound:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * `POST /api/whatsapp/media/sweep` — the sweep, now, for the operator who
   * needs the disk back before the next pass six hours from now.
   *
   * It reports what it did in files and megabytes rather than answering 204,
   * because "0 files, 0 MB" is a real and common answer — retention off,
   * nothing old enough, everything still queued — and an operator staring at a
   * full disk has to be able to tell that from a button that did nothing.
   *
   * The request says nothing about what to delete. The window comes from the
   * saved settings and the rules from the sweeper; there is no parameter here
   * to widen either, so a mistyped body cannot become a wider deletion than
   * the one the operator configured and can see on the settings screen.
   *
   * `sweepCurrentTenant` and NOT `tick`: since the sweep became a per-provider
   * loop, `tick` walks every provider on the deployment. That is right for the
   * timer, which is nobody's request, and wrong for a button — this request
   * arrived inside one provider's scope and must reclaim that provider's disk
   * and report that provider's megabytes.
   */
  static async sweep(req, res) {
    try {
      const result = await WaMediaSweeper.sweepCurrentTenant();
      return res.json(createResponse(
        req.t('whatsapp.mediaSwept', { files: result.files, mb: result.mb }),
        result
      ));
    } catch (error) {
      // `tick` swallows its own failures, so reaching here is a bug rather than
      // a bad file — which is exactly when the operator must not be told that
      // something was cleaned up.
      console.error('whatsapp.mediaSweepFailed:', error);
      return res.status(500).json(createErrorResponse(
        req.t('whatsapp.mediaSweepFailed'),
        error.message
      ));
    }
  }
}

export default WhatsAppMediaController;
