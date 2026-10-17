import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AGENT_VERSION, MAX_RESPONSE_BYTES, resolveNbiUrl, startAgent } from '../agent/skygenpanel-agent.mjs';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

/**
 * O programa do agente (`agent/skygenpanel-agent.mjs`) contra um painel de
 * teste (servidor WebSocket do pacote `ws`) e o GenieACS falso.
 *
 * O que estes testes guardam é, antes de tudo, a recusa: o agente é o pé do
 * painel dentro da rede do provedor, e cada caso de `bad_request` abaixo confere
 * também que o GenieACS NÃO recebeu nada — recusar respondendo certo depois de
 * já ter feito a requisição seria recusa só no nome.
 */

const AGENT_FILE = fileURLToPath(new URL('../agent/skygenpanel-agent.mjs', import.meta.url));
const TOKEN = `sgpa_${'A'.repeat(20)}${'b'.repeat(23)}`;
const CONNECT_PATH = '/api/genieacs-agent/connect';
const FAST = { minMs: 20, maxMs: 200 };

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

function within(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`tempo esgotado: ${label}`)), ms); })
  ]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Um logger que guarda tudo o que o agente escreve, em qualquer nível. */
function captureLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') }, text: () => lines.join('\n') };
}

/**
 * O "painel": aceita o upgrade em CONNECT_PATH só com o Bearer certo (401
 * cru, como o painel de verdade, caso contrário) e entrega cada conexão como
 * um objeto com a fila de mensagens recebidas.
 */
async function startPanel({ token = TOKEN } = {}) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const panel = { upgrades: [], connections: [], rejectStatus: null, waiters: [] };

  server.on('upgrade', (req, socket, head) => {
    panel.upgrades.push({ url: req.url, authorization: req.headers.authorization });
    if (panel.rejectStatus) {
      socket.end(`HTTP/1.1 ${panel.rejectStatus} Recusado\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (req.url !== CONNECT_PATH || req.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = wrapConnection(ws);
      panel.connections.push(conn);
      for (const waiter of panel.waiters.splice(0)) waiter();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  panel.url = `http://127.0.0.1:${server.address().port}`;
  panel.connection = (index) => within(new Promise((resolve) => {
    const check = () => (panel.connections[index] ? resolve(panel.connections[index]) : panel.waiters.push(check));
    check();
  }), 5000, `conexão #${index}`);
  panel.close = async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };
  cleanups.push(panel.close);
  return panel;
}

function wrapConnection(ws) {
  const conn = { ws, messages: [], raw: [], waiters: [] };
  ws.on('message', (data, isBinary) => {
    const text = isBinary ? null : data.toString('utf8');
    conn.raw.push(text);
    let message = null;
    try { message = JSON.parse(text); } catch { message = null; }
    conn.messages.push(message);
    for (const waiter of [...conn.waiters]) waiter();
  });
  conn.next = (predicate, label = 'mensagem') => within(new Promise((resolve) => {
    const check = () => {
      const found = conn.messages.find((message) => message && predicate(message));
      if (found) {
        conn.waiters = conn.waiters.filter((waiter) => waiter !== check);
        resolve(found);
      }
    };
    conn.waiters.push(check);
    check();
  }), 10_000, label);
  conn.request = (request) => {
    ws.send(JSON.stringify({ type: 'request', headers: {}, body: null, timeoutMs: 5000, ...request }));
    return conn.next((message) => message.id === request.id && message.type !== 'hello', `resposta ${request.id}`);
  };
  return conn;
}

async function startStub(options) {
  const stub = await startGenieAcsStub(options);
  cleanups.push(stub.close);
  return stub;
}

function launch(panel, genieacsUrl, extra = {}) {
  const log = captureLogger();
  const agent = startAgent({ panelUrl: panel.url, token: TOKEN, genieacsUrl, logger: log.logger, backoff: FAST, ...extra });
  cleanups.push(() => agent.stop());
  return { agent, log };
}

const b64 = (value) => Buffer.from(value).toString('base64');
const fromB64 = (value) => Buffer.from(value, 'base64').toString('utf8');

describe('agente do GenieACS: conexão', () => {
  it('conecta com o Bearer da chave no caminho do contrato e manda hello com a versão', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    launch(panel, stub.url, { version: '9.9.9-teste' });
    const conn = await panel.connection(0);
    const hello = await conn.next((message) => message.type === 'hello', 'hello');
    assert.deepEqual(hello, { type: 'hello', version: '9.9.9-teste' });
    assert.equal(panel.upgrades[0].url, CONNECT_PATH);
    assert.equal(panel.upgrades[0].authorization, `Bearer ${TOKEN}`);
    assert.match(AGENT_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('reconecta sozinho quando o painel cai, e depois de 4002', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { log } = launch(panel, stub.url);
    const first = await panel.connection(0);
    await first.next((message) => message.type === 'hello');
    first.ws.terminate();
    const second = await panel.connection(1);
    await second.next((message) => message.type === 'hello');
    second.ws.close(4002, 'substituida');
    const third = await panel.connection(2);
    await third.next((message) => message.type === 'hello');
    assert.match(log.text(), /desconectado do painel \(código 1006/);
    assert.match(log.text(), /substituída por outra/);
    // E a conexão nova funciona.
    const reply = await third.request({ id: 'depois', method: 'GET', path: '/devices/' });
    assert.equal(reply.type, 'response');
    assert.equal(reply.status, 200);
  });

  it('painel em silêncio (conexão meio aberta): o agente desiste dela e reconecta', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { log } = launch(panel, stub.url, { silenceLimitMs: 150 });
    const first = await panel.connection(0);
    await first.next((message) => message.type === 'hello');
    // O painel não manda nada — nem o batimento. O socket continua "aberto".
    const second = await panel.connection(1);
    await second.next((message) => message.type === 'hello');
    assert.match(log.text(), /em silêncio há \d+ s; reconectando/);
  });

  it('com o batimento do painel chegando, a conexão fica', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { log } = launch(panel, stub.url, { silenceLimitMs: 150 });
    const first = await panel.connection(0);
    await first.next((message) => message.type === 'hello');
    const batimento = setInterval(() => first.ws.send('{"type":"ping"}'), 40);
    try {
      await sleep(600);
    } finally {
      clearInterval(batimento);
    }
    assert.equal(panel.connections.length, 1, 'reconectou com o painel falando');
    assert.doesNotMatch(log.text(), /silêncio/);
  });

  it('4001 (chave revogada): registra e espera o máximo, sem martelar o painel', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { agent, log } = launch(panel, stub.url, { backoff: { minMs: 20, maxMs: 30_000 } });
    const conn = await panel.connection(0);
    await conn.next((message) => message.type === 'hello');
    conn.ws.close(4001, 'token trocado');
    await within((async () => { while (!/reconectando em/.test(log.text())) await sleep(10); })(), 3000, 'log de reconexão');
    await sleep(400);
    assert.equal(panel.connections.length, 1, 'com espera mínima de 20 ms ele já teria voltado');
    assert.match(log.text(), /chave revogada/);
    const [, seconds] = log.text().match(/reconectando em ([\d.]+) s/);
    assert.ok(Number(seconds) >= 24 && Number(seconds) <= 36, `espera de ${seconds} s não é a máxima (30 s ±20%)`);
    // E `stop()` não fica preso ao temporizador de 30 s.
    await within(agent.stop(), 3000, 'stop');
  });

  it('401 no upgrade é chave recusada (espera máxima); 503 é painel fora do ar (espera curta)', async () => {
    const recusa = await startPanel({ token: 'sgpa_outra-chave' });
    const stub = await startStub();
    const recusado = launch(recusa, stub.url, { backoff: { minMs: 20, maxMs: 30_000 } });
    await within((async () => { while (!/reconectando em/.test(recusado.log.text())) await sleep(10); })(), 5000, 'log 401');
    await sleep(400);
    assert.match(recusado.log.text(), /chave recusada pelo painel \(HTTP 401\)/);
    const [, seconds] = recusado.log.text().match(/reconectando em ([\d.]+) s/);
    assert.ok(Number(seconds) >= 24, `espera de ${seconds} s depois de um 401`);
    // A tentativa do WebSocket e a sondagem que lê o status; nenhuma outra.
    assert.equal(recusa.upgrades.length, 2);
    await recusado.agent.stop();

    const fora = await startPanel();
    fora.rejectStatus = 503;
    const foraDoAr = launch(fora, stub.url);
    await within((async () => { while (fora.upgrades.length < 6) await sleep(10); })(), 5000, 'novas tentativas depois de 503');
    assert.match(foraDoAr.log.text(), /recusou a conexão \(HTTP 503\)/);
    assert.doesNotMatch(foraDoAr.log.text(), /chave recusada/);
    // O painel volta: o agente conecta sem ninguém reiniciar nada.
    fora.rejectStatus = null;
    const conn = await fora.connection(0);
    await conn.next((message) => message.type === 'hello');
  });

  it('painel inalcançável: registra e continua tentando', async () => {
    const livre = http.createServer();
    await new Promise((resolve) => livre.listen(0, '127.0.0.1', resolve));
    const port = livre.address().port;
    await new Promise((resolve) => livre.close(resolve));
    const stub = await startStub();
    const { log } = launch({ url: `http://127.0.0.1:${port}` }, stub.url);
    await within((async () => { while ((log.text().match(/painel inalcançável/g) || []).length < 2) await sleep(10); })(), 5000, 'tentativas');
    assert.match(log.text(), /painel inalcançável \(ECONNREFUSED\)/);
  });
});

describe('agente do GenieACS: pedidos à NBI', () => {
  it('GET com query: credencial repassada, cabeçalhos filtrados, resposta íntegra', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const device = buildDevice({ id: 'ZTEG-SERIAL-1' });
    let seen = null;
    stub.state.respond = ({ req, url, res }) => {
      seen = { headers: req.headers, path: url.pathname, query: url.searchParams.get('query') };
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Total-Count': '1', 'Set-Cookie': 'sessao=1' });
      res.end(JSON.stringify([device]));
    };
    launch(panel, stub.url);
    const conn = await panel.connection(0);
    const query = JSON.stringify({ _id: 'ZTEG-SERIAL-1' });
    const reply = await conn.request({
      id: 'g1',
      method: 'GET',
      path: `/devices/?query=${encodeURIComponent(query)}`,
      headers: {
        Authorization: 'Basic bmJpOnNlZ3JlZG8=',
        Accept: 'application/json',
        Cookie: 'painel=1',
        Host: 'outro.exemplo',
        'X-Forwarded-For': '10.0.0.1',
        Connection: 'close'
      }
    });

    assert.equal(stub.state.requests.length, 1);
    assert.equal(seen.path, '/devices/');
    assert.equal(seen.query, query);
    assert.equal(seen.headers.authorization, 'Basic bmJpOnNlZ3JlZG8=');
    assert.equal(seen.headers.accept, 'application/json');
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers['x-forwarded-for'], undefined);
    assert.equal(seen.headers.host, new URL(stub.url).host);

    assert.equal(reply.type, 'response');
    assert.equal(reply.id, 'g1');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'application/json');
    assert.equal(reply.headers['x-total-count'], '1');
    for (const dropped of ['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']) {
      assert.equal(reply.headers[dropped], undefined, dropped);
    }
    assert.deepEqual(JSON.parse(fromB64(reply.body)), [device]);
  });

  it('POST com corpo chega íntegro (UTF-8 e tudo); DELETE também passa', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    launch(panel, stub.url);
    const conn = await panel.connection(0);
    const task = { name: 'setParameterValues', parameterValues: [['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', 'Café da Vó ☕', 'xsd:string']] };
    const reply = await conn.request({
      id: 'p1',
      method: 'POST',
      path: '/devices/ZTEG%2D1/tasks?connection_request',
      headers: { 'Content-Type': 'application/json' },
      body: b64(JSON.stringify(task))
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(stub.state.tasks[0].task, task);
    assert.equal(stub.state.tasks[0].deviceId, 'ZTEG-1');
    assert.deepEqual(JSON.parse(fromB64(reply.body)), task);

    const removed = await conn.request({ id: 'd1', method: 'DELETE', path: '/devices/ZTEG-1/tags/cliente%20vip' });
    assert.equal(removed.status, 200);
    assert.deepEqual(stub.state.tags, [{ deviceId: 'ZTEG-1', tag: 'cliente vip', method: 'DELETE' }]);
  });

  it('PUT de arquivo: bytes íntegros e os quatro metadados da NBI repassados (1.1.0)', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    launch(panel, stub.url);
    const conn = await panel.connection(0);
    // Bytes que não são UTF-8 válido: passar por string os corromperia.
    const firmware = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x0a]);
    const reply = await conn.request({
      id: 'f1',
      method: 'PUT',
      path: '/files/alfa--F670L_V2.bin',
      headers: {
        Authorization: 'Basic bmJpOnNlZ3JlZG8=',
        'Content-Type': 'application/octet-stream',
        fileType: '1 Firmware Upgrade Image',
        oui: 'ZTEOUI',
        productClass: 'F670L',
        version: 'V2.0',
        Cookie: 'painel=1'
      },
      body: firmware.toString('base64')
    });
    assert.equal(reply.status, 201);
    const [upload] = stub.state.uploads;
    assert.equal(upload.id, 'alfa--F670L_V2.bin');
    assert.ok(upload.bytes.equals(firmware), 'os bytes chegaram diferentes');
    assert.equal(upload.headers.filetype, '1 Firmware Upgrade Image');
    assert.equal(upload.headers.oui, 'ZTEOUI');
    assert.equal(upload.headers.productclass, 'F670L');
    assert.equal(upload.headers.version, 'V2.0');
    assert.equal(upload.headers.cookie, undefined);
    assert.deepEqual(stub.state.files[0].metadata, {
      fileType: '1 Firmware Upgrade Image', oui: 'ZTEOUI', productClass: 'F670L', version: 'V2.0'
    });
  });

  it('3xx do GenieACS volta como está: o agente não segue redirecionamento', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    let alvo = 0;
    const outro = http.createServer((req, res) => { alvo += 1; res.end('interno'); });
    await new Promise((resolve) => outro.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => outro.close(resolve)));
    stub.state.respond = ({ res }) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${outro.address().port}/admin` });
      res.end();
    };
    launch(panel, stub.url);
    const conn = await panel.connection(0);
    const reply = await conn.request({ id: 'r1', method: 'GET', path: '/devices/' });
    assert.equal(reply.status, 302);
    assert.equal(alvo, 0);
  });

  const recusados = [
    ['../ sem barra inicial', { method: 'GET', path: '../devices' }],
    ['/../', { method: 'GET', path: '/../devices' }],
    ['.. no meio', { method: 'GET', path: '/devices/../x' }],
    ['%2e%2e', { method: 'GET', path: '/devices/%2e%2e/x' }],
    ['%2E.', { method: 'GET', path: '/devices/%2E./x' }],
    ['.%2e', { method: 'GET', path: '/devices/.%2e/x' }],
    ['%252e%252e (dupla)', { method: 'GET', path: '/devices/%252e%252e/x' }],
    ['..%2f escondido', { method: 'GET', path: '/devices/a%2f..%2fb' }],
    ['//host', { method: 'GET', path: '//evil.example/x' }],
    ['http://', { method: 'GET', path: 'http://evil.example/' }],
    ['\\\\x', { method: 'GET', path: '\\\\x' }],
    ['/\\host', { method: 'GET', path: '/\\evil.example/x' }],
    ['controle', { method: 'GET', path: '/devices/\u0000x' }],
    ['tab', { method: 'GET', path: '/devi\tces/' }],
    ['escape inválido', { method: 'GET', path: '/devices/%zz' }],
    ['sem caminho', { method: 'GET' }],
    ['caminho número', { method: 'GET', path: 42 }],
    ['PATCH', { method: 'PATCH', path: '/devices/' }],
    ['CONNECT', { method: 'CONNECT', path: '/devices/' }],
    ['HEAD', { method: 'HEAD', path: '/devices/' }],
    ['get minúsculo', { method: 'get', path: '/devices/' }],
    ['GET com corpo', { method: 'GET', path: '/devices/', body: b64('x') }],
    ['corpo não base64', { method: 'POST', path: '/devices/', body: 'não é base64!' }],
    ['cabeçalhos em lista', { method: 'GET', path: '/devices/', headers: [['authorization', 'x']] }],
    ['CRLF no cabeçalho', { method: 'GET', path: '/devices/', headers: { authorization: 'Basic x\r\nX-Injetado: 1' } }],
    ['prazo negativo', { method: 'GET', path: '/devices/', timeoutMs: -1 }]
  ];

  it('recusa com bad_request o que não é NBI, sem tocar o GenieACS', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { agent, log } = launch(panel, stub.url);
    const conn = await panel.connection(0);
    for (const [label, request] of recusados) {
      const reply = await conn.request({ id: `x-${label}`, headers: {}, ...request });
      assert.equal(reply.type, 'error', label);
      assert.equal(reply.code, 'bad_request', `${label}: ${JSON.stringify(reply)}`);
    }
    assert.equal(stub.state.requests.length, 0, JSON.stringify(stub.state.requests));
    // Recusar não derruba nada: o pedido seguinte passa.
    const ok = await conn.request({ id: 'ok', method: 'GET', path: '/devices/' });
    assert.equal(ok.status, 200);
    await agent.stop();
    assert.match(log.text(), new RegExp(`${recusados.length} recusado`));
  });

  it('a mesma origem é a última barreira, mesmo sem as outras', () => {
    const origin = 'http://127.0.0.1:7557';
    assert.equal(resolveNbiUrl('/devices/?query=%7B%7D', origin).href, `${origin}/devices/?query=%7B%7D`);
    assert.equal(resolveNbiUrl('/devices/ZTEG%25252e/tasks', origin).pathname, '/devices/ZTEG%25252e/tasks');
    assert.throws(() => resolveNbiUrl('/devices/%2e%2E/x', origin));
    assert.throws(() => resolveNbiUrl('//127.0.0.2:7557/x', origin));
  });

  it('mensagem malformada é ignorada e contada; o agente segue atendendo', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { agent, log } = launch(panel, stub.url);
    const conn = await panel.connection(0);
    await conn.next((message) => message.type === 'hello');
    conn.ws.send('isto não é json');
    conn.ws.send(JSON.stringify({ type: 'request', method: 'GET', path: '/devices/' })); // sem id
    conn.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    conn.ws.send(JSON.stringify({ type: 'coisa-nova-do-futuro' }));
    const ok = await conn.request({ id: 'ok', method: 'GET', path: '/devices/' });
    assert.equal(ok.status, 200);
    assert.equal(conn.messages.filter((message) => message?.type !== 'hello').length, 1);
    await agent.stop();
    assert.match(log.text(), /3 mensagem\(ns\) malformada/);
    assert.match(log.text(), /1 mensagem\(ns\) de tipo desconhecido/);
  });

  it('GenieACS local fora do ar → upstream_unreachable', async () => {
    const panel = await startPanel();
    const livre = http.createServer();
    await new Promise((resolve) => livre.listen(0, '127.0.0.1', resolve));
    const port = livre.address().port;
    await new Promise((resolve) => livre.close(resolve));
    launch(panel, `http://127.0.0.1:${port}`);
    const conn = await panel.connection(0);
    const reply = await conn.request({ id: 'u1', method: 'GET', path: '/devices/' });
    assert.equal(reply.type, 'error');
    assert.equal(reply.code, 'upstream_unreachable');
  });

  it('GenieACS lento → timeout no prazo do pedido', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    stub.state.respond = () => { /* nunca responde */ };
    launch(panel, stub.url);
    const conn = await panel.connection(0);
    const started = Date.now();
    const reply = await conn.request({ id: 't1', method: 'GET', path: '/devices/', timeoutMs: 200 });
    assert.equal(reply.code, 'timeout');
    assert.ok(Date.now() - started < 3000);
  });

  it('pedidos simultâneos: ids cruzados, no máximo 8 ao mesmo tempo no GenieACS', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    let inFlight = 0;
    let peak = 0;
    stub.state.respond = ({ url, res }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const n = url.searchParams.get('n');
      // Os primeiros demoram mais: as respostas saem fora de ordem.
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ n }));
      }, 120 - Number(n) * 4);
    };
    launch(panel, stub.url);
    const conn = await panel.connection(0);
    const replies = await Promise.all(Array.from({ length: 20 }, (_, n) =>
      conn.request({ id: `c${n}`, method: 'GET', path: `/devices/?n=${n}` })));
    replies.forEach((reply, n) => {
      assert.equal(reply.id, `c${n}`);
      assert.deepEqual(JSON.parse(fromB64(reply.body)), { n: String(n) });
    });
    assert.equal(peak, 8);
  });

  it('corpo acima de 48 MiB → too_large, lendo em streaming e abortando ao passar', async () => {
    const panel = await startPanel();
    let written = 0;
    let declaredWritten = 0;
    const big = http.createServer((req, res) => {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      if (req.url.startsWith('/declarado')) {
        // Declara 1 GiB e manda devagar: o agente tem que recusar pelo cabeçalho.
        res.writeHead(200, { 'Content-Length': String(1024 ** 3) });
        const tick = setInterval(() => { declaredWritten += chunk.length; res.write(chunk); }, 50);
        res.on('close', () => clearInterval(tick));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // chunked, sem tamanho
      let closed = false;
      res.on('close', () => { closed = true; });
      const pump = () => {
        while (!closed && written < 512 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        if (!closed) res.end();
        return undefined;
      };
      pump();
    });
    await new Promise((resolve) => big.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { big.closeAllConnections(); return new Promise((resolve) => big.close(resolve)); });
    const genieacsUrl = `http://127.0.0.1:${big.address().port}`;

    launch(panel, genieacsUrl);
    const conn = await panel.connection(0);
    const rssBefore = process.memoryUsage().rss;
    const reply = await conn.request({ id: 'big', method: 'GET', path: '/files/firmware.bin', timeoutMs: 60_000 });
    assert.equal(reply.code, 'too_large');
    // Parou logo depois do teto — não leu os 512 MiB que o servidor tinha.
    await sleep(100);
    assert.ok(written < MAX_RESPONSE_BYTES + 64 * 1024 * 1024, `o servidor chegou a escrever ${written} bytes`);
    assert.ok(process.memoryUsage().rss - rssBefore < 256 * 1024 * 1024, 'a memória cresceu como se tivesse lido tudo');

    const declared = await conn.request({ id: 'decl', method: 'GET', path: '/declarado', timeoutMs: 60_000 });
    assert.equal(declared.code, 'too_large');
    assert.ok(declaredWritten <= 2 * 1024 * 1024, `leu ${declaredWritten} bytes de um corpo declarado grande demais`);
  });
});

describe('agente do GenieACS: log', () => {
  it('nunca escreve o token, credencial, corpo nem a query do caminho', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    stub.state.respond = ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ segredo: 'RESPOSTA-SECRETA' }));
    };
    const { agent, log } = launch(panel, stub.url);
    const conn = await panel.connection(0);
    const query = encodeURIComponent(JSON.stringify({ _id: 'ZTEG-SERIAL-SECRETO' }));
    await conn.request({ id: 'l1', method: 'GET', path: `/devices/?query=${query}`, headers: { Authorization: 'Basic Q1JFREVOQ0lBTA==' } });
    await conn.request({ id: 'l2', method: 'POST', path: '/devices/ZTEG-SERIAL-SECRETO/tasks', headers: { 'Content-Type': 'application/json' }, body: b64('{"x":"CORPO-SECRETO"}') });
    await conn.request({ id: 'l3', method: 'GET', path: '/devices/%2e%2e/ZTEG-SERIAL-SECRETO' });
    conn.ws.close(4001, 'token trocado');
    await within((async () => { while (!/chave revogada/.test(log.text())) await sleep(10); })(), 3000, 'fechamento');
    await agent.stop();

    const text = log.text();
    for (const segredo of [TOKEN, TOKEN.slice(5), 'Q1JFREVOQ0lBTA', 'CORPO-SECRETO', 'RESPOSTA-SECRETA', 'SERIAL-SECRETO', 'query=', '%7B']) {
      assert.ok(!text.includes(segredo), `o log contém ${segredo}:\n${text}`);
    }
    // E o resumo existe, dizendo só o que pode dizer: método e primeiro
    // segmento (sem isto, a conferência acima passaria com um log vazio).
    assert.match(text, /GET \/devices ×1/);
    assert.match(text, /POST \/devices ×1/);
    assert.match(text, /1 recusado/);
  });
});

describe('agente do GenieACS: partida', () => {
  it('recusa configuração perigosa e avisa sobre http:// fora da rede local', () => {
    const base = { panelUrl: 'https://painel.exemplo', token: TOKEN, genieacsUrl: 'http://127.0.0.1:7557', WebSocketImpl: class { addEventListener() {} } };
    const quiet = { info() {}, warn() {}, error() {} };
    assert.throws(() => startAgent({ ...base, panelUrl: 'ftp://painel.exemplo', logger: quiet }), /PANEL_URL/);
    assert.throws(() => startAgent({ ...base, panelUrl: 'https://u:s@painel.exemplo', logger: quiet }), /usuário ou senha/);
    assert.throws(() => startAgent({ ...base, genieacsUrl: 'file:///etc/passwd', logger: quiet }), /GENIEACS_URL/);
    assert.throws(() => startAgent({ ...base, genieacsUrl: 'http://admin:admin@127.0.0.1:7557', logger: quiet }), /GENIEACS_URL não pode/);
    assert.throws(() => startAgent({ ...base, token: '  ', logger: quiet }), /AGENT_TOKEN/);
    assert.throws(() => startAgent({ ...base, token: 'sgpa_a b', logger: quiet }), /AGENT_TOKEN/);

    for (const [panelUrl, warns] of [['http://painel.exemplo', true], ['http://192.168.0.10:3000', false], ['http://localhost:3000', false], ['https://painel.exemplo', false]]) {
      const log = captureLogger();
      const agent = startAgent({ ...base, panelUrl, logger: log.logger, genieacsUrl: 'http://10.0.0.5:7557/nbi' });
      agent.stop();
      assert.equal(/sem criptografia/.test(log.text()), warns, panelUrl);
      assert.match(log.text(), /só a origem \(http:\/\/10\.0\.0\.5:7557\)/);
      assert.ok(!log.text().includes(TOKEN));
    }
  });

  /** O arquivo do agente como programa, com só o ambiente dado. `exited` resolve com código e saída. */
  function run(env, args = []) {
    const child = spawn(process.execPath, [AGENT_FILE, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cleanups.push(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { out += data; });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
    return { child, exited: within(exited, 10_000, 'saída do processo') };
  }

  it('como programa: variável faltando sai com 2; argumento de linha de comando é ignorado sem ecoar', async () => {
    const faltando = await run({ PANEL_URL: 'https://painel.exemplo' }, ['--token', 'sgpa_NAO_ECOAR']).exited;
    assert.equal(faltando.code, 2);
    assert.match(faltando.out, /faltando no ambiente: AGENT_TOKEN, GENIEACS_URL/);
    assert.match(faltando.out, /2 argumento\(s\) de linha de comando ignorado/);
    assert.ok(!faltando.out.includes('sgpa_NAO_ECOAR'));

    const invalida = await run({ PANEL_URL: 'ftp://x', AGENT_TOKEN: TOKEN, GENIEACS_URL: 'http://127.0.0.1:7557' }).exited;
    assert.equal(invalida.code, 2);
    assert.match(invalida.out, /PANEL_URL precisa usar http/);
  });

  it('como programa: conecta pelo ambiente e sai com 0 no SIGTERM', async () => {
    const panel = await startPanel();
    const stub = await startStub();
    const { child, exited } = run({ PANEL_URL: panel.url, AGENT_TOKEN: TOKEN, GENIEACS_URL: stub.url });
    const conn = await panel.connection(0);
    await conn.next((message) => message.type === 'hello');
    const closed = new Promise((resolve) => conn.ws.on('close', (code) => resolve(code)));
    child.kill('SIGTERM');
    const { code, out } = await exited;
    assert.equal(code, 0);
    assert.equal(await within(closed, 2000, 'fechamento'), 1000, 'fecha a conexão direito ao sair');
    assert.match(out, /SIGTERM recebido/);
    assert.ok(!out.includes(TOKEN));
  });
});
