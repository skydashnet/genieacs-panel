import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { CADENCIA_PADRAO, lerCadencia, proximaVez } = await import('../src/utils/wa/waCadencia.js');

/**
 * O ritmo das mensagens automáticas.
 *
 * O teto por minuto deixava a passada mandar vinte cobranças coladas uma na
 * outra, e rajada é o que o WhatsApp bloqueia. Agora `source='campaign'` sai uma
 * por vez, com um intervalo sorteado entre elas e uma pausa longa a cada tantas;
 * o resto (atendente, bot, alerta) continua saindo na hora.
 *
 * Nada aqui dorme: a passagem do tempo é o `proximaEm` do ritmo movido para trás,
 * que é o que uma passada mais tarde encontraria.
 */
const EVO_BASE = 'https://evo.ritmo.test';
const ACCOUNT = 'painel-ritmo';
const ACCOUNT_TOKEN = 'token-ritmo-999';

/** What the stub answers a send with, per test. */
const stub = { status: 200, body: null, nextId: 0 };

/** Every send the stub saw. */
const sends = [];

let evoServer;
let evoLocalUrl;
let desfazerRota;
let accountId;
let conversationId;

function startEvolutionStub() {
  evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      if (!path.startsWith('/message/sendText/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'unknown route' }));
      }
      sends.push({ path });
      res.writeHead(stub.status, { 'Content-Type': 'application/json' });
      if (stub.status === 200) {
        stub.nextId += 1;
        return res.end(JSON.stringify({ key: { id: `EVO-${stub.nextId}` }, status: 'PENDING' }));
      }
      return res.end(JSON.stringify(stub.body ?? { message: 'server error' }));
    });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${evoServer.address().port}`));
  });
}

before(async () => {
  await startTestServers();
  evoLocalUrl = await startEvolutionStub();

  // The SSRF guard blocks loopback by literal, so the account points at a name
  // that resolves nowhere and `fetch` is rewritten onto the stub. Everything
  // past that line is real: a real socket, real status codes, real bodies.
  // O cliente Evolution conecta por `PinnedTransport`, não por `fetch`: a rota
  // para o dublê troca os encaixes dele, e a guarda de endereço roda inteira.
  desfazerRota = rotearBase(EVO_BASE, evoLocalUrl);

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    // Folga no teto do minuto: o que se mede aqui é o espaço ENTRE mensagens.
    rateLimitPerMin: 100
  }));

  const account = await asTenant(() => WhatsAppAccount.create({
    name: ACCOUNT,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(ACCOUNT_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-ritmo')
  }));
  accountId = account.id;

  const conversation = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: '5593981110499@s.whatsapp.net',
    waPhone: '5593981110499',
    waLid: null,
    pushName: 'Cliente'
  }));
  conversationId = conversation.id;
});

after(async () => {
  desfazerRota?.();
  WaOutboxWorker.stop();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

/** Uma mensagem de saída na fila. */
async function seedMessage(source) {
  const at = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
  return asTenant(() => WaMessage.create({
    conversation_id: conversationId,
    direction: 'out',
    body: `mensagem ${source}`,
    is_note: false,
    source,
    delivery_status: 'queued',
    created_at: at,
    updated_at: at
  }));
}

const statusOf = async (id) => (await asTenant(() => WaMessage.getById(id))).delivery_status;

/** O tempo passou: a vez da próxima automática já chegou. */
function passarOTempo() {
  for (const [tenant, ritmo] of WaOutboxWorker.paces) {
    WaOutboxWorker.paces.set(tenant, { ...ritmo, proximaEm: Date.now() - 1 });
  }
}

beforeEach(async () => {
  await getDb()('wa_messages').del();
  await getDb()('app_state').whereIn('key', [WaOutboxWorker.PACE_KEY, WaOutboxWorker.WINDOW_KEY]).del();
  WaOutboxWorker.stop();
  stub.status = 200;
  sends.length = 0;
});

describe('a regra do ritmo', () => {
  it('sorteia dentro da faixa', () => {
    const cfg = { ...CADENCIA_PADRAO };
    const menor = proximaVez({ agora: 0, sequencia: 0, cfg, sorteio: () => 0 });
    const maior = proximaVez({ agora: 0, sequencia: 0, cfg, sorteio: () => 1 });
    assert.equal(menor.proximaEm, 20_000);
    assert.equal(maior.proximaEm, 45_000);
    assert.equal(menor.sequencia, 1);
  });

  it('faz a pausa longa na 30ª e recomeça a contagem', () => {
    const pausa = proximaVez({ agora: 0, sequencia: 29, cfg: CADENCIA_PADRAO, sorteio: () => 0 });
    assert.deepEqual(pausa, { proximaEm: 5 * 60_000, sequencia: 0 });
  });

  it('sem pausa quando o lote é zero', () => {
    const cfg = { ...CADENCIA_PADRAO, bulkBurstSize: 0 };
    const vez = proximaVez({ agora: 0, sequencia: 499, cfg, sorteio: () => 0 });
    assert.equal(vez.proximaEm, 20_000);
    assert.equal(vez.sequencia, 500);
  });

  it('corrige o que vier fora dos limites', () => {
    assert.deepEqual(
      lerCadencia({ bulkIntervalMinSec: 40, bulkIntervalMaxSec: 10, bulkBurstSize: -3, bulkBurstPauseMin: 999 }),
      { bulkIntervalMinSec: 40, bulkIntervalMaxSec: 40, bulkBurstSize: 0, bulkBurstPauseMin: 120 }
    );
    assert.deepEqual(lerCadencia({}), { ...CADENCIA_PADRAO });
  });
});

describe('o worker no ritmo', () => {
  it('manda a resposta do atendente na hora e UMA automática por vez', async () => {
    const campanhas = [await seedMessage('campaign'), await seedMessage('campaign'), await seedMessage('campaign')];
    const operador = await seedMessage('operator');

    const primeira = await WaOutboxWorker.tick();
    assert.equal(primeira.sent, 2, 'a do atendente e uma automática');
    assert.equal(await statusOf(operador.id), 'sent');
    assert.deepEqual(
      await Promise.all(campanhas.map((m) => statusOf(m.id))),
      ['sent', 'queued', 'queued']
    );

    const cedo = await WaOutboxWorker.tick();
    assert.equal(cedo.sent, 0, 'antes da vez, nenhuma automática sai');

    passarOTempo();
    const depois = await WaOutboxWorker.tick();
    assert.equal(depois.sent, 1);
    assert.equal(await statusOf(campanhas[1].id), 'sent');
    assert.equal(await statusOf(campanhas[2].id), 'queued');
  });

  it('o intervalo sobrevive a um restart', async () => {
    await seedMessage('campaign');
    const segunda = await seedMessage('campaign');
    assert.equal((await WaOutboxWorker.tick()).sent, 1);

    const gravado = JSON.parse(await asTenant(() => AppState.get(WaOutboxWorker.PACE_KEY)));
    assert.ok(gravado.proximaEm > Date.now() + 15_000, 'a próxima vez ficou gravada');

    // O deploy: a memória some, o banco fica.
    WaOutboxWorker.stop();
    assert.equal((await WaOutboxWorker.tick()).sent, 0);
    assert.equal(await statusOf(segunda.id), 'queued');
  });

  it('uma próxima vez absurda, de relógio que voltou, não trava a fila', async () => {
    const mensagem = await seedMessage('campaign');
    await asTenant(() => AppState.upsert(
      WaOutboxWorker.PACE_KEY,
      JSON.stringify({ proximaEm: Date.now() + 24 * 3600_000, sequencia: 3 })
    ));
    assert.equal((await WaOutboxWorker.tick()).sent, 1);
    assert.equal(await statusOf(mensagem.id), 'sent');
  });
});

describe('a configuração do ritmo', () => {
  it('nasce com 20–45 s e pausa de 5 min a cada 30', async () => {
    const config = await asTenant(() => WhatsAppConfigService.getPublicConfig());
    assert.equal(config.bulkIntervalMinSec, 20);
    assert.equal(config.bulkIntervalMaxSec, 45);
    assert.equal(config.bulkBurstSize, 30);
    assert.equal(config.bulkBurstPauseMin, 5);
  });

  it('grava o que a pessoa escolheu, campo a campo', async () => {
    let config = await asTenant(() => WhatsAppConfigService.saveConfig({
      bulkIntervalMinSec: 60, bulkIntervalMaxSec: 30, bulkBurstSize: 0
    }));
    assert.equal(config.bulkIntervalMinSec, 60);
    assert.equal(config.bulkIntervalMaxSec, 60, 'máximo abaixo do mínimo vira o mínimo');
    assert.equal(config.bulkBurstSize, 0);
    assert.equal(config.bulkBurstPauseMin, 5, 'o que não veio fica como estava');

    config = await asTenant(() => WhatsAppConfigService.saveConfig({ bulkBurstPauseMin: 10 }));
    assert.equal(config.bulkIntervalMinSec, 60);
    assert.equal(config.bulkBurstPauseMin, 10);
  });
});
