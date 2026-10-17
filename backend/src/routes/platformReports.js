import express from 'express';
import PlatformReportsController from '../controllers/platformReportsController.js';
import CancellationController from '../controllers/cancellationController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * Os relatórios do console — por ora, a receita. Mesma guarda dupla dos
 * outros roteadores do plano de controle: o que a plataforma fatura não é
 * pergunta que o dono de um provedor faça por uma rota do painel.
 *
 * O `.csv` vem antes do `revenue` sem extensão só por clareza: o Express casa
 * o caminho inteiro, e um não engole o outro.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/reports/revenue.csv', ...guard, PlatformReportsController.revenueCsv);
router.get('/reports/revenue', ...guard, PlatformReportsController.revenue);
// Os pedidos de cancelamento (0107): motivos, ofertas aceitas e retenção.
router.get('/reports/cancellations', ...guard, CancellationController.report);

export default router;
