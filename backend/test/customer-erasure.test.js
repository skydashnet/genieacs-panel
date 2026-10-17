import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: CustomerErasureService } = await import(
  '../src/services/customerErasureService.js'
);
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { tinsertReturningId } = await import('../src/config/database.js');
const { DATA_DIR } = await import('../src/config/paths.js');

/**
 * O direito de eliminação — a metade da LGPD que destrói, e por isso a que tem
 * que ser provada linha a linha.
 *
 * As quatro maneiras de errar isto:
 *
 * 1. **Apagar de menos.** É o modo de falha silencioso e o mais provável: um
 *    `DELETE` na conta não estoura, não deixa órfão de chave estrangeira, e
 *    deixa CPF, nome e telefone de pé em três tabelas que são `SET NULL`. A
 *    resposta diria "pronto".
 * 2. **Deixar o segredo.** A senha do portal está guardada DUAS vezes na linha
 *    da conta — bcrypt e uma cópia cifrada reversível — e nenhum caminho do
 *    produto zera essas colunas. Uma exclusão que só marque `active: false`
 *    deixa a senha do assinante recuperável para sempre.
 * 3. **Apagar do vizinho.** O de sempre, e aqui sem volta.
 * 4. **Apagar o que tem que ficar.** A trilha e o "não me perturbe" — o
 *    segundo porque apagá-lo devolve a pessoa à lista de campanha na
 *    sincronização seguinte, que é desfazer o próprio pedido dela.
 */
let panelUrl;
let token;
let meu;
let vizinho;
let conta;
let contaVizinha;
let senhaDoPortal;
let anexo;
let instancia;

/** A linha crua, com provedor e tudo — nunca por um modelo. */
const cru = (tabela, where) => getDb()(tabela).where(where).first();

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  meu = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
  vizinho = (await db('tenants').where({ slug: 'vizinho' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

/**
 * Semeia o assinante inteiro, dos dois lados, do zero a cada caso.
 *
 * Do zero porque a exclusão destrói: um fixture compartilhado faria o segundo
 * caso rodar sobre o rastro do primeiro e provar o que já estava provado.
 */
async function semear() {
  const db = getDb();
  for (const tabela of [
    'wa_messages', 'wa_conversations', 'wa_opt_outs', 'wa_broadcast_recipients',
    'wa_broadcasts', 'whatsapp_accounts', 'sgp_events', 'sgp_links',
    'device_samples', 'device_sample_hours', 'device_swaps',
    'customer_wifi_credentials', 'mapping_edges', 'mapping_nodes',
    'audit_log', 'customer_accounts'
  ]) {
    await db(tabela).del();
  }

  const plantar = async (tenantId, slug) => runInTenant(tenantId, async () => {
    const account = await CustomerService.ensureAccount({
      _id: 'ONT-COMPARTILHADO', softwareId: 'V1', pppoe: `assinante-${slug}`
    });
    const senha = await CustomerPortalPasswordService.reveal(account);

    await tinsertReturningId('customer_wifi_credentials', {
      account_id: account.id,
      wifi_index: 0,
      ssid: `Casa-${slug}`,
      password_ciphertext: `cifra-do-wifi-${slug}`,
      password_iv: 'iv',
      password_tag: 'tag'
    });
    await tinsertReturningId('sgp_links', {
      account_id: account.id,
      device_id: 'ONT-COMPARTILHADO',
      contract: `CONTRATO-${slug}`,
      document: '52998224725',
      client_name: `Fulana do ${slug}`,
      login: `pppoe-${slug}`,
      phone_e164: `551199999000${slug === 'meu' ? 1 : 2}`
    });
    await tinsertReturningId('sgp_events', {
      dedupe_key: `evento-${slug}`,
      source: 'webhook',
      type: 'contract.updated',
      contract: `CONTRATO-${slug}`,
      document: '52998224725',
      device_id: 'ONT-COMPARTILHADO',
      payload: JSON.stringify({ nome: `Fulana do ${slug}` })
    });
    await tinsertReturningId('device_samples', {
      device_id: 'ONT-COMPARTILHADO', inform_at: new Date(), rx_power: -24.5
    });
    await tinsertReturningId('mapping_nodes', {
      node_id: `no-${slug}`,
      type: 'ont',
      name: `Drop da Fulana do ${slug}`,
      latitude: '-23.5',
      longitude: '-46.6',
      pppoe: `assinante-${slug}`,
      notes: `Fulana do ${slug}, casa azul`
    });

    const instanciaId = await tinsertReturningId('whatsapp_accounts', {
      name: `instancia-${slug}`, base_url: 'https://evo.exemplo.test'
    });
    const conversaId = await tinsertReturningId('wa_conversations', {
      account_id: instanciaId,
      wa_phone_e164: `551199999000${slug === 'meu' ? 1 : 2}`,
      external_thread_id: `thread-${slug}`,
      push_name: `Fulana do ${slug}`,
      contract: `CONTRATO-${slug}`,
      last_message_at: new Date()
    });
    await tinsertReturningId('wa_messages', {
      conversation_id: conversaId,
      direction: 'in',
      external_id: `msg-${slug}`,
      body: `Minha internet caiu — Fulana do ${slug}`
    });
    await tinsertReturningId('wa_opt_outs', {
      wa_phone_e164: `551199999000${slug === 'meu' ? 1 : 2}`,
      conversation_id: conversaId,
      origin: 'inbound',
      reason_text: 'PARAR'
    });

    const campanhaId = await tinsertReturningId('wa_broadcasts', {
      title: `Campanha ${slug}`, body: 'Olá {{nome}}', status: 'sent'
    });
    await tinsertReturningId('wa_broadcast_recipients', {
      broadcast_id: campanhaId,
      phone_e164: `551199999000${slug === 'meu' ? 1 : 2}`,
      contract: `CONTRATO-${slug}`,
      client_name: `Fulana do ${slug}`,
      rendered_body: `Olá Fulana do ${slug}`,
      status: 'sent'
    });

    await AuditLog.record({
      action: AuditLog.ACTIONS.PORTAL_PASSWORD_REVEALED,
      subjectType: 'customer_account',
      subjectId: account.id,
      actorUsername: 'a-dona'
    });

    // Uma ONT trocada: a telemetria da anterior só existe sob o id ANTIGO, e é
    // por ela que a exclusão tem que passar também. As horas são as de uma
    // troca de verdade — a conta nasce, a ONT antiga informa, e só depois ela é
    // trocada —, porque o alcance recorta cada aparelho pelo período em que ele
    // foi desta conta.
    const hora = 60 * 60 * 1000;
    await getDb()('customer_accounts').where({ id: account.id })
      .update({ created_at: new Date(Date.now() - 2 * hora) });
    await tinsertReturningId('device_swaps', {
      occurred_at: new Date(Date.now() - hora),
      account_id: account.id,
      customer_id: account.customer_id,
      pppoe_username: `assinante-${slug}`,
      previous_device_id: `ONT-ANTIGA-${slug}`,
      device_id: 'ONT-COMPARTILHADO',
      matched_by: 'pppoe',
      link_action: 'kept'
    });
    await tinsertReturningId('device_samples', {
      device_id: `ONT-ANTIGA-${slug}`, inform_at: new Date(Date.now() - 1.5 * hora), rx_power: -30.1
    });

    return { account: await CustomerAccount.getById(account.id), senha, instanciaId, conversaId };
  });

  const aqui = await plantar(meu, 'meu');
  const la = await plantar(vizinho, 'vizinho');
  conta = aqui.account;
  contaVizinha = la.account;
  senhaDoPortal = aqui.senha;
  instancia = aqui.instanciaId;

  // Um anexo de verdade no disco, com a linha apontando para ele: é a foto que
  // o assinante mandou, e são bytes dele, não um ponteiro.
  const relativo = path.posix.join('wa-media', `t${meu}`, String(aqui.conversaId), 'foto.jpg');
  anexo = path.join(DATA_DIR, relativo);
  await fs.mkdir(path.dirname(anexo), { recursive: true });
  await fs.writeFile(anexo, 'bytes da foto do assinante');
  await getDb()('wa_messages')
    .where({ conversation_id: aqui.conversaId })
    .update({ attachment_path: relativo, attachment_type: 'image/jpeg', attachment_name: 'foto.jpg' });
}

const apagar = (id = conta.id, confirmacao) => call(`${panelUrl}/api/customers/${id}`, {
  method: 'DELETE',
  headers: authHeaders(token),
  body: { confirmCustomerId: confirmacao ?? conta.customer_id }
});

beforeEach(semear);

describe('o que a exclusão destrói', () => {
  it('a senha do portal, que estava guardada duas vezes na mesma linha', async () => {
    const antes = await cru('customer_accounts', { id: conta.id });
    assert.ok(antes.password_hash, 'o fixture precisa ter hash para o teste ter o que procurar');
    assert.ok(antes.password_ciphertext, 'e a cópia cifrada, que é a que volta em claro');
    assert.ok(senhaDoPortal);

    assert.equal((await apagar()).status, 200);

    const depois = await cru('customer_accounts', { id: conta.id });
    assert.equal(depois.password_hash, null);
    assert.equal(depois.password_ciphertext, null);
    assert.equal(depois.password_iv, null);
    assert.equal(depois.password_tag, null);
  });

  it('a credencial de WiFi, o evento do ERP e a telemetria', async () => {
    assert.equal((await apagar()).status, 200);
    const vazia = async (tabela, where) => assert.equal(
      await cru(tabela, where), undefined, `${tabela} ainda tem linha`
    );
    await vazia('customer_wifi_credentials', { tenant_id: meu });
    await vazia('sgp_events', { tenant_id: meu });
    await vazia('device_samples', { tenant_id: meu, device_id: 'ONT-COMPARTILHADO' });
    // E a da ONT ANTERIOR, que só existe sob o id trocado: é de quem já trocou
    // de aparelho que há mais história guardada.
    await vazia('device_samples', { tenant_id: meu, device_id: 'ONT-ANTIGA-meu' });
    await vazia('wa_messages', { tenant_id: meu });
    await vazia('wa_conversations', { tenant_id: meu });
  });

  it('e os bytes do anexo no disco, não só a linha que apontava para ele', async () => {
    await fs.access(anexo);
    const res = await apagar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.attachments, 1);
    await assert.rejects(() => fs.access(anexo), 'a foto do assinante continua no disco');
  });
});

describe('o que a exclusão esvazia sem destruir', () => {
  it('o contrato fica, a pessoa sai dele', async () => {
    assert.equal((await apagar()).status, 200);
    const vinculo = await cru('sgp_links', { tenant_id: meu });
    assert.ok(vinculo, 'a linha de contrato é registro operacional do ISP e fica');
    assert.equal(vinculo.contract, 'CONTRATO-meu');
    assert.equal(vinculo.document, null);
    assert.equal(vinculo.client_name, null);
    assert.equal(vinculo.login, null);
    assert.equal(vinculo.phone_e164, null);
  });

  it('o nó do mapa fica, o login que o ligava à pessoa sai', async () => {
    assert.equal((await apagar()).status, 200);
    const no = await cru('mapping_nodes', { tenant_id: meu });
    assert.ok(no, 'a caixa e o drop são planta do ISP e continuam lá quando o assinante sai');
    assert.equal(no.pppoe, null);
    assert.equal(no.notes, null);
  });

  it('a conta fica, esvaziada, e o customer_id permanece como costura da trilha', async () => {
    assert.equal((await apagar()).status, 200);
    const depois = await cru('customer_accounts', { id: conta.id });
    assert.ok(depois, 'a linha fica: apagá-la deixaria de pé os SET NULL que carregam o CPF');
    assert.equal(depois.customer_id, conta.customer_id);
    assert.equal(depois.pppoe_username, '');
    assert.equal(depois.device_id, `erased:${conta.id}`);
    assert.equal(depois.identity_hash, `erased:${conta.id}`);
    // Desativar é o primeiro passo DA exclusão, e não um passo antes dela.
    assert.equal(Boolean(depois.active), false);
  });

  it('o destinatário da campanha perde o telefone e o texto renderizado', async () => {
    assert.equal((await apagar()).status, 200);
    const destinatario = await cru('wa_broadcast_recipients', { tenant_id: meu });
    assert.ok(destinatario, 'o relatório da campanha continua contando quantos foram');
    assert.equal(destinatario.status, 'sent');
    assert.equal(destinatario.phone_e164, '');
    assert.equal(destinatario.client_name, null);
    assert.equal(destinatario.rendered_body, '');
  });

  it('e nada do assinante sobra em texto nenhum das tabelas que ficaram', async () => {
    assert.equal((await apagar()).status, 200);
    const db = getDb();
    for (const tabela of ['customer_accounts', 'sgp_links', 'device_swaps',
      'wa_broadcast_recipients', 'mapping_nodes']) {
      const texto = JSON.stringify(await db(tabela).where({ tenant_id: meu }));
      assert.ok(texto !== '[]' || tabela === 'device_swaps', `${tabela} ficou sem linha`);
      assert.equal(texto.includes('Fulana do meu'), false, `${tabela} ainda diz o nome`);
      assert.equal(texto.includes('52998224725'), false, `${tabela} ainda diz o documento`);
      assert.equal(texto.includes('assinante-meu'), false, `${tabela} ainda diz o login`);
    }
  });
});

describe('o que a exclusão NÃO pode tocar', () => {
  it('a trilha, que é registro de que um funcionário agiu', async () => {
    assert.equal((await apagar()).status, 200);
    const revelacao = await cru('audit_log', {
      tenant_id: meu, action: AuditLog.ACTIONS.PORTAL_PASSWORD_REVEALED
    });
    assert.ok(revelacao, 'a linha de quem revelou a senha não some com o assunto dela');
    assert.equal(String(revelacao.subject_id), String(conta.id));
  });

  it('o "não me perturbe", porque apagá-lo desfaria o próprio pedido', async () => {
    assert.equal((await apagar()).status, 200);
    const optOut = await cru('wa_opt_outs', { tenant_id: meu });
    assert.ok(optOut, 'sem ele a próxima sincronização do ERP devolve a pessoa à campanha');
    assert.equal(optOut.wa_phone_e164, '5511999990001');
  });
});

describe('nada do vizinho', () => {
  it('o id do vizinho responde 404 e não apaga nada', async () => {
    const antes = await cru('customer_accounts', { id: contaVizinha.id });
    const res = await apagar(contaVizinha.id, contaVizinha.customer_id);
    assert.equal(res.status, 404);
    assert.notEqual(res.status, 403);
    assert.deepEqual(await cru('customer_accounts', { id: contaVizinha.id }), antes);
  });

  it('e apagar a minha não encosta na dele, mesmo com o device id idêntico', async () => {
    const antes = await getDb()('customer_accounts').where({ tenant_id: vizinho });
    const wifiAntes = await getDb()('customer_wifi_credentials').where({ tenant_id: vizinho });
    assert.equal((await apagar()).status, 200);
    assert.deepEqual(await getDb()('customer_accounts').where({ tenant_id: vizinho }), antes);
    assert.deepEqual(
      await getDb()('customer_wifi_credentials').where({ tenant_id: vizinho }), wifiAntes
    );
  });
});

describe('os dois passos, e a trilha como condição', () => {
  /**
   * O desenho original exigia a conta aposentada antes — e este teste é o que o
   * derrubou. Aposentar não é ato de operador nenhum (só a sincronização
   * aposenta, ao ver uma ONT trocar de dono) e, pior, `retire()` sobrescreve o
   * `device_id`, que é justamente por onde se alcança a telemetria. A
   * precondição faria a exclusão alcançar menos e seria impossível de cumprir.
   */
  it('funciona na conta viva, que é o caso real, e avisa que ela estava viva', async () => {
    assert.equal(Boolean((await cru('customer_accounts', { id: conta.id })).active), true);
    const res = await apagar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.wasActive, true,
      'a tela precisa avisar que a ONT na planta recria a conta na próxima sincronização');
    assert.equal(await cru('customer_wifi_credentials', { tenant_id: meu }), undefined);
  });

  it('confirmação que não confere exatamente responde 409 e não apaga', async () => {
    const res = await apagar(conta.id, conta.customer_id.toLowerCase());
    assert.equal(res.status, 409, 'um id "quase certo" é exatamente o que um engano parece');
    assert.ok(await cru('customer_wifi_credentials', { tenant_id: meu }));
  });

  it('se a trilha não puder ser gravada, nada é apagado', async () => {
    const original = AuditLog.fromRequest;
    AuditLog.fromRequest = async () => null;
    try {
      const res = await apagar();
      assert.equal(res.status, 500);
    } finally {
      AuditLog.fromRequest = original;
    }
    assert.ok(await cru('customer_wifi_credentials', { tenant_id: meu }),
      'apagar sem deixar rastro é a única forma de apagar que é indefensável');
    assert.ok((await cru('customer_accounts', { id: conta.id })).password_ciphertext);
  });

  it('e o que foi apagado fica na trilha, com contagens e sem conteúdo', async () => {
    assert.equal((await apagar()).status, 200);
    const linha = await cru('audit_log', {
      tenant_id: meu, action: AuditLog.ACTIONS.CUSTOMER_DATA_ERASED
    });
    assert.ok(linha, 'a única prova de que o pedido do titular foi atendido');
    assert.equal(String(linha.subject_id), String(conta.id));
    const detalhe = JSON.parse(linha.detail);
    assert.equal(detalhe.rowCounts.customer_wifi_credentials, 1);
    assert.equal(detalhe.rowCounts.wa_messages, 1);
    assert.equal(JSON.stringify(linha).includes('52998224725'), false);
    assert.equal(JSON.stringify(linha).includes('Fulana'), false);
  });
});

describe('o serviço, por dentro', () => {
  it('o levantamento conta o que a exclusão vai alcançar, antes de tocar em nada', async () => {
    const { rowCounts } = await runInTenant(meu, () => CustomerErasureService.survey(conta));
    assert.equal(rowCounts.customer_wifi_credentials, 1);
    assert.equal(rowCounts.sgp_links, 1);
    assert.equal(rowCounts.sgp_events, 1);
    assert.equal(rowCounts.device_samples, 2, 'a da ONT atual e a da anterior');
    assert.equal(rowCounts.wa_conversations, 1);
    assert.equal(rowCounts.mapping_nodes, 1);
    // E a linha continua inteira: levantar não é apagar.
    assert.ok(await cru('customer_wifi_credentials', { tenant_id: meu }));
  });
});
