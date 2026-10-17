import CustomerReferralService, { readReferralToken } from '../services/customerReferralService.js';
import AuditLog from '../models/AuditLog.js';
import { runInTenant } from '../config/tenantContext.js';
import { hostMatchesTenant } from '../middleware/tenantResolver.js';
import { WaError } from '../services/whatsappConfigService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof WaError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

/**
 * Abre o provedor que o token nomeia — e só se o endereço por onde a pessoa
 * chegou pode agir por ele. Token inválido e provedor de outro host dão a
 * mesma resposta: o link não é deste lugar.
 */
async function withLink(req, token, fn) {
  const link = readReferralToken(token);
  if (!link || !hostMatchesTenant(req, link.tenantId)) {
    throw new WaError('whatsapp.referral.invalidLink', { code: 'invalid_link', status: 404 });
  }
  return runInTenant(link.tenantId, () => fn(link));
}

class ReferralController {
  // ── Pública: a página que o link abre ────────────────────────────────────

  static async publicInfo(req, res) {
    try {
      const info = await withLink(req, req.query?.t, (link) => CustomerReferralService.publicInfo(link.contract));
      return res.json(createResponse(req.t('whatsapp.referral.linkReady'), info));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.referral.linkFailed');
    }
  }

  static async publicSubmit(req, res) {
    try {
      const body = req.body ?? {};
      const result = await withLink(req, body.t, (link) => CustomerReferralService.submit(link.contract, body));
      return res.status(result.created ? 201 : 200).json(createResponse(req.t('whatsapp.referral.received'), { created: result.created }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.referral.submitFailed');
    }
  }

  // ── A tela de Indicações ─────────────────────────────────────────────────

  static async list(req, res) {
    try {
      const data = await CustomerReferralService.list({
        status: req.query?.status,
        limit: req.query?.limit,
        offset: req.query?.offset
      });
      return res.json(createResponse(req.t('whatsapp.referral.listReady'), data));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.referral.listFailed');
    }
  }

  static async update(req, res) {
    try {
      const referral = await CustomerReferralService.update(req.params.id, {
        status: req.body?.status,
        note: req.body?.note
      });
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.WHATSAPP_REFERRAL_UPDATED,
        subjectType: 'referral',
        subjectId: String(referral.id),
        detail: { status: referral.status }
      });
      return res.json(createResponse(req.t('whatsapp.referral.updated'), referral));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.referral.updateFailed');
    }
  }

  static async setBaseUrl(req, res) {
    try {
      const baseUrl = await CustomerReferralService.setBaseUrl(req.body?.baseUrl);
      return res.json(createResponse(req.t('whatsapp.referral.baseUrlSaved'), { baseUrl }));
    } catch (error) {
      return handleError(req, res, error, 'whatsapp.referral.baseUrlFailed');
    }
  }
}

export default ReferralController;
