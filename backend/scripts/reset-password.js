import bcrypt from 'bcryptjs';
import { getDb, closePool } from '../src/config/database.js';

/**
 * Redefine a senha de um operador direto no banco, sem escopo de provedor.
 *
 * A senha vem de `RESET_PASSWORD` ou da entrada padrão, nunca de um argumento:
 * `ps` mostra a linha de comando de qualquer processo para qualquer usuário da
 * máquina, e o histórico do shell guarda o resto. O mesmo raciocínio de
 * `grant-platform-admin.js`.
 *
 * Quem ainda passa a senha como segundo argumento (o uso antigo) recebe uma
 * recusa que diz para onde ela foi — e não uma redefinição silenciosa, que
 * deixaria a senha nova registrada exatamente onde não deveria estar.
 */
const USO = [
  'Usage: RESET_PASSWORD=<newPassword> npm run reset-password -- <username>',
  '       printf %s "$PASS" | npm run reset-password -- <username>',
  '       (password from RESET_PASSWORD or stdin, never as an argument)'
];

/** A senha, de onde não fica registrada: variável de ambiente ou entrada padrão. */
async function senhaDeFora() {
  const doAmbiente = process.env.RESET_PASSWORD;
  if (doAmbiente) return doAmbiente;
  if (process.stdin.isTTY) return null;
  const pedacos = [];
  for await (const pedaco of process.stdin) pedacos.push(pedaco);
  return Buffer.concat(pedacos).toString('utf8').replace(/\r?\n$/, '') || null;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const username = args[0];

  if (args.length > 1) {
    console.error('Refusing a password given as an argument: it would show up in `ps` and in the shell history.');
    console.error('Pass it in RESET_PASSWORD or on stdin instead.');
    for (const linha of USO) console.error(linha);
    process.exitCode = 1;
    return;
  }

  if (!username) {
    for (const linha of USO) console.error(linha);
    process.exitCode = 1;
    return;
  }

  const password = await senhaDeFora();
  if (!password) {
    console.error('No password given: set RESET_PASSWORD or pipe it on stdin.');
    for (const linha of USO) console.error(linha);
    process.exitCode = 1;
    return;
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exitCode = 1;
    return;
  }

  try {
    const db = getDb();
    const user = await db('users').where({ username }).first('id');
    if (!user) {
      console.error(`User "${username}" not found`);
      process.exitCode = 1;
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    await db('users').where({ username }).update({
      password: hashed,
      token_version: db.raw('token_version + 1'),
      updated_at: new Date()
    });
    console.log(`Password updated for "${username}"`);
  } catch (error) {
    console.error('Password reset failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
