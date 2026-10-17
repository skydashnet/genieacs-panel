import TeiahService, { TeiahError } from '../services/teiahService.js';
import TeiahExportService from '../services/teiahExportService.js';
import { SgpError } from '../services/sgpService.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { translateError } from '../i18n/index.js';

const EXPORT_STATUSES = new Set(['sent', 'skipped', 'error']);

function handleError(req, res, error, fallbackKey) {
  // The export reads the SGP too, so its errors come in both kinds.
  if (error instanceof TeiahError || error instanceof SgpError) {
    return res.status(error.status).json({
      ...createErrorResponse(translateError(req.t, error), error.details || error.code),
      code: error.code
    });
  }
  console.error(`${fallbackKey}:`, error);
  return res.status(500).json(createErrorResponse(req.t(fallbackKey), error.message));
}

class TeiahController {
  static async getConfig(req, res) {
    try {
      return res.json(createResponse(req.t('teiah.configLoaded'), await TeiahService.getPublicConfig()));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configLoadFailed');
    }
  }

  static async updateConfig(req, res) {
    try {
      const body = req.body ?? {};
      const config = await TeiahService.saveConfig({
        enabled: body.enabled,
        baseUrl: body.baseUrl,
        // An absent key keeps the stored one; "" clears it.
        apiKey: body.apiKey === undefined ? undefined : body.apiKey,
        exportEnabled: body.exportEnabled,
        exportIntervalHours: body.exportIntervalHours,
        batchSize: body.batchSize,
        rentalDefault: body.rentalDefault
      });
      return res.json(createResponse(req.t('teiah.configSaved'), config));
    } catch (error) {
      return handleError(req, res, error, 'teiah.configSaveFailed');
    }
  }

  static async testConnection(req, res) {
    try {
      const body = req.body ?? {};
      const result = await TeiahService.testConnection({ baseUrl: body.baseUrl, apiKey: body.apiKey });
      return res.json(createResponse(req.t('teiah.connectionOk'), result));
    } catch (error) {
      return handleError(req, res, error, 'teiah.connectionTestFailed');
    }
  }

  static async getExportStatus(req, res) {
    try {
      const status = await TeiahExportService.getStatus();
      const lastError = status.lastError
        ? { at: status.lastError.at, code: status.lastError.code, message: translateError(req.t, status.lastError) }
        : null;
      return res.json(createResponse(req.t('teiah.exportLoaded'), { ...status, lastError }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }

  static async listExportItems(req, res) {
    try {
      const status = EXPORT_STATUSES.has(String(req.query?.status)) ? String(req.query.status) : null;
      const items = await TeiahExportService.listItems({ status, limit: req.query?.limit });
      return res.json(createResponse(req.t('teiah.exportLoaded'), { items }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }

  static async previewExport(req, res) {
    try {
      return res.json(createResponse(req.t('teiah.exportPreviewed'), await TeiahExportService.preview({})));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }

  static async runExport(req, res) {
    try {
      await TeiahExportService.start();
      return res.status(202).json(createResponse(req.t('teiah.exportStarted'), { running: true }));
    } catch (error) {
      return handleError(req, res, error, 'teiah.exportFailed');
    }
  }
}

export default TeiahController;
