import express from 'express';
import WhatsAppController from '../controllers/whatsappController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { whatsappTestLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// A instância e o servidor Evolution são `whatsapp.config`: mudar por onde o
// provedor fala é decisão de quem administra. O que responde "está
// funcionando?" — a lista de números, o estado de um deles, a saúde da fila — é
// `whatsapp.read`, porque é a primeira coisa que o plantão olha quando o
// atendimento para, e mandar procurar um administrador às três da manhã para
// descobrir que a instância caiu não é política de acesso, é atraso.
router.get('/config', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.getConfig);
router.put('/config', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.updateConfig);
// A aba Chatbot: o que o atendimento automático diz e quando.
router.get('/bot-config', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.getBotConfig);
router.put('/bot-config', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.updateBotConfig);
router.post('/bot-config/ai-test', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.testBotAi);
router.post('/bot-config/ai-improve-message', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.improveBotMessage);
// O relatório do bot é leitura de quem atende, não de quem configura.
router.get('/bot-report', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getBotReport);
// A pesquisa de satisfação: leitura de quem atende, como o relatório do bot.
router.get('/response-time-report', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getResponseTimeReport);
router.get('/satisfaction-report', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getSatisfactionReport);
router.get('/accounts', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.listAccounts);

// O diagnóstico da configuração, e a única rota deste roteador com limitador.
//
// `whatsapp.config` pelo mesmo motivo que a sonda por conta: ela FAZ o painel
// emitir requisições para endereços que quem administra escolheu, e o resultado
// revela estado do servidor. `POST` e não `GET` porque age e escreve na trilha.
// O precedente é o vizinho na mesma tela, `POST /api/sgp/test`.
router.post('/test', authenticateToken, requirePermission('whatsapp.config'), whatsappTestLimiter, WhatsAppController.testConfig);

// The one read that answers "is this working?". A screen polls it, so it is
// declared with the other reads and stays as cheap as they are.
router.get('/health', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getHealth);
router.post('/accounts', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.createAccount);

// Declared before the `:id` routes so the matcher can never read
// `check-number` as an account id.
router.post('/accounts/check-number', authenticateToken, requirePermission('whatsapp.send'), WhatsAppController.checkNumbers);

router.get('/accounts/:id/qr', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.getQr);
// Modelos aprovados da Meta (número oficial): buscar na Meta é configuração;
// listar serve a quem responde fora da janela de 24 h.
router.post('/accounts/:id/templates/sync', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.syncMetaTemplates);
// Token da Meta vencido ou revogado: a instância é recriada no servidor com o
// mesmo nome e o mesmo webhook, só com o token novo.
router.post('/accounts/:id/meta-token', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.updateMetaToken);
// O webhook da conta WABA, registrado de novo na Meta pelo painel. Mesma
// permissão da troca de token: mexe na configuração do número na Meta.
router.post('/accounts/:id/meta-webhook', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.registerMetaWebhook);
// Criar pede a mesma permissão da sincronização: o modelo vai para a conta
// WABA do número (custo por categoria, nota de qualidade, revisão da Meta) —
// é configuração do número, não campanha.
router.post('/accounts/:id/templates', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.createMetaTemplate);
router.get('/meta-templates', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.listMetaTemplates);
router.get('/accounts/:id/status', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.getStatus);
router.post('/accounts/:id/restart', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.restartAccount);
// Conferir é leitura e pede `whatsapp.read`; reescrever muda o servidor e pede
// `whatsapp.config`. Quem está de plantão descobre a causa sem ter a permissão
// que também cria e apaga número.
router.get('/accounts/:id/webhook', authenticateToken, requirePermission('whatsapp.read'), WhatsAppController.checkWebhook);
router.post('/accounts/:id/webhook', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.reapplyWebhook);
// A volta completa. `whatsapp.config` porque ela FAZ o painel emitir uma
// requisição para um endereço que quem administra escolheu — a mesma permissão
// que já decide para qual servidor Evolution o painel fala.
router.post('/accounts/:id/webhook/probe', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.probeWebhook);
router.post('/accounts/:id/disconnect', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.disconnectAccount);
router.patch('/accounts/:id', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.updateAccount);
router.delete('/accounts/:id', authenticateToken, requirePermission('whatsapp.config'), WhatsAppController.deleteAccount);

export default router;
