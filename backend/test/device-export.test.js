import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { csvCell } = await import('../src/utils/csv.js');

/**
 * A planilha do inventário.
 *
 * O que estes casos defendem: o arquivo tem as linhas do recorte e nenhuma de
 * fora; nenhuma senha sai; baixar a planilha não cria conta de assinante (a
 * lista cria, a planilha só lê); a célula que viraria fórmula sai neutralizada;
 * o recorte grande demais é recusado; e a trilha diz quantas linhas e qual
 * recorte, nunca o texto buscado.
 */
const SENHA = 'operator-password-1';

let panelUrl;
let token;
let genie;

function aparelho({ id, serial, pppoe, rx = -21.5, lastInform = null }) {
  const device = buildDevice({ id, pppoeUsername: pppoe, rxPower: rx, lastInform });
  device._deviceId._SerialNumber = serial;
  device.InternetGatewayDevice.DeviceInfo.SerialNumber._value = serial;
  return device;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({
    devices: [
      aparelho({ id: 'ONT-A', serial: 'ZTEGAAAA0001', pppoe: 'maria@vila' }),
      aparelho({ id: 'ONT-B', serial: 'ZTEGBBBB0002', pppoe: 'joao@centro', rx: -29.4 }),
      aparelho({ id: 'ONT-C', serial: 'ZTEGCCCC0003', pppoe: '=HYPERLINK("x")', lastInform: '2026-01-01T00:00:00.000Z' })
    ]
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: SENHA, email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

afterEach(() => {
  DeviceService.DEVICE_EXPORT_MAX = 5000;
});

const baixar = (query = '', tk = token) => fetch(`${panelUrl}/api/devices/export${query}`, { headers: authHeaders(tk) });
/** As linhas de dados, já separadas em células, sem o BOM e sem o cabeçalho. */
async function planilha(query = '') {
  const res = await baixar(query);
  assert.equal(res.status, 200, await res.clone().text());
  const texto = await res.text();
  const [cabecalho, ...linhas] = texto.replace(/^\uFEFF/, '').trim().split('\r\n');
  return { res, texto, cabecalho: cabecalho.split(';'), linhas: linhas.map((linha) => linha.split(';')) };
}
const contas = async () => Number((await getDb()('customer_accounts').count({ n: '*' }))[0].n);
const trilha = () => getDb()('audit_log').where({ action: AuditLog.ACTIONS.DEVICES_EXPORTED }).orderBy('id', 'asc');

describe('a célula', () => {
  it('o que a planilha leria como fórmula sai com apóstrofo', () => {
    for (const perigo of ['=1+1', '+55', '-1+2', '-A1', '@SUM(A1)']) {
      assert.equal(csvCell(perigo).replace(/^"|"$/g, '')[0], "'", perigo);
    }
    // Número puro não é fórmula: o RX de toda ONT começa com `-`.
    assert.equal(csvCell('-27'), '-27');
    assert.equal(csvCell('-19,8'), '-19,8');
    assert.equal(csvCell('ZTEG0001'), 'ZTEG0001');
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell(null), '');
  });
});

describe('a planilha', () => {
  it('sai como o Excel em português abre, com o nome do dia', async () => {
    const res = await baixar();
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /equipamentos-\d{4}-\d{2}-\d{2}\.csv/);
    // Os bytes, e não o texto: o `text()` do fetch engole o BOM.
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const { cabecalho } = await planilha();
    assert.ok(cabecalho.includes('Série') && cabecalho.includes('ID do cliente'));
  });

  it('traz todo o inventário, sem criar conta de assinante', async () => {
    assert.equal(await contas(), 0);
    const { linhas, cabecalho } = await planilha();
    assert.equal(linhas.length, 3);
    const serie = cabecalho.indexOf('Série');
    assert.deepEqual(linhas.map((l) => l[serie]).sort(), ['ZTEGAAAA0001', 'ZTEGBBBB0002', 'ZTEGCCCC0003']);
    assert.equal(await contas(), 0, 'a planilha criou conta de assinante — isso é da lista, não dela');
    const cliente = cabecalho.indexOf('ID do cliente');
    assert.ok(linhas.every((l) => l[cliente] === ''));
  });

  it('o RX sai como número, com vírgula decimal, sem apóstrofo', async () => {
    const { linhas, cabecalho } = await planilha('?search=centro');
    assert.equal(linhas[0][cabecalho.indexOf('RX (dBm)')], '-29,4');
  });

  it('diz online e offline pelo mesmo critério da lista', async () => {
    const { linhas, cabecalho } = await planilha();
    const porSerie = Object.fromEntries(linhas.map((l) => [l[cabecalho.indexOf('Série')], l[cabecalho.indexOf('Estado')]]));
    assert.equal(porSerie.ZTEGAAAA0001, 'online');
    assert.equal(porSerie.ZTEGCCCC0003, 'offline');
  });

  it('nenhuma senha sai, e a célula-fórmula vem neutralizada', async () => {
    const { texto } = await planilha();
    assert.ok(!texto.includes('factory'), 'a senha de superusuário da ONT saiu na planilha');
    assert.ok(texto.includes("'=HYPERLINK"), 'o PPPoE que começa com = saiu como fórmula viva');
  });

  it('o recorte da busca: só as linhas que a lista mostraria', async () => {
    const { linhas, cabecalho } = await planilha('?search=vila');
    assert.deepEqual(linhas.map((l) => l[cabecalho.indexOf('PPPoE')]), ['maria@vila']);
  });

  it('o recorte do sinal fraco, pelas faixas do painel', async () => {
    const { linhas, cabecalho } = await planilha('?focus=weak-signal');
    assert.deepEqual(linhas.map((l) => l[cabecalho.indexOf('Série')]), ['ZTEGBBBB0002']);
  });

  it('depois que a lista criou as contas, o ID do cliente aparece', async () => {
    await asTenant(() => Setting.upsert('autoGenerateCustomerId', 'true'));
    const lista = await call(`${panelUrl}/api/devices`, { headers: authHeaders(token) });
    assert.equal(lista.status, 200);
    const ids = await getDb()('customer_accounts').pluck('customer_id');
    assert.ok(ids.length > 0);
    const { linhas, cabecalho } = await planilha();
    const cliente = cabecalho.indexOf('ID do cliente');
    assert.deepEqual(linhas.map((l) => l[cliente]).filter(Boolean).sort(), [...ids].sort());
  });

  it('um recorte maior que o teto é recusado com o motivo', async () => {
    DeviceService.DEVICE_EXPORT_MAX = 2;
    const res = await baixar();
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'export_too_large');
    const busca = await baixar('?search=zteg');
    assert.equal(busca.status, 413, 'com busca, o teto também vale — sobre o que a busca deixou');
  });

  it('a trilha diz quantas linhas e qual recorte, e só SE houve busca', async () => {
    await getDb()('audit_log').where({ action: AuditLog.ACTIONS.DEVICES_EXPORTED }).del();
    await planilha('?search=vila&status=all');
    const [linha] = await trilha();
    const detalhe = JSON.parse(linha.detail);
    assert.deepEqual(detalhe, { count: 1, status: 'all', focus: 'all', search: true });
    assert.ok(!linha.detail.includes('vila'), 'o texto buscado foi para a trilha');
  });
});

describe('quem baixa', () => {
  it('o plantão e o visualizador não, mesmo vendo a lista', async () => {
    for (const role of ['tech', 'viewer']) {
      const criado = await call(`${panelUrl}/api/users`, {
        method: 'POST',
        headers: authHeaders(token),
        body: { username: `quem-${role}`, password: SENHA, role, email: `${role}@exemplo.test` }
      });
      assert.equal(criado.status, 201, JSON.stringify(criado.body));
      const entrou = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username: `quem-${role}`, password: SENHA } });
      const tk = entrou.body.data.token;
      assert.equal((await call(`${panelUrl}/api/devices`, { headers: authHeaders(tk) })).status, 200);
      const res = await baixar('', tk);
      assert.equal(res.status, 403, role);
      assert.equal((await res.json()).code, 'missing_permission');
    }
  });
});
