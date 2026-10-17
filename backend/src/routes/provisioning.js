import express from 'express';
import ProvisioningController from '../controllers/provisioningController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { provisioningActionLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// Três guardas e não uma, porque são três decisões diferentes: ler o que o
// provisionamento fez, disparar uma passada — que escreve no CPE do assinante e
// é ato de plantão — e mudar a REGRA que decide o que será escrito, que é
// decisão de quem responde pelo provedor.
const leitura = [authenticateToken, requirePermission('provisioning.read')];
const passada = [authenticateToken, requirePermission('provisioning.run')];
const regra = [authenticateToken, requirePermission('provisioning.write')];

router.get('/config', ...leitura, ProvisioningController.getConfig);
router.put('/config', ...regra, ProvisioningController.updateConfig);

router.get('/profiles', ...leitura, ProvisioningController.listProfiles);
router.post('/profiles', ...regra, ProvisioningController.createProfile);
router.put('/profiles/:id', ...regra, ProvisioningController.updateProfile);
router.delete('/profiles/:id', ...regra, ProvisioningController.deleteProfile);

router.get('/runs', ...leitura, ProvisioningController.listRuns);
// Writing to a CPE is slow and visible to a subscriber, so the actions that do
// it are limited per operator on top of the shared API limit.
router.post('/run', ...passada, provisioningActionLimiter, ProvisioningController.runPass);
router.get('/devices/:deviceId/runs', ...leitura, ProvisioningController.listDeviceRuns);
router.post(
  '/devices/:deviceId/preview', ...passada, provisioningActionLimiter, ProvisioningController.previewDevice
);
router.post(
  '/devices/:deviceId/provision', ...passada, provisioningActionLimiter, ProvisioningController.provisionDevice
);

export default router;
