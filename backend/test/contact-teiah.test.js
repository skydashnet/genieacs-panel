import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: TeiahService, normalizeConsult } = await import('../src/services/teiahService.js');
const { tinsert } = await import('../src/config/database.js');
const { default: TeiahConsultation } = await import('../src/models/TeiahConsultation.js');

/**
 * A TeiaH para quem já é cliente: a consulta grava um instantâneo na ficha,
 * "Aplicar" o junta à ficha sem tirar nada, e a busca em lote só olha quem está
 * ativo e sem telefone. A TeiaH falsa responde por CPF e conta as consultas.
 */

const TEIAH_KEY = 'chave-teiah-ficha';
// CPFs válidos.
const CPF_A = '81373563044';
const CPF_B = '52998224725';
const CPF_C = '11144477735';
const CPF_D = '39053344705';
// Para o cache: um achado, um que a TeiaH não conhece e um que dá erro.
const CPF_E = '12345678909';
const CPF_NAO_ACHADO = '98765432100';
const CPF_ERRO = '45317828791';

const RESPOSTAS = {
  [CPF_A]: {
    resultado: {
      mix: {
        score: { data: { risco: 'BAIXO', score: 700 } },
        emails: { data: ['A@EXEMPLO.TEST', 'a2@exemplo.test'] },
        pessoa: { data: { nome: 'ANA DA TEIAH', nomeMae: 'MARIA DA TEIAH', dataNascimento: '01/04/1985' } },
        telefones: { data: [{ ddd: '93', numero: '35221234' }, { ddd: '93', numero: '991234567' }] },
        enderecos: {
          data: [
            { tipoLogradouro: 'RUA', logradouro: 'DAS FLORES', numero: '10', bairro: 'CENTRO', cidade: 'ITAITUBA', uf: 'pa', cep: '68180-000' },
            { logradouro: 'AV BRASIL', numero: '99', bairro: 'JARDIM', cidade: 'ITAITUBA', uf: 'pa', cep: '68180-111' }
          ]
        }
      }
    }
  },
  // Sem telefone nenhum: a TeiaH conhece, mas não tem número.
  [CPF_B]: { resultado: { mix: { pessoa: { data: { nome: 'BIA SEM FONE' } }, emails: { data: ['bia@exemplo.test'] } } } },
  [CPF_C]: {
    resultado: { mix: { pessoa: { data: { nome: 'CARLOS' } }, telefones: { data: [{ ddd: '93', numero: '988887777' }] } } }
  },
  [CPF_E]: {
    resultado: {
      mix: {
        pessoa: { data: { nome: 'EVA DO CACHE' } },
        telefones: { data: [{ ddd: '93', numero: '966665555' }] },
        enderecos: { data: [{ logradouro: 'RUA DO CACHE', numero: '1', bairro: 'CENTRO', cidade: 'ITAITUBA', uf: 'pa', cep: '68180-000' }] }
      }
    }
  },
  [CPF_D]: { resultado: { mix: { pessoa: { data: { nome: 'DIOGO' } }, telefones: { data: [{ ddd: '93', numero: '977776666' }] } } } }
};

let panelUrl;
let token;
let teiahServer;
const consultas = [];
// Para o teste do erro: a TeiaH fora do ar não deixa nada guardado.
let teiahFora = false;
const auth = () => ({ headers: authHeaders(token) });

function startTeiahStub() {
  teiahServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-api-key'] !== TEIAH_KEY) return send(401, { message: 'API Key inválida' });
      const { cpf } = JSON.parse(raw || '{}');
      consultas.push(cpf);
      if (teiahFora) return send(503, { message: 'indisponível' });
      return RESPOSTAS[cpf] ? send(201, RESPOSTAS[cpf]) : send(404, {});
    });
  });
  return new Promise((resolve) => {
    teiahServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${teiahServer.address().port}`));
  });
}

async function addContract(contract, name, document, extra = {}) {
  await asTenant(() => tinsert('sgp_contacts', {
    contract, client_name: name, document, state: 'active', phone_e164: null, last_synced_at: new Date(), ...extra
  }));
  return contract;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const url = await startTeiahStub();
  await asTenant(() => TeiahService.saveConfig({ enabled: true, baseUrl: url, apiKey: TEIAH_KEY }));
});

after(async () => {
  await asTenant(() => TeiahService.saveConfig({ enabled: false }));
  await new Promise((done) => teiahServer.close(done));
  await stopTestServers();
});

describe('o que a consulta traz', () => {
  it('lê todos os telefones, e-mails e endereços, a mãe e o score', () => {
    const result = normalizeConsult(RESPOSTAS[CPF_A]);
    assert.deepEqual(result.emails, ['a@exemplo.test', 'a2@exemplo.test']);
    // O celular primeiro.
    assert.deepEqual(result.phones, ['5593991234567', '559335221234']);
    assert.equal(result.motherName, 'MARIA DA TEIAH');
    assert.equal(result.addresses.length, 2);
    assert.equal(result.addresses[0].street, 'RUA DAS FLORES');
    assert.equal(result.address.zip, '68180000');
    assert.equal(result.score.score, 700);
  });

  it('acha telefones e e-mails fora das seções esperadas', () => {
    const result = normalizeConsult({
      resultado: { mix: { pessoa: { data: { nome: 'X' } }, contato: { data: { celular: { ddd: '93', numero: '911112222' }, email_principal: 'x@exemplo.test' } } } }
    });
    assert.deepEqual(result.phones, ['5593911112222']);
    assert.deepEqual(result.emails, ['x@exemplo.test']);
  });
});

describe('consultar e aplicar na ficha', () => {
  it('a consulta grava o instantâneo e a ficha o mostra; aplicar junta sem repetir', async () => {
    await addContract('T-100', 'Ana Cliente', CPF_A);
    const antes = await call(`${panelUrl}/api/contacts/T-100/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(antes.status, 409, 'aplicar sem consultar não tem o que aplicar');
    assert.equal(antes.body.code, 'teiah_not_consulted');

    const consulta = await call(`${panelUrl}/api/contacts/T-100/teiah`, { method: 'POST', ...auth() });
    assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
    assert.equal(consulta.body.data.teiah.motherName, 'MARIA DA TEIAH');

    const ficha = await call(`${panelUrl}/api/contacts/T-100`, auth());
    assert.equal(ficha.body.data.teiahReady, true);
    assert.equal(ficha.body.data.teiah.score.score, 700);
    assert.equal(ficha.body.data.teiah.addresses.length, 2);

    const aplicado = await call(`${panelUrl}/api/contacts/T-100/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.body));
    assert.equal(aplicado.body.data.phonesAdded, 2);
    assert.equal(aplicado.body.data.emailsAdded, 2);
    assert.equal(aplicado.body.data.whatsappSet, 1);
    const depois = aplicado.body.data.profile;
    assert.deepEqual(depois.fields.phones.value.sort(), ['559335221234', '5593991234567']);
    assert.equal(depois.whatsappPhone, '5593991234567', 'o celular vira o WhatsApp de quem não tinha número');
    assert.equal(depois.fields.phones.edited, true);

    const outra = await call(`${panelUrl}/api/contacts/T-100/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(outra.body.data.phonesAdded, 0);
    assert.equal(outra.body.data.whatsappSet, 0);
  });

  it('não troca o WhatsApp de quem já tem número', async () => {
    await addContract('T-110', 'Ana Com Número', CPF_A, { phone_e164: '5593900000000' });
    await call(`${panelUrl}/api/contacts/T-110/teiah`, { method: 'POST', ...auth() });
    const aplicado = await call(`${panelUrl}/api/contacts/T-110/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(aplicado.body.data.whatsappSet, 0);
    assert.equal(aplicado.body.data.profile.whatsappPhone, '5593900000000');
  });

  it('a trilha não leva o documento nem o número', async () => {
    const rows = await asTenant(() => getDb()('audit_log').whereIn('action', ['contact.teiah_lookup', 'contact.teiah_applied']));
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.detail.includes(CPF_A), false);
      assert.equal(row.detail.includes('5593991234567'), false);
    }
  });

  it('um cliente sem CPF/CNPJ válido não é consultado', async () => {
    await addContract('T-120', 'Sem Documento', null);
    const res = await call(`${panelUrl}/api/contacts/T-120/teiah`, { method: 'POST', ...auth() });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_document');
  });
});

describe('a busca em lote dos clientes sem telefone', () => {
  it('consulta só quem está ativo, sem telefone e com documento; prévia e aplicar', async () => {
    await addContract('L-1', 'Bia Sem Fone', CPF_B);
    await addContract('L-2', 'Carlos Sem Fone', CPF_C);
    await addContract('L-3', 'Diogo Cancelado', CPF_D, { state: 'cancelled' });
    await addContract('L-4', 'Com Número', CPF_D, { phone_e164: '5593955550000' });
    consultas.length = 0;

    const scan = await call(`${panelUrl}/api/contacts/teiah/phones/scan`, { method: 'POST', ...auth() });
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.data.remaining, 0);
    assert.deepEqual([...new Set(consultas)].sort(), [CPF_B, CPF_C].sort(), 'só os ativos sem telefone');

    // Uma segunda passada não repete a consulta paga.
    consultas.length = 0;
    const outra = await call(`${panelUrl}/api/contacts/teiah/phones/scan`, { method: 'POST', ...auth() });
    assert.equal(outra.body.data.processed, 0);
    assert.deepEqual(consultas, []);

    const prévia = await call(`${panelUrl}/api/contacts/teiah/phones`, auth());
    assert.equal(prévia.status, 200);
    // A Bia não tem telefone na TeiaH: não aparece. O Carlos tem.
    assert.deepEqual(prévia.body.data.rows.map((row) => row.key), ['L-2']);
    assert.deepEqual(prévia.body.data.rows[0].phones, ['5593988887777']);

    const aplicado = await call(`${panelUrl}/api/contacts/teiah/phones/apply`, { method: 'POST', ...auth(), body: { keys: ['L-2', 'L-inexistente'] } });
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.body));
    assert.equal(aplicado.body.data.clients, 1);
    assert.equal(aplicado.body.data.skipped, 1);

    const depois = await call(`${panelUrl}/api/contacts/teiah/phones`, auth());
    assert.deepEqual(depois.body.data.rows, [], 'quem recebeu o número sai da lista de sem telefone');
    const ficha = await call(`${panelUrl}/api/contacts/L-2`, auth());
    assert.equal(ficha.body.data.whatsappPhone, '5593988887777');
  });
});

describe('não consultar de novo o que foi consultado há pouco', () => {
  const lookup = (document, fresh = false) => call(`${panelUrl}/api/contacts/lookup/document?document=${document}${fresh ? '&fresh=1' : ''}`, auth());
  const saved = (document) => asTenant(() => getDb()('teiah_consultations').where({ document }).first());
  const age = (document, days) => asTenant(() => getDb()('teiah_consultations').where({ document })
    .update({ consulted_at: new Date(Date.now() - days * 86_400_000) }));
  const count = (cpf) => consultas.filter((c) => c === cpf).length;

  it('abrir o Novo cliente duas vezes para o mesmo CPF paga uma consulta só', async () => {
    consultas.length = 0;
    const first = await lookup(CPF_E);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.prefill.name, 'EVA DO CACHE');
    assert.equal(first.body.data.teiahCached, false);
    const second = await lookup(CPF_E);
    assert.equal(second.body.data.prefill.name, 'EVA DO CACHE');
    assert.equal(second.body.data.prefill.address.city, 'ITAITUBA');
    assert.equal(second.body.data.teiahCached, true);
    assert.ok(second.body.data.teiahConsultedAt);
    assert.equal(count(CPF_E), 1);
  });

  it('pedir uma consulta nova (fresh) paga e substitui o que estava guardado', async () => {
    const before = count(CPF_E);
    const res = await lookup(CPF_E, true);
    assert.equal(res.body.data.teiahCached, false);
    assert.equal(count(CPF_E), before + 1);
  });

  it('a ficha reaproveita a consulta do Novo cliente', async () => {
    await addContract('T-200', 'Eva Cliente', CPF_E);
    const before = count(CPF_E);
    const res = await call(`${panelUrl}/api/contacts/T-200/teiah`, { method: 'POST', ...auth() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.cached, true);
    assert.deepEqual(res.body.data.teiah.phones, ['5593966665555']);
    assert.equal(count(CPF_E), before, 'nenhuma chamada à TeiaH');

    const forcada = await call(`${panelUrl}/api/contacts/T-200/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    assert.equal(forcada.body.data.cached, false);
    assert.equal(count(CPF_E), before + 1);
  });

  it('o achado vale 30 dias e o não achado, 7', async () => {
    consultas.length = 0;
    await lookup(CPF_NAO_ACHADO);
    await lookup(CPF_NAO_ACHADO);
    assert.equal(count(CPF_NAO_ACHADO), 1, 'o "não achado" também é guardado');

    await age(CPF_NAO_ACHADO, 6);
    await lookup(CPF_NAO_ACHADO);
    assert.equal(count(CPF_NAO_ACHADO), 1, 'com 6 dias ainda vale');
    await age(CPF_NAO_ACHADO, 8);
    await lookup(CPF_NAO_ACHADO);
    assert.equal(count(CPF_NAO_ACHADO), 2, 'com 8 dias, pergunta de novo');

    await age(CPF_E, 29);
    const before = count(CPF_E);
    await lookup(CPF_E);
    assert.equal(count(CPF_E), before, 'o achado com 29 dias ainda vale');
    await age(CPF_E, 31);
    await lookup(CPF_E);
    assert.equal(count(CPF_E), before + 1, 'com 31 dias, pergunta de novo');
  });

  it('a TeiaH com erro não deixa nada guardado', async () => {
    teiahFora = true;
    try {
      const res = await lookup(CPF_ERRO);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.prefillError, true);
      assert.equal(await saved(CPF_ERRO), undefined);
    } finally {
      teiahFora = false;
    }
  });

  it('o cache é de um provedor só, e a trilha leva só se veio do cache', async () => {
    await asTenant(() => getDb()('tenants').where({ slug: 'beta' }).first())
      || await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    const beta = (await getDb()('tenants').where({ slug: 'beta' }).first()).id;
    assert.equal(await runInTenant(beta, () => TeiahConsultation.get(CPF_E)), null);

    const rows = await asTenant(() => getDb()('audit_log').where({ action: 'contact.teiah_lookup' }));
    assert.ok(rows.some((row) => JSON.parse(row.detail).cached === true));
    for (const row of rows) assert.equal(row.detail.includes(CPF_E), false);
  });
});
