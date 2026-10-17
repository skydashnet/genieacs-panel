import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Os dois arquivos que o painel serve para instalar o agente do GenieACS.
 *
 * Três afirmações, e a terceira é a que justifica o arquivo:
 *
 * 1. saem como arquivo — o tipo certo, `nosniff`, `no-cache` — e sem sessão;
 * 2. sem o arquivo no disco, 404 com código próprio, e não uma página que o
 *    instalador gravaria como programa;
 * 3. a origem que o instalador leva como padrão de PANEL_URL vem da
 *    configuração (`PUBLIC_BASE_URL` aqui, sem subdomínios) e NUNCA do `Host`:
 *    o instalador roda como root e manda a chave para esse endereço.
 *
 * O caso com subdomínios — ápice e host de provedor — está em
 * `genieacs-agent-files-subdomain.test.js`, porque o domínio-base é lido no
 * import e cada arquivo de teste é um processo.
 */

// Vazio e não apagado: o `dotenv` não sobrescreve variável que já existe, e um
// `PUBLIC_BASE_URL` no `.env` de quem desenvolve mudaria o que se afirma aqui.
process.env.PUBLIC_BASE_URL = '';

const {
  call, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const {
  AGENT_INSTALLER_PATH, AGENT_PROGRAM_PATH, injectPanelOrigin, safePanelOrigin,
  serveAgentInstaller, serveAgentProgram
} = await import('../src/routes/genieacsAgentFiles.js');
const { default: express } = await import('express');

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALADOR = fs.readFileSync(path.join(RAIZ, '..', 'deploy', 'install-agent.sh'), 'utf8');

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  process.env.PUBLIC_BASE_URL = '';
  await stopTestServers();
});

/** Um GET com o `Host` escolhido: o `fetch` troca esse cabeçalho em silêncio. */
function getComHost(host, url) {
  const alvo = new URL(url);
  return new Promise((resolve, reject) => {
    http.get({
      host: alvo.hostname, port: alvo.port, path: alvo.pathname, headers: { Host: host }
    }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolve({ status: res.statusCode, texto }));
    }).on('error', reject);
  });
}

const padraoDe = (script) => /^DEFAULT_PANEL_URL=(.*)$/m.exec(script)?.[1];

describe('o instalador servido', () => {
  it('sai como shell script, sem sessão, sem cache guardado às cegas', async () => {
    const r = await fetch(`${panelUrl}/api/genieacs-agent/install.sh`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/x-shellscript; charset=utf-8');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const corpo = await r.text();
    // Sem origem configurada, a linha fica vazia e o script pergunta.
    assert.equal(corpo, INSTALADOR);
    assert.equal(padraoDe(corpo), "''");
  });

  it('leva PUBLIC_BASE_URL como padrão, normalizado, e continua bash válido', async () => {
    process.env.PUBLIC_BASE_URL = 'https://painel.provedor.test/';
    const corpo = await (await fetch(`${panelUrl}/api/genieacs-agent/install.sh`)).text();
    assert.equal(padraoDe(corpo), "'https://painel.provedor.test'");
    // Só aquela linha mudou.
    assert.equal(corpo.replace(/^DEFAULT_PANEL_URL=.*$/m, "DEFAULT_PANEL_URL=''"), INSTALADOR);
    const arquivo = path.join(os.tmpdir(), `install-agent-${process.pid}.sh`);
    fs.writeFileSync(arquivo, corpo);
    try {
      execFileSync('/bin/bash', ['-n', arquivo]);
    } finally {
      fs.rmSync(arquivo, { force: true });
    }
  });

  it('nunca usa o Host da requisição', async () => {
    process.env.PUBLIC_BASE_URL = 'https://painel.provedor.test';
    const forjado = await getComHost('atacante.example', `${panelUrl}/api/genieacs-agent/install.sh`);
    assert.equal(forjado.status, 200);
    assert.equal(padraoDe(forjado.texto), "'https://painel.provedor.test'");
    assert.ok(!forjado.texto.includes('atacante.example'));

    // E sem configuração nenhuma, o Host forjado não vira padrão algum.
    process.env.PUBLIC_BASE_URL = '';
    const semConfig = await getComHost('atacante.example', `${panelUrl}/api/genieacs-agent/install.sh`);
    assert.equal(padraoDe(semConfig.texto), "''");
  });

  it('recusa uma origem configurada que fecharia as aspas do script', async () => {
    process.env.PUBLIC_BASE_URL = "https://painel.provedor.test/'$(id)'";
    const corpo = await (await fetch(`${panelUrl}/api/genieacs-agent/install.sh`)).text();
    assert.equal(padraoDe(corpo), "''");
    process.env.PUBLIC_BASE_URL = '';
  });
});

describe('a origem, como função', () => {
  it('aceita http(s) com host, porta e caminho; recusa o resto', () => {
    assert.equal(safePanelOrigin('https://alfa.painel.exemplo.com'), 'https://alfa.painel.exemplo.com');
    assert.equal(safePanelOrigin('http://10.0.0.5:5890/'), 'http://10.0.0.5:5890');
    assert.equal(safePanelOrigin('https://exemplo.com/painel/'), 'https://exemplo.com/painel');
    assert.equal(safePanelOrigin('http://[::1]:5890'), 'http://[::1]:5890');
    for (const ruim of [
      null, '', 'ftp://exemplo.com', 'https://quem:senha@exemplo.com', 'https://exemplo.com/?a=1',
      'https://exemplo.com/#x', "https://exemplo.com/'", 'https://exemplo.com/$(id)', 'não é url'
    ]) {
      assert.equal(safePanelOrigin(ruim), null, String(ruim));
    }
  });

  it('só troca a linha exata, e deixa o script intocado sem origem', () => {
    assert.equal(injectPanelOrigin(INSTALADOR, null), INSTALADOR);
    assert.equal(injectPanelOrigin(INSTALADOR, "https://x.test/'"), INSTALADOR);
    const comOrigem = injectPanelOrigin(INSTALADOR, 'https://x.test');
    assert.equal(comOrigem.split('\n').length, INSTALADOR.split('\n').length);
    assert.equal(padraoDe(comOrigem), "'https://x.test'");
  });
});

describe('o programa do agente servido', () => {
  it('sai como JavaScript quando o arquivo existe, e 404 limpo quando não', async () => {
    const r = await fetch(`${panelUrl}/api/genieacs-agent/agent.mjs`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    if (fs.existsSync(AGENT_PROGRAM_PATH)) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      assert.equal(await r.text(), fs.readFileSync(AGENT_PROGRAM_PATH, 'utf8'));
    } else {
      assert.equal(r.status, 404);
      assert.equal((await r.json()).code, 'agent_file_missing');
    }
  });
});

/**
 * Os dois ramos de cada rota, com arquivos escolhidos. A rota real lê um
 * caminho fixo, e o programa do agente chega num PR vizinho — sem isto o ramo
 * 200 do programa só seria provado depois da junção, e o 404 do instalador
 * nunca.
 */
describe('as rotas, sobre arquivos escolhidos', () => {
  let servidor;
  let url;
  let dir;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-agente-arquivos-'));
    fs.writeFileSync(path.join(dir, 'agente.mjs'), 'export const versao = "0.0.0";\n');
    fs.writeFileSync(path.join(dir, 'instalar.sh'), "#!/usr/bin/env bash\nDEFAULT_PANEL_URL=''\n");
    const app = express();
    app.get('/agent.mjs', serveAgentProgram(path.join(dir, 'agente.mjs')));
    app.get('/sem-agente.mjs', serveAgentProgram(path.join(dir, 'nao-existe.mjs')));
    app.get('/install.sh', serveAgentInstaller(path.join(dir, 'instalar.sh')));
    app.get('/sem-install.sh', serveAgentInstaller(path.join(dir, 'nao-existe.sh')));
    await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => servidor.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serve o que há no disco, com os cabeçalhos certos', async () => {
    const programa = await fetch(`${url}/agent.mjs`);
    assert.equal(programa.status, 200);
    assert.equal(programa.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await programa.text(), 'export const versao = "0.0.0";\n');

    const instalador = await fetch(`${url}/install.sh`);
    assert.equal(instalador.status, 200);
    assert.equal(instalador.headers.get('content-type'), 'text/x-shellscript; charset=utf-8');
  });

  it('responde 404 com código quando o arquivo falta — nas duas', async () => {
    for (const caminho of ['/sem-agente.mjs', '/sem-install.sh']) {
      const r = await call(`${url}${caminho}`);
      assert.equal(r.status, 404, caminho);
      assert.equal(r.body.code, 'agent_file_missing');
      assert.equal(r.body.success, false);
    }
  });
});

describe('os caminhos no disco', () => {
  it('o instalador é o de deploy/, e o programa o de backend/agent/', () => {
    assert.equal(AGENT_INSTALLER_PATH, path.join(RAIZ, '..', 'deploy', 'install-agent.sh'));
    assert.equal(AGENT_PROGRAM_PATH, path.join(RAIZ, 'agent', 'skygenpanel-agent.mjs'));
  });

  /**
   * A imagem não leva `deploy/` inteiro. A rota procura o instalador em
   * `<módulo>/../../../deploy`, que na imagem é `/app/deploy` — e é para lá que
   * o Dockerfile tem que copiá-lo, com a exceção no `.dockerignore` sem a qual
   * o COPY falha no build.
   */
  it('a imagem Docker leva o instalador para onde a rota o procura', () => {
    const dockerfile = fs.readFileSync(path.join(RAIZ, '..', 'Dockerfile'), 'utf8');
    const ignore = fs.readFileSync(path.join(RAIZ, '..', '.dockerignore'), 'utf8').split('\n');
    assert.match(dockerfile, /^WORKDIR \/app\/backend$/m);
    assert.match(dockerfile, /^COPY backend\/ \.\/$/m, 'backend/agent/ vai junto com backend/');
    assert.match(dockerfile, /^COPY deploy\/install-agent\.sh \/app\/deploy\/install-agent\.sh$/m);
    assert.equal(
      path.posix.join('/app/backend/src/routes', '..', '..', '..', 'deploy', 'install-agent.sh'),
      '/app/deploy/install-agent.sh'
    );
    const exclui = ignore.indexOf('deploy');
    const reinclui = ignore.indexOf('!deploy/install-agent.sh');
    assert.ok(exclui !== -1 && reinclui > exclui, 'a exceção tem que vir DEPOIS da exclusão');
    assert.ok(!ignore.includes('backend/agent'), 'o programa do agente não pode ficar fora da imagem');
  });
});

describe('o limitador', () => {
  // Por último no arquivo: ele gasta o balde deste endereço.
  it('corta quem baixa em laço', async () => {
    let ultimo = 0;
    for (let i = 0; i < 35; i += 1) {
      ultimo = (await fetch(`${panelUrl}/api/genieacs-agent/install.sh`)).status;
      if (ultimo === 429) break;
    }
    assert.equal(ultimo, 429);
  });
});
