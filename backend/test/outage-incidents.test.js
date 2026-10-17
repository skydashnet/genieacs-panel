import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

/**
 * A queda em massa vista pelo lado do CLIENTE: o alerta `mass_outage` abre um
 * incidente com os aparelhos atingidos, o operador avisa, o bot responde a
 * quem pergunta, e o "normalizado" sai só para quem foi avisado.
 *
 * A telemetria é de mentira, como em `whatsapp-alerts.test.js`: o que está em
 * prova é o incidente, não o leitor do GenieACS.
 */
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: WaBotService } = await import('../src/services/waBotService.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');

const scan = () => asTenant(() => WaAlertService.scan({ now: Date.now() }));

const TELEFONE = {
  1: '5593981120001',
  2: '5593981120002',
  // O 3 é o mesmo contrato e o mesmo telefone do 2: um aviso só.
  3: '5593981120002',
  4: '5593981120004'
  // O 5 não tem telefone.
};
const OPT_OUT = TELEFONE[4];

let panelUrl;
let token;
let supportAccountId;
let fleet = [];
let identities = [];
let realDashboardDevices;
let realIdentityDevices;

const minutosAtras = (m) => new Date(Date.now() - m * 60_000).toISOString();
const device = (id, minutos) => ({ _id: id, rxpower: -20, temperature: 45, _lastInform: minutosAtras(minutos) });

async function saidaPara(phone) {
  return getDb()('wa_messages')
    .join('wa_conversations', 'wa_conversations.id', 'wa_messages.conversation_id')
    .where('wa_conversations.wa_phone_e164', phone)
    .where('wa_messages.direction', 'out')
    .orderBy('wa_messages.id')
    .select('wa_messages.body', 'wa_conversations.account_id');
}

function queda({ caidas = 5 } = {}) {
  identities = [1, 2, 3, 4, 5, 6].map((n) => ({ _id: `dev-${n}`, pppoe: `cliente${n}` }));
  fleet = identities.map((item, i) => device(item._id, i < caidas ? 45 : 1));
}

function normal() {
  fleet = identities.map((item) => device(item._id, 1));
}

before(async () => {
  ({ panelUrl } = await startTestServers());
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
    recipients: ['5593981119000'],
    rules: {
      ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 60 },
      mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 60 },
      rx_power_low: { enabled: false },
      temperature_high: { enabled: false }
    }
  }));

  await insertReturningId('mapping_nodes', { node_id: 'ODP-1', type: 'odp', name: 'ODP Centro', latitude: -3.1, longitude: -60 });
  await insertReturningId('mapping_nodes', { node_id: 'ODP-2', type: 'odp', name: 'ODP Bairro', latitude: -3.2, longitude: -60 });
  for (let n = 1; n <= 6; n += 1) {
    await insertReturningId('mapping_nodes', {
      node_id: `ONT-${n}`, type: 'ont', name: `Assinante ${n}`, latitude: -3.1, longitude: -60, pppoe: `cliente${n}`
    });
    await getDb()('mapping_edges').insert({ edge_id: `E-${n}`, source: `ONT-${n}`, target: n === 6 ? 'ODP-2' : 'ODP-1', fiber_type: 'drop' });
    await insertReturningId('sgp_links', {
      device_id: `dev-${n}`,
      contract: n === 3 ? '802' : `80${n}`,
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
  WaAlertService.settingsCache.clear();
});

const listar = async () => (await call(`${panelUrl}/api/whatsapp/outages`, { headers: authHeaders(token) })).body.data.incidents;

describe('o incidente de queda em massa', () => {
  it('abre um incidente com os aparelhos atingidos, sem duplicar na varredura seguinte', async () => {
    queda();
    await scan();
    await scan();
    const incidentes = await listar();
    assert.equal(incidentes.length, 1);
    assert.equal(incidentes[0].nodeName, 'ODP Centro');
    assert.equal(incidentes[0].status, 'open');
    assert.equal(incidentes[0].affected, 5);
    // 1, 2 (=3) e 4: três telefones; o 5 não tem.
    assert.equal(incidentes[0].withPhone, 3);
  });

  it('avisa um telefone por cliente, pula o opt-out, leva a previsão e não repete', async () => {
    queda();
    await scan();
    const [incidente] = await listar();
    const aviso = await call(`${panelUrl}/api/whatsapp/outages/${incidente.id}/notify`, {
      method: 'POST', headers: authHeaders(token), body: { eta: 'hoje às 18h' }
    });
    assert.equal(aviso.status, 200, JSON.stringify(aviso.body));
    assert.equal(aviso.body.data.sent, 2);
    assert.equal(aviso.body.data.skippedOptOut, 1);

    const [msg1] = await saidaPara(TELEFONE[1]);
    assert.match(msg1.body, /ODP Centro/);
    assert.match(msg1.body, /hoje às 18h/);
    assert.equal(msg1.account_id, supportAccountId, 'o aviso ao cliente saiu pelo número de alertas');
    assert.equal((await saidaPara(TELEFONE[2])).length, 1, 'mesmo telefone, dois aparelhos: um aviso');
    assert.equal((await saidaPara(OPT_OUT)).length, 0);

    const repetido = await call(`${panelUrl}/api/whatsapp/outages/${incidente.id}/notify`, {
      method: 'POST', headers: authHeaders(token), body: {}
    });
    assert.equal(repetido.body.data.sent, 0);

    const trilha = await getDb()('audit_log').where({ action: 'outage.notified' }).orderBy('id', 'desc').first();
    assert.ok(trilha, 'o aviso não foi para a trilha');
  });

  it('o bot responde a queda a quem pergunta "sem internet"', async () => {
    queda();
    await scan();
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
    assert.equal(resultado.replied, true, JSON.stringify(resultado));
    const [resposta] = await saidaPara(TELEFONE[1]);
    assert.match(resposta.body, /interrupção no serviço na sua região \(ODP Centro\)/);
  });

  it('quando volta, fecha o incidente e manda o "normalizado" só a quem foi avisado', async () => {
    queda();
    await scan();
    const [incidente] = await listar();
    await call(`${panelUrl}/api/whatsapp/outages/${incidente.id}/notify`, {
      method: 'POST', headers: authHeaders(token), body: {}
    });
    await getDb()('wa_messages').del();

    normal();
    await scan();
    const [fechado] = await listar();
    assert.equal(fechado.status, 'resolved');
    assert.ok(fechado.recoverySentAt);
    const [volta] = await saidaPara(TELEFONE[1]);
    assert.match(volta.body, /normalizado/);
    assert.equal((await saidaPara(OPT_OUT)).length, 0);
  });

  it('sem aviso enviado, a volta fecha em silêncio', async () => {
    queda();
    await scan();
    normal();
    await scan();
    const [fechado] = await listar();
    assert.equal(fechado.status, 'resolved');
    const paraClientes = await getDb()('wa_messages')
      .where({ direction: 'out' })
      .whereIn('conversation_id', getDb()('wa_conversations').select('id').where({ account_id: supportAccountId }));
    assert.equal(paraClientes.length, 0);
  });

  it('um id que não existe responde 404', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/outages/999999`, { headers: authHeaders(token) });
    assert.equal(status, 404);
  });
});

describe('os filtros do quadro', () => {
  const nos = (incidentes) => incidentes.map((i) => i.nodeName);
  const filtrar = async (query) => (await call(`${panelUrl}/api/whatsapp/outages${query}`, { headers: authHeaders(token) })).body.data.incidents;
  // Em segundos inteiros: o TIMESTAMP do MySQL não guarda milissegundos.
  const horasAtras = (h) => new Date(Math.floor((Date.now() - h * 3600_000) / 1000) * 1000);

  beforeEach(async () => {
    const incidente = (node, { aberto = false, horas, avisado = false }) => ({
      tenant_id: 1,
      node_id: node.toLowerCase().replace(/\s+/g, '-'),
      node_name: node,
      status: aberto ? 'open' : 'resolved',
      started_at: horasAtras(horas + 1),
      resolved_at: aberto ? null : horasAtras(horas),
      notice_sent_at: avisado ? horasAtras(horas + 0.5) : null
    });
    await getDb()('outage_incidents').insert([
      incidente('CTO-12 Centro', { aberto: true, horas: 1 }),
      incidente('CTO-30', { horas: 2, avisado: true }),
      incidente('CTO-12 Bairro', { horas: 72 }),
      incidente('CTO-99', { horas: 24 * 40 })
    ]);
  });

  it('sem filtro, os abertos e os resolvidos nas últimas 24 h', async () => {
    assert.deepEqual(nos(await filtrar('')), ['CTO-12 Centro', 'CTO-30']);
  });

  it('o período olha mais para trás, e o aberto aparece em qualquer período', async () => {
    assert.deepEqual(nos(await filtrar('?days=7')), ['CTO-12 Centro', 'CTO-30', 'CTO-12 Bairro']);
    assert.deepEqual(nos(await filtrar('?days=90')), ['CTO-12 Centro', 'CTO-30', 'CTO-12 Bairro', 'CTO-99']);
    assert.deepEqual(nos(await filtrar('?days=999')), ['CTO-12 Centro', 'CTO-30'], 'período fora da lista vale 24 h');
  });

  it('a situação separa em andamento e normalizadas', async () => {
    assert.deepEqual(nos(await filtrar('?status=open&days=90')), ['CTO-12 Centro']);
    assert.deepEqual(nos(await filtrar('?status=resolved&days=7')), ['CTO-30', 'CTO-12 Bairro']);
  });

  it('procura pelo ponto do mapa, sem diferenciar maiúsculas', async () => {
    assert.deepEqual(nos(await filtrar('?search=cto-12&days=90')), ['CTO-12 Centro', 'CTO-12 Bairro']);
    assert.deepEqual(await filtrar('?search=%25&days=90'), [], 'um termo só de curinga não acha nada');
  });

  it('separa as que ainda não tiveram aviso', async () => {
    assert.deepEqual(nos(await filtrar('?notified=pending&days=90')), ['CTO-12 Centro', 'CTO-12 Bairro', 'CTO-99']);
    assert.deepEqual(nos(await filtrar('?notified=sent&days=90')), ['CTO-30']);
  });
});
