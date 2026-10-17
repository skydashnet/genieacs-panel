import express from 'express';
import MapSettingsController from '../controllers/mapSettingsController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('map.read'), MapSettingsController.getMapSettings);

router.put('/', authenticateToken, requirePermission('map.write'), MapSettingsController.updateMapSettings);

router.post('/reset', authenticateToken, requirePermission('map.write'), MapSettingsController.resetMapSettings);

export default router;