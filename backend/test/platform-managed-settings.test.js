import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A fronteira entre o console e a tela de Configuração do provedor, na SaaS.
 *
 * Três coisas passaram a ser da plataforma: o GenieACS de cada provedor, o
 * servidor Evolution de todos e os tetos de retenção do plano. E o catálogo
 * padrão passou a poder ser reenviado. O que este arquivo guarda é que o
 * provedor não escreve o que não é dele, que o console escreve no provedor
 * certo e só nele, e que o que o provedor ajustou continua dele.
 *
 * A edição self-hosted, onde nada disso muda, está em
 * `platform-managed-settings-selfhosted.test.js`.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, insertReturningId, runInTenant,
  startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');
const { adoptPlatformWhatsAppServer } = await import('../src/config/seed.js');

const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };

let panelUrl;
let alfa;
let beta;
let caixa;
let token;

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

const vendor = (name, priority = 10) => ({
  name,
  manufacturer_patterns: JSON.stringify(['acme']),
  product_patterns: JSON.stringify([name]),
  wifi_password_path: 'WLANConfiguration.1.KeyPassphrase',
  priority,
  enabled: true
});

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

  caixa = await Tenant.create({ slug: 'plataforma', name: 'Plataforma', kind: 'platform' });
});

after(async () => {
  await stopTestServers();
});

describe('o GenieACS, pelo lado do provedor', () => {
  it('não grava a URL do ACS', async () => {
    for (const [method, path, body] of [
      ['POST', '/settings', { key: 'genieAcsUrl', value: 'http://meu-acs.test:7557' }],
      ['PUT', '/settings/genieAcsUrl', { value: 'http://meu-acs.test:7557' }],
      ['DELETE', '/settings/genieAcsUrl', undefined]
    ]) {
      const { status, body: resposta } = await api(path, { method, body });
      assert.equal(status, 403, `${method} ${path}`);
      assert.equal(resposta.code, 'platform_managed');
    }
  });

  it('nem a credencial da NBI', async () => {
    const { status, body } = await api('/settings/genieacs-auth', {
      method: 'PUT',
      body: { authType: 'bearer', secret: 'token' }
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'platform_managed');
  });

  it('nem os parâmetros TR-069, que dependem do ACS da plataforma', async () => {
    const { status, body } = await api('/settings/vpRxPower', { method: 'PUT', body: { value: 'VirtualParameters.RX' } });
    assert.equal(status, 403);
    assert.equal(body.code, 'platform_managed');
  });

  it('mas continua lendo a credencial e gravando o que é dele', async () => {
    assert.equal((await api('/settings/genieacs-auth')).status, 200);
    const { status } = await api('/settings/customerIdPrefixMode', { method: 'PUT', body: { value: 'default' } });
    assert.equal(status, 200);
  });
});

describe('o GenieACS, pelo console', () => {
  it('grava a URL e a credencial do provedor pedido, e só dele', async () => {
    const betaAntes = await runInTenant(beta, () => Setting.getByKey('genieAcsUrl'));

    const { status, body } = await api(`/platform/tenants/${alfa}/genieacs`, {
      method: 'PUT',
      body: { url: 'http://acs-alfa.exemplo.test:7557', authType: 'basic', username: 'nbi', secret: 'segredo' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.url, 'http://acs-alfa.exemplo.test:7557');
    assert.equal(body.data.auth.authType, 'basic');
    assert.equal(body.data.auth.secretConfigured, true);
    assert.equal(JSON.stringify(body).includes('segredo'), false, 'o segredo não volta nunca');

    assert.equal(await runInTenant(alfa, () => Setting.getByKey('genieAcsUrl')), 'http://acs-alfa.exemplo.test:7557');
    assert.equal(await runInTenant(beta, () => Setting.getByKey('genieAcsUrl')), betaAntes, 'o beta ficou como estava');
  });

  it('grava os parâmetros TR-069 do provedor pedido, e recusa chave desconhecida', async () => {
    const { status, body } = await api(`/platform/tenants/${alfa}/genieacs`, {
      method: 'PUT',
      body: { virtualParameters: { vpRxPower: 'VirtualParameters.RXAlfa' } }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.virtualParameters.vpRxPower, 'VirtualParameters.RXAlfa');
    assert.equal(await runInTenant(alfa, () => Setting.getByKey('vpRxPower')), 'VirtualParameters.RXAlfa');
    assert.notEqual(await runInTenant(beta, () => Setting.getByKey('vpRxPower')), 'VirtualParameters.RXAlfa');

    const ruim = await api(`/platform/tenants/${alfa}/genieacs`, {
      method: 'PUT',
      body: { virtualParameters: { appName: 'x' } }
    });
    assert.equal(ruim.status, 400);
  });

  it('deixa rastro nas duas trilhas', async () => {
    const nossa = await getDb()('platform_audit')
      .where({ action: 'tenant.genieacs_changed', tenant_id: alfa }).first();
    assert.ok(nossa);
    assert.equal(nossa.detail.includes('segredo'), false);
    const dele = await getDb()('audit_log')
      .where({ tenant_id: alfa, action: 'genieacs.url_changed', actor_kind: 'platform' }).first();
    assert.ok(dele, 'o provedor precisa ver na trilha dele quem mudou o ACS');
  });

  it('recusa endereço inválido, e a caixa da plataforma', async () => {
    const ruim = await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { url: 'ftp://acs.test' } });
    assert.equal(ruim.status, 400);
    const daCaixa = await api(`/platform/tenants/${caixa}/genieacs`);
    assert.equal(daCaixa.status, 404);
  });

  it('o provedor lê o que o console gravou', async () => {
    const { body } = await api('/settings');
    assert.equal(body.data.genieAcsUrl, 'http://acs-alfa.exemplo.test:7557');
  });

  /**
   * O botão de teste do provedor testa o endereço GRAVADO, e ignora o corpo.
   * Gravado aqui um endereço de loopback, que o egresso da SaaS recusa com
   * 400; o corpo aponta para um nome que não resolve, que daria 502. O 400 é
   * a prova de que foi o gravado que se testou.
   */
  it('e testa o endereço gravado, não o que mandou', async () => {
    await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { url: 'http://127.0.0.1:7557' } });
    const { status } = await api('/settings/test-genieacs', {
      method: 'POST',
      body: { url: 'http://nao-resolve.invalid:7557' }
    });
    assert.equal(status, 400);
  });
});

describe('o servidor Evolution', () => {
  before(async () => {
    await runInTenant(caixa, () => WhatsAppConfigService.saveConfig({
      managedUrl: 'https://evo.plataforma.test',
      managedAdminKey: 'chave-da-plataforma',
      webhookBaseUrl: 'https://painel.plataforma.test',
      cloudVerifyToken: 'verifica-da-plataforma'
    }));
  });

  it('o token de verificação da Meta não sai para o provedor: o painel registra o webhook', async () => {
    const { status, body } = await api('/whatsapp/config');
    assert.equal(status, 200);
    assert.deepEqual(body.data.cloudWebhook, { auto: true });
    assert.equal(JSON.stringify(body).includes('verifica-da-plataforma'), false);
    // Mas o painel o tem, para mandá-lo à Meta.
    const efetiva = await runInTenant(alfa, () => {
      WhatsAppConfigService.invalidateConfigCache();
      return WhatsAppConfigService.getConfig();
    });
    assert.equal(efetiva.cloudVerifyToken, 'verifica-da-plataforma');
  });

  it('e a caixa da plataforma, que é dona do servidor, continua vendo e editando o token', async () => {
    const publico = await runInTenant(caixa, () => WhatsAppConfigService.getPublicConfig());
    assert.equal(publico.platformManaged, false);
    assert.equal(publico.cloudWebhook.verifyToken, 'verifica-da-plataforma');
  });

  it('o provedor enxerga o da plataforma, sem a chave', async () => {
    const { status, body } = await api('/whatsapp/config');
    assert.equal(status, 200);
    assert.equal(body.data.platformManaged, true);
    assert.equal(body.data.managedUrl, 'https://evo.plataforma.test');
    assert.equal(body.data.managedAdminKeyConfigured, true);
    assert.equal(JSON.stringify(body).includes('chave-da-plataforma'), false);
  });

  it('e não troca o servidor, só o que é dele', async () => {
    const { status, body } = await api('/whatsapp/config', {
      method: 'PUT',
      body: {
        managedUrl: 'https://evo.meu.test',
        managedAdminKey: 'minha-chave',
        webhookBaseUrl: 'https://outro.test',
        rejectCallMessage: 'Só por texto, por favor.'
      }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.managedUrl, 'https://evo.plataforma.test');
    assert.equal(body.data.rejectCallMessage, 'Só por texto, por favor.');

    const daCaixa = await runInTenant(caixa, () => WhatsAppConfigService.getConfig());
    assert.equal(daCaixa.managedUrl, 'https://evo.plataforma.test');
    assert.equal(daCaixa.managedAdminKey, 'chave-da-plataforma');
    assert.equal(daCaixa.platformManaged, false, 'a caixa É a plataforma');
  });

  it('quando a caixa troca o servidor, todo provedor vê na hora', async () => {
    await runInTenant(alfa, () => WhatsAppConfigService.getConfig());
    await runInTenant(caixa, () => WhatsAppConfigService.saveConfig({ managedUrl: 'https://evo2.plataforma.test' }));
    const doAlfa = await runInTenant(alfa, () => WhatsAppConfigService.getConfig());
    assert.equal(doAlfa.managedUrl, 'https://evo2.plataforma.test');
  });
});

describe('a herança do servidor no upgrade', () => {
  it('a caixa sem servidor herda o do provedor mais antigo que tinha, uma vez', async () => {
    const db = getDb();
    const nova = await Tenant.create({ slug: 'plataforma-nova', name: 'Plataforma nova', kind: 'platform' });
    // Só uma caixa por deploy: tira a antiga do caminho durante este caso.
    await db('tenants').where({ id: caixa }).update({ kind: 'provider' });
    try {
      await db('app_state').where({ tenant_id: beta, key: 'whatsapp_evolution_config' }).del();
      await db('app_state').insert({
        tenant_id: beta,
        key: 'whatsapp_evolution_config',
        value: JSON.stringify({ managedUrl: 'https://evo.do-beta.test', webhookBaseUrl: 'https://painel.beta.test' })
      });
      // O alfa, mais antigo, não tem servidor próprio — ou tem? Garante que não.
      await db('app_state').where({ tenant_id: alfa, key: 'whatsapp_evolution_config' }).del();

      assert.equal(await adoptPlatformWhatsAppServer(db), true);
      const blob = JSON.parse((await db('app_state')
        .where({ tenant_id: nova, key: 'whatsapp_evolution_config' }).first()).value);
      assert.equal(blob.managedUrl, 'https://evo.do-beta.test');
      assert.equal(await adoptPlatformWhatsAppServer(db), false, 'a segunda vez não faz nada');
    } finally {
      await db('tenants').where({ id: nova }).update({ kind: 'provider' });
      await db('tenants').where({ id: caixa }).update({ kind: 'platform' });
      WhatsAppConfigService.configCache.clear();
    }
  });
});

describe('os tetos de retenção do plano', () => {
  before(async () => {
    const plano = await api('/platform/plans', {
      method: 'POST',
      body: { code: 'curto', name: 'Curto', maxAuditRetentionDays: 90, maxMessageRetentionDays: 30 }
    });
    assert.equal(plano.status, 201, JSON.stringify(plano.body));
    assert.deepEqual(plano.body.data.plan.retention, { audit: 90, messages: 30, media: null });
    const troca = await api(`/platform/tenants/${alfa}/subscription`, {
      method: 'PUT',
      body: { planId: plano.body.data.plan.id }
    });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    WhatsAppConfigService.configCache.clear();
  });

  it('o provedor vê os tetos', async () => {
    const { body } = await api('/tenant/subscription');
    assert.deepEqual(body.data.retention, { audit: 90, messages: 30, media: null });
  });

  it('recusa guardar mensagens por mais que o teto, ou para sempre', async () => {
    for (const dias of [60, 0]) {
      const { status, body } = await api('/whatsapp/config', { method: 'PUT', body: { messageRetentionDays: dias } });
      assert.equal(status, 422, `${dias} dias`);
      assert.equal(body.code, 'retention_above_cap');
    }
    const dentro = await api('/whatsapp/config', { method: 'PUT', body: { messageRetentionDays: 20 } });
    assert.equal(dentro.status, 200, JSON.stringify(dentro.body));
    assert.equal(dentro.body.data.messageRetentionDays, 20);
  });

  it('e o anexo, sem teto, continua como o provedor escolheu', async () => {
    const { body } = await api('/whatsapp/config');
    assert.equal(body.data.mediaRetentionDays, 0);
  });

  it('a trilha de auditoria também', async () => {
    const acima = await api('/settings/auditRetentionDays', { method: 'PUT', body: { value: '365' } });
    assert.equal(acima.status, 422);
    const dentro = await api('/settings/auditRetentionDays', { method: 'PUT', body: { value: '60' } });
    assert.equal(dentro.status, 200);
    assert.equal(await runInTenant(alfa, () => SchedulerService.auditRetentionDays()), 60);
  });

  it('o que foi gravado antes do teto passa a valer o teto na poda', async () => {
    await runInTenant(alfa, () => Setting.upsert('auditRetentionDays', '365'));
    assert.equal(await runInTenant(alfa, () => SchedulerService.auditRetentionDays()), 90);
  });

  it('capRetention: sem teto é a escolha; com teto, o menor, e "para sempre" vira o teto', () => {
    assert.equal(SubscriptionService.capRetention(0, null), 0);
    assert.equal(SubscriptionService.capRetention(400, null), 400);
    assert.equal(SubscriptionService.capRetention(0, 30), 30);
    assert.equal(SubscriptionService.capRetention(10, 30), 10);
    assert.equal(SubscriptionService.capRetention(60, 30), 30);
  });
});

describe('o catálogo padrão, reenviado', () => {
  const doAlfa = (name) => getDb()('vendors').where({ tenant_id: alfa, name }).first();

  before(async () => {
    const db = getDb();
    await db('vendors').where({ tenant_id: caixa }).del();
    await insertReturningId('vendors', { ...vendor('Comum', 10), tenant_id: caixa });
    await insertReturningId('vendors', { ...vendor('Novo', 10), tenant_id: caixa });
    await db('vendors').where({ tenant_id: alfa, name: 'Comum' }).del();
    // O alfa já tem o "Comum", ajustado por ele.
    await insertReturningId('vendors', { ...vendor('Comum', 99), tenant_id: alfa });
  });

  it('insere o que falta e não mexe no que o provedor ajustou', async () => {
    const { status, body } = await api('/platform/catalogue/propagate', { method: 'POST', body: {} });
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(await doAlfa('Novo'), 'o perfil novo chegou');
    assert.equal(Number((await doAlfa('Comum')).priority), 99, 'o ajuste do alfa ficou');
    assert.ok(await getDb()('vendors').where({ tenant_id: beta, name: 'Novo' }).first(), 'e chegou ao beta também');
  });

  it('a segunda vez não duplica nada', async () => {
    await api('/platform/catalogue/propagate', { method: 'POST', body: {} });
    const [{ n }] = await getDb()('vendors').where({ tenant_id: alfa, name: 'Novo' }).count({ n: '*' });
    assert.equal(Number(n), 1);
  });

  it('o provedor restaura um perfil ao padrão', async () => {
    const comum = await doAlfa('Comum');
    const { status, body } = await api(`/vendor-management/${comum.id}/reset`, { method: 'POST' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(Number((await doAlfa('Comum')).priority), 10);
    assert.equal(Number((await doAlfa('Comum')).id), Number(comum.id), 'a linha é a mesma');
  });

  it('um perfil que só o provedor tem não tem padrão', async () => {
    const id = await runInTenant(alfa, () => insertReturningId('vendors', { ...vendor('Só do alfa'), tenant_id: alfa }));
    const { status, body } = await api(`/vendor-management/${id}/reset`, { method: 'POST' });
    assert.equal(status, 404);
    assert.equal(body.code, 'no_default');
  });

  it('com overwrite, sobrescreve só nos provedores pedidos', async () => {
    await getDb()('vendors').where({ tenant_id: alfa, name: 'Novo' }).update({ priority: 50 });
    await getDb()('vendors').where({ tenant_id: beta, name: 'Novo' }).update({ priority: 50 });
    const { status } = await api('/platform/catalogue/propagate', {
      method: 'POST',
      body: { overwrite: true, tenantIds: [alfa] }
    });
    assert.equal(status, 200);
    assert.equal(Number((await doAlfa('Novo')).priority), 10);
    assert.equal(Number((await getDb()('vendors').where({ tenant_id: beta, name: 'Novo' }).first()).priority), 50);
  });

  it('e fica na nossa trilha', async () => {
    assert.ok(await getDb()('platform_audit').where({ action: 'catalogue.propagated' }).first());
  });
});
