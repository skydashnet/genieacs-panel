import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Enviar e apagar firmware no GenieACS pelo painel, e os arquivos sem dono.
 *
 * Num GenieACS que vários provedores usam, o dono do arquivo vai no nome
 * (`<tag>--<nome>`). Quem põe o prefixo é o SERVIDOR, com a tag do provedor
 * em escopo: o provedor manda só o nome do arquivo, não escolhe de quem ele é,
 * e só apaga o que é dele. A plataforma lista os arquivos sem dono (os de
 * antes da regra), reenvia um como de um provedor e apaga o antigo.
 *
 * Teto do arquivo pequeno de propósito (`FIRMWARE_MAX_MB`), para o 413 sair
 * sem mandar 64 MB num teste.
 */
process.env.EDITION = 'saas';
process.env.FIRMWARE_MAX_MB = '0.01';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const {
  DirectConnector, UNASSIGNED_SCOPE_TAG, forgetSharedAcs
} = await import('../src/services/genieacs/direct.js').then((m) => ({ ...m, DirectConnector: m.default }));
const { FIRMWARE_FILE_TYPE } = await import('../src/services/firmwareFiles.js');

// A guarda de egresso da SaaS recusa loopback, e o ACS de mentira mora nele;
// o que está em jogo aqui é o escopo, não a guarda (que tem os testes dela).
const egressoReal = GenieAcsEgress.fetch;
GenieAcsEgress.fetch = (url, options) => fetch(url, options);

const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };
const LIMITE = Math.floor(0.01 * 1024 * 1024);

let panelUrl;
let genie;
let outroAcs;
let token;
let alfa;
let beta;

const arquivo = (id, { length = 8, productClass = 'F670L', version = 'V1.0', oui = 'ZTEOUI' } = {}) => ({
  _id: id,
  length,
  uploadDate: '2026-09-01T00:00:00.000Z',
  metadata: { fileType: FIRMWARE_FILE_TYPE, oui, productClass, version }
});

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** Um pedido com o arquivo cru no corpo. */
async function enviar(path, bytes, headers = {}) {
  const response = await fetch(`${panelUrl}/api${path}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream', ...headers },
    body: bytes
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

const enviarFirmware = (bytes, { nome = 'F670L_V3.bin', modelo = 'F670L', oui = 'ZTEOUI', versao = 'V3.0' } = {}) => enviar(
  '/devices/firmware/files',
  bytes,
  {
    ...(nome !== null ? { 'X-File-Name': encodeURIComponent(nome) } : {}),
    ...(modelo !== null ? { 'X-Fw-Product-Class': encodeURIComponent(modelo) } : {}),
    'X-Fw-Oui': encodeURIComponent(oui),
    'X-Fw-Version': encodeURIComponent(versao)
  }
);

const definirTag = (tenantId, tag) => runInTenant(tenantId, () => Setting.upsert('deviceScopeTag', tag));
const ids = () => genie.state.files.map((file) => file._id).sort();
const puts = () => genie.state.requests.filter((r) => r.method === 'PUT');

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [] });
  outroAcs = await startGenieAcsStub({ devices: [] });
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  const userId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: userId }).first())) {
    await getDb()('platform_admins').insert({ user_id: userId });
  }
  const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
  assert.equal(criado.status, 201);
  beta = criado.body.data.tenant.id;
});

after(async () => {
  GenieAcsEgress.fetch = egressoReal;
  await genie.close();
  await outroAcs.close();
  await stopTestServers();
});

beforeEach(async () => {
  // Os dois no MESMO ACS, cada um com a sua tag.
  await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', genie.url));
  await runInTenant(beta, () => Setting.upsert('genieAcsUrl', genie.url));
  await definirTag(alfa, 'alfa');
  await definirTag(beta, 'beta');
  forgetSharedAcs();
  genie.state.requests.length = 0;
  genie.state.uploads = [];
  genie.state.files = [
    arquivo('alfa--F670L_V2.bin'),
    arquivo('beta--F670L_V2.bin'),
    arquivo('antigo.bin', { length: 5, productClass: 'HG8245', version: 'V5', oui: 'HWOUI' })
  ];
});

describe('ACS compartilhado: o provedor envia', () => {
  it('o servidor põe o prefixo da tag, com os metadados nos cabeçalhos da NBI', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 128, 10]);
    const { status, body } = await enviarFirmware(bytes);
    assert.equal(status, 201, JSON.stringify(body));
    assert.deepEqual(
      { id: body.data.id, size: body.data.size, productClass: body.data.productClass, version: body.data.version, oui: body.data.oui },
      { id: 'alfa--F670L_V3.bin', size: 6, productClass: 'F670L', version: 'V3.0', oui: 'ZTEOUI' }
    );
    const [put] = puts();
    assert.equal(put.path, '/files/alfa--F670L_V3.bin');
    assert.equal(put.headers.filetype, FIRMWARE_FILE_TYPE);
    assert.equal(put.headers.productclass, 'F670L');
    assert.equal(put.headers.oui, 'ZTEOUI');
    assert.equal(put.headers.version, 'V3.0');
    assert.ok(put.bytes.equals(bytes), 'o GenieACS recebeu bytes diferentes');

    // Aparece na lista do provedor; o outro não o vê.
    const lista = await api('/devices/firmware/files');
    assert.ok(lista.body.data.files.some((file) => file.id === 'alfa--F670L_V3.bin'));

    const trilha = await runInTenant(alfa, () => getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'device.firmware_upload' }).first());
    assert.ok(trilha, 'o envio não entrou na trilha');
    assert.equal(trilha.subject_id, 'alfa--F670L_V3.bin');
  });

  it('recusa nome com prefixo de dono (de outra tag ou da própria) e nome torto, sem tocar a NBI', async () => {
    for (const nome of ['beta--fw.bin', 'alfa--fw.bin', '../fw.bin', 'a/b.bin', '..', '.oculto', 'com espaço.bin', 'x'.repeat(201)]) {
      // eslint-disable-next-line no-await-in-loop -- um por vez
      const { status, body } = await enviarFirmware(Buffer.from('fw'), { nome });
      assert.equal(status, 400, `aceitou ${nome}`);
      assert.equal(body.code, 'firmware_name_invalid', nome);
    }
    assert.equal(puts().length, 0);
  });

  it('409 se o arquivo já existe; 400 sem corpo ou sem modelo; 413 acima do teto', async () => {
    const existe = await enviarFirmware(Buffer.from('fw'), { nome: 'F670L_V2.bin' });
    assert.equal(existe.status, 409, JSON.stringify(existe.body));
    assert.equal(existe.body.code, 'firmware_exists');

    const vazio = await enviarFirmware(Buffer.alloc(0));
    assert.equal(vazio.status, 400, JSON.stringify(vazio.body));
    assert.equal(vazio.body.code, 'firmware_empty');

    const semModelo = await enviarFirmware(Buffer.from('fw'), { modelo: null });
    assert.equal(semModelo.status, 400, JSON.stringify(semModelo.body));
    assert.equal(semModelo.body.code, 'firmware_metadata_invalid');

    const grande = await enviarFirmware(Buffer.alloc(LIMITE + 1, 1));
    assert.equal(grande.status, 413, JSON.stringify(grande.body));
    assert.equal(grande.body.code, 'firmware_too_large');
    assert.equal(puts().length, 0);
  });

  it('sem tag ainda no ACS compartilhado: 409 firmware_scope_unassigned', async () => {
    await definirTag(alfa, '');
    const { status, body } = await enviarFirmware(Buffer.from('fw'));
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, 'firmware_scope_unassigned');
    assert.equal(puts().length, 0);
  });

  it('sem sessão: 401 antes de o corpo ser lido', async () => {
    const response = await fetch(`${panelUrl}/api/devices/firmware/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'fw.bin' },
      body: Buffer.from('fw')
    });
    assert.equal(response.status, 401);
  });
});

describe('ACS compartilhado: o provedor apaga', () => {
  const apagar = (nome) => api(`/devices/firmware/files?name=${encodeURIComponent(nome)}`, { method: 'DELETE' });

  it('o dele, sim', async () => {
    const { status, body } = await apagar('alfa--F670L_V2.bin');
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(ids(), ['antigo.bin', 'beta--F670L_V2.bin']);
    const trilha = await runInTenant(alfa, () => getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'device.firmware_delete' }).first());
    assert.ok(trilha, 'o apagar não entrou na trilha');
  });

  it('o de outro, o sem dono e o que não existe: o mesmo 404, e nada sai', async () => {
    for (const nome of ['beta--F670L_V2.bin', 'antigo.bin', 'alfa--nao-existe.bin', '..', '']) {
      // eslint-disable-next-line no-await-in-loop -- um por vez
      const { status, body } = await apagar(nome);
      assert.equal(status, 404, `apagou ${nome}: ${JSON.stringify(body)}`);
    }
    assert.equal(genie.state.requests.filter((r) => r.method === 'DELETE').length, 0);
    assert.equal(genie.state.files.length, 3);
  });
});

describe('ACS só do provedor', () => {
  beforeEach(async () => {
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', outroAcs.url));
    await definirTag(alfa, '');
    forgetSharedAcs();
  });

  it('envia sem prefixo, e aceita nome com "--"', async () => {
    const um = await enviarFirmware(Buffer.from('fw-1'), { nome: 'F670L_V3.bin' });
    assert.equal(um.status, 201, JSON.stringify(um.body));
    assert.equal(um.body.data.id, 'F670L_V3.bin');
    const dois = await enviarFirmware(Buffer.from('fw-2'), { nome: 'beta--qualquer.bin' });
    assert.equal(dois.status, 201, JSON.stringify(dois.body));
    assert.equal(dois.body.data.id, 'beta--qualquer.bin');
  });

  it('apaga qualquer firmware do ACS', async () => {
    const { status } = await api('/devices/firmware/files?name=antigo.bin', { method: 'DELETE' });
    assert.equal(status, 200);
    assert.ok(!ids().includes('antigo.bin'));
  });
});

describe('a lista passa de 500', () => {
  it('pagina até acabar, e com tag pede ao GenieACS só os do dono', async () => {
    genie.state.files = [];
    for (let i = 0; i < 1203; i += 1) genie.state.files.push(arquivo(`alfa--fw-${String(i).padStart(4, '0')}.bin`));
    for (let i = 0; i < 700; i += 1) genie.state.files.push(arquivo(`beta--fw-${i}.bin`));
    const { status, body } = await api('/devices/firmware/files');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.files.length, 1203);
    assert.ok(body.data.files.every((file) => file.id.startsWith('alfa--')));
    const paginas = genie.state.requests.filter((r) => r.path === '/files');
    assert.deepEqual(paginas.map((r) => new URLSearchParams(r.search).get('skip')), ['0', '500', '1000']);
    assert.ok(paginas.every((r) => decodeURIComponent(r.search).includes('^alfa--')), 'a busca não levou o prefixo do dono');
  });
});

describe('o escopo do conector cobre files/<nome>', () => {
  it('só o arquivo da tag; a tag "sem dono" nada; o nome torto nada', async () => {
    const recusa = (tag, caminho, metodo = 'DELETE') => assert.rejects(
      () => DirectConnector.applyScope(tag, caminho, metodo, {}),
      (error) => error.code === 'firmware_not_found',
      `${tag} ${metodo} ${caminho}`
    );
    await DirectConnector.applyScope('alfa', 'files/alfa--fw.bin', 'DELETE', {});
    await DirectConnector.applyScope('alfa', 'files/alfa--fw.bin', 'PUT', {});
    await recusa('alfa', 'files/beta--fw.bin');
    await recusa('alfa', 'files/beta--fw.bin', 'PUT');
    await recusa('alfa', 'files/fw.bin');
    await recusa('alfa', 'files/alfa_2--fw.bin');
    await recusa('alfa', `files/${encodeURIComponent('alfa--../x')}`);
    await recusa(UNASSIGNED_SCOPE_TAG, `files/${UNASSIGNED_SCOPE_TAG}--fw.bin`);
    await recusa('alfa', 'files', 'POST');
    const lista = await DirectConnector.applyScope('alfa', 'files', 'GET', { query: '{"metadata.fileType":"x"}' });
    assert.deepEqual(JSON.parse(lista.query), { $and: [{ 'metadata.fileType': 'x' }, { _id: { $regex: '^alfa--' } }] });
  });

  it('a plataforma (unscoped) passa', async () => {
    const response = await runInTenant(alfa, () => DirectConnector.request('files/antigo.bin', { method: 'DELETE', unscoped: true }));
    assert.equal(response.status, 200);
  });
});

describe('console: firmware sem dono', () => {
  const base = (id) => `/platform/tenants/${id}/genieacs/firmware`;
  const reenviar = (id, nome, bytes) => enviar(`${base(id)}/reassign`, bytes, { 'X-File-Name': encodeURIComponent(nome) });

  it('lista só os sem prefixo, com a tag do provedor', async () => {
    const { status, body } = await api(`${base(alfa)}/unowned`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.tag, 'alfa');
    assert.equal(body.data.shared, true);
    assert.deepEqual(body.data.files.map((file) => file.id), ['antigo.bin']);
  });

  it('ACS só do provedor: shared false e nada', async () => {
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', outroAcs.url));
    await definirTag(alfa, '');
    forgetSharedAcs();
    const { status, body } = await api(`${base(alfa)}/unowned`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data, { tag: null, shared: false, files: [] });
  });

  it('reenvia como do provedor, com os metadados do antigo — e confere o tamanho', async () => {
    const errado = await reenviar(beta, 'antigo.bin', Buffer.from('1234'));
    assert.equal(errado.status, 400, JSON.stringify(errado.body));
    assert.equal(errado.body.code, 'firmware_size_mismatch');

    const bytes = Buffer.from('12345');
    const { status, body } = await reenviar(beta, 'antigo.bin', bytes);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.id, 'beta--antigo.bin');
    const novo = genie.state.files.find((file) => file._id === 'beta--antigo.bin');
    assert.deepEqual(novo.metadata, { fileType: FIRMWARE_FILE_TYPE, oui: 'HWOUI', productClass: 'HG8245', version: 'V5' });
    assert.ok(genie.state.uploads.at(-1).bytes.equals(bytes));
    assert.ok(ids().includes('antigo.bin'), 'o antigo não pode sumir no reenvio');

    const deNovo = await reenviar(beta, 'antigo.bin', bytes);
    assert.equal(deNovo.status, 409, JSON.stringify(deNovo.body));
    assert.equal(deNovo.body.code, 'firmware_exists');

    const trilha = await getDb()('platform_audit').where({ action: 'tenant.firmware_reassigned' }).first();
    assert.ok(trilha, 'o reenvio não entrou na trilha da plataforma');
  });

  it('não reenvia arquivo que já tem dono, nem o que não existe, nem sem tag', async () => {
    const deOutro = await reenviar(beta, 'alfa--F670L_V2.bin', Buffer.alloc(8));
    assert.equal(deOutro.status, 404, JSON.stringify(deOutro.body));
    const inexistente = await reenviar(beta, 'sumiu.bin', Buffer.alloc(8));
    assert.equal(inexistente.status, 404, JSON.stringify(inexistente.body));
    await definirTag(beta, '');
    const semTag = await reenviar(beta, 'antigo.bin', Buffer.from('12345'));
    assert.equal(semTag.status, 409, JSON.stringify(semTag.body));
    assert.equal(semTag.body.code, 'firmware_scope_unassigned');
    const ninguem = await reenviar(999_999, 'antigo.bin', Buffer.from('12345'));
    assert.equal(ninguem.status, 404);
    assert.equal(puts().length, 0);
  });

  it('apaga o sem dono; o de um provedor é 404', async () => {
    const deProvedor = await api(`${base(alfa)}/unowned/${encodeURIComponent('beta--F670L_V2.bin')}`, { method: 'DELETE' });
    assert.equal(deProvedor.status, 404, JSON.stringify(deProvedor.body));
    const { status, body } = await api(`${base(alfa)}/unowned/antigo.bin`, { method: 'DELETE' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(ids(), ['alfa--F670L_V2.bin', 'beta--F670L_V2.bin']);
    const trilha = await getDb()('platform_audit').where({ action: 'tenant.firmware_deleted' }).first();
    assert.ok(trilha);
  });
});
