import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: SgpContactSyncService } = await import('../src/services/sgpContactSyncService.js');
const { default: AppState } = await import('../src/models/AppState.js');

/**
 * Todos os clientes do SGP nos contatos do WhatsApp, com ou sem contrato, com
 * ou sem equipamento.
 *
 * O caminho da listagem é configurado por instalação — a referência da URA não
 * tem uma chamada "liste todos". O SGP falso daqui responde nele com páginas
 * por `offset`/`limit`, em três formatos que as versões do SGP usam: cliente
 * com contratos aninhados, cliente sem contrato, e um caminho que ignora a
 * paginação e devolve sempre a mesma página.
 */

const APP = 'painel';
const TOKEN = 'token-da-listagem';
const LIST_PATH = '/api/ura/clientes/';
const BROKEN_PATH = '/api/ura/clientes-sem-pagina/';
/** Answers an empty list when asked without a filter. */
const EMPTY_PATH = '/api/ura/clientes-vazio/';
/** Ignores `limit` and answers with the whole base at once. */
const ALL_PATH = '/api/ura/clientes-tudo/';
/** Takes longer than the listing deadline to answer. */
const SLOW_PATH = '/api/ura/clientes-lento/';
/** Contracts keyed by `id` and contacts as an object of lists, the way some SGP versions send them. */
const SHAPE_PATH = '/api/ura/clientes-formato/';
/** Answers page one, then refuses page two. */
const BREAKS_PATH = '/api/ura/clientes-quebra/';
/** Misses the deadline once, then answers at once. */
const SLOW_ONCE_PATH = '/api/ura/clientes-lento-uma-vez/';
/** Refuses outright without a filter, the way an URA call does. */
const FILTER_PATH = '/api/ura/clientes-com-filtro/';
const INSTANCE = 'painel-sync-contatos';
const WEBHOOK_TOKEN = 'segredo-do-webhook-sync';

/** O cadastro do SGP falso. Mutável: um teste dá contrato a quem não tinha. */
const clientes = [];
for (let i = 1; i <= 21; i += 1) {
  clientes.push({
    id: 1000 + i,
    nome: `Cliente ${String(i).padStart(2, '0')}`,
    cpfcnpj: String(10000000000 + i),
    celular: `55939911${String(10000 + i).slice(-5)}`,
    contratos: [{ contrato: `K-${i}`, contratoStatus: i % 7 === 0 ? 'Cancelado' : 'Ativo' }]
  });
}
// Dois contratos num cliente só.
clientes.push({
  id: 2001,
  nome: 'Maria Duas Casas',
  cpfcnpj: '55566677788',
  telefones: ['(93) 3522-1234', '(93) 98111-3333'],
  contratos: [
    { contrato: 'K-DUAS-1', contratoStatus: 'Ativo' },
    { contrato: 'K-DUAS-2', contratoStatus: 'Suspenso' }
  ]
});
// Cadastro sem contrato nenhum.
clientes.push({ id: 3001, nome: 'João Sem Contrato', cpfcnpj: '99988877766', celular: '93 99222-4444', contratos: [] });

let panelUrl;
let token;
let beta;
let accountId;
let sgpServer;
let lastListPayload = null;
let slowOnceCalls = 0;

const auth = () => ({ headers: authHeaders(token) });
const situacao = () => call(`${panelUrl}/api/sgp/contacts/sync`, auth());
/**
 * O botão: o POST só dispara (202) e a tela pergunta até terminar. Devolve o
 * último resultado no formato de uma resposta, para os testes lerem como antes.
 */
async function sincronizar() {
  const start = await call(`${panelUrl}/api/sgp/contacts/sync`, { method: 'POST', ...auth() });
  if (start.status !== 202) return start;
  for (let i = 0; i < 400; i += 1) {
    const res = await situacao();
    if (!res.body.data.running) return { status: 200, body: { data: res.body.data.lastRun, lastError: res.body.data.lastError } };
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error('a sincronização não terminou');
}
// Direto no serviço: a rota tem o limitador da sincronização de frota, que é o
// certo em produção e acaba com o orçamento de um arquivo de testes.
const sincronizarDireto = () => asTenant(() => SgpContactSyncService.syncAll());
const testar = () => call(`${panelUrl}/api/sgp/contacts/test`, { method: 'POST', ...auth() });
const contatos = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, auth());
const linhas = () => asTenant(() => getDb()('sgp_contacts').orderBy('id'));
const configurar = (patch) => asTenant(() => SgpService.saveConfig(patch));
const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith(LIST_PATH)) {
        lastListPayload = payload;
        const offset = Number(payload.offset) || 0;
        const limit = Number(payload.limit) || 10;
        return send({ status: 1, clientes: clientes.slice(offset, offset + limit) });
      }
      if (req.url.startsWith(SHAPE_PATH)) {
        return send({
          status: 1,
          clientes: [
            {
              id: 7,
              nome: '7 - Elane Formato',
              cpfcnpj: '700.000.000-07',
              contratos: [{ id: 7070, status: 'Ativo' }],
              contatos: { emails: ['elane@exemplo.test'], celulares: ['(93) 99123-7070'], telefones: [] }
            },
            {
              id: 8,
              nome: 'Contrato Ilegível',
              cpfcnpj: '800.000.000-08',
              contratos: [{ numero: 'X' }],
              contatos: [{ tipo: 'celular', fone: '93991238080' }]
            }
          ]
        });
      }
      if (req.url.startsWith(BREAKS_PATH)) {
        if ((Number(payload.offset) || 0) > 0) return send({ status: 0, msg: 'Falha na página dois' });
        return send({ status: 1, clientes: clientes.slice(0, Number(payload.limit) || 10) });
      }
      if (req.url.startsWith(SLOW_ONCE_PATH)) {
        slowOnceCalls += 1;
        if (slowOnceCalls === 1) {
          setTimeout(() => send({ status: 1, clientes: [] }), 400);
          return undefined;
        }
        return send({ status: 1, clientes: clientes.slice(0, 3) });
      }
      if (req.url.startsWith(ALL_PATH)) return send({ status: 1, clientes });
      if (req.url.startsWith(SLOW_PATH)) {
        setTimeout(() => send({ status: 1, clientes: [] }), 400);
        return undefined;
      }
      if (req.url.startsWith(EMPTY_PATH)) return send({ status: 1, clientes: [] });
      if (req.url.startsWith(FILTER_PATH)) return send({ status: 0, msg: 'Informe ao menos um filtro' });
      if (req.url.startsWith(BROKEN_PATH)) {
        return send({ status: 1, clientes: clientes.slice(0, Number(payload.limit) || 10) });
      }
      return send({ status: 0, msg: 'Endpoint inexistente' });
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

function eventoV2({ id, remoteJid }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe: false, id },
      pushName: 'Cliente',
      message: { conversation: 'oi' },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  await configurar({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual', contactsPageSize: 10 });
  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia-sync'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;

  // Um contrato que já tem ONT: a listagem continua mostrando só uma vez.
  await asTenant(() => db('sgp_links').insert({
    device_id: 'ONT-K1', contract: 'K-1', client_name: 'Cliente 01', state: 'active', link_mode: 'manual',
    phone_e164: '5593991110001'
  }));

  // O cadastro sem contrato do vizinho.
  await runInTenant(beta, () => db('sgp_contacts').insert({
    tenant_id: beta, contract: null, sgp_client_id: '9999', client_name: 'Do Beta', state: 'none'
  }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('o caminho padrão', () => {
  it('é /api/ura/clientes/, sem ninguém precisar preencher', async () => {
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');
  });

  it('também para quem salvou o campo vazio na versão anterior', async () => {
    await configurar({ endpoints: { customerList: '' } });
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');
  });

  it('tira a variável {{url}} de um caminho colado do Postman', async () => {
    await configurar({ endpoints: { customerList: '/{{url}}/api/ura/clientes/' } });
    let config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');

    await configurar({ endpoints: { customerList: '{{url}}/api/ura/clientes/' } });
    config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');
  });

  it('recusa uma variável do Postman no meio do caminho', async () => {
    const res = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { endpoints: { customerList: '/api/{{versao}}/clientes/' } }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_endpoint');
  });

  it('lê limpo um caminho com {{url}} salvo antes da correção', async () => {
    await asTenant(async () => {
      const stored = JSON.parse(await AppState.get('sgp_integration_config'));
      stored.endpoints = { ...stored.endpoints, customerList: '/{{url}}/api/ura/clientes/' };
      await AppState.upsert('sgp_integration_config', JSON.stringify(stored));
      SgpService.invalidateConfigCache();
    });
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');
    await configurar({ endpoints: { customerList: '' } });
  });
});

describe('salvar a seção pela tela', () => {
  const salvar = (body) => call(`${panelUrl}/api/sgp/config`, { method: 'PUT', headers: authHeaders(token), body });

  it('guarda a sincronização automática, o intervalo e a paginação', async () => {
    const res = await salvar({
      contactsSyncEnabled: true,
      contactsSyncIntervalHours: 6,
      contactsPageSize: 30,
      contactsPaging: 'page',
      contactsOffsetParam: 'pagina',
      contactsLimitParam: 'quantidade'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const lido = await call(`${panelUrl}/api/sgp/config`, auth());
    const config = lido.body.data;
    assert.equal(config.contactsSyncEnabled, true);
    assert.equal(config.contactsSyncIntervalHours, 6);
    assert.equal(config.contactsPageSize, 30);
    assert.equal(config.contactsPaging, 'page');
    assert.equal(config.contactsOffsetParam, 'pagina');
    assert.equal(config.contactsLimitParam, 'quantidade');
  });

  it('salvar o formulário principal do SGP não desliga a sincronização automática', async () => {
    const res = await salvar({ linkMode: 'manual' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.contactsSyncEnabled, true);
    assert.equal(res.body.data.contactsPageSize, 30);

    // De volta ao que o resto do arquivo espera.
    await configurar({
      contactsSyncEnabled: false,
      contactsSyncIntervalHours: 24,
      contactsPageSize: 10,
      contactsPaging: 'offset',
      contactsOffsetParam: 'offset',
      contactsLimitParam: 'limit'
    });
  });
});

describe('o botão de testar', () => {
  it('lê só a primeira página e não grava nada', async () => {
    assert.equal(LIST_PATH, '/api/ura/clientes/');
    const res = await testar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.received, 10);
    assert.ok(res.body.data.fields.includes('contratos'));
    assert.equal((await linhas()).filter((row) => Number(row.tenant_id) !== Number(beta)).length, 0);
  });
});

describe('a sincronização completa', () => {
  let resultado;

  before(async () => {
    resultado = await sincronizar();
  });

  it('percorre todas as páginas', async () => {
    assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
    assert.equal(resultado.body.data.partial, false);
    assert.equal(resultado.body.data.pages, 3);
    // 21 clientes com um contrato, um com dois, um sem nenhum.
    assert.equal(resultado.body.data.total, 24);
    assert.equal(resultado.body.data.withoutContract, 1);
    assert.equal(lastListPayload.limit, 10);
  });

  it('guarda uma linha por contrato, e a do cliente sem contrato', async () => {
    const todas = await linhas();
    const duas = todas.filter((row) => ['K-DUAS-1', 'K-DUAS-2'].includes(row.contract));
    assert.equal(duas.length, 2);
    assert.equal(duas[0].phone_e164, '5593981113333', 'o celular da lista, não o fixo');
    assert.equal(duas.find((row) => row.contract === 'K-DUAS-2').state, 'blocked');

    const joao = todas.find((row) => row.client_name === 'João Sem Contrato');
    assert.equal(joao.contract, null);
    assert.equal(joao.sgp_client_id, '3001');
    assert.equal(joao.state, 'none');
    assert.equal(joao.phone_e164, '5593992224444');
    assert.ok(joao.last_seen_at);
  });

  it('não apaga a correção do operador ao sincronizar de novo', async () => {
    await asTenant(() => getDb()('sgp_contacts').where({ contract: 'K-5' }).update({ phone_manual: '5521900000005' }));
    const again = await sincronizar();
    assert.equal(again.body.data.updated, 24);
    assert.equal(again.body.data.created, 0);
    const k5 = (await linhas()).find((row) => row.contract === 'K-5');
    assert.equal(k5.phone_manual, '5521900000005');
  });

  it('diz quando foi a última', async () => {
    const res = await situacao();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.running, false);
    assert.equal(res.body.data.lastRun.total, 24);
    assert.equal(res.body.data.lastError, null);
  });
});

describe('na aba Contatos', () => {
  it('mostra quem tem e quem não tem contrato, sem repetir o que tem ONT', async () => {
    const res = await contatos('?limit=200');
    const lista = res.body.data.contacts;
    assert.equal(lista.filter((c) => c.contract === 'K-1').length, 1);
    assert.equal(lista.find((c) => c.contract === 'K-1').hasDevice, true);
    const joao = lista.find((c) => c.clientName === 'João Sem Contrato');
    assert.equal(joao.hasContract, false);
    assert.match(joao.key, /^c:\d+$/);
    assert.ok(!lista.some((c) => c.clientName === 'Do Beta'), 'o cadastro do vizinho não aparece');
  });

  it('filtra por situação', async () => {
    const semContrato = await contatos('?state=none');
    assert.deepEqual(semContrato.body.data.contacts.map((c) => c.clientName), ['João Sem Contrato']);
    const cancelados = await contatos('?state=cancelled');
    assert.deepEqual(cancelados.body.data.contacts.map((c) => c.contract).sort(), ['K-14', 'K-21', 'K-7']);
  });
});

describe('conversa com um cliente sem contrato', () => {
  let chave;
  let fioId;

  before(async () => {
    const res = await contatos('?state=none');
    chave = res.body.data.contacts[0].key;
  });

  it('abre pela chave, vinculada à linha e não a um contrato inventado', async () => {
    const res = await call(`${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(chave)}/conversation`, {
      method: 'POST', ...auth()
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.contract, null);
    assert.equal(res.body.data.clientName, 'João Sem Contrato');
    assert.equal(`c:${res.body.data.sgpContactId}`, chave);
    fioId = res.body.data.id;
  });

  it('a resposta dele cai no mesmo fio, mesmo sem o nono dígito', async () => {
    await hook(eventoV2({ id: 'MSG-SEM-CONTRATO', remoteJid: '559392224444@s.whatsapp.net' }));
    const fios = await asTenant(() => getDb()('wa_conversations')
      .whereIn('wa_phone_e164', ['5593992224444', '559392224444']));
    assert.deepEqual(fios.map((f) => f.id), [fioId], 'nenhum segundo fio pela outra grafia');
    assert.equal(fios[0].unread_count, 1);
  });

  it('um número desconhecido pode ser vinculado a ele à mão', async () => {
    await hook(eventoV2({ id: 'MSG-PARENTE', remoteJid: '5521955550000@s.whatsapp.net' }));
    const parente = await asTenant(() => WaConversation.getByThread(accountId, '5521955550000@s.whatsapp.net'));
    const res = await call(`${panelUrl}/api/whatsapp/conversations/${parente.id}/subscriber`, {
      method: 'POST', ...auth(), body: { contract: chave, savePhone: true }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.clientName, 'João Sem Contrato');
    const joao = (await linhas()).find((row) => row.client_name === 'João Sem Contrato');
    assert.equal(joao.phone_manual, '5521955550000');
  });

  it('não alcança o cadastro do vizinho pela chave', async () => {
    const doBeta = await runInTenant(beta, () => getDb()('sgp_contacts').where({ sgp_client_id: '9999' }).first());
    const res = await call(`${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(`c:${doBeta.id}`)}/conversation`, {
      method: 'POST', ...auth()
    });
    assert.equal(res.status, 404);
  });

  it('quando ganha contrato no SGP, a linha sem contrato sai e a conversa segue com ele', async () => {
    const joao = clientes.find((c) => c.id === 3001);
    joao.contratos = [{ contrato: 'K-NOVO', contratoStatus: 'Ativo' }];
    await sincronizar();

    const todas = await linhas();
    assert.ok(!todas.some((row) => row.sgp_client_id === '3001'), 'a linha sem contrato foi aposentada');
    const novo = todas.find((row) => row.contract === 'K-NOVO');
    assert.equal(novo.phone_manual, '5521955550000', 'a correção do operador foi junto');

    const fio = await asTenant(() => WaConversation.getById(fioId));
    assert.equal(fio.contract, 'K-NOVO');
    assert.equal(fio.sgp_contact_id, null);
  });
});

describe('um SGP que não lista sem filtro', () => {
  it('uma primeira página vazia é avisada, não comemorada', async () => {
    await configurar({ endpoints: { customerList: EMPTY_PATH } });
    const res = await sincronizarDireto();
    assert.equal(res.partial, true);
    assert.equal(res.reason, 'empty');
    assert.equal(res.total, 0);
  });

  it('a recusa chega com a frase do próprio SGP', async () => {
    await configurar({ endpoints: { customerList: FILTER_PATH } });
    const res = await testar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'sgp_rejected');
    assert.match(res.body.message, /Informe ao menos um filtro/);
    await assert.rejects(sincronizarDireto(), (error) => error.code === 'sgp_rejected');
  });

  it('pelo botão, a recusa fica guardada para a tela mostrar', async () => {
    await configurar({ endpoints: { customerList: FILTER_PATH } });
    const res = await sincronizar();
    assert.equal(res.body.lastError.code, 'sgp_rejected');
    assert.match(res.body.lastError.message, /Informe ao menos um filtro/);
  });
});

describe('os formatos de outras versões do SGP', () => {
  it('lê o contrato pelo id dentro de contratos e o celular dentro de contatos', async () => {
    await configurar({ endpoints: { customerList: SHAPE_PATH } });
    const res = await testar();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.withContract, 1);
    assert.equal(res.body.data.withPhone, 2);
    assert.equal(res.body.data.rows, 2, 'o cliente de contrato ilegível continua lá, sem contrato');
    assert.match(res.body.data.shape.contratos, /id, status/);
    assert.match(res.body.data.shape.contatos, /celulares: \[string\]/);
    assert.ok(!JSON.stringify(res.body.data.shape).includes('99123'), 'o formato não traz valores');
    assert.equal(typeof res.body.data.durationMs, 'number');

    await sincronizarDireto();
    const elane = (await linhas()).find((row) => row.contract === '7070');
    assert.ok(elane, 'o contrato 7070 foi gravado');
    assert.equal(elane.phone_e164, '5593991237070');
  });

  it('uma página que falha no meio guarda o que já leu, como parcial', async () => {
    await configurar({ endpoints: { customerList: BREAKS_PATH } });
    // Direto no serviço, pelo orçamento do limitador; a tela lê o mesmo GET.
    await assert.rejects(sincronizarDireto(), (error) => error.code === 'sgp_rejected');
    const res = await situacao();
    assert.equal(res.body.data.lastRun.partial, true);
    assert.equal(res.body.data.lastRun.reason, 'error');
    assert.equal(res.body.data.lastRun.pages, 1);
    assert.ok(res.body.data.lastRun.total > 0);
    assert.equal(res.body.data.lastError.code, 'sgp_rejected');
  });

  it('pede de novo a página que estourou o prazo uma vez', async () => {
    await configurar({ endpoints: { customerList: SLOW_ONCE_PATH } });
    const prazoReal = SgpService.LIST_TIMEOUT_MS;
    SgpService.LIST_TIMEOUT_MS = 100;
    try {
      const res = await sincronizarDireto();
      assert.equal(res.total, 3);
      assert.equal(slowOnceCalls, 2);
    } finally {
      SgpService.LIST_TIMEOUT_MS = prazoReal;
    }
  });
});

describe('um SGP que manda a base inteira de uma vez', () => {
  it('grava todos numa chamada só e não chama de parcial', async () => {
    await configurar({ endpoints: { customerList: ALL_PATH } });
    const res = await sincronizarDireto();
    assert.equal(res.pages, 1);
    assert.equal(res.partial, false);
    assert.equal(res.note, 'all_at_once');
    assert.equal(res.total, 24);
  });

  it('uma listagem lenta estoura o prazo dela, com a frase dela', async () => {
    await configurar({ endpoints: { customerList: SLOW_PATH } });
    const prazoReal = SgpService.LIST_TIMEOUT_MS;
    SgpService.LIST_TIMEOUT_MS = 100;
    try {
      const res = await testar();
      assert.equal(res.status, 504);
      assert.equal(res.body.code, 'timeout');
      assert.match(res.body.message, /listagem de clientes|client listing/i);
    } finally {
      SgpService.LIST_TIMEOUT_MS = prazoReal;
    }
  });
});

describe('um SGP que ignora a paginação', () => {
  it('para na segunda página em vez de ler a primeira para sempre', async () => {
    await configurar({ endpoints: { customerList: BROKEN_PATH } });
    const res = await sincronizar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.partial, true);
    assert.equal(res.body.data.reason, 'paging_ignored');
    assert.equal(res.body.data.pages, 2);
  });
});
