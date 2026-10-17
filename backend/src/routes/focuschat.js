import express from 'express';
import FocusChatController from '../controllers/focusChatController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { teiahAdminLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// The integration is configuration: the same capability as the rest of
// Settings. The test reaches the vendor, so it shares the outside-API budget.
router.get('/config', authenticateToken, requirePermission('settings.write'), FocusChatController.getConfig);
router.put('/config', authenticateToken, requirePermission('settings.write'), FocusChatController.updateConfig);
router.post('/test', authenticateToken, requirePermission('settings.write'), teiahAdminLimiter, FocusChatController.testConnection);

export default router;
