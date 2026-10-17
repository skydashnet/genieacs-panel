/**
 * Reescreve o bloco de retenção de `docs/lgpd-inventario-de-dados.md` a partir
 * de `src/config/retention.js`.
 *
 *   node backend/scripts/render-retention-doc.js           # reescreve
 *   node backend/scripts/render-retention-doc.js --check   # sai com 1 se estiver desatualizado
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceRetentionBlock } from '../src/utils/retentionDoc.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.join(AQUI, '..', '..', 'docs', 'lgpd-inventario-de-dados.md');

const atual = readFileSync(DOC, 'utf8');
const novo = replaceRetentionBlock(atual);
if (novo === null) {
  console.error('O documento não tem os marcadores <!-- retention:begin --> / <!-- retention:end -->.');
  process.exit(2);
}
if (process.argv.includes('--check')) {
  if (novo !== atual) {
    console.error('docs/lgpd-inventario-de-dados.md está desatualizado em relação a src/config/retention.js.');
    process.exit(1);
  }
  console.log('Documento de retenção em dia.');
} else if (novo === atual) {
  console.log('Nada a mudar.');
} else {
  writeFileSync(DOC, novo);
  console.log('Documento de retenção reescrito.');
}
