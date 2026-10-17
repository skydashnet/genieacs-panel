import express from 'express';
import SettingsController from '../controllers/settingsController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('settings.read'), SettingsController.getAllSettings);

// O endereço de GenieACS que o deploy sugere a ESTE provedor, quando ele
// hospeda uma instância por provedor. `settings.write` e não `settings.read`:
// a resposta só serve a quem pode gravar o campo que ela preenche, e quem não
// pode não tem por que aprender o padrão de endereçamento interno do deploy.
//
// ANTES de `/:key`, que é um parâmetro e engoliria qualquer nome literal posto
// depois dele. É a mesma razão de `/genieacs-auth` estar abaixo e ainda assim
// acima do `/:key`, e o erro aqui nem daria bug visível: cairia em
// `getSettingByKey` procurando uma chave chamada "genieacs-suggestion", que
// não existe — um 404 com a mensagem errada.
router.get('/genieacs-suggestion', authenticateToken, requirePermission('settings.write'), SettingsController.getGenieAcsSuggestion);

// A credencial com que o painel se apresenta à NBI. Leitura em `settings.read`
// porque a resposta não traz o segredo — só o tipo, o usuário e se existe um —
// e quem administra precisa ver o que está configurado sem poder mudá-lo.
//
// ANTES de `/:key`, e não junto de `/test-genieacs` lá embaixo: `/:key` casa
// com qualquer segmento, então declarada depois esta rota nunca seria
// alcançada — o GET responderia "configuração não encontrada" e o PUT tentaria
// gravar uma chave chamada `genieacs-auth`, que a allowlist recusa. Os dois
// erros parecem bug de outra coisa.
router.get('/genieacs-auth', authenticateToken, requirePermission('settings.read'), SettingsController.getGenieAcsAuth);
router.put('/genieacs-auth', authenticateToken, requirePermission('settings.write'), SettingsController.updateGenieAcsAuth);

// Como o painel chega ao GenieACS (direto ou pelo agente) e a chave do agente.
// A leitura em `settings.read`, como a de `/genieacs-auth`: o estado do agente
// (conectado, versão, os 4 últimos caracteres da chave) não é segredo, e quem
// só lê as configurações precisa saber por que a lista de equipamentos parou.
// Mudar o modo e gerar a chave em `settings.write`, a permissão que grava o
// `genieAcsUrl` — é o mesmo assunto. ANTES de `/:key`,
// pela mesma razão das rotas acima — o PUT cairia em `updateSetting` tentando
// gravar uma chave chamada `genieacs-connection`.
router.get('/genieacs-connection', authenticateToken, requirePermission('settings.read'), SettingsController.getGenieAcsConnection);
router.put('/genieacs-connection', authenticateToken, requirePermission('settings.write'), SettingsController.updateGenieAcsConnection);
router.post('/genieacs-connection/agent-token', authenticateToken, requirePermission('settings.write'), SettingsController.generateGenieAcsAgentToken);

// Os primeiros passos do provedor novo. Também ANTES de `/:key`, pela mesma
// razão das rotas acima. Ler é `settings.read`: o checklist só aparece a quem
// administra; marcar "já vi" é `settings.write`, como gravar qualquer ajuste.
router.get('/onboarding', authenticateToken, requirePermission('settings.read'), SettingsController.getOnboardingStatus);
router.post('/onboarding/dismiss', authenticateToken, requirePermission('settings.write'), SettingsController.dismissOnboarding);

// Como está a sincronização de IDs de cliente. Antes de `/:key`, pela mesma
// razão das rotas acima.
router.get('/customer-id-sync', authenticateToken, requirePermission('settings.read'), SettingsController.customerIdSyncStatus);

// O formato da data e o que mais mudar como o painel se desenha para TODA a
// equipe: só sessão, sem `settings.read`. Antes de `/:key`, pela mesma razão
// das rotas acima.
router.get('/display', authenticateToken, SettingsController.getDisplayPreferences);

router.get('/:key', authenticateToken, requirePermission('settings.read'), SettingsController.getSettingByKey);

router.post('/', authenticateToken, requirePermission('settings.write'), SettingsController.createSetting);

router.post('/sync-customer-ids', authenticateToken, requirePermission('settings.write'), SettingsController.syncCustomerIds);

router.put('/:key', authenticateToken, requirePermission('settings.write'), SettingsController.updateSetting);

router.delete('/:key', authenticateToken, requirePermission('settings.write'), SettingsController.deleteSetting);

router.post('/test-genieacs', authenticateToken, requirePermission('settings.write'), SettingsController.testGenieAcsConnection);

export default router;
