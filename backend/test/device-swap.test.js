import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: DeviceSwap } = await import('../src/models/DeviceSwap.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: DeviceSwapService } = await import('../src/services/deviceSwapService.js');

const PPPOE = 'subscriber-1@isp';

/** What GenieACS hands the sync for one ONT. */
function inform(deviceId, { softwareId = 'V1.0.0', pppoe = PPPOE } = {}) {
  return { _id: deviceId, softwareId, pppoe };
}

const ensure = (device) => asTenant(() => CustomerService.ensureAccount(device));
const linkFor = (deviceId) => asTenant(() => SgpLink.getByDeviceId(deviceId));
const swapsFor = (deviceId) => asTenant(() => DeviceSwap.listForDevice(deviceId));
const openSwaps = () => asTenant(() => DeviceSwap.listOpen());

/** A contract bound to an ONT, with the two things the ERP did not put there. */
async function linkDevice(deviceId, patch = {}) {
  await getDb()('sgp_links').insert({
    device_id: deviceId,
    contract: '4242',
    link_mode: 'manual',
    phone_manual: '+5511999990000',
    ...patch
  });
}

let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('device_swaps').del();
  await getDb()('sgp_links').del();
  await getDb()('customer_accounts').del();
});

describe('detecting the swap', () => {
  it('records the replacement when the new ONT runs the same firmware', async () => {
    // The common case, and the one a hook on the PPPoE branch alone would miss:
    // same model, same firmware, so the identity hash is unchanged and the
    // account matches on it before the login is ever compared.
    await ensure(inform('ont-old'));
    const moved = await ensure(inform('ont-new'));

    assert.equal(moved.device_id, 'ont-new');
    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.previous_device_id, 'ont-old');
    assert.equal(swap.matched_by, 'identity_hash');
    assert.equal(Number(swap.repeat_count), 1);
    assert.equal(Boolean(swap.flapping), false);
  });

  it('records the replacement when the new ONT runs different firmware', async () => {
    await ensure(inform('ont-old', { softwareId: 'V1.0.0' }));
    await ensure(inform('ont-new', { softwareId: 'V2.4.1' }));

    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.matched_by, 'pppoe');
    assert.equal(swap.previous_device_id, 'ont-old');
  });

  it('records nothing when the same ONT informs again', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-old', { softwareId: 'V2.4.1' }));

    assert.equal((await getDb()('device_swaps')).length, 0);
  });

  it('records nothing when the ONT was re-provisioned for someone else', async () => {
    // A different login on the same equipment is a new subscriber, not a
    // replacement: the account is retired rather than moved, and filing that as
    // a swap would tell the operator to expect one customer on two ONTs.
    await ensure(inform('ont-old'));
    await ensure(inform('ont-old', { pppoe: 'subscriber-2@isp' }));

    assert.equal((await getDb()('device_swaps')).length, 0);
  });
});

describe('the SGP link', () => {
  it('carries the contract onto the new ONT with the manual corrections intact', async () => {
    await ensure(inform('ont-old'));
    await linkDevice('ont-old');

    await ensure(inform('ont-new'));

    assert.equal(await linkFor('ont-old'), null);
    const link = await linkFor('ont-new');
    assert.equal(link.contract, '4242');
    // A delete-and-relookup would leave both of these gone, with nothing said.
    assert.equal(link.phone_manual, '+5511999990000');
    assert.equal(link.link_mode, 'manual');

    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.link_action, 'moved');
    assert.equal(swap.contract, '4242');
  });

  it('drops the old link when the new ONT already has one of its own', async () => {
    await ensure(inform('ont-old'));
    await linkDevice('ont-old');
    await linkDevice('ont-new', { contract: '4242', phone_manual: '+5511999990000' });

    await ensure(inform('ont-new'));

    assert.equal(await linkFor('ont-old'), null);
    const link = await linkFor('ont-new');
    assert.equal(link.phone_manual, '+5511999990000');
    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.link_action, 'cleared');
  });

  it('says so rather than inventing a link that never existed', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    const [swap] = await swapsFor('ont-new');
    assert.equal(swap.link_action, 'none');
    assert.equal(swap.contract, null);
  });
});

describe('two ONTs trading one login', () => {
  it('stops moving the link and flags the pair instead', async () => {
    await ensure(inform('ont-old'));
    await linkDevice('ont-old');

    // The replacement informs, and the link follows it.
    await ensure(inform('ont-new'));
    assert.ok(await linkFor('ont-new'));

    // The old one is still powered on and informs a minute later. Following it
    // back would take the contract off the ONT that is actually in service.
    await ensure(inform('ont-old'));

    const back = await asTenant(() => DeviceSwap.getPair('ont-new', 'ont-old'));
    assert.equal(back.link_action, 'held');
    assert.equal(Boolean(back.flapping), true);
    assert.ok(await linkFor('ont-new'), 'the link must stay where it was');
    assert.equal(await linkFor('ont-old'), null);
  });

  it('flags both directions, so the pair reads as one story', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));

    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    assert.equal(Boolean(forward.flapping), true);
  });

  it('folds a repeat into the row already describing it', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    const rows = await getDb()('device_swaps');
    assert.equal(rows.length, 2, 'one row per direction, however many times it happens');
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    assert.equal(Number(forward.repeat_count), 2);
  });

  it('reopens a repeat the operator had already dismissed', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    await asTenant(() => DeviceSwap.acknowledge(forward.id));
    assert.equal((await openSwaps()).length, 0);

    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    const reopened = await asTenant(() => DeviceSwap.getById(forward.id));
    assert.equal(reopened.acknowledged_at, null);
  });

  it('dismissing one direction of an unstable pair dismisses both', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    assert.equal((await openSwaps()).length, 2);

    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    await asTenant(() => DeviceSwap.acknowledge(forward.id));

    assert.equal((await openSwaps()).length, 0);
  });

  it('keeps an unstable pair dismissed while it goes on trading the login', async () => {
    // The ONTs stay powered on and keep alternating every few minutes. The
    // operator already confirmed the pair is unstable; bringing the warning
    // back on each inform made "Confirmar" look like it did nothing.
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    await asTenant(() => DeviceSwap.acknowledge(forward.id));

    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));

    assert.equal((await openSwaps()).length, 0);
    const after = await asTenant(() => DeviceSwap.getById(forward.id));
    assert.equal(Number(after.repeat_count), 3, 'the repeats are still counted');
  });

  it('reopens a dismissed unstable pair that went quiet and then swapped again', async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    await asTenant(() => DeviceSwap.acknowledge(forward.id));

    // Nothing for a whole day: the next swap is news again.
    const longAgo = new Date(Date.now() - DeviceSwapService.dismissedFlapWindowMs() - 60_000);
    await getDb()('device_swaps').update({ occurred_at: longAgo });

    await ensure(inform('ont-new'));

    const reopened = await asTenant(() => DeviceSwap.getById(forward.id));
    assert.equal(reopened.acknowledged_at, null);
  });

  it('keeps it dismissed across a gap longer than the flap window', async () => {
    // The pair trades whenever someone opens the device list or the sweep
    // runs, and an hour between two of those is ordinary. That hour used to
    // put both directions back on the dashboard after "Confirmar".
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));
    const forward = await asTenant(() => DeviceSwap.getPair('ont-old', 'ont-new'));
    await asTenant(() => DeviceSwap.acknowledge(forward.id));

    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    await getDb()('device_swaps').update({ occurred_at: anHourAgo });
    await ensure(inform('ont-new'));
    await ensure(inform('ont-old'));

    assert.equal((await openSwaps()).length, 0);
    const rows = await getDb()('device_swaps');
    assert.ok(rows.every((row) => Boolean(row.flapping)), 'the pair is still read as unstable');
  });
});

describe('the ONT that informed last keeps the account', () => {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const sync = (devices) => asTenant(() => CustomerService.syncDevices(devices, { enabled: true }));

  it('does not hand the account back to the old ONT still sitting in GenieACS', async () => {
    // The old ONT stayed in GenieACS with the same login. Each sweep saw it
    // without an account and took it back: A→B, B→A, "par instável · 97×".
    const old = { ...inform('ont-old'), _lastInform: minutesAgo(600) };
    const replacement = { ...inform('ont-new'), _lastInform: minutesAgo(2) };
    await ensure({ ...old, _lastInform: minutesAgo(700) });
    await sync([old, replacement]);
    await sync([old, replacement]);
    await sync([old, replacement]);

    const [account] = await getDb()('customer_accounts').where({ active: true });
    assert.equal(account.device_id, 'ont-new');
    const rows = await getDb()('device_swaps');
    assert.equal(rows.length, 1, 'one swap, and no way back');
    assert.equal(rows[0].device_id, 'ont-new');
    assert.equal(Number(rows[0].repeat_count), 1);
  });

  it('still moves the account when the new ONT informed after the old one', async () => {
    await ensure({ ...inform('ont-old'), _lastInform: minutesAgo(30) });
    const moved = await sync([
      { ...inform('ont-old'), _lastInform: minutesAgo(30) },
      { ...inform('ont-new'), _lastInform: minutesAgo(1) }
    ]);
    assert.ok(moved.get('ont-new'));
    assert.equal(moved.get('ont-old'), undefined);
  });
});

describe('the operator API', () => {
  beforeEach(async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
  });

  it('lists what has not been looked at yet', async () => {
    const { status, body } = await call(
      `${panelUrl}/api/devices/swaps`,
      { headers: authHeaders(token) }
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.open, 1);
    assert.equal(body.data.swaps[0].previousDeviceId, 'ont-old');
    assert.equal(body.data.swaps[0].deviceId, 'ont-new');
  });

  it('drops it off the list once acknowledged', async () => {
    const listed = await call(`${panelUrl}/api/devices/swaps`, { headers: authHeaders(token) });
    const { id } = listed.body.data.swaps[0];

    const acked = await call(`${panelUrl}/api/devices/swaps/${id}/acknowledge`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(acked.status, 200, JSON.stringify(acked.body));
    assert.ok(acked.body.data.acknowledgedAt);

    const again = await call(`${panelUrl}/api/devices/swaps`, { headers: authHeaders(token) });
    assert.equal(again.body.data.open, 0);
  });

  it('answers 404 for a swap that does not exist', async () => {
    const { status } = await call(`${panelUrl}/api/devices/swaps/999999/acknowledge`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    assert.equal(status, 404);
  });

  it('serves both ends of the swap on the device page', async () => {
    for (const deviceId of ['ont-old', 'ont-new']) {
      // eslint-disable-next-line no-await-in-loop -- two assertions, not a hot path
      const { body } = await call(
        `${panelUrl}/api/devices/${deviceId}/swaps`,
        { headers: authHeaders(token) }
      );
      assert.equal(body.data.swaps.length, 1, `${deviceId} should see the swap`);
    }
  });

  it('requires a session', async () => {
    const { status } = await call(`${panelUrl}/api/devices/swaps`);
    assert.equal(status, 401);
  });
});

/**
 * Quem dispensou o aviso.
 *
 * A coluna existe desde que a tabela existe e gravava `null` em toda dispensa:
 * o controlador lia `req.user?.id`, e a sessão expõe `userId`. O encadeamento
 * opcional transformou o erro de digitação em silêncio — nenhuma exceção,
 * nenhum aviso, só uma coluna vazia. O teste antigo desta rota afirmava
 * `acknowledgedAt` e passava direto pelo lado vazio.
 *
 * Importa porque é o aviso que, ignorado, precede a aposentadoria da conta do
 * assinante anterior — a escrita destrutiva que o `audit_log` passou a
 * registrar. Sem esta coluna, a pergunta "quem deixou isso acontecer?" morre
 * um passo antes da trilha.
 */
describe('quem dispensou a troca', () => {
  let swapId;

  beforeEach(async () => {
    await ensure(inform('ont-old'));
    await ensure(inform('ont-new'));
    [{ id: swapId }] = await openSwaps();
  });

  const dispensar = () => call(`${panelUrl}/api/devices/swaps/${swapId}/acknowledge`, {
    method: 'POST',
    headers: authHeaders(token)
  });

  it('grava o id do operador, e não null', async () => {
    const operador = await getDb()('users').where({ username: 'operator' }).first();
    const { status } = await dispensar();
    assert.equal(status, 200);

    const linha = await getDb()('device_swaps').where({ id: swapId }).first();
    assert.equal(
      Number(linha.acknowledged_by), Number(operador.id),
      'a dispensa tem que nomear quem a fez'
    );
  });

  it('e a tela recebe o NOME, não o id', async () => {
    const dispensada = await dispensar();
    assert.equal(dispensada.body.data.acknowledgedBy, 'operator');

    // O histórico do aparelho é onde a troca já dispensada continua aparecendo,
    // e onde, sem o nome, ela é visualmente idêntica a uma aberta.
    const { body } = await call(
      `${panelUrl}/api/devices/ont-new/swaps`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.swaps[0].acknowledgedBy, 'operator');
  });

  it('e a troca que ninguém dispensou não inventa nome nenhum', async () => {
    const { body } = await call(
      `${panelUrl}/api/devices/ont-new/swaps`,
      { headers: authHeaders(token) }
    );
    assert.equal(body.data.swaps[0].acknowledgedBy, null);
  });
});
