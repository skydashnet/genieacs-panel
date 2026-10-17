import express from 'express';
import TenantController from '../controllers/tenantController.js';
import CancellationController from '../controllers/cancellationController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

/**
 * Unauthenticated on purpose, and the only route in the panel that is
 * unauthenticated by design rather than by necessity: the login screen has to
 * show the provider's name before there is anybody to authenticate.
 *
 * The path is `/public` rather than `/` so that the next thing mounted on this
 * router cannot inherit its openness by accident. A future `GET /api/tenant`
 * returning the provider's real settings would be a one-line addition to this
 * file, and with the open route sitting at `/` there would be nothing in the
 * shape of the code to make its author notice which side of the line they were
 * on. The word `public` in the path is the reminder.
 */
router.get('/public', TenantController.getPublicProfile);

// E do outro lado da linha que o parágrafo acima descreve: tudo que este
// provedor cadastrou, num arquivo. Autenticada e com capacidade própria.
router.get('/export', authenticateToken, requirePermission('tenant.export'), TenantController.exportTenant);

// O plano, o estado da assinatura e o uso contra o limite. Autenticada, e
// com `settings.read` — é o mesmo lado da linha que as configurações: quem
// pode ver a configuração do provedor pode ver em que plano ele está. Fica
// FORA da porta da assinatura (`subscriptionGate.js` a lista), porque é o que
// a tela de bloqueio mostra.
router.get('/subscription', authenticateToken, requirePermission('settings.read'), TenantController.getSubscription);

// As cobranças emitidas a este provedor, com o link de pagamento de cada uma
// que ainda está em aberto. Mesma capacidade e mesmo lado da linha que
// `/subscription`, e também fora da porta da assinatura — quem está bloqueado é
// exatamente quem precisa desta lista.
router.get('/charges', authenticateToken, requirePermission('settings.read'), TenantController.listCharges);

// O catálogo de planos, com preço, e o do provedor marcado. Mesma capacidade
// e mesmo lado da porta da assinatura que `/subscription`: é a tela onde se
// escolhe o plano, e quem está em `past_due` é quem mais precisa dela.
router.get('/plans', authenticateToken, requirePermission('settings.read'), TenantController.listPlans);

// A indicação de provedores (0106): o link de indicação, os indicados e o
// saldo de créditos. Na tela de Plano, com a mesma capacidade dela.
router.get('/referrals', authenticateToken, requirePermission('settings.read'), TenantController.getReferrals);

// O provedor troca de plano, e "pagar agora". Os dois são a conta do
// provedor mudando — `settings.write`, que é de `owner` e `admin`, os mesmos
// que gravam o cadastro fiscal que vai na fatura. Fora da porta da
// assinatura, porque é por eles que um provedor em `past_due` SAI de lá;
// `suspended` e `canceled` são recusados pelo controlador, com 409 e o
// código que a tela lê. Nenhum dos dois lê gateway ou cliente do corpo.
router.put('/subscription/plan', authenticateToken, requirePermission('settings.write'), TenantController.changePlan);
router.post('/charges/pay', authenticateToken, requirePermission('settings.write'), TenantController.payNow);
// O cupom de desconto (0093) que o provedor digita na tela de Plano. Mesma
// capacidade e mesmo lado da porta da assinatura que a troca de plano: um
// desconto é uma das saídas de quem está atrasado.
router.post('/subscription/coupon', authenticateToken, requirePermission('settings.write'), TenantController.applyCoupon);
// O cartão recorrente (0100): ligar/desligar a cobrança automática no cartão
// e esquecer o cartão salvo. Mesma capacidade e mesmo lado da porta da
// assinatura que a troca de plano — quem está atrasado precisa poder trocar
// o cartão recusado por Pix/boleto. O cartão em si nunca passa por aqui.
router.put('/subscription/autopay', authenticateToken, requirePermission('settings.write'), TenantController.setCardAutopay);
router.delete('/subscription/card', authenticateToken, requirePermission('settings.write'), TenantController.removeCard);
// A retenção no cancelamento (0107): o motivo, as ofertas (desconto ou
// pausa), o cancelamento no fim do período e o desfazer. `settings.write` na
// rota e o papel de DONO no controlador — cancelar a empresa não é decisão de
// um admin contratado. Fora da porta da assinatura: quem está atrasado
// também pode querer sair.
router.get('/subscription/cancellation', authenticateToken, requirePermission('settings.write'), CancellationController.status);
router.post('/subscription/cancellation', authenticateToken, requirePermission('settings.write'), CancellationController.request);
router.post('/subscription/cancellation/accept', authenticateToken, requirePermission('settings.write'), CancellationController.accept);
router.post('/subscription/cancellation/confirm', authenticateToken, requirePermission('settings.write'), CancellationController.confirm);
router.delete('/subscription/cancellation', authenticateToken, requirePermission('settings.write'), CancellationController.revert);

// O nome do provedor, escrito por quem administra. É o antigo `appName` das
// configurações, agora na linha do provedor — ver o controlador.
router.patch('/', authenticateToken, requirePermission('settings.write'), TenantController.rename);

// Os dados públicos de um CNPJ, para preencher o cadastro acima. Só lê; pede
// `settings.write` porque só serve a quem vai gravar o cadastro. O número vai
// na query (`?cnpj=`): não endereça linha nenhuma, é só o que se consulta.
router.get('/cnpj', authenticateToken, requirePermission('settings.write'), TenantController.lookupCnpj);

// O endereço de um CEP, para o mesmo cadastro. Também só lê.
router.get('/cep', authenticateToken, requirePermission('settings.write'), TenantController.lookupCep);

// O ponto no mapa de um endereço, para posicionar a sede. Pede `map.write`
// porque o que ele alimenta é o centro do mapa, que é essa permissão que grava.
router.get('/geocode', authenticateToken, requirePermission('map.write'), TenantController.geocode);

// A exigência do login em duas etapas para a equipe. Ler é de quem lê a
// configuração; gravar pede `settings.write` E papel `owner`, conferido no
// controlador — a matriz não tem capacidade só do dono.
router.get('/security', authenticateToken, requirePermission('settings.read'), TenantController.getSecurity);
router.put('/security', authenticateToken, requirePermission('settings.write'), TenantController.updateSecurity);

export default router;
