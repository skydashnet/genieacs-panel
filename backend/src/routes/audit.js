import express from 'express';
import AuditController from '../controllers/auditController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

// Só leitura, e é a rota inteira. Ver o comentário no controlador.
router.get('/', authenticateToken, requirePermission('audit.read'), AuditController.list);

export default router;
