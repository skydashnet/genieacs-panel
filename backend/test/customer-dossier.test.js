import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: CustomerDataExportService } = await import(
  '../src/services/customerDataExportService.js'
);
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { tinsertReturningId } = await import('../src/config/database.js');

/**
 * O dossiê de um assinante — o direito de acesso da LGPD, do lado de quem tem
 * que atendê-lo.
 *
 * O ISP é o controlador desses dados e nós somos operadores. O pedido do
 * titular chega ao ISP, e até aqui o ISP não tinha botão nenhum: a exportação
 * que existia é a do provedor inteiro, que não se entrega a um assinante.
 *
 * As três maneiras de errar isto, que é o que este arquivo guarda: trazer de
 * menos (o histórico da ONT trocada some), trazer do vizinho (o dossiê de um
 * assinante de OUTRO ISP), e trazer segredo (a senha do portal, a credencial
 * de WiFi cifrada).
 */
let panelUrl;
let token;
let meu;
let vizinho;
let conta;
let senhaDoPortal;

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

  conta = await runInTenant(meu, () => CustomerService.ensureAccount({
    _id: 'ONT-ATUAL', softwareId: 'V1', pppoe: 'assinante-do-dossie'
  }));
  senhaDoPortal = await runInTenant(meu, () => CustomerPortalPasswordService.reveal(conta));

  await runInTenant(meu, async () => {
    // Uma ONT trocada: a telemetria antiga fica sob o id ANTIGO. Na ordem de
    // uma troca de verdade — a conta nasce, a ONT antiga informa, e só depois
    // ela é trocada.
    const hora = 60 * 60 * 1000;
    await getDb()('customer_accounts').where({ id: conta.id })
      .update({ created_at: new Date(Date.now() - 2 * hora) });
    await tinsertReturningId('device_swaps', {
      occurred_at: new Date(Date.now() - hora),
      account_id: conta.id,
      previous_device_id: 'ONT-ANTIGA',
      device_id: 'ONT-ATUAL',
      matched_by: 'pppoe',
      link_action: 'kept'
    });
    await tinsertReturningId('device_samples', {
      device_id: 'ONT-ANTIGA', inform_at: new Date(Date.now() - 1.5 * hora), rx_power: -27.5
    });
    await tinsertReturningId('device_samples', {
      device_id: 'ONT-ATUAL', inform_at: new Date(), rx_power: -22.1
    });
    await tinsertReturningId('sgp_links', {
      account_id: conta.id,
      device_id: 'ONT-ATUAL',
      contract: 'CONTRATO-1',
      document: '52998224725',
      client_name: 'Fulana de Tal',
      phone_e164: '5511999990000'
    });
    await tinsertReturningId('customer_wifi_credentials', {
      account_id: conta.id,
      wifi_index: 0,
      ssid: 'CasaDaFulana',
      password_ciphertext: 'cifra-que-nao-sai',
      password_iv: 'iv',
      password_tag: 'tag'
    });
  });

  // O vizinho, com o MESMO device id — a colisão que acontece de verdade.
  await runInTenant(vizinho, () => CustomerService.ensureAccount({
    _id: 'ONT-ATUAL', softwareId: 'V1', pppoe: 'assinante-do-vizinho'
  }));
  await runInTenant(vizinho, () => tinsertReturningId('device_samples', {
    device_id: 'ONT-ATUAL', inform_at: new Date(), rx_power: -99.9
  }));
});

after(async () => {
  await stopTestServers();
});

const dossie = () => runInTenant(meu, () => CustomerDataExportService.build(conta.id));

describe('o dossiê reúne o que está espalhado', () => {
  it('traz a conta, o contrato e a credencial de WiFi', async () => {
    const arquivo = await dossie();
    assert.equal(arquivo.data.customer_accounts.length, 1);
    assert.equal(arquivo.data.sgp_links.length, 1);
    assert.equal(arquivo.data.sgp_links[0].contract, 'CONTRATO-1');
    assert.equal(arquivo.data.customer_wifi_credentials.length, 1);
  });

  /**
   * O caso que um mapa ingênuo perde: quem trocou de ONT tem a telemetria
   * antiga sob o id ANTIGO, e é justamente quem tem mais história.
   */
  it('e a telemetria da ONT ANTERIOR, que só existe sob o id trocado', async () => {
    const arquivo = await dossie();
    const ids = arquivo.data.device_samples.map((linha) => linha.device_id).sort();
    assert.deepEqual(ids, ['ONT-ANTIGA', 'ONT-ATUAL']);
  });

  it('e diz no manifesto o que NÃO está no arquivo', async () => {
    const arquivo = await dossie();
    const oQueFalta = arquivo.manifest.notCollected.map((n) => n.what);
    assert.ok(oQueFalta.includes('genieacs'));
    assert.ok(oQueFalta.includes('attachment-bytes'));
    for (const item of arquivo.manifest.notCollected) {
      assert.ok(item.why, `${item.what} precisa dizer por quê`);
    }
  });

  it('e nomeia as tabelas que não guardam nada de assinante', async () => {
    const arquivo = await dossie();
    assert.ok(arquivo.manifest.omittedTables.settings);
    assert.ok(arquivo.manifest.omittedTables.billing_events);
  });

  /**
   * E nomeia TODAS elas.
   *
   * Afirmar duas chaves deixava o manifesto mentir por omissão no dia em que
   * uma tabela escopada nova entrasse: ela não estaria nos dados (não é do
   * assinante) nem na lista do que ficou de fora, e quem lesse o arquivo não
   * teria como saber que ela existe. A conta é sobre o conjunto: toda tabela
   * escopada está ou nos dados, ou declarada com o motivo escrito.
   */
  it('e nenhuma tabela escopada fica fora das duas listas', async () => {
    const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');
    const arquivo = await dossie();
    const nosDados = new Set(Object.keys(arquivo.data));
    const declaradas = new Set(Object.keys(arquivo.manifest.omittedTables));
    const orfas = [...SCOPED_TABLES].filter((t) => !nosDados.has(t) && !declaradas.has(t));
    assert.deepEqual(orfas, [],
      `tabelas escopadas que o manifesto não menciona: ${orfas.join(', ')}`);
  });
});

describe('nada do vizinho', () => {
  it('mesmo com o device id idêntico nos dois provedores', async () => {
    const arquivo = await dossie();
    const potencias = arquivo.data.device_samples.map((l) => Number(l.rx_power));
    assert.equal(potencias.includes(-99.9), false, 'a amostra do vizinho não podia estar aqui');
    assert.equal(JSON.stringify(arquivo).includes('assinante-do-vizinho'), false);
  });
});

describe('nenhum segredo', () => {
  it('a senha do portal não sai, nem em claro nem como hash', async () => {
    const arquivo = await dossie();
    const texto = JSON.stringify(arquivo);
    assert.ok(senhaDoPortal, 'o fixture precisa de uma senha para o teste ter o que procurar');
    assert.equal(texto.includes(senhaDoPortal), false);
    assert.equal(texto.includes('password_hash'), false);
  });

  it('nem a credencial de WiFi cifrada', async () => {
    const arquivo = await dossie();
    const texto = JSON.stringify(arquivo);
    assert.equal(texto.includes('cifra-que-nao-sai'), false);
    // Mas o SSID sai: é dado do titular, e é o que ele veio buscar.
    assert.ok(texto.includes('CasaDaFulana'));
  });
});

describe('a rota', () => {
  it('devolve o arquivo como anexo, com o id do assinante no nome', async () => {
    // `fetch` cru e não o `call` do harness: o helper devolve o corpo já
    // parseado e guarda a resposta em `.response` — aqui o que se confere é o
    // cabeçalho, e é ele que diz ao navegador que isto é um download.
    const res = await fetch(`${panelUrl}/api/customers/${conta.id}/export`, {
      headers: authHeaders(token)
    });
    assert.equal(res.status, 200);
    const disposicao = res.headers.get('content-disposition');
    assert.match(disposicao, /^attachment; filename="assinante-.+\.json"$/, disposicao);
    // O nome carrega o identificador do titular: quem atende dez pedidos num dia
    // precisa saber qual arquivo é de quem sem abrir os dez.
    assert.ok(disposicao.includes(String(conta.customer_id)), disposicao);
    const corpo = JSON.parse(await res.text());
    assert.equal(corpo.manifest.formatVersion, 1);
  });

  it('deixa registro na trilha, com contagens e sem conteúdo', async () => {
    await call(`${panelUrl}/api/customers/${conta.id}/export`, { headers: authHeaders(token) });
    const linha = await getDb()('audit_log')
      .where({ tenant_id: meu, action: AuditLog.ACTIONS.CUSTOMER_DATA_EXPORTED })
      .orderBy('id', 'desc')
      .first();
    assert.ok(linha, 'entregar o dossiê de uma pessoa tem que deixar registro');
    assert.equal(linha.subject_type, 'customer_account');
    assert.equal(String(linha.subject_id), String(conta.id));
    const detalhe = JSON.parse(linha.detail);
    assert.ok(detalhe.rowCounts.customer_accounts >= 1);
    // O ponto: o documento e o nome do titular não podem estar na trilha.
    assert.equal(JSON.stringify(linha).includes('52998224725'), false);
    assert.equal(JSON.stringify(linha).includes('Fulana de Tal'), false);
  });

  it('e um id que não existe responde 404, não 500', async () => {
    const res = await call(`${panelUrl}/api/customers/99999/export`, { headers: authHeaders(token) });
    assert.equal(res.status, 404);
  });
});
