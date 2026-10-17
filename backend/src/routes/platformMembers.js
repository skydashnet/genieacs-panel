import express from 'express';
import PlatformMemberController from '../controllers/platformMemberController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';

/**
 * Who works for which provider, from the control plane.
 *
 * Mounted at `/api/platform`, alongside the router that mints and suspends
 * providers, and only where `EDITION=saas`: on a self-hosted install these
 * paths do not answer 403, they do not exist, because a 403 tells whoever asked
 * that a control plane is there.
 *
 * Two guards, in this order and never one without the other.
 * `authenticateToken` establishes WHO is asking — and, as a side effect, opens
 * the scope of the provider that caller's own session belongs to, which is not
 * the provider these routes act on; the controller takes that from the path.
 * `requirePlatformAdmin` then establishes that they are above providers rather
 * than inside one. A provider's own administrator passes the first and must
 * fail the second: reaching into another ISP's staff list is exactly the power
 * this plane exists to keep away from them.
 */
const router = express.Router();

router.get(
  '/tenants/:id/members',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.list
);

router.post(
  '/tenants/:id/members',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.add
);

/**
 * Criar a conta direto, para um provedor administrado — com link de primeira
 * senha ou com a senha digitada por quem opera o console. As três portas desta
 * tela e a diferença entre elas estão no controlador.
 */
router.post(
  '/tenants/:id/operators',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.createOperator
);

/**
 * Convidar quem ainda NÃO tem login. É o par da rota acima, e a razão de ele
 * existir está no controlador: sem ele, um provedor recém-criado não tinha
 * caminho nenhum para a primeira conta.
 */
router.post(
  '/tenants/:id/invites',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.invite
);

// Mexer numa conta da equipe: os dados (login, e-mail, telefone, papel), um
// link novo de definir senha, a senha na hora e o fim das sessões. Todas pelo
// provedor da URL, e 404 para quem não trabalha nele.
router.patch(
  '/tenants/:id/members/:userId',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.update
);
router.post(
  '/tenants/:id/members/:userId/password-link',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.passwordLink
);
router.post(
  '/tenants/:id/members/:userId/password',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.setPassword
);
router.post(
  '/tenants/:id/members/:userId/sessions/revoke',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.revokeSessions
);

router.delete(
  '/tenants/:id/members/:userId',
  authenticateToken,
  requirePlatformAdmin,
  PlatformMemberController.remove
);

export default router;
