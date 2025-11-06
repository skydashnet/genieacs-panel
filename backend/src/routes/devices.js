import express from 'express';
import DeviceController from '../controllers/deviceController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, DeviceController.getDevices);

router.get('/:deviceId', authenticateToken, DeviceController.getDeviceDetail);

router.delete('/:deviceId', authenticateToken, DeviceController.deleteDevice);

router.post('/reboot', authenticateToken, DeviceController.rebootDevice);

router.post('/summon', authenticateToken, DeviceController.summonDevice);

export default router;