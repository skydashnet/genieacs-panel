import express from 'express';
import SettingsController from '../controllers/settingsController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requireRole(['admin']), SettingsController.getAllSettings);

router.get('/:key', authenticateToken, requireRole(['admin']), SettingsController.getSettingByKey);

router.post('/', authenticateToken, requireRole(['admin']), SettingsController.createSetting);

router.put('/:key', authenticateToken, requireRole(['admin']), SettingsController.updateSetting);

router.delete('/:key', authenticateToken, requireRole(['admin']), SettingsController.deleteSetting);

router.post('/test-genieacs', authenticateToken, requireRole(['admin']), SettingsController.testGenieAcsConnection);

export default router;
