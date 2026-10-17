import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: TeiahService, normalizeConsult } = await import('../src/services/teiahService.js');

/**
 * "Novo cliente": o CPF/CNPJ primeiro, depois o cadastro, e — quando o
 * operador pede — o mesmo cliente criado no SGP pela API de CRM
 * (`POST /api/crm/cliente/F|J`).
 *
 * O SGP falso responde a consulta e a listagem por documento (o que já está
 * lá) e a criação, guardando o corpo recebido para os testes lerem. A Receita
 * e o CEP saem por `fetch`, trocado aqui para nenhum teste ir à internet.
 */

const APP = 'painel';
const TOKEN = 'token-do-crm';

const CPF_NOVO = '81373563044';
const CPF_EXISTENTE = '52998224725';
const CNPJ_NOVO = '67897733000141';

let panelUrl;
let token;
let sgpServer;
let proximoId = 57;
const criados = [];
/** Como o SGP responde a próxima criação: `ok`, `sem-id` ou `recusa`. */
let modoCriacao = 'ok';

const realFetch = globalThis.fetch;
const auth = () => ({ headers: authHeaders(token) });

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      const doc = String(payload.cpfcnpj ?? '').replace(/\D/g, '');
      if (req.url.startsWith('/api/crm/cliente/')) {
        criados.push({ path: req.url, body: payload });
        if (modoCriacao === 'sem-id') return send({ message: 'Campo obrigatório: bairro' });
        if (modoCriacao === 'recusa') return send({ message: 'CPF já cadastrado' }, 400);
        proximoId += 1;
        return send({ cliente_id: proximoId, message: `Cliente ${payload.nome} cadastrado via API.` });
      }
      if (req.url.startsWith('/api/ura/consultacliente')) {
        if (doc === CPF_EXISTENTE) {
          return send({ status: 1, contratos: [{ contrato: 'K-EXISTE', contratoStatus: 'Ativo', razaoSocial: 'Já Existe da Silva', cpfCnpj: CPF_EXISTENTE }] });
        }
        return send({ status: 0, msg: 'Cliente não encontrado' });
      }
      if (req.url.startsWith('/api/ura/clientes/')) return send({ status: 1, clientes: [] });
      return send({ status: 0, msg: 'Endpoint inexistente' });
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

/**
 * A Receita e o CEP falsos. Qualquer outro serviço de fora responde 503, para
 * nada sair de verdade; as chamadas ao próprio painel passam.
 */
function fakeFetch() {
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' }
    }));
    if (url.startsWith(`https://brasilapi.com.br/api/cnpj/v1/${CNPJ_NOVO}`)) {
      return json(200, {
        cnpj: CNPJ_NOVO,
        razao_social: 'SILVA E ROCHA DISTRIBUIDORA LTDA',
        nome_fantasia: 'SR DISTRIBUIDORA',
        descricao_tipo_de_logradouro: 'AVENIDA',
        logradouro: 'WASHINGTON SOARES',
        numero: '3200',
        complemento: 'GALPAO 5',
        bairro: 'EDSON QUEIROZ',
        municipio: 'FORTALEZA',
        uf: 'CE',
        cep: '60811100',
        email: 'contato@sr.test',
        ddd_telefone_1: '8533334444'
      });
    }
    if (url.startsWith('https://brasilapi.com.br/api/cep/v2/60125120')) {
      return json(200, { cep: '60125120', state: 'CE', city: 'Fortaleza', neighborhood: 'Meireles', street: 'Rua Joaquim Nabuco' });
    }
    if (url.startsWith(panelUrl)) return realFetch(input, init);
    return json(503, {});
  };
}

const lookup = (document) => call(`${panelUrl}/api/contacts/lookup/document?document=${document}`, auth());
const criarNoSgp = (body) => call(`${panelUrl}/api/contacts/sgp`, { method: 'POST', ...auth(), body });

const PESSOA = {
  document: '813.735.630-44',
  name: 'Lucas Henrique Pereira',
  whatsappPhone: '(85) 99812-3456',
  email: 'Lucas@Email.test',
  birthDate: '1980-04-01',
  address: {
    street: 'Rua Joaquim Nabuco',
    number: '850',
    complement: 'Apto 201',
    district: 'Meireles',
    city: 'Fortaleza',
    state: 'ce',
    zip: '60125-120',
    reference: 'Próximo ao hospital',
    latitude: -3.7241,
    longitude: -38.4936
  }
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual' }));
  fakeFetch();
});

after(async () => {
  globalThis.fetch = realFetch;
  await stopTestServers();
  await new Promise((done) => sgpServer.close(done));
});

beforeEach(() => {
  modoCriacao = 'ok';
});

describe('consultar o documento antes do cadastro', () => {
  it('recusa um CPF que não confere', async () => {
    const res = await lookup('11111111111');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_document');
  });

  it('acha quem já está no SGP e devolve a chave da ficha', async () => {
    const res = await lookup(CPF_EXISTENTE);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.personType, 'PF');
    assert.equal(res.body.data.inSgp.length, 1);
    assert.equal(res.body.data.inSgp[0].key, 'K-EXISTE');
    assert.equal(res.body.data.prefill, null);
  });

  it('um CPF novo vem sem preenchimento: não há fonte pública de CPF', async () => {
    const res = await lookup(CPF_NOVO);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.inSgp, []);
    assert.equal(res.body.data.prefill, null);
  });

  it('um CNPJ novo vem preenchido pela Receita', async () => {
    const res = await lookup(CNPJ_NOVO);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { prefill } = res.body.data;
    assert.equal(res.body.data.personType, 'PJ');
    assert.equal(prefill.name, 'SILVA E ROCHA DISTRIBUIDORA LTDA');
    assert.equal(prefill.tradeName, 'SR DISTRIBUIDORA');
    assert.equal(prefill.address.city, 'FORTALEZA');
    assert.equal(prefill.address.zip, '60811100');
  });

  it('o CEP preenche o endereço', async () => {
    const res = await call(`${panelUrl}/api/contacts/lookup/cep?cep=60125-120`, auth());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.city, 'Fortaleza');
    const ruim = await call(`${panelUrl}/api/contacts/lookup/cep?cep=123`, auth());
    assert.equal(ruim.status, 400);
  });
});

describe('cadastrar no SGP', () => {
  it('manda o corpo no formato da API de CRM e abre a ficha com o id do SGP', async () => {
    criados.length = 0;
    const res = await criarNoSgp(PESSOA);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(criados.length, 1);
    const [{ path, body }] = criados;
    assert.equal(path, '/api/crm/cliente/F');
    assert.equal(body.app, APP);
    assert.equal(body.cpfcnpj, '813.735.630-44');
    assert.equal(body.nome, 'Lucas Henrique Pereira');
    assert.equal(body.celular, '85998123456');
    assert.equal(body.email, 'lucas@email.test');
    assert.equal(body.datanasc, '01/04/1980');
    assert.deepEqual(body.endereco, {
      logradouro: 'Rua Joaquim Nabuco',
      numero: '850',
      complemento: 'Apto 201',
      bairro: 'Meireles',
      cidade: 'Fortaleza',
      cep: '60125-120',
      uf: 'CE',
      pais: 'BR',
      pontoreferencia: 'Próximo ao hospital',
      map_ll: '-3.7241,-38.4936'
    });

    // A ficha fica no painel sob o id do SGP: a próxima sincronização acha a mesma.
    const profile = res.body.data;
    assert.match(profile.key, /^c:\d+$/);
    const client = await asTenant(() => getDb()('sgp_clients').where({ sgp_client_id: '58' }).first());
    assert.ok(client, 'o cliente não foi gravado com o id do SGP');
    assert.equal(client.source, 'sgp');
    assert.equal(client.document, CPF_NOVO);

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.created' }).orderBy('id', 'desc').first());
    const detalhe = JSON.parse(trilha.detail);
    assert.equal(detalhe.sgp, true);
    assert.equal(detalhe.sgpClientId, '58');
    assert.equal(trilha.detail.includes('Joaquim'), false, 'a trilha guardou dado pessoal');
  });

  it('pessoa jurídica vai para /J com os campos da empresa', async () => {
    criados.length = 0;
    const res = await criarNoSgp({
      document: CNPJ_NOVO,
      name: 'Silva e Rocha Distribuidora LTDA',
      tradeName: 'SR Distribuidora',
      responsibleName: 'Ricardo Almeida Rocha',
      responsibleDocument: '224.271.340-07',
      birthDate: '1980-03-18',
      address: { street: 'Avenida Washington Soares', number: 'S/N', district: 'Edson Queiroz', city: 'Fortaleza', state: 'CE', zip: '60811100' }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [{ path, body }] = criados;
    assert.equal(path, '/api/crm/cliente/J');
    assert.equal(body.cpfcnpj, '67.897.733/0001-41');
    assert.equal(body.nomefantasia, 'SR Distribuidora');
    assert.equal(body.respcpf, '22427134007');
    assert.equal(body.datafundacao, '18/03/1980');
    assert.equal(body.datanasc, undefined);
    // "S/N" não é inteiro: vai no complemento.
    assert.equal(body.endereco.numero, undefined);
    assert.equal(body.endereco.complemento, 'S/N');
  });

  it('não cria de novo quem já está no SGP', async () => {
    criados.length = 0;
    const res = await criarNoSgp({ ...PESSOA, document: CPF_EXISTENTE });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'already_in_sgp');
    assert.deepEqual(criados, [], 'o SGP foi chamado mesmo com o cliente já lá');
  });

  it('exige o que o SGP exige, antes de chamá-lo', async () => {
    criados.length = 0;
    const semBairro = await criarNoSgp({ ...PESSOA, address: { ...PESSOA.address, district: '' } });
    assert.equal(semBairro.status, 400);
    const semCep = await criarNoSgp({ ...PESSOA, address: { ...PESSOA.address, zip: '123' } });
    assert.equal(semCep.status, 400);
    assert.deepEqual(criados, []);
  });

  it('uma resposta sem cliente_id não conta como cadastro', async () => {
    modoCriacao = 'sem-id';
    const res = await criarNoSgp({ ...PESSOA, document: '11144477735' });
    assert.equal(res.status, 502);
    assert.match(res.body.message, /bairro/);
    const orfao = await asTenant(() => getDb()('sgp_clients').where({ document: '11144477735' }).first());
    assert.equal(orfao, undefined);
  });

  it('a recusa do SGP chega com as palavras dele', async () => {
    modoCriacao = 'recusa';
    const res = await criarNoSgp({ ...PESSOA, document: '11144477735' });
    assert.equal(res.status, 502);
    assert.match(res.body.message, /já cadastrado/);
  });

  it('quem não tem sgp.act não cria no SGP', async () => {
    await call(`${panelUrl}/api/users`, {
      method: 'POST', ...auth(),
      body: { username: 'viewer1', password: 'viewer-password-1', email: 'viewer1@exemplo.test', role: 'viewer' }
    });
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'viewer1', password: 'viewer-password-1' }
    });
    const res = await call(`${panelUrl}/api/contacts/sgp`, {
      method: 'POST', headers: authHeaders(login.body.data.token), body: PESSOA
    });
    assert.equal(res.status, 403);
  });
});

/**
 * Quem não está no SGP nem no painel: a TeiaH preenche. A TeiaH falsa responde
 * `consulta-cpf` com o formato visto no Swagger (`resultado.mix.*.data`), mais
 * endereço e telefones, e guarda o que recebeu.
 */
describe('preencher pela TeiaH', () => {
  const TEIAH_KEY = 'chave-teiah-consulta';
  let teiahServer;
  let teiahModo = 'ok';
  const consultas = [];

  const RESPOSTA = {
    resultado: {
      mix: {
        score: { data: { risco: 'BAIXO', score: 390, descricaoPagamento: null, probabilidadePagamento: null } },
        emails: { data: ['FULANO@EXEMPLO.TEST', 'outro@exemplo.test'] },
        pessoa: {
          data: {
            cpf: CPF_NOVO,
            nome: 'FULANO DA TEIAH',
            idade: 41,
            obito: null,
            nomeMae: 'MAE DO FULANO',
            dataNascimento: '01/04/1985'
          }
        },
        telefones: { data: [{ ddd: '93', numero: '35221234' }, { ddd: '93', numero: '991234567' }] },
        enderecos: {
          data: [{
            tipoLogradouro: 'RUA', logradouro: 'DAS FLORES', numero: '10', bairro: 'CENTRO',
            cidade: 'ITAITUBA', uf: 'pa', cep: '68180-000'
          }]
        }
      }
    }
  };

  before(async () => {
    teiahServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        consultas.push({ path: req.url, key: req.headers['x-api-key'], body: JSON.parse(raw || 'null') });
        const send = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.headers['x-api-key'] !== TEIAH_KEY || teiahModo === '401') {
          return send(401, { statusCode: 401, message: 'API Key inválida ou revogada' });
        }
        if (req.url === '/api/whatsapp/consulta-cpf') return send(201, RESPOSTA);
        return send(404, {});
      });
    });
    const url = await new Promise((resolve) => {
      teiahServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${teiahServer.address().port}`));
    });
    await asTenant(() => TeiahService.saveConfig({ enabled: true, baseUrl: url, apiKey: TEIAH_KEY }));
  });

  after(async () => {
    await asTenant(() => TeiahService.saveConfig({ enabled: false }));
    await new Promise((done) => teiahServer.close(done));
  });

  beforeEach(() => {
    teiahModo = 'ok';
    consultas.length = 0;
  });

  it('um CPF fora do SGP vem preenchido pela TeiaH, com o score', async () => {
    const res = await lookup('111.444.777-35');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { prefill, teiahScore, deceased } = res.body.data;
    assert.equal(prefill.source, 'teiah');
    assert.equal(prefill.name, 'FULANO DA TEIAH');
    assert.equal(prefill.birthDate, '1985-04-01');
    assert.equal(prefill.email, 'fulano@exemplo.test');
    // O celular primeiro: é o número que o WhatsApp alcança.
    assert.equal(prefill.phone, '5593991234567');
    assert.deepEqual(prefill.address, {
      street: 'RUA DAS FLORES', number: '10', district: 'CENTRO', city: 'ITAITUBA', state: 'PA', zip: '68180000'
    });
    assert.equal(teiahScore.score, 390);
    assert.equal(deceased, false);
    assert.equal(consultas.length, 1);
    assert.equal(consultas[0].path, '/api/whatsapp/consulta-cpf');
    assert.equal(consultas[0].key, TEIAH_KEY);
    assert.deepEqual(consultas[0].body, { cpf: '11144477735' });
    // O resto da ficha da TeiaH não chega à tela.
    assert.equal(JSON.stringify(res.body).includes('MAE DO FULANO'), false);

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.teiah_lookup' }).orderBy('id', 'desc').first());
    assert.ok(trilha, 'a consulta à TeiaH não deixou rastro');
    assert.equal(trilha.detail.includes('11144477735'), false, 'a trilha guardou o documento');
    assert.equal(JSON.parse(trilha.detail).found, true);
  });

  it('o endereço fora das seções esperadas é achado, e o que falta vem do CEP', async () => {
    // Uma empresa: a TeiaH guarda o endereço numa seção que o código não conhece
    // e traz só o CEP; rua, bairro, cidade e UF vêm do serviço de CEP.
    const original = JSON.stringify(RESPOSTA);
    const outra = JSON.parse(original);
    delete outra.resultado.mix.enderecos;
    outra.resultado.mix.localizacao = { data: { sede: { cep: '68180-000', numero: '77' } } };
    const { normalizeConsult } = await import('../src/services/teiahService.js');
    const result = normalizeConsult(outra);
    assert.deepEqual(result.address, { number: '77', zip: '68180000' });
  });

  it('quem já está no SGP não é consultado na TeiaH', async () => {
    const res = await lookup(CPF_EXISTENTE);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.inSgp.length, 1);
    assert.equal(res.body.data.teiahConsulted, false);
    assert.deepEqual(consultas, []);
  });

  it('a TeiaH recusando a chave vira formulário em branco, não erro', async () => {
    teiahModo = '401';
    // Outro CPF: o '111.444.777-35' já foi consultado acima e o painel não consulta de novo.
    const res = await lookup('123.456.789-09');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.prefill, null);
    assert.equal(res.body.data.prefillError, true);
  });

  it('a leitura aceita outros nomes e formatos', () => {
    const lido = normalizeConsult({
      resultado: {
        mix: {
          pessoa: { nome: 'SEM DATA', obito: 'S', data_nascimento: '1990-02-03' },
          telefones: ['(93) 99123-4567'],
          endereco: { data: { logradouro: 'AV BRASIL', municipio: 'SANTAREM', uf: 'PA', cep: '68000000' } },
          email: { data: [{ email: 'X@Y.TEST' }] }
        }
      }
    });
    assert.equal(lido.name, 'SEM DATA');
    assert.equal(lido.deceased, true);
    assert.equal(lido.birthDate, '1990-02-03');
    assert.deepEqual(lido.phones, ['5593991234567']);
    assert.equal(lido.address.city, 'SANTAREM');
    assert.deepEqual(lido.emails, ['x@y.test']);
    assert.equal(normalizeConsult({}).found, false);
  });
});
