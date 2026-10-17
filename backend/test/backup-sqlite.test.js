import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { default: Database } = await import('better-sqlite3');

/**
 * A cópia do SQLite, que é o backup de todo install self-hosted.
 *
 * Duas coisas, e a segunda é a razão de o script existir em vez de um `cp`:
 *
 * 1. a cópia tem que ter os dados;
 * 2. um destino que não presta tem que **falhar**, e não sair zero deixando um
 *    arquivo com tamanho. Um backup que mente é pior que nenhum: ele impede que
 *    alguém procure outro.
 *
 * Pelo processo e não pela importação, porque o que está sob contrato é o
 * código de saída — é por ele que o script de shell decide continuar ou morrer.
 */

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, 'scripts', 'backup-sqlite.js');

function copiar(origem, destino) {
  return execFileSync(process.execPath, [SCRIPT, destino], {
    cwd: RAIZ,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SKYGP_SQLITE_PATH: origem }
  });
}

function bancoDeMentira(pasta, linhas = 3) {
  const caminho = path.join(pasta, 'panel.sqlite');
  const db = new Database(caminho);
  // O ledger, porque é por ele que o script reconhece um banco deste painel.
  db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)');
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('0001_baseline', 'x');
  db.exec('CREATE TABLE assinantes (id INTEGER PRIMARY KEY, nome TEXT)');
  const insere = db.prepare('INSERT INTO assinantes (nome) VALUES (?)');
  for (let i = 0; i < linhas; i += 1) insere.run(`assinante ${i}`);
  db.close();
  return caminho;
}

describe('a cópia do banco SQLite', () => {
  it('leva os dados, e diz o tamanho para o manifesto', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    const origem = bancoDeMentira(pasta, 5);
    const destino = path.join(pasta, 'saida', 'panel.sqlite');

    const tamanho = Number(copiar(origem, destino).trim());
    assert.ok(tamanho > 0, 'um zero aqui é a primeira coisa que denuncia um backup vazio');
    assert.equal(tamanho, fs.statSync(destino).size);

    const copia = new Database(destino, { readonly: true });
    assert.equal(copia.prepare('SELECT COUNT(*) n FROM assinantes').get().n, 5);
    copia.close();
  });

  /**
   * O caso que faz o script existir: `sqlite3` não está instalado num install
   * recém-feito, e um `cp` do arquivo vivo produz uma cópia que abre, responde
   * a consultas e está corrompida em algum lugar que ninguém vai procurar. A
   * API de backup do SQLite copia com a transação em andamento e é consistente.
   */
  it('é consistente mesmo com uma transação aberta na origem', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    const origem = bancoDeMentira(pasta, 2);
    const destino = path.join(pasta, 'panel-copia.sqlite');

    const vivo = new Database(origem);
    vivo.exec('BEGIN');
    vivo.prepare('INSERT INTO assinantes (nome) VALUES (?)').run('ainda não confirmado');
    try {
      copiar(origem, destino);
    } finally {
      vivo.exec('ROLLBACK');
      vivo.close();
    }

    const copia = new Database(destino, { readonly: true });
    assert.equal(copia.pragma('integrity_check')[0].integrity_check, 'ok');
    // A linha não confirmada não podia ter entrado: a cópia é do banco como ele
    // está comprometido a estar, e não do que uma transação ainda pode desfazer.
    assert.equal(copia.prepare('SELECT COUNT(*) n FROM assinantes').get().n, 2);
    copia.close();
  });

  it('origem que não existe: sai diferente de zero e não escreve nada', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    const destino = path.join(pasta, 'panel.sqlite');
    assert.throws(() => copiar(path.join(pasta, 'nao-existe.sqlite'), destino), (erro) => {
      assert.equal(erro.status, 1);
      assert.match(erro.stderr, /no SQLite database at/);
      return true;
    });
    assert.equal(fs.existsSync(destino), false,
      'um arquivo deixado para trás pareceria um backup que aconteceu');
  });

  /**
   * O modo clássico de um backup mentir: `integrity_check` responde `ok` para um
   * banco vazio, então um `panel.sqlite` de zero byte — o install onde o serviço
   * nunca subiu, ou onde o `DATA_DIR` aponta para a pasta errada — copia limpo,
   * sai com 4 KB de cabeçalho e devolve zero. Tem tamanho, tem sha256, tem linha
   * no manifesto, e não tem um registro dentro.
   */
  it('banco vazio: recusa, em vez de copiar 4 KB de nada e sair zero', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    const origem = path.join(pasta, 'panel.sqlite');
    fs.writeFileSync(origem, '');
    const destino = path.join(pasta, 'copia.sqlite');

    assert.throws(() => copiar(origem, destino), (erro) => {
      assert.equal(erro.status, 1);
      assert.match(erro.stderr, /not a panel database/);
      return true;
    });
    assert.equal(fs.existsSync(destino), false);
  });

  it('e um banco com o ledger vazio, que é o install que nunca migrou', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    const origem = path.join(pasta, 'panel.sqlite');
    const db = new Database(origem);
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)');
    db.close();

    assert.throws(() => copiar(origem, path.join(pasta, 'copia.sqlite')), (erro) => {
      assert.match(erro.stderr, /empty migration ledger/);
      return true;
    });
  });

  it('sem destino, recusa em vez de adivinhar um', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    const origem = bancoDeMentira(pasta);
    assert.throws(() => execFileSync(process.execPath, [SCRIPT], {
      cwd: RAIZ, encoding: 'utf8',
      env: { PATH: process.env.PATH, SKYGP_SQLITE_PATH: origem }
    }), (erro) => {
      assert.equal(erro.status, 1);
      assert.match(erro.stderr, /usage:/);
      return true;
    });
  });
});
