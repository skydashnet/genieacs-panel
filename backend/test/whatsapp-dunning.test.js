import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaDunningService, etapaDevida, chaveDaFatura } = await import('../src/services/waDunningService.js');
const { variaveisVazias } = await import('../src/utils/wa/waCobranca.js');
const { dentroDaJanela, lerJanela } = await import('../src/utils/wa/waJanela.js');

/**
 * A régua AUTOMÁTICA — a metade que envia.
 *
 * O que se prova aqui é o que torna seguro deixá-la ligada: a etapa certa para
 * cada fatura, uma vez só, nunca para quem pediu silêncio, nunca fora da
 * janela, e nunca mais depois que a pessoa pagou.
 */

const APP = 'painel';
const TOKEN = 'token-secreto-regua';
const EVO_BASE = 'https://evo.provedor.test';

const COBRANCA = 'Olá {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias. PIX: {{pix}}';
const LEMBRETE = 'Olá {{nome}}, sua fatura de {{valor}} vence em {{dias_para_vencer}} dias. PIX: {{pix}}';
const OBRIGADO = 'Obrigado, {{nome}}! Recebemos o pagamento de {{valor}}.';

/** A semana inteira aberta: a janela é testada à parte, com o relógio na mão. */
const SEMPRE = {
  timezone: 'America/Sao_Paulo',
  week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: false, open: '00:00', close: '23:59' }))
};
/** Um instante que cai dentro de `SEMPRE` em qualquer dia: meio-dia em São Paulo. */
function meioDia(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(15, 0, 0, 0);
  return d;
}

/**
 * Call it WHEN THE SGP ANSWERS, never while building the fixtures below. They
 * are module constants, evaluated once at import, and the panel counts "overdue
 * for N days" against the instant of each request: a run that crossed 00:00 UTC
 * between the two read 11 where the fixture meant 10. The fixtures declare an
 * offset (`venceEmDias`) and the stub resolves it per response.
 *
 * (The payment dates set inside the tests are fine: they are taken at the
 * moment of the test, not at import.)
 */
function dayOffset(days) {
  const date = meioDia();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const SUBSCRIBERS = [
  { contract: 'R-ATRASO-10', name: 'João', phone: '5593981120001',
    invoices: [{ numerodocumento: 'T10', valor: '129,90', venceEmDias: -10, pix: 'pix-10' }] },
  { contract: 'R-ATRASO-2', name: 'Maria', phone: '5593981120002',
    invoices: [{ numerodocumento: 'T2', valor: '89,90', venceEmDias: -2, pix: 'pix-2' }] },
  { contract: 'R-FUTURA-3', name: 'Carlos', phone: '5593981120003',
    invoices: [{ numerodocumento: 'T3', valor: '99,90', venceEmDias: 3, pix: 'pix-3' }] },
  { contract: 'R-SEM-FONE', name: 'Ana', phone: null,
    invoices: [{ numerodocumento: 'T4', valor: '50,00', venceEmDias: -5, pix: 'pix-4' }] },
  { contract: 'R-OPTOUT', name: 'Pedro', phone: '5593981120005',
    invoices: [{ numerodocumento: 'T5', valor: '50,00', venceEmDias: -5, pix: 'pix-5' }] },
  { contract: 'R-SEM-PIX', name: 'Lucia', phone: '5593981120006',
    invoices: [{ numerodocumento: 'T6', valor: '50,00', venceEmDias: -5 }] },
  { contract: 'R-EM-DIA', name: 'Rita', phone: '5593981120007', invoices: [] }
];
const byContract = new Map(SUBSCRIBERS.map((row) => [row.contract, row]));

let panelUrl;
let token;
let sgpServer;
const templateIds = {};

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/titulos')) {
        const subscriber = byContract.get(String(payload.contrato));
        if (!subscriber) return send({ status: 0, msg: 'Contrato inexistente' });
        const faturas = payload.apenas_titulos_em_aberto
          ? subscriber.invoices.filter((f) => !f.dataPagamento)
          : subscriber.invoices;
        // Resolved here, after the filter, so the due date is the one of THIS answer.
        const titulos = faturas.map(({ venceEmDias, ...titulo }) => (
          venceEmDias === undefined ? titulo : { ...titulo, vencimento: dayOffset(venceEmDias) }
        ));
        return send({ status: 1, titulos });
      }
      res.writeHead(404);
      return res.end('{}');
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });
const sends = () => asTenant(() => getDb()('wa_dunning_sends').orderBy('id'));
const run = (options = {}) => asTenant(() => WaDunningService.run({ now: meioDia(), ...options }));

async function createTemplate(name, body, category = 'cobranca') {
  const { status, body: res } = await api('/templates', { method: 'POST', body: { name, body, category } });
  assert.equal(status, 201, JSON.stringify(res));
  return res.data.id;
}

async function saveRule(rule) {
  return api('/dunning/rule', { method: 'PUT', body: rule });
}

const STEPS = () => [
  { offsetDays: -3, templateId: templateIds.lembrete },
  { offsetDays: 1, templateId: templateIds.cobranca },
  { offsetDays: 5, templateId: templateIds.cobranca }
];

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe' }));
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-cobranca',
    purpose: 'billing',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));

  const now = new Date();
  await asTenant(() => getDb()('sgp_links').insert(SUBSCRIBERS.map((subscriber, index) => ({
    device_id: `ont-regua-${index}`,
    contract: subscriber.contract,
    client_name: subscriber.name,
    document: '12345678909',
    state: 'active',
    link_mode: 'auto',
    phone_e164: subscriber.phone,
    created_at: now,
    updated_at: now
  }))));
  await asTenant(() => WaOptOut.record({ waPhone: byContract.get('R-OPTOUT').phone, origin: 'customer' }));

  templateIds.cobranca = await createTemplate('régua cobrança', COBRANCA);
  templateIds.lembrete = await createTemplate('régua lembrete', LEMBRETE);
  templateIds.obrigado = await createTemplate('régua obrigado', OBRIGADO, 'geral');
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('as regras puras', () => {
  it('escolhe a etapa mais recente do mesmo lado do vencimento, sem rajada', () => {
    const steps = [{ offsetDays: -3 }, { offsetDays: 0 }, { offsetDays: 1 }, { offsetDays: 5 }, { offsetDays: 10 }];
    assert.equal(etapaDevida(steps, -5), null, 'antes da primeira etapa não há nada');
    assert.equal(etapaDevida(steps, -3).offsetDays, -3);
    assert.equal(etapaDevida(steps, -1).offsetDays, -3);
    assert.equal(etapaDevida(steps, 0).offsetDays, 0);
    assert.equal(etapaDevida(steps, 7).offsetDays, 5, 'no sétimo dia, a do quinto — e só ela');
    assert.equal(etapaDevida([{ offsetDays: -3 }], 4), null, 'fatura vencida não recebe lembrete');
    assert.equal(etapaDevida([{ offsetDays: 2 }], -1), null, 'fatura a vencer não recebe cobrança');
  });

  it('diz quais variáveis citadas estão vazias', () => {
    const vars = { nome: 'Ana', pix: '', link_boleto: null, valor: 'R$ 1,00' };
    assert.deepEqual(variaveisVazias('Oi {{nome}}, {{pix}} {{ link_boleto }} {{pix}} {{linha_digitavel}}', vars),
      ['pix', 'link_boleto', 'linha_digitavel']);
    assert.deepEqual(variaveisVazias('Oi {{nome}}: {{valor}}', vars), []);
  });

  it('identifica a fatura pelo título, ou por vencimento e valor', () => {
    assert.equal(chaveDaFatura({ id: 'T1', dueDate: '2026-01-01', amount: 10 }), 'T1');
    assert.equal(chaveDaFatura({ id: null, dueDate: '2026-01-01', amount: 10 }), 'venc:2026-01-01:10');
  });

  it('respeita dia e hora da janela no fuso do provedor', () => {
    const janela = lerJanela({
      timezone: 'America/Sao_Paulo',
      week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: day === 0, open: '08:00', close: '20:00' }))
    });
    // 2026-09-28 é segunda-feira. 11:00Z = 08:00 em São Paulo.
    assert.equal(dentroDaJanela(janela, new Date('2026-09-28T11:00:00Z')), true);
    assert.equal(dentroDaJanela(janela, new Date('2026-09-28T10:59:00Z')), false, '07:59 ainda é cedo');
    assert.equal(dentroDaJanela(janela, new Date('2026-09-28T23:00:00Z')), false, '20:00 já fechou');
    assert.equal(dentroDaJanela(janela, new Date('2026-09-27T15:00:00Z')), false, 'domingo fechado');
  });

  it('recusa janela ilegível, e a janela ilegível responde "fora"', () => {
    assert.equal(lerJanela({ timezone: 'Lugar/Nenhum', week: [] }), null);
    assert.equal(lerJanela({ timezone: 'America/Sao_Paulo', week: [{ day: 1, open: '18:00', close: '08:00' }] }), null);
    assert.equal(dentroDaJanela({ timezone: '', week: [] }, new Date()), false);
  });
});

describe('cadastrar a régua', () => {
  it('recusa lembrete depois do vencimento e cobrança antes dele', async () => {
    let res = await saveRule({ steps: [{ offsetDays: 2, templateId: templateIds.lembrete }] });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'step_needs_dunning');
    res = await saveRule({ steps: [{ offsetDays: -2, templateId: templateIds.cobranca }] });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'step_needs_reminder');
  });

  it('recusa duas etapas no mesmo dia e agradecimento que cita dias', async () => {
    let res = await saveRule({ steps: [
      { offsetDays: 1, templateId: templateIds.cobranca },
      { offsetDays: 1, templateId: templateIds.cobranca }
    ] });
    assert.equal(res.body.code, 'duplicate_offset');
    res = await saveRule({ steps: [], thanksTemplateId: templateIds.cobranca });
    assert.equal(res.body.code, 'thanks_template_days');
  });

  it('não liga sem etapa', async () => {
    const res = await api('/dunning/enabled', { method: 'POST', body: { enabled: true } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'no_steps');
  });

  it('salvar não liga', async () => {
    const res = await saveRule({
      steps: STEPS(), window: SEMPRE, maxPerInvoice: 3, minIntervalHours: 0, thanksTemplateId: templateIds.obrigado
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.enabled, false);
    assert.deepEqual(res.body.data.steps.map((s) => s.offsetDays), [-3, 1, 5]);
  });

  it('desligada, não roda', async () => {
    await assert.rejects(run(), (error) => error.code === 'rule_disabled');
  });
});

describe('a prévia', () => {
  it('diz quem receberia qual etapa e não grava nada', async () => {
    // Começa em segundo plano e responde na hora — uma ida ao SGP por contrato
    // não cabe no minuto que um proxy espera. A tela consulta até terminar.
    const inicio = await api('/dunning/preview', { method: 'POST' });
    assert.equal(inicio.status, 202, JSON.stringify(inicio.body));
    assert.equal(inicio.body.data.status, 'running');
    let estado;
    for (let i = 0; i < 100; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- a consulta repetida é o que se testa
      estado = (await api('/dunning/preview')).body.data;
      if (estado.status !== 'running') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    assert.equal(estado.status, 'done', JSON.stringify(estado));
    assert.equal(estado.checked, estado.total, 'o progresso chega ao total');
    const body = { data: estado.result };
    const por = new Map(body.data.items.map((item) => [item.contract, item]));
    assert.equal(por.get('R-ATRASO-10').stepOffset, 5);
    assert.equal(por.get('R-ATRASO-2').stepOffset, 1);
    assert.equal(por.get('R-FUTURA-3').stepOffset, -3);
    assert.equal(por.get('R-SEM-FONE').reason, 'noPhone');
    assert.equal(por.get('R-OPTOUT').reason, 'optOut');
    assert.equal(por.get('R-SEM-PIX').reason, 'templateIncomplete');
    assert.deepEqual(por.get('R-SEM-PIX').missing, ['pix'], 'e diz qual variável faltou');
    assert.deepEqual(por.get('R-OPTOUT').missing, []);
    assert.equal(por.has('R-EM-DIA'), false);
    assert.equal(body.data.queued, 3);
    assert.equal((await sends()).length, 0, 'a prévia não pode gravar decisão nenhuma');
  });
});

describe('a prévia recusa na hora o que não precisa do SGP', () => {
  it('sem etapa, a resposta já é o erro — e não uma prévia que falha depois', async () => {
    const atual = (await api('/dunning/rule')).body.data;
    await saveRule({ steps: [] });
    const res = await api('/dunning/preview', { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'no_steps');
    await saveRule({ steps: atual.steps });
  });
});

describe('ligada', () => {
  it('liga, e a ligação vai para a trilha', async () => {
    const res = await api('/dunning/enabled', { method: 'POST', body: { enabled: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.enabled, true);
    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'whatsapp.dunning_enabled' }));
    assert.equal(trilha.length, 1);
  });

  it('fora da janela, não manda nada', async () => {
    await saveRule({ window: { timezone: 'America/Sao_Paulo', week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true, open: '08:00', close: '20:00' })) } });
    await assert.rejects(run(), (error) => error.code === 'outside_window');
    assert.equal(await asTenant(() => WaDunningService.due(null, meioDia())), false);
    await saveRule({ window: SEMPRE });
    assert.equal(await asTenant(() => WaDunningService.due(null, meioDia())), true);
  });

  it('enfileira a etapa de cada um e registra por que pulou os outros', async () => {
    const summary = await run();
    assert.equal(summary.queued, 3);
    assert.equal(summary.skipped.noPhone, 1);
    assert.equal(summary.skipped.optOut, 1);
    assert.equal(summary.skipped.templateIncomplete, 1);

    const linhas = await sends();
    const fila = linhas.filter((l) => l.status === 'queued');
    assert.equal(fila.length, 3);
    for (const linha of fila) assert.ok(linha.message_id, 'cada envio aponta para a mensagem na fila');

    const mensagens = await asTenant(() => getDb()('wa_messages').whereIn('id', fila.map((l) => l.message_id)));
    assert.equal(mensagens.length, 3);
    const textos = mensagens.map((m) => m.body).join('\n');
    assert.match(textos, /venceu há 10 dias/);
    assert.match(textos, /vence em 3 dias/);
    assert.ok(mensagens.every((m) => m.source === 'campaign' && m.delivery_status === 'queued'));
  });

  it('rodar de novo no mesmo dia não repete ninguém', async () => {
    const antes = (await sends()).length;
    const summary = await run();
    assert.equal(summary.queued, 0);
    assert.equal((await sends()).length, antes);
  });

  it('duas passadas ao mesmo tempo: uma recusa, e nada dobra', async () => {
    const antes = (await sends()).length;
    const resultados = await Promise.allSettled([run({ now: meioDia(1) }), run({ now: meioDia(1) })]);
    const recusadas = resultados.filter((r) => r.status === 'rejected');
    assert.equal(recusadas.length, 1);
    assert.equal(recusadas[0].reason.code, 'already_running');
    const linhas = await sends();
    const chaves = linhas.map((l) => `${l.contract}|${l.invoice_key}|${l.kind}|${l.step_offset}`);
    assert.equal(new Set(chaves).size, chaves.length, 'nenhuma decisão duplicada');
    assert.ok(linhas.length >= antes);
  });

  it('dias depois, manda a próxima etapa — até o teto por fatura', async () => {
    // R-ATRASO-2 venceu há 2 dias e recebeu a D+1. Três dias depois é o quinto
    // dia: a D+5 é devida.
    let summary = await run({ now: meioDia(3) });
    const maria = (await sends()).filter((l) => l.contract === 'R-ATRASO-2' && l.status === 'queued');
    assert.deepEqual(maria.map((l) => l.step_offset).sort(), [1, 5]);

    // Com teto 1, uma fatura já cobrada não recebe mais nada: a etapa nova vira
    // `max_reached`, gravada, para aparecer no histórico.
    await saveRule({ maxPerInvoice: 1, steps: [...STEPS(), { offsetDays: 10, templateId: templateIds.cobranca }] });
    summary = await run({ now: meioDia(9) });
    assert.ok(summary.skipped.maxReached >= 1);
    const teto = (await sends()).find((l) => l.contract === 'R-ATRASO-2' && l.step_offset === 10);
    assert.equal(teto.status, 'skipped');
    assert.equal(teto.reason, 'max_reached');
    await saveRule({ maxPerInvoice: 6, steps: STEPS() });
  });

  it('o intervalo mínimo adia, sem gastar a etapa', async () => {
    await saveRule({ minIntervalHours: 48, steps: [...STEPS(), { offsetDays: 11, templateId: templateIds.cobranca }] });
    // João recebeu a D+5 hoje (dia 10). Amanhã é o dia 11: a D+11 é devida,
    // mas a última cobrança foi há menos de 48 horas.
    await asTenant(() => getDb()('wa_dunning_sends').where({ contract: 'R-ATRASO-10' })
      .update({ created_at: meioDia(0) }));
    const summary = await run({ now: meioDia(1) });
    assert.ok(summary.skipped.interval >= 1);
    const onze = (await sends()).find((l) => l.contract === 'R-ATRASO-10' && l.step_offset === 11);
    assert.equal(onze, undefined, 'adiada não é gravada: sai quando o intervalo vencer');
    await saveRule({ minIntervalHours: 0, steps: STEPS() });
  });
});

describe('pagou, parou', () => {
  it('o webhook de pagamento tira da fila o que ainda não saiu', async () => {
    // Maria recebeu a D+1 e a D+5, as duas ainda na fila: o outbox não roda
    // neste teste. Pagou — nenhuma das duas pode sair.
    const maria = byContract.get('R-ATRASO-2');
    const antes = (await sends()).filter((l) => l.contract === 'R-ATRASO-2' && l.status === 'queued');
    assert.deepEqual(antes.map((l) => l.step_offset).sort((a, b) => a - b), [1, 5]);
    const mensagemIds = antes.map((l) => l.message_id);

    maria.invoices[0].dataPagamento = dayOffset(0);
    const r = await asTenant(() => WaDunningService.onPayment('R-ATRASO-2'));
    assert.equal(r.paid, 1);

    const depois = (await sends()).filter((l) => l.contract === 'R-ATRASO-2' && l.kind === 'step');
    assert.ok(depois.every((l) => l.paid_at), 'a fatura inteira fica marcada como paga');
    for (const id of antes.map((l) => l.id)) {
      const linha = depois.find((l) => l.id === id);
      assert.equal(linha.status, 'canceled');
      assert.equal(linha.reason, 'paid');
    }
    const naFila = await asTenant(() => getDb()('wa_messages').whereIn('id', mensagemIds));
    assert.equal(naFila.length, 0, 'a cobrança que ainda estava na fila saiu dela');
    // Quem não chegou a receber cobrança não recebe "obrigado pelo pagamento".
    assert.equal(r.thanked, 0);
  });

  it('agradece uma vez quem foi cobrado e pagou', async () => {
    const carlos = byContract.get('R-FUTURA-3');
    const lembrete = (await sends()).find((l) => l.contract === 'R-FUTURA-3' && l.status === 'queued');
    assert.equal(lembrete.step_offset, -3);
    // O lembrete já saiu: o pagamento não o cancela, e o agradecimento vai.
    await asTenant(() => getDb()('wa_messages').where({ id: lembrete.message_id }).update({ delivery_status: 'sent' }));

    carlos.invoices[0].dataPagamento = dayOffset(0);
    const r1 = await asTenant(() => WaDunningService.onPayment('R-FUTURA-3'));
    assert.equal(r1.paid, 1);
    assert.equal(r1.thanked, 1);
    const saiu = (await sends()).find((l) => l.id === lembrete.id);
    assert.equal(saiu.status, 'queued', 'a mensagem que já saiu não vira cancelada');
    assert.ok(saiu.paid_at);

    const obrigado = (await sends()).filter((l) => l.contract === 'R-FUTURA-3' && l.kind === 'thanks');
    assert.equal(obrigado.length, 1);
    const texto = await asTenant(() => getDb()('wa_messages').where({ id: obrigado[0].message_id }).first());
    assert.match(texto.body, /Recebemos o pagamento de R\$ 99,90/);

    const r2 = await asTenant(() => WaDunningService.onPayment('R-FUTURA-3'));
    assert.equal(r2.thanked, 0);
    assert.equal((await sends()).filter((l) => l.contract === 'R-FUTURA-3' && l.kind === 'thanks').length, 1);
  });

  it('a passada percebe o pagamento sem webhook, e não cobra mais', async () => {
    const joao = byContract.get('R-ATRASO-10');
    // A mensagem já saiu: o pagamento marca a data, mas não cancela o que foi.
    await asTenant(() => getDb()('wa_messages')
      .whereIn('id', getDb()('wa_dunning_sends').where({ contract: 'R-ATRASO-10' }).whereNotNull('message_id').select('message_id'))
      .update({ delivery_status: 'sent' }));
    joao.invoices[0].dataPagamento = dayOffset(0);
    const summary = await run({ now: meioDia(20) });
    assert.ok(summary.paid >= 1);
    const linhas = (await sends()).filter((l) => l.contract === 'R-ATRASO-10');
    assert.ok(linhas.filter((l) => l.kind === 'step').every((l) => l.paid_at), 'todas as etapas da fatura paga marcadas');
    assert.equal(linhas.filter((l) => l.kind === 'step' && l.status === 'queued' && l.step_offset > 5).length, 0,
      'nenhuma etapa nova depois de pagar');
    assert.equal(linhas.filter((l) => l.kind === 'thanks').length, 1);
  });

  it('uma fatura que só sumiu, sem pagamento, não é dada como paga', async () => {
    // Cancelada no ERP: some das em aberto E da lista completa, sem data de
    // pagamento. Não rende agradecimento, nem marca nada.
    const lucia = byContract.get('R-SEM-PIX');
    const guardada = lucia.invoices;
    lucia.invoices = [];
    const r = await asTenant(() => WaDunningService.onPayment('R-SEM-PIX'));
    assert.equal(r.paid, 0);
    const linhas = (await sends()).filter((l) => l.contract === 'R-SEM-PIX');
    assert.ok(linhas.every((l) => !l.paid_at));
    lucia.invoices = guardada;
  });
});

describe('histórico e resultado', () => {
  it('lista os envios com o motivo e o estado da mensagem', async () => {
    const { status, body } = await api('/dunning/sends?limit=100');
    assert.equal(status, 200);
    const optout = body.data.items.find((i) => i.contract === 'R-OPTOUT');
    assert.equal(optout.status, 'skipped');
    assert.equal(optout.reason, 'opt_out');
    assert.deepEqual(optout.missing, []);
    const semPix = body.data.items.find((i) => i.contract === 'R-SEM-PIX' && i.kind === 'step');
    assert.equal(semPix.reason, 'template_incomplete');
    assert.deepEqual(semPix.missing, ['pix'], 'o histórico guarda qual variável faltou');
    const joao = body.data.items.find((i) => i.contract === 'R-ATRASO-10' && i.kind === 'step' && i.status === 'queued');
    assert.equal(joao.deliveryStatus, 'sent');
    assert.equal(joao.templateName, 'régua cobrança');
  });

  it('filtra os envios que falharam na entrega', async () => {
    const todos = (await api('/dunning/sends?limit=100')).body.data.items;
    const joao = todos.find((i) => i.contract === 'R-ATRASO-10' && i.kind === 'step' && i.status === 'queued');
    const id = (await getDb()('wa_dunning_sends').where({ contract: 'R-ATRASO-10', kind: 'step', status: 'queued' }).first()).message_id;
    await getDb()('wa_messages').where({ id }).update({ delivery_status: 'failed' });
    try {
      const { status, body } = await api('/dunning/sends?status=failed&limit=100');
      assert.equal(status, 200);
      assert.ok(body.data.items.length >= 1);
      assert.ok(body.data.items.every((i) => i.deliveryStatus === 'failed'));
      assert.ok(body.data.items.some((i) => i.contract === joao.contract));
    } finally {
      await getDb()('wa_messages').where({ id }).update({ delivery_status: 'sent' });
    }
  });

  it('conta o que foi recuperado', async () => {
    const { body } = await api('/dunning/stats?days=30');
    // João (129,90), Maria (89,90) e Carlos (99,90) foram cobrados, e os três
    // pagaram. Agradecidos: João e Carlos — Maria não chegou a receber nada.
    assert.equal(body.data.invoices, 3);
    assert.equal(body.data.invoicesPaid, 3);
    assert.equal(body.data.amountRecovered, 319.7);
    assert.equal(body.data.recoveryRate, 100);
    assert.equal(body.data.thanks, 2);
    assert.equal(body.data.skipped.opt_out >= 1, true);
    assert.ok(body.data.byStep.find((s) => s.offsetDays === 5).sent >= 1);
  });

  it('rodar agora recusa com a régua desligada', async () => {
    await api('/dunning/enabled', { method: 'POST', body: { enabled: false } });
    const { status, body } = await api('/dunning/run', { method: 'POST' });
    assert.equal(status, 400);
    assert.equal(body.code, 'rule_disabled');
  });
});
