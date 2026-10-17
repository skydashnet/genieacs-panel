import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: TenantExportService, exportaColuna } = await import(
  '../src/services/tenantExportService.js'
);
const { SCHEMA_TABLES } = await import('../src/config/migrations.js');
const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerPortalPasswordService } = await import(
  '../src/services/customerPortalPasswordService.js'
);
const { default: GenieAcsAuthService } = await import('../src/services/genieacsAuthService.js');
const { tinsertReturningId } = await import('../src/config/database.js');

/**
 * Levar o cadastro embora.
 *
 * Item 12 do checklist, e o que ele existe para garantir é simples de dizer e
 * fácil de errar em três direções: o arquivo tem que ter **tudo** o que é do
 * provedor, **nada** do vizinho, e **nenhum segredo**.
 *
 * A terceira é a que mais se erra, porque errar não quebra nada: um export que
 * carrega o material cifrado de toda a operação parece perfeito, e o defeito só
 * aparece quando o arquivo já circulou por e-mail.
 */
let panelUrl;
let token;
let meu;
let vizinho;
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

  const conta = await runInTenant(meu, () => CustomerService.ensureAccount({
    _id: 'ONT-QUE-SAI', softwareId: 'V1', pppoe: 'assinante-que-sai'
  }));
  senhaDoPortal = await runInTenant(meu, () => CustomerPortalPasswordService.reveal(conta));
  assert.ok(senhaDoPortal, 'o fixture precisa de uma senha para o teste ter o que procurar');

  await runInTenant(meu, () => GenieAcsAuthService.saveConfig({
    authType: 'bearer', secret: 'credencial-que-nao-sai'
  }));

  // O vizinho, com o MESMO device id — a colisão que acontece de verdade e que
  // é o jeito de o export vazar sem parecer que vazou.
  await runInTenant(vizinho, () => CustomerService.ensureAccount({
    _id: 'ONT-QUE-SAI', softwareId: 'V1', pppoe: 'assinante-do-vizinho'
  }));
  await runInTenant(vizinho, () => tinsertReturningId('vendors', {
    name: 'Fabricante do Vizinho',
    manufacturer_patterns: '[]',
    product_patterns: '[]',
    parameter_prefix: 'InternetGatewayDevice'
  }));
});

after(async () => {
  await stopTestServers();
});

describe('o que entra no arquivo', () => {
  it('é toda tabela escopada, e a lista sai do schema', () => {
    // Escrita à mão, uma tabela escopada nova ficaria de fora e o export
    // passaria a mentir por omissão — que é o pior jeito de um export falhar,
    // porque parece ter funcionado.
    const esperadas = SCHEMA_TABLES.filter((t) => SCOPED_TABLES.has(t));
    assert.deepEqual(TenantExportService.tabelas(), esperadas);
    assert.ok(esperadas.length >= 20, `só ${esperadas.length} tabelas escopadas`);
  });

  it('na ordem de criação do schema, que é a que as FKs pedem', () => {
    // Não é arrumação: é o que faz o arquivo poder ser reinserido de cima para
    // baixo sem quebrar referência. `customer_accounts` antes de
    // `customer_wifi_credentials`, que aponta para ela.
    const ordem = TenantExportService.tabelas();
    assert.ok(ordem.indexOf('customer_accounts') < ordem.indexOf('customer_wifi_credentials'));
    assert.ok(ordem.indexOf('wa_conversations') < ordem.indexOf('wa_messages'));
  });

  it('inclui as linhas deste provedor', async () => {
    const arquivo = await runInTenant(meu, () => TenantExportService.build());
    const contas = arquivo.data.customer_accounts;
    assert.equal(contas.length, 1);
    assert.equal(contas[0].device_id, 'ONT-QUE-SAI');
    assert.equal(contas[0].pppoe_username, 'assinante-que-sai');
  });

  it('e o manifesto diz o que tem dentro', async () => {
    const { manifest } = await runInTenant(meu, () => TenantExportService.build());
    assert.equal(manifest.formatVersion, 1);
    assert.ok(manifest.tenant.slug, 'o manifesto tem que nomear o provedor');
    assert.equal(manifest.rowCounts.customer_accounts, 1);
    assert.deepEqual(manifest.tables, TenantExportService.tabelas());
    // Dito no próprio arquivo: quem o abrir daqui a dois anos precisa saber o
    // que NÃO está ali antes de concluir que a senha de alguém se perdeu.
    assert.ok(manifest.omittedColumns.why.length > 20);
  });
});

describe('o que NÃO entra', () => {
  it('nada do vizinho, nem quando o device id é o mesmo', async () => {
    const arquivo = await runInTenant(meu, () => TenantExportService.build());
    const tudo = JSON.stringify(arquivo);
    assert.equal(tudo.includes('assinante-do-vizinho'), false);
    assert.equal(tudo.includes('Fabricante do Vizinho'), false);
    // E o controle: o vizinho tem mesmo o que se procurou acima, então a busca
    // não deu negativo por não haver o que achar.
    const dele = JSON.stringify(await runInTenant(vizinho, () => TenantExportService.build()));
    assert.equal(dele.includes('assinante-do-vizinho'), true);
    assert.equal(dele.includes('Fabricante do Vizinho'), true);
  });

  it('nenhum segredo, nem cifrado', async () => {
    // Só a seção `data`, e não o arquivo inteiro: o manifesto NOMEIA as colunas
    // omitidas, de propósito, então procurar `password_hash` no arquivo todo
    // acha o manifesto e acusa um vazamento que não existe. Foi o que
    // aconteceu na primeira escrita deste caso.
    const arquivo = await runInTenant(meu, () => TenantExportService.build());
    const tudo = JSON.stringify(arquivo.data);
    // O ciphertext é inútil para quem recebe — a chave fica aqui e é derivada
    // do JWT_SECRET deste deployment — e perigoso para quem guarda.
    for (const coluna of ['password_ciphertext', 'password_iv', 'password_tag',
      'wifi_password_ciphertext', 'token_ciphertext', 'password_hash']) {
      assert.equal(tudo.includes(`"${coluna}"`), false, `${coluna} saiu no arquivo`);
    }
    assert.equal(tudo.includes(senhaDoPortal), false, 'a senha do portal saiu em claro');
    assert.equal(tudo.includes('credencial-que-nao-sai'), false, 'a credencial da NBI saiu');
  });

  it('mas mantém o metadado que diz que havia um segredo', async () => {
    // `..._key_version` é metadado, não segredo, e sem ele quem recebe o
    // arquivo não sabe nem que existia uma senha a redefinir.
    const arquivo = await runInTenant(meu, () => TenantExportService.build());
    const conta = arquivo.data.customer_accounts[0];
    assert.ok('password_key_version' in conta, Object.keys(conta).join(', '));
  });

  it('e a regra é por sufixo, para o próximo segredo já nascer de fora', () => {
    assert.equal(exportaColuna('qualquer_coisa_nova_ciphertext'), false);
    assert.equal(exportaColuna('qualquer_coisa_nova_iv'), false);
    assert.equal(exportaColuna('qualquer_coisa_nova_tag'), false);
    // O digest da chave do agente do GenieACS, e o próximo digest de chave.
    assert.equal(exportaColuna('agent_token_hash'), false);
    assert.equal(exportaColuna('qualquer_coisa_nova_token_hash'), false);
    // Metadado da chave continua saindo: a tela e quem recebe sabem que existia.
    assert.equal(exportaColuna('agent_token_hint'), true);
    assert.equal(exportaColuna('password_key_version'), true);
    assert.equal(exportaColuna('device_id'), true);
  });
});

describe('a rota', () => {
  it('devolve o arquivo como anexo, com o nome do provedor', async () => {
    const resposta = await fetch(`${panelUrl}/api/tenant/export`, { headers: authHeaders(token) });
    assert.equal(resposta.status, 200);
    const disposicao = resposta.headers.get('content-disposition');
    assert.match(disposicao, /^attachment; filename="skygenpanel-.+\.json"$/, disposicao);
    const corpo = JSON.parse(await resposta.text());
    assert.equal(corpo.manifest.formatVersion, 1);
    assert.ok(corpo.data.customer_accounts.length >= 1);
  });

  it('deixa registro na trilha, porque devolve o cadastro inteiro de uma vez', async () => {
    // Sem isso, um operador de saída baixaria a base e nada no painel diria que
    // aconteceu.
    const linhas = await getDb()('audit_log').where({ action: 'tenant.exported' });
    assert.ok(linhas.length >= 1);
    assert.equal(linhas[0].actor_username, 'a-dona');
    assert.ok(JSON.parse(linhas[0].detail).rowCounts.customer_accounts >= 1);
  });

  it('e a trilha não guarda o arquivo, só o que ele tinha', async () => {
    const linhas = await getDb()('audit_log').where({ action: 'tenant.exported' });
    assert.equal(JSON.stringify(linhas).includes(senhaDoPortal), false);
    assert.equal(JSON.stringify(linhas).includes('assinante-que-sai'), false,
      'a trilha registra o tamanho do export, não o conteúdo dele');
  });
});
