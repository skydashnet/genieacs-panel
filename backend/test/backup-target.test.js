import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Onde o backup vai procurar o banco — e a prova de que a resposta atravessa o
 * shell como DADO.
 *
 * Este é o único arquivo do projeto que testa um script pelo processo e não
 * pela importação, e é de propósito: o que está sob teste não é o valor de
 * retorno de uma função, é **o texto que sai na stdout**, porque quem o consome
 * faz `eval "$(node scripts/backup-target.js)"` rodando como root. Importar o
 * módulo provaria a leitura da configuração e não provaria nada sobre o `eval`.
 *
 * As duas afirmações, e a segunda é a que morde:
 *
 * 1. **A precedência.** `DATABASE_URL` > `db-config.json` > SQLite. Se o script
 *    a reimplementasse errado, um install com `DATABASE_URL` teria o backup
 *    feito do SQLite vazio ao lado — e o arquivo teria tamanho, e sairia 0.
 * 2. **A citação.** A senha do banco é escolhida por quem opera e pode conter
 *    aspas, `$`, `;` e crase. Uma dessas atravessando um `eval` de root não é um
 *    valor errado, é execução de comando.
 */

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, 'scripts', 'backup-target.js');

/** O script, rodado com um ambiente inteiro escolhido aqui. */
function alvo(env = {}, dataDir = null) {
  const pasta = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-backup-'));
  const saida = execFileSync(process.execPath, [SCRIPT], {
    cwd: RAIZ,
    encoding: 'utf8',
    // Ambiente limpo: sem isto o `.env` do desenvolvedor e o `DATABASE_URL` da
    // máquina decidiriam o resultado, e o teste diria coisas diferentes em
    // máquinas diferentes.
    env: { PATH: process.env.PATH, DATA_DIR: pasta, ...env }
  });
  const pares = Object.fromEntries(
    saida.trim().split('\n').map((linha) => {
      const igual = linha.indexOf('=');
      return [linha.slice(0, igual), linha.slice(igual + 1)];
    })
  );
  return { saida, pares, pasta };
}

/** O que o shell entende de uma linha — que é o que o consumidor vai obter. */
function comoOShellLe(saida, chave) {
  return execFileSync('/bin/sh', ['-c', `eval "$1"; printf '%s' "$${chave}"`, 'sh', saida], {
    encoding: 'utf8'
  });
}

describe('onde o backup procura o banco', () => {
  it('sem nada configurado, é o SQLite dentro do DATA_DIR', () => {
    const { pares, pasta } = alvo();
    assert.equal(pares.SKYGP_CLIENT, `'better-sqlite3'`);
    assert.equal(pares.SKYGP_SQLITE_PATH, `'${path.join(pasta, 'panel.sqlite')}'`);
    assert.equal(pares.SKYGP_MEDIA_DIR, `'${path.join(pasta, 'wa-media')}'`);
    // Nada de host nem de senha: não há servidor nenhum nesta forma, e emitir
    // as chaves vazias faria o consumidor tentar um `pg_dump` sem alvo.
    assert.equal(pares.SKYGP_HOST, undefined);
    assert.equal(pares.SKYGP_PASSWORD, undefined);
  });

  it('com db-config.json, é o servidor que a tela de banco gravou', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-backup-'));
    fs.writeFileSync(path.join(pasta, 'db-config.json'), JSON.stringify({
      client: 'mysql', host: 'mariadb.interno', port: 3307,
      user: 'painel', password: 'senha-do-arquivo', database: 'skygp'
    }));
    const { pares } = alvo({}, pasta);
    assert.equal(pares.SKYGP_CLIENT, `'mysql2'`, 'a grafia do arquivo é normalizada');
    assert.equal(pares.SKYGP_HOST, `'mariadb.interno'`);
    assert.equal(pares.SKYGP_PORT, `'3307'`);
    assert.equal(pares.SKYGP_DATABASE, `'skygp'`);
    // No MySQL "schema" é o próprio banco: a chave sai vazia para o consumidor
    // não passar um `--schema=` que faria o dump não exportar nada.
    assert.equal(pares.SKYGP_SCHEMA, `''`);
  });

  /**
   * A precedência que existe para a imagem do SaaS não ser apontada para o
   * banco errado por um volume velho. Se ela se invertesse aqui, o backup da
   * edição hospedada copiaria um SQLite vazio ao lado do Postgres de verdade —
   * com tamanho, e saindo zero.
   */
  it('e DATABASE_URL vence o arquivo, como no painel', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-backup-'));
    fs.writeFileSync(path.join(pasta, 'db-config.json'), JSON.stringify({
      client: 'mysql', host: 'nao-e-este', database: 'nem-este'
    }));
    const { pares } = alvo({
      DATABASE_URL: 'postgres://u:p@db.exemplo:6543/painel?schema=p1&sslmode=no-verify'
    }, pasta);
    assert.equal(pares.SKYGP_CLIENT, `'pg'`);
    assert.equal(pares.SKYGP_HOST, `'db.exemplo'`);
    assert.equal(pares.SKYGP_PORT, `'6543'`);
    assert.equal(pares.SKYGP_SCHEMA, `'p1'`, 'um Postgres gerenciado pode ter mais de um painel');
    assert.equal(pares.SKYGP_SSL, `'1'`);
    assert.equal(pares.SKYGP_SSL_VERIFY, `'0'`, 'no-verify mantém o TLS e larga a cadeia');
  });

  it('a porta padrão sai do dialeto quando a URL não a diz', () => {
    assert.equal(alvo({ DATABASE_URL: 'postgres://u:p@h/d' }).pares.SKYGP_PORT, `'5432'`);
    assert.equal(alvo({ DATABASE_URL: 'mysql://u:p@h/d' }).pares.SKYGP_PORT, `'3306'`);
  });

  it('uma URL que não presta morre no stderr e não na stdout', () => {
    // A distinção não é cosmética: quem chama faz `eval` da stdout como root, e
    // um `eval` de uma mensagem de erro é um comando desconhecido rodando.
    assert.throws(() => alvo({ DATABASE_URL: 'redis://h/0' }), (erro) => {
      assert.equal(erro.status, 1);
      assert.equal(erro.stdout, '');
      assert.match(erro.stderr, /postgres:\/\/ or mysql:\/\//);
      return true;
    });
  });
});

describe('a saída atravessa o shell como dado, e nunca como comando', () => {
  /**
   * A senha é escolhida por quem opera o banco, e o consumidor a lê com `eval`
   * rodando como root. Este caso é o que separa um backup de uma execução
   * remota de comando na madrugada.
   */
  it('mesmo com aspas, cifrão, ponto-e-vírgula e crase na senha', () => {
    const perigosa = `a'b;touch /tmp/skygp-nao-devia-existir;$(id)\`id\`$HOME`;
    const { saida, pares } = alvo({
      DATABASE_URL: `postgres://u:${encodeURIComponent(perigosa)}@h/d`
    });
    assert.equal(comoOShellLe(saida, 'SKYGP_PASSWORD'), perigosa,
      'o shell tem que devolver a senha inteira, sem executar nada dela');
    assert.equal(fs.existsSync('/tmp/skygp-nao-devia-existir'), false,
      'a citação falhou e o `eval` executou parte da senha');
    // E a linha não pode simplesmente omitir o que não soube citar.
    assert.ok(pares.SKYGP_PASSWORD.length > perigosa.length);
  });

  it('e com uma quebra de linha, que sozinha viraria uma linha nova de shell', () => {
    // A senha finge ser a PRÓXIMA linha da saída, com um valor que o script
    // jamais emitiria: se `SKYGP_CLIENT` voltar como `INVADIDO`, quem escolheu o
    // dialeto do dump foi a senha, e o consumidor acabou de rodar o ramo errado
    // como root.
    const quebrada = 'linha1\nSKYGP_CLIENT=INVADIDO';
    const { saida } = alvo({
      DATABASE_URL: `postgres://u:${encodeURIComponent(quebrada)}@h/d`
    });
    assert.equal(comoOShellLe(saida, 'SKYGP_PASSWORD'), quebrada);
    assert.equal(comoOShellLe(saida, 'SKYGP_CLIENT'), 'pg',
      'a segunda linha da senha virou uma atribuição de verdade');
  });
});
