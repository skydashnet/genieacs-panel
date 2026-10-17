import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import SgpEvent, { publicEvent } from '../models/SgpEvent.js';
import SgpEventService from '../services/sgpEventService.js';
import SgpService, { SgpError, WEBHOOK_PATH } from '../services/sgpService.js';
import { verifyWebhookSignature } from '../utils/webhookSignature.js';
import { translateError } from '../i18n/index.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof SgpError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class SgpEventController {
  /**
   * Every active provider a delivery could belong to, with the configuration
   * it would have to be checked against.
   *
   * Read outside any provider's scope on purpose — which provider this is for
   * is precisely the question being answered — and one scope is opened per
   * candidate to read that provider's own configuration, since the secret
   * lives in the scoped `app_state` and each provider's is cached under its
   * own key. Providers with delivery switched off are not candidates: a secret
   * that is not in use must not admit anything. Neither is a provider that is
   * not active — the same reading `forSoleTenant` and `forEachTenant` take of
   * that column, and the reason a suspended ISP's ERP cannot keep filling its
   * log.
   */
  static async deliveryCandidates() {
    const tenants = await getDb()('tenants').where({ status: 'active' }).orderBy('id', 'asc');
    const candidates = [];
    for (const tenant of tenants) {
      const config = await runInTenant(tenant.id, () => SgpService.getConfig());
      if (config.webhookEnabled && config.webhookSecret) {
        candidates.push({ tenantId: tenant.id, config });
      }
    }
    return candidates;
  }

  /**
   * Public endpoint SGP posts to. It is mounted before the global JSON parser
   * so the signature is computed over the exact bytes that were signed; the
   * body is only parsed once the signature checks out.
   *
   * The provider is the RESULT of the signature check, never an input to it.
   *
   * This route is public and sits under `resolveTenant`, which — until
   * providers are reached by host — answers with the first provider for every
   * request. Reading the webhook secret from that scope meant the endpoint
   * could only ever authenticate provider #1: a second ISP's SGP had no way to
   * deliver anything at all, and scoping `sgp_events` without settling that
   * would have moved the failure rather than ended it.
   *
   * The Evolution webhook already solves the same problem here, by resolving
   * its account from the instance name in the payload before the scope opens
   * (`WhatsAppAccount.getByName`). This is that shape with a different
   * identifier, and the difference is deliberate: SGP is configured with a URL
   * and a shared secret and nothing else, so there is no field an integrator
   * could be asked to fill in that would name the provider — and inventing one
   * would put an unauthenticated, caller-chosen provider selector in front of
   * an HMAC check. The signature is the identifier instead. The delivery is
   * verified against each candidate's own secret under that candidate's own
   * timestamp policy, and the provider whose secret verifies IS the provider.
   * A signature that cannot be produced without a secret cannot name the wrong
   * owner of it.
   *
   * What an unauthenticated caller CAN learn from this endpoint: whether
   * somebody on this deployment has SGP delivery enabled — 404 while nobody
   * does, 401 once anybody does. That is exactly what it already told a prober
   * when there was one provider, and the 404 is kept because it is what stops
   * a survey of panels from noticing SGP here at all.
   *
   * What it CANNOT learn: how many providers exist, which of them uses SGP, or
   * anything that tells them apart. Nothing in the request names a provider and
   * no answer varies by one — every delivery that does not verify gets the same
   * 401 with the same code, and every candidate is tried on every request, so
   * neither the response nor the work behind it depends on which provider a
   * body was aimed at. It also learns nothing about a contract, document or
   * login: none of that is read before the signature verifies.
   *
   * And what it CANNOT do: have one provider's secret admit another provider's
   * payload. The row is filed under whoever's secret signed those bytes, and
   * there is no claimed identity for that to disagree with. Writing into
   * provider B's log still requires B's secret, exactly as before.
   *
   * Two providers holding the SAME secret are refused rather than guessed at.
   * The delivery is genuinely ambiguous, and taking the lower-numbered one
   * would write an ISP's subscriber data into another ISP's log; an operator
   * has to rotate one of them. It is logged loudly for that reason.
   *
   * The cost is one HMAC per candidate per delivery over a body already capped
   * at 64 kB, behind `sgpWebhookLimiter`. If a deployment ever carries enough
   * providers for that to matter, the answer is a routing hint minted by the
   * panel and shown next to the URL in Settings — not a hint the sender is
   * trusted to invent.
   */
  static async receive(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    let candidates;
    try {
      candidates = await SgpEventController.deliveryCandidates();
    } catch (error) {
      console.error('Could not read the SGP webhook configuration:', error.message);
      return res.status(503).json({ success: false, code: 'unavailable' });
    }

    // Nobody has delivery switched on, so there is nothing here to talk to.
    if (candidates.length === 0) {
      return res.status(404).json({ success: false, code: 'webhook_disabled' });
    }

    // Every candidate is checked, and the loop is not cut short on the first
    // match: stopping early would make the work depend on which provider the
    // body belongs to, and it is also how two providers sharing a secret would
    // go unnoticed instead of being refused.
    const accepted = [];
    const reasons = new Set();
    for (const candidate of candidates) {
      const verdict = verifyWebhookSignature({
        rawBody,
        secret: candidate.config.webhookSecret,
        headers: req.headers,
        toleranceSeconds: candidate.config.webhookToleranceSeconds,
        requireTimestamp: candidate.config.webhookRequireTimestamp
      });
      if (verdict.ok) accepted.push(candidate);
      else reasons.add(verdict.reason);
    }

    if (accepted.length > 1) {
      console.error(
        'Refused an SGP webhook delivery: providers '
        + `${accepted.map((candidate) => candidate.tenantId).join(', ')} share a webhook secret, `
        + 'so the delivery cannot be attributed. Rotate one of them.'
      );
      // Same answer as a bad signature: the sender is not told that its secret
      // is correct but installed twice.
      return res.status(401).json({ success: false, code: 'invalid_signature' });
    }

    if (accepted.length === 0) {
      // Panel-side only, and it names no provider: the response never says
      // which part failed, let alone whose check it failed.
      console.warn(`Rejected an SGP webhook delivery: ${[...reasons].sort().join('/')}`);
      return res.status(401).json({ success: false, code: 'invalid_signature' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return res.status(400).json({ success: false, code: 'invalid_json' });
    }

    const { tenantId, config } = accepted[0];
    // Everything from here down runs as the provider that signed the delivery,
    // not as whatever the request happened to be resolved to — including the
    // deferred processing, which inherits this scope through the promise it is
    // started on.
    return runInTenant(tenantId, async () => {
      try {
        const { created, event } = await SgpEventService.ingestWebhook(rawBody, parsed, config);
        if (!created) {
          // A redelivery must not look like a failure, or SGP keeps retrying.
          // "Redelivery" now means this provider has already stored the key —
          // another provider's identical event id is a different event.
          return res.status(200).json({ success: true, duplicate: true, id: event?.id ?? null });
        }
        // Answer before touching SGP or GenieACS: a delivery that waits on our
        // round-trips times out on the sender and gets retried.
        res.status(202).json({ success: true, duplicate: false, id: event.id });
        void SgpEventService.processPending({ limit: 5 }).catch((error) => {
          console.warn(`Deferred SGP event processing failed: ${error.message}`);
        });
        return undefined;
      } catch (error) {
        console.error('Failed to store an SGP webhook delivery:', error);
        return res.status(500).json({ success: false, code: 'storage_failed' });
      }
    });
  }

  static async list(req, res) {
    try {
      const events = await SgpEvent.list({
        status: req.query?.status ?? null,
        type: req.query?.type ?? null,
        contract: req.query?.contract ?? null,
        limit: req.query?.limit
      });
      return res.json(createResponse(req.t('sgp.events.loaded'), {
        events: events.map((event) => publicEvent(event))
      }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.loadFailed');
    }
  }

  static async get(req, res) {
    try {
      const event = await SgpEvent.getById(Number(req.params?.id));
      if (!event) return res.status(404).json(createErrorResponse(req.t('sgp.events.notFound')));
      return res.json(createResponse(req.t('sgp.events.loaded'), { event: publicEvent(event) }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.loadFailed');
    }
  }

  static async retry(req, res) {
    try {
      const event = await SgpEventService.retry(Number(req.params?.id));
      if (!event) return res.status(404).json(createErrorResponse(req.t('sgp.events.notFound')));
      return res.json(createResponse(req.t('sgp.events.retried'), { event: publicEvent(event) }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.retryFailed');
    }
  }

  static async rotateSecret(req, res) {
    try {
      const secret = await SgpService.rotateWebhookSecret();
      // Shown once, exactly like a regenerated portal password.
      return res.json(createResponse(req.t('sgp.events.secretRotated'), {
        secret,
        path: WEBHOOK_PATH
      }));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.secretRotateFailed');
    }
  }

  static async reconcile(req, res) {
    try {
      const summary = await SgpEventService.reconcile({});
      return res.json(createResponse(req.t('sgp.events.reconciled'), summary));
    } catch (error) {
      return handleError(req, res, error, 'sgp.events.reconcileFailed');
    }
  }
}

export default SgpEventController;
