import * as dbManagement from '../services/dbManagementService.js';
import { translateError } from '../i18n/index.js';

const DbManagementController = {
  async getConfig(req, res) {
    try {
      const config = dbManagement.getActiveConfig();
      res.json({ success: true, message: req.t('database.activeConfig'), data: config });
    } catch (error) {
      res.status(500).json({ success: false, message: translateError(req.t, error) });
    }
  },

  async testConnection(req, res) {
    try {
      await dbManagement.testConfig(req.body || {});
      res.json({ success: true, message: req.t('database.connectionSuccess') });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: req.t('database.connectionFailed', { error: translateError(req.t, error) })
      });
    }
  },

  async switchDatabase(req, res) {
    try {
      const { migrateData, ...config } = req.body || {};
      const active = await dbManagement.switchDatabase(config, { migrateData: Boolean(migrateData) });
      res.json({
        success: true,
        message: req.t('database.switched'),
        data: active
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: req.t('database.switchFailed', { error: translateError(req.t, error) })
      });
    }
  }
};

export default DbManagementController;
