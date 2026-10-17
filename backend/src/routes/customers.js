import express from 'express';
import CustomerController from '../controllers/customerController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

/**
 * O que um assinante pode pedir sobre si, pela mão do provedor.
 *
 * O ISP é o controlador desses dados e nós somos o operador: o pedido do
 * titular chega ao ISP por balcão, telefone ou WhatsApp — não a nós, e não pelo
 * painel. Por isso o botão é do operador do ISP e não do assinante, e por isso
 * a capacidade é própria: quem atende o balcão vê a ficha o dia inteiro
 * (`devices.list`) e não precisa poder baixar a vida de alguém num arquivo.
 */
router.get(
  '/:accountId/export',
  authenticateToken,
  requirePermission('customers.dossier'),
  CustomerController.exportDossier
);

/**
 * E o direito de eliminação, que é a mesma conversa com o sinal trocado.
 *
 * Capacidade SEPARADA da de exportar, apesar de hoje as duas caírem no mesmo
 * conjunto de papéis. O argumento é o de `tenant.export` levado até o fim: duas
 * capacidades com o mesmo dono hoje são um nome a mais; uma capacidade só, no
 * dia em que alguém quiser entregar a tarefa de atender pedidos da LGPD a um
 * líder de suporte, entrega junto o poder de destruir — em silêncio, porque a
 * matriz não teria como dizer outra coisa. Uma delas não tem volta, e é isso
 * que a matriz precisa poder expressar.
 */
router.delete(
  '/:accountId',
  authenticateToken,
  requirePermission('customers.erase'),
  CustomerController.erase
);

export default router;
