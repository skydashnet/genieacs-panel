import express from 'express';
import SgpController from '../controllers/sgpController.js';
import SgpEventController from '../controllers/sgpEventController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { sgpAdminLimiter, sgpSyncLimiter, sgpWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// Unauthenticated: the caller is SGP, and the shared secret is the credential
// — and, since a delivery carries no session and every request under `/api`
// resolves to the same provider until providers are reached by host, that
// secret is also what says WHICH provider the delivery belongs to. The handler
// therefore ignores the provider this request was scoped to and opens the
// scope of the one whose secret verifies; `SgpEventController.receive`
// documents what that does and does not let an unauthenticated caller learn.
// Declared before the device routes so the matcher never treats `events` as a
// device id.
router.post('/events/webhook', sgpWebhookLimiter, SgpEventController.receive);

router.get('/events', authenticateToken, requirePermission('sgp.read'), SgpEventController.list);
router.get('/events/:id', authenticateToken, requirePermission('sgp.read'), SgpEventController.get);
router.post('/events/:id/retry', authenticateToken, requirePermission('sgp.act'), SgpEventController.retry);
router.post('/events/secret/rotate', authenticateToken, requirePermission('sgp.config'), SgpEventController.rotateSecret);
router.post('/reconcile', authenticateToken, requirePermission('sgp.act'), sgpSyncLimiter, SgpEventController.reconcile);

router.get('/config', authenticateToken, requirePermission('sgp.config'), SgpController.getConfig);
router.put('/config', authenticateToken, requirePermission('sgp.config'), SgpController.updateConfig);
router.post('/test', authenticateToken, requirePermission('sgp.config'), sgpAdminLimiter, SgpController.testConnection);
router.get('/customers', authenticateToken, requirePermission('sgp.read'), sgpAdminLimiter, SgpController.lookup);
router.get('/links', authenticateToken, requirePermission('sgp.read'), SgpController.listLinks);
router.get('/overview', authenticateToken, requirePermission('sgp.read'), SgpController.getOverview);
// A fleet sync calls the provider once per ONT, so it gets its own budget.
router.post('/sync', authenticateToken, requirePermission('sgp.act'), sgpSyncLimiter, SgpController.syncFleet);
// Every SGP client into the WhatsApp contacts. The sync pages through the
// whole client listing, so it takes the fleet sync's budget; the test reads one
// page and writes nothing, and is a configuration aid, so it asks for
// `sgp.config` like the connection test next to it.
router.get('/contacts/sync', authenticateToken, requirePermission('sgp.read'), SgpController.getContactsSync);
router.post('/contacts/sync', authenticateToken, requirePermission('sgp.act'), sgpSyncLimiter, SgpController.syncContacts);
router.post('/contacts/test', authenticateToken, requirePermission('sgp.config'), sgpAdminLimiter, SgpController.testContacts);
router.get('/devices/:deviceId', authenticateToken, requirePermission('sgp.read'), sgpAdminLimiter, SgpController.getDeviceIntegration);
router.post('/devices/:deviceId/link', authenticateToken, requirePermission('sgp.act'), sgpAdminLimiter, SgpController.linkDevice);
router.delete('/devices/:deviceId/link', authenticateToken, requirePermission('sgp.act'), sgpAdminLimiter, SgpController.unlinkDevice);
router.post('/devices/:deviceId/unlock', authenticateToken, requirePermission('sgp.act'), sgpAdminLimiter, SgpController.unlockDevice);
router.post('/devices/:deviceId/ticket', authenticateToken, requirePermission('sgp.act'), sgpAdminLimiter, SgpController.openTicket);

export default router;
