import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpContactSyncService } = await import('../src/services/sgpContactSyncService.js');

/**
 * A ficha completa do cliente do SGP: o que a listagem manda e o painel antes
 * descartava, e o que o operador corrige no painel sem que a sincronização
 * desfaça.
 *
 * O SGP falso responde no formato que um SGP de verdade mostrou no botão
 * Testar: cliente com `contratos` aninhados pelo `id`, `endereco` em objeto e
 * `contatos` com listas de celulares, telefones e e-mails.
 */

const APP = 'painel';
const TOKEN = 'token-da-ficha';

const clientes = [
  {
    id: 7,
    nome: '7 - Elane Patriqui',
    tipo: 'F',
    cpfcnpj: '123.456.789-09',
    sexo: 'F',
    dataNascimento: '1990-04-12',
    dataCadastro: '2019-03-01',
    endereco: {
      logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro',
      cidade: 'Santarém', uf: 'PA', cep: '68005-000', complemento: 'Casa 2'
    },
    contatos: {
      celulares: ['(93) 99126-1076'],
      telefones: ['(93) 3522-1234'],
      emails: ['Elane@Exemplo.test']
    },
    contratos: [
      {
        id: 373, pop_id: 1, dataCadastro: '2019-03-02', status: 'Ativo',
        motivo_status: null, vencimento: '10', contratoCentralLogin: '12345678909'
      },
      {
        id: 374, pop_id: 1, dataCadastro: '2021-06-01', status: 'Suspenso',
        motivo_status: 'Inadimplência', vencimento: '20'
      }
    ],
    titulos: []
  },
  {
    id: 8,
    nome: 'Sem Contrato Nenhum',
    tipo: 'J',
    cpfcnpj: '11.222.333/0001-81',
    contatos: { celulares: ['93991230008'], emails: [] },
    contratos: []
  }
];

let panelUrl;
let token;
let sgpServer;

const auth = () => ({ headers: authHeaders(token) });
const ficha = (key) => call(`${panelUrl}/api/contacts/${encodeURIComponent(key)}`, auth());
const editar = (key, body) => call(`${panelUrl}/api/contacts/${encodeURIComponent(key)}`, {
  method: 'PATCH', headers: authHeaders(token), body
});
const sincronizar = () => asTenant(() => SgpContactSyncService.syncAll());
const contatos = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, auth());

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (payload.app !== APP || payload.token !== TOKEN) return res.end(JSON.stringify({ status: 0, msg: 'Token inválido' }));
      const offset = Number(payload.offset) || 0;
      const limit = Number(payload.limit) || 10;
      return res.end(JSON.stringify({ status: 1, clientes: clientes.slice(offset, offset + limit) }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual', contactsPageSize: 10
  }));
  await sincronizar();
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('a sincronização guarda o cadastro inteiro', () => {
  it('a ficha do cliente: dados pessoais, endereço, telefones e e-mails', async () => {
    const [cliente] = await asTenant(() => getDb()('sgp_clients').where({ sgp_client_id: '7' }));
    assert.ok(cliente, 'a ficha do cliente 7 existe');
    assert.equal(cliente.person_type, 'PF');
    assert.equal(cliente.document, '12345678909');
    assert.equal(cliente.gender, 'F');
    assert.equal(cliente.birth_date, '1990-04-12');
    assert.equal(cliente.registered_at, '2019-03-01');
    const endereco = JSON.parse(cliente.address);
    assert.equal(endereco.street, 'Rua das Flores');
    assert.equal(endereco.city, 'Santarém');
    assert.deepEqual(JSON.parse(cliente.phones).sort(), ['559335221234', '5593991261076'].sort());
    assert.deepEqual(JSON.parse(cliente.emails), ['elane@exemplo.test']);
  });

  it('e cada contrato ligado a ela, com vencimento e motivo', async () => {
    const linhas = await asTenant(() => getDb()('sgp_contacts').where({ client_ref: '7' }).orderBy('contract'));
    assert.deepEqual(linhas.map((linha) => linha.contract), ['373', '374']);
    assert.equal(linhas[0].due_day, '10');
    assert.equal(linhas[1].status_reason, 'Inadimplência');
    assert.equal(linhas[1].state, 'blocked');
  });
});

describe('a ficha pela rota', () => {
  it('mostra os campos, de onde vieram, e todos os contratos do cliente', async () => {
    const res = await ficha('373');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const perfil = res.body.data;
    assert.equal(perfil.clientId, '7');
    assert.equal(perfil.fields.name.value, '7 - Elane Patriqui');
    assert.equal(perfil.fields.name.edited, false);
    assert.equal(perfil.fields.document.value, '12345678909', 'a ficha mostra o documento inteiro');
    assert.equal(perfil.fields.address.value.zip, '68005-000');
    assert.deepEqual(perfil.contracts.map((contrato) => contrato.contract), ['373', '374']);
    assert.equal(perfil.contracts[1].dueDay, '20');
  });

  it('um cliente sem contrato abre pela chave da lista', async () => {
    const lista = await contatos('?search=Sem%20Contrato');
    const linha = lista.body.data.contacts.find((contato) => contato.clientName === 'Sem Contrato Nenhum');
    assert.ok(linha, JSON.stringify(lista.body));
    const res = await ficha(linha.key);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.fields.personType.value, 'PJ');
    assert.deepEqual(res.body.data.contracts, []);
  });

  it('uma chave que não existe dá 404', async () => {
    const res = await ficha('CONTRATO-QUE-NAO-EXISTE');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
  });
});

describe('editar no painel', () => {
  it('guarda o que o operador escreveu e marca como editado', async () => {
    const res = await editar('373', {
      name: 'Elane Patriqui da Silva',
      address: { street: 'Av. Nova', number: '5', city: 'Santarém', state: 'PA' },
      emails: ['elane.nova@exemplo.test'],
      notes: 'Prefere contato à tarde'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const perfil = res.body.data;
    assert.equal(perfil.fields.name.value, 'Elane Patriqui da Silva');
    assert.equal(perfil.fields.name.edited, true);
    assert.equal(perfil.fields.name.sgpValue, '7 - Elane Patriqui');
    assert.equal(perfil.fields.name.editedBy, 'operator');
    assert.equal(perfil.fields.address.value.street, 'Av. Nova');
    assert.equal(perfil.notes, 'Prefere contato à tarde');
  });

  it('a lista de contatos mostra o nome editado', async () => {
    const lista = await contatos('?limit=50');
    const linha = lista.body.data.contacts.find((contato) => contato.contract === '373');
    assert.equal(linha.clientName, 'Elane Patriqui da Silva');
  });

  it('a sincronização seguinte não desfaz a edição', async () => {
    await sincronizar();
    const perfil = (await ficha('374')).body.data;
    assert.equal(perfil.fields.name.value, 'Elane Patriqui da Silva', 'o outro contrato do mesmo cliente também vê');
    assert.equal(perfil.fields.address.value.street, 'Av. Nova');
    assert.equal(perfil.notes, 'Prefere contato à tarde');
  });

  it('restaurar do SGP devolve o valor de lá', async () => {
    const res = await editar('373', { name: null });
    assert.equal(res.body.data.fields.name.value, '7 - Elane Patriqui');
    assert.equal(res.body.data.fields.name.edited, false);
    assert.equal(res.body.data.fields.address.edited, true, 'só o campo pedido volta');
  });

  it('o telefone do WhatsApp é a correção do contrato', async () => {
    const res = await editar('373', { whatsappPhone: '(93) 98111-0000' });
    assert.equal(res.body.data.whatsappPhone, '5593981110000');
    assert.equal(res.body.data.whatsappPhoneSource, 'manual');
  });

  it('recusa um valor que não serve', async () => {
    const res = await editar('373', { emails: ['isto não é e-mail'] });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_field');
  });

  it('a trilha diz quais campos, nunca os valores', async () => {
    const linhas = await asTenant(() => getDb()('audit_log').where({ action: 'contact.updated' }).orderBy('id'));
    assert.ok(linhas.length >= 1);
    const detalhe = String(linhas[0].detail);
    assert.match(detalhe, /name/);
    assert.ok(!detalhe.includes('Av. Nova'), 'o valor não vai para a trilha');
  });
});

describe('criar um cliente no painel', () => {
  it('nasce com a ficha e aparece na lista de contatos', async () => {
    const res = await call(`${panelUrl}/api/contacts`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { name: 'Cliente de Balcão', document: '529.982.247-25', whatsappPhone: '93991234567' }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.source, 'panel');
    assert.equal(res.body.data.fields.name.value, 'Cliente de Balcão');

    const lista = await contatos('?search=Balc');
    const linha = lista.body.data.contacts.find((contato) => contato.key === res.body.data.key);
    assert.ok(linha, JSON.stringify(lista.body));
    assert.equal(linha.phone, '5593991234567');
  });

  it('sem nome não nasce', async () => {
    const res = await call(`${panelUrl}/api/contacts`, { method: 'POST', headers: authHeaders(token), body: {} });
    assert.equal(res.status, 400);
  });
});

describe('a planilha', () => {
  const exportar = (query = '') => fetch(`${panelUrl}/api/contacts/export${query}`, { headers: authHeaders(token) });
  const importar = (csv, mode) => fetch(`${panelUrl}/api/contacts/import?mode=${mode}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'text/csv' },
    body: csv
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('exporta um CSV que o Excel abre: BOM, ponto e vírgula, o que a ficha mostra', async () => {
    const res = await exportar();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="contatos-/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'começa com o BOM do UTF-8');
    const csv = bytes.toString('utf8').replace(/^\uFEFF/, '');
    assert.ok(csv.startsWith('Chave;Contrato;Nome;'), csv.slice(0, 80));
    const linha373 = csv.split('\r\n').find((line) => line.startsWith('373;'));
    assert.ok(linha373, csv);
    assert.match(linha373, /Av\. Nova/, 'o endereço editado no painel é o que sai');
    assert.match(linha373, /Prefere contato à tarde/);
  });

  it('exportar e importar o mesmo arquivo não muda nada', async () => {
    const csv = await (await exportar()).text();
    const res = await importar(csv, 'preview');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.updates, 0, JSON.stringify(res.body.data.rows));
    assert.equal(res.body.data.creates, 0);
    assert.deepEqual(res.body.data.errors, []);
  });

  it('com "Sem telefone", exporta só quem a lista mostra nesse filtro', async () => {
    const contratosDo = (csv) => csv.replace(/^\uFEFF/, '').split('\r\n').slice(1)
      .filter(Boolean).map((line) => line.split(';')[1]).filter(Boolean).sort();
    await getDb()('sgp_links').insert({
      tenant_id: 1, device_id: 'ONT-PLANILHA-SEM-FONE', contract: '9990', client_name: 'Sem Fone Planilha', state: 'active', link_mode: 'auto'
    });
    const lista = await call(`${panelUrl}/api/whatsapp/contacts?noPhone=true&limit=200`, { headers: authHeaders(token) });
    assert.equal(lista.status, 200);
    const esperados = lista.body.data.contacts.map((c) => c.contract).filter(Boolean).sort();
    assert.ok(esperados.length > 0, 'a base do teste tem quem esteja sem telefone');
    const filtrado = contratosDo(await (await exportar('?noPhone=true')).text());
    assert.deepEqual(filtrado, esperados);
    assert.ok(contratosDo(await (await exportar()).text()).length > filtrado.length, 'sem o filtro, vêm também os com telefone');
  });

  it('a prévia diz o que muda sem gravar; aplicar grava como edição do painel', async () => {
    const csv = [
      'Contrato;Nome;E-mails;Cidade',
      '374;Elane da Planilha;;',
      '373;;;',
      ';Cliente Novo da Planilha;novo@exemplo.test;Belém',
      'NAO-EXISTE;Alguém;;',
      '373;;isto não é e-mail;'
    ].join('\n');
    const previa = await importar(csv, 'preview');
    assert.equal(previa.status, 200, JSON.stringify(previa.body));
    assert.equal(previa.body.data.updates, 1);
    assert.equal(previa.body.data.creates, 1);
    assert.equal(previa.body.data.errors.length, 2);
    assert.deepEqual(previa.body.data.errors.map((error) => error.line), [5, 6]);
    assert.deepEqual(previa.body.data.rows.find((row) => row.line === 2).fields, ['name']);
    assert.equal((await ficha('374')).body.data.fields.name.value, '7 - Elane Patriqui', 'a prévia não grava');

    const aplicado = await importar(csv, 'apply');
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.body));
    assert.equal(aplicado.body.data.updated, 1);
    assert.equal(aplicado.body.data.created, 1);
    const perfil = (await ficha('374')).body.data;
    assert.equal(perfil.fields.name.value, 'Elane da Planilha');
    assert.equal(perfil.fields.name.edited, true);

    const lista = await contatos('?search=Planilha');
    assert.ok(lista.body.data.contacts.some((contato) => contato.clientName === 'Cliente Novo da Planilha'));

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contacts.imported' }).first());
    assert.ok(trilha, 'a importação fica na trilha');
    assert.ok(!String(trilha.detail).includes('Elane'), 'com quantidades, nunca linhas');
  });

  it('uma célula que viraria fórmula sai neutralizada', async () => {
    await editar('373', { notes: '=HYPERLINK("http://x")' });
    const csv = await (await exportar('?search=373')).text();
    assert.match(csv, /'=HYPERLINK/);
  });

  it('recusa uma planilha sem as colunas do exportar', async () => {
    const res = await importar('Fruta;Cor\nbanana;amarela', 'preview');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'badHeader');
  });
});
