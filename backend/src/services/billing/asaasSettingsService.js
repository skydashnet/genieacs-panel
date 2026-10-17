import crypto from 'node:crypto';
import AppState from '../../models/AppState.js';
import Tenant from '../../models/Tenant.js';
import { runInTenant } from '../../config/tenantContext.js';
import { createSecretBox } from '../../utils/secretBox.js';

/**
 * A conta da plataforma no Asaas, configurada pelo console — e não só pelo
 * `.env`.
 *
 * ## Por que sair do ambiente
 *
 * Até aqui a chave da API e o token do webhook eram variáveis de ambiente, e a
 * única maneira de trocar a chave (que o gateway obriga a trocar quando alguém
 * a vaza, e que muda de família ao sair do sandbox para produção) era abrir um
 * terminal no servidor e reiniciar o processo. Quem opera a cobrança é quem
 * opera o console, e essa pessoa não tem — nem deveria ter — ssh.
 *
 * ## O banco ganha, o ambiente continua valendo
 *
 * O valor guardado pelo console tem precedência; a variável de ambiente é o
 * que vale quando o console nunca gravou nada. É o que mantém de pé o deploy
 * que já cobrava antes desta tela existir: ninguém precisa migrar nada no dia
 * da atualização, e o dia em que alguém grava pelo console é o dia em que o
 * `.env` deixa de mandar — visível na própria tela, que diz de onde cada valor
 * vem (`db` ou `env`).
 *
 * ## Onde mora
 *
 * No `app_state` da caixa da plataforma, que é o molde do servidor Evolution
 * compartilhado (`whatsappConfigService.readEffectiveConfig`): um segredo que é
 * da PLATAFORMA e não de provedor nenhum precisa de um dono no schema, e a
 * caixa existe exatamente para isso. Sem caixa — um self-hosted, ou uma SaaS
 * que ainda não a criou — só o ambiente vale, e gravar é recusado com um erro
 * que diz o porquê em vez de guardar o segredo no provedor errado.
 *
 * Os dois segredos vão cifrados, cada um no envelope `{ v: 1, ...box.encrypt() }`
 * que `secretRotationService` sabe re-cifrar — a entrada dele está em `BLOBS`,
 * e esquecê-la seria o primeiro segredo do painel a ficar de fora da rotação.
 * Uma caixa só para os dois: eles moram no mesmo blob, são da mesma conta e
 * têm o mesmo raio de estrago — quem lê um lê o outro.
 */

export const CONFIG_KEY = 'asaas_gateway_config';
export const SECRET_CONTEXT = 'skygenpanel-asaas-gateway-v1';

export const ENVIRONMENTS = Object.freeze(['sandbox', 'production']);

/** As duas bases, conferidas na documentação do gateway em setembro de 2026. */
export const BASE_URLS = Object.freeze({
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3'
});

/** Tetos de tamanho. Uma chave do Asaas tem perto de 170 caracteres. */
const API_KEY_MAX = 1024;
const WEBHOOK_TOKEN_MAX = 255;

/**
 * A NFS-e: o que vai em cada nota que a Asaas emite por um pagamento
 * confirmado. Nada aqui é segredo — é o cadastro fiscal do serviço que a
 * plataforma vende —, então mora no blob em claro, ao lado do ambiente.
 *
 * Os tetos são os da tela, folgados para o que as prefeituras pedem: a
 * descrição do serviço é texto livre que sai impresso na nota, e o código
 * municipal é curto (`01.07`, `1.07`, `010701`…).
 */
export const NFSE_FIELDS = Object.freeze([
  'nfseEnabled', 'serviceDescription', 'municipalServiceId', 'municipalServiceCode',
  'municipalServiceName', 'issPercent', 'retainIss', 'observations'
]);
const NFSE_TEXT_LIMITS = Object.freeze({
  serviceDescription: 1000,
  municipalServiceId: 64,
  municipalServiceCode: 64,
  municipalServiceName: 255,
  observations: 1000
});

/** A configuração da nota quando nada foi gravado: desligada e vazia. */
export const NFSE_DEFAULTS = Object.freeze({
  nfseEnabled: false,
  serviceDescription: null,
  municipalServiceId: null,
  municipalServiceCode: null,
  municipalServiceName: null,
  issPercent: 0,
  retainIss: false,
  observations: null
});

/** O bloco `nfse` guardado, completo e com os tipos certos — nunca lança. */
function nfseGuardada(stored) {
  const bruto = stored?.nfse && typeof stored.nfse === 'object' ? stored.nfse : {};
  const texto = (valor, max) => (typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, max) : null);
  const iss = Number(bruto.issPercent);
  return {
    nfseEnabled: bruto.nfseEnabled === true,
    serviceDescription: texto(bruto.serviceDescription, NFSE_TEXT_LIMITS.serviceDescription),
    municipalServiceId: texto(bruto.municipalServiceId, NFSE_TEXT_LIMITS.municipalServiceId),
    municipalServiceCode: texto(bruto.municipalServiceCode, NFSE_TEXT_LIMITS.municipalServiceCode),
    municipalServiceName: texto(bruto.municipalServiceName, NFSE_TEXT_LIMITS.municipalServiceName),
    issPercent: Number.isFinite(iss) && iss >= 0 && iss <= 100 ? iss : 0,
    retainIss: bruto.retainIss === true,
    observations: texto(bruto.observations, NFSE_TEXT_LIMITS.observations)
  };
}

/**
 * O que o patch muda na configuração da nota, validado — ou nada.
 *
 * Mesmo contrato dos segredos: campo ausente não é tocado; texto vazio ou nulo
 * apaga. Ligar exige o mínimo que a Asaas exige para agendar uma nota — a
 * descrição do serviço e o serviço municipal (pelo id OU pelo código) —, e a
 * conferência é sobre o resultado da mescla: ligar numa gravação e preencher
 * noutra não pode deixar a emissão ligada sem o que emitir.
 */
function nfseDoPatch(patch, anterior) {
  const presentes = NFSE_FIELDS.filter((campo) => patch[campo] !== undefined);
  if (!presentes.length) return undefined;
  const proxima = { ...anterior };
  for (const campo of presentes) {
    const valor = patch[campo];
    if (campo === 'nfseEnabled' || campo === 'retainIss') {
      if (typeof valor !== 'boolean') {
        throw new AsaasSettingsError(`${campo} must be a boolean`, { code: 'invalid_nfse' });
      }
      proxima[campo] = valor;
    } else if (campo === 'issPercent') {
      const numero = valor === null || valor === '' ? 0 : Number(valor);
      if (!Number.isFinite(numero) || numero < 0 || numero > 100) {
        throw new AsaasSettingsError('issPercent must be a number between 0 and 100', { code: 'invalid_nfse' });
      }
      // Duas casas: é o que a prefeitura imprime, e o que a Asaas aceita.
      proxima.issPercent = Math.round(numero * 100) / 100;
    } else {
      if (valor !== null && typeof valor !== 'string') {
        throw new AsaasSettingsError(`${campo} must be a string`, { code: 'invalid_nfse' });
      }
      const aparado = valor === null ? '' : valor.trim();
      if (aparado.length > NFSE_TEXT_LIMITS[campo]) {
        throw new AsaasSettingsError(`${campo} is too long`, { code: 'invalid_nfse' });
      }
      proxima[campo] = aparado || null;
    }
  }
  if (proxima.nfseEnabled) {
    if (!proxima.serviceDescription) {
      throw new AsaasSettingsError('serviceDescription is required to issue invoices', { code: 'invalid_nfse' });
    }
    if (!proxima.municipalServiceId && !proxima.municipalServiceCode) {
      throw new AsaasSettingsError(
        'municipalServiceId or municipalServiceCode is required to issue invoices', { code: 'invalid_nfse' }
      );
    }
  }
  return proxima;
}

/**
 * Multa, juros e desconto por antecipação: os termos que vão em cada cobrança
 * que a plataforma emite no Asaas. Nada aqui é segredo, e o molde é o da
 * `nfse` logo acima — um subbloco `charges` no blob, desligado por padrão.
 *
 * As unidades, porque elas não são as mesmas:
 *
 * - `finePercent`: a multa, em % do valor, cobrada uma vez depois do
 *   vencimento (0 a 10).
 * - `interestMonthlyPercent`: os juros, em % ao mês, que o gateway rateia por
 *   dia de atraso (0 a 10).
 * - `discountKind`: `percent` ou `fixed`. Com `percent`, `discountValue` é a
 *   porcentagem (0 a 100); com `fixed`, é em CENTAVOS, como todo dinheiro
 *   deste painel — quem converte para reais é o cliente do gateway.
 * - `discountDaysBefore`: até quantos dias ANTES do vencimento o desconto vale
 *   (0 = até o próprio vencimento, 30 no máximo).
 *
 * Zero em qualquer um é "desligado": não vai campo nenhum ao gateway.
 */
export const CHARGES_FIELDS = Object.freeze([
  'finePercent', 'interestMonthlyPercent', 'discountKind', 'discountValue', 'discountDaysBefore'
]);
export const DISCOUNT_KINDS = Object.freeze(['percent', 'fixed']);

/** A configuração dos termos quando nada foi gravado: tudo desligado. */
export const CHARGES_DEFAULTS = Object.freeze({
  finePercent: 0,
  interestMonthlyPercent: 0,
  discountKind: 'percent',
  discountValue: 0,
  discountDaysBefore: 0
});

/**
 * O piso de uma fatura com desconto: R$ 5,00, o mesmo do cupom
 * (`COUPON_FLOOR_CENTS`) e o mínimo que o gateway aceita numa cobrança.
 */
export const CHARGE_FLOOR_CENTS = 500;

/** Os tetos de cada número — a validação e a leitura usam os mesmos. */
const CHARGES_LIMITS = Object.freeze({
  finePercent: 10,
  interestMonthlyPercent: 10,
  discountPercent: 100,
  discountFixedCents: 100_000_000,
  discountDaysBefore: 30
});

const duasCasas = (numero) => Math.round(numero * 100) / 100;

/** O bloco `charges` guardado, completo e com os tipos certos — nunca lança. */
function chargesGuardada(stored) {
  const bruto = stored?.charges && typeof stored.charges === 'object' ? stored.charges : {};
  const entre = (valor, max) => {
    const numero = Number(valor);
    return Number.isFinite(numero) && numero >= 0 && numero <= max ? numero : 0;
  };
  const discountKind = DISCOUNT_KINDS.includes(bruto.discountKind) ? bruto.discountKind : 'percent';
  const discountValue = discountKind === 'fixed'
    ? Math.floor(entre(bruto.discountValue, CHARGES_LIMITS.discountFixedCents))
    : entre(bruto.discountValue, CHARGES_LIMITS.discountPercent);
  return {
    finePercent: entre(bruto.finePercent, CHARGES_LIMITS.finePercent),
    interestMonthlyPercent: entre(bruto.interestMonthlyPercent, CHARGES_LIMITS.interestMonthlyPercent),
    discountKind,
    discountValue,
    discountDaysBefore: Math.floor(entre(bruto.discountDaysBefore, CHARGES_LIMITS.discountDaysBefore))
  };
}

/**
 * O que o patch muda nos termos da cobrança, validado — ou nada.
 *
 * Mesmo contrato da `nfse`: campo ausente não é tocado; nulo ou texto vazio
 * num número é zero (desligado). A conferência do desconto é sobre o
 * resultado da mescla, porque o mesmo `discountValue` quer dizer coisas
 * diferentes conforme o `discountKind` — trocar só o tipo numa gravação não
 * pode deixar 1500 "por cento" de pé.
 */
function chargesDoPatch(patch, anterior) {
  const presentes = CHARGES_FIELDS.filter((campo) => patch[campo] !== undefined);
  if (!presentes.length) return undefined;
  const proxima = { ...anterior };
  const numero = (campo, valor) => {
    const lido = valor === null || valor === '' ? 0 : Number(valor);
    if (typeof valor === 'boolean' || !Number.isFinite(lido) || lido < 0) {
      throw new AsaasSettingsError(`${campo} must be a non-negative number`, { code: 'invalid_charges' });
    }
    return lido;
  };
  for (const campo of presentes) {
    const valor = patch[campo];
    if (campo === 'discountKind') {
      if (!DISCOUNT_KINDS.includes(valor)) {
        throw new AsaasSettingsError(`discountKind must be one of ${DISCOUNT_KINDS.join(', ')}`, {
          code: 'invalid_charges'
        });
      }
      proxima.discountKind = valor;
    } else if (campo === 'finePercent' || campo === 'interestMonthlyPercent') {
      const lido = numero(campo, valor);
      if (lido > CHARGES_LIMITS[campo]) {
        throw new AsaasSettingsError(`${campo} must be between 0 and ${CHARGES_LIMITS[campo]}`, {
          code: 'invalid_charges'
        });
      }
      proxima[campo] = duasCasas(lido);
    } else if (campo === 'discountDaysBefore') {
      const lido = numero(campo, valor);
      if (!Number.isInteger(lido) || lido > CHARGES_LIMITS.discountDaysBefore) {
        throw new AsaasSettingsError(
          `discountDaysBefore must be a whole number between 0 and ${CHARGES_LIMITS.discountDaysBefore}`,
          { code: 'invalid_charges' }
        );
      }
      proxima.discountDaysBefore = lido;
    } else {
      proxima.discountValue = numero(campo, valor);
    }
  }
  if (proxima.discountKind === 'fixed') {
    if (!Number.isInteger(proxima.discountValue) || proxima.discountValue > CHARGES_LIMITS.discountFixedCents) {
      throw new AsaasSettingsError('a fixed discountValue must be a whole number of cents', {
        code: 'invalid_charges'
      });
    }
  } else {
    if (proxima.discountValue > CHARGES_LIMITS.discountPercent) {
      throw new AsaasSettingsError('a percent discountValue must be between 0 and 100', { code: 'invalid_charges' });
    }
    proxima.discountValue = duasCasas(proxima.discountValue);
  }
  return proxima;
}

/**
 * Quanto o desconto por antecipação tira de uma fatura de `amountCents`, já
 * com o piso — ou nada.
 *
 * Pura, e é a MESMA conta nas duas pontas: a emissão manda ao gateway o que
 * ela diz, e a conferência do pagamento (`recordPayment`) aceita como inteiro
 * o valor que ela diz. Duas contas parecidas em dois lugares dariam um
 * centavo de diferença, e um centavo a menos é "pago a menos".
 *
 * Com o piso: o desconto nunca leva a fatura abaixo de `CHARGE_FLOOR_CENTS`.
 * Um desconto que passaria disso vira o FIXO que para exatamente no piso
 * (`clamped`); uma fatura que já está no piso não tem desconto nenhum.
 *
 * @returns {{ cents: number, kind: 'percent'|'fixed', percent: number|null,
 *   daysBefore: number, clamped: boolean }|null}
 */
export function earlyDiscountFor(amountCents, config) {
  const valor = Number(amountCents);
  if (!Number.isInteger(valor) || valor <= CHARGE_FLOOR_CENTS) return null;
  const termos = config ?? CHARGES_DEFAULTS;
  const desconto = Number(termos.discountValue);
  if (!Number.isFinite(desconto) || desconto <= 0) return null;
  const daysBefore = Number.isInteger(termos.discountDaysBefore) ? termos.discountDaysBefore : 0;
  const folga = valor - CHARGE_FLOOR_CENTS;
  if (termos.discountKind === 'fixed') {
    const cents = Math.min(Math.floor(desconto), folga);
    return cents > 0
      ? { cents, kind: 'fixed', percent: null, daysBefore, clamped: cents < Math.floor(desconto) }
      : null;
  }
  // O gateway calcula a porcentagem do lado dele, em reais com duas casas:
  // arredondado, como ele arredonda.
  const cents = Math.round((valor * desconto) / 100);
  if (cents <= 0) return null;
  if (cents > folga) return { cents: folga, kind: 'fixed', percent: null, daysBefore, clamped: true };
  return { cents, kind: 'percent', percent: desconto, daysBefore, clamped: false };
}

/**
 * Quanto tempo o blob lido fica em memória.
 *
 * Curto de propósito: o job de emissão pergunta por isto a cada provedor, a
 * cada minuto, e cada pergunta seria uma leitura no banco — mas num deploy com
 * mais de um processo a gravação invalida só o processo que gravou, e quinze
 * segundos é o tempo máximo que os outros ficam falando com a chave velha.
 */
const CACHE_TTL_MS = 15_000;

/**
 * Criada na primeira vez que é usada, não no carregamento do módulo: este
 * arquivo entra na cadeia de import do middleware de sessão, e um processo de
 * produção sem segredo tem de ouvir primeiro que falta o JWT_SECRET — não que
 * falta a chave da caixa de segredos.
 */
let caixa = null;
function box() {
  if (!caixa) caixa = createSecretBox(SECRET_CONTEXT);
  return caixa;
}

let cache = null;

/** Esquece o que foi lido. Exportado para os testes e para quem grava. */
export function invalidateAsaasSettings() {
  cache = null;
}

export class AsaasSettingsError extends Error {
  constructor(message, { code = 'invalid', status = 400 } = {}) {
    super(message);
    this.name = 'AsaasSettingsError';
    this.code = code;
    this.status = status;
  }
}

function envValue(nome) {
  const valor = String(process.env[nome] ?? '').trim();
  return valor.length ? valor : null;
}

function selar(valor) {
  return { v: 1, ...box().encrypt(valor) };
}

/** O segredo aberto, ou nulo — inclusive quando a chave da caixa não o abre. */
function abrir(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const valor = box().decrypt(envelope);
  return valor ? String(valor) : null;
}

/**
 * O blob guardado, e de qual caixa. `platformId` nulo quer dizer "não há onde
 * guardar", que é diferente de "não há nada guardado".
 */
async function lerGuardado() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const caixa = await Tenant.platform();
  let stored = null;
  if (caixa) {
    const bruto = await runInTenant(caixa.id, () => AppState.get(CONFIG_KEY));
    if (bruto) {
      try {
        const lido = JSON.parse(bruto);
        stored = lido && typeof lido === 'object' ? lido : null;
      } catch {
        // Um blob ilegível é tratado como ausente: o ambiente volta a valer, e
        // a próxima gravação pelo console o reescreve inteiro.
        stored = null;
      }
    }
  }
  const value = { platformId: caixa?.id ?? null, stored };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/**
 * Os valores que valem agora, com a origem de cada um.
 *
 * O ambiente PADRÃO é a parte com história. Um deploy que já cobrava pelo
 * `.env` falava com `api.asaas.com` — produção —, porque era a base fixa do
 * cliente; então uma chave vinda do ambiente, sem ambiente escolhido no
 * console, continua sendo produção. Sem chave nenhuma, o padrão é o sandbox:
 * quem está configurando pela primeira vez está testando, e errar para o lado
 * do sandbox custa uma cobrança de mentira, não uma de verdade.
 */
async function resolver() {
  const { platformId, stored } = await lerGuardado();

  const chaveDb = abrir(stored?.apiKey);
  const chaveEnv = envValue('ASAAS_API_KEY');
  const tokenDb = abrir(stored?.webhookToken);
  const tokenEnv = envValue('BILLING_WEBHOOK_TOKEN');

  const apiKey = chaveDb ?? chaveEnv;
  const apiKeySource = chaveDb ? 'db' : chaveEnv ? 'env' : null;
  const webhookToken = tokenDb ?? tokenEnv;
  const webhookTokenSource = tokenDb ? 'db' : tokenEnv ? 'env' : null;

  let environment;
  if (ENVIRONMENTS.includes(stored?.environment)) environment = stored.environment;
  else if (apiKeySource === 'env') environment = 'production';
  else environment = 'sandbox';

  return {
    platformId,
    environment,
    apiKey,
    apiKeySource,
    webhookToken,
    webhookTokenSource,
    nfse: nfseGuardada(stored),
    charges: chargesGuardada(stored),
    updatedAt: stored?.updatedAt ?? null
  };
}

/** O que a tela pode ver: de onde vem cada coisa, nunca o valor. */
export async function readPublic() {
  const efetivo = await resolver();
  return {
    environment: efetivo.environment,
    apiKeyConfigured: Boolean(efetivo.apiKey),
    apiKeySource: efetivo.apiKeySource,
    webhookTokenConfigured: Boolean(efetivo.webhookToken),
    webhookTokenSource: efetivo.webhookTokenSource,
    ...efetivo.nfse,
    ...efetivo.charges,
    updatedAt: efetivo.updatedAt
  };
}

/** A configuração da NFS-e que vale agora — ver `NFSE_FIELDS`. */
export async function effectiveNfseConfig() {
  return (await resolver()).nfse;
}

/** A multa, os juros e o desconto que valem agora — ver `CHARGES_FIELDS`. */
export async function effectiveChargesConfig() {
  return (await resolver()).charges;
}

/** A chave com que o painel CHAMA o gateway, ou nulo. */
export async function effectiveApiKey() {
  return (await resolver()).apiKey;
}

/** O token que o gateway manda de volta na entrega do webhook, ou nulo. */
export async function effectiveWebhookToken() {
  return (await resolver()).webhookToken;
}

/** O ambiente que vale, `sandbox` ou `production`. */
export async function effectiveEnvironment() {
  return (await resolver()).environment;
}

/**
 * A base da API, sem barra no fim.
 *
 * `ASAAS_BASE_URL` ganha de tudo, e continua sendo o que era: a porta para o
 * teste apontar o cliente para um servidor de mentira em `127.0.0.1`. Fora
 * disso a base sai do ambiente escolhido — que é o motivo de o ambiente ser um
 * campo da tela e não uma URL: a URL errada para a chave certa dá 401, e dois
 * valores fixos não têm como sair errados.
 */
export async function effectiveBaseUrl() {
  const forcada = envValue('ASAAS_BASE_URL');
  if (forcada) return forcada.replace(/\/+$/, '');
  return BASE_URLS[await effectiveEnvironment()];
}

/**
 * Normaliza um segredo recebido da tela. `undefined` mantém, `''` (ou nulo)
 * apaga, e o resto é o valor novo, aparado.
 */
function segredoDoPatch(valor, { nome, max }) {
  if (valor === undefined) return undefined;
  if (valor === null) return '';
  if (typeof valor !== 'string') throw new AsaasSettingsError(`${nome} must be a string`);
  const aparado = valor.trim();
  if (aparado.length > max) throw new AsaasSettingsError(`${nome} is too long`);
  // Um segredo com espaço ou quebra de linha no meio é quase sempre uma colagem
  // que levou junto o texto em volta — e ele iria para um cabeçalho HTTP, onde
  // uma quebra de linha nem é permitida.
  if (/\s/.test(aparado)) throw new AsaasSettingsError(`${nome} must not contain whitespace`);
  return aparado;
}

/**
 * Grava. Campo ausente não é tocado; presente e vazio apaga — e apagar aqui
 * devolve a palavra ao `.env`, se ele tiver o valor.
 *
 * @returns o mesmo que `readPublic`, já com o que foi gravado, mais o que mudou.
 */
export async function save(patch = {}) {
  const environment = patch.environment === undefined ? undefined : patch.environment;
  if (environment !== undefined && !ENVIRONMENTS.includes(environment)) {
    throw new AsaasSettingsError(`environment must be one of ${ENVIRONMENTS.join(', ')}`, {
      code: 'invalid_environment'
    });
  }
  const apiKey = segredoDoPatch(patch.apiKey, { nome: 'apiKey', max: API_KEY_MAX });
  const webhookToken = segredoDoPatch(patch.webhookToken, { nome: 'webhookToken', max: WEBHOOK_TOKEN_MAX });

  // Lido sem o cache: a gravação parte do que está no banco agora, e não do
  // que estava há quinze segundos — senão duas gravações seguidas de campos
  // diferentes perderiam a primeira.
  invalidateAsaasSettings();
  const { platformId, stored } = await lerGuardado();
  if (!platformId) {
    throw new AsaasSettingsError(
      'There is no platform box in this deployment to store the gateway settings in',
      { code: 'no_platform_tenant', status: 409 }
    );
  }

  const anterior = stored ?? {};
  const nfseAnterior = nfseGuardada(anterior);
  const nfse = nfseDoPatch(patch, nfseAnterior);
  const chargesAnterior = chargesGuardada(anterior);
  const charges = chargesDoPatch(patch, chargesAnterior);
  const proximo = {
    v: 1,
    environment: ENVIRONMENTS.includes(anterior.environment) ? anterior.environment : null,
    apiKey: anterior.apiKey ?? null,
    webhookToken: anterior.webhookToken ?? null,
    // O bloco da nota só é gravado quando existe: um blob de antes dela
    // continua sem ele, e a leitura devolve os padrões.
    ...(anterior.nfse ? { nfse: nfseAnterior } : {}),
    ...(anterior.charges ? { charges: chargesAnterior } : {}),
    updatedAt: anterior.updatedAt ?? null
  };
  if (nfse !== undefined) proximo.nfse = nfse;
  if (charges !== undefined) proximo.charges = charges;
  if (environment !== undefined) proximo.environment = environment;
  if (apiKey !== undefined) proximo.apiKey = apiKey ? selar(apiKey) : null;
  if (webhookToken !== undefined) proximo.webhookToken = webhookToken ? selar(webhookToken) : null;
  proximo.updatedAt = new Date().toISOString();

  await runInTenant(platformId, () => AppState.upsert(CONFIG_KEY, JSON.stringify(proximo)));
  invalidateAsaasSettings();

  return {
    settings: await readPublic(),
    changed: {
      environment: environment !== undefined && environment !== anterior.environment,
      apiKey: apiKey !== undefined,
      webhookToken: webhookToken !== undefined,
      nfse: nfse !== undefined && JSON.stringify(nfse) !== JSON.stringify(nfseAnterior),
      charges: charges !== undefined && JSON.stringify(charges) !== JSON.stringify(chargesAnterior)
    }
  };
}

/**
 * Cunha um token de webhook novo, grava e o devolve — a única vez em que ele
 * sai do servidor. 32 bytes do CSPRNG em base64url: cabe num cabeçalho sem
 * escapar nada e está dentro do tamanho que o gateway aceita.
 */
export async function generateWebhookToken() {
  const webhookToken = crypto.randomBytes(32).toString('base64url');
  const { settings } = await save({ webhookToken });
  return { webhookToken, settings };
}

export default {
  readPublic,
  effectiveApiKey,
  effectiveWebhookToken,
  effectiveEnvironment,
  effectiveBaseUrl,
  effectiveNfseConfig,
  effectiveChargesConfig,
  save,
  generateWebhookToken,
  invalidateAsaasSettings
};
