import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/**
 * O formato da data é do provedor e vale para toda a equipe: grava-se em
 * Configurações (`settings.write`) e lê-se por `GET /api/settings/display`,
 * que só pede sessão — quem não abre as configurações também vê datas.
 */
let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => { await stopTestServers(); });

const display = (headers = authHeaders(token)) => call(`${panelUrl}/api/settings/display`, { headers });
const salvar = (value) => call(`${panelUrl}/api/settings/dateFormat`, {
  method: 'PUT', headers: authHeaders(token), body: { value }
});

describe('formato da data', () => {
  it('sem nada salvo, segue o idioma', async () => {
    const res = await display();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { dateFormat: 'auto' });
  });

  it('grava um formato da lista e toda sessão passa a lê-lo', async () => {
    assert.equal((await salvar('dd/MM/yyyy')).status, 200);
    assert.equal((await display()).body.data.dateFormat, 'dd/MM/yyyy');
    const lista = await call(`${panelUrl}/api/settings`, { headers: authHeaders(token) });
    assert.equal(lista.body.data.dateFormat, 'dd/MM/yyyy', 'a tela de configurações relê o que gravou');
  });

  it('recusa formato fora da lista', async () => {
    const res = await salvar('dd/mm/aa');
    assert.equal(res.status, 400);
    assert.equal((await display()).body.data.dateFormat, 'dd/MM/yyyy');
  });

  it('sem sessão, 401', async () => {
    assert.equal((await display({})).status, 401);
  });
});
