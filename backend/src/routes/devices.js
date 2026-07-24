import express from 'express';
import DeviceController from '../controllers/deviceController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, DeviceController.getDevices);
router.get('/:deviceId', authenticateToken, DeviceController.getDeviceDetail);
router.delete('/:deviceId', authenticateToken, requireRole(['admin']), DeviceController.deleteDevice);
router.post('/reboot', authenticateToken, requireRole(['admin']), DeviceController.rebootDevice);
router.post('/summon', authenticateToken, requireRole(['admin']), DeviceController.summonDevice);
router.post('/:id/update-wan', authenticateToken, requireRole(['admin']), DeviceController.updateWanConfig);
router.post('/:id/update-credentials', authenticateToken, requireRole(['admin']), DeviceController.updateCredentials);

export default router;
