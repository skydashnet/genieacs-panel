import express from 'express';
import { getDb } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import { waMediaLimiter } from '../middleware/rateLimit.js';
import { resolveStoredAttachment, streamAttachment } from '../services/waMediaFile.js';
import { tokenFromQuery, verify } from '../utils/wa/waMediaToken.js';

const router = express.Router();

/**
 * The file the Evolution server fetches in order to send it.
 *
 * PUBLIC — mounted outside `authenticateToken`, because the caller has no
 * session to authenticate. Its only credential is the signed `t` in the query
 * string, minted by the outbox worker at despatch and good for fifteen minutes.
 * A browser never mints one; the operator has their own route.
 *
 * Everything that fails answers the same bare 404, deliberately, in the same
 * spirit as the webhook's single 401: an expired token, a token for another id,
 * a message that does not exist and a message with nothing attached are four
 * different facts, and telling them apart would let a prober walk the id space
 * and learn which messages carry files.
 */
router.get('/:id', waMediaLimiter, async (req, res) => {
  const notFound = () => res.status(404).json({
    success: false,
    code: 'attachment_not_found',
    message: req.t('whatsapp.error.attachmentNotFound')
  });

  const id = Number(req.params?.id);
  if (!Number.isInteger(id) || id <= 0) return notFound();

  // The signature is checked BEFORE the database is touched: an unsigned
  // request must not be able to make the panel do work, and it must not be
  // able to time the difference between a row that exists and one that does
  // not.
  if (!verify(id, tokenFromQuery(req.query))) return notFound();

  try {
    // tenant-scope-exempt: this route runs before `resolveTenant` — there is no
    // session and no host to attribute the request to, which is the same
    // position the webhook is in. The signature stands in for the scope: it
    // names exactly one message id and only the panel can mint one, so this
    // read reaches precisely the row the panel itself already chose to publish,
    // and no other. Serving one message's bytes needs no provider filter
    // because the caller cannot name a message the panel did not name first.
    //
    // `runUnscoped` repeats that to the SQL sentinel, which judges the SQL and
    // cannot read the paragraph above it.
    const message = await runUnscoped(
      'a signed media link names one message and only the panel can mint one',
      () => getDb()('wa_messages').where({ id }).first()
    );
    if (!message) return notFound();

    const resolved = await resolveStoredAttachment(message);
    if (!resolved) return notFound();

    return streamAttachment(res, resolved);
  } catch (error) {
    console.error('[wa] media fetch failed:', error.message);
    return res.status(500).json({ success: false, message: req.t('common.internalError') });
  }
});

export default router;
