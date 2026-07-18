import express from 'express';
import DbManagementController from '../controllers/dbManagementController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/config', authenticateToken, requireRole(['admin']), DbManagementController.getConfig);
router.post('/test', authenticateToken, requireRole(['admin']), DbManagementController.testConnection);
router.post('/switch', authenticateToken, requireRole(['admin']), DbManagementController.switchDatabase);

export default router;
