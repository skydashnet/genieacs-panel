import knexFactory from 'knex';
import { getDb, closePool } from '../config/database.js';
import { buildKnexConfig, readDbConfig, writeDbConfig } from '../config/dbConfig.js';
import { ensureSchema } from '../config/schema.js';
import { SCHEMA_TABLES } from '../config/migrations.js';
import { seedDefaults } from '../config/seed.js';
import { runUnscoped } from '../config/tenantContext.js';
import { TranslatableError } from '../i18n/index.js';

// Every table the schema owns, straight from the migrations. Kept derived
// rather than listed here: the hand-written version fell eight tables behind
// when WhatsApp landed, and a switch would have carried the panel across
// without a single conversation, message or broadcast.
const COPY_TABLES = SCHEMA_TABLES;

function normalizeConfig(input) {
  const client = input.client === 'mysql' || input.client === 'mysql2' ? 'mysql2' : 'sqlite3';
  if (client === 'mysql2') {
    return {
      client: 'mysql2',
      host: input.host,
      port: Number(input.port) || 3306,
      user: input.user,
      password: input.password ?? '',
      database: input.database
    };
  }
  return { client: 'sqlite3' };
}

function validateExternal(config) {
  if (config.client !== 'mysql2') return;
  const missing = ['host', 'user', 'database'].filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new TranslatableError('database.missingMysqlFields', { fields: missing.join(', ') });
  }
}

/**
 * O que sai daqui quando o driver recusa a conexão: só o CÓDIGO do erro.
 *
 * A mensagem crua do `mysql2` ia inteira para o corpo da resposta, e ela diz
 * mais do que quem pergunta precisa saber — o endereço interno com que o painel
 * se apresentou ("Access denied for user 'u'@'172.18.0.3'"), o que respondeu do
 * outro lado quando o host nem era um MySQL, a diferença entre porta fechada e
 * porta que não responde contada em prosa. Com o código (`ECONNREFUSED`,
 * `ETIMEDOUT`, `ENOTFOUND`, `ER_ACCESS_DENIED_ERROR`, `ER_BAD_DB_ERROR`) o
 * operador ainda sabe o que consertar; o texto completo vai para o log do
 * servidor, que é de quem opera a máquina.
 *
 * O que já é `TranslatableError` passa intacto: essas mensagens são nossas.
 */
function driverFailure(error) {
  if (error?.translationKey) return error;
  console.warn(`Database connection test failed: ${error?.message || error}`);
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code)
    ? error.code
    : 'CONNECTION_ERROR';
  return new Error(code);
}

async function probeConfig(config) {
  let probe;
  try {
    probe = knexFactory(buildKnexConfig(config));
    await probe.raw('SELECT 1');
    return true;
  } catch (error) {
    throw driverFailure(error);
  } finally {
    if (probe) await probe.destroy();
  }
}

/**
 * Testa uma conexão com host, porta e credenciais vindos do corpo do request.
 *
 * Passa pelo mesmo portão da troca, e pelo mesmo motivo com outra cara: não há
 * dado sendo copiado aqui, mas há um socket sendo aberto para onde o corpo
 * mandar, e a resposta distingue "conectou", "recusou" e "não respondeu". Num
 * deploy com mais de um provedor, isso é um administrador de provedor varrendo
 * as portas da rede interna da plataforma pelo painel — o MySQL, o Redis, o
 * serviço de metadados, uma porta de cada vez. A instalação de um provedor só,
 * para a qual o botão existe, não muda nada.
 */
export async function testConfig(rawConfig) {
  await assertSoleProvider();
  const config = normalizeConfig(rawConfig);
  validateExternal(config);
  return probeConfig(config);
}

export function getActiveConfig() {
  const config = readDbConfig();
  const safe = { client: config.client === 'mysql2' || config.client === 'mysql' ? 'mysql2' : 'sqlite3' };
  if (safe.client === 'mysql2') {
    safe.host = config.host;
    safe.port = config.port;
    safe.user = config.user;
    safe.database = config.database;
  }
  return safe;
}

/**
 * Moves the whole panel to another database, every provider's rows included.
 *
 * tenant-scope-exempt: a copy that took only the provider in scope would put a
 * deployment on a new database minus everybody else's data, which is the one
 * outcome worse than refusing to copy at all. Declared unscoped so the SQL
 * sentinel does not have to guess that from the shape of a `select *`.
 */
export async function copyData(source, target) {
  return runUnscoped(
    'copying the whole panel between databases',
    () => copyEveryTable(source, target)
  );
}

async function copyEveryTable(source, target) {
  const snapshots = new Map();
  for (const table of COPY_TABLES) {
    if (await source.schema.hasTable(table)) {
      snapshots.set(table, await source(table).select('*'));
    }
  }

  await target.transaction(async (trx) => {
    for (const table of [...COPY_TABLES].reverse()) {
      if (await trx.schema.hasTable(table)) {
        await trx(table).del();
      }
    }

    for (const table of COPY_TABLES) {
      const rows = snapshots.get(table) || [];
      if (rows.length > 0 && await trx.schema.hasTable(table)) {
        await trx.batchInsert(table, rows, 100);
      }
    }
  });
}

function isSameConfig(left, right) {
  const a = normalizeConfig(left);
  const b = normalizeConfig(right);
  if (a.client !== b.client) return false;
  if (a.client === 'sqlite3') return true;
  return (
    a.host === b.host &&
    Number(a.port) === Number(b.port) &&
    a.user === b.user &&
    a.password === b.password &&
    a.database === b.database
  );
}

/**
 * Refuses the switch (and the connection test) on a deployment that serves more than one provider.
 *
 * `copyData` reads every table with no provider predicate and writes it to a
 * host, user and password that came from the request body — so on a shared
 * deployment one ISP's administrator could copy every OTHER ISP's subscribers,
 * password hashes and encrypted secrets to a server of their choosing, and then
 * repoint the panel at it. `app.js` withholds the route outside the
 * self-hosted edition, and that gate is the right idea in the wrong shape: it
 * reads `EDITION`, which defaults to `selfhosted` and which `install.sh` writes
 * into every generated `.env`, so a deployment that grows into a second
 * provider without anyone remembering to set `EDITION=saas` still has it live.
 *
 * The provider count is a fact the process can check for itself, which is what
 * makes it worth having as well as the edition gate rather than instead of it.
 * A single-ISP install — what this feature is for, and where the operator owns
 * the data on both ends — is unaffected.
 */
async function assertSoleProvider() {
  const [{ total } = {}] = await getDb()('tenants').count({ total: '*' });
  if (Number(total) > 1) {
    // Sem status nem code: este controller colapsa toda falha em 400 com a
    // mensagem traduzida, e metadado que ninguém lê é metadado que mente.
    throw new TranslatableError('database.switchNotSoleProvider');
  }
}

export async function switchDatabase(rawConfig, { migrateData = false } = {}) {
  await assertSoleProvider();
  const config = normalizeConfig(rawConfig);
  validateExternal(config);

  const currentConfig = readDbConfig();
  if (isSameConfig(currentConfig, config)) {
    writeDbConfig(config);
    return getActiveConfig();
  }

  // `probeConfig`, e não `testConfig`: o portão já foi conferido no topo, e
  // contar os provedores duas vezes na mesma chamada não protege nada a mais.
  await probeConfig(config);

  const target = knexFactory(buildKnexConfig(config));
  try {
    await ensureSchema(target);

    if (migrateData) {
      const source = getDb();
      await copyData(source, target);
    } else {
      await seedDefaults(target);
    }
  } finally {
    await target.destroy();
  }

  writeDbConfig(config);
  await closePool();

  return getActiveConfig();
}
