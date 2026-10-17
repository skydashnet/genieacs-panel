import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Na self-hosted não existe console: o dono da instalação é o provedor, e tudo
 * o que na SaaS é da plataforma continua editável na tela de Configuração
 * dele. O par deste arquivo é `platform-managed-settings.test.js`.
 */
const {
  authHeaders, call, startTestServers, stopTestServers
} = await import('./helpers/harness.js');

const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };

let panelUrl;
let token;

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('self-hosted: o provedor configura a própria infraestrutura', () => {
  it('grava a URL do GenieACS', async () => {
    const { status } = await api('/settings/genieAcsUrl', { method: 'PUT', body: { value: 'http://acs.local:7557' } });
    assert.equal(status, 200);
  });

  it('grava os parâmetros TR-069', async () => {
    const { status } = await api('/settings/vpRxPower', { method: 'PUT', body: { value: 'VirtualParameters.RX' } });
    assert.equal(status, 200);
  });

  it('grava a credencial da NBI', async () => {
    const { status } = await api('/settings/genieacs-auth', {
      method: 'PUT',
      body: { authType: 'bearer', secret: 'token' }
    });
    assert.equal(status, 200);
  });

  it('e o servidor Evolution', async () => {
    const { status, body } = await api('/whatsapp/config', {
      method: 'PUT',
      body: { managedUrl: 'https://evo.local.test', managedAdminKey: 'k' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.managedUrl, 'https://evo.local.test');
    assert.equal(body.data.platformManaged, false);
  });

  it('sem teto de retenção', async () => {
    const { status } = await api('/whatsapp/config', { method: 'PUT', body: { messageRetentionDays: 0 } });
    assert.equal(status, 200);
    const trilha = await api('/settings/auditRetentionDays', { method: 'PUT', body: { value: '3650' } });
    assert.equal(trilha.status, 200);
  });
});
