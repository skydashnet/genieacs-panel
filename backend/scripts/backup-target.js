import { readDbConfig, resolveClient } from '../src/config/dbConfig.js';
import { DATA_DIR, SQLITE_PATH } from '../src/config/paths.js';

/**
 * Onde o banco deste install está, para quem vai copiá-lo.
 *
 * Existe porque a resposta não é lida de um lugar só. A precedência é
 * `DATABASE_URL` > `DATA_DIR/db-config.json` > SQLite no `DATA_DIR`, e cada um
 * dos três tem regra própria: a URL carrega `?schema=`, `?sslmode=` e
 * `?pool=`; o arquivo é escrito pela tela de banco e guarda a senha em claro; o
 * SQLite deriva de `DATA_DIR`, que por sua vez deriva do `.env` ou do próprio
 * lugar onde o repositório está. Reescrever isso em bash seria uma segunda
 * fonte de verdade, e ela erraria no primeiro `DATABASE_URL` com uma senha que
 * contém `@` — que é quando ninguém está olhando.
 *
 * **Não abre conexão.** Importa `dbConfig.js` e `paths.js`, que são leitura de
 * ambiente e de arquivo, e nunca `database.js` — abrir o pool arrastaria a
 * sentinela de SQL e o escopo de provedor, que levantaria exceção em qualquer
 * consulta sem provedor em escopo. Um script de backup não consulta nada.
 *
 * ## A saída, e por que é assim
 *
 * Linhas `CHAVE='valor'` na stdout, para o consumidor fazer
 * `eval "$(node scripts/backup-target.js)"`. Aspas simples com o escape
 * `'\''`, que é o único jeito de um valor arbitrário atravessar o `eval`
 * sendo dado e não código — e o valor aqui inclui a senha do banco, que é
 * escolhida por quem opera e pode conter qualquer coisa.
 *
 * A senha sai na stdout e **nunca** em argv: um `mysqldump -p"$SENHA"` aparece
 * inteiro no `ps` de qualquer usuário da máquina. Por isso o consumidor a lê
 * daqui e a entrega ao dump por ambiente ou por arquivo 0600.
 */

/** Um valor qualquer, como um literal de shell que não vira código. */
function aspas(valor) {
  return `'${String(valor ?? '').replace(/'/g, "'\\''")}'`;
}

function main() {
  const config = readDbConfig();
  const client = resolveClient(config);

  const linhas = [
    ['SKYGP_CLIENT', client],
    ['SKYGP_DATA_DIR', DATA_DIR],
    ['SKYGP_MEDIA_DIR', `${DATA_DIR}/wa-media`]
  ];

  if (client === 'better-sqlite3') {
    linhas.push(['SKYGP_SQLITE_PATH', config.filename || SQLITE_PATH]);
  } else {
    linhas.push(
      ['SKYGP_HOST', config.host ?? '127.0.0.1'],
      ['SKYGP_PORT', String(config.port ?? (client === 'pg' ? 5432 : 3306))],
      ['SKYGP_USER', config.user ?? ''],
      ['SKYGP_PASSWORD', config.password ?? ''],
      ['SKYGP_DATABASE', config.database ?? ''],
      // Só no Postgres, e só quando há: no MySQL um "schema" é o próprio banco,
      // e emitir a chave vazia faria o consumidor passar `--schema=` para um
      // `pg_dump` que então não exportaria nada.
      ['SKYGP_SCHEMA', client === 'pg' ? (config.schema ?? '') : ''],
      ['SKYGP_SSL', config.ssl ? '1' : '0'],
      // `sslRejectUnauthorized` é indefinido quando não há SSL nenhum; o padrão
      // do lado de cá é verificar, que é a direção segura.
      ['SKYGP_SSL_VERIFY', config.ssl && config.sslRejectUnauthorized === false ? '0' : '1']
    );
  }

  for (const [chave, valor] of linhas) {
    process.stdout.write(`${chave}=${aspas(valor)}\n`);
  }
}

try {
  main();
} catch (error) {
  // Para o stderr, e código 1: o consumidor faz `eval` da stdout, e um `eval`
  // de uma mensagem de erro é um comando desconhecido rodando como root.
  process.stderr.write(`backup-target: ${error.message}\n`);
  process.exitCode = 1;
}
