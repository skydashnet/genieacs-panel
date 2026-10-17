import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import PlatformController from '../controllers/platformController.js';
import PlatformGenieAcsController from '../controllers/platformGenieAcsController.js';
import { authenticateToken, requirePlatformAdmin } from '../middleware/auth.js';
import { platformExportLimiter } from '../middleware/rateLimit.js';

/**
 * The SaaS control plane.
 *
 * Every route here is guarded twice over, and the two guards answer different
 * questions. `authenticateToken` asks who is signed in and at which provider;
 * `requirePlatformAdmin` asks whether that person is on the platform roster at
 * all — a plane ABOVE any provider, because minting a provider and reaching
 * between providers is precisely what a provider's own administrator must not
 * be able to do, however senior they are inside their own ISP.
 *
 * `platform_admins` is created empty and no migration promotes anybody, so on a
 * deployment where nobody has been granted the role these routes exist and
 * refuse everyone. That is the safe side of failing.
 *
 * O DELETE existe desde a onda 22 e exige quatro coisas ao mesmo tempo — ver
 * o comentário no controlador, que explica por que a decisão anterior de não
 * ter DELETE continua correta na forma como ela foi tomada.
 *
 * O PATCH de `/tenants/:id` carrega DUAS intenções — a chave de ciclo de vida
 * (`status`) e a correção do cadastro (`name`, `slug`) —, e recusa as duas no
 * mesmo corpo. O porquê está no despachante, em `PlatformController.update`.
 */
const router = express.Router();

/**
 * Passes a scraper carrying `METRICS_TOKEN`; sends everybody else through the
 * console's two guards. The token is compared in constant time and read per
 * request, so rotating it is editing the environment and restarting. Unset,
 * only a platform administrator's session reads the counters.
 */
function allowMetricsScraper(req, res, next) {
  const expected = String(process.env.METRICS_TOKEN || '');
  const offered = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] ?? '';
  if (expected.length >= 32 && offered.length === expected.length
    && timingSafeEqual(Buffer.from(offered), Buffer.from(expected))) {
    return next();
  }
  return authenticateToken(req, res, (error) => {
    if (error) return next(error);
    return requirePlatformAdmin(req, res, next);
  });
}

router.get('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.listTenants);
router.post('/tenants', authenticateToken, requirePlatformAdmin, PlatformController.create);
router.patch('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.update);
router.delete('/tenants/:id', authenticateToken, requirePlatformAdmin, PlatformController.remove);

// O que o processo contou desde que subiu, no formato que o Prometheus lê,
// com `tenant_id` em toda série. Contagem por provedor é a lista de clientes
// com o tamanho de cada um, então fica atrás do mesmo guarda que o resto do
// console — ou de `METRICS_TOKEN`, que é como um coletor entra: um coletor
// não tem sessão, e um JWT de uma hora não é coisa que se cole num scrape.
// Olhar o painel de um cliente. O que a rota devolve é um bilhete de uso
// único e um endereço, nunca uma sessão — ver o controlador.
router.post('/tenants/:id/impersonate', authenticateToken, requirePlatformAdmin, PlatformController.impersonate);

// O cadastro de um provedor num arquivo, daqui de cima.
//
// A do provedor (`GET /api/tenant/export`) continua sendo a porta dele. Esta
// existe para o estado em que aquela não alcança: suspenso, o host inteiro do
// provedor responde 404 — e a exclusão exige suspender antes. Sem esta rota, a
// janela para o ISP levar os próprios dados fechava antes de a exclusão ser
// permitida.
//
// Com limitador próprio, ao contrário do resto deste arquivo: uma chamada lê
// toda tabela escopada de um provedor, e é a leitura mais cara do painel.
router.get('/tenants/:id/export', authenticateToken, requirePlatformAdmin, platformExportLimiter, PlatformController.exportTenant);

// O GenieACS de cada provedor. Na SaaS é a plataforma quem hospeda o ACS, então
// é daqui — e não da tela de Configuração do provedor — que se diz para onde o
// painel dele fala. Ver `config/platformManaged.js`.
router.get('/tenants/:id/genieacs', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.get);
router.put('/tenants/:id/genieacs', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.update);
router.post('/tenants/:id/genieacs/test', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.test);
router.post('/tenants/:id/genieacs/tag-devices', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.tagDevices);
// Os firmwares SEM dono de um GenieACS compartilhado: listar, reenviar um como
// do provedor (corpo cru, lido pelo parser reservado em `app.js`) e apagar o
// antigo. Fora do escopo do provedor, que é o que os esconde.
router.get('/tenants/:id/genieacs/firmware/unowned', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.listUnownedFirmware);
router.post('/tenants/:id/genieacs/firmware/reassign', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.reassignFirmware);
router.delete('/tenants/:id/genieacs/firmware/unowned/:name', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.deleteUnownedFirmware);
// A chave do agente do GenieACS (modo `agent`). Mostrada uma vez, na resposta.
router.post('/tenants/:id/genieacs/agent-token', authenticateToken, requirePlatformAdmin, PlatformGenieAcsController.agentToken);

router.get('/metrics', allowMetricsScraper, PlatformController.metrics);

// Os fatos do deploy: edição, dialeto do banco, endereços, e o que está ou não
// configurado. Só leitura, e configurado sim/não em vez do valor — ver o
// controlador. Atrás dos dois guardas como o resto: não é segredo, mas é o
// inventário do deploy, e inventário é meio caminho de um reconhecimento.
router.get('/deployment', authenticateToken, requirePlatformAdmin, PlatformController.deployment);

// De onde o próximo provedor herda o catálogo de equipamentos, e quem hoje não
// tem nenhum. A leitura é só leitura: editar o catálogo padrão é editar o da CAIXA da
// plataforma, nas telas de Configuração que já existem — a mesma decisão que a
// Parte 1 tomou para o WhatsApp, e pelo mesmo motivo.
router.get('/catalogue', authenticateToken, requirePlatformAdmin, PlatformController.catalogue);
// Reenvia o catálogo da caixa aos provedores: insere o que falta e, só quando
// pedido, sobrescreve o que tem o mesmo nome. Nunca apaga.
router.post('/catalogue/propagate', authenticateToken, requirePlatformAdmin, PlatformController.propagateCatalogue);

// A trilha do plano de controle. Só leitura, como a do provedor e pelo mesmo
// motivo: se desse para apagar uma linha, a primeira coisa a fazer depois de
// apagar um provedor seria apagar o registro disso.
router.get('/audit', authenticateToken, requirePlatformAdmin, PlatformController.listAudit);

export default router;
