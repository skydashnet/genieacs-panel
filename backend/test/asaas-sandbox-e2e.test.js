import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FLOWS, cnpjValido, gerarCnpj, isSandboxBaseUrl, looksLikeProductionKey, parseArgs, refusalReasons
} from '../scripts/asaas-sandbox-e2e.js';

/**
 * O roteiro do sandbox do Asaas (`scripts/asaas-sandbox-e2e.js`).
 *
 * O roteiro de verdade é manual e fala com o sandbox — não roda aqui. O que
 * roda é o `--dry-run`: os mesmos oito fluxos, no mesmo banco temporário,
 * contra o Asaas de mentira (`helpers/asaasSandboxMock.js`). É o que pega o
 * roteiro quebrado por uma mudança no painel antes de alguém gastar uma tarde
 * no sandbox para descobrir — e o que prova que as travas (produção, chave,
 * base) recusam antes de qualquer coisa.
 */
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'asaas-sandbox-e2e.js');

function rodar(args, envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  delete env.ASAAS_SANDBOX_API_KEY;
  for (const [nome, valor] of Object.entries(envExtra)) env[nome] = valor;
  // Nem o modo de teste do pai nem um `production` perdido valem para o filho,
  // a não ser que o caso peça.
  if (!('APP_ENV' in envExtra)) env.APP_ENV = 'test';
  if (!('NODE_ENV' in envExtra)) env.NODE_ENV = 'test';
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    filho.stdout.on('data', (parte) => { stdout += parte; });
    filho.stderr.on('data', (parte) => { stderr += parte; });
    filho.on('error', reject);
    filho.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('as peças puras', () => {
  it('gera CNPJ com os dígitos verificadores certos', () => {
    for (let i = 0; i < 200; i += 1) {
      const cnpj = gerarCnpj();
      assert.match(cnpj, /^\d{8}0001\d{2}$/);
      assert.equal(cnpjValido(cnpj), true, cnpj);
    }
    assert.equal(cnpjValido('11.222.333/0001-81'), true);
    assert.equal(cnpjValido('11.222.333/0001-82'), false);
    assert.equal(cnpjValido('00000000000000'), false);
    assert.equal(cnpjValido('123'), false);
  });

  it('só aceita a base do sandbox, em https', () => {
    assert.equal(isSandboxBaseUrl('https://api-sandbox.asaas.com/v3'), true);
    assert.equal(isSandboxBaseUrl('https://sandbox.asaas.com/api/v3'), true);
    assert.equal(isSandboxBaseUrl('https://api.asaas.com/v3'), false);
    assert.equal(isSandboxBaseUrl('http://api-sandbox.asaas.com/v3'), false);
    assert.equal(isSandboxBaseUrl('https://api-sandbox.asaas.com.example.net/v3'), false);
    assert.equal(isSandboxBaseUrl('não é url'), false);
  });

  it('recusa produção, chave ausente, chave de produção e base de fora', () => {
    assert.deepEqual(refusalReasons({ env: { ASAAS_SANDBOX_API_KEY: '$aact_hmlg_abc' }, dryRun: false }), []);
    assert.deepEqual(refusalReasons({ env: {}, dryRun: true }), []);
    assert.equal(refusalReasons({ env: {}, dryRun: false }).length, 1);
    assert.equal(looksLikeProductionKey('$aact_prod_abc'), true);
    assert.equal(looksLikeProductionKey('$aact_hmlg_abc'), false);
    assert.match(refusalReasons({ env: { ASAAS_SANDBOX_API_KEY: '$aact_prod_abc' }, dryRun: false })[0], /production key/);
    assert.match(refusalReasons({ env: { APP_ENV: 'production' }, dryRun: true })[0], /APP_ENV=production/);
    assert.match(refusalReasons({ env: { NODE_ENV: 'production' }, dryRun: true })[0], /NODE_ENV=production/);
    assert.match(refusalReasons({ env: {}, dotenv: { APP_ENV: 'production' }, dryRun: true })[0], /backend\/\.env/);
    assert.match(refusalReasons({
      env: { ASAAS_SANDBOX_API_KEY: '$aact_hmlg_abc', ASAAS_BASE_URL: 'https://api.asaas.com/v3' }, dryRun: false
    })[0], /not the Asaas sandbox/);
  });

  it('lê as opções', () => {
    assert.deepEqual(parseArgs(['--dry-run', '--only', '2,refund', '--report-dir', '/tmp/x', '--keep']), {
      dryRun: true, only: ['2', 'refund'], reportDir: '/tmp/x', keep: true, verbose: false, help: false
    });
    assert.throws(() => parseArgs(['--producao']), /unknown option/);
  });
});

describe('o script', () => {
  it('sem chave e sem --dry-run, recusa antes de começar', async () => {
    const { code, stderr } = await rodar([]);
    assert.equal(code, 2);
    assert.match(stderr, /REFUSED: ASAAS_SANDBOX_API_KEY/);
  });

  it('em produção, recusa até o --dry-run', async () => {
    const { code, stderr } = await rodar(['--dry-run'], { APP_ENV: 'production' });
    assert.equal(code, 2);
    assert.match(stderr, /APP_ENV=production/);
  });

  it('com uma base que não é o sandbox, recusa', async () => {
    const { code, stderr } = await rodar([], {
      ASAAS_SANDBOX_API_KEY: '$aact_hmlg_000000000000000000000000', ASAAS_BASE_URL: 'https://api.asaas.com/v3'
    });
    assert.equal(code, 2);
    assert.match(stderr, /not the Asaas sandbox/);
    assert.equal(stderr.includes('$aact_hmlg_000000000000000000000000'), false, 'a chave não aparece na recusa');
  });

  it('--dry-run: os oito fluxos passam contra o Asaas de mentira, e o relatório não leva segredo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asaas-e2e-report-'));
    try {
      const { code, stdout, stderr } = await rodar(['--dry-run', '--report-dir', dir]);
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      const arquivos = fs.readdirSync(dir).filter((nome) => /^asaas-sandbox-.*\.json$/.test(nome));
      assert.equal(arquivos.length, 1);
      const bruto = fs.readFileSync(path.join(dir, arquivos[0]), 'utf8');
      const relatorio = JSON.parse(bruto);
      assert.equal(relatorio.mode, 'dry-run');
      assert.deepEqual(relatorio.flows.map((f) => f.key), FLOWS.map((f) => f.key));
      for (const fluxo of relatorio.flows) {
        assert.equal(fluxo.status, 'pass', `${fluxo.key}: ${fluxo.error ?? fluxo.reason ?? ''}`);
        assert.ok(Number.isInteger(fluxo.ms));
        assert.ok(Array.isArray(fluxo.steps) && fluxo.steps.length > 0);
      }
      assert.deepEqual(relatorio.summary.pass, FLOWS.length);

      // O que o desconto por antecipação devolveu está no relatório e na tela.
      const desconto = relatorio.flows.find((f) => f.key === 'early_discount').details;
      assert.equal(desconto.settled.value, 89.91);
      assert.equal(desconto.webhookCode, 'recorded');
      assert.match(stdout, /Early discount — what Asaas reports/);
      assert.match(stdout, /8 passed, 0 failed, 0 skipped/);

      // Nem token de cartão, nem número de cartão, nem a chave de mentira.
      for (const saida of [bruto, stdout, stderr]) {
        assert.equal(/tok_mock_[0-9a-f]+/.test(saida), false, 'token de cartão na saída');
        assert.equal(saida.includes('5162306219378829') || saida.includes('5184019740373151'), false, 'número de cartão na saída');
        assert.equal(/mock_[0-9a-f]{32}/.test(saida), false, 'a chave da API na saída');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
