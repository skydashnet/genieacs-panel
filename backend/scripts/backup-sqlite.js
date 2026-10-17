import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { SQLITE_PATH } from '../src/config/paths.js';

/**
 * Uma cópia consistente do banco SQLite, com o painel rodando.
 *
 * Existe por dois motivos, e o primeiro é o que surpreende:
 *
 * 1. **`sqlite3` não está instalado.** `deploy/install.sh` traz git, curl, tar,
 *    build-essential e mais um punhado de utilitários, e nenhum cliente de
 *    banco — nem `sqlite3`, nem `pg_dump`, nem `mysqldump`. Num install recém
 *    feito, a única biblioteca capaz de ler este arquivo é a que o próprio
 *    painel já carrega.
 * 2. **`cp` de arquivo vivo não é backup.** Copiar `panel.sqlite` enquanto uma
 *    transação está aberta produz um arquivo que abre, responde a consultas e
 *    está corrompido em algum lugar que ninguém vai procurar até precisar. A
 *    API `backup()` do SQLite copia página a página segurando o que precisa ser
 *    segurado, e é a resposta certa desde sempre.
 *
 * Sai com código diferente de zero se a cópia não passar no
 * `PRAGMA integrity_check`. Um backup que sai 0 tendo escrito lixo é como um
 * backup mente por meses: o arquivo está lá, tem tamanho, e ninguém o abre até
 * o dia em que é a última coisa que resta.
 */

async function main() {
  const destino = process.argv[2];
  if (!destino) {
    throw new Error('usage: node scripts/backup-sqlite.js <destino>');
  }
  const origem = process.env.SKYGP_SQLITE_PATH || SQLITE_PATH;
  if (!fs.existsSync(origem)) {
    throw new Error(`no SQLite database at ${origem}`);
  }

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  // Só leitura na origem: este processo não é o dono do banco, é um visitante
  // enquanto o serviço escreve.
  const db = new Database(origem, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destino);
  } finally {
    db.close();
  }

  const copia = new Database(destino, { readonly: true, fileMustExist: true });
  try {
    const [linha] = copia.pragma('integrity_check');
    const veredito = linha?.integrity_check;
    if (veredito !== 'ok') {
      throw new Error(`integrity_check on the copy said "${veredito}"`);
    }

    // E a cópia tem que ser deste painel.
    //
    // `integrity_check` responde `ok` para um banco VAZIO, e um `panel.sqlite`
    // de zero byte — o install onde o serviço nunca subiu, ou onde alguém
    // apontou o `DATA_DIR` para a pasta errada — copia limpo, sai com 4 KB de
    // cabeçalho e devolve zero. O resultado é um backup com tamanho, com
    // `sha256`, com linha no manifesto, e sem um único registro dentro: o modo
    // clássico de um backup mentir por meses, porque tudo o que se olha é se
    // ele existe.
    //
    // O ledger é o que prova: toda base deste painel tem `schema_migrations`
    // com pelo menos uma linha desde a primeira subida.
    const ledger = copia.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get();
    if (!ledger?.n) {
      throw new Error('the copy has no schema_migrations table: this is not a panel database');
    }
    const aplicadas = copia.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
    if (!aplicadas?.n) {
      throw new Error('the copy has an empty migration ledger: the panel never ran against it');
    }
    // O tamanho vai para a stdout porque quem chama escreve isto no manifesto,
    // e um zero ali é a primeira coisa que denuncia um backup vazio.
    process.stdout.write(`${fs.statSync(destino).size}\n`);
  } finally {
    copia.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`backup-sqlite: ${error.message}\n`);
  // O arquivo pela metade sai junto: deixá-lo seria um backup que parece ter
  // acontecido, que é pior do que nenhum.
  if (process.argv[2]) fs.rmSync(process.argv[2], { force: true });
  process.exitCode = 1;
}
