import express from 'express';
import { IS_SAAS } from '../config/edition.js';
import AuthController from '../controllers/authController.js';
import { requirePermission, requirePlatformAdmin, authenticateToken } from '../middleware/auth.js';
import {
  authTicketRedeemLimiter,
  emailChangeLimiter,
  impersonationRedeemLimiter,
  mfaLimiter,
  passwordResetLimiter
} from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/setup-status', AuthController.getSetupStatus);

router.post('/setup', AuthController.setupAdmin);
// Um provedor novo se cadastrando sozinho. Só existe na edição SaaS — montado
// atrás de `IS_SAAS` para que, na self-hosted, a rota responda 404 e não 403:
// um 403 diria que há um cadastro para encontrar.
if (IS_SAAS) router.post('/signup', AuthController.signup);

router.post('/login', AuthController.login);

// O bilhete que o console cunhou vira a sessão de leitura, no host do provedor
// e sem sessão anterior — quem personifica não tem conta aqui. O bilhete É a
// credencial, de uso único e válido por um minuto; ver o controlador.
router.post('/impersonate/redeem', impersonationRedeemLimiter, AuthController.redeemImpersonation);

// "Esqueci minha senha", as duas metades. Públicas as duas, e é o que elas
// PRECISAM ser: quem perdeu a senha não tem sessão, e a segunda é aberta do
// celular, onde não há sessão do painel — exigir login para confirmar um link
// mandado por e-mail é ensinar a equipe a digitar a senha depois de clicar num
// link, que é a forma exata de um phishing.
//
// A primeira responde SEMPRE a mesma coisa, exista a conta ou não; ver o
// controlador. A segunda não emite sessão: ela troca a senha e manda para o
// login.
router.post('/password-reset', passwordResetLimiter, AuthController.requestPasswordReset);
router.post('/password-reset/confirm', authTicketRedeemLimiter, AuthController.confirmPasswordReset);

// A prova do endereço. Pedir exige sessão — é o próprio endereço de quem pede;
// confirmar não, pelo mesmo motivo da redefinição.
router.post('/email/verify', emailChangeLimiter, authenticateToken, AuthController.requestEmailVerification);
router.post('/email/verify/confirm', authTicketRedeemLimiter, AuthController.confirmEmailVerification);

router.get('/user', authenticateToken, AuthController.getCurrentUser);

router.post('/logout', authenticateToken, AuthController.logout);

router.post('/refresh', AuthController.refreshToken);

router.post('/change-password', authenticateToken, AuthController.changePassword);

// Login em duas etapas da própria conta. O limite vem DEPOIS da sessão, para
// contar por pessoa: é ele que segura quem tenta adivinhar os 6 dígitos numa
// sessão roubada para desligar o 2FA.
router.get('/mfa', authenticateToken, AuthController.mfaStatus);
router.post('/mfa/setup', authenticateToken, mfaLimiter, AuthController.mfaSetup);
router.post('/mfa/enable', authenticateToken, mfaLimiter, AuthController.mfaEnable);
router.post('/mfa/disable', authenticateToken, mfaLimiter, AuthController.mfaDisable);
router.post('/mfa/recovery-codes', authenticateToken, mfaLimiter, AuthController.mfaRegenerateRecovery);

router.post('/change-username', authenticateToken, AuthController.changeUsername);

// O e-mail de login da própria pessoa: é por aqui que quem já usa o painel
// migra. `authenticateToken` e nada mais — é autoatendimento, e prendê-lo atrás
// de uma capacidade de administração deixaria de fora justamente quem precisa
// (um `tech` sem e-mail não conseguiria cadastrar o seu, e o login por e-mail
// nunca poderia ser exigido).
// Limitado por IP e provedor: o 409 daqui diz se um endereço tem conta em
// algum provedor da plataforma — ver `emailChangeLimiter`.
router.post('/email', emailChangeLimiter, authenticateToken, AuthController.changeEmail);

// Quantas contas ainda estão sem e-mail — o número que diz se dá para virar
// `LOGIN_REQUIRES_EMAIL` sem trancar ninguém do lado de fora.
//
// O número é da plataforma inteira, porque a chave é: uma variável de ambiente
// do processo, não uma configuração por provedor. Então quem pode lê-lo é quem
// pode virá-la. No self-hosted isso é quem administra a equipe; na edição SaaS
// é o plano de controle — um administrador de provedor não decide a chave, e o
// total de contas da plataforma não é dado do provedor dele. Quem ainda falta
// na PRÓPRIA equipe ele vê em `GET /api/users`, que já mostra o e-mail de cada
// membro.
router.get(
  '/email-readiness',
  authenticateToken,
  IS_SAAS ? requirePlatformAdmin : requirePermission('operators.read'),
  AuthController.emailReadiness
);

export default router;