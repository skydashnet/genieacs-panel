import express from 'express';
import PlatformIntegrationsController from '../controllers/platformIntegrationsController.js';
import PlatformSettingsController from '../controllers/platformSettingsController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * As integrações da plataforma com sistemas de fora — hoje, a conta dela no
 * Asaas. Mesma guarda dupla do resto do console: a chave com que a plataforma
 * cobra os provedores é o segredo mais caro deste deploy, e o administrador de
 * um provedor, por mais dono que seja do ISP dele, não chega perto dela.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/integrations/asaas', ...guard, PlatformIntegrationsController.getAsaas);
router.put('/integrations/asaas', ...guard, PlatformIntegrationsController.updateAsaas);
router.post('/integrations/asaas/test', ...guard, PlatformIntegrationsController.testAsaas);
router.post('/integrations/asaas/webhook-token', ...guard, PlatformIntegrationsController.rotateWebhookToken);

// Configurações → Dados do SaaS: a empresa que vende, como o site a mostra.
router.get('/settings/profile', ...guard, PlatformSettingsController.getProfile);
router.put('/settings/profile', ...guard, PlatformSettingsController.updateProfile);
// Configurações → Alertas (0112): a configuração vai no perfil; o teste, aqui.
router.post('/alerts/test', ...guard, PlatformSettingsController.testAlert);

// O provedor como cliente na conta Asaas da plataforma: cria lá e liga aqui.
router.post('/tenants/:id/gateway/asaas-customer', ...guard, PlatformIntegrationsController.createAsaasCustomer);

export default router;
