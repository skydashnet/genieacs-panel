import express from 'express';
import InviteController from '../controllers/inviteController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { inviteAcceptLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// ── A equipe convidando ─────────────────────────────────────────────────
// As mesmas capacidades da tela de operadores, porque é a mesma decisão: um
// convite É um vínculo, adiado. Dar-lhe capacidade própria só convidaria alguém
// a conceder "só os convites" a quem não pode mexer na equipe — o que é a mesma
// coisa com um clique a mais.
router.get('/', authenticateToken, requirePermission('operators.read'), InviteController.list);
router.post('/', authenticateToken, requirePermission('operators.manage'), InviteController.create);
router.delete('/:id', authenticateToken, requirePermission('operators.manage'), InviteController.revoke);

// ── Quem foi convidado ──────────────────────────────────────────────────
// Sem sessão, de propósito: quem abre o link ainda não tem conta neste
// provedor, e exigir login para ver o convite seria exigir o que o convite
// existe para dar. O que vem antes de `token` no caminho é o que mantém estas
// duas fora do alcance de `/:id` acima — um `:id` que casasse com um token
// levaria uma revogação a ser lida como consulta.
//
// Limitadas por IP e mais apertado que o balde geral da API: o token são 32
// bytes, então adivinhar é impossível, mas um endpoint sem sessão que consulta
// o banco a cada chamada é bomba de tráfego se ninguém o segurar.
//
// O token vai no CORPO, o que faz a consulta ser POST apesar de não mudar
// nada: é o preço de não deixar a credencial no caminho, que o `requestLogger`
// grava inteiro. Ver `usableInvite` para o resto do motivo.
router.post('/token/preview', inviteAcceptLimiter, InviteController.preview);
router.post('/token/accept', inviteAcceptLimiter, InviteController.accept);

export default router;
