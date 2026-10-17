import express from 'express';
import PlatformAdminController from '../controllers/platformAdminController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * O cadastro do próprio console, editado pelo console.
 *
 * Montado em `/api/platform`, ao lado do registro de provedores e da equipe
 * deles, e só onde `EDITION=saas` — num self-hosted não existe plano acima do
 * provedor, e estas rotas não respondem 403 ali: elas não existem, porque um
 * 403 já responderia a pergunta que quem sonda está fazendo.
 *
 * As duas guardas de sempre, nesta ordem e nunca uma sem a outra.
 * `authenticateToken` estabelece QUEM pergunta; `requirePlatformAdmin`, que
 * quem pergunta está acima dos provedores em vez de dentro de um.
 *
 * Aqui a segunda guarda tem um papel que ela não tem nas rotas vizinhas: **é o
 * próprio cadastro que estas rotas editam.** Quem passa por ela pode pôr outra
 * pessoa ao lado de si — e a única coisa que impede o cadastro de chegar a
 * zero, que o trancaria para todos para sempre, é a recusa do último, lá
 * embaixo em `PlatformAdmin.removeUnlessLast`. Uma sessão de personificação,
 * que é de quem está no cadastro mas foi re-escopada no provedor de um cliente,
 * bate no 404 da guarda antes de chegar aqui; o motivo está escrito nela.
 */
const router = express.Router();

router.get(
  '/admins',
  authenticateToken,
  requirePlatformAdmin,
  PlatformAdminController.list
);

router.post(
  '/admins',
  authenticateToken,
  requirePlatformAdmin,
  PlatformAdminController.grant
);

router.delete(
  '/admins/:userId',
  authenticateToken,
  requirePlatformAdmin,
  PlatformAdminController.revoke
);

export default router;
