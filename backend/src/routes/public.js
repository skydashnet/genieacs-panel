import express from 'express';
import PublicController from '../controllers/publicController.js';
import { publicCnpjLimiter, publicLeadLimiter, publicReadLimiter } from '../middleware/rateLimit.js';

/**
 * A página pública do ápice: sem sessão, só leitura de catálogo e o pedido de
 * demonstração. Montado atrás de `platformHostOnly` — no host de um provedor
 * estas rotas não existem.
 */
const router = express.Router();

router.get('/info', publicReadLimiter, PublicController.info);
router.get('/plans', publicReadLimiter, PublicController.plans);
router.get('/slug-available', publicReadLimiter, PublicController.slugAvailable);
router.get('/cnpj', publicCnpjLimiter, PublicController.cnpj);
router.post('/leads', publicLeadLimiter, PublicController.createLead);

export default router;
