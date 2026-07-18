import * as dbManagement from '../services/dbManagementService.js';

const DbManagementController = {
  async getConfig(req, res) {
    try {
      const config = dbManagement.getActiveConfig();
      res.json({ success: true, message: 'Active database config', data: config });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async testConnection(req, res) {
    try {
      await dbManagement.testConfig(req.body || {});
      res.json({ success: true, message: 'Connection successful' });
    } catch (error) {
      res.status(400).json({ success: false, message: `Connection failed: ${error.message}` });
    }
  },

  async switchDatabase(req, res) {
    try {
      const { migrateData, ...config } = req.body || {};
      const active = await dbManagement.switchDatabase(config, { migrateData: Boolean(migrateData) });
      res.json({
        success: true,
        message: 'Database switched successfully. Restart the service to apply.',
        data: active
      });
    } catch (error) {
      res.status(400).json({ success: false, message: `Switch failed: ${error.message}` });
    }
  }
};

export default DbManagementController;
