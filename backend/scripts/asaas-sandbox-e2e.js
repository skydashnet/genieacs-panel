#!/usr/bin/env node
/**
 * Teste ponta a ponta da cobrança contra o SANDBOX do Asaas — manual, fora do
 * CI.
 *
 * ## Uso
 *
 *   # contra o sandbox de verdade (a chave é a do sandbox, `$aact_hmlg_…`)
 *   ASAAS_SANDBOX_API_KEY='$aact_hmlg_…' npm run e2e:asaas-sandbox
 *
 *   # o mesmo roteiro contra o gateway de mentira dos testes, sem rede nem chave
 *   npm run e2e:asaas-sandbox -- --dry-run
 *
 * Opções:
 *
 *   --dry-run            usa o Asaas de mentira (`test/helpers/asaasSandboxMock.js`)
 *   --only 2,4,refund    roda só os fluxos pedidos (número ou nome)
 *   --report-dir <dir>   onde gravar o JSON (padrão: `backend/reports/`)
 *   --keep               não cancela no gateway as cobranças que ficaram em aberto
 *   --verbose            mostra o log dos serviços (sempre sem chave e sem token)
 *   --help               esta ajuda
 *
 * Variáveis opcionais (só no modo de verdade):
 *
 *   ASAAS_SANDBOX_REMOTE_IP           IP mandado na tokenização e na cobrança de cartão (padrão 127.0.0.1)
 *   ASAAS_SANDBOX_CARD_APPROVED       cartão de teste aprovado (padrão 5162306219378829)
 *   ASAAS_SANDBOX_CARD_REFUSED        cartão de teste recusado (padrão 5184019740373151)
 *   ASAAS_SANDBOX_NFSE_SERVICE_CODE   código do serviço municipal da NFS-e (padrão 01.07)
 *   ASAAS_SANDBOX_NFSE_SERVICE_ID     id do serviço municipal na Asaas (ganha do código, se posto)
 *
 * ## O que ele recusa
 *
 * - Rodar sem `ASAAS_SANDBOX_API_KEY` (fora do `--dry-run`), ou com uma chave
 *   de produção (`$aact_prod_…`).
 * - Rodar com `NODE_ENV`/`APP_ENV` de produção — no ambiente do processo OU no
 *   `backend/.env`.
 * - Falar com qualquer base que não seja a do sandbox
 *   (`api-sandbox.asaas.com` / `sandbox.asaas.com`): conferido antes da
 *   primeira chamada, com a base que o próprio `asaasClient` vai usar.
 *
 * ## Como ele roda
 *
 * Num banco SQLite TEMPORÁRIO (um `DATA_DIR` em `os.tmpdir()`, apagado no fim),
 * com as migrações de sempre (`ensureSchema` + `seedDefaults`, como o
 * `test/helpers/harness.js`). Semeia a caixa da plataforma, um provedor de
 * teste com CNPJ gerado (dígitos verificadores válidos), um plano de R$ 99,90 e
 * a configuração `asaas_gateway_config` apontada para o sandbox com a chave.
 * Nada do banco de quem roda é tocado — nem lido.
 *
 * O webhook público não entra: cada fluxo lê o pagamento com
 * `GET /payments/{id}` e entrega esse corpo ao `BillingWebhookController`
 * local, chamado direto com um `req`/`res` montados aqui.
 *
 * ## Os fluxos
 *
 *   1. customer          cliente criado no gateway por `ensureAsaasCustomer`
 *   2. renewal           renovação emitida (`issueCurrent`), paga por `receiveInCash`,
 *                        `GET /payments/{id}` entregue como PAYMENT_RECEIVED: o prazo anda
 *   3. charge_terms      multa, juros e desconto configurados aparecem na cobrança do gateway
 *   4. card_approved     cartão de teste aprovado tokenizado, salvo, renovação no vencimento
 *                        cobrada no cartão (CONFIRMED)
 *   5. card_refused      cartão de recusa: a renovação volta para Pix/boleto (UNDEFINED)
 *   6. refund            pagamento de cartão estornado pelo caminho do console
 *   7. nfse              NFS-e ligada e emitida; conta sem NFS-e habilitada vira "pulado"
 *   8. early_discount    o que o Asaas devolve (`value`, `netValue`, `originalValue`) num
 *                        pagamento com desconto por antecipação
 *
 * Cada fluxo prepara o próprio estado (assinatura, cobranças e configuração
 * zeradas) e termina em passou, falhou ou pulado, com os detalhes e o tempo.
 *
 * ## Saída
 *
 * Uma tabela no terminal e um JSON em `backend/reports/asaas-sandbox-<data>.json`
 * (fora do git). A chave da API, o token do webhook e os tokens de cartão
 * NUNCA aparecem em nenhum dos dois: tudo o que sai passa por `limpar`.
 *
 * Código de saída: 0 sem falhas, 1 com alguma falha, 2 recusado antes de começar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

/** As bases que o modo de verdade aceita. Qualquer outra é recusa. */
export const SANDBOX_HOSTS = Object.freeze(['api-sandbox.asaas.com', 'sandbox.asaas.com']);

export const DEFAULT_APPROVED_CARD = '5162306219378829';
export const DEFAULT_REFUSED_CARD = '5184019740373151';

export const FLOWS = Object.freeze([
  { id: 1, key: 'customer', title: 'Cliente no gateway' },
  { id: 2, key: 'renewal', title: 'Renovação Pix/boleto + baixa + webhook' },
  { id: 3, key: 'charge_terms', title: 'Multa, juros e desconto na cobrança' },
  { id: 4, key: 'card_approved', title: 'Cartão aprovado na renovação' },
  { id: 5, key: 'card_refused', title: 'Cartão recusado volta para Pix/boleto' },
  { id: 6, key: 'refund', title: 'Estorno pelo console' },
  { id: 7, key: 'nfse', title: 'NFS-e' },
  { id: 8, key: 'early_discount', title: 'Desconto por antecipação: valores do Asaas' }
]);

// ── Peças puras (exportadas para o teste) ───────────────────────────────

/** Os dois dígitos verificadores de um CNPJ, dos doze primeiros. */
function digitosCnpj(doze) {
  const dv = (numeros) => {
    const pesos = numeros.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = numeros.reduce((acc, n, i) => acc + n * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(doze);
  const d2 = dv([...doze, d1]);
  return [d1, d2];
}

/** Um CNPJ de matriz (`/0001`) com os dígitos verificadores certos. */
export function gerarCnpj(random = (max) => crypto.randomInt(max)) {
  let raiz;
  do {
    raiz = Array.from({ length: 8 }, () => random(10));
  } while (new Set(raiz).size === 1);
  const doze = [...raiz, 0, 0, 0, 1];
  return [...doze, ...digitosCnpj(doze)].join('');
}

/** Se o CNPJ (só dígitos ou formatado) tem os verificadores certos. */
export function cnpjValido(valor) {
  const numeros = String(valor ?? '').replace(/\D/g, '').split('').map(Number);
  if (numeros.length !== 14 || new Set(numeros).size === 1) return false;
  const [d1, d2] = digitosCnpj(numeros.slice(0, 12));
  return numeros[12] === d1 && numeros[13] === d2;
}

/** Se a base é a do sandbox do Asaas — https e um dos `SANDBOX_HOSTS`. */
export function isSandboxBaseUrl(base) {
  try {
    const url = new URL(String(base));
    return url.protocol === 'https:' && SANDBOX_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Uma chave que se anuncia como de produção (`$aact_prod_…`). */
export function looksLikeProductionKey(chave) {
  return /(^|\$)aact_prod_/i.test(String(chave ?? '').trim());
}

/**
 * Os motivos para NÃO rodar, antes de carregar qualquer módulo do painel.
 *
 * @param {{ env: object, dotenv: object|null, dryRun: boolean }} entrada
 * @returns {string[]} vazio quando pode rodar
 */
export function refusalReasons({ env, dotenv = null, dryRun }) {
  const motivos = [];
  for (const [origem, fonte] of [['environment', env], ['backend/.env', dotenv ?? {}]]) {
    for (const nome of ['NODE_ENV', 'APP_ENV']) {
      if (String(fonte[nome] ?? '').trim().toLowerCase() === 'production') {
        motivos.push(`${nome}=production in the ${origem}; this script never runs in production`);
      }
    }
  }
  if (!dryRun) {
    const chave = String(env.ASAAS_SANDBOX_API_KEY ?? '').trim();
    if (!chave) motivos.push('ASAAS_SANDBOX_API_KEY is not set (or use --dry-run)');
    else if (looksLikeProductionKey(chave)) motivos.push('ASAAS_SANDBOX_API_KEY is a production key ($aact_prod_…)');
    else if (/\s/.test(chave)) motivos.push('ASAAS_SANDBOX_API_KEY contains whitespace');
    const forcada = String(env.ASAAS_BASE_URL ?? '').trim();
    if (forcada && !isSandboxBaseUrl(forcada)) {
      motivos.push(`ASAAS_BASE_URL points to ${forcada}, which is not the Asaas sandbox`);
    }
  }
  return motivos;
}

export function parseArgs(argv) {
  const opcoes = { dryRun: false, only: null, reportDir: null, keep: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opcoes.dryRun = true;
    else if (arg === '--keep') opcoes.keep = true;
    else if (arg === '--verbose') opcoes.verbose = true;
    else if (arg === '--help' || arg === '-h') opcoes.help = true;
    else if (arg === '--only') opcoes.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--only=')) opcoes.only = arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--report-dir') opcoes.reportDir = argv[++i] ?? null;
    else if (arg.startsWith('--report-dir=')) opcoes.reportDir = arg.slice(13);
    else throw new Error(`unknown option: ${arg}`);
  }
  return opcoes;
}

// ── Segredos fora da saída ──────────────────────────────────────────────

const segredos = new Set();
function guardarSegredo(valor) {
  const texto = String(valor ?? '').trim();
  if (texto.length >= 6) segredos.add(texto);
}

/** O texto sem nenhum segredo conhecido. */
function limpar(texto) {
  let saida = String(texto ?? '');
  for (const segredo of segredos) {
    if (saida.includes(segredo)) saida = saida.split(segredo).join('[redacted]');
  }
  return saida;
}

/** Cópia profunda sem segredos: chaves com cara de token somem, e o texto passa por `limpar`. */
function limparObjeto(valor) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return limpar(valor);
  if (typeof valor !== 'object') return valor;
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.map(limparObjeto);
  const saida = {};
  for (const [chave, item] of Object.entries(valor)) {
    if (/token|access_?key|apiKey|ciphertext|ccv/i.test(chave)) {
      saida[chave] = item === null || item === undefined ? item : '[redacted]';
    } else {
      saida[chave] = limparObjeto(item);
    }
  }
  return saida;
}

// ── O roteiro ───────────────────────────────────────────────────────────

class Pulado extends Error {
  constructor(motivo, detalhes = {}) {
    super(motivo);
    this.name = 'Pulado';
    this.detalhes = detalhes;
  }
}

class Falhou extends Error {
  constructor(mensagem, detalhes = {}) {
    super(mensagem);
    this.name = 'Falhou';
    this.detalhes = detalhes;
  }
}

function conferir(condicao, mensagem, detalhes = {}) {
  if (!condicao) throw new Falhou(mensagem, detalhes);
}

const DIA = 86_400_000;
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const msDe = (valor) => (valor ? new Date(valor).getTime() : null);
const iso = (valor) => (valor ? new Date(valor).toISOString() : null);

function ajuda() {
  const linhas = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const fim = linhas.findIndex((l, i) => i > 0 && l.trim() === '*/');
  return linhas.slice(2, fim).map((l) => l.replace(/^ \* ?/, '')).join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const escrever = (texto = '') => process.stdout.write(`${limpar(texto)}\n`);
  let opcoes;
  try {
    opcoes = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (opcoes.help) {
    escrever(ajuda());
    return 0;
  }

  // O `.env` lido, mas não aplicado: só para a recusa de produção.
  let dotenvLido = null;
  try {
    const caminho = path.join(BACKEND_DIR, '.env');
    if (fs.existsSync(caminho)) {
      const { default: dotenv } = await import('dotenv');
      dotenvLido = dotenv.parse(fs.readFileSync(caminho));
    }
  } catch {
    dotenvLido = null;
  }
  const motivos = refusalReasons({ env: process.env, dotenv: dotenvLido, dryRun: opcoes.dryRun });
  if (motivos.length) {
    for (const motivo of motivos) process.stderr.write(`REFUSED: ${motivo}\n`);
    return 2;
  }

  const modo = opcoes.dryRun ? 'dry-run' : 'sandbox';
  const chave = opcoes.dryRun
    ? `mock_${crypto.randomBytes(16).toString('hex')}`
    : String(process.env.ASAAS_SANDBOX_API_KEY).trim();
  const webhookToken = crypto.randomBytes(32).toString('base64url');
  guardarSegredo(chave);
  guardarSegredo(webhookToken);
  const remoteIp = opcoes.dryRun ? '127.0.0.1' : (process.env.ASAAS_SANDBOX_REMOTE_IP || '127.0.0.1');
  const cartaoAprovado = (opcoes.dryRun ? null : process.env.ASAAS_SANDBOX_CARD_APPROVED) || DEFAULT_APPROVED_CARD;
  const cartaoRecusado = (opcoes.dryRun ? null : process.env.ASAAS_SANDBOX_CARD_REFUSED) || DEFAULT_REFUSED_CARD;
  // O número inteiro do cartão de teste não é segredo, mas também não precisa sair.
  guardarSegredo(cartaoAprovado);
  guardarSegredo(cartaoRecusado);

  let mock = null;
  if (opcoes.dryRun) {
    const { startAsaasSandboxMock } = await import('../test/helpers/asaasSandboxMock.js');
    mock = await startAsaasSandboxMock({ apiKey: chave });
  }

  // O ambiente inteiro ANTES de qualquer import do painel: os módulos leem
  // variáveis no carregamento, e o `dotenv/config` de `runtimeEnv` não
  // sobrescreve o que já está posto — então cada variável que importa é
  // ATRIBUÍDA (vazia, quando é para não valer), nunca apagada.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asaas-sandbox-e2e-'));
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    APP_ENV: 'e2e',
    NODE_ENV: 'test',
    EDITION: 'selfhosted',
    JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    JWT_SECRET_PREVIOUS: '',
    PORTAL_JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    SECRET_BOX_KEY: crypto.randomBytes(48).toString('hex'),
    SECRET_BOX_KEY_PREVIOUS: '',
    RLS_ENABLED: '',
    TRUST_PROXY: '0',
    // Sem SMTP: o aviso de cartão recusado não sai para ninguém.
    SMTP_URL: '',
    MAIL_FROM: '',
    // A chave e o token vão para a caixa da plataforma, não para o ambiente.
    ASAAS_API_KEY: '',
    BILLING_WEBHOOK_TOKEN: '',
    ASAAS_BASE_URL: mock ? mock.url : ''
  });

  // O log dos serviços, guardado (limpo) e só mostrado com --verbose.
  const logs = [];
  const originais = {};
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) {
    originais[nivel] = console[nivel];
    console[nivel] = (...args) => {
      const linha = limpar(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      logs.push({ level: nivel, at: new Date().toISOString(), line: linha.slice(0, 2000) });
      if (opcoes.verbose) process.stderr.write(`  [${nivel}] ${linha}\n`);
    };
  }

  const inicio = Date.now();
  const relatorio = {
    tool: 'asaas-sandbox-e2e',
    mode: modo,
    startedAt: new Date(inicio).toISOString(),
    finishedAt: null,
    baseUrl: null,
    flows: [],
    summary: null,
    cleanup: [],
    logs: []
  };

  let fecharBanco = async () => {};
  let codigo = 0;
  try {
    const { getDb, closePool, tdb } = await import('../src/config/database.js');
    fecharBanco = closePool;
    const { ensureSchema } = await import('../src/config/schema.js');
    const { seedDefaults } = await import('../src/config/seed.js');
    const { runInTenant, runUnscoped } = await import('../src/config/tenantContext.js');
    const { default: Plan } = await import('../src/models/Plan.js');
    const { default: Subscription } = await import('../src/models/Subscription.js');
    const { default: Tenant } = await import('../src/models/Tenant.js');
    const { default: BillingCharge } = await import('../src/models/BillingCharge.js');
    const { default: BillingInvoice } = await import('../src/models/BillingInvoice.js');
    const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
    const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
    const { default: CardAutopayService, CARD_TOKEN_CONTEXT } = await import('../src/services/billing/cardAutopayService.js');
    const { default: BillingInvoiceService } = await import('../src/services/billing/billingInvoiceService.js');
    const { default: BillingWebhookController } = await import('../src/controllers/billingWebhookController.js');
    const { default: PlatformSubscriptionsController } = await import('../src/controllers/platformSubscriptionsController.js');
    const { ensureAsaasCustomer } = await import('../src/services/billing/asaasCustomerService.js');
    const asaasSettings = await import('../src/services/billing/asaasSettingsService.js');
    const asaasClient = await import('../src/services/billing/asaasClient.js');
    const { createSecretBox } = await import('../src/utils/secretBox.js');

    // ── O banco e a semente ─────────────────────────────────────────────
    await ensureSchema();
    await seedDefaults();
    const db = getDb();
    const semRede = (motivo, fn) => runUnscoped(`asaas-sandbox-e2e: ${motivo}`, fn);

    let caixa = await Tenant.platform();
    if (!caixa) {
      await semRede('seeding the platform box', () => db('tenants').insert({
        slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform'
      }));
      caixa = await Tenant.platform();
    }
    const provedor = await semRede('picking the test provider', () => db('tenants')
      .whereNot({ kind: 'platform' }).orderBy('id', 'asc').first());
    if (!provedor) throw new Error('the migrations created no provider');
    const tenantId = provedor.id;
    const cnpj = gerarCnpj();
    const emailDeTeste = `financeiro+e2e-${Date.now()}@example.com`;
    await semRede('filling the test provider billing details', () => db('tenants').where({ id: tenantId }).update({
      name: 'Provedor E2E Sandbox',
      status: 'active',
      billing_legal_name: 'Provedor E2E Sandbox LTDA',
      billing_tax_id: cnpj,
      billing_email: emailDeTeste,
      billing_phone: '11987654321',
      billing_postal_code: '01310100',
      billing_address_line: 'Avenida Paulista',
      billing_address_number: '1000',
      billing_district: 'Bela Vista',
      billing_gateway: null,
      billing_customer_ref: null
    }));
    const plano = await Plan.create({
      code: `e2e-sandbox-${Date.now()}`, name: 'E2E Sandbox', price_cents: 9990, currency: 'BRL',
      period_days: 30, trial_days: 0, active: true
    });

    await asaasSettings.save({ environment: 'sandbox', apiKey: chave, webhookToken });
    asaasSettings.invalidateAsaasSettings();

    // ── A trava da base, com a base que o cliente vai mesmo usar ─────────
    const base = await asaasClient.baseUrl();
    relatorio.baseUrl = base;
    const ambiente = await asaasSettings.effectiveEnvironment();
    if (opcoes.dryRun) {
      if (!base.startsWith('http://127.0.0.1:')) throw new Error(`dry-run expected the local mock, got ${base}`);
    } else if (!isSandboxBaseUrl(base) || ambiente !== 'sandbox') {
      // Antes de qualquer chamada: nada saiu ainda.
      process.stderr.write(`REFUSED: the gateway base is ${base} (${ambiente}), not the Asaas sandbox\n`);
      codigo = 2;
      return codigo;
    }

    // ── Ferramentas dos fluxos ──────────────────────────────────────────

    /** Chamada crua ao gateway — para o que o `asaasClient` não expõe (o corpo inteiro). */
    async function gateway(method, caminho, payload = null) {
      const url = `${await asaasClient.baseUrl()}${caminho}`;
      if (!opcoes.dryRun && !isSandboxBaseUrl(url)) throw new Error(`refusing to call ${url}`);
      const resposta = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'TR69-Controle-e2e', access_token: await asaasClient.apiKey() },
        body: payload === null ? undefined : JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000)
      });
      const texto = await resposta.text();
      let corpo = null;
      try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = texto; }
      return { status: resposta.status, ok: resposta.ok, body: corpo };
    }

    const lerPagamento = async (id) => {
      const r = await gateway('GET', `/payments/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Falhou(`GET /payments/${id} answered ${r.status}`, { body: r.body });
      return r.body;
    };

    /** Os campos de um pagamento que interessam ao relatório. */
    const resumoPagamento = (p) => ({
      id: p?.id ?? null,
      status: p?.status ?? null,
      billingType: p?.billingType ?? null,
      value: p?.value ?? null,
      netValue: p?.netValue ?? null,
      originalValue: p?.originalValue ?? null,
      dueDate: p?.dueDate ?? null,
      paymentDate: p?.paymentDate ?? null,
      clientPaymentDate: p?.clientPaymentDate ?? null,
      confirmedDate: p?.confirmedDate ?? null,
      fine: p?.fine ?? null,
      interest: p?.interest ?? null,
      discount: p?.discount ?? null,
      externalReference: p?.externalReference ?? null
    });

    /** O webhook entregue ao controlador local, como o Express o entregaria. */
    async function entregarWebhook(evento, pagamento) {
      const corpo = {
        id: `evt_e2e_${crypto.randomBytes(6).toString('hex')}`,
        event: evento,
        dateCreated: new Date().toISOString().slice(0, 19).replace('T', ' '),
        payment: pagamento
      };
      const cabecalhos = { 'asaas-access-token': webhookToken, 'content-type': 'application/json' };
      const req = {
        body: corpo, headers: cabecalhos, ip: '127.0.0.1', method: 'POST',
        get: (nome) => cabecalhos[String(nome).toLowerCase()]
      };
      const res = respostaFalsa();
      await BillingWebhookController.receive(req, res);
      if (BillingWebhookController.pendingCardWork) await BillingWebhookController.pendingCardWork;
      return { status: res.statusCode, body: res.body };
    }

    function respostaFalsa() {
      const res = {
        statusCode: 200,
        body: undefined,
        headers: {},
        status(codigoHttp) { res.statusCode = codigoHttp; return res; },
        json(corpo) { res.body = corpo; return res; },
        send(corpo) { res.body = corpo; return res; },
        set(nome, valor) { res.headers[nome] = valor; return res; },
        setHeader(nome, valor) { res.headers[nome] = valor; }
      };
      return res;
    }

    const assinatura = () => Subscription.forTenant(tenantId);
    const hoje = () => ChargeIssuingService.isoDate(new Date());
    const emitir = (opcoesDeEmissao) => runInTenant(tenantId, async () => ChargeIssuingService.issueCurrent({
      tenant: await Tenant.findById(tenantId), ...opcoesDeEmissao
    }));
    const linhaDaCobranca = (gatewayId) => runInTenant(tenantId, () => BillingCharge.byGatewayId(gatewayId));

    /** As cobranças criadas no gateway nesta rodada — para a faxina do fim. */
    const criadas = new Set();
    const anotarCriada = (resultado) => {
      if (resultado?.chargeId) criadas.add(String(resultado.chargeId));
      return resultado;
    };

    /** O estado de partida de cada fluxo: nada em aberto, nada configurado. */
    async function prepararFluxo({ renewsAt, charges = null, nfse = null, cartao = null }) {
      await runInTenant(tenantId, async () => {
        await tdb('billing_invoices').del();
        await tdb('billing_charges').del();
        await tdb('billing_events').del();
      });
      const zeros = { finePercent: 0, interestMonthlyPercent: 0, discountKind: 'percent', discountValue: 0, discountDaysBefore: 0 };
      await asaasSettings.save({ ...zeros, ...(charges ?? {}), nfseEnabled: false, ...(nfse ?? {}) });
      asaasSettings.invalidateAsaasSettings();
      let colunasDoCartao = { card_autopay_at: null, card_remote_ip: null, ...CardAutopayService.CLEARED_CARD };
      if (cartao) {
        const cifrado = createSecretBox(CARD_TOKEN_CONTEXT).encrypt(cartao.token);
        colunasDoCartao = {
          ...colunasDoCartao,
          card_autopay_at: aoSegundo(Date.now() - 60_000),
          card_remote_ip: remoteIp,
          card_token_ciphertext: cifrado.password_ciphertext,
          card_token_iv: cifrado.password_iv,
          card_token_tag: cifrado.password_tag,
          card_token_key_version: cifrado.password_key_version,
          card_brand: cartao.brand ?? null,
          card_last4: cartao.last4 ?? null,
          card_saved_at: aoSegundo(Date.now() - 60_000)
        };
      }
      await Subscription.upsertForTenant(tenantId, {
        plan_id: plano.id,
        status: 'active',
        renews_at: renewsAt,
        trial_ends_at: null,
        canceled_at: null,
        pending_plan_id: null,
        pending_plan_at: null,
        pending_plan_locked_at: null,
        upgraded_at: null,
        billing_exempt_at: null,
        suspended_reason: null,
        proration_due_at: null,
        ...colunasDoCartao
      });
      await SubscriptionService.invalidate(tenantId);
    }

    let clienteMemo = null;
    /** O cliente no gateway: o do fluxo 1, ou criado aqui quando ele não rodou. */
    async function garantirCliente() {
      if (clienteMemo) return clienteMemo;
      const tenant = await Tenant.findById(tenantId);
      if (tenant.billing_customer_ref && tenant.billing_gateway === 'asaas') {
        clienteMemo = tenant.billing_customer_ref;
        return clienteMemo;
      }
      try {
        clienteMemo = (await ensureAsaasCustomer(tenantId)).customerRef;
      } catch (error) {
        throw new Pulado(`no gateway customer to charge (customer creation failed: ${error.message})`);
      }
      return clienteMemo;
    }

    const tokensMemo = new Map();
    /** Tokeniza um cartão de teste — `POST /creditCard/tokenizeCreditCard`. */
    async function tokenizar(numero) {
      if (tokensMemo.has(numero)) return tokensMemo.get(numero);
      const cliente = await garantirCliente();
      const ano = new Date().getUTCFullYear() + 3;
      const r = await gateway('POST', '/creditCard/tokenizeCreditCard', {
        customer: cliente,
        creditCard: {
          holderName: 'PROVEDOR E2E SANDBOX', number: numero, expiryMonth: '12', expiryYear: String(ano), ccv: '123'
        },
        creditCardHolderInfo: {
          name: 'Provedor E2E Sandbox LTDA',
          email: emailDeTeste,
          cpfCnpj: cnpj,
          postalCode: '01310100',
          addressNumber: '1000',
          mobilePhone: '11987654321'
        },
        remoteIp
      });
      if (!r.ok || !r.body?.creditCardToken) {
        const resultado = { error: `tokenization answered ${r.status}`, body: r.body };
        tokensMemo.set(numero, resultado);
        return resultado;
      }
      guardarSegredo(r.body.creditCardToken);
      const resultado = {
        token: r.body.creditCardToken,
        brand: r.body.creditCardBrand ? String(r.body.creditCardBrand) : null,
        last4: r.body.creditCardNumber ? String(r.body.creditCardNumber).replace(/\D/g, '').slice(-4) : null
      };
      tokensMemo.set(numero, resultado);
      return resultado;
    }

    /** Emite, confere que saiu, e devolve o resultado. */
    async function emitirConferindo(opcoesDeEmissao, esperado = {}) {
      const r = anotarCriada(await emitir(opcoesDeEmissao));
      conferir(r.issued === true, `issueCurrent did not issue (${r.reason ?? 'unknown'})`, {
        reason: r.reason ?? null, error: r.error ?? null
      });
      if (esperado.billingType) {
        conferir(r.billingType === esperado.billingType,
          `expected billingType ${esperado.billingType}, got ${r.billingType}`, { billingType: r.billingType });
      }
      return r;
    }

    /** Pagamento pago via webhook, com o prazo conferido andando. */
    async function creditarPeloWebhook(evento, pagamento, prazoAntes) {
      const entrega = await entregarWebhook(evento, pagamento);
      conferir(entrega.status === 200, `webhook answered ${entrega.status}`, { body: entrega.body });
      conferir(entrega.body?.code === 'recorded', `webhook code ${entrega.body?.code}, expected recorded`, { body: entrega.body });
      const depois = await assinatura();
      conferir(msDe(depois.renews_at) > msDe(prazoAntes), 'renews_at did not move forward', {
        before: iso(prazoAntes), after: iso(depois.renews_at)
      });
      return { entrega, depois };
    }

    // ── Os fluxos ───────────────────────────────────────────────────────

    const implementacoes = {
      async customer(ctx) {
        await semRede('unlinking the test provider before the customer flow', () => db('tenants')
          .where({ id: tenantId }).update({ billing_gateway: null, billing_customer_ref: null }));
        clienteMemo = null;
        const criado = await ctx.step('ensureAsaasCustomer', () => ensureAsaasCustomer(tenantId));
        conferir(criado.created === true, 'ensureAsaasCustomer did not create a customer');
        conferir(/^cus_/.test(String(criado.customerRef)), `unexpected customer id ${criado.customerRef}`);
        clienteMemo = criado.customerRef;
        const lido = await ctx.step('GET /customers/{id}', () => gateway('GET', `/customers/${encodeURIComponent(criado.customerRef)}`));
        conferir(lido.ok, `GET /customers answered ${lido.status}`, { body: lido.body });
        conferir(String(lido.body?.cpfCnpj ?? '').replace(/\D/g, '') === cnpj, 'the gateway customer has another CPF/CNPJ', {
          expected: cnpj, got: lido.body?.cpfCnpj
        });
        conferir(lido.body?.externalReference === `tenant:${tenantId}`, 'the gateway customer has another externalReference', {
          got: lido.body?.externalReference
        });
        const repetido = await ctx.step('ensureAsaasCustomer again', () => ensureAsaasCustomer(tenantId));
        conferir(repetido.created === false && repetido.customerRef === criado.customerRef, 'the second call created another customer');
        return { customerRef: criado.customerRef, cpfCnpj: cnpj, notificationDisabled: lido.body?.notificationDisabled ?? null };
      },

      async renewal(ctx) {
        await garantirCliente();
        await prepararFluxo({ renewsAt: aoSegundo(Date.now() + 2 * DIA) });
        const antes = await assinatura();
        const emitida = await ctx.step('issueCurrent', () => emitirConferindo({ manual: true }, { billingType: 'UNDEFINED' }));
        const baixa = await ctx.step('receiveInCash', () => asaasClient.receiveInCash(emitida.chargeId, {
          paymentDate: hoje(), value: emitida.amountCents
        }));
        const pagamento = await ctx.step('GET /payments/{id}', () => lerPagamento(emitida.chargeId));
        conferir(['RECEIVED_IN_CASH', 'RECEIVED', 'CONFIRMED'].includes(pagamento.status),
          `payment status ${pagamento.status} after receiveInCash`);
        const { entrega, depois } = await ctx.step('webhook PAYMENT_RECEIVED', () => creditarPeloWebhook('PAYMENT_RECEIVED', pagamento, antes.renews_at));
        const linha = await linhaDaCobranca(emitida.chargeId);
        conferir(linha?.status === 'paid', `charge row is ${linha?.status}, expected paid`);
        const reentrega = await ctx.step('webhook replay', () => entregarWebhook('PAYMENT_RECEIVED', pagamento));
        conferir(reentrega.body?.code === 'duplicate', `replayed webhook code ${reentrega.body?.code}, expected duplicate`);
        const novamente = await assinatura();
        conferir(msDe(novamente.renews_at) === msDe(depois.renews_at), 'the replayed webhook moved renews_at again');
        return {
          chargeId: emitida.chargeId,
          amountCents: emitida.amountCents,
          receiveInCashStatus: baixa.status,
          payment: resumoPagamento(pagamento),
          webhookCode: entrega.body.code,
          renewsAtBefore: iso(antes.renews_at),
          renewsAtAfter: iso(depois.renews_at),
          extendedDays: Math.round((msDe(depois.renews_at) - msDe(antes.renews_at)) / DIA)
        };
      },

      async charge_terms(ctx) {
        await garantirCliente();
        const termos = { finePercent: 2, interestMonthlyPercent: 1, discountKind: 'percent', discountValue: 5, discountDaysBefore: 3 };
        await prepararFluxo({ renewsAt: aoSegundo(Date.now() + 10 * DIA), charges: termos });
        const emitida = await ctx.step('issueCurrent', () => emitirConferindo({ manual: true }, { billingType: 'UNDEFINED' }));
        const pagamento = await ctx.step('GET /payments/{id}', () => lerPagamento(emitida.chargeId));
        conferir(Number(pagamento.fine?.value) === termos.finePercent, `fine.value is ${pagamento.fine?.value}`, { fine: pagamento.fine });
        conferir(Number(pagamento.interest?.value) === termos.interestMonthlyPercent, `interest.value is ${pagamento.interest?.value}`, {
          interest: pagamento.interest
        });
        conferir(Number(pagamento.discount?.value) === termos.discountValue, `discount.value is ${pagamento.discount?.value}`, {
          discount: pagamento.discount
        });
        conferir(String(pagamento.discount?.type ?? '').toUpperCase() === 'PERCENTAGE', `discount.type is ${pagamento.discount?.type}`);
        conferir(Number(pagamento.discount?.dueDateLimitDays) === termos.discountDaysBefore,
          `discount.dueDateLimitDays is ${pagamento.discount?.dueDateLimitDays}`);
        const linha = await linhaDaCobranca(emitida.chargeId);
        return {
          configured: termos,
          payment: resumoPagamento(pagamento),
          storedDiscountTerms: linha?.discount_terms ?? null
        };
      },

      async card_approved(ctx) {
        await garantirCliente();
        const cartao = await ctx.step('tokenizeCreditCard (approved card)', () => tokenizar(cartaoAprovado));
        if (!cartao.token) throw new Pulado(`the sandbox did not tokenize the approved test card: ${cartao.error}`, { body: cartao.body });
        // O vencimento é agora: a renovação de cartão sai no dia (sem `manual`).
        await prepararFluxo({ renewsAt: aoSegundo(Date.now() + 30_000), cartao });
        const antes = await assinatura();
        conferir(CardAutopayService.usable(antes), 'the saved card is not usable after seeding');
        let emitida = anotarCriada(await ctx.step('issueCurrent (scheduler pass, due today)', () => emitir({})));
        let caminho = 'scheduler';
        if (!emitida.issued && emitida.reason === 'not_due_yet') {
          emitida = anotarCriada(await ctx.step('issueCurrent (pay now)', () => emitir({ manual: true, cardNow: true })));
          caminho = 'pay_now';
        }
        conferir(emitida.issued === true, `issueCurrent did not issue (${emitida.reason})`, { error: emitida.error ?? null });
        conferir(emitida.billingType === 'CREDIT_CARD', `expected CREDIT_CARD, got ${emitida.billingType}`);
        const pagamento = await ctx.step('GET /payments/{id}', () => lerPagamento(emitida.chargeId));
        conferir(['CONFIRMED', 'RECEIVED'].includes(pagamento.status), `card payment status is ${pagamento.status}, expected CONFIRMED`);
        conferir(pagamento.billingType === 'CREDIT_CARD', `gateway billingType is ${pagamento.billingType}`);
        const { entrega, depois } = await ctx.step('webhook PAYMENT_CONFIRMED', () => creditarPeloWebhook('PAYMENT_CONFIRMED', pagamento, antes.renews_at));
        conferir(!depois.card_failed_at, 'the card was marked as failed');
        conferir(CardAutopayService.hasToken(depois), 'the saved card was dropped');
        return {
          issuedBy: caminho,
          chargeId: emitida.chargeId,
          card: { brand: cartao.brand, last4: cartao.last4 },
          payment: resumoPagamento(pagamento),
          webhookCode: entrega.body.code,
          renewsAtBefore: iso(antes.renews_at),
          renewsAtAfter: iso(depois.renews_at)
        };
      },

      async card_refused(ctx) {
        await garantirCliente();
        const cartao = await ctx.step('tokenizeCreditCard (refusal card)', () => tokenizar(cartaoRecusado));
        if (!cartao.token) {
          throw new Pulado(`the sandbox refused the refusal test card at tokenization, so the fallback cannot be exercised: ${cartao.error}`, {
            body: cartao.body
          });
        }
        await prepararFluxo({ renewsAt: aoSegundo(Date.now() + 30_000), cartao });
        const emitida = anotarCriada(await ctx.step('issueCurrent (pay now)', () => emitir({ manual: true, cardNow: true })));
        conferir(emitida.issued === true, `issueCurrent did not issue (${emitida.reason})`, { error: emitida.error ?? null });
        conferir(emitida.billingType === 'UNDEFINED', `expected the fallback to UNDEFINED, got ${emitida.billingType}`);
        const pagamento = await ctx.step('GET /payments/{id}', () => lerPagamento(emitida.chargeId));
        conferir(pagamento.billingType === 'UNDEFINED', `gateway billingType is ${pagamento.billingType}`);
        conferir(['PENDING', 'OVERDUE'].includes(pagamento.status), `fallback payment status is ${pagamento.status}`);
        const depois = await assinatura();
        const linha = await linhaDaCobranca(emitida.chargeId);
        const recusaNoLog = logs.filter((l) => /was (refused|rejected)/.test(l.line)).map((l) => l.line).slice(-1)[0] ?? null;
        conferir(emitida.cardRefused === true && Boolean(depois.card_failed_at),
          'the gateway error was not read as a CARD refusal (classified as "rejected"): the card was not marked failed', {
            cardRefused: emitida.cardRefused ?? false, gatewayError: recusaNoLog
          });
        return {
          chargeId: emitida.chargeId,
          cardRefused: true,
          cardFailure: depois.card_failure,
          chargeRowBillingType: linha?.billing_type ?? null,
          payment: resumoPagamento(pagamento),
          gatewayError: recusaNoLog
        };
      },

      async refund(ctx) {
        await garantirCliente();
        const cartao = await ctx.step('tokenizeCreditCard (approved card)', () => tokenizar(cartaoAprovado));
        if (!cartao.token) throw new Pulado(`the sandbox did not tokenize the approved test card: ${cartao.error}`, { body: cartao.body });
        await prepararFluxo({ renewsAt: aoSegundo(Date.now() + 30_000), cartao });
        const antes = await assinatura();
        const emitida = anotarCriada(await ctx.step('issueCurrent (pay now)', () => emitir({ manual: true, cardNow: true })));
        conferir(emitida.issued === true && emitida.billingType === 'CREDIT_CARD',
          `expected a card charge, got ${emitida.issued ? emitida.billingType : emitida.reason}`);
        const pago = await ctx.step('GET /payments/{id}', () => lerPagamento(emitida.chargeId));
        conferir(['CONFIRMED', 'RECEIVED'].includes(pago.status), `card payment status is ${pago.status}`);
        const { depois: creditada } = await ctx.step('webhook PAYMENT_CONFIRMED', () => creditarPeloWebhook('PAYMENT_CONFIRMED', pago, antes.renews_at));
        const linha = await linhaDaCobranca(emitida.chargeId);
        conferir(linha?.status === 'paid', `charge row is ${linha?.status}, expected paid`);

        const req = {
          params: { id: String(tenantId), chargeId: String(linha.id) },
          body: { reason: 'asaas-sandbox-e2e' },
          user: { userId: null, username: 'asaas-sandbox-e2e' },
          ip: '127.0.0.1',
          headers: {},
          get: () => undefined
        };
        const res = respostaFalsa();
        await ctx.step('console refund', () => PlatformSubscriptionsController.refund(req, res));
        conferir(res.statusCode === 200, `console refund answered ${res.statusCode}`, { body: res.body });
        const estornada = await linhaDaCobranca(emitida.chargeId);
        conferir(estornada?.status === 'refunded', `charge row is ${estornada?.status}, expected refunded`);
        const devolvida = await assinatura();
        conferir(msDe(devolvida.renews_at) === msDe(antes.renews_at), 'renews_at did not go back to where it was', {
          before: iso(antes.renews_at), credited: iso(creditada.renews_at), afterRefund: iso(devolvida.renews_at)
        });
        const noGateway = await ctx.step('GET /payments/{id} after refund', () => lerPagamento(emitida.chargeId));
        conferir(/REFUND/.test(String(noGateway.status)), `gateway status after refund is ${noGateway.status}`);
        const aviso = await ctx.step('webhook PAYMENT_REFUNDED', () => entregarWebhook('PAYMENT_REFUNDED', noGateway));
        conferir(aviso.status === 200, `PAYMENT_REFUNDED webhook answered ${aviso.status}`);
        const final = await assinatura();
        conferir(msDe(final.renews_at) === msDe(antes.renews_at), 'the PAYMENT_REFUNDED webhook undid the period a second time');
        return {
          chargeId: emitida.chargeId,
          gatewayStatusAfterRefund: noGateway.status,
          refundedWebhookCode: aviso.body?.code ?? null,
          renewsAtBefore: iso(antes.renews_at),
          renewsAtCredited: iso(creditada.renews_at),
          renewsAtAfterRefund: iso(final.renews_at)
        };
      },

      async nfse(ctx) {
        await garantirCliente();
        const servico = process.env.ASAAS_SANDBOX_NFSE_SERVICE_ID
          ? { municipalServiceId: String(process.env.ASAAS_SANDBOX_NFSE_SERVICE_ID) }
          : { municipalServiceCode: String(process.env.ASAAS_SANDBOX_NFSE_SERVICE_CODE || '01.07') };
        await prepararFluxo({
          renewsAt: aoSegundo(Date.now() + 2 * DIA),
          nfse: {
            nfseEnabled: true,
            serviceDescription: 'Licença de uso de software de gestão (teste e2e sandbox)',
            municipalServiceName: 'Licenciamento ou cessão de direito de uso de programas de computação',
            issPercent: 2,
            ...servico
          }
        });
        const antes = await assinatura();
        const emitida = await ctx.step('issueCurrent', () => emitirConferindo({ manual: true }, { billingType: 'UNDEFINED' }));
        await ctx.step('receiveInCash', () => asaasClient.receiveInCash(emitida.chargeId, { paymentDate: hoje(), value: emitida.amountCents }));
        const pagamento = await ctx.step('GET /payments/{id}', () => lerPagamento(emitida.chargeId));
        await ctx.step('webhook PAYMENT_RECEIVED', () => creditarPeloWebhook('PAYMENT_RECEIVED', pagamento, antes.renews_at));
        const linha = await linhaDaCobranca(emitida.chargeId);
        const naFila = await runInTenant(tenantId, () => BillingInvoice.forCharge(linha.id));
        conferir(Boolean(naFila), 'the paid charge did not queue an invoice');
        const passada = await ctx.step('BillingInvoiceService.processDue', () => runInTenant(tenantId, () => BillingInvoiceService.processDue({})));
        const nota = await runInTenant(tenantId, () => BillingInvoice.forCharge(linha.id));
        const detalhes = {
          chargeId: emitida.chargeId,
          pass: passada,
          invoice: nota ? {
            status: nota.status, externalId: nota.external_id ?? null, number: nota.number ?? null, error: nota.error ?? null
          } : null
        };
        if (nota?.external_id && ['scheduled', 'authorized'].includes(nota.status)) {
          const noGateway = await ctx.step('GET /invoices/{id}', () => asaasClient.getInvoice(nota.external_id));
          detalhes.gatewayInvoice = noGateway;
          if (!opcoes.keep) {
            try {
              await asaasClient.cancelInvoice(nota.external_id);
              relatorio.cleanup.push({ invoice: nota.external_id, canceled: true });
            } catch (error) {
              relatorio.cleanup.push({ invoice: nota.external_id, canceled: false, error: error.message });
            }
          }
          return detalhes;
        }
        const erro = String(nota?.error ?? '');
        if (/gateway answered 4\d\d/.test(erro)) {
          throw new Pulado(`the sandbox account is not set up to issue NFS-e: ${erro.slice(0, 300)}`, detalhes);
        }
        throw new Falhou(`invoice ended as ${nota?.status ?? 'missing'}${erro ? `: ${erro}` : ''}`, detalhes);
      },

      async early_discount(ctx) {
        await garantirCliente();
        const termos = { discountKind: 'percent', discountValue: 10, discountDaysBefore: 0 };
        await prepararFluxo({ renewsAt: aoSegundo(Date.now() + 10 * DIA), charges: termos });
        const antes = await assinatura();
        const emitida = await ctx.step('issueCurrent', () => emitirConferindo({ manual: true }, { billingType: 'UNDEFINED' }));
        const config = await asaasSettings.effectiveChargesConfig();
        const desconto = asaasSettings.earlyDiscountFor(Number(emitida.amountCents), config);
        conferir(desconto && desconto.cents > 0, 'no early discount applies to this amount', { amountCents: emitida.amountCents });
        const comDesconto = Number(emitida.amountCents) - desconto.cents;
        const emitidoNoGateway = resumoPagamento(await ctx.step('GET /payments/{id} (issued)', () => lerPagamento(emitida.chargeId)));
        await ctx.step('receiveInCash (discounted value)', () => asaasClient.receiveInCash(emitida.chargeId, {
          paymentDate: hoje(), value: comDesconto
        }));
        const pago = await ctx.step('GET /payments/{id} (settled)', () => lerPagamento(emitida.chargeId));
        const entrega = await ctx.step('webhook PAYMENT_RECEIVED', () => entregarWebhook('PAYMENT_RECEIVED', pago));
        conferir(entrega.status === 200, `webhook answered ${entrega.status}`, { body: entrega.body });
        const depois = await assinatura();
        const estendeu = msDe(depois.renews_at) > msDe(antes.renews_at);
        const observacao = {
          chargedCents: Number(emitida.amountCents),
          expectedDiscountCents: desconto.cents,
          receivedInCashCents: comDesconto,
          issued: { value: emitidoNoGateway.value, netValue: emitidoNoGateway.netValue, originalValue: emitidoNoGateway.originalValue, discount: emitidoNoGateway.discount },
          settled: { value: pago.value ?? null, netValue: pago.netValue ?? null, originalValue: pago.originalValue ?? null, status: pago.status ?? null, paymentDate: pago.paymentDate ?? null },
          webhookCode: entrega.body?.code ?? null,
          periodExtended: estendeu
        };
        const avisos = [];
        if (!estendeu) avisos.push(`the panel did NOT extend the period for this discounted payment (webhook code ${entrega.body?.code})`);
        return { ...observacao, ...(avisos.length ? { warnings: avisos } : {}) };
      }
    };

    // ── A execução ──────────────────────────────────────────────────────
    const escolhidos = FLOWS.filter((f) => !opcoes.only
      || opcoes.only.includes(String(f.id)) || opcoes.only.includes(f.key));
    if (!escolhidos.length) throw new Error(`--only matched no flow (${opcoes.only.join(',')})`);

    escrever(`Asaas e2e (${modo}) → ${base}`);
    escrever(`provider #${tenantId}, CNPJ ${cnpj}, plan ${plano.price_cents} cents / ${plano.period_days} days`);
    escrever('');

    for (const fluxo of escolhidos) {
      const passos = [];
      const ctx = {
        async step(nome, fn) {
          const t0 = Date.now();
          try {
            const valor = await fn();
            passos.push({ name: nome, ms: Date.now() - t0, ok: true });
            return valor;
          } catch (error) {
            passos.push({ name: nome, ms: Date.now() - t0, ok: false, error: limpar(error?.message ?? error) });
            throw error;
          }
        }
      };
      const t0 = Date.now();
      const linha = { id: fluxo.id, key: fluxo.key, title: fluxo.title, status: 'pass', ms: 0, details: null, steps: passos };
      process.stdout.write(limpar(`  ${fluxo.id}. ${fluxo.title} … `));
      try {
        linha.details = await implementacoes[fluxo.key](ctx);
      } catch (error) {
        if (error instanceof Pulado) {
          linha.status = 'skip';
          linha.reason = error.message;
          linha.details = error.detalhes;
        } else {
          linha.status = 'fail';
          linha.error = error?.message ?? String(error);
          linha.details = error?.detalhes ?? null;
          if (!(error instanceof Falhou) && error?.stack) linha.stack = error.stack.split('\n').slice(0, 6).join('\n');
        }
      }
      linha.ms = Date.now() - t0;
      if (linha.details?.warnings?.length) linha.warnings = linha.details.warnings;
      relatorio.flows.push(limparObjeto(linha));
      escrever(`${linha.status.toUpperCase()} (${linha.ms} ms)`);
    }

    // ── A faxina no gateway ─────────────────────────────────────────────
    if (!opcoes.keep) {
      for (const id of criadas) {
        try {
          const p = await lerPagamento(id);
          if (p.status === 'PENDING' || p.status === 'OVERDUE') {
            await asaasClient.cancelCharge(id);
            relatorio.cleanup.push({ payment: id, canceled: true });
          }
        } catch (error) {
          relatorio.cleanup.push({ payment: id, canceled: false, error: limpar(error.message) });
        }
      }
    }
  } catch (error) {
    codigo = 1;
    relatorio.fatal = limpar(error?.stack ?? error?.message ?? String(error));
  } finally {
    for (const [nivel, original] of Object.entries(originais)) console[nivel] = original;
    try { await fecharBanco(); } catch { /* o processo termina já */ }
    if (mock) await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (codigo === 2) return codigo;

  // ── O relatório ───────────────────────────────────────────────────────
  relatorio.finishedAt = new Date().toISOString();
  const contagem = { pass: 0, fail: 0, skip: 0 };
  for (const f of relatorio.flows) contagem[f.status] += 1;
  relatorio.summary = { ...contagem, total: relatorio.flows.length, ms: Date.now() - inicio };
  relatorio.logs = logs.slice(-200);
  if (contagem.fail > 0 || relatorio.fatal) codigo = 1;

  const diretorio = path.resolve(opcoes.reportDir || path.join(BACKEND_DIR, 'reports'));
  fs.mkdirSync(diretorio, { recursive: true });
  const arquivo = path.join(diretorio, `asaas-sandbox-${relatorio.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(arquivo, `${limpar(JSON.stringify(limparObjeto(relatorio), null, 2))}\n`);

  escrever('');
  escrever(tabela(relatorio.flows));
  const desconto = relatorio.flows.find((f) => f.key === 'early_discount' && f.status === 'pass');
  if (desconto) {
    const d = desconto.details;
    escrever('');
    escrever('Early discount — what Asaas reports:');
    escrever(`  issued : value=${d.issued.value} netValue=${d.issued.netValue} originalValue=${d.issued.originalValue} discount=${JSON.stringify(d.issued.discount)}`);
    escrever(`  settled: value=${d.settled.value} netValue=${d.settled.netValue} originalValue=${d.settled.originalValue} status=${d.settled.status}`);
    escrever(`  charged ${d.chargedCents} cents, received in cash ${d.receivedInCashCents} cents → webhook ${d.webhookCode}, period extended: ${d.periodExtended}`);
  }
  if (relatorio.fatal) {
    escrever('');
    escrever(`FATAL: ${relatorio.fatal.split('\n')[0]}`);
  }
  escrever('');
  escrever(`${contagem.pass} passed, ${contagem.fail} failed, ${contagem.skip} skipped in ${relatorio.summary.ms} ms`);
  escrever(`report: ${arquivo}`);
  return codigo;
}

/** A tabela do terminal: um fluxo por linha, o motivo de quem não passou. */
function tabela(fluxos) {
  const linhas = fluxos.map((f) => {
    const nota = f.status === 'fail' ? f.error : f.status === 'skip' ? f.reason : (f.warnings?.[0] ? `warning: ${f.warnings[0]}` : '');
    return [String(f.id), f.key, f.status.toUpperCase(), `${f.ms} ms`, String(nota ?? '').replace(/\s+/g, ' ').slice(0, 110)];
  });
  const cabecalho = ['#', 'flow', 'status', 'time', 'notes'];
  const larguras = cabecalho.map((c, i) => Math.max(c.length, ...linhas.map((l) => l[i].length)));
  const formatar = (l) => l.map((c, i) => c.padEnd(larguras[i])).join('  ').trimEnd();
  return [formatar(cabecalho), larguras.map((w) => '-'.repeat(w)).join('  '), ...linhas.map(formatar)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((codigo) => process.exit(codigo), (error) => {
    process.stderr.write(`${limpar(error?.stack ?? error)}\n`);
    process.exit(1);
  });
}
