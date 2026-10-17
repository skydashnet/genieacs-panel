import express from 'express';
import PlatformBillingController from '../controllers/platformBillingController.js';
import PlatformSubscriptionsController from '../controllers/platformSubscriptionsController.js';
import PlatformCouponsController from '../controllers/platformCouponsController.js';
import PlatformReferralsController from '../controllers/platformReferralsController.js';
import CancellationController from '../controllers/cancellationController.js';
import PlatformDelinquencyController from '../controllers/platformDelinquencyController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * A metade comercial do plano de controle. Mesma guarda dupla de
 * `platform.js`, pelo mesmo motivo: o plano de um provedor é decisão de quem
 * opera o SaaS, e o administrador do próprio provedor — por mais dono que seja
 * — não muda o que paga por uma rota do painel.
 */
const router = express.Router();
const guard = [authenticateToken, requirePlatformAdmin];

router.get('/plans', ...guard, PlatformBillingController.listPlans);
router.post('/plans', ...guard, PlatformBillingController.createPlan);
router.patch('/plans/:id', ...guard, PlatformBillingController.updatePlan);

router.get('/tenants/:id/subscription', ...guard, PlatformBillingController.getSubscription);
router.put('/tenants/:id/subscription', ...guard, PlatformBillingController.updateSubscription);
router.post('/tenants/:id/payments', ...guard, PlatformBillingController.recordPayment);
router.get('/tenants/:id/usage', ...guard, PlatformBillingController.getUsage);

// A tela de Assinaturas: todos de uma vez, as cobranças de um, e os gestos
// sobre uma cobrança (o estorno inclusive, que desfaz o período pago). Trocar plano, suspender e reativar continuam no `PUT`
// da assinatura, logo acima — esta tela o chama em vez de duplicá-lo.
router.get('/subscriptions', ...guard, PlatformSubscriptionsController.listSubscriptions);
router.patch('/tenants/:id/subscription/deadlines', ...guard, PlatformSubscriptionsController.setDeadlines);
// O "isento de cobrança": ativo sem gerar fatura, até alguém desligar.
router.put('/tenants/:id/subscription/billing-exempt', ...guard, PlatformBillingController.setBillingExempt);
router.get('/tenants/:id/charges', ...guard, PlatformSubscriptionsController.listCharges);
router.patch('/tenants/:id/charges/:chargeId', ...guard, PlatformSubscriptionsController.update);
router.post('/tenants/:id/charges/:chargeId/settle', ...guard, PlatformSubscriptionsController.settle);
router.post('/tenants/:id/charges/:chargeId/cancel', ...guard, PlatformSubscriptionsController.cancel);
router.post('/tenants/:id/charges/:chargeId/reissue', ...guard, PlatformSubscriptionsController.reissue);
router.post('/tenants/:id/charges/:chargeId/refund', ...guard, PlatformSubscriptionsController.refund);
// A NFS-e da cobrança paga: emitir, ou emitir de novo a que falhou.
router.post('/tenants/:id/charges/:chargeId/invoice', ...guard, PlatformSubscriptionsController.issueInvoice);

// Os cupons de desconto (0093): o catálogo deles, e o cupom de UM provedor —
// `{ code }` aplica (substituindo o que houver), `{ code: null }` tira.
router.get('/coupons', ...guard, PlatformCouponsController.list);
router.post('/coupons', ...guard, PlatformCouponsController.create);
router.patch('/coupons/:id', ...guard, PlatformCouponsController.update);
router.delete('/coupons/:id', ...guard, PlatformCouponsController.remove);
router.put('/tenants/:id/subscription/coupon', ...guard, PlatformBillingController.setCoupon);
// A retenção no cancelamento (0107): o console desfaz o cancelamento agendado.
router.delete('/tenants/:id/subscription/cancellation', ...guard, CancellationController.consoleRevert);

// A indicação e os créditos de um provedor (0106): a lista, e o ajuste manual
// do saldo — auditado nas duas trilhas.
router.get('/tenants/:id/referrals', ...guard, PlatformReferralsController.get);
router.post('/tenants/:id/credits', ...guard, PlatformReferralsController.adjust);

// O painel de inadimplência: quem deve, e as ações em massa — os provedores
// vão no corpo, e cada um é tratado no escopo dele (ver o controlador).
router.get('/delinquency', ...guard, PlatformDelinquencyController.list);
router.post('/delinquency/actions', ...guard, PlatformDelinquencyController.run);

export default router;
