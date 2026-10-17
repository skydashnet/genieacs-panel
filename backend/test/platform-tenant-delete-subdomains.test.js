import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Apagar o ÚLTIMO provedor, num deploy com subdomínio por provedor.
 *
 * `platform-tenant-delete.test.js` guarda a operação inteira, e guarda também a
 * regra que protege o último — que existe por uma razão de resolução, não de
 * negócio: sem nenhum provedor, `resolveDefaultTenantId` devolve null e o
 * deployment inteiro responde 503, inclusive para quem acabou de apagar.
 *
 * Onde o HOST nomeia o provedor, nada disso se aplica: a resolução vem do
 * endereço, aquela função nunca é chamada, e o console vive no endereço da
 * plataforma, que continua de pé. Um SaaS com zero provedores é um estado
 * coerente — é um SaaS sem clientes ainda, ou que acabou de perder o último —,
 * e proibir apagar ali seria obrigar todo deploy a manter para sempre o
 * provedor `default` que a migração cria sozinha.
 *
 * Arquivo separado porque o domínio-base é lido no import, e `Host` é header
 * proibido no `fetch`.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

let panelUrl;
let casa;
let consoleToken;

const APEX = 'painel.test';
const CASA = 'default.painel.test';
const noConsole = (path, options = {}) => callAs(APEX, `${panelUrl}${path}`, {
  ...options,
  headers: { Authorization: `Bearer ${consoleToken}`, ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  casa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  const setup = await callAs(CASA, `${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'plataforma', password: 'senha-da-plataforma-1', email: 'plataforma@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));

  const entrada = await callAs(APEX, `${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'plataforma', password: 'senha-da-plataforma-1' }
  });
  assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
  consoleToken = entrada.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('o último provedor, onde o host nomeia provedores', () => {
  it('sai — e o console continua de pé sem nenhum', async () => {
    assert.equal((await getDb()('tenants')).length, 1, 'o cenário precisa de um provedor só');

    // As outras três condições continuam valendo: suspender antes, digitar o
    // slug exato, e a trilha gravada antes. O que caiu é só a quarta.
    const semSuspender = await noConsole(`/api/platform/tenants/${casa}`, {
      method: 'DELETE', body: { confirmSlug: 'default' }
    });
    assert.equal(semSuspender.status, 409, 'apagar um provedor ativo passou');

    const suspenso = await noConsole(`/api/platform/tenants/${casa}`, {
      method: 'PATCH', body: { status: 'suspended' }
    });
    assert.equal(suspenso.status, 200, JSON.stringify(suspenso.body));

    const semSlug = await noConsole(`/api/platform/tenants/${casa}`, {
      method: 'DELETE', body: { confirmSlug: 'Default' }
    });
    assert.equal(semSlug.status, 409, 'o slug quase certo passou');

    const apagado = await noConsole(`/api/platform/tenants/${casa}`, {
      method: 'DELETE', body: { confirmSlug: 'default' }
    });
    assert.equal(apagado.status, 200, JSON.stringify(apagado.body));
    assert.equal((await getDb()('tenants')).length, 0);

    // O console responde com zero provedores: ele não pertence a nenhum, então
    // não há o que o derrube junto.
    const lista = await noConsole('/api/platform/tenants');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    assert.deepEqual(lista.body.data.tenants, []);

    // E a trilha do plano de controle sobrevive ao provedor, como sempre.
    const linha = await getDb()('platform_audit')
      .where({ action: 'tenant.deleted' }).orderBy('id', 'desc').first();
    assert.ok(linha, 'apagar não deixou linha na trilha da plataforma');
    assert.equal(linha.tenant_slug, 'default');
  });

  it('e o console segue servindo para criar o próximo', async () => {
    const criado = await noConsole('/api/platform/tenants', {
      method: 'POST', body: { slug: 'novo', name: 'ISP Novo' }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.equal((await getDb()('tenants')).length, 1);
  });
});
