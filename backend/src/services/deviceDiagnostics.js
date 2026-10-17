/**
 * Ping e traceroute que saem DA ONT.
 *
 * O plantão pergunta "o assinante chega ao mundo?" e a resposta útil é a da
 * própria ONT, do lado de lá da fibra — um ping do painel diz se o painel chega
 * nela, que é outra pergunta. O CWMP tem isso nos dois modelos de dados: o
 * painel grava o destino e `DiagnosticsState=Requested`, a ONT roda sozinha,
 * avisa que terminou, e o painel lê o resultado.
 *
 * Este módulo é só o que é PURO nisso: os caminhos de cada modelo, a conferência
 * do destino e a leitura do resultado. Quem fala com o ACS é `DeviceService`.
 *
 * A mesma conferência do destino está em `frontend/src/lib/device-diagnostics.ts`,
 * e o teste de lá importa ESTA e exige que as duas digam o mesmo.
 */

export const DIAGNOSTIC_KINDS = Object.freeze(['ping', 'traceroute']);

/** Onde mora cada diagnóstico, por raiz do modelo de dados. */
export const DIAGNOSTIC_OBJECTS = Object.freeze({
  InternetGatewayDevice: Object.freeze({
    ping: 'InternetGatewayDevice.IPPingDiagnostics',
    traceroute: 'InternetGatewayDevice.TraceRouteDiagnostics'
  }),
  Device: Object.freeze({
    ping: 'Device.IP.Diagnostics.IPPing',
    traceroute: 'Device.IP.Diagnostics.TraceRoute'
  })
});

/**
 * Os nomes de cada salto do traceroute. O TR-098 os prefixa com `Hop`, o
 * TR-181 não — é a única diferença de nome entre os dois que este painel lê.
 */
const HOP_FIELDS = Object.freeze({
  InternetGatewayDevice: { host: 'HopHost', address: 'HopHostAddress', error: 'HopErrorCode', times: 'HopRTTimes' },
  Device: { host: 'Host', address: 'HostAddress', error: 'ErrorCode', times: 'RTTimes' }
});

export const PING_COUNT_DEFAULT = 4;
export const PING_COUNT_MAX = 10;
export const TRACEROUTE_MAX_HOPS = 30;

/** Um traceroute longo não cabe na tela nem no documento do ACS. */
const HOP_LIMIT = 64;

/**
 * A raiz em que o diagnóstico é escrito, dadas as raízes que o documento tem.
 *
 * TR-098 quando ele está lá — quase toda ONT daqui fala TR-098, e uma que
 * tenha as duas árvores quase sempre só implementa os diagnósticos na antiga.
 * TR-181 só quando é a única. Sem nenhuma (documento que ainda não informou),
 * TR-098, como `readSummonShape` já faz ao falhar.
 */
export function diagnosticRoot(roots = []) {
  if (roots.includes('InternetGatewayDevice')) return 'InternetGatewayDevice';
  if (roots.includes('Device')) return 'Device';
  return 'InternetGatewayDevice';
}

function isIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIpv6(value) {
  if (!/^[0-9a-f:]+$/i.test(value) || value.length > 39) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const groups = (half) => (half === '' ? [] : half.split(':'));
  const cabecas = groups(halves[0]);
  const caudas = halves.length === 2 ? groups(halves[1]) : [];
  const todos = [...cabecas, ...caudas];
  if (!todos.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? todos.length <= 7 : todos.length === 8;
}

function isHostname(value) {
  if (value.length > 253) return false;
  // Só dígitos e pontos é um IPv4 ou nada: "10.0.0.300" não é um nome.
  if (/^[\d.]+$/.test(value)) return false;
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/**
 * O destino que a ONT vai pingar: um IPv4, um IPv6 ou um nome DNS, e nada mais.
 *
 * Sem esquema, porta, caminho ou espaço. O ping sai da ONT e não do painel —
 * não é uma porta para o painel buscar URLs —, mas o valor vai parar num
 * parâmetro da ONT do cliente e na trilha, e o que não é destino não entra.
 */
export function isValidDiagnosticHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (!value) return false;
  return isIpv4(value) || isIpv6(value) || isHostname(value);
}

/**
 * Os parâmetros do pedido, na ordem em que vão para a ONT.
 *
 * `DiagnosticsState` por último: é ele que dispara, e uma ONT que aplique os
 * valores na ordem recebida rodaria com o destino anterior se viesse antes.
 * Os prazos estão em milissegundos, que é a unidade dos dois modelos.
 */
export function diagnosticRequest(root, kind, host, { count = PING_COUNT_DEFAULT } = {}) {
  const object = DIAGNOSTIC_OBJECTS[root]?.[kind];
  if (!object) throw new Error(`Unknown diagnostic ${root}/${kind}`);
  const destino = String(host).trim();
  const parameterValues = kind === 'ping'
    ? [
        [`${object}.Host`, destino, 'xsd:string'],
        [`${object}.NumberOfRepetitions`, count, 'xsd:unsignedInt'],
        [`${object}.Timeout`, 2000, 'xsd:unsignedInt']
      ]
    : [
        [`${object}.Host`, destino, 'xsd:string'],
        [`${object}.NumberOfTries`, 3, 'xsd:unsignedInt'],
        [`${object}.Timeout`, 5000, 'xsd:unsignedInt'],
        [`${object}.MaxHopCount`, TRACEROUTE_MAX_HOPS, 'xsd:unsignedInt']
      ];
  parameterValues.push([`${object}.DiagnosticsState`, 'Requested', 'xsd:string']);
  return { object, parameterValues };
}

function nodeAt(row, path) {
  let node = row;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

function valueOf(node) {
  if (node && typeof node === 'object' && '_value' in node) return node._value;
  return node && typeof node === 'object' ? undefined : node;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Em que pé o diagnóstico está, lido do valor de `DiagnosticsState`.
 *
 * `Requested` é o que o painel gravou e o que a ONT reporta enquanto roda.
 * `None` ou nada é "nunca rodou aqui". Todo `Error_*` é uma resposta — a ONT
 * rodou e não conseguiu —, e o código vai inteiro para a tela.
 */
export function diagnosticState(value) {
  const texto = String(value ?? '').trim();
  if (!texto || /^none$/i.test(texto)) return 'idle';
  if (/^requested$/i.test(texto)) return 'running';
  if (/^complete/i.test(texto)) return 'complete';
  return 'error';
}

/**
 * O resultado, lido do documento que o ACS guarda da ONT.
 *
 * `measuredAt` é quando o ACS leu o estado pela última vez: com a ONT fora do
 * ar o pedido fica na fila, e o que o documento mostra até lá é o resultado da
 * vez ANTERIOR. A tela diz de quando é em vez de apresentá-lo como novo.
 */
export function readDiagnosticResult(row, root, kind) {
  const object = DIAGNOSTIC_OBJECTS[root]?.[kind];
  if (!object) throw new Error(`Unknown diagnostic ${root}/${kind}`);
  const read = (name) => valueOf(nodeAt(row, `${object}.${name}`));
  const stateNode = nodeAt(row, `${object}.DiagnosticsState`);
  const bruto = valueOf(stateNode);
  const state = diagnosticState(bruto);
  const result = {
    kind,
    root,
    state,
    error: state === 'error' ? String(bruto).trim().slice(0, 64) : null,
    host: read('Host') == null ? null : String(read('Host')).slice(0, 253),
    measuredAt: stateNode && typeof stateNode === 'object' && stateNode._timestamp ? stateNode._timestamp : null,
    ping: null,
    hops: null,
    responseTime: null
  };
  if (state !== 'complete') return result;

  if (kind === 'ping') {
    result.ping = {
      success: numberOrNull(read('SuccessCount')),
      failure: numberOrNull(read('FailureCount')),
      average: numberOrNull(read('AverageResponseTime')),
      minimum: numberOrNull(read('MinimumResponseTime')),
      maximum: numberOrNull(read('MaximumResponseTime'))
    };
    return result;
  }

  result.responseTime = numberOrNull(read('ResponseTime'));
  const campos = HOP_FIELDS[root];
  const saltos = nodeAt(row, `${object}.RouteHops`);
  result.hops = saltos && typeof saltos === 'object'
    ? Object.keys(saltos)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, HOP_LIMIT)
      .map((key) => {
        const salto = saltos[key];
        const times = String(valueOf(salto?.[campos.times]) ?? '')
          .split(',')
          .map((part) => numberOrNull(part.trim()))
          .filter((time) => time !== null);
        const erro = numberOrNull(valueOf(salto?.[campos.error]));
        return {
          hop: Number(key),
          host: String(valueOf(salto?.[campos.host]) ?? '').slice(0, 253) || null,
          address: String(valueOf(salto?.[campos.address]) ?? '').slice(0, 45) || null,
          times,
          error: erro && erro !== 0 ? erro : null
        };
      })
    : [];
  return result;
}
