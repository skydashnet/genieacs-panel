import express from 'express';
import TeiahController from '../controllers/teiahController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { teiahAdminLimiter, teiahExportLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/config', authenticateToken, requirePermission('teiah.config'), TeiahController.getConfig);
router.put('/config', authenticateToken, requirePermission('teiah.config'), TeiahController.updateConfig);
router.post('/test', authenticateToken, requirePermission('teiah.config'), teiahAdminLimiter, TeiahController.testConnection);

router.get('/export', authenticateToken, requirePermission('teiah.read'), TeiahController.getExportStatus);
router.get('/export/items', authenticateToken, requirePermission('teiah.read'), TeiahController.listExportItems);
// The preview looks up the open invoices of a few contracts in the SGP, so it
// shares the connection test's budget.
router.get('/export/preview', authenticateToken, requirePermission('teiah.read'), teiahAdminLimiter, TeiahController.previewExport);
// A run reads every cancelled contract's invoices and writes to TeiaH.
router.post('/export/run', authenticateToken, requirePermission('teiah.act'), teiahExportLimiter, TeiahController.runExport);

export default router;
