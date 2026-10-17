import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: FocusChatService } = await import('../src/services/focusChatService.js');

/**
 * Importar a agenda do Focus Chat: a API pagina por cursor (`next`), o token
 * vai no cabeçalho `access-token`, e só entra quem o painel ainda não conhece.
 * Grupos e contatos de canais sem telefone ficam de fora.
 */

const TOKEN = 'token-do-canal-focus';

const fc = {
  server: null,
  requests: [],
  limitedOnce: false,
  pages: {
    first: {
      data: [
        { id: 'a', name: 'Ana Focus', number: '5593992220101', email: 'ana@exemplo.test', observation: 'Cliente do centro', tags: [{ name: 'VIP' }], type: 0 },
        // Já existe no painel, sem o nono dígito.
        { id: 'b', name: 'Bruno Antigo', number: '559391110002', type: 0 },
        { id: 'g', name: 'Grupo da rua', number: '120363000000000000', isGroup: true, type: 0 },
        { id: 'i', name: 'Insta', number: null, type: 2 }
      ],
      paging: { cursors: { next: 'pagina-2' } }
    },
    'pagina-2': {
      data: [
        { id: 'c', name: null, nameFromWhatsApp: 'Carla WA', number: '+55 (93) 99222-0102', email: 'nao-e-email', type: 0 },
        // A Ana de novo.
        { id: 'a2', name: 'Ana Repetida', number: '93992220101', type: 0 },
        { id: 'x', name: 'Sem Número', number: '123', type: 0 }
      ],
      paging: { cursors: { next: null } }
    }
  }
};

let panelUrl;
let token;

const importar = (mode) => call(`${panelUrl}/api/contacts/import/focuschat?mode=${mode}`, { method: 'POST', headers: authHeaders(token) });
const importados = () => asTenant(() => getDb()('sgp_contacts').where({ import_source: 'focuschat' }).orderBy('id'));

before(async () => {
  ({ panelUrl } = await startTestServers());
  fc.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    fc.requests.push({ path: url.pathname, next: url.searchParams.get('next'), token: req.headers['access-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['access-token'] !== TOKEN) {
      res.writeHead(400);
      return res.end(JSON.stringify({ status: '400', msg: 'Token inválido', errorCode: 'auth_01' }));
    }
    if (url.pathname !== '/core/v2/api/contacts/list') {
      res.writeHead(404);
      return res.end('{}');
    }
    if (fc.limitedOnce) {
      fc.limitedOnce = false;
      res.writeHead(429);
      return res.end(JSON.stringify({ status: '429', msg: 'Too many', errorCode: 'rate_01' }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify(fc.pages[url.searchParams.get('next') || 'first']));
  });
  await new Promise((resolve) => fc.server.listen(0, '127.0.0.1', resolve));
  FocusChatService.BASE_URL = `http://127.0.0.1:${fc.server.address().port}`;
  FocusChatService.RETRY_DELAYS_MS = [10, 10, 10];
  FocusChatService.PAGE_DELAY_MS = 0;

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await getDb()('sgp_contacts').insert([
    { tenant_id: 1, contract: '301', client_name: 'BRUNO', phone_e164: '5593991110002', state: 'active' }
  ]);
});

after(async () => {
  await new Promise((resolve) => fc.server.close(resolve));
  await stopTestServers();
});

describe('configuração do Focus Chat', () => {
  it('sem token configurado, a importação diz o que falta', async () => {
    const res = await importar('preview');
    assert.equal(res.status, 409, JSON.stringify(res.body));
  });

  it('o token é salvo, nunca devolvido, e o teste de conexão usa o cabeçalho access-token', async () => {
    const salvo = await call(`${panelUrl}/api/focuschat/config`, {
      method: 'PUT', headers: authHeaders(token), body: { enabled: true, token: TOKEN }
    });
    assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
    assert.equal(salvo.body.data.tokenConfigured, true);
    assert.equal(salvo.body.data.ready, true);
    assert.doesNotMatch(JSON.stringify(salvo.body), new RegExp(TOKEN));

    const lido = await call(`${panelUrl}/api/focuschat/config`, { headers: authHeaders(token) });
    assert.doesNotMatch(JSON.stringify(lido.body), new RegExp(TOKEN));

    // Um PUT sem token mantém o que está salvo.
    const semToken = await call(`${panelUrl}/api/focuschat/config`, {
      method: 'PUT', headers: authHeaders(token), body: { enabled: true }
    });
    assert.equal(semToken.body.data.tokenConfigured, true);

    const teste = await call(`${panelUrl}/api/focuschat/test`, { method: 'POST', headers: authHeaders(token), body: {} });
    assert.equal(teste.status, 200, JSON.stringify(teste.body));
    assert.equal(teste.body.data.firstPage, 4);
    assert.equal(fc.requests.at(-1).token, TOKEN);

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'focuschat.config_updated' }).orderBy('id', 'desc').first());
    assert.ok(trilha);
    assert.doesNotMatch(String(trilha.detail), new RegExp(TOKEN));
  });

  it('um token recusado volta como erro claro', async () => {
    const res = await call(`${panelUrl}/api/focuschat/test`, { method: 'POST', headers: authHeaders(token), body: { token: 'errado' } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'unauthorized');
  });
});

describe('importar do Focus Chat', () => {
  it('a prévia segue o cursor e conta novos, existentes, ignorados, inválidos e duplicados, sem gravar', async () => {
    fc.requests = [];
    fc.limitedOnce = true;
    const res = await importar('preview');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.total, 7);
    assert.equal(data.creates, 2);
    assert.equal(data.existing, 1);
    assert.equal(data.ignored, 2);
    assert.equal(data.invalid, 1);
    assert.equal(data.duplicated, 1);
    assert.deepEqual(data.rows, [
      { name: 'Ana Focus', phone: '5593992220101' },
      { name: 'Carla WA', phone: '5593992220102' }
    ]);
    assert.ok(fc.requests.some((request) => request.next === 'pagina-2'), 'pediu a segunda página pelo cursor');
    assert.equal((await importados()).length, 0, 'a prévia não grava');
  });

  it('aplicar cria só os novos, com e-mail, observação e etiquetas, e registra na trilha', async () => {
    const res = await importar('apply');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created, 2);
    const linhas = await importados();
    assert.deepEqual(linhas.map((linha) => linha.phone_e164), ['5593992220101', '5593992220102']);

    const ficha = await call(`${panelUrl}/api/contacts/c:${linhas[0].id}`, { headers: authHeaders(token) });
    assert.deepEqual(ficha.body.data.fields.emails.value, ['ana@exemplo.test']);
    assert.match(ficha.body.data.notes, /Cliente do centro/);
    assert.match(ficha.body.data.notes, /VIP/);
    const carla = await call(`${panelUrl}/api/contacts/c:${linhas[1].id}`, { headers: authHeaders(token) });
    assert.deepEqual(carla.body.data.fields.emails.value, [], 'um e-mail inválido não entra');

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contacts.imported' }).orderBy('id', 'desc').first());
    assert.match(String(trilha.detail), /focuschat/);
  });

  it('importar de novo não cria ninguém', async () => {
    const res = await importar('preview');
    assert.equal(res.body.data.creates, 0);
    assert.equal(res.body.data.existing, 3);
  });
});
