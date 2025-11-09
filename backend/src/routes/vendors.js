import express from 'express';
import VendorController from '../controllers/vendorController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/wifi-security-configs', authenticateToken, VendorController.getAllWifiSecurityConfigs);
router.get('/wifi-security-configs/by-product-class/:productClass', authenticateToken, VendorController.getWifiSecurityConfigByProductClass);
router.get('/wifi-security-configs/:id', authenticateToken, VendorController.getWifiSecurityConfigById);

router.get('/:vendorId/wifi-security', authenticateToken, VendorController.getWifiSecurityMappings);

router.post('/wifi-security-configs', authenticateToken, requireRole(['admin']), VendorController.createWifiSecurityConfig);
router.post('/:vendorId/wifi-security', authenticateToken, requireRole(['admin']), VendorController.createWifiSecurityMapping);

router.put('/wifi-security/:id', authenticateToken, requireRole(['admin']), VendorController.updateWifiSecurityMapping);
router.put('/wifi-security-configs/:id', authenticateToken, requireRole(['admin']), VendorController.updateWifiSecurityConfig);

router.delete('/wifi-security/:id', authenticateToken, requireRole(['admin']), VendorController.deleteWifiSecurityMapping);
router.delete('/wifi-security-configs/:id', authenticateToken, requireRole(['admin']), VendorController.deleteWifiSecurityConfig);

router.get('/', authenticateToken, VendorController.getAllVendors);
router.get('/:id', authenticateToken, VendorController.getVendorById);
router.post('/', authenticateToken, requireRole(['admin']), VendorController.createVendor);
router.put('/:id', authenticateToken, requireRole(['admin']), VendorController.updateVendor);
router.delete('/:id', authenticateToken, requireRole(['admin']), VendorController.deleteVendor);

export default router;