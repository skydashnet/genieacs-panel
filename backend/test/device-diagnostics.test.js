import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const {
  diagnosticRequest, diagnosticRoot, isValidDiagnosticHost, readDiagnosticResult
} = await import('../src/services/deviceDiagnostics.js');

/**
 * Ping e traceroute que saem DA ONT.
 *
 * O que estes casos defendem: cada ONT recebe os caminhos do modelo de dados
 * que ela fala (um TR-181 que recebesse os caminhos TR-098 recusaria a tarefa,
 * e a recusa fica como falha no ACS atrapalhando as tarefas seguintes); o
 * destino é só destino; e consultar o resultado não empilha tarefa numa ONT
 * que está fora do ar.
 */
const TR098 = 'ONT-DIAG-098';
const TR181 = 'ONT-DIAG-181';

function node(value, timestamp = '2026-09-24T12:00:00.000Z') {
  return { _value: value, _writable: true, _timestamp: timestamp };
}

function tr181Device(id) {
  return {
    _id: id,
    _lastInform: new Date().toISOString(),
    _registered: '2026-09-01T00:00:00.000Z',
    _tags: [],
    _deviceId: { _Manufacturer: 'Huawei', _ProductClass: 'HG8145X6', _SerialNumber: 'HWTC00000181' },
    Device: { DeviceInfo: { SerialNumber: node('HWTC00000181'), SoftwareVersion: node('V5') } }
  };
}

let panelUrl;
let token;
let genie;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [buildDevice({ id: TR098 }), tr181Device(TR181)] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

beforeEach(() => {
  genie.state.respond = null;
  genie.state.onTask = null;
  genie.state.taskStatus = 200;
  genie.state.tasks.length = 0;
  for (const device of genie.state.devices) {
    delete device.InternetGatewayDevice?.IPPingDiagnostics;
    delete device.Device?.IP;
  }
});

const post = (path, body) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });
const linhas = () => getDb()('audit_log').where({ action: AuditLog.ACTIONS.DEVICE_DIAGNOSTIC_STARTED }).orderBy('id', 'asc');
const escritos = (deviceId) => genie.state.tasks
  .filter((entry) => entry.deviceId === deviceId && entry.task?.name === 'setParameterValues')
  .flatMap((entry) => entry.task.parameterValues.map(([path]) => path));
const device = (id) => genie.state.devices.find((d) => d._id === id);

describe('o destino é só destino', () => {
  it('aceita IPv4, IPv6 e nome', () => {
    for (const bom of ['8.8.8.8', ' 1.1.1.1 ', '2001:4860:4860::8888', '::1', 'fe80::1', 'google.com', 'dns.provedor.net.br', 'localhost']) {
      assert.equal(isValidDiagnosticHost(bom), true, bom);
    }
  });

  it('recusa o que não é destino', () => {
    for (const ruim of [
      '', '   ', null, undefined, 42, 'http://google.com', 'google.com:443', '8.8.8.8:53', 'a b', 'google.com/x',
      '10.0.0.300', '1.2.3', '01.2.3.4', '-inicio.com', 'fim-.com', 'a..b', '1:2:3', '1::2::3',
      `${'a'.repeat(64)}.com`, 'g$oogle.com', '8.8.8.8;reboot'
    ]) {
      assert.equal(isValidDiagnosticHost(ruim), false, JSON.stringify(ruim));
    }
  });
});

describe('o pedido e a leitura, sem rede', () => {
  it('TR-098 quando existe; TR-181 só quando é a única árvore', () => {
    assert.equal(diagnosticRoot(['InternetGatewayDevice', 'Device']), 'InternetGatewayDevice');
    assert.equal(diagnosticRoot(['Device']), 'Device');
    assert.equal(diagnosticRoot([]), 'InternetGatewayDevice');
  });

  it('o disparo vai por último, depois do destino', () => {
    const { parameterValues } = diagnosticRequest('Device', 'ping', ' 8.8.8.8 ', { count: 3 });
    assert.deepEqual(parameterValues.at(-1), ['Device.IP.Diagnostics.IPPing.DiagnosticsState', 'Requested', 'xsd:string']);
    assert.deepEqual(parameterValues[0], ['Device.IP.Diagnostics.IPPing.Host', '8.8.8.8', 'xsd:string']);
    assert.ok(parameterValues.some(([path, value]) => path.endsWith('.NumberOfRepetitions') && value === 3));
  });

  it('lê os saltos do traceroute na ordem numérica, com os nomes de cada modelo', () => {
    const saltos = (campos) => ({
      2: { [campos[0]]: node('b.net'), [campos[1]]: node('10.0.0.2'), [campos[2]]: node(0), [campos[3]]: node('5,6,7') },
      10: { [campos[0]]: node('j.net'), [campos[1]]: node('10.0.0.10'), [campos[2]]: node(11), [campos[3]]: node('') },
      1: { [campos[0]]: node('a.net'), [campos[1]]: node('10.0.0.1'), [campos[2]]: node(0), [campos[3]]: node('1, 2,3') }
    });
    const tr098 = readDiagnosticResult({
      InternetGatewayDevice: {
        TraceRouteDiagnostics: {
          DiagnosticsState: node('Complete'),
          ResponseTime: node(33),
          RouteHops: saltos(['HopHost', 'HopHostAddress', 'HopErrorCode', 'HopRTTimes'])
        }
      }
    }, 'InternetGatewayDevice', 'traceroute');
    const tr181 = readDiagnosticResult({
      Device: {
        IP: {
          Diagnostics: {
            TraceRoute: {
              DiagnosticsState: node('Complete'),
              ResponseTime: node(33),
              RouteHops: saltos(['Host', 'HostAddress', 'ErrorCode', 'RTTimes'])
            }
          }
        }
      }
    }, 'Device', 'traceroute');
    for (const result of [tr098, tr181]) {
      assert.equal(result.state, 'complete');
      assert.equal(result.responseTime, 33);
      assert.deepEqual(result.hops.map((hop) => hop.hop), [1, 2, 10]);
      assert.deepEqual(result.hops[0].times, [1, 2, 3]);
      assert.equal(result.hops[0].host, 'a.net');
      assert.equal(result.hops[2].error, 11);
      assert.equal(result.hops[1].error, null);
    }
  });

  it('o erro da ONT é resposta, com o código inteiro', () => {
    const result = readDiagnosticResult({
      InternetGatewayDevice: { IPPingDiagnostics: { DiagnosticsState: node('Error_CannotResolveHostName') } }
    }, 'InternetGatewayDevice', 'ping');
    assert.equal(result.state, 'error');
    assert.equal(result.error, 'Error_CannotResolveHostName');
    assert.equal(result.ping, null);
  });

  it('nunca rodou é "nada ainda", não erro', () => {
    assert.equal(readDiagnosticResult({}, 'InternetGatewayDevice', 'ping').state, 'idle');
    assert.equal(readDiagnosticResult({
      InternetGatewayDevice: { IPPingDiagnostics: { DiagnosticsState: node('None') } }
    }, 'InternetGatewayDevice', 'ping').state, 'idle');
  });
});

describe('pedir o diagnóstico', () => {
  it('uma ONT TR-098 recebe os caminhos TR-098, e só eles, com linha na trilha', async () => {
    const antes = (await linhas()).length;
    const { status, body } = await post('/api/devices/diagnostics', { deviceId: TR098, kind: 'ping', host: ' 8.8.8.8 ' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.root, 'InternetGatewayDevice');
    assert.equal(body.data.queued, false);

    const paths = escritos(TR098);
    assert.ok(paths.includes('InternetGatewayDevice.IPPingDiagnostics.Host'), paths.join(', '));
    assert.equal(paths.at(-1), 'InternetGatewayDevice.IPPingDiagnostics.DiagnosticsState');
    assert.ok(paths.every((path) => path.startsWith('InternetGatewayDevice.')), paths.join(', '));

    const depois = await linhas();
    assert.equal(depois.length, antes + 1);
    assert.equal(depois.at(-1).subject_id, TR098);
    assert.deepEqual(JSON.parse(depois.at(-1).detail), { kind: 'ping', host: '8.8.8.8' });
  });

  it('uma ONT TR-181 recebe os caminhos TR-181', async () => {
    const { status } = await post('/api/devices/diagnostics', { deviceId: TR181, kind: 'traceroute', host: 'google.com' });
    assert.equal(status, 200);
    const paths = escritos(TR181);
    assert.ok(paths.includes('Device.IP.Diagnostics.TraceRoute.MaxHopCount'), paths.join(', '));
    assert.ok(paths.every((path) => path.startsWith('Device.')), paths.join(', '));
  });

  it('destino inválido: 400, nenhuma tarefa e nenhuma linha', async () => {
    const antes = (await linhas()).length;
    for (const host of ['http://google.com', '8.8.8.8:53', '10.0.0.300', '', undefined]) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post('/api/devices/diagnostics', { deviceId: TR098, kind: 'ping', host });
      assert.equal(status, 400, `aceitou ${JSON.stringify(host)}`);
      assert.equal(body.code, 'invalid_host');
    }
    assert.equal(genie.state.tasks.length, 0);
    assert.equal((await linhas()).length, antes);
  });

  it('tipo e repetições fora do lugar também são recusados', async () => {
    const tipo = await post('/api/devices/diagnostics', { deviceId: TR098, kind: 'nmap', host: '8.8.8.8' });
    assert.equal(tipo.status, 400);
    assert.equal(tipo.body.code, 'invalid_kind');
    for (const count of [0, 11, 2.5, 'dez']) {
      // eslint-disable-next-line no-await-in-loop -- uma tentativa por vez
      const { status, body } = await post('/api/devices/diagnostics', { deviceId: TR098, kind: 'ping', host: '8.8.8.8', count });
      assert.equal(status, 400, `aceitou ${count}`);
      assert.equal(body.code, 'invalid_count');
    }
    assert.equal(genie.state.tasks.length, 0);
  });

  it('com a ONT fora do ar o pedido fica na fila, e a resposta diz isso', async () => {
    genie.state.taskStatus = 202;
    const { status, body } = await post('/api/devices/diagnostics', { deviceId: TR098, kind: 'ping', host: '8.8.8.8' });
    assert.equal(status, 200);
    assert.equal(body.data.queued, true);
  });
});

describe('ler o resultado', () => {
  const pingRodando = () => {
    device(TR098).InternetGatewayDevice.IPPingDiagnostics = {
      Host: node('8.8.8.8'),
      DiagnosticsState: node('Requested')
    };
  };

  it('rodando: pede o objeto à ONT uma vez e devolve o que ela respondeu', async () => {
    pingRodando();
    genie.state.onTask = (entry) => {
      if (entry.task?.name !== 'refreshObject') return;
      Object.assign(device(TR098).InternetGatewayDevice.IPPingDiagnostics, {
        DiagnosticsState: node('Complete', '2026-09-24T12:01:00.000Z'),
        SuccessCount: node(4),
        FailureCount: node(0),
        AverageResponseTime: node(12),
        MinimumResponseTime: node(10),
        MaximumResponseTime: node(15)
      });
    };
    const { status, body } = await post('/api/devices/diagnostics/result', { deviceId: TR098, kind: 'ping' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.state, 'complete');
    assert.deepEqual(body.data.ping, { success: 4, failure: 0, average: 12, minimum: 10, maximum: 15 });
    assert.equal(body.data.measuredAt, '2026-09-24T12:01:00.000Z');
    assert.deepEqual(
      genie.state.tasks.map((entry) => [entry.task?.name, entry.task?.objectName]),
      [['refreshObject', 'InternetGatewayDevice.IPPingDiagnostics']]
    );
  });

  it('com tarefa esperando na fila, não empilha outra', async () => {
    pingRodando();
    // A ONT está fora do ar: o próprio pedido do diagnóstico ficou na fila.
    genie.state.taskStatus = 202;
    await post('/api/devices/diagnostics', { deviceId: TR098, kind: 'ping', host: '8.8.8.8' });
    const antes = genie.state.tasks.length;

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- consultas em sequência, como a tela faz
      const { status, body } = await post('/api/devices/diagnostics/result', { deviceId: TR098, kind: 'ping' });
      assert.equal(status, 200);
      assert.equal(body.data.state, 'running');
    }
    assert.equal(genie.state.tasks.length, antes, 'empilhou leituras numa ONT fora do ar');
  });

  it('terminado não pede nada à ONT', async () => {
    device(TR098).InternetGatewayDevice.IPPingDiagnostics = {
      DiagnosticsState: node('Complete'),
      SuccessCount: node(3),
      FailureCount: node(1)
    };
    const { body } = await post('/api/devices/diagnostics/result', { deviceId: TR098, kind: 'ping' });
    assert.equal(body.data.state, 'complete');
    assert.equal(body.data.ping.failure, 1);
    assert.equal(genie.state.tasks.length, 0);
  });

  it('aparelho que o ACS não conhece: 404', async () => {
    const { status } = await post('/api/devices/diagnostics/result', { deviceId: 'NAO-EXISTE', kind: 'ping' });
    assert.equal(status, 404);
  });
});
