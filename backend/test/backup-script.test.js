import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { default: Database } = await import('better-sqlite3');

/**
 * O script que o relógio dispara às 3h17 — provado rodando, e não lido.
 *
 * O que se testa aqui é a lógica que só existe no bash e que ninguém vai olhar
 * de novo até o dia do restore: a recusa de um destino que se copia a si mesmo,
 * a poda que decide o que sobrevive, e a impressão digital das chaves — que é a
 * única peça do backup inteiro que responde a pergunta "o dump que eu tenho
 * abre com a chave que eu tenho?".
 *
 * Nada aqui usa o painel: o script é montado sobre um install de mentira, que é
 * exatamente o que ele enxerga em produção — um diretório com `backend/`, um
 * `.env` e um `DATA_DIR`.
 */

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, '..', 'deploy', 'skygenpanel-backup');

let base;
let install;
let dados;
let destino;

/** Um install de mentira: o suficiente para o script achar tudo o que lê. */
before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-bkp-'));
  install = path.join(base, 'install');
  dados = path.join(base, 'dados');
  destino = path.join(base, 'backups');

  fs.mkdirSync(path.join(install, 'backend', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dados, 'wa-media', 't1', '9'), { recursive: true });
  for (const nome of ['backup-target.js', 'backup-sqlite.js']) {
    fs.copyFileSync(path.join(RAIZ, 'scripts', nome), path.join(install, 'backend', 'scripts', nome));
  }
  // Os dois scripts importam `../src/config/...` e carregam `better-sqlite3`.
  // O caminho mais honesto é apontar o install falso para o `src` e o
  // `node_modules` reais — é o mesmo código que roda na máquina do ISP.
  fs.symlinkSync(path.join(RAIZ, 'src'), path.join(install, 'backend', 'src'));
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(install, 'backend', 'node_modules'));
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ version: '9.9.9' }));

  fs.writeFileSync(path.join(install, 'backend', '.env'),
    `DATA_DIR=${dados}\nSECRET_BOX_KEY=chave-de-cifra-do-teste\nJWT_SECRET=segredo-de-jwt-do-teste\n`,
    { mode: 0o600 });

  const db = new Database(path.join(dados, 'panel.sqlite'));
  db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)');
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('0044_o_topo_do_ledger', 'x');
  db.exec('CREATE TABLE assinantes (id INTEGER PRIMARY KEY, nome TEXT)');
  db.prepare('INSERT INTO assinantes (nome) VALUES (?)').run('Fulana de Tal');
  db.close();
  fs.writeFileSync(path.join(dados, 'wa-media', 't1', '9', 'foto.jpg'), 'bytes da foto');
  fs.writeFileSync(path.join(dados, 'db-config.json'), '{"client":"sqlite3"}', { mode: 0o600 });
});

function rodar(verbo = 'run', extra = {}) {
  return execFileSync('/bin/bash', [SCRIPT, verbo], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SKYGP_DIR: install,
      SKYGP_BACKUP_DIR: destino,
      ...extra
    }
  });
}

const copias = () => (fs.existsSync(destino)
  ? fs.readdirSync(destino).filter((n) => !n.startsWith('.')).sort()
  : []);

const manifesto = (nome) => JSON.parse(
  fs.readFileSync(path.join(destino, nome, 'manifest.json'), 'utf8')
);

describe('o backup de um install SQLite', () => {
  it('leva o banco, os anexos e a configuração, e diz o que levou', () => {
    rodar();
    const [copia] = copias();
    assert.ok(copia, 'a passada tinha que deixar uma cópia');

    const m = manifesto(copia);
    assert.equal(m.client, 'better-sqlite3');
    assert.equal(m.panelVersion, '9.9.9');
    // Em que migração o dump foi tirado: é a linha que, no dia do restore, diz
    // se ele é mais velho que o binário que vai abri-lo.
    assert.equal(m.schemaMigration, '0044_o_topo_do_ledger');
    assert.equal(m.includesEnv, false, 'o .env não entra sem alguém pedir');

    for (const arquivo of ['panel.sqlite', 'wa-media.tar.gz', 'db-config.json']) {
      assert.ok(m.files[arquivo], `${arquivo} não está no manifesto`);
      assert.ok(m.files[arquivo].bytes > 0, `${arquivo} saiu vazio`);
      assert.equal(m.files[arquivo].sha256.length, 64);
    }

    // E o banco copiado tem o assinante dentro, que é o ponto de tudo isto.
    const copiado = new Database(path.join(destino, copia, 'panel.sqlite'), { readonly: true });
    assert.equal(copiado.prepare('SELECT nome FROM assinantes').get().nome, 'Fulana de Tal');
    copiado.close();
  });

  /**
   * O segredo é a metade do backup que não é o dado. Restaurar o banco com a
   * chave errada não dá erro: o painel sobe, responde 200, e toda senha de
   * portal e de WiFi volta nula — `decrypt` devolve null e a tela mostra um
   * dado que "sumiu" em vez de uma chave que falta.
   */
  it('guarda a impressão digital das chaves, e nunca o valor delas', () => {
    const m = manifesto(copias()[0]);
    assert.match(m.secretFingerprints.SECRET_BOX_KEY, /^[0-9a-f]{12}$/);
    assert.match(m.secretFingerprints.JWT_SECRET, /^[0-9a-f]{12}$/);
    assert.notEqual(m.secretFingerprints.SECRET_BOX_KEY, m.secretFingerprints.JWT_SECRET);
    const texto = fs.readFileSync(path.join(destino, copias()[0], 'manifest.json'), 'utf8');
    assert.equal(texto.includes('chave-de-cifra-do-teste'), false);
    assert.equal(texto.includes('segredo-de-jwt-do-teste'), false);
  });

  it('e o verify compara essas impressões com as chaves de hoje', () => {
    assert.match(rodar('verify'), /keys still match/);

    const env = path.join(install, 'backend', '.env');
    const original = fs.readFileSync(env, 'utf8');
    fs.writeFileSync(env, original.replace('chave-de-cifra-do-teste', 'chave-rotacionada'));
    try {
      assert.throws(() => rodar('verify'), (erro) => {
        assert.equal(erro.status, 1);
        assert.match(erro.stderr, /SECRET_BOX_KEY changed/);
        // A frase que importa: não é "o backup está corrompido", é "o backup
        // está bom e a chave que abre ele é outra".
        assert.match(erro.stderr, /needs the PREVIOUS key/);
        return true;
      });
    } finally {
      fs.writeFileSync(env, original);
    }
  });
});

describe('o destino, que não pode ser o que ele copia', () => {
  it('recusa cair dentro do DATA_DIR', () => {
    assert.throws(() => rodar('run', { SKYGP_BACKUP_DIR: path.join(dados, 'backups') }), (erro) => {
      assert.match(erro.stderr, /outside DATA_DIR/);
      return true;
    });
  });

  it('e dentro do diretório de instalação', () => {
    assert.throws(() => rodar('run', { SKYGP_BACKUP_DIR: path.join(install, 'backups') }), (erro) => {
      assert.match(erro.stderr, /outside the install directory/);
      return true;
    });
  });

  it('e um caminho relativo, que dependeria de onde o timer foi disparado', () => {
    assert.throws(() => rodar('run', { SKYGP_BACKUP_DIR: 'backups' }), (erro) => {
      assert.match(erro.stderr, /absolute path/);
      return true;
    });
  });
});

describe('a poda', () => {
  /**
   * Trinta diárias mais os domingos. Domingo promovido em vez de uma segunda
   * agenda: uma passada por dia, e quem sobrevive é decidido lendo os nomes —
   * então a máquina que ficou uma semana desligada não perde também a linha
   * semanal.
   */
  it('mantém as N mais novas e promove os domingos', () => {
    fs.rmSync(destino, { recursive: true, force: true });
    fs.mkdirSync(destino, { recursive: true });
    // Quarenta dias para trás, um por dia, todos com manifesto.
    const hoje = new Date('2026-09-12T03:17:00Z');
    for (let d = 1; d <= 40; d += 1) {
      const dia = new Date(hoje.getTime() - d * 86400000);
      const nome = `${dia.toISOString().slice(0, 10)}T031700Z`;
      fs.mkdirSync(path.join(destino, nome));
      fs.writeFileSync(path.join(destino, nome, 'manifest.json'), '{}');
    }

    rodar('run', { SKYGP_BACKUP_KEEP_DAILY: '10', SKYGP_BACKUP_KEEP_WEEKLY: '52' });

    const ficaram = copias();
    // As dez mais novas são as dez últimas por nome, mais a de agora.
    const domingos = ficaram.filter((nome) => new Date(`${nome.slice(0, 10)}T00:00:00Z`).getUTCDay() === 0);
    assert.ok(ficaram.length > 10, 'os domingos antigos tinham que sobreviver ao corte diário');
    assert.ok(ficaram.length < 41, `a poda não podou nada: ${ficaram.length}`);
    assert.ok(domingos.length >= 4, `quarenta dias têm mais domingos que isto: ${domingos}`);
    // E a mais antiga que sobrou tem que ser um domingo: se fosse outro dia, o
    // corte diário estaria contando errado.
    assert.equal(new Date(`${ficaram[0].slice(0, 10)}T00:00:00Z`).getUTCDay(), 0);
  });

  it('e uma passada que falha não deixa pasta nenhuma para a poda contar', () => {
    fs.rmSync(destino, { recursive: true, force: true });
    // Um Postgres que não existe: o dump morre depois de a pasta já ter sido
    // criada, que é exatamente o momento em que uma pasta vazia com a data de
    // hoje nasceria — e trinta falhas seguidas empurrariam para fora o último
    // backup bom.
    assert.throws(() => rodar('run', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }));
    assert.deepEqual(copias(), []);
  });
});
