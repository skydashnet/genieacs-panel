import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

/**
 * Os números ao lado de cada filtro da tela de Contatos: quantos contatos a
 * lista mostraria se aquele filtro fosse clicado, com os outros mantidos.
 */

let panelUrl;
let token;

const lista = (query = '') => call(`${panelUrl}/api/whatsapp/contacts?limit=200${query}`, { headers: authHeaders(token) });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await getDb()('sgp_contacts').insert([
    { tenant_id: 1, contract: '401', client_name: 'ATIVO COM FONE', phone_e164: '5593991110401', state: 'active' },
    { tenant_id: 1, contract: '402', client_name: 'ATIVO SEM FONE', state: 'active' },
    { tenant_id: 1, contract: '403', client_name: 'ATIVO SEM FONE DOIS', state: 'active' },
    { tenant_id: 1, contract: '404', client_name: 'SUSPENSO COM FONE', phone_e164: '5593991110404', state: 'blocked' },
    { tenant_id: 1, contract: '405', client_name: 'CANCELADO SEM FONE', state: 'cancelled' },
    { tenant_id: 1, contract: null, client_name: 'IMPORTADO COM FONE', phone_e164: '5593991110406', state: 'none', import_source: 'whatsapp' },
    { tenant_id: 1, contract: null, client_name: 'IMPORTADO SEM FONE', state: 'none', import_source: 'sheet' }
  ]);
});

after(async () => {
  await stopTestServers();
});

describe('os números dos filtros de Contatos', () => {
  it('as abas contam a lista inteira quando nenhum botão está ligado', async () => {
    const { status, body } = await lista();
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.counts, {
      states: { all: 7, active: 3, blocked: 1, cancelled: 1, none: 2 },
      noPhone: 4,
      imported: 2,
      withDevice: 0,
      withoutDevice: 7
    });
    assert.equal(body.data.total, 7);
  });

  it('o número de cada aba é o total que a lista daria ao clicar nela', async () => {
    const { body } = await lista();
    for (const [aba, estado] of [['all', ''], ['active', 'active'], ['blocked', 'blocked'], ['cancelled', 'cancelled'], ['none', 'none']]) {
      // eslint-disable-next-line no-await-in-loop -- sete leituras pequenas
      const real = await lista(estado ? `&state=${estado}` : '');
      assert.equal(real.body.data.total, body.data.counts.states[aba], `aba ${aba}`);
    }
  });

  it('os botões ligados mudam o número das abas, e o de cada botão segue a aba', async () => {
    const semFone = await lista('&noPhone=true');
    assert.deepEqual(semFone.body.data.counts.states, { all: 4, active: 2, blocked: 0, cancelled: 1, none: 1 });
    assert.equal(semFone.body.data.counts.noPhone, 4, 'o botão ligado mostra o total da lista');
    assert.equal(semFone.body.data.counts.imported, 1, 'importados sem telefone');
    assert.equal(semFone.body.data.total, 4);

    const ativosSemFone = await lista('&state=active&noPhone=true');
    assert.equal(ativosSemFone.body.data.total, 2);
    assert.equal(ativosSemFone.body.data.counts.noPhone, 2);
    assert.equal(ativosSemFone.body.data.counts.imported, 0, 'não há importado entre os ativos');

    const importados = await lista('&imported=true');
    assert.deepEqual(importados.body.data.counts.states, { all: 2, active: 0, blocked: 0, cancelled: 0, none: 2 });
    assert.equal(importados.body.data.counts.noPhone, 1);
  });

  it('a busca reduz todos os números', async () => {
    const { body } = await lista('&search=SEM%20FONE');
    assert.deepEqual(body.data.counts.states, { all: 4, active: 2, blocked: 0, cancelled: 1, none: 1 });
    assert.equal(body.data.counts.noPhone, 4);
    assert.equal(body.data.counts.imported, 1);
  });

  it('uma página adiante devolve os mesmos números', async () => {
    const primeira = await lista('&limit=2');
    const segunda = await call(`${panelUrl}/api/whatsapp/contacts?limit=2&offset=2`, { headers: authHeaders(token) });
    assert.equal(segunda.body.data.contacts.length, 2);
    assert.deepEqual(segunda.body.data.counts, primeira.body.data.counts);
  });

  // Por último: a ONT ligada ao contrato 401 muda quem tem equipamento.
  it('com e sem equipamento: contam, filtram e combinam com a aba', async () => {
    await getDb()('sgp_links').insert({
      tenant_id: 1, device_id: 'ONT-401', contract: '401', client_name: 'ATIVO COM FONE', state: 'active', link_mode: 'manual'
    });
    const { body } = await lista();
    assert.equal(body.data.counts.withDevice, 1);
    assert.equal(body.data.counts.withoutDevice, 6);

    const com = await lista('&device=with');
    assert.equal(com.body.data.total, 1);
    assert.equal(com.body.data.contacts[0].deviceId, 'ONT-401');
    assert.equal(com.body.data.counts.states.all, 1);

    const semAtivos = await lista('&device=without&state=active');
    assert.equal(semAtivos.body.data.total, 2);
    assert.ok(semAtivos.body.data.contacts.every((contact) => !contact.hasDevice));

    const ignorado = await lista('&device=qualquer');
    assert.equal(ignorado.body.data.total, 7, 'um valor desconhecido não filtra');
  });
});
