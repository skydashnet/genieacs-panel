import express from 'express';
import MapSettingsController from '../controllers/mapSettingsController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, MapSettingsController.getMapSettings);

router.put('/', authenticateToken, requireRole(['admin']), MapSettingsController.updateMapSettings);

router.post('/reset', authenticateToken, requireRole(['admin']), MapSettingsController.resetMapSettings);

export default router;