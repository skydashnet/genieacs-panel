import express from 'express';
import ReferralController from '../controllers/referralController.js';
import WhatsAppBillingController from '../controllers/whatsappBillingController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { whatsappSendLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// Duas guardas, e a linha entre elas é a que separa ver de disparar. Ler a
// lista de inadimplentes ou os modelos é trabalho de plantão; criar campanha,
// mudar modelo ou tirar alguém do não-perturbe decide que centenas de pessoas
// recebem mensagem do provedor, e isso não é ato de plantão.
const leitura = [authenticateToken, requirePermission('campaigns.read')];
const gestao = [authenticateToken, requirePermission('campaigns.manage')];

// ── Templates ──────────────────────────────────────────────────────────
router.get('/templates', ...leitura, WhatsAppBillingController.listTemplates);
// A IA escreve o texto do modelo; só rascunho, e a IA é paga por uso.
router.post('/templates/ai-draft', ...gestao, whatsappSendLimiter, WhatsAppBillingController.draftTemplate);
router.post('/templates', ...gestao, WhatsAppBillingController.createTemplate);
router.put('/templates/:id', ...gestao, WhatsAppBillingController.updateTemplate);
router.delete('/templates/:id', ...gestao, WhatsAppBillingController.deleteTemplate);
// Os avisos automáticos (manutenção, queda, alerta) ligados a modelos da Meta,
// para o número oficial mandar fora da janela de 24 h.
router.get('/meta-notice-bindings', ...leitura, WhatsAppBillingController.getMetaNoticeBindings);
router.put('/meta-notice-bindings', ...gestao, WhatsAppBillingController.saveMetaNoticeBindings);
// Relatório de modelos da Meta enviados por mês, e os preços que o provedor
// paga por categoria (só para a estimativa). Fica no par leitura/gestão das
// campanhas porque é gasto com modelos, e quem dispara modelos — campanha,
// régua de cobrança, avisos — é quem tem `campaigns.*`. Na matriz de papéis
// quem tem `whatsapp.read` tem `campaigns.read`, então a aba de relatórios não
// perde ninguém; mudar o preço é decisão de gestão, como ligar os avisos.
router.get('/meta-usage', ...leitura, WhatsAppBillingController.getMetaUsage);
router.get('/meta-prices', ...leitura, WhatsAppBillingController.getMetaPrices);
router.put('/meta-prices', ...gestao, WhatsAppBillingController.saveMetaPrices);

// ── Do not disturb ─────────────────────────────────────────────────────
router.get('/opt-outs', ...leitura, WhatsAppBillingController.listOptOuts);
router.post('/opt-outs', ...gestao, WhatsAppBillingController.createOptOut);
router.patch('/opt-outs/:id', ...gestao, WhatsAppBillingController.updateOptOut);
router.delete('/opt-outs/:id', ...gestao, WhatsAppBillingController.revokeOptOut);

// ── Billing cadence ────────────────────────────────────────────────────
// Both of these call the provider's SGP once per subscriber, so they are the
// two slowest routes in the panel by design. `campaign` builds a DRAFT and
// returns; it never sends.
router.get('/billing/overdue', ...leitura, WhatsAppBillingController.listOverdue);
router.post('/billing/campaign', ...gestao, WhatsAppBillingController.buildCampaign);

// ── The subscriber's number ────────────────────────────────────────────
// The only way to correct a number outside the database. `{ phone: '' }` is a
// clear, not an empty request: it drops the override and hands the contract
// back to what the ERP last synced.
router.put('/subscribers/:contract/phone', ...gestao, WhatsAppBillingController.setSubscriberPhone);

// ── Automatic billing cadence ─────────────────────────────────────────
// Unlike the manual cadence above, this one SENDS. Saving the steps never
// switches it on: `enabled` is its own request, and it goes to the audit trail.
router.get('/dunning/rule', ...leitura, WhatsAppBillingController.getDunningRule);
router.put('/dunning/rule', ...gestao, WhatsAppBillingController.saveDunningRule);
router.post('/dunning/enabled', ...gestao, WhatsAppBillingController.setDunningEnabled);
router.post('/dunning/starter', ...gestao, WhatsAppBillingController.installDunningStarter);
router.post('/dunning/preview', ...gestao, WhatsAppBillingController.startDunningPreview);
router.get('/dunning/preview', ...leitura, WhatsAppBillingController.getDunningPreview);
router.post('/dunning/run', ...gestao, WhatsAppBillingController.runDunning);
router.get('/dunning/sends', ...leitura, WhatsAppBillingController.listDunningSends);
router.get('/dunning/stats', ...leitura, WhatsAppBillingController.dunningStats);

// ── Campaigns ──────────────────────────────────────────────────────────
router.get('/broadcasts', ...leitura, WhatsAppBillingController.listBroadcasts);
// Campanha de aviso: o público sai do cadastro (situação, plano, bairro,
// cidade, contratos colados). A prévia não grava nada; criar grava um
// rascunho ou uma campanha agendada — nunca envia na hora.
router.get('/broadcasts/audience-options', ...leitura, WhatsAppBillingController.campaignAudienceOptions);
router.post('/broadcasts/preview', ...gestao, WhatsAppBillingController.previewCampaign);
router.post('/broadcasts', ...gestao, WhatsAppBillingController.createCampaign);
router.put('/broadcasts/:id', ...gestao, WhatsAppBillingController.updateCampaign);
router.get('/broadcasts/:id/recipients', ...leitura, WhatsAppBillingController.broadcastRecipients);
router.post('/broadcasts/:id/status', ...gestao, WhatsAppBillingController.setBroadcastStatus);

// ── Indique e ganhe ────────────────────────────────────────────────────
// A lista de quem os clientes indicaram, o estado de cada um e o endereço de
// onde o link abre. A página pública do link mora no portal do assinante.
router.get('/referrals', ...leitura, ReferralController.list);
router.put('/referrals/base-url', ...gestao, ReferralController.setBaseUrl);
router.patch('/referrals/:id', ...gestao, ReferralController.update);

export default router;
