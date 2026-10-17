import express from 'express';
import DeviceController from '../controllers/deviceController.js';
import { authenticateToken, requirePermission } from '../middleware/auth.js';
import { deviceDeleteLimiter, deviceDiagnosticLimiter, factoryResetLimiter, portalPasswordAdminLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

router.get('/', authenticateToken, requirePermission('devices.list'), DeviceController.getDevices);
router.get('/dashboard', authenticateToken, requirePermission('devices.list'), DeviceController.getDashboard);
router.get('/faults', authenticateToken, requirePermission('devices.list'), DeviceController.getFaults);
// O recorte da lista numa planilha. Capacidade própria, só do dono e do admin:
// levar a base toda de uma vez não é o mesmo que ver página por página. Acima
// de `/:deviceId`, para `export` não ser lido como id de aparelho.
router.get('/export', authenticateToken, requirePermission('devices.export'), DeviceController.exportDevices);
router.delete('/faults/:faultId', authenticateToken, requirePermission('devices.write'), DeviceController.deleteFault);
// Above the bare `/:deviceId` route, so `/swaps` is not read as a device id.
router.get('/swaps', authenticateToken, requirePermission('devices.inspect'), DeviceController.getSwaps);
router.post('/swaps/:id/acknowledge', authenticateToken, requirePermission('devices.write'), DeviceController.acknowledgeSwap);
// The device id travels in the query, not the path: GenieACS ids are not rows
// of this panel, and route-coverage.test.js keeps id-addressed routes from
// growing. Above `/:deviceId`, so `parameters` is not read as a device id.
// Firmware: os arquivos do GenieACS que servem para esta ONT, e a troca.
// `devices.maintain`: a ONT grava e reinicia, e um firmware errado não tem
// volta pelo painel. O aparelho vai na query e no corpo, como nas vizinhas.
// Todos os firmwares que dizem o modelo: a lista do lote, onde as ONTs
// marcadas podem ser de modelos diferentes.
router.get('/firmware/files', authenticateToken, requirePermission('devices.maintain'), DeviceController.listFirmwareCatalog);
// Enviar e apagar um firmware no GenieACS. O corpo do envio é o arquivo cru,
// lido pelo parser reservado em `app.js` (limite e guardas lá, repetidas aqui).
// O nome no `DELETE` é o `id` da lista — com o prefixo do dono num ACS
// compartilhado — e vai na query (`?name=`), como o id do aparelho nas
// vizinhas: é arquivo do GenieACS, não linha deste painel, e
// route-coverage.test.js não deixa crescer a lista de rotas por parâmetro.
router.post('/firmware/files', authenticateToken, requirePermission('devices.maintain'), DeviceController.uploadFirmwareFile);
router.delete('/firmware/files', authenticateToken, requirePermission('devices.maintain'), DeviceController.deleteFirmwareFile);
router.get('/firmware', authenticateToken, requirePermission('devices.maintain'), DeviceController.listFirmware);
router.post('/firmware/upgrade', authenticateToken, requirePermission('devices.maintain'), DeviceController.upgradeFirmware);
router.get('/parameters', authenticateToken, requirePermission('devices.inspect'), DeviceController.getDeviceParameters);
// Above the bare `/:deviceId` route, like the other device sub-paths.
router.get('/:deviceId/history', authenticateToken, requirePermission('devices.list'), DeviceController.getHistory);
router.get('/:deviceId/swaps', authenticateToken, requirePermission('devices.inspect'), DeviceController.getDeviceSwaps);
router.get('/:deviceId/portal-password', authenticateToken, requirePermission('customers.secrets'), portalPasswordAdminLimiter, DeviceController.getPortalPassword);
router.post('/:deviceId/portal-password/reset', authenticateToken, requirePermission('customers.secrets'), portalPasswordAdminLimiter, DeviceController.resetPortalPassword);
router.get('/:deviceId', authenticateToken, requirePermission('devices.inspect'), DeviceController.getDeviceDetail);
router.delete('/:deviceId', authenticateToken, requirePermission('devices.maintain'), deviceDeleteLimiter, DeviceController.deleteDevice);
router.post('/reboot', authenticateToken, requirePermission('devices.write'), DeviceController.rebootDevice);
// O aparelho vai no corpo, como no reiniciar: o id é do GenieACS, e a varredura
// de ids do painel não o alcança (ver `route-coverage.test.js`).
router.post('/factory-reset', authenticateToken, requirePermission('devices.maintain'), factoryResetLimiter, DeviceController.factoryResetDevice);
// Ping e traceroute pela ONT. `devices.write` e não `devices.maintain`: é o
// trabalho diário do plantão e não muda a configuração do cliente. O segundo
// é um POST porque pode pedir à ONT o resultado — não é só leitura. O limite
// segura a tela esquecida aberta consultando.
router.post('/diagnostics', authenticateToken, requirePermission('devices.write'), deviceDiagnosticLimiter, DeviceController.startDiagnostic);
router.post('/diagnostics/result', authenticateToken, requirePermission('devices.write'), deviceDiagnosticLimiter, DeviceController.readDiagnostic);
// Uma ação em vários aparelhos de uma vez, com os ids no corpo (até 200).
// `devices.maintain`: um clique alcança muitos assinantes.
router.post('/batch', authenticateToken, requirePermission('devices.maintain'), DeviceController.runBatch);
router.post('/summon', authenticateToken, requirePermission('devices.write'), DeviceController.summonDevice);
router.post('/:id/update-wan', authenticateToken, requirePermission('devices.write'), DeviceController.updateWanConfig);
router.post('/:id/add-wan', authenticateToken, requirePermission('devices.write'), DeviceController.addWanConnection);
router.put('/:id/installation-date', authenticateToken, requirePermission('devices.write'), DeviceController.updateInstallationDate);
router.post('/:id/update-wifi', authenticateToken, requirePermission('devices.write'), DeviceController.updateWifiConfig);
router.post('/:id/update-credentials', authenticateToken, requirePermission('devices.write'), DeviceController.updateCredentials);

export default router;
