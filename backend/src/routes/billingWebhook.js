import express from 'express';
import BillingWebhookController from '../controllers/billingWebhookController.js';
import { billingWebhookLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

/**
 * A entrega do gateway de pagamento.
 *
 * Pública porque quem chama é um servidor, não uma sessão: autentica com a
 * credencial que a plataforma configurou no painel do gateway, e não com um
 * token deste painel. A conferência dessa credencial é a primeira coisa que o
 * controlador faz.
 *
 * Montada acima do resolvedor de provedor em `app.js`: a entrega chega no
 * endereço que o operador digitou lá no gateway — o apex, na prática — e o apex
 * não nomeia provedor nenhum. Quem sabe de quem é o dinheiro é o corpo.
 */
router.post('/', billingWebhookLimiter, BillingWebhookController.receive);

export default router;
