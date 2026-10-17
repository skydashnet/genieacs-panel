import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Configurações → Dados do SaaS: o que o console grava, o que o `.env` ainda
 * responde, e o que a página pública mostra.
 */
process.env.EDITION = 'saas';
process.env.PLATFORM_LEGAL_NAME = 'Do Ambiente LTDA';
process.env.PLATFORM_CONTACT_WHATSAPP = '+55 (11) 98888-7777';

const { authHeaders, call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');

let panelUrl;
let token;

const perfil = (options = {}) => call(`${panelUrl}/api/platform/settings/profile`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  const db = getDb();
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
});

after(async () => {
  await stopTestServers();
});

describe('sem a caixa da plataforma', () => {
  it('lê o ambiente e recusa gravar', async () => {
    const res = await perfil();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.values.legalName, 'Do Ambiente LTDA');
    assert.equal(res.body.data.sources.legalName, 'env');
    assert.equal(res.body.data.values.contactWhatsapp, '5511988887777');
    assert.equal(res.body.data.canSave, false);
    const put = await perfil({ method: 'PUT', body: { legalName: 'X' } });
    assert.equal(put.status, 409);
  });
});

describe('com a caixa da plataforma', () => {
  before(async () => {
    await getDb()('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
    invalidatePlatformProfile();
  });

  it('grava, prevalece sobre o ambiente e aparece no site', async () => {
    const put = await perfil({
      method: 'PUT',
      body: {
        legalName: 'Tavares Telecom LTDA',
        tradeName: 'TR69',
        taxId: '11222333000181',
        address: 'Rua A, 1 - Centro, Santarém/PA',
        contactEmail: 'contato@tr69.test',
        contactWhatsapp: '(93) 99193-5695',
        notifyWhatsapp: '93991935695',
        instagram: '@tr69',
        youtube: 'youtube.com/@tr69'
      }
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const { values, sources } = put.body.data;
    assert.equal(values.legalName, 'Tavares Telecom LTDA');
    assert.equal(sources.legalName, 'db');
    assert.equal(values.taxId, '11.222.333/0001-81');
    assert.equal(values.contactWhatsapp, '5593991935695');
    assert.equal(values.instagram, 'https://www.instagram.com/tr69');
    assert.equal(values.youtube, 'https://youtube.com/@tr69');

    const info = await call(`${panelUrl}/api/public/info`);
    assert.equal(info.status, 200);
    assert.equal(info.body.data.productName, 'TR69');
    assert.equal(info.body.data.legalName, 'Tavares Telecom LTDA');
    assert.equal(info.body.data.contactWhatsapp, '5593991935695');
    assert.equal(info.body.data.social.instagram, 'https://www.instagram.com/tr69');
    assert.equal(info.body.data.social.facebook, null);
  });

  it('vazio apaga o gravado e o ambiente volta a valer', async () => {
    const put = await perfil({ method: 'PUT', body: { legalName: '' } });
    assert.equal(put.status, 200);
    assert.equal(put.body.data.values.legalName, 'Do Ambiente LTDA');
    assert.equal(put.body.data.sources.legalName, 'env');
    // O que não veio no corpo fica como estava.
    assert.equal(put.body.data.values.tradeName, 'TR69');
  });

  it('recusa CNPJ, e-mail, telefone e link inválidos, dizendo o campo', async () => {
    for (const [campo, valor] of [
      ['taxId', '11222333000100'],
      ['contactEmail', 'nao-e-email'],
      ['notifyWhatsapp', '123'],
      ['facebook', 'https://exemplo.com/pagina']
    ]) {
      const res = await perfil({ method: 'PUT', body: { [campo]: valor } });
      assert.equal(res.status, 400, campo);
      assert.equal(res.body.field, campo);
    }
  });

  it('registra na trilha da plataforma só os nomes dos campos', async () => {
    const linha = await getDb()('platform_audit').where({ action: 'platform.profile_changed' }).orderBy('id', 'desc').first();
    assert.ok(linha);
    assert.deepEqual(JSON.parse(linha.detail).fields, ['legalName']);
  });

  it('não existe para quem não tem a chave do console', async () => {
    const res = await call(`${panelUrl}/api/platform/settings/profile`);
    assert.ok([401, 404].includes(res.status));
  });
});
