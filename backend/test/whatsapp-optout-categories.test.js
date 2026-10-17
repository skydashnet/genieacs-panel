import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaBroadcast } = await import('../src/models/WaBroadcast.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { lerTipos, bloqueia, optOutOf } = await import('../src/utils/wa/waOptOutTipos.js');

/**
 * "Não perturbe" por TIPO de comunicação: a equipe afina o que cada cliente
 * aceita receber. Nula é "tudo" — o que já existia, e todo "SAIR" do cliente.
 */

let panelUrl;
let token;
const api = (rota, options = {}) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token), ...options });

const FONE = { a: '5593991110201', b: '5593991110202', c: '5593991110203' };

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-tipos',
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  await getDb()('sgp_contacts').insert([
    ['301', 'ANA DOS TIPOS', FONE.a],
    ['302', 'BRUNO PROMO', FONE.b],
    ['303', 'CARLA LIVRE', FONE.c]
  ].map(([contract, name, phone]) => ({ tenant_id: 1, contract, client_name: name, phone_e164: phone, state: 'active' })));
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_opt_outs').del();
  await getDb()('audit_log').where({ action: 'whatsapp.opt_out_changed' }).del();
  asTenant(() => WaBillingService.resetBuildWindow());
});

describe('as regras puras', () => {
  it('lê a lista de tipos: vazia ou completa é "todos", fora da lista é recusa', () => {
    assert.equal(lerTipos(undefined), null);
    assert.equal(lerTipos([]), null);
    assert.equal(lerTipos(['billing', 'service', 'marketing', 'survey']), null);
    assert.deepEqual(lerTipos(['marketing', 'billing', 'marketing']), ['billing', 'marketing']);
    assert.equal(lerTipos(['billing', 'spam']), undefined);
  });

  it('um bloqueio sem tipos cobre tudo; com tipos, só eles', () => {
    assert.equal(bloqueia(null, 'billing'), true);
    assert.equal(bloqueia('marketing', 'billing'), false);
    assert.equal(bloqueia('billing,marketing', 'marketing'), true);
    assert.equal(bloqueia('marketing', undefined), true, 'sem tipo, qualquer bloqueio conta');
    assert.deepEqual(optOutOf([['marketing']]), { optedOut: false, optOutCategories: ['marketing'] });
    assert.deepEqual(optOutOf([['marketing'], null]), { optedOut: true, optOutCategories: null });
    assert.deepEqual(optOutOf([]), { optedOut: false, optOutCategories: null });
  });
});

describe('o modelo', () => {
  it('pergunta pelo tipo: quem bloqueou promoção ainda recebe a fatura', async () => {
    await asTenant(() => WaOptOut.record({ waPhone: FONE.a, origin: 'operator', categories: ['marketing'] }));
    await asTenant(() => WaOptOut.record({ waPhone: FONE.b, origin: 'customer' }));
    const blocked = (category) => asTenant(() => WaOptOut.activePhones([FONE.a, FONE.b, FONE.c], category));
    assert.deepEqual([...await blocked('marketing')].sort(), [FONE.a, FONE.b]);
    assert.deepEqual([...await blocked('billing')], [FONE.b]);
    assert.deepEqual([...await blocked(undefined)].sort(), [FONE.a, FONE.b]);
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.a, category: 'billing' })), false);
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.a, category: 'marketing' })), true);
  });

  it('um "SAIR" do cliente amplia o bloqueio parcial para tudo', async () => {
    await asTenant(() => WaOptOut.record({ waPhone: FONE.a, origin: 'operator', categories: ['marketing'] }));
    await asTenant(() => WaOptOut.record({ waPhone: FONE.a, origin: 'customer', reasonText: 'SAIR' }));
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.a, category: 'billing' })), true);
    assert.equal((await getDb()('wa_opt_outs').where({ wa_phone_e164: FONE.a })).length, 1, 'continua uma linha só');
  });

  it('o que já estava gravado antes (sem tipos) bloqueia tudo', async () => {
    await getDb()('wa_opt_outs').insert({ tenant_id: 1, wa_phone_e164: FONE.c, origin: 'customer', categories: null });
    for (const tipo of ['billing', 'service', 'marketing', 'survey']) {
      assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.c, category: tipo })), true, tipo);
    }
  });
});

describe('a API do não perturbe', () => {
  it('adiciona com tipos, mostra o nome do cliente e vai para a Trilha', async () => {
    const res = await api('/opt-outs', { method: 'POST', body: { phone: FONE.a, categories: ['marketing', 'survey'] } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.categories, ['marketing', 'survey']);
    assert.equal(res.body.data.clientName, 'ANA DOS TIPOS');

    const lista = (await api('/opt-outs')).body.data;
    assert.deepEqual(lista.map((row) => [row.waPhoneE164, row.categories, row.clientName]), [[FONE.a, ['marketing', 'survey'], 'ANA DOS TIPOS']]);

    const trilha = await getDb()('audit_log').where({ action: 'whatsapp.opt_out_changed' });
    assert.equal(trilha.length, 1);
    assert.ok(!JSON.stringify(trilha[0]).includes(FONE.a), 'a trilha não guarda o telefone');
  });

  it('sem tipos, é tudo; tipo que não existe é recusado', async () => {
    const tudo = await api('/opt-outs', { method: 'POST', body: { phone: FONE.b } });
    assert.equal(tudo.body.data.categories, null);
    const ruim = await api('/opt-outs', { method: 'POST', body: { phone: FONE.c, categories: ['spam'] } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_categories');
    assert.equal((await api('/opt-outs')).body.data.length, 1);
  });

  it('adicionar de novo troca os tipos, e o PATCH também', async () => {
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.a, categories: ['marketing'] } });
    const outra = await api('/opt-outs', { method: 'POST', body: { phone: FONE.a, categories: ['billing'] } });
    assert.equal(outra.status, 200);
    assert.deepEqual(outra.body.data.categories, ['billing']);

    const id = outra.body.data.id;
    const patch = await api(`/opt-outs/${id}`, { method: 'PATCH', body: { categories: ['service'] } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.deepEqual(patch.body.data.categories, ['service']);
    const todos = await api(`/opt-outs/${id}`, { method: 'PATCH', body: { categories: [] } });
    assert.equal(todos.body.data.categories, null);
    assert.equal((await api(`/opt-outs/${id}`, { method: 'PATCH', body: {} })).status, 400);
    assert.equal((await api('/opt-outs/999999', { method: 'PATCH', body: { categories: ['billing'] } })).status, 404);
    assert.equal((await getDb()('audit_log').where({ action: 'whatsapp.opt_out_changed' })).length, 4);
  });

  it('a lista de contatos separa o bloqueio total do parcial', async () => {
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.a, categories: ['marketing'] } });
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.b } });
    const contatos = (await api('/contacts?limit=50')).body.data.contacts;
    const por = new Map(contatos.map((c) => [c.contract, c]));
    assert.deepEqual([por.get('301').optedOut, por.get('301').optOutCategories], [false, ['marketing']]);
    assert.deepEqual([por.get('302').optedOut, por.get('302').optOutCategories], [true, null]);
    assert.deepEqual([por.get('303').optedOut, por.get('303').optOutCategories], [false, null]);
  });
});

describe('cada envio pergunta pelo seu tipo', () => {
  it('a campanha de aviso pula quem bloqueou promoção, mas não quem só bloqueou cobrança', async () => {
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.a, categories: ['marketing'] } });
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.b, categories: ['billing'] } });
    const { body } = await api('/broadcasts/preview', {
      method: 'POST',
      body: { filters: { contracts: ['301', '302', '303'] }, body: 'Oi {{nome}}' }
    });
    assert.equal(body.data.counts.optOut, 1);
    assert.deepEqual(body.data.sample.map((r) => r.contract).sort(), ['302', '303']);
  });

  it('a cobrança avulsa e a campanha de aviso, na entrega, respeitam o tipo de cada uma', async () => {
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.a, categories: ['marketing'] } });
    await api('/opt-outs', { method: 'POST', body: { phone: FONE.b, categories: ['billing'] } });

    const enviar = async (kind) => {
      const broadcast = await asTenant(() => WaBroadcast.create({
        title: `teste ${kind}`, body: 'Oi', status: 'draft', kind, rate_limit_per_min: 60, total_count: 2
      }));
      await asTenant(() => WaBroadcast.addRecipients(broadcast.id, [
        { phone: FONE.a, contract: '301', clientName: 'ANA', body: 'Oi' },
        { phone: FONE.b, contract: '302', clientName: 'BRUNO', body: 'Oi' }
      ]));
      await asTenant(() => WaBroadcastService.setStatus(broadcast.id, 'running'));
      await asTenant(() => WaBroadcastService.tickForTenant());
      const linhas = await getDb()('wa_broadcast_recipients').where({ broadcast_id: broadcast.id });
      return Object.fromEntries(linhas.map((l) => [l.contract, `${l.status}${l.error_msg ? `:${l.error_msg}` : ''}`]));
    };

    // Cobrança: a Ana bloqueou só promoção e recebe; o Bruno bloqueou cobrança.
    assert.deepEqual(await enviar('billing'), { 301: 'sent', 302: 'skipped:opt_out' });
    // Aviso geral: o contrário.
    assert.deepEqual(await enviar('general'), { 301: 'skipped:opt_out', 302: 'sent' });
  });
});
