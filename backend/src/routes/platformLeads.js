import express from 'express';
import PlatformLeadsController from '../controllers/platformLeadsController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/** Os pedidos de demonstração da página pública — só o console os lê. */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/leads', ...guard, PlatformLeadsController.list);
router.patch('/leads/:id', ...guard, PlatformLeadsController.update);

export default router;
