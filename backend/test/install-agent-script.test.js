import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O instalador do agente do GenieACS, e a regra em volta da qual ele foi
 * escrito: **a chave nunca passa pelo argv de processo nenhum.**
 *
 * Argv é público na máquina — `ps`, `/proc/<pid>/cmdline` — para qualquer
 * usuário local, durante toda a vida do processo. Uma chave que passe por ali
 * uma vez (um `curl -H "Authorization: Bearer $AGENT_TOKEN"` para "testar a
 * chave", um `sed` para gravá-la no arquivo) está exposta, e nada na saída do
 * script denuncia.
 *
 * Duas provas, porque cada uma cobre o ponto cego da outra:
 *
 * 1. **Rodando.** O script roda de verdade, com um PATH onde TODO executável é
 *    um invólucro que anota o próprio argv num arquivo e depois chama o
 *    verdadeiro (ou, para os que mexem no sistema — `systemctl`, `useradd`,
 *    `curl` —, finge). A chave não pode aparecer nessa anotação, nem na saída.
 *    Isto pega qualquer comando externo, inclusive um que ainda não existe no
 *    script. O que não pega é o caminho que o teste não percorre (o `read -s`
 *    do terminal, por exemplo).
 * 2. **Lendo.** Toda linha que expande a chave tem que ser de um embutido do
 *    bash (`printf`, `[[`, `[`) ou de uma função do próprio script — e cada
 *    linha é conferida, percorrida ou não.
 *
 * Nada aqui é root nem mexe no sistema: as funções que exigem root, systemd e
 * pacotes são trocadas depois do `source`, e os caminhos (`/etc`, `/opt`)
 * apontam para um diretório temporário.
 */

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, '..', 'deploy', 'install-agent.sh');
const fonte = fs.readFileSync(SCRIPT, 'utf8');

/** Uma chave no formato real: `sgpa_` + 32 bytes em base64url. */
const CHAVE = `sgpa_${crypto.randomBytes(32).toString('base64url')}`;
const OUTRA_CHAVE = `sgpa_${crypto.randomBytes(32).toString('base64url')}`;

let base;
let stubs;
let registro;
let raiz;

/**
 * O invólucro. Um arquivo só, com um link para ele com o nome de cada
 * executável do PATH real: o nome com que foi chamado (`$0`) diz quem ele é.
 */
const INVOLUCRO = `#!/bin/bash
nome="\${0##*/}"
printf '%s\\n' "\$nome \$*" >>"\$STUB_LOG"
case "\$nome" in
  curl)
    saida=""
    anterior=""
    for arg in "\$@"; do
      [ "\$anterior" = "--output" ] && saida="\$arg"
      anterior="\$arg"
    done
    if [ -n "\$saida" ]; then
      printf 'export const agente = true;\\n' >"\$saida"
      exit 0
    fi
    for arg in "\$@"; do
      [ "\$arg" = "--write-out" ] && { printf '200'; exit 0; }
    done
    exit 0
    ;;
  systemctl|useradd|userdel|chown|sleep|journalctl) exit 0 ;;
  id) [ "\${STUB_USER_EXISTS:-0}" = 1 ] && exit 0; exit 1 ;;
  install)
    modo=""; dir=0; args=()
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -d) dir=1 ;;
        -m) modo="\$2"; shift ;;
        -o|-g) shift ;;
        *) args+=("\$1") ;;
      esac
      shift
    done
    if [ "\$dir" = 1 ]; then
      for d in "\${args[@]}"; do
        /bin/mkdir -p "\$d"
        [ -n "\$modo" ] && /bin/chmod "\$modo" "\$d"
      done
    else
      /bin/cp "\${args[0]}" "\${args[1]}"
      [ -n "\$modo" ] && /bin/chmod "\$modo" "\${args[1]}"
    fi
    exit 0
    ;;
esac
IFS=: read -r -a dirs <<<"\$REAL_PATH"
for d in "\${dirs[@]}"; do
  [ -x "\$d/\$nome" ] && [ ! -d "\$d/\$nome" ] && exec "\$d/\$nome" "\$@"
done
printf 'invólucro: %s não existe no PATH real\\n' "\$nome" >&2
exit 127
`;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-agente-'));
  stubs = path.join(base, 'bin');
  registro = path.join(base, 'argv.log');
  fs.mkdirSync(stubs);
  const involucro = path.join(base, 'involucro');
  fs.writeFileSync(involucro, INVOLUCRO, { mode: 0o755 });

  // Todo executável do PATH real vira um link para o invólucro. Um comando que
  // o script passe a usar amanhã já está coberto; um que não exista em lugar
  // nenhum falha alto, como falharia na máquina do provedor.
  for (const dir of String(process.env.PATH).split(':').filter(Boolean)) {
    let nomes = [];
    try { nomes = fs.readdirSync(dir); } catch { continue; }
    for (const nome of nomes) {
      if (!/^[\w.+-]+$/.test(nome) || fs.existsSync(path.join(stubs, nome))) continue;
      fs.symlinkSync(involucro, path.join(stubs, nome));
    }
  }
  for (const nome of ['curl', 'node', 'systemctl', 'useradd', 'userdel', 'id', 'chown', 'install', 'sleep']) {
    if (!fs.existsSync(path.join(stubs, nome))) fs.symlinkSync(involucro, path.join(stubs, nome));
  }

  raiz = path.join(base, 'raiz');
  fs.mkdirSync(path.join(raiz, 'etc', 'systemd', 'system'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'opt'), { recursive: true });
  fs.mkdirSync(path.join(base, 'tmp'));
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const caminhos = () => ({
  envFile: path.join(raiz, 'etc', 'skygenpanel-agent.env'),
  unitFile: path.join(raiz, 'etc', 'systemd', 'system', 'skygenpanel-agent.service'),
  agentDir: path.join(raiz, 'opt', 'skygenpanel-agent'),
  agentFile: path.join(raiz, 'opt', 'skygenpanel-agent', 'skygenpanel-agent.mjs')
});

/**
 * Roda o script com as funções de sistema trocadas. O `source` com
 * `SKYGP_AGENT_SOURCE_ONLY=1` carrega as funções sem chamar `main`; a troca vem
 * depois, e `main` é chamada com os argumentos do teste.
 */
function rodar(args = [], env = {}, script = SCRIPT) {
  const c = caminhos();
  const programa = [
    'set -euo pipefail',
    'source "$1"; shift',
    `ENV_FILE='${c.envFile}'`,
    `UNIT_FILE='${c.unitFile}'`,
    `AGENT_DIR='${c.agentDir}'`,
    `AGENT_FILE='${c.agentFile}'`,
    'require_root() { :; }',
    'require_systemd() { :; }',
    'install_system_dependencies() { :; }',
    'install_node_runtime() { :; }',
    // Sem terminal: é o caminho de quem roda por automação, e o único que um
    // teste percorre sem travar esperando alguém digitar.
    'tty_available() { return 1; }',
    'main "$@"'
  ].join('\n');
  const r = spawnSync('/bin/bash', ['-c', programa, 'bash', script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: stubs,
      REAL_PATH: process.env.PATH,
      STUB_LOG: registro,
      TMPDIR: path.join(base, 'tmp'),
      SKYGP_AGENT_SOURCE_ONLY: '1',
      ...env
    }
  });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

function arquivoDeChave(conteudo, nome = 'chave') {
  const arquivo = path.join(base, nome);
  fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
  return arquivo;
}

const argvs = () => (fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8') : '');

describe('o instalador, rodando', () => {
  it('instala com a chave de AGENT_TOKEN_FILE, e ela não aparece em argv nem na saída', () => {
    const r = rodar([], {
      AGENT_TOKEN_FILE: arquivoDeChave(`${CHAVE}\r\n`),
      PANEL_URL: 'https://alfa.painel.exemplo.test/',
      GENIEACS_URL: 'http://127.0.0.1:7557'
    });
    assert.equal(r.status, 0, r.saida);

    const log = argvs();
    // O invólucro viu os comandos — senão a ausência da chave não provaria nada.
    assert.match(log, /^curl .*agent\.mjs/m, 'o agente devia ter sido baixado');
    assert.match(log, /^node --check /m, 'o agente devia ter sido conferido');
    assert.match(log, /^useradd --system --no-create-home .*skygenpanel-agent$/m);
    assert.match(log, /^systemctl restart skygenpanel-agent$/m);
    assert.ok(!log.includes(CHAVE), `a chave apareceu no argv de um comando:\n${log}`);
    assert.ok(!r.saida.includes(CHAVE), 'a chave apareceu na saída do instalador');
    // A dica — os quatro últimos caracteres — é a mesma que o painel mostra.
    assert.ok(r.saida.includes(`…${CHAVE.slice(-4)}`));
  });

  it('grava o ambiente como 0600, com as três variáveis', () => {
    const { envFile } = caminhos();
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const env = fs.readFileSync(envFile, 'utf8');
    assert.match(env, /^PANEL_URL=https:\/\/alfa\.painel\.exemplo\.test$/m, 'a barra do fim sai');
    assert.match(env, new RegExp(`^AGENT_TOKEN=${CHAVE}$`, 'm'), 'o \\r do arquivo da chave sai');
    assert.match(env, /^GENIEACS_URL=http:\/\/127\.0\.0\.1:7557$/m);
    // Nenhum temporário ficou para trás ao lado dele.
    const sobras = fs.readdirSync(path.dirname(envFile)).filter((n) => n.startsWith('.skygenpanel-agent.env'));
    assert.deepEqual(sobras, []);
  });

  it('põe o programa no lugar como 0644, e a unidade aponta para ele', () => {
    const { agentFile, unitFile, envFile } = caminhos();
    assert.equal(fs.statSync(agentFile).mode & 0o777, 0o644);
    const unidade = fs.readFileSync(unitFile, 'utf8');
    assert.match(unidade, new RegExp(`^ExecStart=/\\S+/node ${agentFile.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(unidade, new RegExp(`^EnvironmentFile=${envFile.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.ok(!unidade.includes(CHAVE), 'a chave não mora na unidade, que é 0644');
  });

  it('reexecutado sem chave nova, mantém a do arquivo', () => {
    fs.rmSync(registro, { force: true });
    const r = rodar([], { PANEL_URL: 'https://alfa.painel.exemplo.test' });
    assert.equal(r.status, 0, r.saida);
    const env = fs.readFileSync(caminhos().envFile, 'utf8');
    assert.match(env, new RegExp(`^AGENT_TOKEN=${CHAVE}$`, 'm'));
    // E o GenieACS também veio do arquivo, sem ninguém dizer de novo.
    assert.match(env, /^GENIEACS_URL=http:\/\/127\.0\.0\.1:7557$/m);
    assert.ok(!argvs().includes(CHAVE));
    assert.ok(!r.saida.includes(CHAVE));
  });

  it('troca a chave quando AGENT_TOKEN_FILE traz outra', () => {
    const r = rodar([], {
      AGENT_TOKEN_FILE: arquivoDeChave(OUTRA_CHAVE, 'outra'),
      PANEL_URL: 'https://alfa.painel.exemplo.test'
    });
    assert.equal(r.status, 0, r.saida);
    const env = fs.readFileSync(caminhos().envFile, 'utf8');
    assert.match(env, new RegExp(`^AGENT_TOKEN=${OUTRA_CHAVE}$`, 'm'));
    assert.equal(fs.statSync(caminhos().envFile).mode & 0o777, 0o600);
    assert.ok(!argvs().includes(OUTRA_CHAVE));
  });

  it('ignora AGENT_TOKEN do ambiente — sem arquivo nem terminal, não instala', () => {
    fs.rmSync(caminhos().envFile);
    const r = rodar([], { AGENT_TOKEN: CHAVE, PANEL_URL: 'https://alfa.painel.exemplo.test' });
    assert.notEqual(r.status, 0);
    assert.match(r.saida, /AGENT_TOKEN foi ignorada/);
    assert.match(r.saida, /Sem a chave do agente/);
    assert.ok(!r.saida.includes(CHAVE));
    assert.ok(!fs.existsSync(caminhos().envFile));
  });

  it('recusa um arquivo que não tem uma chave, sem repetir o conteúdo', () => {
    const quase = `${CHAVE.slice(0, -1)}!`;
    const r = rodar([], {
      AGENT_TOKEN_FILE: arquivoDeChave(quase, 'quase'),
      PANEL_URL: 'https://alfa.painel.exemplo.test'
    });
    assert.notEqual(r.status, 0);
    assert.match(r.saida, /não tem o formato/);
    assert.ok(!r.saida.includes(quase.slice(5, 30)));
  });

  it('recusa argumento desconhecido sem repeti-lo — pode ser a chave colada no lugar errado', () => {
    const r = rodar([CHAVE], { PANEL_URL: 'https://alfa.painel.exemplo.test' });
    assert.notEqual(r.status, 0);
    assert.match(r.saida, /Opção desconhecida/);
    assert.ok(!r.saida.includes(CHAVE));
    assert.ok(!r.saida.includes(CHAVE.slice(5, 20)));
  });

  it('recusa endereço de painel com usuário e senha, ou que feche aspas', () => {
    for (const url of ['https://quem:senha@painel.exemplo.test', "https://painel.exemplo.test/'$(id)'"]) {
      const r = rodar([], { AGENT_TOKEN_FILE: arquivoDeChave(CHAVE), PANEL_URL: url });
      assert.notEqual(r.status, 0, url);
      assert.match(r.saida, /Endereço do painel inválido/);
    }
  });

  it('--uninstall para, desabilita e remove unidade, programa, ambiente e usuário', () => {
    // De volta a um estado instalado, para ter o que remover.
    assert.equal(rodar([], {
      AGENT_TOKEN_FILE: arquivoDeChave(CHAVE), PANEL_URL: 'https://alfa.painel.exemplo.test'
    }).status, 0);
    fs.rmSync(registro, { force: true });

    const r = rodar(['--uninstall'], { STUB_USER_EXISTS: '1' });
    assert.equal(r.status, 0, r.saida);
    const c = caminhos();
    for (const p of [c.envFile, c.unitFile, c.agentDir]) {
      assert.ok(!fs.existsSync(p), `${p} continuou lá`);
    }
    const log = argvs();
    assert.match(log, /^systemctl disable --now skygenpanel-agent$/m);
    assert.match(log, /^systemctl daemon-reload$/m);
    assert.match(log, /^userdel skygenpanel-agent$/m);
  });
});

/** As linhas do script que não são comentário, com o número de cada uma. */
const linhas = fonte.split('\n')
  .map((texto, i) => ({ texto, n: i + 1 }))
  .filter(({ texto }) => !/^\s*#/.test(texto));

/** O texto da unidade, como o heredoc a escreve. */
const unidade = (/cat >"\$UNIT_FILE" <<EOF\n([\s\S]*?)\nEOF\n/.exec(fonte) || [])[1] || '';

describe('o instalador, lido', () => {
  it('passa no `bash -n`', () => {
    execFileSync('/bin/bash', ['-n', SCRIPT]);
  });

  it('passa no shellcheck, onde ele existe', (t) => {
    const achado = spawnSync('shellcheck', ['--version']);
    if (achado.error) return t.skip('shellcheck não instalado');
    const r = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
    return undefined;
  });

  it('não tem opção de linha de comando para a chave', () => {
    // Fora dos comentários: o cabeçalho do script DIZ que não existe `--token`.
    const codigo = linhas.map(({ texto }) => texto).join('\n');
    assert.ok(!/--token/.test(codigo), 'nenhum --token');
    assert.ok(!/AGENT_TOKEN=\$1|AGENT_TOKEN="\$[0-9@*]/.test(fonte), 'a chave não sai dos argumentos');
  });

  /**
   * Toda expansão da chave (`$AGENT_TOKEN`, `$current_token`) tem que estar num
   * trecho cujo comando é embutido do bash ou função do script. A dica
   * `${…: -4}` fica de fora: é o que o painel também mostra.
   *
   * O trecho é o pedaço da linha entre `&&`, `||`, `;`, `|`, `$(` e `` ` ``:
   * cada um deles pode começar um comando novo, e é o comando que importa.
   */
  it('só expande a chave em embutido do bash ou em função do script', () => {
    // As funções do script, menos as que escrevem na tela: `log "$AGENT_TOKEN"`
    // não põe a chave em argv, mas a mostra, que é o mesmo vazamento.
    const funcoes = new Set([...fonte.matchAll(/^\s*(\w+)\(\)\s+\{/gm)].map((m) => m[1]));
    for (const falante of ['log', 'warn', 'die', 'ask', 'usage']) funcoes.delete(falante);
    const embutidos = new Set(['printf', '[[', '[', 'local', 'return', 'read', 'unset']);
    const expande = /\$\{?(AGENT_TOKEN|current_token)(?!_FILE)(?!: -4\})\b/;
    const achados = [];
    for (const { texto, n } of linhas) {
      if (!expande.test(texto)) continue;
      for (const trecho of texto.split(/&&|\|\||;|\||\$\(|`/)) {
        if (!expande.test(trecho)) continue;
        const palavras = trecho.trim()
          .replace(/^(?:if|then|elif|while|until|!|\{|\()\s+/g, '')
          .split(/\s+/);
        const comando = palavras[0];
        const atribuicao = /^\w+=/.test(comando);
        if (!(atribuicao || embutidos.has(comando) || funcoes.has(comando))) {
          achados.push(`${n}: ${texto.trim()}`);
        }
      }
    }
    assert.deepEqual(achados, [], 'a chave foi expandida como argumento de um comando externo');
  });

  it('e o único printf que escreve a chave é o do arquivo de ambiente', () => {
    const escritas = linhas.filter(({ texto }) => /printf\b.*\$\{?AGENT_TOKEN\b(?!_FILE)(?!: -4)/.test(texto));
    assert.deepEqual(escritas.map(({ texto }) => texto.trim()), [`printf 'AGENT_TOKEN=%s\\n' "$AGENT_TOKEN"`]);
    // Dentro do grupo redirecionado para o temporário, e não para a saída.
    const grupo = /\{\n((?:\s+printf [^\n]+\n)+)\s+\} >"\$temp_env"/.exec(fonte);
    assert.ok(grupo && grupo[1].includes('"$AGENT_TOKEN"'), 'o printf da chave tem que estar no grupo redirecionado');
  });

  it('pede a chave com `read -s`, do /dev/tty', () => {
    const leituras = linhas.filter(({ texto }) => /\bread\b[^\n]*\bAGENT_TOKEN\b/.test(texto));
    assert.ok(leituras.length >= 2, 'a leitura do arquivo e a do terminal');
    for (const { texto, n } of leituras) {
      if (texto.includes('<"$AGENT_TOKEN_FILE"')) continue;
      assert.match(texto, /\bread -rs AGENT_TOKEN <\/dev\/tty\b/, `linha ${n}: ${texto.trim()}`);
    }
    assert.ok(leituras.some(({ texto }) => texto.includes('</dev/tty')), 'nenhuma leitura do terminal');
  });

  it('cria o ambiente com umask 077, e o deixa root e 0600', () => {
    const corpo = /write_env_file\(\) \{\n([\s\S]*?)\n\}\n/.exec(fonte)?.[1] || '';
    assert.ok(corpo, 'write_env_file não encontrada');
    const umask = corpo.indexOf('umask 077');
    const cria = corpo.indexOf('mktemp');
    assert.ok(umask !== -1 && cria !== -1 && umask < cria, 'o umask tem que vir ANTES de criar o arquivo');
    assert.match(corpo, /chown root:root "\$temp_env"/);
    assert.match(corpo, /chmod 0600 "\$temp_env"/);
    assert.match(corpo, /mv -f -- "\$temp_env" "\$ENV_FILE"/);
  });

  it('endurece a unidade do systemd', () => {
    assert.ok(unidade, 'heredoc da unidade não encontrado');
    for (const linha of [
      'User=${SERVICE_USER}',
      'EnvironmentFile=${ENV_FILE}',
      'Restart=always',
      'RestartSec=5',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectControlGroups=yes',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'RestrictNamespaces=yes',
      'LockPersonality=yes',
      'MemoryDenyWriteExecute=no',
      'CapabilityBoundingSet=',
      'SystemCallArchitectures=native'
    ]) {
      assert.ok(unidade.split('\n').includes(linha), `falta na unidade: ${linha}`);
    }
    // O `no` é a única linha que afrouxa, e o porquê tem que estar ao lado.
    assert.match(unidade, /JIT[\s\S]{0,300}\nMemoryDenyWriteExecute=no/);
    assert.match(fonte, /^SERVICE_USER="skygenpanel-agent"$/m);
  });

  it('cria o usuário de sistema sem shell e sem home', () => {
    assert.match(fonte, /useradd --system --no-create-home --home-dir \/nonexistent --shell \/usr\/sbin\/nologin "\$SERVICE_USER"/);
  });

  it('tem a linha que o painel substitui, exatamente uma vez', () => {
    assert.equal((fonte.match(/^DEFAULT_PANEL_URL=''$/gm) || []).length, 1);
  });

  it('só age na última linha — um download cortado não roda meio instalador', () => {
    const fim = fonte.trimEnd().split('\n').slice(-3).join('\n');
    assert.match(fim, /main "\$@"\nfi$/);
    // E nada fora de função faz coisa alguma antes: só atribuição e definição.
    const soltas = linhas.filter(({ texto }) => /^[a-z]/.test(texto)
      && !/^\w+=|^\w+\(\)\s+\{|^set -euo pipefail$|^if \[ "\$\{SKYGP_AGENT_SOURCE_ONLY|^fi$/.test(texto));
    assert.deepEqual(soltas.map(({ n, texto }) => `${n}: ${texto}`), []);
  });
});
