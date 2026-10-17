#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `agent/` é o programa que o provedor instala na rede dele (`.mjs`, porque roda
// solto, fora deste package.json): um erro de sintaxe ali só apareceria na
// máquina do provedor, depois de instalado.
const roots = ['src', 'scripts', 'test', 'agent'];

function collect(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(target, found);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) found.push(target);
  }
  return found;
}

const files = roots.flatMap((root) => collect(path.join(backendDir, root)));
const failures = [];

await Promise.all(files.map(async (file) => {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    failures.push(`${path.relative(backendDir, file)}\n${error.stderr || error.message}`);
  }
}));

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(`Syntax OK: ${files.length} file(s)`);
