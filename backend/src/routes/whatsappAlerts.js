import express from 'express';
import WhatsAppAlertsController from '../controllers/whatsappAlertsController.js';
import OutageController from '../controllers/outageController.js';
import MaintenanceController from '../controllers/maintenanceController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { telegramTestLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// `whatsapp.config` e não `whatsapp.read`: aqui está a escala de plantão, e
// mexer nela põe mensagem no telefone de um técnico às três da manhã. Quem está
// de plantão recebe o alerta; quem decide quem recebe é outra pessoa.
router.get('/alerts/settings', authenticateToken, requirePermission('whatsapp.config'), WhatsAppAlertsController.getSettings);
router.put('/alerts/settings', authenticateToken, requirePermission('whatsapp.config'), WhatsAppAlertsController.updateSettings);
router.post('/alerts/scan', authenticateToken, requirePermission('whatsapp.config'), WhatsAppAlertsController.scan);
// Uma mensagem de teste no grupo do Telegram: é o que diz se o bot está lá.
router.post('/alerts/telegram/test', authenticateToken, requirePermission('whatsapp.config'), telegramTestLimiter, WhatsAppAlertsController.testTelegram);

// As quedas em massa que o alerta viu, e o aviso aos clientes atingidos. Ler é
// de quem atende; avisar e fechar são de quem manda mensagem pelo provedor.
router.get('/outages', authenticateToken, requirePermission('whatsapp.read'), OutageController.list);
router.get('/outages/:id', authenticateToken, requirePermission('whatsapp.read'), OutageController.get);
router.patch('/outages/:id', authenticateToken, requirePermission('whatsapp.send'), OutageController.update);
router.post('/outages/:id/notify', authenticateToken, requirePermission('whatsapp.send'), OutageController.notify);
router.post('/outages/:id/resolve', authenticateToken, requirePermission('whatsapp.send'), OutageController.resolve);

// Manutenção programada. Ler é de quem atende; agendar, avisar e encerrar
// mandam mensagem ao assinante — de quem manda mensagem pelo provedor.
// `nodes` e `preview` antes de `:id`, senão o Express leria "preview" como id.
router.get('/maintenances', authenticateToken, requirePermission('whatsapp.read'), MaintenanceController.list);
router.get('/maintenances/nodes', authenticateToken, requirePermission('whatsapp.read'), MaintenanceController.nodes);
router.get('/maintenances/preview', authenticateToken, requirePermission('whatsapp.read'), MaintenanceController.preview);
router.get('/maintenances/:id', authenticateToken, requirePermission('whatsapp.read'), MaintenanceController.get);
router.post('/maintenances', authenticateToken, requirePermission('whatsapp.send'), MaintenanceController.create);
router.patch('/maintenances/:id', authenticateToken, requirePermission('whatsapp.send'), MaintenanceController.update);
router.post('/maintenances/:id/notify', authenticateToken, requirePermission('whatsapp.send'), MaintenanceController.notify);
router.post('/maintenances/:id/cancel', authenticateToken, requirePermission('whatsapp.send'), MaintenanceController.cancel);
router.post('/maintenances/:id/conclude', authenticateToken, requirePermission('whatsapp.send'), MaintenanceController.conclude);

export default router;
