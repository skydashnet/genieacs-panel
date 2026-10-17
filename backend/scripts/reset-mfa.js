import { getDb, closePool } from '../src/config/database.js';
import MfaService from '../src/services/mfaService.js';

/**
 * Desliga o login em duas etapas de alguém que perdeu o celular E os códigos
 * de recuperação, e derruba as sessões abertas dessa pessoa.
 *
 * A equipe do provedor faz isso pela tela (`POST /api/users/:id/mfa-reset`),
 * mas a tela recusa, de propósito, quem ela não pode decidir: o último dono,
 * quem trabalha também em outro provedor, quem opera a plataforma. Para esses
 * a saída é quem tem o servidor — o mesmo raciocínio de `reset-password.js`.
 *
 * O nome de usuário vai por argumento: não é segredo. Depois de rodar, a
 * pessoa entra só com a senha e, num provedor que exige o 2FA, é levada a
 * ativá-lo de novo com o celular novo.
 */
async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: skygenpanel reset-mfa <username>');
    process.exitCode = 1;
    return;
  }

  try {
    const user = await getDb()('users').where({ username }).first('id');
    if (!user) {
      console.error(`User "${username}" not found`);
      process.exitCode = 1;
      return;
    }
    const tinha = await MfaService.resetForUser(user.id);
    console.log(tinha
      ? `Two-step login turned off for "${username}"; their sessions were ended`
      : `"${username}" had no two-step login; their sessions were ended anyway`);
  } catch (error) {
    console.error('Two-step login reset failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
