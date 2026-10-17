import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O endereço de GenieACS que o painel SUGERE a um provedor que está nascendo.
 *
 * O caso que dá razão ao arquivo é o terceiro bloco: a sugestão passa pela
 * MESMA guarda de egresso que a gravação. Sugerir um endereço que o botão
 * Salvar recusaria entregaria ao operador uma mensagem sobre allowlist de
 * portas referente a um valor que ele não digitou — e a culpa pareceria dele.
 *
 * `EDITION=saas` porque é onde a guarda vale: num deploy de um provedor só ela
 * não se aplica, e o mesmo template passaria. As duas metades estão medidas.
 */
process.env.EDITION = 'saas';

const { suggestGenieAcsUrl } = await import('../src/services/genieacsSuggestion.js');
const { authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/** Um provedor como o serviço o enxerga: só o que o template consome. */
const PROVEDOR = { id: 7, slug: 'alfa' };

describe('a sugestão de endereço do ACS', () => {
  it('substitui o slug e o id do provedor', () => {
    assert.equal(
      suggestGenieAcsUrl(PROVEDOR, 'https://acs-{slug}.exemplo.test'),
      'https://acs-alfa.exemplo.test'
    );
    assert.equal(
      suggestGenieAcsUrl(PROVEDOR, 'https://acs.exemplo.test/{id}/{slug}'),
      'https://acs.exemplo.test/7/alfa'
    );
  });

  it('e sem template não sugere nada', () => {
    assert.equal(suggestGenieAcsUrl(PROVEDOR, undefined), null);
    assert.equal(suggestGenieAcsUrl(PROVEDOR, ''), null);
    assert.equal(suggestGenieAcsUrl(PROVEDOR, '   '), null);
  });

  it('e sem provedor em mãos também não', () => {
    assert.equal(suggestGenieAcsUrl(null, 'https://acs-{slug}.exemplo.test'), null);
  });

  /**
   * Um marcador que não existe fica cru no texto, e um endereço com `{tenant}`
   * dentro é pior que endereço nenhum: o campo APARECE preenchido, e o erro só
   * se revela no Salvar.
   */
  it('e um marcador desconhecido invalida a sugestão inteira', () => {
    assert.equal(suggestGenieAcsUrl(PROVEDOR, 'https://acs-{tenant}.exemplo.test'), null);
  });

  it('e um template que não é URL, idem', () => {
    assert.equal(suggestGenieAcsUrl(PROVEDOR, 'acs-{slug}.exemplo.test'), null);
    assert.equal(suggestGenieAcsUrl(PROVEDOR, 'ftp://acs-{slug}.exemplo.test'), null);
  });

  it('e credencial embutida não se sugere', () => {
    // O conector recusa `user:senha@` na base — sugeri-la seria sugerir o que
    // não se consegue gravar.
    assert.equal(suggestGenieAcsUrl(PROVEDOR, 'https://u:s@acs-{slug}.exemplo.test'), null);
  });
});

/**
 * O caso que importa.
 */
describe('e a sugestão passa pela guarda de egresso', () => {
  it('7547 é do CWMP e não se sugere', () => {
    // A porta por onde as ONTs falam com o ACS. A NBI, que é o que o painel
    // consome, é 7557 — e é a allowlist que diz isso, não um comentário.
    assert.equal(suggestGenieAcsUrl(PROVEDOR, 'http://acs.exemplo.test:7547'), null);
    assert.equal(
      suggestGenieAcsUrl(PROVEDOR, 'http://acs.exemplo.test:7557'),
      'http://acs.exemplo.test:7557'
    );
  });

  it('e as portas que a guarda aceita, sim', () => {
    for (const porta of [80, 443, 7557, 8080]) {
      const molde = `http://acs-{slug}.exemplo.test:${porta}`;
      assert.equal(suggestGenieAcsUrl(PROVEDOR, molde), `http://acs-alfa.exemplo.test:${porta}`);
    }
  });

  it('e o esquema sem porta explícita vale pela porta dele', () => {
    assert.equal(
      suggestGenieAcsUrl(PROVEDOR, 'https://acs-{slug}.exemplo.test'),
      'https://acs-alfa.exemplo.test'
    );
    assert.equal(suggestGenieAcsUrl(PROVEDOR, 'http://acs-{slug}.exemplo.test:9999'), null);
  });
});

describe('e a rota que a serve', () => {
  let panelUrl;
  let token;
  let tokenDeViewer;

  before(async () => {
    ({ panelUrl } = await startTestServers());
    process.env.GENIEACS_URL_TEMPLATE = 'https://acs-{slug}.exemplo.test';

    const setup = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
    });
    assert.equal(setup.status, 201);
    token = setup.body.data.token;

    const criado = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(token),
      body: {
        username: 'so-olha', password: 'senha-de-quem-olha-1',
        role: 'viewer', email: 'so-olha@exemplo.test'
      }
    });
    assert.equal(criado.status, 201);
    const entrou = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'so-olha', password: 'senha-de-quem-olha-1' }
    });
    tokenDeViewer = entrou.body.data.token;
  });

  after(async () => {
    await stopTestServers();
    delete process.env.GENIEACS_URL_TEMPLATE;
  });

  const ler = (comToken) =>
    call(`${panelUrl}/api/settings/genieacs-suggestion`, { headers: authHeaders(comToken) });

  it('devolve o endereço do provedor em escopo', async () => {
    const resposta = await ler(token);
    assert.equal(resposta.status, 200);
    // O slug é o do provedor que o `setup` criou, seja ele qual for — o que se
    // afirma é que a rota leu o provedor em escopo, e não um fixo.
    assert.match(resposta.body.data.suggestion, /^https:\/\/acs-.+\.exemplo\.test$/);
  });

  it('e é a rota, não uma chave chamada "genieacs-suggestion"', async () => {
    // `/:key` casa com qualquer segmento: declarada depois dele, esta rota
    // cairia em `getSettingByKey` e responderia 404 com a mensagem errada.
    const { body } = await ler(token);
    assert.ok('suggestion' in body.data, JSON.stringify(body.data));
  });

  it('sem sessão, 401', async () => {
    assert.equal((await call(`${panelUrl}/api/settings/genieacs-suggestion`)).status, 401);
  });

  it('e quem não pode gravar a URL não lê a sugestão dela', async () => {
    assert.equal((await ler(tokenDeViewer)).status, 403);
  });
});
