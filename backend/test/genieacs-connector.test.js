import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * O conector: a fronteira entre "o painel quer um recurso do ACS" e "o painel
 * abre uma requisição HTTP para um host".
 *
 * O que este arquivo persegue é o destino **exato** — pathname e busca, e não
 * um `startsWith('/devices')`. A diferença não é preciosismo: enquanto os
 * servidores falsos dos outros testes aceitavam qualquer coisa que começasse
 * com `/devices`, a frota inteira passou a pedir `/devices/?projection=...`, com
 * uma barra a mais, e nada reclamou daqui até o socket. Numa NBI de verdade
 * aquela barra é outra rota.
 *
 * O segundo caso é o inverso do primeiro: um caminho que TENTA escolher o host.
 * A raiz decide o servidor; o caminho, nunca — e é a única invariante do
 * conector que um modo novo (agente, túnel) também vai ter de honrar.
 */

const {
  asTenant, startTestServers, stopTestServers, call
} = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: ProvisioningService } = await import('../src/services/provisioningService.js');
const { connectorFor } = await import('../src/services/genieacs/connector.js');

let panelUrl;
let servidor;
let base;
let pedidos = [];

before(async () => {
  ({ panelUrl } = await startTestServers());
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador', password: 'senha-do-operador-1', email: 'operador@exemplo.test' }
  });

  servidor = http.createServer((req, res) => {
    pedidos.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
  await asTenant(() => Setting.upsert('genieAcsUrl', base));
});

after(async () => {
  await new Promise((resolve) => servidor.close(resolve));
  await stopTestServers();
});

/** O `pathname` de tudo que chegou ao ACS falso desde a última limpeza. */
const caminhos = () => pedidos.map((url) => new URL(url, base).pathname);

describe('o destino que sai no fio', () => {
  /**
   * As quatro leituras de frota. Todas pediam a mesma coisa por uma forma
   * diferente das demais — a busca embutida no endpoint —, que é justamente a
   * forma que a barra a mais produzia.
   */
  const leituras = [
    ['painel', () => asTenant(() => DeviceService.getDashboardDevices())],
    ['telemetria', () => asTenant(() => DeviceService.getTelemetryFleet())],
    ['identidade do assinante', () => asTenant(() => DeviceService.getCustomerIdentityDevices())],
    ['candidatos a provisionamento', () => asTenant(() => ProvisioningService.findCandidates({ limit: 1 }))]
  ];

  for (const [nome, ler] of leituras) {
    it(`a leitura de ${nome} pede /devices, sem barra a mais`, async () => {
      pedidos = [];
      await ler();
      assert.ok(pedidos.length >= 1, 'a leitura precisa ter falado com o ACS');
      assert.deepEqual(
        [...new Set(caminhos())],
        ['/devices'],
        `saiu ${JSON.stringify(pedidos)}`
      );
    });
  }

  it('e a projeção continua indo junto, como parâmetro de busca', async () => {
    // O par que dá sentido aos quatro acima: sem ele, um conector que jogasse a
    // busca fora passaria em todos.
    pedidos = [];
    await asTenant(() => DeviceService.getTelemetryFleet());
    const busca = new URL(pedidos[0], base).searchParams.get('projection');
    assert.ok(busca, 'a projeção precisa chegar ao ACS');
    assert.ok(busca.includes('_lastInform'), `projeção inesperada: ${busca}`);
  });
});

describe('o caminho não escolhe o host', () => {
  it('um caminho absoluto continua caindo na raiz configurada', async () => {
    const connector = await asTenant(() => connectorFor());
    const url = await asTenant(() => connector.urlFor('//evil.example/devices'));
    assert.equal(url.host, new URL(base).host);
  });

  it('e um caminho com busca embutida é recusado antes de virar destino', () => {
    // A recusa é o que impede a forma antiga de voltar em silêncio: ela não
    // dava erro nenhum, só mudava a rota.
    assert.throws(
      () => DeviceService.devicePath('?projection=_id'),
      /query string/
    );
    assert.equal(DeviceService.devicePath('abc/tasks'), 'devices/abc/tasks');
    assert.equal(DeviceService.devicePath(''), 'devices');
  });
});
