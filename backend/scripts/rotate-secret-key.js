import 'dotenv/config';
import { getDb, closePool } from '../src/config/database.js';
import SecretRotationService from '../src/services/secretRotationService.js';

/**
 * Reescreve todo segredo guardado com a chave que está viva agora.
 *
 * O passo que faltava para a rotação da `SECRET_BOX_KEY` ser terminável. A
 * mecânica, as armadilhas e o que este comando NÃO resolve estão em
 * `src/services/secretRotationService.js`; aqui mora só a casca de linha de
 * comando.
 *
 *   node scripts/rotate-secret-key.js --dry-run
 *   node scripts/rotate-secret-key.js
 *
 * A chave nova entra por `SECRET_BOX_KEY` e a anterior por
 * `SECRET_BOX_KEY_PREVIOUS`, no ambiente — nunca por argumento, que iria parar
 * no `ps` e no histórico do shell. As duas de `JWT_SECRET` valem igual, e
 * precisam estar presentes: instalação antiga tem linha na versão 1, que só
 * abre por elas.
 */
async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const desconhecido = args.find((arg) => arg !== '--dry-run');
  if (desconhecido) {
    console.error(`Unknown argument: ${desconhecido}`);
    console.error('Usage: node scripts/rotate-secret-key.js [--dry-run]');
    process.exitCode = 1;
    return;
  }

  try {
    getDb();
    const resumo = await SecretRotationService.run({ dryRun });

    const versoes = Object.entries(resumo.versoes).sort(([a], [b]) => Number(a) - Number(b));
    if (versoes.length === 0) {
      console.log('No stored secrets found. Nothing to rotate.');
      return;
    }
    for (const [versao, quantos] of versoes) {
      console.log(`  key version ${versao}: ${quantos} secret(s)`);
    }

    if (dryRun) {
      console.log('\n--dry-run: nothing was written.');
      return;
    }

    console.log(`\nRewrote ${resumo.reescritas} secret(s) with the live key.`);
    if (resumo.reescritas > 0) {
      // O aviso que evita o desastre seguinte, e que nenhum documento dava: a
      // chave antiga deixa de ser necessária para o BANCO e continua sendo para
      // todo backup tirado antes de agora — e a retenção padrão guarda perto de
      // um ano deles.
      console.log(
        '\nThe previous key is no longer needed to read the live database.\n'
        + 'It IS still needed to restore any backup taken before this run, and the\n'
        + 'default retention keeps about a year of them. File the previous key with\n'
        + 'those dumps before removing it from .env.'
      );
    }
  } catch (error) {
    console.error(`Secret rotation failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
