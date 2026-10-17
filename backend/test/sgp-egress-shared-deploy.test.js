import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Mesma regra de `egress-guard-shared-deploy.test.js`: a edição fica no default
// (`selfhosted`), porque é exatamente o deploy que esqueceu `EDITION=saas` que
// este arquivo cobre. Importações dinâmicas para nada subir acima desta linha.
delete process.env.EDITION;

const {
  deploymentIsShared, refreshDeploymentSharing, resetDeploymentSharing
} = await import('../src/services/genieacsEgress.js');
const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');

/**
 * A guarda do SGP lia só `IS_SAAS`, e `EDITION` tem default `selfhosted`.
 *
 * O `baseUrl` do SGP chega no corpo de `POST /api/sgp/test`, atrás de
 * `sgp.config` — permissão que todo administrador de provedor tem. Num deploy
 * com vários provedores que suba sem `EDITION=saas`, esse administrador é um
 * inquilino, e a guarda deixava ele apontar a sonda para o loopback, para a VPC
 * ou para o serviço de metadados. O ACS já tinha fechado esse buraco com
 * `deploymentIsShared()`; o SGP passa a ler a mesma régua.
 *
 * E o outro lado tem que continuar valendo: a instalação de um provedor só
 * roda o SGP na LAN do operador, e `sgp.test.js` inteiro depende de um stub em
 * `127.0.0.1`.
 */
const SEGREDO = 'SEGREDO-DO-SERVICO-INTERNO';
const interno = { server: null, port: null, hits: [] };
let panelUrl;
let token;

before(async () => {
  await new Promise((resolve) => {
    interno.server = http.createServer((req, res) => {
      interno.hits.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Responde como um SGP que não achou o cliente: a sonda trata isso como
      // "URL, app e token válidos", e é o que prova que a chamada passou.
      res.end(JSON.stringify({ status: 0, msg: SEGREDO }));
    });
    interno.server.listen(0, '127.0.0.1', () => {
      interno.port = interno.server.address().port;
      resolve();
    });
  });

  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador', password: 'operador-senha-1', email: 'operador@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  // Limpeza ANTES de derrubar os servidores — depois o pool já foi destruído.
  await getDb()('tenants').where({ slug: 'segundo-provedor-sgp' }).del();
  await stopTestServers();
  await new Promise((done) => interno.server.close(done));
});

afterEach(() => {
  interno.hits.length = 0;
  resetDeploymentSharing();
});

function sondar(baseUrl) {
  return call(`${panelUrl}/api/sgp/test`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { baseUrl, app: 'painel', token: 'token-secreto-123' }
  });
}

describe('SGP com um provedor só: a LAN do operador continua alcançável', () => {
  it('a sonda chega ao loopback', async () => {
    await refreshDeploymentSharing();
    assert.equal(deploymentIsShared(), false);

    const { body } = await sondar(`http://127.0.0.1:${interno.port}`);

    assert.notEqual(body.code, 'blocked_host', JSON.stringify(body));
    assert.ok(interno.hits.length > 0, 'a sonda não chegou ao SGP da LAN');
  });
});

describe('SGP num deploy compartilhado sem EDITION: a guarda passa a valer', () => {
  before(async () => {
    await getDb()('tenants').insert({
      slug: 'segundo-provedor-sgp', name: 'Segundo Provedor', status: 'active'
    });
  });

  it('recusa o loopback, e não devolve nada do serviço interno', async () => {
    assert.equal(process.env.EDITION, undefined, 'o teste perde o sentido com a variável posta');
    await refreshDeploymentSharing();
    assert.equal(deploymentIsShared(), true);

    const { status, body } = await sondar(`http://127.0.0.1:${interno.port}`);

    assert.deepEqual(interno.hits, [], 'a sonda alcançou o serviço interno');
    assert.equal(status, 400);
    assert.equal(body.code, 'blocked_host');
    assert.ok(!JSON.stringify(body).includes(SEGREDO));
  });

  it('recusa faixa privada e o serviço de metadados', async () => {
    await refreshDeploymentSharing();
    for (const baseUrl of ['http://10.0.0.5', 'http://192.168.1.1:8080', 'http://169.254.169.254']) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await sondar(baseUrl);
      assert.equal(status, 400, `${baseUrl} não foi recusado: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'blocked_host', baseUrl);
    }
  });
});
