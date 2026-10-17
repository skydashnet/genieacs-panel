import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaTemplateService } = await import('../src/services/waTemplateService.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { default: WaMediaSweeper } = await import('../src/services/waMediaSweeper.js');
const { outDir } = await import('../src/services/waAttachmentService.js');
const { DATA_DIR } = await import('../src/config/paths.js');
const {
  chaveDeLugar,
  contratosColados,
  primeiroNome
} = await import('../src/services/waCampaignService.js');

/**
 * O módulo "Nova campanha": público pelo cadastro, mensagem com as variáveis
 * do cadastro, agendamento e anexo — sobre o mesmo envio das campanhas de
 * cobrança.
 */

let panelUrl;
let token;
const api = (rota, options = {}) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token), ...options });

const endereco = (district, city) => JSON.stringify({ district, city });

const CONTATOS = [
  // contrato, nome, telefone, situação, plano, bairro, cidade
  ['101', 'RAQUEL ARAÚJO XAVIER', '5593991110101', 'active', '300 MB', 'Centro', 'Santarém'],
  ['102', 'JOÃO SILVA', '5593991110102', 'active', '500 MB', 'Aeroporto Velho', 'Santarém'],
  ['103', 'MARIA SOUZA', '5593991110103', 'blocked', '300 MB', 'CENTRO', 'Santarem'],
  ['104', 'PEDRO LIMA', null, 'active', '300 MB', 'Centro', 'Santarém'],
  ['105', 'ANA COSTA', '5593991110105', 'active', '300 MB', 'Centro', 'Santarém'],
  ['106', 'ANA COSTA', '5593991110105', 'active', '300 MB', 'Centro', 'Santarém'],
  ['107', 'CARLOS ROCHA', '5593991110107', 'cancelled', null, 'Prainha', 'Alter do Chão']
];

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
    name: 'painel-avisos',
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  await getDb()('sgp_contacts').insert(CONTATOS.map(([contract, name, phone, state, plan, district, city]) => ({
    tenant_id: 1,
    contract,
    client_name: name,
    phone_e164: phone,
    state,
    plan,
    address_parts: endereco(district, city)
  })));
  await asTenant(() => WaOptOut.record({ waPhone: '5593991110102', origin: 'customer', reasonText: 'SAIR' }));
});

after(async () => {
  await stopTestServers();
});

beforeEach(() => {
  asTenant(() => WaBillingService.resetBuildWindow());
});

describe('as regras puras', () => {
  it('compara lugar sem acento nem maiúscula e lê contratos colados', () => {
    assert.equal(chaveDeLugar('  Santarém '), chaveDeLugar('SANTAREM'));
    assert.deepEqual(contratosColados('101\n102, 103;104 101'), ['101', '102', '103', '104']);
    assert.equal(primeiroNome('RAQUEL ARAÚJO XAVIER'), 'Raquel');
  });
});

describe('GET /broadcasts/audience-options', () => {
  it('traz situação, plano, bairro e cidade com contagem', async () => {
    const { status, body } = await api('/broadcasts/audience-options');
    assert.equal(status, 200, JSON.stringify(body));
    const { states, plans, districts, cities } = body.data;
    assert.equal(states.find((s) => s.value === 'active').count, 5);
    assert.equal(plans.find((p) => p.value === '300 MB').count, 5);
    assert.equal(districts.find((d) => chaveDeLugar(d.value) === 'centro').count, 5, 'Centro e CENTRO são um bairro só');
    assert.ok(cities.some((c) => c.value === 'Alter do Chão'));
  });
});

describe('POST /broadcasts/preview', () => {
  const preview = (payload) => api('/broadcasts/preview', { method: 'POST', body: payload });

  it('situação E plano E bairro, e conta quem fica de fora', async () => {
    const { status, body } = await preview({
      filters: { states: ['active'], plans: ['300 MB'], districts: ['centro'] },
      body: 'Olá {{primeiro_nome}}, seu plano {{plano}} ganhou mais velocidade!'
    });
    assert.equal(status, 200, JSON.stringify(body));
    const { counts, sample } = body.data;
    // 101, 104 (sem celular), 105 e 106 (mesmo celular) — 103 está bloqueado.
    assert.equal(counts.matched, 4);
    assert.equal(counts.noPhone, 1);
    assert.equal(counts.duplicate, 1);
    assert.equal(counts.reachable, 2);
    assert.deepEqual(sample.map((r) => r.contract).sort(), ['101', '105']);
    assert.equal(sample.find((r) => r.contract === '101').body, 'Olá Raquel, seu plano 300 MB ganhou mais velocidade!');
  });

  it('respeita o não perturbe e a lista colada', async () => {
    const { body } = await preview({ filters: { contracts: '102\n101' }, body: 'Oi {{nome}}' });
    assert.equal(body.data.counts.optOut, 1);
    assert.deepEqual(body.data.sample.map((r) => r.contract), ['101']);
  });

  it('pula quem não tem o dado que o texto cita', async () => {
    const { body } = await preview({ filters: { cities: ['alter do chao'] }, body: 'Seu plano: {{plano}}' });
    assert.equal(body.data.counts.templateIncomplete, 1);
    assert.equal(body.data.counts.reachable, 0);
  });

  it('recusa variável de cobrança', async () => {
    const { status, body } = await preview({ filters: {}, body: 'Pague com {{pix}}' });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /billing_variables|pix/);
  });

  it('aceita um modelo "geral" com {{plano}}', async () => {
    const modelo = await asTenant(() => WaTemplateService.create({
      name: 'Aviso · upgrade', body: 'Oi {{primeiro_nome}}, o {{plano}} mudou.', category: 'geral'
    }));
    const { status, body } = await preview({ filters: { contracts: ['101'] }, templateId: modelo.id });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.sample[0].body, 'Oi Raquel, o 300 MB mudou.');
  });
});

describe('POST /broadcasts', () => {
  const criar = (payload) => api('/broadcasts', { method: 'POST', body: payload });

  it('cria um rascunho de aviso com os destinatários', async () => {
    const { status, body } = await criar({
      title: 'Manutenção no Centro',
      filters: { districts: ['Centro'] },
      body: 'Oi {{primeiro_nome}}, amanhã há manutenção no seu bairro.'
    });
    assert.equal(status, 201, JSON.stringify(body));
    const { broadcast, recipients } = body.data;
    assert.equal(broadcast.status, 'draft');
    assert.equal(broadcast.kind, 'general');
    assert.equal(recipients, 3, '101, 103 e 105');
    assert.deepEqual(broadcast.audience.districts, ['Centro']);
    const rows = await getDb()('wa_broadcast_recipients').where({ broadcast_id: broadcast.id });
    assert.equal(rows.length, 3);
    assert.ok(rows.some((r) => r.rendered_body === 'Oi Raquel, amanhã há manutenção no seu bairro.'));
  });

  it('edita um rascunho: refaz público e texto, e uma campanha em andamento não se edita', async () => {
    const criada = await criar({ title: 'Antes', filters: { districts: ['Centro'] }, body: 'Oi {{nome}}' });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    const id = criada.body.data.broadcast.id;
    assert.equal(criada.body.data.broadcast.audience.contractList.length, 0);

    const editada = await api(`/broadcasts/${id}`, {
      method: 'PUT',
      body: { title: 'Depois', filters: { contracts: ['101', '103'] }, body: 'Olá {{primeiro_nome}}', pace: 'slow' }
    });
    assert.equal(editada.status, 200, JSON.stringify(editada.body));
    assert.equal(editada.body.data.recipients, 2);
    assert.equal(editada.body.data.broadcast.title, 'Depois');
    assert.equal(editada.body.data.broadcast.pacePerHour, 30);
    assert.deepEqual(editada.body.data.broadcast.audience.contractList, ['101', '103']);
    const rows = await getDb()('wa_broadcast_recipients').where({ broadcast_id: id });
    assert.equal(rows.length, 2, 'a lista antiga foi trocada, não somada');
    assert.ok(rows.every((r) => r.rendered_body.startsWith('Olá ')));

    await getDb()('wa_broadcasts').where({ id }).update({ status: 'running' });
    const recusada = await api(`/broadcasts/${id}`, { method: 'PUT', body: { title: 'X', filters: { contracts: ['101'] }, body: 'Oi' } });
    assert.equal(recusada.status, 409);
    assert.equal((await getDb()('wa_broadcast_recipients').where({ broadcast_id: id })).length, 2);
    await asTenant(() => WaBroadcastService.setStatus(id, 'canceled'));
  });

  it('recusa agendamento no passado', async () => {
    const { status } = await criar({
      title: 'Atrasada', filters: { contracts: ['101'] }, body: 'Oi', scheduledAt: new Date(Date.now() - 3600_000).toISOString()
    });
    assert.equal(status, 400);
  });

  it('agendada: nasce "queued" e começa sozinha quando a hora chega', async () => {
    const quando = new Date(Date.now() + 10 * 60_000);
    const { status, body } = await criar({
      title: 'Promoção', filters: { contracts: ['101'] }, body: 'Oi {{nome}}', scheduledAt: quando.toISOString()
    });
    assert.equal(status, 201, JSON.stringify(body));
    const id = body.data.broadcast.id;
    assert.equal(body.data.broadcast.status, 'queued');
    assert.ok(body.data.broadcast.scheduledAt);

    assert.equal(await asTenant(() => WaBroadcastService.startScheduled(new Date())), 0, 'antes da hora, nada');
    assert.equal((await getDb()('wa_broadcasts').where({ id }).first()).status, 'queued');

    assert.equal(await asTenant(() => WaBroadcastService.startScheduled(new Date(quando.getTime() + 1000))), 1);
    const row = await getDb()('wa_broadcasts').where({ id }).first();
    assert.equal(row.status, 'running');
    assert.ok(row.start_at);
    await asTenant(() => WaBroadcastService.setStatus(id, 'canceled'));
  });

  it('com anexo: cada mensagem sai com o arquivo, e o sweeper não o apaga', async () => {
    const relativo = await asTenant(() => path.posix.join(outDir(), '2026', '09', 'aviso-teste.pdf'));
    const absoluto = path.join(DATA_DIR, relativo);
    fs.mkdirSync(path.dirname(absoluto), { recursive: true });
    fs.writeFileSync(absoluto, '%PDF-1.4 teste');

    const { status, body } = await criar({
      title: 'Comunicado',
      filters: { contracts: ['101'] },
      body: 'Oi {{primeiro_nome}}, segue o comunicado.',
      attachment: { path: relativo, name: 'comunicado.pdf' }
    });
    assert.equal(status, 201, JSON.stringify(body));
    const id = body.data.broadcast.id;
    assert.equal(body.data.broadcast.attachment.type, 'application/pdf');

    const { protect } = await asTenant(() => WaMediaSweeper.indexRows());
    assert.ok(protect.has(path.resolve(absoluto)), 'o arquivo de uma campanha em rascunho fica protegido');

    await asTenant(() => WaBroadcastService.setStatus(id, 'running'));
    await asTenant(() => WaBroadcastService.tickForTenant());
    const recipient = await getDb()('wa_broadcast_recipients').where({ broadcast_id: id }).first();
    assert.equal(recipient.status, 'sent');
    const message = await getDb()('wa_messages').where({ id: recipient.message_id }).first();
    assert.equal(message.attachment_path, relativo);
    assert.equal(message.source, 'campaign');
  });

  it('recusa anexo fora da pasta de saída', async () => {
    const { status } = await criar({
      title: 'Malandro', filters: { contracts: ['101'] }, body: 'Oi', attachment: { path: '../panel.sqlite' }
    });
    assert.equal(status, 400);
  });
});
