import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A conexão vinda do ambiente, para a edição que roda de imagem contra um
 * Postgres gerenciado: `DATABASE_URL` vence o `db-config.json`.
 */
const { dbConfigFromEnv, buildKnexConfig } = await import('../src/config/dbConfig.js');
const { default: knexFactory } = await import('knex');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

describe('DATABASE_URL', () => {
  it('is absent by default', () => {
    assert.equal(dbConfigFromEnv(''), null);
    assert.equal(dbConfigFromEnv(undefined), null);
  });

  it('reads a Postgres URL with schema, TLS and pool size', () => {
    const config = dbConfigFromEnv('postgres://sky%40gp:s%3Ecret@db.internal:6432/panel?schema=alfa&sslmode=require&pool=4');
    assert.deepEqual(config, {
      client: 'pg', host: 'db.internal', port: 6432, user: 'sky@gp', password: 's>cret',
      database: 'panel', schema: 'alfa', ssl: true, sslRejectUnauthorized: true, poolMax: 4
    });
    const knex = buildKnexConfig(config);
    assert.equal(knex.client, 'pg');
    assert.deepEqual(knex.searchPath, ['alfa']);
    assert.deepEqual(knex.connection.ssl, { rejectUnauthorized: true });
    assert.equal(knex.pool.max, 4);
  });

  it('keeps TLS on and drops verification only when told to', () => {
    assert.deepEqual(buildKnexConfig(dbConfigFromEnv('postgresql://u:p@h/d?sslmode=no-verify')).connection.ssl, { rejectUnauthorized: false });
    assert.equal(buildKnexConfig(dbConfigFromEnv('postgresql://u:p@h/d?sslmode=disable')).connection.ssl, false);
    assert.equal(buildKnexConfig(dbConfigFromEnv('postgresql://u:p@h/d')).connection.ssl, false);
  });

  it('reads a MySQL URL and ignores schema there', () => {
    const config = dbConfigFromEnv('mysql://root:pw@127.0.0.1/skygp?schema=ignored');
    assert.equal(config.client, 'mysql2');
    assert.equal(config.port, 3306);
    assert.equal(config.schema, undefined);
    assert.equal(buildKnexConfig(config).client, 'mysql2');
  });

  it('refuses what it cannot connect to, loudly', () => {
    assert.throws(() => dbConfigFromEnv('sqlite:///panel.db'), /postgres:\/\/ or mysql:\/\//);
    assert.throws(() => dbConfigFromEnv('postgres://u:p@h/'), /names no database/);
    assert.throws(() => dbConfigFromEnv('not a url'), /not a valid URL/);
  });
});

/**
 * A conexão SQLite, medida pelo EFEITO e não pelo texto da configuração.
 *
 * O padrão do SQLite é o journal `delete`, em que um leitor tranca um escritor
 * no arquivo inteiro, e sem `busy_timeout` a colisão não espera: vira
 * `SQLITE_BUSY` na hora. Como cada conexão do `better-sqlite3` é um handle
 * próprio e o pool abre vários — mais o processo de backup, que abre o mesmo
 * arquivo —, essa é a origem de "database is locked" num deploy que não fez
 * nada de errado.
 *
 * Abre um knex de verdade contra um arquivo temporário e lê os pragmas de
 * volta. Afirmar que a string está no arquivo provaria que alguém escreveu a
 * linha; o que importa é o `afterCreate` ter rodado.
 */
describe('a conexão SQLite', () => {
  /** Um banco descartável, e o caminho dele. */
  function bancoTemporario() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-sqlite-'));
    return { dir, filename: path.join(dir, 'panel.sqlite') };
  }

  const abrir = (filename) => knexFactory(buildKnexConfig({ client: 'sqlite3', filename }));

  it('abre em WAL, espera por lock em vez de estourar, e mantém as chaves estrangeiras', async () => {
    const { dir, filename } = bancoTemporario();
    const db = abrir(filename);
    try {
      // `.raw` porque é pragma: o valor volta na primeira coluna da primeira
      // linha, e o formato difere entre eles.
      const [journal] = await db.raw('PRAGMA journal_mode');
      assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');

      const [busy] = await db.raw('PRAGMA busy_timeout');
      assert.equal(Number(busy.timeout), 5000);

      // A linha que já existia não pode ter sido empurrada para fora pelo
      // caminho: sem ela, uma linha órfã entra calada.
      const [fk] = await db.raw('PRAGMA foreign_keys');
      assert.equal(Number(fk.foreign_keys), 1);
    } finally {
      await db.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o modo sobrevive a fechar e reabrir, porque mora no cabeçalho do arquivo', async () => {
    const { dir, filename } = bancoTemporario();
    const primeiro = abrir(filename);
    try {
      await primeiro.raw('PRAGMA journal_mode');
    } finally {
      await primeiro.destroy();
    }

    // Reabrir com a configuração NUA — sem o `afterCreate` — e ainda ver `wal`
    // é o que prova que o modo ficou gravado, e não só valeu naquela sessão.
    const nu = knexFactory({
      client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true
    });
    try {
      const [journal] = await nu.raw('PRAGMA journal_mode');
      assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');
    } finally {
      await nu.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
