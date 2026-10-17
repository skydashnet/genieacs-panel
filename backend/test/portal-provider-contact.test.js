import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: CustomerPortalPasswordService } = await import('../src/services/customerPortalPasswordService.js');

/**
 * "Fale com seu provedor" no portal do assinante.
 *
 * O que se defende: desligado (o padrão), nada do provedor sai; ligado, sai
 * exatamente nome, telefone, WhatsApp, e-mail e endereço — nunca o CNPJ nem
 * a inscrição estadual, mesmo com o cadastro fiscal preenchido; os campos
 * das configurações valem sobre o cadastro; sem sessão do portal, 401; e o
 * contato de outro provedor não aparece.
 */
const CUSTOMER_ID = 'CSG-CONTACT-123456';
const CNPJ = '11222333000181';
let panelUrl;
let portalUrl;
let token;
let cookie;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  const tenantId = await defaultTenantId();
  await db('tenants').where({ id: tenantId }).update({
    name: 'Fibra Itaituba',
    billing_legal_name: 'Fibra Itaituba Telecom LTDA',
    billing_tax_id: CNPJ,
    billing_state_registration: '151234567',
    billing_phone: '93 3518-0000',
    billing_email: 'contato@fibra.test',
    billing_address_line: 'Rodovia Transamazônica',
    billing_address_number: '100',
    billing_district: 'Bela Vista',
    billing_city: 'Itaituba',
    billing_state: 'PA',
    billing_postal_code: '68180010'
  });
  await db('tenants').insert({ slug: 'outro', name: 'Outro Provedor', status: 'active', billing_phone: '11 99999-0000' });

  const created = await CustomerPortalPasswordService.createRecord();
  await db('customer_accounts').insert({
    tenant_id: tenantId,
    customer_id: CUSTOMER_ID,
    device_id: 'contact-device-1',
    identity_hash: 'contact'.padEnd(64, '0'),
    software_id: 'V1.0.0',
    pppoe_username: 'contato@isp',
    active: true,
    ...created.record
  });
  const login = await call(`${portalUrl}/api/customer/login`, {
    method: 'POST',
    body: { customerId: CUSTOMER_ID, password: created.password }
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  cookie = login.response.headers.getSetCookie().find((entry) => entry.startsWith('skygp_portal_session=')).split(';')[0];
});

after(async () => {
  await stopTestServers();
});

const contato = (headers = { Cookie: cookie }) => call(`${portalUrl}/api/customer/provider`, { headers });
const salvar = (key, value) => call(`${panelUrl}/api/settings/${key}`, { method: 'PUT', headers: authHeaders(token), body: { value } });

describe('GET /api/customer/session', () => {
  it('leva o formato de data do provedor', async () => {
    const sessao = () => call(`${portalUrl}/api/customer/session`, { headers: { Cookie: cookie } });
    assert.equal((await sessao()).body.data.dateFormat, 'auto');
    assert.equal((await salvar('dateFormat', 'dd/MM/yyyy')).status, 200);
    assert.equal((await sessao()).body.data.dateFormat, 'dd/MM/yyyy');
    assert.equal((await salvar('dateFormat', 'auto')).status, 200);
  });
});

describe('GET /api/customer/provider', () => {
  it('sem sessão do portal, 401', async () => {
    const res = await contato({});
    assert.equal(res.status, 401);
  });

  it('desligado por padrão: só enabled:false, nem o nome', async () => {
    const res = await contato();
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'provider_ok');
    assert.deepEqual(res.body.data, { enabled: false });
  });

  it('ligado: exatamente as chaves do contato, e o CNPJ nunca', async () => {
    assert.equal((await salvar('portalShowProviderContact', 'true')).status, 200);
    const res = await contato();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.data).sort(), ['address', 'email', 'enabled', 'name', 'phone', 'whatsapp']);
    assert.equal(res.body.data.name, 'Fibra Itaituba');
    assert.equal(res.body.data.phone, '93 3518-0000');
    assert.equal(res.body.data.email, 'contato@fibra.test');
    assert.equal(res.body.data.whatsapp, null);
    assert.match(res.body.data.address, /Rodovia Transamazônica, 100/);
    assert.match(res.body.data.address, /Itaituba - PA/);
    const corpo = JSON.stringify(res.body);
    assert.ok(!corpo.includes(CNPJ), 'o CNPJ não sai no portal');
    assert.ok(!corpo.includes('151234567'), 'a inscrição estadual não sai no portal');
    assert.ok(!corpo.includes('LTDA'), 'a razão social não sai no portal');
    assert.ok(!corpo.includes('99999-0000'), 'o contato de outro provedor não aparece');
  });

  it('os campos das configurações valem sobre o cadastro', async () => {
    assert.equal((await salvar('portalContactPhone', '(93) 3518-1111')).status, 200);
    assert.equal((await salvar('portalContactWhatsapp', '93 99100-2222')).status, 200);
    assert.equal((await salvar('portalContactEmail', 'suporte@fibra.test')).status, 200);
    const res = await contato();
    assert.equal(res.body.data.phone, '(93) 3518-1111');
    assert.equal(res.body.data.whatsapp, '93 99100-2222');
    assert.equal(res.body.data.email, 'suporte@fibra.test');
    // Esvaziar volta ao cadastro.
    assert.equal((await salvar('portalContactPhone', '')).status, 200);
    assert.equal((await contato()).body.data.phone, '93 3518-0000');
  });

  it('desligar de novo esconde tudo', async () => {
    await asTenant(() => Setting.upsert('portalShowProviderContact', 'false'));
    assert.deepEqual((await contato()).body.data, { enabled: false });
  });
});

describe('validação das configurações do contato', () => {
  it('recusa telefone, e-mail e chave fora do formato', async () => {
    assert.equal((await salvar('portalShowProviderContact', 'sim')).status, 400);
    assert.equal((await salvar('portalContactPhone', '123')).status, 400);
    assert.equal((await salvar('portalContactWhatsapp', 'liga pra mim')).status, 400);
    assert.equal((await salvar('portalContactEmail', 'nao-e-email')).status, 400);
  });
});

describe('Tenant.PORTAL_CONTACT_COLUMNS', () => {
  it('não contém coluna fiscal nem de gateway', () => {
    for (const coluna of ['billing_tax_id', 'billing_state_registration', 'billing_legal_name', ...Tenant.GATEWAY_COLUMNS]) {
      assert.ok(!Tenant.PORTAL_CONTACT_COLUMNS.includes(coluna), coluna);
    }
  });
});
