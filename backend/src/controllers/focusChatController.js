import FocusChatService, { FocusChatError } from '../services/focusChatService.js';
import AuditLog from '../models/AuditLog.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

function handleError(req, res, error, fallbackKey) {
  if (error instanceof FocusChatError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class FocusChatController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(req.t('focuschat.configLoaded'), await FocusChatService.getPublicConfig()));
    } catch (error) {
      return handleError(req, res, error, 'focuschat.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await FocusChatService.saveConfig({
        enabled: body.enabled,
        // An absent token keeps the stored one; "" clears it.
        token: body.token === undefined ? undefined : body.token
      });
      // Whether the token changed, never the token.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.FOCUSCHAT_CONFIG_UPDATED,
        subjectType: 'settings',
        subjectId: 'focuschat',
        detail: { enabled: config.enabled, tokenChanged: body.token !== undefined }
      });
      return res.json(createResponse(req.t('focuschat.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'focuschat.configSaveFailed');
    }
  }

  static async testConnection(req, res) {
    try {
      const result = await FocusChatService.testConnection({ token: req.body?.token });
      return res.json(createResponse(req.t('focuschat.connectionOk', { count: result.firstPage }), result));
    } catch (error) {
      return handleError(req, res, error, 'focuschat.connectionTestFailed');
    }
  }
}

export default FocusChatController;
