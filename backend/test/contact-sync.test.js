import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpContactSyncService } = await import('../src/services/sgpContactSyncService.js');
const { default: Setting } = await import('../src/models/Setting.js');

/**
 * "Sincronizar" na ficha do cliente: o SGP consultado de novo só para aquele
 * cliente, e as ONTs dos contratos chamadas a reportar agora.
 */

const APP = 'painel';
const TOKEN = 'token-da-sincronizacao';

const sgp = {
  server: null,
  down: false,
  cliente: null
};

function clienteBase() {
  return {
    id: 541,
    nome: 'JOSE RIBAMAR',
    tipo: 'F',
    cpfcnpj: '686.506.202-72',
    endereco: { logradouro: 'Avenida Eça de Queirós', numero: '200', cidade: 'Itaituba', uf: 'PA' },
    contatos: { celulares: ['(93) 99111-0001'], emails: ['jose@exemplo.test'] },
    contratos: [{ id: 569, status: 'Ativo', vencimento: '10' }]
  };
}

let panelUrl;
let token;
let genie;

const sincronizar = (key, auth = token) => call(`${panelUrl}/api/contacts/${encodeURIComponent(key)}/sync`, {
  method: 'POST', headers: authHeaders(auth)
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgp.cliente = clienteBase();
  sgp.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (sgp.down) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('fora do ar');
      }
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/clientes')) {
        // A listagem filtrada pelo documento, como o botão pede; a sincronização
        // geral pede páginas.
        return res.end(JSON.stringify({ status: 1, clientes: [sgp.cliente] }));
      }
      // consultacliente: pelo contrato.
      return res.end(JSON.stringify({
        status: 1,
        contratos: sgp.cliente.contratos.map((contrato) => ({
          contrato: contrato.id, status: contrato.status, razaoSocial: sgp.cliente.nome,
          cpfCnpj: sgp.cliente.cpfcnpj, celular: sgp.cliente.contatos.celulares[0]
        }))
      }));
    });
  });
  await new Promise((resolve) => sgp.server.listen(0, '127.0.0.1', resolve));
  const sgpUrl = `http://127.0.0.1:${sgp.server.address().port}`;

  genie = await startGenieAcsStub({ devices: [buildDevice({ id: 'ONT-569' })] });
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual', contactsPageSize: 10
  }));
  await asTenant(() => SgpContactSyncService.syncAll());
  await getDb()('sgp_links').insert({
    tenant_id: 1, device_id: 'ONT-569', contract: '569', client_name: 'JOSE RIBAMAR', state: 'active', link_mode: 'manual'
  });
});

after(async () => {
  await new Promise((resolve) => sgp.server.close(resolve));
  await genie?.close?.();
  await stopTestServers();
});

describe('sincronizar um cliente', () => {
  it('traz os dados novos do SGP e chama a ONT do contrato', async () => {
    // O operador corrigiu o endereço no painel; no SGP mudaram o nome e o celular.
    const editar = await call(`${panelUrl}/api/contacts/569`, {
      method: 'PATCH', headers: authHeaders(token), body: { address: { street: 'Rua Corrigida no Painel', city: 'Itaituba' } }
    });
    assert.equal(editar.status, 200, JSON.stringify(editar.body));
    sgp.cliente = { ...clienteBase(), nome: 'JOSE RIBAMAR TEODORICO DE SOUSA', contatos: { celulares: ['(93) 99111-0002'], emails: [] } };

    const res = await sincronizar('569');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { profile, sgp: resultado, devices } = res.body.data;
    assert.equal(resultado.error, null);
    assert.equal(resultado.contracts, 1);
    assert.equal(profile.fields.name.value, 'JOSE RIBAMAR TEODORICO DE SOUSA');
    assert.deepEqual(profile.fields.phones.value, ['5593991110002']);
    assert.equal(profile.fields.address.value.street, 'Rua Corrigida no Painel', 'a edição do painel continua valendo');

    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceId, 'ONT-569');
    assert.ok(genie.state.tasks.some((task) => task.deviceId === 'ONT-569'), 'a ONT recebeu o summon');

    const trilha = await getDb()('audit_log').where({ action: 'contact.synced' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.doesNotMatch(String(trilha.detail), /RIBAMAR/, 'a trilha não guarda dados do cadastro');
  });

  it('com o SGP fora do ar, avisa o erro e chama a ONT mesmo assim', async () => {
    sgp.down = true;
    const antes = genie.state.tasks.length;
    const res = await sincronizar('569');
    sgp.down = false;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.sgp.error, 'o erro do SGP vem na resposta');
    assert.ok(genie.state.tasks.length > antes, 'o summon rodou');
  });

  it('uma chave que não existe dá 404', async () => {
    const res = await sincronizar('CONTRATO-QUE-NAO-EXISTE');
    assert.equal(res.status, 404);
  });
});
