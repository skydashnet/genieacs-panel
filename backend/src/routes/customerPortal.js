import express from 'express';
import CustomerPortalController from '../controllers/customerPortalController.js';
import { authenticatePortalCustomer } from '../middleware/portalAuth.js';
import {
  portalAccountLimiter,
  portalBillingLimiter,
  portalMutationLimiter,
  portalRevealLimiter,
  portalUnlockLimiter,
  referralSubmitLimiter
} from '../middleware/rateLimit.js';
import ReferralController from '../controllers/referralController.js';

const router = express.Router();

// Every authenticated limiter runs after authentication so that it can be keyed
// by customer account instead of by source address, which is shared by the
// whole customer base behind a reverse proxy or Cloudflare Tunnel.
router.post('/login', CustomerPortalController.login);
// A página de indicação: sem sessão, porque quem a abre é um amigo do cliente.
// O token vai na query (leitura) e no corpo (cadastro) e não no caminho, que o
// log do servidor grava inteiro; é ele que nomeia o provedor e o contrato.
router.get('/referral', ReferralController.publicInfo);
router.post('/referral', referralSubmitLimiter, ReferralController.publicSubmit);
router.get(
  '/session',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.session
);
router.get(
  '/provider',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.provider
);
router.get(
  '/overview',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.overview
);
router.get(
  '/wifi/:index/password',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalRevealLimiter,
  CustomerPortalController.revealWifiPassword
);
router.put(
  '/wifi',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalMutationLimiter,
  CustomerPortalController.updateWifi
);
router.get(
  '/billing',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalBillingLimiter,
  CustomerPortalController.billing
);
router.post(
  '/billing/trust-unlock',
  authenticatePortalCustomer,
  portalAccountLimiter,
  portalUnlockLimiter,
  CustomerPortalController.trustUnlock
);
router.post(
  '/logout',
  authenticatePortalCustomer,
  portalAccountLimiter,
  CustomerPortalController.logout
);

export default router;
