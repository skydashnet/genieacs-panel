import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: TeiahService } = await import('../src/services/teiahService.js');
const {
  default: TeiahExportService, buildImportItem, toMonthYear, toCep, toUf, hashItem, rentalFor
} = await import('../src/services/teiahExportService.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { refreshDeploymentSharing, resetDeploymentSharing } = await import('../src/services/genieacsEgress.js');

/**
 * TeiaH Valid: os contratos cancelados com título em aberto, do SGP para a
 * base de endereços inadimplentes.
 *
 * Dois servidores falsos. O SGP responde a listagem de clientes (de onde vêm o
 * endereço e as datas) e os títulos de cada contrato. A TeiaH responde
 * `/api/import/address(es)` com a regra do Swagger: `x-api-key` ou 401, e
 * guarda o que recebeu para os testes lerem.
 */

const APP = 'painel';
const SGP_TOKEN = 'token-sgp-teiah';
const API_KEY = 'chave-teiah-123';

const ENDERECO = {
  logradouro: 'Avenida Paulista', numero: '1000', complemento: 'Apto 101',
  bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP', cep: '01310100'
};

const clientes = [
  {
    id: 1,
    nome: 'Devedor Cancelado',
    cpfcnpj: '11122233344',
    contratos: [{
      contrato: 'C-DEVE', contratoStatus: 'Cancelado', dataCadastro: '15/01/2020',
      dataCancelamento: '10/12/2023', comodato: 'S', endereco: { ...ENDERECO, latitude: '-23,5614', longitude: '-46.6559' }
    }]
  },
  {
    // Sem endereço próprio: vale o do cliente.
    id: 2,
    nome: 'Endereço no Cliente',
    cpfcnpj: '22233344455',
    endereco: { ...ENDERECO, numero: '200', cep: '01310-200' },
    contratos: [{ contrato: 'C-CLIENTE', contratoStatus: 'Cancelado', dataAtivacao: '2021-03-01', dataCancelamento: '2024-02-05' }]
  },
  {
    // Cancelou em dia: nada a enviar.
    id: 3,
    nome: 'Pagou Tudo',
    cpfcnpj: '33344455566',
    contratos: [{ contrato: 'C-QUITE', contratoStatus: 'Cancelado', dataCadastro: '01/01/2020', dataCancelamento: '01/06/2022', endereco: ENDERECO }]
  },
  {
    // Sem CEP: nem chega a consultar os títulos.
    id: 4,
    nome: 'Sem CEP',
    cpfcnpj: '44455566677',
    contratos: [{ contrato: 'C-SEMCEP', contratoStatus: 'Cancelado', dataCadastro: '01/01/2020', dataCancelamento: '01/06/2022', endereco: { ...ENDERECO, cep: '' } }]
  },
  {
    // Sem data de cancelamento no SGP.
    id: 5,
    nome: 'Sem Data',
    cpfcnpj: '55566677788',
    contratos: [{ contrato: 'C-SEMDATA', contratoStatus: 'Cancelado', dataCadastro: '01/01/2020', endereco: ENDERECO }]
  },
  {
    // Ativo: não é candidato.
    id: 6,
    nome: 'Ativo Devendo',
    cpfcnpj: '66677788899',
    contratos: [{ contrato: 'C-ATIVO', contratoStatus: 'Ativo', dataCadastro: '01/01/2020', endereco: ENDERECO }]
  }
];

const titulos = {
  'C-DEVE': [
    { numeroDocumento: '1', valor: '1.000,50', status: 'Aberto', vencimento: '10/11/2023' },
    { numeroDocumento: '2', valor: '499,50', status: 'Vencido', vencimento: '10/12/2023' },
    { numeroDocumento: '3', valor: '99,90', status: 'Cancelado', vencimento: '10/12/2023' }
  ],
  'C-CLIENTE': [{ numeroDocumento: '4', valor: '250', status: 'Aberto', vencimento: '05/02/2024' }],
  'C-QUITE': [],
  'C-SEMDATA': [{ numeroDocumento: '5', valor: '80', status: 'Aberto', vencimento: '01/06/2022' }]
};

let panelUrl;
let token;
let beta;
let sgpServer;
let teiahServer;
let teiahUrl;
const invoiceCalls = [];
const teiah = { batches: [], singles: [], keys: [], batchStatus: 201 };

const auth = () => ({ headers: authHeaders(token) });
const linhas = () => asTenant(() => getDb()('teiah_exports').orderBy('contract'));
const porContrato = async () => Object.fromEntries((await linhas()).map((row) => [row.contract, row]));

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || 'null')); } catch { resolve(null); }
    });
  });
}

function startSgpStub() {
  sgpServer = http.createServer(async (req, res) => {
    const payload = (await readBody(req)) || {};
    const send = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (payload.app !== APP || payload.token !== SGP_TOKEN) return send({ status: 0, msg: 'Token inválido' });
    if (req.url.startsWith('/api/ura/clientes/')) {
      const offset = Number(payload.offset) || 0;
      return send({ status: 1, clientes: clientes.slice(offset, offset + (Number(payload.limit) || 10)) });
    }
    if (req.url.startsWith('/api/ura/titulos/')) {
      invoiceCalls.push(payload.contrato);
      return send({ status: 1, titulos: titulos[payload.contrato] ?? [] });
    }
    return send({ status: 0, msg: 'Endpoint inexistente' });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

function startTeiahStub() {
  teiahServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    teiah.keys.push(req.headers['x-api-key'] ?? null);
    if (req.headers['x-api-key'] !== API_KEY) return send(401, { statusCode: 401, message: 'Unauthorized' });
    if (req.method === 'POST' && req.url === '/api/import/addresses') {
      if (teiah.batchStatus !== 201) return send(teiah.batchStatus, { message: ['each value in body must be a string'] });
      teiah.batches.push(body);
      return send(201, { imported: Array.isArray(body) ? body.length : 0 });
    }
    if (req.method === 'POST' && req.url === '/api/import/address') {
      if (!body?.cep) return send(400, { message: ['cep should not be empty'] });
      teiah.singles.push(body);
      return send(201, { id: teiah.singles.length });
    }
    return send(404, { message: 'Cannot POST' });
  });
  return new Promise((resolve) => {
    teiahServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${teiahServer.address().port}`));
  });
}

async function runExport() {
  return asTenant(() => TeiahExportService.exportAll());
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  teiahUrl = await startTeiahStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  TeiahExportService.INVOICE_PACE_MS = 0;

  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: SGP_TOKEN, linkMode: 'manual', contactsPageSize: 10
  }));
  await asTenant(() => import('../src/services/sgpContactSyncService.js').then((m) => m.default.syncAll()));

  const db = getDb();
  await db('tenants').insert({ slug: 'beta-teiah', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta-teiah' }).first()).id;
  // Um contrato cancelado do vizinho, com o mesmo número: nunca pode sair daqui.
  await runInTenant(beta, () => db('sgp_contacts').insert({
    tenant_id: beta, contract: 'C-DEVE', client_name: 'Do Beta', state: 'cancelled',
    address_parts: JSON.stringify({ street: 'Rua do Vizinho', number: '1', district: 'X', city: 'Y', state: 'PA', zip: '68000000' }),
    contract_created_at: '01/01/2020', contract_cancelled_at: '01/01/2021'
  }));
});

after(async () => {
  resetDeploymentSharing();
  await getDb()('tenants').where({ slug: 'beta-teiah' }).del();
  await stopTestServers();
  await new Promise((done) => sgpServer.close(done));
  await new Promise((done) => teiahServer.close(done));
});

beforeEach(() => {
  teiah.batchStatus = 201;
});

describe('conversões do DTO', () => {
  it('mês/ano a partir dos formatos do SGP', () => {
    assert.equal(toMonthYear('15/01/2020'), '01/2020');
    assert.equal(toMonthYear('5/3/2021 10:00:00'), '03/2021');
    assert.equal(toMonthYear('2024-02-05'), '02/2024');
    assert.equal(toMonthYear('2024-02-05T10:00:00Z'), '02/2024');
    assert.equal(toMonthYear('12/2023'), '12/2023');
    assert.equal(toMonthYear(new Date(Date.UTC(2022, 5, 1))), '06/2022');
    assert.equal(toMonthYear('ontem'), null);
    assert.equal(toMonthYear(null), null);
  });

  it('CEP com hífen e UF de duas letras', () => {
    assert.equal(toCep('01310100'), '01310-100');
    assert.equal(toCep('01310-100'), '01310-100');
    assert.equal(toCep('1310100'), null);
    assert.equal(toUf('sp'), 'SP');
    assert.equal(toUf('São Paulo'), 'SP');
    assert.equal(toUf('Pará'), 'PA');
    assert.equal(toUf('XX'), null);
  });

  it('recusa cancelamento antes do início e dívida zero', () => {
    const address = { street: 'R', number: '1', district: 'B', city: 'C', state: 'SP', zip: '01310100' };
    assert.equal(buildImportItem({ address, startedAt: '01/05/2022', cancelledAt: '01/01/2022', amount: 10 }).reason, 'missing_cancellation');
    assert.equal(buildImportItem({ address, startedAt: '01/05/2022', cancelledAt: '01/06/2022', amount: 0 }).reason, 'no_debt');
    assert.equal(buildImportItem({ address: { ...address, number: '' }, startedAt: '01/05/2022', cancelledAt: '01/06/2022', amount: 5 }).reason, 'missing_address');
  });

  it('aluguel: o SGP prevalece, o padrão cobre o silêncio', () => {
    assert.equal(rentalFor({ equipment_rented: 1 }, { rentalDefault: 'false' }), true);
    assert.equal(rentalFor({ equipment_rented: false }, { rentalDefault: 'true' }), false);
    assert.equal(rentalFor({ equipment_rented: null }, { rentalDefault: 'true' }), true);
    assert.equal(rentalFor({ equipment_rented: null }, { rentalDefault: 'omit' }), null);
    const address = { street: 'R', number: '1', district: 'B', city: 'C', state: 'SP', zip: '01310100' };
    const base = { address, startedAt: '01/05/2022', cancelledAt: '01/06/2022', amount: 5 };
    assert.equal('aluguel' in buildImportItem(base).item, false);
    assert.equal(buildImportItem({ ...base, rental: false }).item.aluguel, false);
  });

  it('o hash não depende da ordem das chaves', () => {
    assert.equal(hashItem({ a: 1, b: 2 }), hashItem({ b: 2, a: 1 }));
  });
});

describe('configuração', () => {
  it('guarda a chave cifrada e nunca a devolve', async () => {
    const res = await call(`${panelUrl}/api/teiah/config`, {
      method: 'PUT', ...auth(),
      body: { enabled: true, baseUrl: `${teiahUrl}/api`, apiKey: API_KEY, batchSize: 2 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.apiKeyConfigured, true);
    assert.equal(res.body.data.ready, true);
    // O `/api` colado do Swagger sai: os caminhos são da API.
    assert.equal(res.body.data.baseUrl, teiahUrl);
    assert.equal(JSON.stringify(res.body).includes(API_KEY), false);

    const raw = await asTenant(() => AppState.get('teiah_integration_config'));
    assert.equal(raw.includes(API_KEY), false, 'a chave ficou em claro no banco');

    const again = await call(`${panelUrl}/api/teiah/config`, { method: 'PUT', ...auth(), body: { batchSize: 2 } });
    assert.equal(again.body.data.apiKeyConfigured, true, 'um PUT sem a chave apagou a chave');
  });

  it('o teste manda a chave e não grava nada na TeiaH', async () => {
    const before = teiah.batches.length;
    const res = await call(`${panelUrl}/api/teiah/test`, { method: 'POST', ...auth(), body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(teiah.keys.at(-1), API_KEY);
    assert.deepEqual(teiah.batches.slice(before), [[]]);
  });

  it('uma chave recusada vira credentialsRejected', async () => {
    const res = await call(`${panelUrl}/api/teiah/test`, { method: 'POST', ...auth(), body: { apiKey: 'errada' } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'unauthorized');
  });

  it('um endereço que não é a API (404) não passa no teste', async () => {
    const res = await call(`${panelUrl}/api/teiah/test`, {
      method: 'POST', ...auth(), body: { baseUrl: `${teiahUrl}/outra-coisa`, apiKey: API_KEY }
    });
    assert.equal(res.status, 502, JSON.stringify(res.body));
  });

  it('testar outro endereço sem chave: 400, e a chave salva não sai', async () => {
    const antes = teiah.keys.length;
    const res = await call(`${panelUrl}/api/teiah/test`, {
      method: 'POST', ...auth(), body: { baseUrl: `${teiahUrl}/outra-coisa` }
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'api_key_required_for_new_url');
    assert.equal(teiah.keys.length, antes, 'nenhum pedido saiu');
  });

  it('o mesmo endereço, escrito de outro jeito, usa a chave salva', async () => {
    const res = await call(`${panelUrl}/api/teiah/test`, {
      method: 'POST', ...auth(), body: { baseUrl: `${teiahUrl.replace('http://', 'HTTP://')}/api/` }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(teiah.keys.at(-1), API_KEY);
  });

  it('salvar outro endereço sem chave é recusado; com chave, aceito', async () => {
    const outro = `${teiahUrl}/outra-coisa`;
    const semChave = await call(`${panelUrl}/api/teiah/config`, { method: 'PUT', ...auth(), body: { baseUrl: outro } });
    assert.equal(semChave.status, 400, JSON.stringify(semChave.body));
    assert.equal(semChave.body.code, 'api_key_required_for_new_url');
    const lido = await call(`${panelUrl}/api/teiah/config`, auth());
    assert.equal(lido.body.data.baseUrl, teiahUrl, 'o endereço não mudou');

    const mesmo = await call(`${panelUrl}/api/teiah/config`, { method: 'PUT', ...auth(), body: { baseUrl: `${teiahUrl}/` } });
    assert.equal(mesmo.status, 200, JSON.stringify(mesmo.body));

    const comChave = await call(`${panelUrl}/api/teiah/config`, {
      method: 'PUT', ...auth(), body: { baseUrl: outro, apiKey: API_KEY }
    });
    assert.equal(comChave.status, 200, JSON.stringify(comChave.body));
    assert.equal(comChave.body.data.baseUrl, outro);

    // De volta ao endereço de verdade para os testes seguintes.
    const volta = await call(`${panelUrl}/api/teiah/config`, {
      method: 'PUT', ...auth(), body: { baseUrl: teiahUrl, apiKey: API_KEY }
    });
    assert.equal(volta.status, 200, JSON.stringify(volta.body));
  });
});

describe('envio dos inadimplentes', () => {
  it('manda só os cancelados com dívida, no formato do Swagger', async () => {
    teiah.batches.length = 0;
    invoiceCalls.length = 0;
    const result = await runExport();

    assert.equal(result.total, 5, JSON.stringify(result));
    assert.equal(result.sent, 2);
    assert.equal(result.skipped, 3);
    assert.deepEqual(result.reasons, { no_debt: 1, missing_address: 1, missing_cancellation: 1 });

    const enviados = teiah.batches.flat();
    const deve = enviados.find((item) => item.numero === '1000');
    assert.deepEqual(deve, {
      estado: 'SP',
      cidade: 'São Paulo',
      cep: '01310-100',
      bairro: 'Bela Vista',
      rua: 'Avenida Paulista',
      numero: '1000',
      complemento: 'Apto 101',
      latitude: -23.5614,
      longitude: -46.6559,
      // O SGP diz "S" no comodato.
      aluguel: true,
      // O título cancelado não entra na soma.
      inadimplente_valor: 1500,
      data_inicio: '01/2020',
      data_cancelamento: '12/2023'
    });
    const doCliente = enviados.find((item) => item.numero === '200');
    // O SGP não diz nada e o padrão é não enviar.
    assert.equal('aluguel' in doCliente, false);
    assert.equal(doCliente.cep, '01310-200');
    assert.equal(doCliente.inadimplente_valor, 250);
    assert.equal(doCliente.data_inicio, '03/2021');
    assert.equal(doCliente.data_cancelamento, '02/2024');

    // Nada que identifique a pessoa sai do painel.
    const texto = JSON.stringify(teiah.batches);
    for (const proibido of ['Devedor', '11122233344', 'C-DEVE', 'Rua do Vizinho']) {
      assert.equal(texto.includes(proibido), false, `${proibido} foi enviado à TeiaH`);
    }
    // Sem CEP e sem data de cancelamento: o SGP nem foi perguntado.
    assert.equal(invoiceCalls.includes('C-SEMCEP'), false);
    assert.equal(invoiceCalls.includes('C-SEMDATA'), false);
    assert.equal(invoiceCalls.includes('C-ATIVO'), false);

    const rows = await porContrato();
    assert.equal(rows['C-DEVE'].status, 'sent');
    assert.equal(Number(rows['C-DEVE'].amount), 1500);
    assert.equal(rows['C-QUITE'].reason, 'no_debt');
    assert.equal(rows['C-SEMCEP'].reason, 'missing_address');
    assert.equal(rows['C-SEMDATA'].reason, 'missing_cancellation');
  });

  it('não reenvia o que não mudou, e reenvia quando a dívida muda', async () => {
    teiah.batches.length = 0;
    const second = await runExport();
    assert.equal(second.sent, 0);
    assert.equal(second.unchanged, 2);
    assert.deepEqual(teiah.batches, []);

    titulos['C-CLIENTE'] = [{ numeroDocumento: '4', valor: '300', status: 'Aberto', vencimento: '05/02/2024' }];
    const third = await runExport();
    assert.equal(third.sent, 1);
    assert.equal(teiah.batches.flat()[0].inadimplente_valor, 300);
  });

  it('o padrão da configuração preenche o aluguel só onde o SGP não diz', async () => {
    teiah.batches.length = 0;
    await asTenant(() => TeiahService.saveConfig({ rentalDefault: 'false' }));
    const result = await runExport();
    // Só o contrato sem informação do SGP muda (ganha `aluguel: false`); o outro
    // continua `true` e igual ao já enviado.
    assert.equal(result.sent, 1, JSON.stringify(result));
    const [item] = teiah.batches.flat();
    assert.equal(item.numero, '200');
    assert.equal(item.aluguel, false);
    const cfg = await call(`${panelUrl}/api/teiah/config`, auth());
    assert.equal(cfg.body.data.rentalDefault, 'false');
    await asTenant(() => TeiahService.saveConfig({ rentalDefault: 'nao-existe' }));
    assert.equal((await asTenant(() => TeiahService.getConfig())).rentalDefault, 'false');
  });

  it('usa o evento de cancelamento quando o SGP não manda a data', async () => {
    await asTenant(() => getDb()('sgp_events').insert({
      dedupe_key: 'teste-cancelamento-semdata', source: 'webhook', type: 'cancelled',
      contract: 'C-SEMDATA', status: 'processed', occurred_at: new Date(Date.UTC(2022, 6, 15))
    }));
    const result = await runExport();
    assert.equal(result.sent, 1);
    const rows = await porContrato();
    assert.equal(rows['C-SEMDATA'].status, 'sent');
  });

  it('um lote recusado por formato cai para o envio de um em um', async () => {
    teiah.batchStatus = 400;
    teiah.singles.length = 0;
    await asTenant(() => getDb()('teiah_exports').where({ contract: 'C-DEVE' }).update({ payload_hash: 'velho' }));
    const result = await runExport();
    assert.equal(result.sent, 1, JSON.stringify(result));
    assert.equal(teiah.singles.length, 1);
    assert.equal(teiah.singles[0].numero, '1000');
  });

  it('uma chave revogada para o envio e deixa o erro para a tela', async () => {
    await asTenant(() => TeiahService.saveConfig({ apiKey: 'revogada' }));
    await asTenant(() => getDb()('teiah_exports').where({ contract: 'C-DEVE' }).update({ payload_hash: 'velho' }));
    await assert.rejects(runExport(), (error) => error.code === 'unauthorized');
    const status = await call(`${panelUrl}/api/teiah/export`, auth());
    assert.equal(status.body.data.lastError.code, 'unauthorized');
    await asTenant(() => TeiahService.saveConfig({ apiKey: API_KEY }));
  });

  it('a lista e o status mostram o que foi pulado e por quê', async () => {
    const status = await call(`${panelUrl}/api/teiah/export`, auth());
    assert.equal(status.status, 200);
    assert.ok(status.body.data.totals.sent >= 2);
    const pulados = await call(`${panelUrl}/api/teiah/export/items?status=skipped`, auth());
    assert.equal(pulados.status, 200);
    const semCep = pulados.body.data.items.find((item) => item.contract === 'C-SEMCEP');
    assert.equal(semCep.reason, 'missing_address');
    assert.equal(semCep.clientName, 'Sem CEP');
  });

  it('a prévia mostra o item sem enviar e sem gravar', async () => {
    teiah.batches.length = 0;
    const antes = await linhas();
    const res = await call(`${panelUrl}/api/teiah/export/preview`, auth());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const deve = res.body.data.items.find((item) => item.contract === 'C-DEVE');
    assert.equal(deve.item.inadimplente_valor, 1500);
    assert.deepEqual(teiah.batches, []);
    assert.deepEqual(await linhas(), antes);
  });

  it('nada do vizinho: o outro provedor não tem registro nem envio', async () => {
    const doBeta = await runInTenant(beta, () => getDb()('teiah_exports').where({ tenant_id: beta }));
    assert.deepEqual(doBeta, []);
  });
});

describe('deploy compartilhado', () => {
  it('recusa uma API apontada para a rede interna', async () => {
    await refreshDeploymentSharing();
    const res = await call(`${panelUrl}/api/teiah/test`, { method: 'POST', ...auth(), body: {} });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'blocked_host');
    resetDeploymentSharing();
  });
});
