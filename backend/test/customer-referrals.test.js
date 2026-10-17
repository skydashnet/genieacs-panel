import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { signReferralToken, readReferralToken } = await import('../src/services/customerReferralService.js');

/**
 * "Indique e ganhe": o link de cada cliente (token assinado), a página pública
 * que ele abre no portal, a lista de indicados e a variável da campanha.
 */

let panelUrl;
let portalUrl;
let token;
const api = (rota, options = {}) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token), ...options });

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-avisos',
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  await getDb()('sgp_contacts').insert({
    tenant_id: 1,
    contract: '555',
    client_name: 'JOÃO SILVA',
    phone_e164: '5593991110555',
    state: 'active',
    plan: '300 MB',
    address_parts: JSON.stringify({ district: 'Centro', city: 'Santarém' })
  });
});

after(async () => {
  await stopTestServers();
});

const info = (t) => call(`${portalUrl}/api/customer/referral?t=${encodeURIComponent(t ?? '')}`);
const enviar = (payload) => call(`${portalUrl}/api/customer/referral`, { method: 'POST', body: payload });

describe('o token do link', () => {
  it('é do contrato e do provedor, e não se forja', () => {
    const t = signReferralToken(1, '555');
    assert.deepEqual(readReferralToken(t), { tenantId: 1, contract: '555' });
    assert.equal(readReferralToken(`${t}x`), null);
    const [v, payload, sig] = t.split('.');
    const outro = Buffer.from(JSON.stringify([1, '999'])).toString('base64url');
    assert.equal(readReferralToken(`${v}.${outro}.${sig}`), null, 'a assinatura é do contrato 555');
    assert.equal(readReferralToken('lixo'), null);
    assert.ok(payload);
  });
});

describe('a página pública', () => {
  const t = () => signReferralToken(1, '555');

  it('mostra o primeiro nome de quem indicou, sem sessão', async () => {
    const { status, body } = await info(t());
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.referrerFirstName, 'João');
  });

  it('recusa um token inválido e um contrato que não existe', async () => {
    assert.equal((await info('lixo')).status, 404);
    assert.equal((await info(signReferralToken(1, '404404'))).status, 404);
  });

  it('cadastra o indicado ligado a quem indicou, e o mesmo telefone de novo não duplica', async () => {
    const primeira = await enviar({ t: t(), name: 'Maria Souza', phone: '(93) 99111-2222', neighborhood: 'Aldeia' });
    assert.equal(primeira.status, 201, JSON.stringify(primeira.body));
    const outra = await enviar({ t: t(), name: 'Maria Souza', phone: '93991112222' });
    assert.equal(outra.status, 200);
    assert.equal(outra.body.data.created, false);

    const rows = await getDb()('customer_referrals').where({ referrer_contract: '555' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phone_e164, '5593991112222');
    assert.equal(rows[0].neighborhood, 'Aldeia');
    assert.equal(rows[0].status, 'new');
  });

  it('recusa nome curto, telefone inválido e o telefone do próprio cliente', async () => {
    assert.equal((await enviar({ t: t(), name: 'A', phone: '93991113333' })).status, 400);
    assert.equal((await enviar({ t: t(), name: 'Pedro Lima', phone: '123' })).status, 400);
    const propria = await enviar({ t: t(), name: 'Eu mesmo', phone: '5593991110555' });
    assert.equal(propria.status, 400);
    assert.equal(propria.body.code, 'self_referral');
  });

  it('com token inválido não grava nada', async () => {
    const antes = (await getDb()('customer_referrals')).length;
    assert.equal((await enviar({ t: 'lixo', name: 'Fulano de Tal', phone: '93991114444' })).status, 404);
    assert.equal((await getDb()('customer_referrals')).length, antes);
  });
});

describe('o aviso a quem indicou', () => {
  it('entra na fila do WhatsApp do cliente que indicou, uma vez', async () => {
    const t = signReferralToken(1, '555');
    const r = await enviar({ t, name: 'Carlos Rocha', phone: '93991115555' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // O aviso é assíncrono: espera até a linha aparecer.
    let mensagem = null;
    for (let i = 0; i < 40 && !mensagem; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      mensagem = await getDb()('wa_messages').where({ source: 'campaign' }).where('body', 'like', '%Carlos%').first();
      // eslint-disable-next-line no-await-in-loop
      if (!mensagem) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.ok(mensagem, 'a mensagem de aviso foi enfileirada');
    assert.match(mensagem.body, /^Olá, João! Carlos /);
    const row = await getDb()('customer_referrals').where({ phone_e164: '5593991115555' }).first();
    assert.ok(row.referrer_notified_at, 'o aviso fica marcado');
  });
});

describe('a lista de indicações', () => {
  it('traz quem indicou e o estado, e o estado muda', async () => {
    const lista = await api('/referrals');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const { referrals, counts } = lista.body.data;
    assert.equal(referrals.length, 2);
    assert.ok(referrals.every((r) => r.referrerContract === '555'));
    assert.equal(counts.new, 2);

    const alvo = referrals.find((r) => r.name === 'Maria Souza');
    const mudou = await api(`/referrals/${alvo.id}`, { method: 'PATCH', body: { status: 'won', note: 'Instalado' } });
    assert.equal(mudou.status, 200, JSON.stringify(mudou.body));
    assert.equal(mudou.body.data.status, 'won');
    assert.equal((await api('/referrals')).body.data.counts.won, 1);

    const invalido = await api(`/referrals/${alvo.id}`, { method: 'PATCH', body: { status: 'xyz' } });
    assert.equal(invalido.status, 400);
  });
});

describe('a variável {{link_indicacao}} da campanha', () => {
  it('põe o link do próprio cliente na mensagem, e só depois de haver um endereço', async () => {
    const sem = await api('/broadcasts/preview', {
      method: 'POST',
      body: { filters: { contracts: ['555'] }, body: 'Indique: {{link_indicacao}}' }
    });
    assert.equal(sem.status, 200, JSON.stringify(sem.body));
    assert.equal(sem.body.data.counts.reachable, 0, 'sem endereço, o link fica vazio e a mensagem é pulada');

    const salvo = await api('/referrals/base-url', { method: 'PUT', body: { baseUrl: 'https://portal.provedor.test/' } });
    assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
    assert.equal(salvo.body.data.baseUrl, 'https://portal.provedor.test');

    const com = await api('/broadcasts/preview', {
      method: 'POST',
      body: { filters: { contracts: ['555'] }, body: 'Indique: {{link_indicacao}}' }
    });
    assert.equal(com.body.data.counts.reachable, 1);
    const texto = com.body.data.sample[0].body;
    assert.match(texto, /^Indique: https:\/\/portal\.provedor\.test\/indique\?t=v1\./);
    const link = texto.replace('Indique: ', '');
    const lido = readReferralToken(new URL(link).searchParams.get('t'));
    assert.deepEqual(lido, { tenantId: 1, contract: '555' });
  });

  it('recusa um endereço que não é http(s)', async () => {
    const r = await api('/referrals/base-url', { method: 'PUT', body: { baseUrl: 'javascript:alert(1)' } });
    assert.equal(r.status, 400);
  });
});
