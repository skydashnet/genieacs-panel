import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { DirectConnector } = await import('../src/services/genieacs/connector.js');
const { UNASSIGNED_SCOPE_TAG } = await import('../src/services/genieacs/direct.js');
const {
  FIRMWARE_FILE_TYPE, filesOwnedBy, firmwareOwner
} = await import('../src/services/firmwareFiles.js');

/**
 * Firmware num GenieACS que vários provedores usam.
 *
 * A coleção `files` é uma só para o ACS inteiro. Sem recorte, cada provedor
 * via o nome, a versão e o modelo do firmware que o outro subiu — e podia
 * mandá-lo para as ONTs dele. Com o ACS compartilhado, o provedor só vê e só
 * usa os arquivos com o prefixo da tag dele (`<tag>--nome`); os sem dono, de
 * antes da regra, ficam escondidos de todos.
 *
 * O conector é o de verdade, com a tag de escopo trocada aqui: o que está em
 * jogo é o recorte do serviço, não como a tag é descoberta (isso é de
 * `shared-acs-scope.test.js`).
 */
const DEVICE_ID = 'ONT-FW-ESCOPO';

const arquivo = (id, { productClass = 'F670L', version = 'V2.0', uploadDate = '2026-09-01T00:00:00.000Z' } = {}) => ({
  _id: id,
  length: 1000,
  uploadDate,
  metadata: { fileType: FIRMWARE_FILE_TYPE, oui: 'ZTEOUI', productClass, version }
});

let panelUrl;
let token;
let genie;
let tagDaVez = null;
const scopeTagReal = DirectConnector.scopeTag;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const device = buildDevice({ id: DEVICE_ID, tags: ['alfa'] });
  device._deviceId._OUI = 'ZTEOUI';
  genie = await startGenieAcsStub({ devices: [device] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
  DirectConnector.scopeTag = async () => tagDaVez;
});

after(async () => {
  DirectConnector.scopeTag = scopeTagReal;
  await genie.close();
  await stopTestServers();
});

beforeEach(() => {
  tagDaVez = 'alfa';
  genie.state.tasks.length = 0;
  genie.state.files = [
    arquivo('alfa--f670l-v2.bin', { version: 'V2.0', uploadDate: '2026-09-10T00:00:00.000Z' }),
    arquivo('beta--f670l-v3.bin', { version: 'V3.0', uploadDate: '2026-09-12T00:00:00.000Z' }),
    arquivo('alfa_2--f670l-v4.bin', { version: 'V4.0' }),
    arquivo('f670l-antigo.bin', { version: 'V2.5' }),
    arquivo(`${UNASSIGNED_SCOPE_TAG}--f670l.bin`, { version: 'V2.6' })
  ];
});

afterEach(() => {
  tagDaVez = null;
});

const post = (path, body) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });
const get = (path) => call(`${panelUrl}${path}`, { headers: authHeaders(token) });
const downloads = () => genie.state.tasks.filter((entry) => entry.task?.name === 'download');

describe('o dono do arquivo, sem rede', () => {
  it('é a tag antes do primeiro "--", e só se for uma tag válida', () => {
    assert.equal(firmwareOwner({ _id: 'alfa--fw.bin' }), 'alfa');
    assert.equal(firmwareOwner({ _id: 'alfa_2--fw--x.bin' }), 'alfa_2');
    assert.equal(firmwareOwner({ _id: 'fw.bin' }), null);
    assert.equal(firmwareOwner({ _id: '--fw.bin' }), null);
    assert.equal(firmwareOwner({ _id: 'a b--fw.bin' }), null);
  });

  it('sem escopo, todos; com escopo, só os do dono; a tag "sem dono" não é dona de nada', () => {
    const files = genie.state.files;
    assert.equal(filesOwnedBy(files, null).length, files.length);
    assert.deepEqual(filesOwnedBy(files, 'alfa').map((file) => file._id), ['alfa--f670l-v2.bin']);
    assert.deepEqual(
      filesOwnedBy(files, UNASSIGNED_SCOPE_TAG, { unassignedTag: UNASSIGNED_SCOPE_TAG }),
      []
    );
  });
});

describe('ACS compartilhado: a lista', () => {
  it('a do lote mostra só os do provedor — nem os de outro, nem os sem dono', async () => {
    const { status, body } = await get('/api/devices/firmware/files');
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.files.map((file) => file.id), ['alfa--f670l-v2.bin']);
    const texto = JSON.stringify(body.data);
    assert.ok(!texto.includes('beta--'), 'o arquivo de outro provedor não aparece');
    assert.ok(!texto.includes('V3.0'), 'nem a versão dele');
    assert.ok(!texto.includes('antigo'), 'o arquivo sem dono não aparece');
  });

  it('a da ficha também, e a conta de "outros modelos" não conta os alheios', async () => {
    const { status, body } = await get(`/api/devices/firmware?deviceId=${DEVICE_ID}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.files.map((file) => file.id), ['alfa--f670l-v2.bin']);
    assert.equal(body.data.otherModels, 0);
  });

  it('sem tag ainda no ACS compartilhado: nenhum arquivo, nem o que leva o nome da tag "sem dono"', async () => {
    tagDaVez = UNASSIGNED_SCOPE_TAG;
    const { status, body } = await get('/api/devices/firmware/files');
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.files, []);
  });
});

describe('ACS compartilhado: usar o arquivo', () => {
  it('o de outro provedor ou sem dono é recusado como "não serve", e nada sai', async () => {
    for (const fileId of ['beta--f670l-v3.bin', 'alfa_2--f670l-v4.bin', 'f670l-antigo.bin']) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId });
      assert.equal(status, 400, `aceitou ${fileId}`);
      assert.equal(body.code, 'firmware_not_compatible');
    }
    assert.equal(downloads().length, 0);
  });

  it('no lote também', async () => {
    const { status, body } = await post('/api/devices/batch', {
      action: 'firmware', deviceIds: [DEVICE_ID], fileId: 'beta--f670l-v3.bin'
    });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, 'firmware_not_compatible');
    assert.equal(downloads().length, 0);
  });

  it('o do próprio provedor segue', async () => {
    const { status, body } = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId: 'alfa--f670l-v2.bin' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(downloads().map((entry) => entry.task.file), ['alfa--f670l-v2.bin']);
  });
});

describe('ACS só do provedor', () => {
  it('nada muda: todos os arquivos, com prefixo ou sem', async () => {
    tagDaVez = null;
    const { status, body } = await get('/api/devices/firmware/files');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.files.length, genie.state.files.length);

    const usar = await post('/api/devices/firmware/upgrade', { deviceId: DEVICE_ID, fileId: 'f670l-antigo.bin' });
    assert.equal(usar.status, 200, JSON.stringify(usar.body));
  });
});
