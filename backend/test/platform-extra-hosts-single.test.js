import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `PLATFORM_EXTRA_HOSTS` num SaaS de endereço único: sem `TENANT_BASE_DOMAIN`,
 * todos os provedores entram pelo mesmo endereço, e o nome extra é a única
 * porta de plataforma — a vitrine e o cadastro.
 *
 * O que se prova: o nome extra serve a página pública e o cadastro, e NÃO
 * cai no provedor padrão para o resto; o endereço compartilhado continua como
 * era, sem cadastro; e quem se cadastrou entra pelo endereço compartilhado.
 */
process.env.EDITION = 'saas';
delete process.env.TENANT_BASE_DOMAIN;
delete process.env.PORTAL_BASE_DOMAIN;
process.env.PLATFORM_EXTRA_HOSTS = 'site.test';
process.env.PUBLIC_BASE_URL = 'https://painel.site.test';

const { startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { isPlatformHost, platformExtraHosts } = await import('../src/middleware/tenantResolver.js');

let panelUrl;

function callAs(host, path, { method = 'GET', body } = {}) {
  const target = new URL(`${panelUrl}${path}`);
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
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
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

const SITE = 'site.test';
const COMPARTILHADO = 'painel.site.test';

before(async () => {
  ({ panelUrl } = await startTestServers());
  // O endereço compartilhado já tem o seu dono, como num deploy de verdade.
  const setup = await callAs(COMPARTILHADO, '/api/auth/setup', {
    method: 'POST', body: { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
});

after(async () => {
  await stopTestServers();
});

describe('o nome extra sem domínio-base', () => {
  it('é reconhecido, e só ele', () => {
    assert.deepEqual(platformExtraHosts(), ['site.test']);
    assert.equal(isPlatformHost('site.test'), true);
    assert.equal(isPlatformHost('www.site.test'), true);
    assert.equal(isPlatformHost('painel.site.test'), false);
  });

  it('serve a vitrine como plataforma e diz onde os provedores entram', async () => {
    const perfil = await callAs(SITE, '/api/tenant/public');
    assert.equal(perfil.status, 200);
    assert.equal(perfil.body.data.slug, null);
    const info = await callAs(SITE, '/api/public/info');
    assert.equal(info.body.data.panelUrl, 'https://painel.site.test');
    const plans = await callAs(SITE, '/api/public/plans');
    assert.equal(plans.status, 200);
  });

  it('não entrega o painel do provedor padrão', async () => {
    const res = await callAs(SITE, '/api/devices');
    assert.equal(res.status, 404);
    const settings = await callAs(SITE, '/api/settings');
    assert.equal(settings.status, 404);
  });

  it('cadastra, e o provedor novo entra pelo endereço compartilhado', async () => {
    const res = await callAs(SITE, '/api/auth/signup', {
      method: 'POST',
      body: {
        providerName: 'Fibra Única', slug: 'fibra-unica', username: 'dono-unica',
        email: 'dono@unica.test', password: 'senha-unica-1'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.panelUrl, 'https://painel.site.test');

    const login = await callAs(COMPARTILHADO, '/api/auth/login', {
      method: 'POST', body: { username: 'dono-unica', password: 'senha-unica-1' }
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.ok(login.body.data.token);
  });
});

describe('o endereço compartilhado', () => {
  it('continua sem cadastro e servindo o provedor', async () => {
    const signup = await callAs(COMPARTILHADO, '/api/auth/signup', {
      method: 'POST',
      body: { providerName: 'X', slug: 'provedor-x', username: 'dono-x', email: 'x@x.test', password: 'senha-x-1234' }
    });
    assert.equal(signup.status, 404);
    const perfil = await callAs(COMPARTILHADO, '/api/tenant/public');
    assert.equal(perfil.status, 200);
    assert.notEqual(perfil.body.data.slug, null);
  });
});
