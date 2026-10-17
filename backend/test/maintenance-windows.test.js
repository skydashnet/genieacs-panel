import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

/**
 * Manutenção programada: o aviso antes, o silêncio durante e o "concluída"
 * depois — o mesmo cenário de `outage-incidents.test.js`, com uma ODC acima
 * das duas ODPs para provar que a janela desce a árvore inteira.
 */
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: WaBotService } = await import('../src/services/waBotService.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: MaintenanceService } = await import('../src/services/maintenanceService.js');

const TELEFONE = {
  1: '5593981130001',
  2: '5593981130002',
  3: '5593981130002',
  4: '5593981130004'
};
const OPT_OUT = TELEFONE[4];
const EQUIPE = '5593981139000';
const HORA = 3600_000;

let panelUrl;
let token;
let supportAccountId;
let fleet = [];
let identities = [];
let realDashboardDevices;
let realIdentityDevices;

const minutosAtras = (m) => new Date(Date.now() - m * 60_000).toISOString();
const device = (id, minutos) => ({ _id: id, rxpower: -20, temperature: 45, _lastInform: minutosAtras(minutos) });

function queda() {
  fleet = identities.map((item, i) => device(item._id, i < 5 ? 45 : 1));
}

async function saidaPara(phone) {
  return getDb()('wa_messages')
    .join('wa_conversations', 'wa_conversations.id', 'wa_messages.conversation_id')
    .where('wa_conversations.wa_phone_e164', phone)
    .where('wa_messages.direction', 'out')
    .orderBy('wa_messages.id')
    .select('wa_messages.body');
}

const agendar = (body) => call(`${panelUrl}/api/whatsapp/maintenances`, {
  method: 'POST', headers: authHeaders(token), body
});
const acao = (id, nome) => call(`${panelUrl}/api/whatsapp/maintenances/${id}/${nome}`, {
  method: 'POST', headers: authHeaders(token), body: {}
});
const scan = () => asTenant(() => WaAlertService.scan({ now: Date.now() }));

before(async () => {
  ({ panelUrl } = await startTestServers());
  identities = [1, 2, 3, 4, 5, 6].map((n) => ({ _id: `dev-${n}`, pppoe: `cliente${n}` }));
  fleet = identities.map((item) => device(item._id, 1));
  realDashboardDevices = DeviceService.getDashboardDevices;
  realIdentityDevices = DeviceService.getCustomerIdentityDevices;
  DeviceService.getDashboardDevices = async () => fleet;
  DeviceService.getCustomerIdentityDevices = async () => identities;

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-alertas', purpose: 'alerts', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('t-alertas'),
    ...WhatsAppConfigService.encryptWebhookToken('w-alertas')
  }));
  const suporte = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-suporte', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: false,
    ...WhatsAppConfigService.encryptInstanceToken('t-suporte'),
    ...WhatsAppConfigService.encryptWebhookToken('w-suporte')
  }));
  supportAccountId = suporte.id;

  await asTenant(() => WaAlertService.saveSettings({
    enabled: true,
    recipients: [EQUIPE],
    rules: {
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    }
  }));

  await insertReturningId('mapping_nodes', { node_id: 'ODC-1', type: 'odc', name: 'ODC Norte', latitude: -3.1, longitude: -60 });
  await insertReturningId('mapping_nodes', { node_id: 'ODP-1', type: 'odp', name: 'ODP Centro', latitude: -3.1, longitude: -60 });
  await insertReturningId('mapping_nodes', { node_id: 'ODP-2', type: 'odp', name: 'ODP Bairro', latitude: -3.2, longitude: -60 });
  await getDb()('mapping_edges').insert({ edge_id: 'E-ODC-1', source: 'ODC-1', target: 'ODP-1', fiber_type: 'feeder' });
  await getDb()('mapping_edges').insert({ edge_id: 'E-ODC-2', source: 'ODP-2', target: 'ODC-1', fiber_type: 'feeder' });
  for (let n = 1; n <= 6; n += 1) {
    await insertReturningId('mapping_nodes', {
      node_id: `ONT-${n}`, type: 'ont', name: `Assinante ${n}`, latitude: -3.1, longitude: -60, pppoe: `cliente${n}`
    });
    await getDb()('mapping_edges').insert({ edge_id: `E-${n}`, source: `ONT-${n}`, target: n === 6 ? 'ODP-2' : 'ODP-1', fiber_type: 'drop' });
    await insertReturningId('sgp_links', {
      device_id: `dev-${n}`,
      contract: n === 3 ? '902' : `90${n}`,
      client_name: `Cliente ${n}`,
      login: `cliente${n}`,
      state: 'active',
      link_mode: 'manual',
      phone_e164: TELEFONE[n] ?? null
    });
  }
  await asTenant(() => WaOptOut.record({ waPhone: OPT_OUT, origin: 'operator', reasonText: 'teste' }));
});

after(async () => {
  DeviceService.getDashboardDevices = realDashboardDevices;
  DeviceService.getCustomerIdentityDevices = realIdentityDevices;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_messages').del();
  await getDb()('wa_alert_state').del();
  await getDb()('outage_incident_devices').del();
  await getDb()('outage_incidents').del();
  await getDb()('maintenance_window_devices').del();
  await getDb()('maintenance_windows').del();
  WaAlertService.settingsCache.clear();
  fleet = identities.map((item) => device(item._id, 1));
});

describe('manutenção programada', () => {
  it('a prévia desce a árvore: a ODP pega os clientes dela, a ODC os das duas ODPs', async () => {
    const odp = await call(`${panelUrl}/api/whatsapp/maintenances/preview?nodeId=ODP-1`, { headers: authHeaders(token) });
    assert.equal(odp.status, 200, JSON.stringify(odp.body));
    assert.equal(odp.body.data.affected, 5);
    // 1, 2 (=3) e 4: três telefones; o 5 não tem.
    assert.equal(odp.body.data.withPhone, 3);
    const odc = await call(`${panelUrl}/api/whatsapp/maintenances/preview?nodeId=ODC-1`, { headers: authHeaders(token) });
    assert.equal(odc.body.data.affected, 6);
  });

  it('recusa nó que não agrupa clientes, horário invertido e janela longa demais', async () => {
    const inicio = Date.now() + 48 * HORA;
    const ont = await agendar({ nodeId: 'ONT-1', startsAt: new Date(inicio), endsAt: new Date(inicio + HORA) });
    assert.equal(ont.status, 400);
    const invertido = await agendar({ nodeId: 'ODP-1', startsAt: new Date(inicio), endsAt: new Date(inicio - HORA) });
    assert.equal(invertido.status, 400);
    const longa = await agendar({ nodeId: 'ODP-1', startsAt: new Date(inicio), endsAt: new Date(inicio + 25 * HORA) });
    assert.equal(longa.status, 400);
    const passado = await agendar({ nodeId: 'ODP-1', startsAt: new Date(Date.now() - 2 * HORA), endsAt: new Date(Date.now() + HORA) });
    assert.equal(passado.status, 400);
  });

  it('o aviso sai sozinho na antecedência: um por telefone, sem o opt-out, uma vez só', async () => {
    const inicio = Date.now() + 48 * HORA;
    const criado = await agendar({ nodeId: 'ODP-1', startsAt: new Date(inicio), endsAt: new Date(inicio + 2 * HORA), leadHours: 24 });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.equal(criado.body.data.affected, 5);
    assert.equal((await saidaPara(TELEFONE[1])).length, 0, 'avisou antes da antecedência');

    await asTenant(() => MaintenanceService.processDue({ now: inicio - 25 * HORA }));
    assert.equal((await saidaPara(TELEFONE[1])).length, 0);

    await asTenant(() => MaintenanceService.processDue({ now: inicio - 23 * HORA }));
    await asTenant(() => MaintenanceService.processDue({ now: inicio - 22 * HORA }));
    const [aviso, ...resto] = await saidaPara(TELEFONE[1]);
    assert.match(aviso.body, /manutenção/);
    assert.match(aviso.body, /ODP Centro/);
    assert.equal(resto.length, 0, 'o aviso repetiu');
    assert.equal((await saidaPara(TELEFONE[2])).length, 1, 'mesmo telefone, dois aparelhos: um aviso');
    assert.equal((await saidaPara(OPT_OUT)).length, 0);
    const conversa = await getDb()('wa_conversations').where({ wa_phone_e164: TELEFONE[1] }).first();
    assert.equal(conversa.account_id, supportAccountId);

    // Depois do aviso não se muda mais: o cliente já foi avisado daquele horário.
    const edicao = await call(`${panelUrl}/api/whatsapp/maintenances/${criado.body.data.id}`, {
      method: 'PATCH', headers: authHeaders(token), body: { message: 'outro texto' }
    });
    assert.equal(edicao.status, 409);

    // No fim previsto, "concluída" a quem foi avisado.
    await asTenant(() => MaintenanceService.processDue({ now: inicio + 3 * HORA }));
    const mensagens = await saidaPara(TELEFONE[1]);
    assert.equal(mensagens.length, 2);
    assert.match(mensagens[1].body, /concluída/);
    assert.equal((await saidaPara(OPT_OUT)).length, 0);
    const trilha = await getDb()('audit_log').where({ action: 'maintenance.notified' }).first();
    assert.ok(trilha, 'o aviso não foi para a trilha');
  });

  it('durante a janela a queda não vira alerta nem incidente, e o bot responde manutenção', async () => {
    // Em cima da hora: já dentro da antecedência, o aviso sai no agendamento.
    const criado = await agendar({
      nodeId: 'ODC-1', startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 2 * HORA), leadHours: 24
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.equal(criado.body.data.status, 'active');
    assert.equal((await saidaPara(TELEFONE[1])).length, 1, 'o aviso em cima da hora não saiu');

    queda();
    await scan();
    const incidentes = await getDb()('outage_incidents');
    assert.equal(incidentes.length, 0, 'a manutenção abriu incidente de queda');
    assert.equal((await saidaPara(EQUIPE)).length, 0, 'a equipe recebeu alerta de uma manutenção');

    const conversa = await asTenant(async () => {
      const { default: WaConversation } = await import('../src/models/WaConversation.js');
      return WaConversation.ensure({
        accountId: supportAccountId,
        externalThreadId: `${TELEFONE[1]}@s.whatsapp.net`,
        waPhone: TELEFONE[1],
        waLid: null,
        pushName: 'Cliente 1'
      });
    });
    const resultado = await asTenant(() => WaBotService.responder({
      conversation: conversa, messageId: null, body: 'estou sem internet', direction: 'in'
    }));
    assert.equal(resultado.intent, 'maintenance', JSON.stringify(resultado));
    const mensagens = await saidaPara(TELEFONE[1]);
    assert.match(mensagens.at(-1).body, /manutenção programada/);

    // Concluída antes do previsto: a próxima varredura volta a ver quedas.
    const concluir = await acao(criado.body.data.id, 'conclude');
    assert.equal(concluir.status, 200, JSON.stringify(concluir.body));
    assert.match((await saidaPara(TELEFONE[1])).at(-1).body, /concluída/);
    await scan();
    assert.equal((await getDb()('outage_incidents')).length, 1, 'depois da manutenção a queda devia abrir incidente');
  });

  it('cancelar depois do aviso manda "cancelada"; antes do aviso, fica em silêncio', async () => {
    const perto = await agendar({
      nodeId: 'ODP-1', startsAt: new Date(Date.now() + HORA), endsAt: new Date(Date.now() + 2 * HORA), leadHours: 24
    });
    assert.equal((await saidaPara(TELEFONE[1])).length, 1);
    const cancelado = await acao(perto.body.data.id, 'cancel');
    assert.equal(cancelado.status, 200, JSON.stringify(cancelado.body));
    assert.equal(cancelado.body.data.status, 'cancelled');
    assert.match((await saidaPara(TELEFONE[1])).at(-1).body, /cancelada/);

    await getDb()('wa_messages').del();
    const longe = await agendar({
      nodeId: 'ODP-1', startsAt: new Date(Date.now() + 72 * HORA), endsAt: new Date(Date.now() + 73 * HORA), leadHours: 24
    });
    await acao(longe.body.data.id, 'cancel');
    assert.equal((await saidaPara(TELEFONE[1])).length, 0);
    const denovo = await acao(longe.body.data.id, 'cancel');
    assert.equal(denovo.status, 409);
  });
});
