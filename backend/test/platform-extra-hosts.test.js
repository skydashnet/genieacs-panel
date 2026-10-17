import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `PLATFORM_EXTRA_HOSTS`: o domínio de marketing respondendo como o ápice.
 *
 * O que se prova é a fronteira dos dois lados: o nome configurado (e o `www.`
 * dele) serve a página pública e o perfil de plataforma; um nome que ninguém
 * configurou continua 404; e um nome que o resolvedor leria como provedor é
 * descartado, e segue sendo o provedor.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';
process.env.PLATFORM_EXTRA_HOSTS = ' Site.test , painel.test, default.painel.test,, site.test';

const { startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { isPlatformHost, platformExtraHosts } = await import('../src/middleware/tenantResolver.js');

let panelUrl;

function callAs(host, path) {
  const target = new URL(`${panelUrl}${path}`);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { Host: host }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        resolve({ status: response.statusCode, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('a lista de nomes extras', () => {
  it('normaliza, tira repetidos e descarta o que nomeia o painel ou um provedor', () => {
    assert.deepEqual(platformExtraHosts(), ['site.test']);
  });

  it('reconhece o nome e o www dele, e nada além', () => {
    assert.equal(isPlatformHost('site.test'), true);
    assert.equal(isPlatformHost('www.site.test'), true);
    assert.equal(isPlatformHost('painel.test'), true);
    assert.equal(isPlatformHost('outro.test'), false);
    assert.equal(isPlatformHost('x.site.test'), false);
  });
});

describe('o nome extra servindo como o ápice', () => {
  it('responde a página pública e o perfil de plataforma', async () => {
    for (const host of ['site.test', 'www.site.test']) {
      const plans = await callAs(host, '/api/public/plans');
      assert.equal(plans.status, 200, host);
      const perfil = await callAs(host, '/api/tenant/public');
      assert.equal(perfil.status, 200, host);
      assert.equal(perfil.body.data.slug, null);
      assert.equal(perfil.body.data.panelBaseDomain, 'painel.test');
    }
  });

  it('recusa as rotas de provedor, como o ápice recusa', async () => {
    const res = await callAs('site.test', '/api/devices');
    assert.equal(res.status, 404);
  });

  it('um nome que ninguém configurou continua 404', async () => {
    const res = await callAs('outro.test', '/api/public/plans');
    assert.equal(res.status, 404);
  });

  it('o provedor listado por engano continua sendo o provedor', async () => {
    const res = await callAs('default.painel.test', '/api/tenant/public');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.slug, 'default');
    const plans = await callAs('default.painel.test', '/api/public/plans');
    assert.equal(plans.status, 404);
  });
});
