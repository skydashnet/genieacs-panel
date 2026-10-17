import { isUniqueViolation } from '../../config/database.js';
import { runInTenant } from '../../config/tenantContext.js';
import BillingCharge, { isProration } from '../../models/BillingCharge.js';
import BillingEvent from '../../models/BillingEvent.js';
import BillingInvoice, { REISSUABLE_INVOICE_STATUSES, safeInvoiceUrl } from '../../models/BillingInvoice.js';
import {
  AsaasError, authorizeInvoice, cancelInvoice, createInvoice, getInvoice, listInvoicesForPayment
} from './asaasClient.js';
import { effectiveApiKey, effectiveNfseConfig } from './asaasSettingsService.js';

/**
 * A NFS-e das cobranças pagas, pela Asaas.
 *
 * ## Três tempos, e só um fala com a Asaas
 *
 * 1. **A fila** (`enqueueForCharge`): o pagamento confirmado — pelo webhook ou
 *    pela baixa do console — grava uma linha `pending` e mais nada. Nunca se
 *    chama a Asaas dali: o webhook precisa responder rápido e não pode falhar
 *    porque a emissão de nota está fora do ar, e o dinheiro já está creditado
 *    quando esta linha nasce.
 * 2. **O agendador** (`processDue`): pede a nota (`POST /invoices`), guarda o
 *    id ANTES de autorizar e autoriza; com tentativas e espera crescente na
 *    falha. E consulta as agendadas até a prefeitura responder.
 * 3. **O webhook** (`applyWebhook`): `INVOICE_*` atualiza a linha que a Asaas
 *    nomeia, e só ela — nota que o painel não conhece é ignorada.
 *
 * ## Nota não se apaga
 *
 * Uma cobrança duplicada se cancela e ninguém viu; uma nota fiscal duplicada é
 * um documento na prefeitura, com cancelamento sujeito a prazo e a recusa. Por
 * isso a garra (`BillingInvoice.claim`), o id gravado antes da autorização, e
 * a conferência no gateway antes de criar — SEMPRE, e não só depois de uma
 * falha: uma passada anterior pode ter criado a nota e perdido a garra, e a
 * reemissão do console pode estar diante de uma nota que a Asaas ainda tem
 * viva (`listInvoicesForPayment`, `getInvoice`).
 *
 * ## O estorno no meio da passada
 *
 * A passada segura a linha pela garra (`next_attempt_at`), e cada gravação
 * dela exige a linha ainda `pending` e com a MESMA garra
 * (`BillingInvoice.updateIf`). O estorno que chega no meio marca a linha
 * (`canceled`, ou `canceling` quando há nota na Asaas), a gravação da passada
 * não acontece, e a passada, relendo, cancela na Asaas a nota que acabou de
 * criar. Cancelamento que falha vira `canceling`, e o agendador insiste.
 */

/** Quanto tempo a passada segura a linha enquanto fala com a Asaas. */
const CLAIM_MS = 5 * 60 * 1000;

/** De quanto em quanto tempo se pergunta pela nota agendada. */
export const POLL_INTERVAL_MS = 10 * 60 * 1000;

/** Tentativas de pedir a nota antes de desistir e deixá-la para o console. */
export const MAX_ATTEMPTS = 8;

/** As notas que a Asaas já não tem como válidas — as únicas que se pode substituir. */
const MORTAS_NA_ASAAS = new Set(['canceled', 'error']);

/**
 * Se a nota que a Asaas descreve ainda vale (ou pode vir a valer). Estado
 * desconhecido — `PROCESSING_CANCELLATION`, um nome novo — conta como viva:
 * na dúvida, não se pede a segunda nota do mesmo pagamento.
 */
export function isAliveAtGateway(nota) {
  return !MORTAS_NA_ASAAS.has(statusFromGateway(nota?.status));
}

/**
 * Tentativas de cancelar a nota de um estorno antes de desistir: a linha vira
 * `error` com o pedido de cancelar à mão, e o agendador para de insistir.
 */
export const MAX_CANCEL_ATTEMPTS = 10;

/** Quantas notas uma passada leva adiante, por provedor. */
const BATCH = 5;

/** A espera depois da tentativa `n` (1, 2, …): 5 min dobrando, até 12 h. */
export function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(5 * 60 * 1000 * 2 ** (n - 1), 12 * 60 * 60 * 1000);
}

/** O estado da Asaas no vocabulário da tabela — ou nulo, quando não muda nada. */
export function statusFromGateway(status) {
  switch (String(status ?? '').toUpperCase()) {
    case 'SCHEDULED':
    case 'SYNCHRONIZED':
    case 'AUTHORIZATION_PENDING':
      return 'scheduled';
    case 'AUTHORIZED':
    // A prefeitura recusou o CANCELAMENTO: a nota continua valendo.
    case 'CANCELLATION_DENIED':
      return 'authorized';
    case 'ERROR':
      return 'error';
    case 'CANCELED':
    case 'CANCELLED':
      return 'canceled';
    default:
      return null;
  }
}

/** O estado que o EVENTO afirma, para quando o corpo não traz `status`. */
const STATUS_DO_EVENTO = Object.freeze({
  INVOICE_AUTHORIZED: 'authorized',
  INVOICE_ERROR: 'error',
  INVOICE_CANCELED: 'canceled',
  INVOICE_CANCELLATION_DENIED: 'authorized'
});

/**
 * De que estado a linha pode ir para cada um. O webhook reentrega e não
 * garante ordem: um `INVOICE_UPDATED` atrasado com `SCHEDULED` não pode
 * desfazer uma nota já autorizada, nem reabrir uma cancelada.
 */
const TRANSICOES = Object.freeze({
  scheduled: new Set(['pending', 'scheduled', 'error']),
  // `canceling` não sai por aqui: um `INVOICE_AUTHORIZED` atrasado não
  // desfaz o pedido de cancelamento do estorno — quem o tira de lá é o
  // cancelamento confirmado, ou a recusa dele (`applyWebhook`).
  // Não de `canceled`: um `INVOICE_AUTHORIZED` atrasado não desfaz o
  // cancelamento do estorno. A volta de cancelada para autorizada é só a da
  // recusa do cancelamento, tratada à parte em `applyWebhook`.
  authorized: new Set(['pending', 'scheduled', 'error', 'authorized']),
  error: new Set(['pending', 'scheduled']),
  canceled: new Set(['pending', 'scheduled', 'authorized', 'error', 'canceling'])
});

/** O fuso da prefeitura: a competência da nota é o dia de lá, não o do servidor. */
const FUSO_DA_NOTA = 'America/Sao_Paulo';

/** `YYYY-MM-DD` de hoje em São Paulo — a data de competência da nota. */
export function effectiveDateOf(now = new Date()) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO_DA_NOTA, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map((parte) => [parte.type, parte.value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}

/** O que gravar na linha a partir de uma resposta da Asaas. */
function patchDaNota(nota, statusAtual, now = new Date()) {
  const status = statusFromGateway(nota.status);
  const patch = {};
  if (status && TRANSICOES[status]?.has(statusAtual)) patch.status = status;
  const final = patch.status ?? statusAtual;
  if (nota.number) patch.number = nota.number;
  const pdf = safeInvoiceUrl(nota.pdfUrl);
  const xml = safeInvoiceUrl(nota.xmlUrl);
  if (pdf) patch.pdf_url = pdf;
  if (xml) patch.xml_url = xml;
  if (final === 'authorized') {
    patch.error = null;
    if (patch.status === 'authorized' && statusAtual !== 'authorized') patch.issued_at = now;
  } else if (final === 'error') {
    patch.error = nota.statusDescription || 'The city hall refused the invoice';
  }
  return patch;
}

/**
 * A observação padrão da nota: o período da cobrança — e, na de pró-rata
 * (0101), que é a diferença da troca de plano daquele período (a chave dela
 * não é data; o fim do período está em `proration_detail`).
 */
function observacaoDaCobranca(charge) {
  const fim = BillingCharge.periodEndOf(charge);
  const ate = fim ? String(fim).slice(0, 10) : '';
  if (isProration(charge)) return ate ? `Pró-rata da troca de plano, período até ${ate}` : 'Pró-rata da troca de plano';
  return `Período até ${ate}`;
}

/**
 * O corpo do `POST /invoices`, da configuração e da cobrança.
 *
 * `valueCents` é o que de fato ENTROU por esta cobrança (ver
 * `valorRecebido`): a baixa que aceitou um pagamento a menos fatura o que
 * veio, não o que se pediu. Sem ele, o valor da cobrança.
 */
export function invoicePayload(config, charge, now = new Date(), valueCents = charge.amount_cents) {
  return {
    payment: String(charge.gateway_charge_id),
    serviceDescription: config.serviceDescription,
    // A Asaas pede o campo; sem observação configurada, o período da cobrança
    // é o que melhor explica a nota a quem a lê.
    observations: config.observations || observacaoDaCobranca(charge),
    valueCents: Number(valueCents),
    deductions: 0,
    effectiveDate: effectiveDateOf(now),
    ...(config.municipalServiceId ? { municipalServiceId: config.municipalServiceId } : {}),
    ...(config.municipalServiceCode ? { municipalServiceCode: config.municipalServiceCode } : {}),
    ...(config.municipalServiceName ? { municipalServiceName: config.municipalServiceName } : {}),
    externalReference: `charge:${charge.id}`,
    taxes: {
      retainIss: Boolean(config.retainIss),
      iss: Number(config.issPercent) || 0,
      cofins: 0,
      csll: 0,
      inss: 0,
      ir: 0,
      pis: 0
    }
  };
}

function motivo(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500);
}

/**
 * Quanto entrou por esta cobrança, pelo extrato: a soma dos pagamentos com a
 * referência dela (o id no gateway, ou `charge:<id>`). Sem pagamento nenhum
 * registrado — a linha marcada paga à mão —, o valor da cobrança.
 */
async function valorRecebido(cobranca) {
  const refs = [cobranca.gateway_charge_id, `charge:${cobranca.id}`];
  const soma = await BillingEvent.receivedFor(refs);
  return soma === null ? Number(cobranca.amount_cents) : soma;
}

/** O relógio da passada: o `now` pedido, andando com o tempo real desde o começo dela. */
function relogioDesde(now) {
  const base = now.getTime();
  const inicio = Date.now();
  return () => new Date(base + Math.max(0, Date.now() - inicio));
}

class BillingInvoiceService {
  /**
   * Põe a nota de uma cobrança paga na fila — no escopo do provedor dela.
   *
   * Idempotente pela cobrança: a segunda chamada (o webhook reentregue, a
   * baixa depois do webhook) encontra a linha e não faz nada. Nunca lança:
   * quem chama acabou de creditar dinheiro, e a nota é consequência, não
   * condição.
   *
   * @returns {Promise<{ enqueued: boolean, reason?: string }>}
   */
  static async enqueueForCharge(charge) {
    try {
      if (!charge?.id) return { enqueued: false, reason: 'no_charge' };
      // Só o que passou pelo gateway: a nota da Asaas é de um PAGAMENTO dela,
      // e a baixa de uma cobrança que nunca saiu de cá não tem o que apontar.
      if (!charge.gateway_charge_id) return { enqueued: false, reason: 'no_gateway_payment' };
      const config = await effectiveNfseConfig();
      if (!config.nfseEnabled) return { enqueued: false, reason: 'disabled' };
      if (await BillingInvoice.forCharge(charge.id)) return { enqueued: false, reason: 'exists' };
      try {
        await BillingInvoice.enqueue(charge.id);
      } catch (error) {
        if (isUniqueViolation(error)) return { enqueued: false, reason: 'exists' };
        throw error;
      }
      return { enqueued: true };
    } catch (error) {
      console.error(`Could not queue the invoice of charge ${charge?.id}: ${error.message}`);
      return { enqueued: false, reason: 'error' };
    }
  }

  /**
   * O pedido do console: emitir a nota de uma cobrança paga, ou emitir de novo
   * a que deu erro ou foi cancelada. Lança `InvoiceRequestError` com o código
   * da recusa; quem chama está no escopo do provedor.
   *
   * A reemissão de uma linha que já tem id na Asaas pergunta antes à Asaas:
   * o erro ou o cancelamento que a linha diz pode ser só o que o painel viu
   * (um webhook perdido, uma nota corrigida lá à mão). Viva lá, a nota é
   * ADOTADA — a linha volta a apontar para ela, e a resposta é 409
   * `invoice_exists` com `adopted` —, e nenhuma segunda nota é pedida.
   */
  static async requestForCharge(charge) {
    if (!charge) throw new InvoiceRequestError(404, 'Charge not found', 'not_found');
    if (charge.status !== 'paid') {
      throw new InvoiceRequestError(409, `The charge is ${charge.status}, not paid`, 'not_paid', { status: charge.status });
    }
    if (!charge.gateway_charge_id) {
      throw new InvoiceRequestError(
        409, 'The charge was not paid through the gateway; there is no payment to invoice', 'no_gateway_payment'
      );
    }
    const config = await effectiveNfseConfig();
    if (!config.nfseEnabled) {
      throw new InvoiceRequestError(409, 'Invoice issuing is turned off in Integrations', 'nfse_disabled');
    }

    const atual = await BillingInvoice.forCharge(charge.id);
    if (!atual) {
      try {
        await BillingInvoice.enqueue(charge.id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      return { invoice: await BillingInvoice.forCharge(charge.id), statusBefore: null };
    }
    if (!REISSUABLE_INVOICE_STATUSES.includes(atual.status)) {
      throw new InvoiceRequestError(409, `The charge already has a ${atual.status} invoice`, 'invoice_exists', {
        invoiceStatus: atual.status
      });
    }
    if (atual.external_id) {
      let nota = null;
      try {
        nota = await getInvoice(atual.external_id);
      } catch (error) {
        // 404: a Asaas não tem mais a nota — nada a adotar, pode-se pedir outra.
        if (!(error instanceof AsaasError && Number(error.status) === 404)) {
          throw new InvoiceRequestError(
            502, `Could not check the current invoice at the gateway: ${motivo(error)}`, 'gateway_failed'
          );
        }
      }
      if (nota && isAliveAtGateway(nota)) {
        const status = statusFromGateway(nota.status) ?? 'scheduled';
        const patch = {
          ...patchDaNota({ ...nota, status: null }, status),
          status,
          error: null,
          next_attempt_at: status === 'scheduled' ? new Date() : null,
          ...(status === 'authorized' && !atual.issued_at ? { issued_at: new Date() } : {})
        };
        const adotou = await BillingInvoice.updateIf(atual.id, { status: atual.status, externalId: atual.external_id }, patch);
        if (!adotou) throw new InvoiceRequestError(409, 'The invoice changed meanwhile; try again', 'busy');
        throw new InvoiceRequestError(
          409, `The gateway still has this invoice as ${status}; it was linked back instead of issuing another`,
          'invoice_exists', { invoiceStatus: status, adopted: true }
        );
      }
    }
    // A MESMA linha volta ao começo (ver `BillingInvoice.reopen`).
    const changed = await BillingInvoice.reopen(atual.id, atual.status);
    if (!changed) {
      throw new InvoiceRequestError(409, 'The invoice changed meanwhile; try again', 'busy');
    }
    return { invoice: await BillingInvoice.findById(atual.id), statusBefore: atual.status };
  }

  /**
   * A passada do agendador, no escopo de UM provedor.
   *
   * Sem chave da API, nada: não há com quem falar, e contar isso como
   * tentativa esgotaria as tentativas de uma nota que nunca foi tentada. Com a
   * emissão desligada, as pendentes esperam (quem desligou não quer nota
   * nova), mas as agendadas continuam sendo consultadas e os cancelamentos
   * pendentes continuam sendo pedidos — essas notas já existem na Asaas.
   *
   * Cada linha toma a garra com o relógio de AGORA (`relogioDesde`), e não o
   * do começo da passada: uma passada lenta não pode pôr numa linha uma garra
   * que já nasce perto de vencer.
   */
  static async processDue({ now = new Date(), limit = BATCH } = {}) {
    const resumo = { issued: 0, failed: 0, polled: 0, canceled: 0 };
    if (!(await effectiveApiKey())) return resumo;
    const config = await effectiveNfseConfig();
    const relogio = relogioDesde(now);

    for (const linha of await BillingInvoice.due({ statuses: ['canceling'], now: relogio(), limit })) {
      // eslint-disable-next-line no-await-in-loop
      if (await BillingInvoiceService.retryCancel(linha, relogio())) resumo.canceled += 1;
    }
    if (config.nfseEnabled) {
      for (const linha of await BillingInvoice.due({ statuses: ['pending'], now: relogio(), limit })) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await BillingInvoiceService.issueOne(linha, config, relogio());
        if (ok === true) resumo.issued += 1;
        else if (ok === false) resumo.failed += 1;
      }
    }
    for (const linha of await BillingInvoice.due({ statuses: ['scheduled'], now: relogio(), limit })) {
      // eslint-disable-next-line no-await-in-loop
      if (await BillingInvoiceService.pollOne(linha, relogio())) resumo.polled += 1;
    }
    return resumo;
  }

  /**
   * A passada perdeu a linha no meio (o estorno a marcou, ou a garra venceu e
   * outra passada a tomou) com uma nota criada na Asaas por ela. Relê e, se o
   * que mudou foi um pedido de cancelamento, cancela também esta nota — que o
   * estorno não tinha como conhecer.
   */
  static async lostClaim(linhaId, externalId, now) {
    const agora = await BillingInvoice.findById(linhaId);
    if (!agora || !externalId) return;
    if (agora.status !== 'canceled' && agora.status !== 'canceling') {
      // Outra passada tem a linha: ela pergunta à Asaas antes de criar e
      // adota esta nota (ver `issueOne`).
      console.warn(`Invoice ${linhaId}: the claim was lost mid-pass; ${externalId} is left for the next pass to adopt`);
      return;
    }
    // O estorno já viu esta nota (a linha aponta para ela): o cancelamento
    // dela está feito ou a caminho.
    if (agora.external_id === externalId) return;
    if (!agora.external_id) {
      // Marcada cancelada antes de a nota existir: a linha passa a apontar
      // para ela, e é ela que se cancela.
      const apontou = await BillingInvoice.updateIf(linhaId, { status: agora.status, externalId: null }, {
        external_id: externalId
      });
      if (apontou) {
        await BillingInvoiceService.cancelAtGateway({ id: linhaId, status: agora.status }, externalId, now);
        return;
      }
    }
    // Uma nota órfã, que a linha não nomeia: cancelada, e dito em voz alta.
    console.error(`Invoice ${linhaId}: ${externalId} was created for a refunded charge; canceling it at the gateway`);
    await BillingInvoiceService.cancelAtGateway({ id: linhaId, status: agora.status }, externalId, now, { record: false });
  }

  /** Pede (e autoriza) uma nota pendente. `true` saiu, `false` falhou, `null` não era para agora. */
  static async issueOne(linha, config, now = new Date()) {
    const garra = await BillingInvoice.claim(linha, { until: new Date(now.getTime() + CLAIM_MS), now });
    if (!garra) return null;
    // Toda gravação da passada: a linha ainda pendente, ainda com esta garra.
    const gravar = (patch) => BillingInvoice.updateIf(linha.id, { status: 'pending', token: garra }, patch);

    const cobranca = await BillingCharge.findById(linha.charge_id);
    // A cobrança foi estornada (ou mexida à mão) entre a fila e aqui: nota de
    // dinheiro que voltou não se emite — e a que já existe na Asaas se cancela.
    if (!cobranca || cobranca.status !== 'paid') {
      const porque = `The charge is ${cobranca?.status ?? 'gone'}; no invoice issued`;
      if (linha.external_id) {
        if (await gravar({ status: 'canceling', error: porque, attempts: 0 })) {
          await BillingInvoiceService.cancelAtGateway({ id: linha.id, status: 'canceling' }, linha.external_id, now);
        }
        return null;
      }
      await gravar({ status: 'canceled', error: porque, next_attempt_at: null });
      return null;
    }
    if (!cobranca.gateway_charge_id) {
      await gravar({ status: 'error', error: 'The charge has no gateway payment to invoice', next_attempt_at: null });
      return false;
    }
    const valor = await valorRecebido(cobranca);
    if (!(valor > 0)) {
      await gravar({ status: 'error', error: 'Nothing was received for this charge; no invoice issued', next_attempt_at: null });
      return false;
    }

    let externalId = linha.external_id || null;
    let adotada = null;
    try {
      if (!externalId) {
        // SEMPRE, e não só depois de uma falha: uma tentativa anterior pode ter
        // criado a nota e perdido a resposta, ou perdido a garra antes de
        // gravar o id. Recriar seria a segunda nota do mesmo pagamento;
        // adota-se a viva.
        const existentes = await listInvoicesForPayment(cobranca.gateway_charge_id);
        adotada = existentes.find(isAliveAtGateway) ?? null;
        if (adotada) externalId = adotada.id;
      }
      if (!externalId) {
        const criada = await createInvoice(invoicePayload(config, cobranca, now, valor));
        externalId = criada.id;
      }
      // O id fica gravado ANTES da autorização: se ela falhar, a próxima
      // tentativa autoriza esta nota em vez de pedir outra.
      if (externalId !== linha.external_id && !(await gravar({ external_id: externalId }))) {
        await BillingInvoiceService.lostClaim(linha.id, externalId, now);
        return null;
      }
      // A adotada que a prefeitura já autorizou não se autoriza de novo.
      const autorizada = adotada && statusFromGateway(adotada.status) === 'authorized'
        ? adotada
        : await authorizeInvoice(externalId);
      const patch = patchDaNota(autorizada, 'pending', now);
      if (!patch.status) patch.status = 'scheduled';
      const gravou = await gravar({
        ...patch,
        attempts: Number(linha.attempts) + 1,
        // Agendada, a próxima pergunta é a consulta — não antes do intervalo.
        next_attempt_at: patch.status === 'scheduled' ? new Date(now.getTime() + POLL_INTERVAL_MS) : null,
        ...(patch.status === 'scheduled' ? { error: null } : {})
      });
      if (!gravou) {
        await BillingInvoiceService.lostClaim(linha.id, externalId, now);
        return null;
      }
      return true;
    } catch (error) {
      const tentativas = Number(linha.attempts) + 1;
      const esgotou = tentativas >= MAX_ATTEMPTS;
      console.warn(
        `Invoice ${linha.id} (charge ${linha.charge_id}) failed at the gateway, attempt ${tentativas}: ${motivo(error)}`
      );
      const gravou = await gravar({
        ...(externalId ? { external_id: externalId } : {}),
        status: esgotou ? 'error' : 'pending',
        error: motivo(error),
        attempts: tentativas,
        next_attempt_at: esgotou ? null : new Date(now.getTime() + backoffMs(tentativas))
      });
      if (!gravou && externalId) await BillingInvoiceService.lostClaim(linha.id, externalId, now);
      return false;
    }
  }

  /** Pergunta à Asaas pela nota agendada. */
  static async pollOne(linha, now = new Date()) {
    if (!linha.external_id) return false;
    const garra = await BillingInvoice.claim(linha, { until: new Date(now.getTime() + POLL_INTERVAL_MS), now });
    if (!garra) return false;
    try {
      const nota = await getInvoice(linha.external_id);
      const patch = patchDaNota(nota, linha.status, now);
      const final = patch.status ?? linha.status;
      // Condicional como na emissão: o estorno que pediu o cancelamento no
      // meio desta consulta não é desfeito por ela.
      await BillingInvoice.updateIf(linha.id, { status: linha.status, token: garra }, {
        ...patch,
        next_attempt_at: final === 'scheduled' ? new Date(now.getTime() + POLL_INTERVAL_MS) : null
      });
      return true;
    } catch (error) {
      // A garra já empurrou a próxima consulta para depois do intervalo.
      console.warn(`Could not read invoice ${linha.external_id} at the gateway: ${motivo(error)}`);
      return false;
    }
  }

  /**
   * Cancela na Asaas a nota `externalId` da linha (que está em `linha.status`)
   * e grava o resultado. Nunca lança.
   *
   * Recusado ou fora do ar, pergunta como a nota está: já cancelada ou com
   * erro lá, não há o que cancelar e a linha fica `canceled`; viva, a linha
   * fica `canceling` e o agendador tenta de novo, com a espera crescente das
   * emissões (até doze horas entre uma e outra), e o erro fica na linha para
   * o console. Depois de `MAX_CANCEL_ATTEMPTS` falhas, desiste: a linha vira
   * `error`, com o pedido de cancelar à mão no painel da Asaas.
   *
   * `record: false` cancela uma nota que não é a da linha (a órfã de uma
   * corrida): só a chamada e o log.
   *
   * @returns {Promise<{ canceled: boolean, reason?: string }>}
   */
  static async cancelAtGateway(linha, externalId, now = new Date(), { record = true } = {}) {
    const gravar = (patch) => (record
      ? BillingInvoice.updateIf(linha.id, { status: linha.status, externalId }, patch)
      : Promise.resolve(false));
    try {
      const nota = await cancelInvoice(externalId);
      const status = statusFromGateway(nota.status);
      // A Asaas pode responder "processando o cancelamento": a linha já fica
      // cancelada, e o `INVOICE_CANCELLATION_DENIED` a devolve se a
      // prefeitura recusar.
      await gravar({
        status: status === 'authorized' ? 'authorized' : 'canceled',
        error: status === 'authorized' ? 'The city hall denied the cancellation' : null,
        next_attempt_at: null
      });
      return { canceled: status !== 'authorized', ...(status === 'authorized' ? { reason: 'denied' } : {}) };
    } catch (error) {
      let lida = null;
      try { lida = await getInvoice(externalId); } catch { lida = null; }
      if (lida && !isAliveAtGateway(lida)) {
        await gravar({ status: 'canceled', error: null, next_attempt_at: null });
        return { canceled: true, reason: 'already_dead_at_gateway' };
      }
      const atual = record ? await BillingInvoice.findById(linha.id) : null;
      const tentativas = linha.status === 'canceling' ? Number(atual?.attempts ?? 0) + 1 : 1;
      const desistiu = tentativas >= MAX_CANCEL_ATTEMPTS;
      console.error(
        `Could not cancel invoice ${externalId} (attempt ${tentativas}): ${motivo(error)}`
        + (record && !desistiu ? ' — will retry' : ' — cancel it at the gateway')
      );
      if (desistiu) {
        // A prefeitura (ou a Asaas) não deixa: insistir para sempre só enche
        // o log. A linha vira `error` com o recado para o console — e a
        // reemissão não alcança, porque a cobrança estornada não está paga.
        await gravar({
          status: 'error',
          error: (`Cancelamento recusado pela prefeitura/Asaas após ${tentativas} tentativas — cancele manualmente `
            + `no painel do Asaas. Último erro: ${motivo(error)}`).slice(0, 500),
          attempts: tentativas,
          next_attempt_at: null
        });
        return { canceled: false, reason: 'gave_up' };
      }
      // A espera cresce até as doze horas de `backoffMs`.
      await gravar({
        status: 'canceling',
        error: `Cancellation failed: ${motivo(error)}`.slice(0, 500),
        attempts: tentativas,
        next_attempt_at: new Date(now.getTime() + backoffMs(tentativas))
      });
      return { canceled: false, reason: error instanceof AsaasError ? 'gateway_failed' : 'error' };
    }
  }

  /** O agendador insistindo num cancelamento que falhou. */
  static async retryCancel(linha, now = new Date()) {
    if (!linha.external_id) {
      await BillingInvoice.updateIf(linha.id, { status: 'canceling', externalId: null }, {
        status: 'canceled', next_attempt_at: null
      });
      return true;
    }
    const garra = await BillingInvoice.claim(linha, { until: new Date(now.getTime() + CLAIM_MS), now });
    if (!garra) return false;
    const resultado = await BillingInvoiceService.cancelAtGateway(
      { id: linha.id, status: 'canceling' }, linha.external_id, now
    );
    return resultado.canceled;
  }

  /**
   * Cancela a nota de uma cobrança estornada — no escopo do provedor.
   *
   * Nunca lança, e nunca bloqueia o estorno: o dinheiro já voltou. Toda nota
   * que tem id na Asaas — inclusive a `error`, que pode ter sido corrigida lá —
   * é cancelada lá; a que falha fica `canceling`, e o agendador insiste. A
   * pendente que nunca chegou à Asaas só é marcada cancelada — e a passada
   * que a estiver levando agora vê a marca e cancela o que tiver criado (ver
   * `issueOne`).
   *
   * @returns {Promise<{ canceled: boolean, reason?: string }>}
   */
  static async cancelForCharge(chargeId) {
    try {
      // Até três leituras: cada gravação é condicional ao estado lido, e uma
      // passada do agendador pode estar mexendo na mesma linha.
      for (let volta = 0; volta < 3; volta += 1) {
        // eslint-disable-next-line no-await-in-loop
        const linha = await BillingInvoice.forCharge(chargeId);
        if (!linha) return { canceled: false, reason: 'no_invoice' };
        if (linha.status === 'canceled') return { canceled: false, reason: 'already_canceled' };
        if (!linha.external_id) {
          // eslint-disable-next-line no-await-in-loop
          const marcou = await BillingInvoice.updateIf(linha.id, { status: linha.status, externalId: null }, {
            status: 'canceled', error: 'Canceled before issuing: the charge was refunded', next_attempt_at: null
          });
          if (marcou) return { canceled: true, reason: 'not_issued' };
          continue;
        }
        // Primeiro a marca (`canceling`), condicional: a passada que segura a
        // linha perde as próximas gravações e não a desfaz.
        // eslint-disable-next-line no-await-in-loop
        const marcou = await BillingInvoice.updateIf(linha.id, { status: linha.status, externalId: linha.external_id }, {
          status: 'canceling', attempts: linha.status === 'canceling' ? linha.attempts : 0
        });
        if (!marcou) continue;
        // eslint-disable-next-line no-await-in-loop
        return await BillingInvoiceService.cancelAtGateway({ id: linha.id, status: 'canceling' }, linha.external_id);
      }
      return { canceled: false, reason: 'busy' };
    } catch (error) {
      console.error(
        `Could not cancel the invoice of refunded charge ${chargeId}: ${motivo(error)} — cancel it at the gateway`
      );
      return { canceled: false, reason: error instanceof AsaasError ? 'gateway_failed' : 'error' };
    }
  }

  /**
   * Uma entrega `INVOICE_*` do webhook. Fora de escopo na entrada; abre o do
   * provedor dono da nota. Nunca lança — a resposta ao gateway é sempre 200.
   *
   * @returns {Promise<string>} o código para o corpo da resposta.
   */
  static async applyWebhook(body) {
    const evento = String(body?.event ?? '');
    const nota = body?.invoice;
    const externalId = nota?.id ? String(nota.id).slice(0, 64) : null;
    if (!externalId) return 'ignored';
    try {
      const tenantId = await BillingInvoice.tenantOfExternalId(externalId);
      if (!tenantId) return 'unknown_invoice';
      return await runInTenant(tenantId, async () => {
        const linha = await BillingInvoice.byExternalId(externalId);
        if (!linha) return 'unknown_invoice';
        // O pagamento da nota tem de ser o da cobrança desta linha: um id que
        // casasse com a cobrança de outro provedor seria escrever na nota
        // errada.
        if (nota.payment) {
          const cobranca = await BillingCharge.findById(linha.charge_id);
          if (cobranca?.gateway_charge_id && String(cobranca.gateway_charge_id) !== String(nota.payment)) {
            console.warn(`Invoice webhook: ${externalId} names payment ${nota.payment}, not the charge's; ignored`);
            return 'payment_mismatch';
          }
        }
        const lida = {
          status: nota.status || null,
          number: nota.number ? String(nota.number).slice(0, 64) : null,
          pdfUrl: safeInvoiceUrl(nota.pdfUrl),
          xmlUrl: safeInvoiceUrl(nota.xmlUrl),
          statusDescription: nota.statusDescription ? String(nota.statusDescription).slice(0, 500) : null
        };
        if (!statusFromGateway(lida.status) && STATUS_DO_EVENTO[evento]) {
          lida.status = STATUS_DO_EVENTO[evento].toUpperCase();
        }
        const negado = evento === 'INVOICE_CANCELLATION_DENIED';
        // A recusa do cancelamento é a única volta de `canceled` (e de
        // `canceling`, que pararia de insistir): a nota que o estorno pediu
        // para cancelar continua valendo, e a tela tem de dizer.
        const cancelando = linha.status === 'canceled' || linha.status === 'canceling';
        const patch = patchDaNota(lida, negado && cancelando ? 'authorized' : linha.status);
        if (negado) {
          if (cancelando) patch.status = 'authorized';
          patch.error = lida.statusDescription || 'The city hall denied the cancellation';
        }
        if (!Object.keys(patch).length) return 'unchanged';
        const final = patch.status ?? linha.status;
        if (!['scheduled', 'pending', 'canceling'].includes(final)) patch.next_attempt_at = null;
        // Condicional ao estado lido: a passada ou o estorno que mexeram na
        // linha entre a leitura e aqui não são desfeitos pela entrega.
        const gravou = await BillingInvoice.updateIf(linha.id, { status: linha.status }, patch);
        return gravou ? 'invoice_updated' : 'unchanged';
      });
    } catch (error) {
      console.error(`Invoice webhook: could not apply ${evento} for ${externalId}: ${error.message}`);
      return 'update_failed';
    }
  }
}

export class InvoiceRequestError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export default BillingInvoiceService;
