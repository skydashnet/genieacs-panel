import express from 'express';
import DbManagementController from '../controllers/dbManagementController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/config', authenticateToken, requirePermission('database.manage'), DbManagementController.getConfig);
router.post('/test', authenticateToken, requirePermission('database.manage'), DbManagementController.testConnection);
router.post('/switch', authenticateToken, requirePermission('database.manage'), DbManagementController.switchDatabase);

export default router;
