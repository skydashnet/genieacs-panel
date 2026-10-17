import bcrypt from 'bcryptjs';
import { getDb, closePool } from '../src/config/database.js';
import PlatformAdmin from '../src/models/PlatformAdmin.js';
import User from '../src/models/User.js';
import { isValidEmail } from '../src/utils/helpers.js';

/**
 * Hands the control plane to somebody on an install that already has users.
 *
 * The other bootstrap path is `setup`, which only exists for an install with no
 * users at all, so an existing deployment upgrading into the control plane has
 * no way in — and the migration deliberately promotes nobody. This is that way
 * in, and it is a shell script rather than a route on purpose: the person who
 * can run it is the person who holds the server, which is exactly who should be
 * deciding who may mint providers.
 *
 * It takes a username rather than an id because that is what the operator
 * knows, and it is read straight off `users` — outside any provider scope,
 * since a platform administrator is not a member of one. `--revoke` is here
 * because the same person who can grant this has to be able to take it back
 * without opening a SQL client.
 *
 * `--create` é o terceiro modo, e é o que faz a conta-raiz da plataforma
 * deixar de pertencer a um provedor.
 *
 * Até aqui a primeira chave nascia no `/setup`, que cria o primeiro operador de
 * UM provedor e, na edição SaaS, o põe no cadastro de quebra — ou seja, quem
 * opera a plataforma era membro do provedor `default`, que é exatamente a
 * contradição que o console fora de provedor existe para desfazer. Com
 * `--create` a conta nasce sem NENHUMA linha em `tenant_users`: ela entra no
 * console, no endereço da plataforma, e em painel de provedor nenhum — o login
 * de lá recusa quem não tem vínculo, sem mudança alguma.
 *
 * Script e não rota, pelo motivo de sempre e por mais um: uma rota de criação
 * no ápice seria pública, criando a conta de maior privilégio do deploy,
 * trancada só por "não existe ninguém ainda" — e num SaaS onde ISPs se cadastram
 * sozinhos esse contador não fica em zero.
 *
 * A senha vem de `PLATFORM_ADMIN_PASSWORD` ou da entrada padrão, nunca de um
 * argumento: argumento aparece em `ps` e no histórico do shell.
 */
/** O valor de `--flag=x` ou de `--flag x`, ou null. */
function opcao(args, nome) {
  const igual = args.find((arg) => arg.startsWith(`${nome}=`));
  if (igual) return igual.slice(nome.length + 1);
  const posicao = args.indexOf(nome);
  if (posicao === -1) return null;
  const seguinte = args[posicao + 1];
  return seguinte && !seguinte.startsWith('--') ? seguinte : null;
}

/**
 * A senha, de onde não fica registrada: variável de ambiente ou entrada padrão.
 *
 * Nunca de um argumento — `ps` mostra a linha de comando de qualquer processo
 * para qualquer usuário da máquina, e o histórico do shell guarda o resto.
 */
async function senhaDeFora() {
  const doAmbiente = process.env.PLATFORM_ADMIN_PASSWORD;
  if (doAmbiente) return doAmbiente;
  if (process.stdin.isTTY) return null;
  const pedacos = [];
  for await (const pedaco of process.stdin) pedacos.push(pedaco);
  return Buffer.concat(pedacos).toString('utf8').trim() || null;
}

/**
 * Cria uma conta de plataforma: sem vínculo com provedor nenhum.
 *
 * Numa transação com a linha do cadastro, porque uma conta criada sem a chave
 * é uma conta que não entra em lugar nenhum — nem no console, que ela deveria
 * abrir, nem num painel, onde ela não tem vínculo. Meio caminho aqui é lixo
 * que alguém teria de limpar à mão.
 */
async function criar({ username, email, password }) {
  const conflito = await User.loginConflict({ username, email });
  if (conflito) {
    console.error(conflito === 'email_taken'
      ? `E-mail "${email}" já está em uso`
      : `User "${username}" already exists`);
    process.exitCode = 1;
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  const db = getDb();
  const id = await db.transaction(async (trx) => {
    const novoId = await User.create({ username, email, password: hash, role: 'viewer' }, trx);
    await trx('platform_admins').insert({ user_id: novoId });
    return novoId;
  });

  console.log(`Platform administrator created: "${username}" (id ${id})`);
  console.log('This account belongs to no provider: it signs in at the platform address only.');
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const revoke = args.includes('--revoke');
  const create = args.includes('--create');
  const email = opcao(args, '--email');
  const username = args.find((arg) => !arg.startsWith('--') && arg !== email);

  if (!username) {
    console.error('Usage: node scripts/grant-platform-admin.js <username> [--revoke]');
    console.error('       node scripts/grant-platform-admin.js <username> --create --email <address>');
    console.error('       (password from PLATFORM_ADMIN_PASSWORD or stdin)');
    process.exitCode = 1;
    return;
  }

  try {
    if (create) {
      // E-mail obrigatório porque toda conta nasce com um desde a fase do login
      // por e-mail: sem ele, esta conta não teria como recuperar a própria
      // senha nem de longe — e a do console não passa por redefinição na tela.
      if (!email || !isValidEmail(email)) {
        console.error('--create needs a valid --email');
        process.exitCode = 1;
        return;
      }
      const password = await senhaDeFora();
      if (!password || password.length < 8 || password.length > 128) {
        console.error('Password must come from PLATFORM_ADMIN_PASSWORD or stdin, 8 to 128 characters');
        process.exitCode = 1;
        return;
      }
      await criar({ username, email, password });
      return;
    }

    const db = getDb();
    const user = await db('users').where({ username }).first('id');
    if (!user) {
      console.error(`User "${username}" not found`);
      process.exitCode = 1;
      return;
    }

    if (revoke) {
      const removed = await PlatformAdmin.remove(user.id);
      console.log(removed
        ? `Platform administrator revoked from "${username}"`
        : `"${username}" was not a platform administrator`);
      return;
    }

    // Running it twice is not a mistake to punish: whoever holds the server
    // will run it again to check that it took. Saying which of the two
    // happened is the useful part, and neither is a failure.
    const added = await PlatformAdmin.add(user.id);
    console.log(added
      ? `Platform administrator granted to "${username}"`
      : `"${username}" is already a platform administrator`);
  } catch (error) {
    console.error('Platform administrator grant failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
