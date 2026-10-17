import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaBroadcast, MAX_ATTEMPTS } = await import('../src/models/WaBroadcast.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');
const { retryDelayMs, retryScheduleMs } = await import('../src/services/waOutboxWorker.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');

/**
 * How long a campaign waits before giving up on a recipient.
 *
 * Be exact about the failure this guards against, because it is easy to state
 * wrongly: `WaBroadcastService.deliver` only ENQUEUES. It writes a row to
 * `wa_messages` and the outbox owns the transport, so an Evolution server that
 * is down never reaches its catch — that is the outbox's problem, and 0018
 * already survives it.
 *
 * What reaches this catch is `no_account`: the campaign is running and no
 * number is connected. Before 0019 that burned three attempts across about two
 * minutes and ended the entire campaign in `failed`, which is far less time
 * than an operator needs to notice a disconnected number and reconnect it.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let campaignId;

function seedRecipient(patch = {}) {
  return asTenant(() => insertReturningId('wa_broadcast_recipients', {
    broadcast_id: campaignId,
    phone_e164: '5593981110000',
    rendered_body: 'sua fatura venceu',
    status: 'pending',
    attempts: 0,
    created_at: wholeSecond(Date.now()),
    ...patch
  }));
}

const recipient = (id) => asTenant(() => WaBroadcast.getRecipient(id));
const pendingIds = () => asTenant(() => WaBroadcast.listPendingIds(campaignId, 50));

before(async () => {
  await startTestServers();
  campaignId = await asTenant(() => insertReturningId('wa_broadcasts', {
    title: 'Cobrança de teste',
    body: 'sua fatura venceu',
    status: 'running'
  }));
});

after(async () => {
  await stopTestServers();
});

describe('a recipient waiting out a retry', () => {
  it('is invisible to the flush loop until it is due', async () => {
    const id = await seedRecipient({ next_attempt_at: wholeSecond(Date.now() + 10 * 60_000) });
    assert.ok(!(await pendingIds()).includes(id), 'not due, so not picked up');
  });

  it('cannot be claimed while it is waiting', async () => {
    const id = await seedRecipient({ next_attempt_at: wholeSecond(Date.now() + 10 * 60_000) });
    // `listPendingIds` and `claimRecipient` repeat the same test on purpose, so
    // that two overlapping ticks cannot both take a row. A claim that ignored
    // the due time would make the first assertion cosmetic.
    assert.equal(await asTenant(() => WaBroadcast.claimRecipient(id)), null);
  });

  it('is due again once its time has passed', async () => {
    const id = await seedRecipient({ next_attempt_at: wholeSecond(Date.now() - 60_000) });
    assert.ok((await pendingIds()).includes(id));
  });

  /**
   * The upgrade case, and the common one: NULL means due now. Every row written
   * before the column existed carries it, so a campaign that was in flight
   * during the upgrade must not stall.
   */
  it('treats a null due time as due now', async () => {
    const id = await seedRecipient({ next_attempt_at: null });
    assert.ok((await pendingIds()).includes(id));
  });
});

describe('what a campaign does with a number that is not connected', () => {
  /**
   * No `whatsapp_accounts` row exists in this suite, so `WaSendService.enqueue`
   * throws `no_account` — which is the real condition, reached the real way.
   */
  it('schedules another attempt instead of giving up in two minutes', async () => {
    const id = await seedRecipient();
    const before = Date.now();

    const outcome = await asTenant(() => WaBroadcastService.deliver(id, { id: 1 }));
    assert.equal(outcome, 'retry');

    const row = await recipient(id);
    assert.equal(row.status, 'pending', 'still the loop’s to take');
    assert.equal(Number(row.attempts), 1);
    assert.ok(row.next_attempt_at, 'and it now carries a due time');
    const due = new Date(row.next_attempt_at).getTime();
    assert.ok(due > before, 'in the future');
    assert.ok(
      due <= before + retryDelayMs(1) + 5_000,
      'and on the outbox’s own curve, not a second one'
    );
  });

  it('gives the operator longer than a glance to reconnect the number', async () => {
    // The decision is the window, not the curve, and a window measured in tens
    // of minutes cannot be tested by waiting for it.
    const total = retryScheduleMs(MAX_ATTEMPTS).reduce((sum, wait) => sum + wait, 0);
    assert.ok(
      total > 10 * 60_000,
      `a campaign should survive longer than ten minutes of a disconnected number, got ${total} ms`
    );
  });

  it('still gives up eventually, and leaves no due time behind when it does', async () => {
    const id = await seedRecipient({ attempts: MAX_ATTEMPTS });

    const outcome = await asTenant(() => WaBroadcastService.deliver(id, { id: 1 }));
    assert.equal(outcome, 'failed');

    const row = await recipient(id);
    assert.equal(row.status, 'failed');
    assert.equal(
      row.next_attempt_at,
      null,
      'a terminal row has nothing left to wait for, and a leftover time would outlive its reason'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A garra, que por muito tempo não garrou nada
//
// `claimRecipient` promete no docstring que o `UPDATE` condicional impede dois
// ticks sobrepostos de contatarem o mesmo assinante. A promessa era vazia: a
// janela de retomada media idade por `created_at` — o instante em que a
// campanha foi MONTADA. Como o operador revisa o rascunho antes de disparar,
// toda campanha real já nasce com mais de cinco minutos, então a condição
// "garra morta" casava no mesmo instante da garra.
//
// O dano chega no cliente do cliente: o assinante recebe a mesma cobrança duas
// vezes.
// ─────────────────────────────────────────────────────────────────────────────
describe('dois ticks disputando o mesmo destinatário', () => {
  it('só um garra, mesmo numa campanha montada há horas', async () => {
    // A campanha montada muito antes do disparo é o caso NORMAL, não a exceção:
    // é o que acontece sempre que alguém revisa antes de enviar.
    const id = await seedRecipient({
      created_at: wholeSecond(Date.now() - 6 * 60 * 60 * 1000)
    });

    const primeiro = await asTenant(() => WaBroadcast.claimRecipient(id));
    const segundo = await asTenant(() => WaBroadcast.claimRecipient(id));

    assert.ok(primeiro, 'o primeiro tick tinha que garrar');
    assert.equal(segundo, null, 'o segundo tick garrou o mesmo assinante — ele recebe duas vezes');
  });

  it('a garra fica registrada, e é dela que a idade é medida', async () => {
    const id = await seedRecipient({
      created_at: wholeSecond(Date.now() - 6 * 60 * 60 * 1000)
    });
    await asTenant(() => WaBroadcast.claimRecipient(id));

    const linha = await recipient(id);
    assert.equal(linha.status, 'sending');
    assert.ok(linha.claimed_at, 'sem `claimed_at` a retomada volta a medir por `created_at`');
    // Recém-garrada, não pode aparecer para o tick seguinte.
    assert.ok(!(await pendingIds()).includes(id));
  });

  it('uma garra ABANDONADA continua sendo retomada — a queda tem que ser recuperável', async () => {
    // O outro lado da moeda: fechar a janela não pode deixar uma linha presa em
    // 'sending' para sempre quando o tick que a pegou morreu no meio.
    const id = await seedRecipient({
      status: 'sending',
      claimed_at: wholeSecond(Date.now() - 10 * 60 * 1000)
    });

    assert.ok((await pendingIds()).includes(id), 'garra morta tem que voltar para a fila');
    assert.ok(await asTenant(() => WaBroadcast.claimRecipient(id)));
  });

  it('linha antiga, de antes da coluna existir, não é retomada por engano', async () => {
    // `claimed_at` nulo em 'sending' nunca casa a retomada. É o certo: sem
    // instante de garra não há como saber se ela foi abandonada, e supor que
    // sim é exatamente o defeito que esta onda corrigiu.
    const id = await seedRecipient({
      status: 'sending',
      claimed_at: null,
      created_at: wholeSecond(Date.now() - 6 * 60 * 60 * 1000)
    });
    assert.ok(!(await pendingIds()).includes(id));
    assert.equal(await asTenant(() => WaBroadcast.claimRecipient(id)), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O ponto de não-retorno
//
// `WaSendService.enqueue` é o instante em que o assinante passa a VAI receber.
// Enquanto a escrita de bookkeeping dividia o `catch` do envio, um banco que
// soluçasse depois dela — lock timeout, `SQLITE_BUSY` — devolvia o destinatário
// a 'pending'. O tick seguinte o reenfileirava, e a mensagem já enfileirada
// saía do mesmo jeito: a mesma cobrança até sete vezes por causa de uma falha
// que não tinha nada a ver com o envio.
// ─────────────────────────────────────────────────────────────────────────────
describe('falha DEPOIS de a mensagem entrar na fila', () => {
  let accountId;

  before(async () => {
    // Uma conta de verdade: `WaConversation.ensure` tem chave estrangeira para
    // ela, e sem a linha o `deliver` cai antes de chegar ao enqueue — que é
    // justamente o ponto que este caso existe para exercitar.
    accountId = await asTenant(() => insertReturningId('whatsapp_accounts', {
      name: 'campanha-teste',
      base_url: 'https://evo.exemplo.test',
      status: 'connected',
      flavor: 'v2'
    }));
  });

  it('não devolve o destinatário para a fila', async () => {
    const id = await seedRecipient();
    const enqueueReal = WaSendService.enqueue;
    const updateReal = WaBroadcast.updateRecipient;
    let enfileirou = 0;

    // O enqueue dá certo: a mensagem está na fila e o assinante vai receber.
    WaSendService.enqueue = async () => {
      enfileirou += 1;
      return { id: 4242 };
    };
    // E SÓ a escrita de conclusão falha, que é o soluço de banco. As outras
    // continuam funcionando, senão o próprio caminho de erro quebraria e o
    // caso deixaria de medir o que quer medir.
    WaBroadcast.updateRecipient = async (recipientId, patch) => {
      if (patch?.status === 'sent') throw new Error('SQLITE_BUSY: database is locked');
      return updateReal.call(WaBroadcast, recipientId, patch);
    };

    let resultado;
    try {
      resultado = await asTenant(() => WaBroadcastService.deliver(id, { id: accountId }));
    } finally {
      WaSendService.enqueue = enqueueReal;
      WaBroadcast.updateRecipient = updateReal;
    }

    assert.equal(enfileirou, 1, 'o caso não chegou ao enqueue; não mede nada');
    // 'retry' aqui significaria reenvio — o assinante recebendo de novo o que
    // já foi enfileirado.
    assert.equal(resultado, 'sent');

    // A linha fica em 'sending', que é o estado honesto: enfileirada, sem
    // bookkeeping. A retomada por `claimed_at` cuida dela em cinco minutos se
    // de fato ninguém a concluiu.
    assert.equal((await recipient(id)).status, 'sending');
    assert.ok(!(await pendingIds()).includes(id), 'voltou para a fila: vai reenviar');
  });
});
