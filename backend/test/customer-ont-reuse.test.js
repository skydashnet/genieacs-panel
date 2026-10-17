import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: CustomerDataExportService } = await import(
  '../src/services/customerDataExportService.js'
);
const { default: CustomerErasureService } = await import('../src/services/customerErasureService.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
const { tinsertReturningId } = await import('../src/config/database.js');

/**
 * A ONT que muda de casa.
 *
 * O ISP recolhe a ONT de X e instala na casa de Y. `retireAccount` fecha a
 * conta de X, mas a telemetria, os eventos do ERP e as conversas de X ficam
 * gravados sob o mesmo device id — e é por ele que o dossiê e a exclusão
 * procuravam. O dossiê de Y entregava a Y a história de X, e a exclusão pedida
 * por Y apagava a de X.
 *
 * O que este arquivo guarda: cada um leva o que é seu, e só o que é seu.
 */
const ONT = 'ONT-REAPROVEITADA';
const HORA = 60 * 60 * 1000;

let tenantId;
let antigo;
let novo;

before(async () => {
  await startTestServers();
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  await runInTenant(tenantId, async () => {
    antigo = await CustomerService.ensureAccount({ _id: ONT, softwareId: 'V1', pppoe: 'assinante-x' });
    await getDb()('customer_accounts').where({ id: antigo.id })
      .update({ created_at: new Date(Date.now() - 3 * HORA) });

    // A casa de X, enquanto a ONT era dele.
    await tinsertReturningId('device_samples', {
      device_id: ONT, inform_at: new Date(Date.now() - 2 * HORA), rx_power: -31.1
    });
    await tinsertReturningId('device_sample_hours', {
      device_id: ONT, bucket_at: new Date(Date.now() - 2 * HORA), sample_count: 1, rx_avg: -31.1
    });
    await tinsertReturningId('sgp_events', {
      dedupe_key: 'evento-de-x',
      source: 'webhook',
      type: 'contract.updated',
      contract: 'CONTRATO-X',
      device_id: ONT,
      occurred_at: new Date(Date.now() - 2 * HORA),
      payload: JSON.stringify({ nome: 'Fulano X' })
    });
    const instancia = await tinsertReturningId('whatsapp_accounts', {
      name: 'instancia-reuso', base_url: 'https://evo.exemplo.test'
    });
    const conversaDeX = await tinsertReturningId('wa_conversations', {
      account_id: instancia,
      wa_phone_e164: '5511988880001',
      external_thread_id: 'thread-x',
      push_name: 'Fulano X',
      device_id: ONT,
      customer_account_id: antigo.id,
      created_at: new Date(Date.now() - 2 * HORA),
      last_message_at: new Date(Date.now() - 2 * HORA)
    });
    await tinsertReturningId('wa_messages', {
      conversation_id: conversaDeX, direction: 'in', external_id: 'msg-x', body: 'Aqui é o X'
    });

    // A ONT vai para a casa de Y.
    novo = await CustomerService.ensureAccount({ _id: ONT, softwareId: 'V1', pppoe: 'assinante-y' });
    assert.notEqual(novo.id, antigo.id, 'o fixture precisa de duas contas');
    antigo = await CustomerAccount.getById(antigo.id);

    await tinsertReturningId('device_samples', {
      device_id: ONT, inform_at: new Date(Date.now() + 1000), rx_power: -18.8
    });
    await tinsertReturningId('sgp_links', {
      account_id: novo.id, device_id: ONT, contract: 'CONTRATO-Y', client_name: 'Fulana Y'
    });
  });
});

after(async () => {
  await stopTestServers();
});

const dossie = (conta) => runInTenant(tenantId, () => CustomerDataExportService.build(conta.id));

describe('o dossiê de quem recebeu a ONT', () => {
  it('não traz nada do dono anterior', async () => {
    const arquivo = await dossie(novo);
    const texto = JSON.stringify(arquivo);
    assert.equal(texto.includes('Fulano X'), false, 'o nome de X saiu no arquivo de Y');
    assert.equal(texto.includes('CONTRATO-X'), false);
    assert.deepEqual(arquivo.data.wa_conversations, []);
    assert.deepEqual(arquivo.data.wa_messages, []);
    assert.deepEqual(arquivo.data.device_sample_hours, []);
    assert.deepEqual(arquivo.data.device_samples.map((l) => Number(l.rx_power)), [-18.8]);
  });

  it('e continua trazendo o que é dele', async () => {
    const arquivo = await dossie(novo);
    assert.deepEqual(arquivo.data.sgp_links.map((l) => l.contract), ['CONTRATO-Y']);
  });
});

describe('o dossiê de quem teve a conta aposentada', () => {
  it('traz a própria história, que só sobrevive pelo registro da aposentadoria', async () => {
    const arquivo = await dossie(antigo);
    assert.deepEqual(arquivo.data.device_samples.map((l) => Number(l.rx_power)), [-31.1]);
    assert.equal(arquivo.data.wa_conversations.length, 1);
    assert.equal(arquivo.data.sgp_events.length, 1);
    assert.ok(arquivo.data.audit_log.some((l) => l.action === 'subscriber_account.retired'),
      'a aposentadoria é o que o titular mais precisa ver, e ficava de fora');
  });

  it('e nada de quem veio depois', async () => {
    const texto = JSON.stringify(await dossie(antigo));
    assert.equal(texto.includes('Fulana Y'), false);
    assert.equal(texto.includes('CONTRATO-Y'), false);
    assert.equal(texto.includes('-18.8'), false);
  });
});

describe('a exclusão pedida por quem recebeu a ONT', () => {
  it('apaga o que é dele e deixa de pé o que é do dono anterior', async () => {
    await runInTenant(tenantId, async () => {
      const levantamento = await CustomerErasureService.survey(novo);
      assert.equal(levantamento.rowCounts.device_samples, 1);
      assert.equal(levantamento.rowCounts.wa_conversations, 0);
      assert.equal(levantamento.rowCounts.sgp_events, 0);
      await CustomerErasureService.erase(novo, levantamento);
    });

    const db = getDb();
    const amostras = await db('device_samples').where({ tenant_id: tenantId, device_id: ONT });
    assert.deepEqual(amostras.map((l) => Number(l.rx_power)), [-31.1]);
    assert.equal((await db('device_sample_hours').where({ tenant_id: tenantId, device_id: ONT })).length, 1);
    assert.equal((await db('sgp_events').where({ tenant_id: tenantId, dedupe_key: 'evento-de-x' })).length, 1);
    assert.equal((await db('wa_conversations').where({ tenant_id: tenantId, external_thread_id: 'thread-x' })).length, 1);
    assert.equal((await db('wa_messages').where({ tenant_id: tenantId, external_id: 'msg-x' })).length, 1);
  });
});
