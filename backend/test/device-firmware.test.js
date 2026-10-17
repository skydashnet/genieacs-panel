import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const {
  FIRMWARE_FILE_TYPE, compatibleFirmware, currentFirmwareVersion, isInstalledVersion
} = await import('../src/services/firmwareFiles.js');

/**
 * Firmware pelo painel, com os arquivos que já estão no GenieACS.
 *
 * O que estes casos defendem é o que não tem volta: um firmware de outro
 * modelo pode deixar a ONT sem subir. A lista só mostra o que é do modelo
 * dela, e o servidor confere de novo na hora de mandar — a tela pode estar
 * velha e a API é chamada por quem não usa a tela.
 */
const DEVICE_ID = 'ONT-FW-1';

const arquivo = (id, { fileType = FIRMWARE_FILE_TYPE, oui = 'ZTEOUI', productClass = 'F670L', version = 'V2.0', uploadDate = '2026-09-01T00:00:00.000Z' } = {}) => ({
  _id: id,
  length: 12_345_678,
  uploadDate,
  metadata: { fileType, oui, productClass, version }
});

let panelUrl;
let token;
let genie;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const device = buildDevice({ id: DEVICE_ID });
  device._deviceId._OUI = 'ZTEOUI';
  genie = await startGenieAcsStub({ devices: [device] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

beforeEach(() => {
  genie.state.respond = null;
  genie.state.taskStatus = 200;
  genie.state.tasks.length = 0;
  genie.state.files = [
    arquivo('f670l-v2.bin', { version: 'V2.0', uploadDate: '2026-09-10T00:00:00.000Z' }),
    arquivo('f670l-v1.bin', { version: 'V1.0.0', uploadDate: '2026-08-01T00:00:00.000Z' }),
    arquivo('f670l-sem-oui.bin', { oui: '', version: 'V2.1', uploadDate: '2026-09-20T00:00:00.000Z' }),
    arquivo('outro-modelo.bin', { productClass: 'F680' }),
    arquivo('outro-fabricante.bin', { oui: 'HWTC' }),
    arquivo('sem-modelo.bin', { productClass: '' }),
    arquivo('config.xml', { fileType: '3 Vendor Configuration File' })
  ];
});

const post = (path, body) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });
const get = (path) => call(`${panelUrl}${path}`, { headers: authHeaders(token) });
const linhas = () => getDb()('audit_log').where({ action: AuditLog.ACTIONS.DEVICE_FIRMWARE_UPGRADE }).orderBy('id', 'asc');
const downloads = () => genie.state.tasks.filter((entry) => entry.task?.name === 'download');

describe('quais firmwares servem, sem rede', () => {
  it('o mesmo modelo, e o mesmo fabricante quando o arquivo diz um', () => {
    const { compatible, otherModels } = compatibleFirmware([
      arquivo('a', { oui: 'zteoui', productClass: ' f670l ' }),
      arquivo('b', { oui: '' }),
      arquivo('c', { productClass: 'F680' }),
      arquivo('d', { oui: 'HWTC' }),
      arquivo('e', { productClass: '' }),
      arquivo('f', { fileType: '3 Vendor Configuration File' })
    ], { oui: 'ZTEOUI', productClass: 'F670L' });
    assert.deepEqual(compatible.map((file) => file.id).sort(), ['a', 'b']);
    // O arquivo de configuração não é firmware: nem entra na conta.
    assert.equal(otherModels, 3);
  });

  it('ONT sem modelo conhecido não recebe firmware nenhum', () => {
    const { compatible } = compatibleFirmware([arquivo('a')], { oui: 'ZTEOUI', productClass: '' });
    assert.deepEqual(compatible, []);
  });

  it('arquivo que exige fabricante não serve à ONT que não diz o dela', () => {
    const { compatible } = compatibleFirmware([arquivo('a')], { oui: null, productClass: 'F670L' });
    assert.deepEqual(compatible, []);
  });

  it('a versão atual vem de qualquer um dos dois modelos de dados', () => {
    assert.equal(currentFirmwareVersion({ InternetGatewayDevice: { DeviceInfo: { SoftwareVersion: { _value: 'V1.0.0' } } } }), 'V1.0.0');
    assert.equal(currentFirmwareVersion({ Device: { DeviceInfo: { SoftwareVersion: { _value: 'R5' } } } }), 'R5');
    assert.equal(currentFirmwareVersion({}), null);
    assert.equal(isInstalledVersion({ version: 'v1.0.0' }, 'V1.0.0'), true);
    assert.equal(isInstalledVersion({ version: null }, 'V1.0.0'), false);
  });
});

describe('a lista na ficha do aparelho', () => {
  it('só os do modelo da ONT, o mais novo primeiro, com a versão atual marcada', async () => {
    const { status, body } = await get(`/api/devices/firmware?deviceId=${DEVICE_ID}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.current, 'V1.0.0');
    assert.deepEqual(body.data.files.map((file) => file.id), ['f670l-sem-oui.bin', 'f670l-v2.bin', 'f670l-v1.bin']);
    assert.deepEqual(body.data.files.map((file) => file.installed), [false, false, true]);
    assert.equal(body.data.otherModels, 3);
  });

  it('aparelho que o ACS não conhece: 404', async () => {
    const { status } = await get('/api/devices/firmware?deviceId=NAO-EXISTE');
    assert.equal(status, 404);
  });
});

describe('trocar o firmware', () => {
  it('manda o download do arquivo escolhido, com linha dizendo de qual versão para qual', async () => {
    const antes = (await linhas()).length;
    const { status, body } = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId: 'f670l-v2.bin' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.queued, false);
    assert.deepEqual(downloads().map((entry) => [entry.deviceId, entry.task.file]), [[DEVICE_ID, 'f670l-v2.bin']]);

    const depois = await linhas();
    assert.equal(depois.length, antes + 1);
    assert.equal(depois.at(-1).subject_id, DEVICE_ID);
    assert.deepEqual(JSON.parse(depois.at(-1).detail), { file: 'f670l-v2.bin', from: 'V1.0.0', to: 'V2.0' });
  });

  it('arquivo de outro modelo, de outro fabricante, sem modelo ou inexistente: 400, nada sai', async () => {
    const antes = (await linhas()).length;
    for (const fileId of ['outro-modelo.bin', 'outro-fabricante.bin', 'sem-modelo.bin', 'config.xml', 'nao-existe.bin', '', undefined]) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId });
      assert.equal(status, 400, `aceitou ${JSON.stringify(fileId)}`);
      assert.equal(body.code, 'firmware_not_compatible');
    }
    assert.equal(downloads().length, 0);
    assert.equal((await linhas()).length, antes);
  });

  it('a versão que a ONT já roda é recusada: só a derrubaria à toa', async () => {
    const { status, body } = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId: 'f670l-v1.bin' });
    assert.equal(status, 400);
    assert.equal(body.code, 'firmware_already_installed');
    assert.equal(downloads().length, 0);
  });

  it('com a ONT fora do ar o pedido fica na fila, e a resposta diz isso', async () => {
    genie.state.taskStatus = 202;
    const { status, body } = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId: 'f670l-v2.bin' });
    assert.equal(status, 200);
    assert.equal(body.data.queued, true);
  });
});
