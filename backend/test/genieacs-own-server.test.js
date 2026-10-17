import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O provedor com o próprio GenieACS, na SaaS.
 *
 * Por padrão o ACS de todo provedor é da plataforma: o console grava endereço,
 * credencial e parâmetros TR-069, e o provedor recebe 403 (ver
 * `platform-managed-settings.test.js`). O console pode marcar um provedor como
 * dono do próprio servidor (`ownership = 'own'`); aí essas três coisas voltam
 * para as mãos dele — e só dele, não dos vizinhos. O que ele não pode é gravar
 * o endereço do ACS de outro provedor.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');

const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };
const BETA_ACS = 'https://acs-beta.exemplo.test:7557';

let panelUrl;
let alfa;
let beta;
let token;

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

const consolePut = (tenantId, body) => api(`/platform/tenants/${tenantId}/genieacs`, { method: 'PUT', body });

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201, 'não criou o primeiro administrador');
  token = setup.body.data.token;
  const userId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: userId }).first())) {
    await getDb()('platform_admins').insert({ user_id: userId });
  }

  const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
  assert.equal(criado.status, 201);
  beta = criado.body.data.tenant.id;
  await runInTenant(beta, () => Setting.upsert('genieAcsUrl', BETA_ACS));
});

after(async () => {
  await stopTestServers();
});

describe('ACS da plataforma (o padrão)', () => {
  it('o provedor não grava endereço, credencial nem parâmetros TR-069', async () => {
    assert.equal((await api('/settings/genieAcsUrl', { method: 'PUT', body: { value: 'https://meu.exemplo.test' } })).status, 403);
    assert.equal((await api('/settings/vpRxPower', { method: 'PUT', body: { value: 'VirtualParameters.RX' } })).status, 403);
    const auth = await api('/settings/genieacs-auth', { method: 'PUT', body: { authType: 'bearer', secret: 'x' } });
    assert.equal(auth.status, 403);
  });

  it('a tela sabe que é só leitura', async () => {
    const { status, body } = await api('/settings/genieacs-auth');
    assert.equal(status, 200);
    assert.equal(body.data.platformManaged, true);
  });

  it('o console mostra quem administra', async () => {
    const { status, body } = await api(`/platform/tenants/${alfa}/genieacs`);
    assert.equal(status, 200);
    assert.equal(body.data.ownership, 'platform');
  });
});

describe('o console marca o ACS como do provedor', () => {
  it('recusa valor desconhecido', async () => {
    const { status } = await consolePut(alfa, { ownership: 'vizinho' });
    assert.equal(status, 400);
  });

  it('grava só no provedor pedido, com trilha dos dois lados', async () => {
    const { status, body } = await consolePut(alfa, { ownership: 'own' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.ownership, 'own');
    assert.equal(await runInTenant(alfa, () => GenieAcsConnection.ownership()), 'own');
    assert.equal(await runInTenant(beta, () => GenieAcsConnection.ownership()), 'platform');

    const doProvedor = await getDb()('audit_log').where({ tenant_id: alfa, action: 'genieacs.ownership_changed' });
    assert.equal(doProvedor.length, 1);
    const daPlataforma = await getDb()('platform_audit')
      .where({ action: 'tenant.genieacs_changed', tenant_id: alfa })
      .orderBy('id', 'desc')
      .first();
    assert.match(String(daPlataforma?.detail ?? ''), /ownership/);
  });

  it('o provedor passa a gravar endereço, credencial e parâmetros TR-069', async () => {
    const url = await api('/settings/genieAcsUrl', { method: 'PUT', body: { value: 'https://acs-alfa.exemplo.test:7557' } });
    assert.equal(url.status, 200, JSON.stringify(url.body));
    const vp = await api('/settings/vpRxPower', { method: 'PUT', body: { value: 'VirtualParameters.RXAlfa' } });
    assert.equal(vp.status, 200);
    const auth = await api('/settings/genieacs-auth', {
      method: 'PUT',
      body: { authType: 'basic', username: 'nbi', secret: 'segredo' }
    });
    assert.equal(auth.status, 200, JSON.stringify(auth.body));
    assert.equal(auth.body.data.platformManaged, false);
    assert.equal((await api('/settings/genieacs-auth')).body.data.platformManaged, false);
  });

  it('mas não o endereço do ACS de outro provedor', async () => {
    const { status, body } = await api('/settings/genieAcsUrl', {
      method: 'PUT',
      body: { value: `${BETA_ACS}/outro/caminho` }
    });
    assert.equal(status, 409);
    assert.equal(body.code, 'genieacs_origin_in_use');
    assert.equal(
      await runInTenant(alfa, () => Setting.getByKey('genieAcsUrl')),
      'https://acs-alfa.exemplo.test:7557',
      'o endereço do alfa ficou como estava'
    );
  });

  it('o vizinho continua com o ACS da plataforma', async () => {
    const vizinho = await runInTenant(beta, async () => (await import('../src/config/platformManaged.js'))
      .platformManagesGenieAcsCurrentTenant());
    assert.equal(vizinho, true);
  });

  it('voltar para a plataforma fecha a porta e mantém o que ele gravou', async () => {
    const { status } = await consolePut(alfa, { ownership: 'platform' });
    assert.equal(status, 200);
    const recusado = await api('/settings/genieAcsUrl', { method: 'PUT', body: { value: 'https://outro.exemplo.test' } });
    assert.equal(recusado.status, 403);
    assert.equal(await runInTenant(alfa, () => Setting.getByKey('genieAcsUrl')), 'https://acs-alfa.exemplo.test:7557');
    assert.equal(await runInTenant(alfa, () => Setting.getByKey('vpRxPower')), 'VirtualParameters.RXAlfa');
  });
});
