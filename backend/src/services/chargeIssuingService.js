import BillingCharge, {
  OPEN_CHARGE_STATUSES, EXEMPT_CANCEL_MARKER, RETENTION_CANCEL_MARKER, isProration, isOverageCharge, isoDateOf
} from '../models/BillingCharge.js';
import Tenant from '../models/Tenant.js';
import { currentTenantId } from '../config/tenantContext.js';
import { isUniqueViolation } from '../config/database.js';
import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import Coupon from '../models/Coupon.js';
import UsagePeak from '../models/UsagePeak.js';
import { providerFor } from './billing/registry.js';
import { PRODUCT_NAME } from '../config/brand.js';
import SubscriptionService, {
  isBillableStatus, isCancelScheduled, isPauseScheduled
} from './subscriptionService.js';
import CardAutopayService from './billing/cardAutopayService.js';
import TenantCredit from '../models/TenantCredit.js';

/**
 * A régua de emissão: quem cobra o provedor, e quando.
 *
 * O webhook já sabia receber a notícia de um pagamento; o que não existia era
 * pedir o pagamento. A cobrança se criava à mão no painel do gateway, uma por
 * cliente por mês, e é a tarefa que deixa de caber quando são cinquenta.
 *
 * ## Por que a emissão sai ANTES do vencimento, e não no dia
 *
 * Um boleto leva até três dias úteis para compensar, e o financeiro de um ISP
 * não paga no mesmo dia em que recebe. Emitir no vencimento é emitir atrasado:
 * o provedor é bloqueado enquanto o dinheiro está a caminho. `LEAD_DAYS` é essa
 * folga, e é um parâmetro comercial próprio — deliberadamente NÃO é
 * `SubscriptionService.REMINDER_BEFORE_DAYS`, que responde outra pergunta
 * (quanto antes uma PESSOA precisa ser lembrada) e muda por outros motivos.
 *
 * ## A memória, e por que ela é uma linha e não uma marca
 *
 * `expiry_warned_for` não serve aqui, por três razões, e a primeira sozinha
 * bastaria: ela já tem dono. Dois jobs escrevendo a mesma coluna se apagam — o
 * aviso marca o prazo, a emissão lê "já feito" e nunca emite. Além disso ela é
 * booleana por prazo, e a emissão precisa lembrar QUAL cobrança criou, para o
 * webhook reconciliar; e a janela dela é a do aviso.
 *
 * A memória é a linha em `billing_charges`, com `(tenant_id, period_end)`
 * único. Ela herda de `expiry_warned_for` a propriedade que a torna certa — um
 * pagamento empurra `renews_at`, o período seguinte tem outra chave, e o ciclo
 * recomeça sem ninguém limpar nada — e acrescenta o que faltava: o id no
 * gateway, o link, o estado e o motivo da falha.
 *
 * ## A linha nasce antes da chamada
 *
 * Gravar depois da resposta seria deixar a janela aberta: duas passadas que se
 * cruzassem criariam duas cobranças de verdade na mão de um cliente pagante. A
 * inserção é o bilhete que ganha a corrida, e o índice único é quem a decide.
 *
 * O que sobra é a falha do meio — o gateway criou a cobrança e a resposta se
 * perdeu. Aí a linha fica `pending` sem `gateway_charge_id`, que é um estado
 * reconhecível, e a retentativa manda a MESMA `externalReference`
 * (`tenant:<id>:<período>`), para que a reconciliação do outro lado tenha por
 * onde perceber. Uma cobrança duplicada no gateway é um problema visível e
 * corrigível; uma cobrança que nunca saiu, não.
 */
/**
 * A recusa de `followDeadline`, com o status HTTP que o console responde:
 * 409 `busy` (a linha é de outra passada agora) ou 502 `gateway_failed`.
 */
export { EXEMPT_CANCEL_MARKER };

/** Os nomes curtos dos recursos na descrição da fatura no gateway (português, como o resto dela). */
const NOME_DO_RECURSO = Object.freeze({ operators: 'operadores', subscribers: 'assinantes', devices: 'ONTs' });

/** Centavos como "R$ 1.234,56" — a descrição da fatura é texto, sem a formatação da tela. */
function reais(centavos) {
  const n = Math.round(Number(centavos) || 0);
  const inteiro = Math.floor(Math.abs(n) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}R$ ${inteiro},${String(Math.abs(n) % 100).padStart(2, '0')}`;
}

/**
 * O resumo do excedente que vai na descrição da fatura (0105):
 * " + excedente R$ 45,00 (3 operadores × R$ 10,00; 5 ONTs × R$ 3,00)".
 * Vazio sem excedente.
 */
export function overageDescription(parcelas) {
  if (!Array.isArray(parcelas) || !parcelas.length) return '';
  const total = parcelas.reduce((soma, item) => soma + Number(item.cents || 0), 0);
  const partes = parcelas.map((item) => `${item.units} ${NOME_DO_RECURSO[item.resource] ?? item.resource} × ${reais(item.unitCents)}`);
  return ` + excedente ${reais(total)} (${partes.join('; ')})`;
}

/** Todas as cobranças do provedor em escopo (as do excedente se leem pela conta de cada uma). */
const getDbCharges = () => BillingCharge.allForTenant();

export class ChargeFollowError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'ChargeFollowError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

class ChargeIssuingService {
  /** Quantos dias antes do vencimento a cobrança sai — a de Pix/boleto; a do cartão salvo sai no dia (`chargesSavedCard`). */
  static LEAD_DAYS = 5;

  /**
   * Se a próxima cobrança deste provedor sai no cartão salvo (0100): o
   * gateway sabe cobrar cartão salvo e a cobrança automática está utilizável
   * (`CardAutopayService.usable`). A mesma decisão que a emissão toma, para a
   * antecedência da emissão e para a régua de lembretes.
   */
  static chargesSavedCard(provider, subscription) {
    return Boolean(provider?.canChargeSavedCard && CardAutopayService.usable(subscription));
  }

  /** `chargesSavedCard` a partir da linha do provedor (o gateway ligado a ele). */
  static cardAutopayFor(tenant, subscription) {
    if (!tenant?.billing_customer_ref) return false;
    const provider = providerFor(tenant.billing_gateway);
    return Boolean(provider?.canIssue) && this.chargesSavedCard(provider, subscription);
  }

  /**
   * Quantas vezes se insiste numa emissão que falhou.
   *
   * Um teto, e não insistência infinita: se o gateway recusa o CNPJ do
   * provedor, a centésima tentativa recusa igual — e o que resolve é alguém
   * olhar. O `last_error` da linha é o que essa pessoa vai ler.
   */
  static MAX_ATTEMPTS = 5;

  /**
   * Quanto tempo se dá a quem já está vencido, quando a cobrança sai atrasada.
   *
   * Não é indulgência: é o mínimo para um boleto poder ser pago. Emitir com
   * vencimento de hoje para quem já está bloqueado é emitir algo que nasce
   * vencido de novo.
   */
  static OVERDUE_GRACE_DAYS = 3;

  /**
   * Quanto se espera antes de insistir numa emissão que falhou.
   *
   * O agendador passa a cada minuto. Sem esta espera, uma resposta perdida no
   * meio viraria cinco cobranças de verdade em cinco minutos na mão de um
   * cliente pagante — que é o dano que este serviço inteiro existe para não
   * causar. Uma hora é curta para o operador que está olhando e longa o
   * bastante para um gateway se recuperar.
   */
  static RETRY_AFTER_MS = 60 * 60 * 1000;

  /**
   * Por quanto tempo quem vai emitir fica dono da linha (`issuing_until`).
   *
   * Folga larga sobre o prazo da chamada ao gateway (vinte segundos, em
   * `asaasClient`): a garra só precisa durar mais que a chamada, e vencer
   * sozinha quando o processo morre no meio dela — dois minutos depois,
   * alguém retoma a linha em vez de ela ficar presa para sempre.
   */
  static CLAIM_MS = 2 * 60 * 1000;

  /**
   * O fuso em que uma data de cobrança é lida.
   *
   * `toISOString()` é UTC, e o gateway lê `dueDate` no horário do Brasil: um
   * `renews_at` às 02:00Z é o dia ANTERIOR em São Paulo. Três coisas
   * divergiriam por um dia — a chave única, o vencimento e o "faltam N dias" —
   * e a que faz estrago é a chave, porque uma chave errada emite duas vezes.
   */
  static BILLING_TIMEZONE = 'America/Sao_Paulo';

  /** A data ISO de um instante, no fuso da cobrança. `en-CA` já formata YYYY-MM-DD. */
  static isoDate(instante) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.BILLING_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(instante));
  }

  /** A chave do período: o prazo que esta cobrança compra. */
  static periodKey(deadline) {
    return this.isoDate(deadline);
  }

  /**
   * O vencimento que vai ao gateway, que NEM SEMPRE é o fim do período.
   *
   * Um provedor em `past_due` tem o prazo no passado, e um gateway recusa
   * cobrança vencida antes de nascer. Sem esta conta ele falharia cinco vezes,
   * desistiria, e — como `renews_at` só se move com pagamento — a chave do
   * período nunca mudaria e ele nunca mais seria cobrado. É exatamente a
   * população que a emissão existe para resolver, e ela seria a única a ficar
   * de fora, em silêncio.
   */
  static dueDateFor(deadline, now) {
    const doPeriodo = this.isoDate(deadline);
    const hoje = this.isoDate(now);
    return doPeriodo >= hoje ? doPeriodo : this.isoDate(now.getTime() + this.OVERDUE_GRACE_DAYS * 86_400_000);
  }

  /**
   * Fecha as cobranças de períodos que já passaram e não foram pagas por aqui.
   *
   * `canceled` e não `failed`: nada falhou — o período simplesmente acabou, e o
   * provedor está em dia por outro caminho. A diferença importa para quem for
   * ler o histórico depois, e é a razão de os dois estados existirem.
   *
   * ## No gateway primeiro, e só depois aqui
   *
   * Esta faxina cancelava só a LINHA. A cobrança emitida continuava viva na
   * Asaas — com link, lembrete e, depois do vencimento, aviso de atraso —, e a
   * emissão logo abaixo abria a do período novo: duas faturas vivas na mão do
   * provedor, e ele sendo cobrado pela que o painel já dava por encerrada. O
   * caso comum é o prazo mexido à mão (a cortesia do console, a data
   * corrigida), que `followDeadline` agora resolve na hora; esta é a segunda
   * tranca, para o que chegar aqui por qualquer outro caminho — o pagamento
   * avulso que empurrou `renews_at`, um banco mexido à mão.
   *
   * Com a garra, como toda escrita que fala com o gateway por uma linha. E a
   * recusa do gateway deixa a linha EM ABERTO: o motivo mais provável é a
   * cobrança já ter sido paga lá (a Asaas não apaga cobrança recebida), e
   * aí fechá-la aqui como cancelada esconderia um pagamento que o webhook
   * perdeu. O motivo fica em `last_error` e a próxima tentativa espera
   * `RETRY_AFTER_MS` (`next_attempt_at`, que numa linha de período vencido não
   * significa mais nada para a emissão): o agendador passa a cada minuto, e um
   * DELETE recusado por minuto por cobrança seria martelar o gateway.
   */
  static async cancelStale(periodoAtual, { now = new Date() } = {}) {
    const velhas = await BillingCharge.openBefore(periodoAtual);
    let canceladas = 0;
    for (const cobranca of velhas) {
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      const noGateway = typeof provider?.cancelCharge === 'function';
      if (noGateway && cobranca.next_attempt_at) {
        const espera = new Date(cobranca.next_attempt_at);
        if (!Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) continue;
      }
      // eslint-disable-next-line no-await-in-loop -- uma ou duas por provedor, e cada uma fala com o gateway
      const minha = await BillingCharge.claim(cobranca.id, {
        until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
      });
      if (!minha) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        if (noGateway) await provider.cancelCharge(cobranca.gateway_charge_id);
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, { status: 'canceled', issuing_until: null, next_attempt_at: null });
        canceladas += 1;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, {
          last_error: String(error.message ?? '').slice(0, 500),
          next_attempt_at: new Date(now.getTime() + this.RETRY_AFTER_MS),
          issuing_until: null
        });
        console.warn(
          `Stale charge ${cobranca.id} (period ${cobranca.period_end}) could not be canceled at the gateway `
          + `and stays open — it may have been paid there: ${error.message}`
        );
      }
    }
    return canceladas;
  }

  /**
   * Cancela TODAS as cobranças em aberto do provedor em escopo — o que o
   * "isento de cobrança" faz ao ser ligado (`SubscriptionService.setBillingExempt`),
   * e a varredura que o agendador repete enquanto a isenção vale
   * (`issueCurrent` → `billing_exempt`).
   *
   * O mesmo gesto do "cancelar" da tela de Assinaturas, linha a linha: a
   * garra (`claim` com `openOnly`), o gateway primeiro e a linha depois. A
   * diferença é o que a recusa faz: lá ela para tudo e responde 502; aqui a
   * linha que o gateway não cancelou FICA em aberto — com o motivo em
   * `last_error`, a próxima tentativa em `next_attempt_at` e em voz alta no
   * log —, e a isenção vale mesmo assim. Fechar aqui uma cobrança viva no
   * gateway seria esconder um link de pagamento que ainda funciona; e deixar
   * de isentar porque o gateway está fora seria o console sem como cumprir o
   * que decidiu. A varredura do agendador tenta de novo depois da espera.
   *
   * A cancelada por aqui leva `EXEMPT_CANCEL_MARKER` em `last_error`: é por
   * essa marca que o desligar acha a cobrança do período atual e a reabre
   * (`reopenExemptCanceled`) — sem ela a linha ficaria `canceled`, a emissão
   * responderia `already_settled` para sempre e o provedor venceria sem fatura.
   *
   * `honorBackoff` é o da varredura: ela passa a cada minuto, e um DELETE
   * recusado por minuto por cobrança seria martelar o gateway (a mesma espera
   * de `cancelStale`). O clique do console tenta na hora.
   *
   * @returns {Promise<{ canceled: number, failed: number[] }>} quantas saíram,
   *   e os ids das que ficaram (recusa do gateway, em espera, ou tomadas por
   *   outra passada).
   */
  static async cancelOpenCharges({ now = new Date(), honorBackoff = false } = {}) {
    const abertas = await BillingCharge.openAll();
    let canceladas = 0;
    const ficaram = [];
    for (const cobranca of abertas) {
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      const noGateway = typeof provider?.cancelCharge === 'function';
      if (honorBackoff && noGateway && cobranca.next_attempt_at) {
        const espera = new Date(cobranca.next_attempt_at);
        if (!Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
          ficaram.push(cobranca.id);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop -- uma ou duas por provedor, e cada uma fala com o gateway
      const minha = await BillingCharge.claim(cobranca.id, {
        until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
      });
      if (!minha) {
        console.warn(`Open charge ${cobranca.id} was busy and stays open while exempting provider ${cobranca.tenant_id}`);
        ficaram.push(cobranca.id);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        if (noGateway) await provider.cancelCharge(cobranca.gateway_charge_id);
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, {
          status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: EXEMPT_CANCEL_MARKER
        });
        canceladas += 1;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(cobranca.id, {
          last_error: String(error.message ?? '').slice(0, 500),
          next_attempt_at: new Date(now.getTime() + this.RETRY_AFTER_MS),
          issuing_until: null
        });
        console.warn(
          `Open charge ${cobranca.id} (period ${cobranca.period_end}) could not be canceled at the gateway `
          + `while exempting provider ${cobranca.tenant_id}; it stays open: ${error.message}`
        );
        ficaram.push(cobranca.id);
      }
    }
    return { canceled: canceladas, failed: ficaram };
  }

  /**
   * Desligar a isenção devolve à emissão a cobrança do período que ELA
   * cancelou — a do prazo que continua no futuro.
   *
   * Sem isto, a linha do período atual ficaria `canceled` e a emissão do
   * agendador responderia `already_settled` a cada passada (só o clique
   * reabre cancelada): o provedor chegaria ao prazo sem fatura nenhuma e
   * venceria. Só a cancelada PELA ISENÇÃO (`EXEMPT_CANCEL_MARKER`): a que o
   * console cancelou a dedo continua cancelada, como sempre.
   *
   * Pela mesma porta da reemissão (`resetForReissue`, com a garra): o id
   * velho do gateway vai para `superseded_charges` e a linha volta `pending`,
   * sem id, para a próxima passada emitir. O valor mudado à mão pelo console
   * (0078) volta junto: o desconto foi dado ao período, e a isenção não o
   * desfaz.
   *
   * @returns {Promise<boolean>} se reabriu.
   */
  static async reopenExemptCanceled(periodEnd, { now = new Date(), marker = EXEMPT_CANCEL_MARKER } = {}) {
    const linha = await BillingCharge.forPeriod(periodEnd);
    if (!linha || linha.status !== 'canceled' || linha.last_error !== marker) return false;
    const minha = await BillingCharge.claim(linha.id, {
      until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, statuses: ['canceled']
    });
    if (!minha) return false;
    const reaberta = await BillingCharge.resetForReissue(linha.id, {
      amountCents: Number(linha.amount_cents),
      currency: linha.currency
    });
    if (!reaberta) {
      await BillingCharge.release(linha.id);
      return false;
    }
    if (linha.amount_overridden_at) {
      await BillingCharge.update(linha.id, { amount_overridden_at: linha.amount_overridden_at });
    }
    return true;
  }

  /**
   * A reserva de crédito (0106) de uma linha que esta passada reservou e
   * depois decidiu NÃO emitir (o status, o cancelamento agendado ou a pausa
   * que entraram no meio): volta ao saldo, e a linha volta a dizer o preço
   * sem crédito — a próxima emissão reserva de novo, pelo saldo de então.
   * Melhor esforço: falhar aqui só deixa a reserva para a próxima passada
   * (`reserveForCharge` solta a anterior antes de reservar).
   */
  static async soltarCreditoNaoEmitido(chargeId, reservado, precoSemCredito) {
    if (!(reservado > 0)) return;
    try {
      await TenantCredit.releaseForCharge(chargeId);
      await BillingCharge.update(chargeId, { amount_cents: precoSemCredito });
    } catch (error) {
      console.error(`Charge ${chargeId} was not issued but its reserved credit could not be released: ${error.message}`);
    }
  }

  /**
   * O mesmo de `reopenExemptCanceled`, para a cobrança que o fluxo de
   * cancelamento (0107) cancelou (`RETENTION_CANCEL_MARKER`): desfeito o
   * cancelamento agendado, a fatura do período volta à emissão.
   */
  static async reopenRetentionCanceled(periodEnd, { now = new Date() } = {}) {
    return this.reopenExemptCanceled(periodEnd, { now, marker: RETENTION_CANCEL_MARKER });
  }

  /**
   * Cancela as cobranças de RENOVAÇÃO em aberto do provedor em escopo — as do
   * período `periodEnd`, ou todas quando nulo — para a retenção no
   * cancelamento (0107): a pausa aceita e o cancelamento agendado não deixam
   * fatura viva na mão do provedor.
   *
   * Estrita, ao contrário da varredura da isenção: quem chama cancela ANTES
   * de gravar a decisão, e qualquer recusa LANÇA (`ChargeFollowError`) — 409
   * `busy` quando outra passada tem a linha, 502 `gateway_failed` quando o
   * gateway recusa (o motivo mais provável é a fatura já ter sido paga lá).
   * Aí nada é decidido: melhor "tente de novo" do que uma pausa com uma
   * fatura viva no e-mail. A pró-rata não entra: é a diferença de um período
   * que o provedor já usou.
   *
   * A cancelada leva `RETENTION_CANCEL_MARKER`, que é o que o desfazer procura
   * (`reopenRetentionCanceled`) e o que o "pagar agora" da pausa reabre (a
   * cancelada do período volta pelo clique, como qualquer cancelada).
   *
   * @returns {Promise<{ canceled: number[] }>} os ids das linhas canceladas.
   */
  static async cancelRenewalCharges({ periodEnd = null, now = new Date() } = {}) {
    const chave = periodEnd ? String(periodEnd).slice(0, 10) : null;
    const abertas = (await BillingCharge.openAll())
      .filter((linha) => !isProration(linha) && (!chave || String(linha.period_end).slice(0, 10) === chave));
    const canceladas = [];
    for (const cobranca of abertas) {
      // eslint-disable-next-line no-await-in-loop -- uma por provedor, quase sempre
      const minha = await BillingCharge.claim(cobranca.id, {
        until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
      });
      if (!minha) {
        throw new ChargeFollowError(409, 'busy', 'The open charge is being changed by another process; try again shortly');
      }
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      if (typeof provider?.cancelCharge === 'function') {
        try {
          // eslint-disable-next-line no-await-in-loop
          await provider.cancelCharge(cobranca.gateway_charge_id);
        } catch (error) {
          // eslint-disable-next-line no-await-in-loop
          await BillingCharge.release(cobranca.id);
          throw new ChargeFollowError(502, 'gateway_failed', `The payment gateway refused: ${error.message}`, error.message);
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await BillingCharge.update(cobranca.id, {
        status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: RETENTION_CANCEL_MARKER
      });
      canceladas.push(Number(cobranca.id));
    }
    return { canceled: canceladas };
  }

  /**
   * A cobrança em aberto acompanha o prazo que se moveu sem pagamento.
   *
   * Chamada por quem mexe no prazo à mão (`SubscriptionService.setDeadlines`
   * e `setStatus` com data), no escopo do provedor, ANTES de gravar o prazo
   * novo. A chave de uma cobrança é o prazo que ela compra; mudado o prazo, a
   * cobrança emitida para a chave velha ficaria órfã — a faxina a fecharia, a
   * emissão abriria outra para a chave nova, e o provedor teria duas faturas.
   * Aqui ela vira a cobrança do prazo novo:
   *
   *   - no gateway, o vencimento muda para o do prazo novo (`dueDateFor`, o
   *     mesmo cálculo da emissão — com a folga de quem já está vencido);
   *   - na linha, `period_end` passa a ser a chave nova, e o vencimento é o
   *     que o gateway aceitou. Uma `overdue` volta a `pending`: com o
   *     vencimento novo, não está mais atrasada.
   *
   * Se o prazo novo JÁ tem cobrança (voltou-se a um prazo que teve uma), duas
   * linhas não cabem numa chave: a velha é cancelada no gateway e aqui.
   *
   * A recusa do gateway LANÇA (`ChargeFollowError`, 502) e nada é gravado —
   * nem a linha nem, porque quem chama grava depois, o prazo. Mover o prazo
   * deixando a fatura velha viva é exatamente o dano que isto existe para
   * evitar. A linha tomada por outra passada lança 409 `busy`.
   *
   * Uma linha sem id no gateway só troca de chave: é a emissão que a leva lá,
   * pela porta de sempre, com o vencimento do prazo novo.
   *
   * @returns {Promise<{ moved: boolean, canceled?: boolean, reason?: string, chargeId?: number }>}
   */
  static async followDeadline({ from, to, now = new Date() }) {
    const de = from ? new Date(from) : null;
    const para = to ? new Date(to) : null;
    if (!de || !para || Number.isNaN(de.getTime()) || Number.isNaN(para.getTime())) {
      return { moved: false, reason: 'no_deadline' };
    }
    const chaveVelha = this.periodKey(de);
    const chaveNova = this.periodKey(para);
    if (chaveVelha === chaveNova) return { moved: false, reason: 'same_period' };
    const cobranca = await BillingCharge.forPeriod(chaveVelha);
    if (!cobranca || !OPEN_CHARGE_STATUSES.includes(cobranca.status)) {
      return { moved: false, reason: 'no_open_charge' };
    }

    const minha = await BillingCharge.claim(cobranca.id, {
      until: new Date(now.getTime() + this.CLAIM_MS), now, unissued: false, openOnly: true
    });
    if (!minha) {
      throw new ChargeFollowError(409, 'busy', 'The open charge is being changed by another process; try again shortly');
    }
    const noGateway = async (fn) => {
      try {
        return await fn();
      } catch (error) {
        throw new ChargeFollowError(502, 'gateway_failed', `The payment gateway refused: ${error.message}`, error.message);
      }
    };
    try {
      const provider = cobranca.gateway_charge_id ? providerFor(cobranca.provider) : null;
      const vencimento = this.dueDateFor(para, now);
      if (await BillingCharge.forPeriod(chaveNova)) {
        if (typeof provider?.cancelCharge === 'function') {
          await noGateway(() => provider.cancelCharge(cobranca.gateway_charge_id));
        }
        await BillingCharge.update(cobranca.id, { status: 'canceled', issuing_until: null });
        return { moved: false, canceled: true, chargeId: cobranca.id };
      }
      let respondido = null;
      if (typeof provider?.updateCharge === 'function') {
        respondido = await noGateway(() => provider.updateCharge(cobranca.gateway_charge_id, {
          dueDate: vencimento,
          // O valor de agora, para o desconto por antecipação ir junto com o piso.
          amountCents: Number(cobranca.amount_cents),
          // O meio com que ela nasceu (0100): a de cartão continua de cartão.
          ...(cobranca.billing_type ? { billingType: cobranca.billing_type } : {})
        }));
      }
      await BillingCharge.update(cobranca.id, {
        period_end: chaveNova,
        due_date: respondido?.dueDate || vencimento,
        // Os termos do desconto que foram junto (0100): a conferência os lê.
        ...(respondido?.discountTerms ? { discount_terms: BillingCharge.serializeDiscountTerms(respondido.discountTerms) } : {}),
        ...(cobranca.status === 'overdue' ? { status: 'pending' } : {}),
        issuing_until: null
      });
      return { moved: true, chargeId: cobranca.id };
    } finally {
      await BillingCharge.release(cobranca.id);
    }
  }

  /**
   * O excedente que a cobrança da renovação `periodo` soma (0105).
   *
   * ## Que período, e em que fatura
   *
   * A cobrança com a chave `P` (o `renews_at` de agora) paga o período que
   * COMEÇA em `P` — ela sai `LEAD_DAYS` antes, ainda dentro do período que
   * termina em `P`. O excedente cobrado nela é o do período que ela FECHA:
   * o uso de `[renovação anterior, P)`, cujos picos o agendador grava com a
   * mesma chave `P` (`SubscriptionService.recordUsagePeaks`). Ou seja: o
   * período pago de antemão, e o excedente dele cobrado depois, na renovação
   * seguinte — como uma conta de consumo.
   *
   * ## Congelado na linha
   *
   * Calculado UMA vez, quando a linha do período nasce (ou na primeira emissão
   * de uma linha que ainda não o tinha), e gravado em `pricing_detail`. Toda
   * reemissão do mesmo período — a troca de plano, o cupom, o "Reemitir", a
   * cancelada reaberta — reaproveita as parcelas gravadas: o mesmo período dá
   * sempre o mesmo valor, e nada é cobrado duas vezes. O pico que ainda subir
   * entre a emissão e `P` (os últimos dias do período) não entra: a fatura
   * diz o que mediu até sair, e o provedor já a tem na mão.
   *
   * Sem período pago (o teste, que vira a primeira fatura) não há excedente:
   * o teste é de graça, com ou sem uso acima do teto. O plano é o ATUAL, o
   * que valeu no período que fecha — e não o da descida agendada, que só
   * passa a valer no período que esta cobrança paga.
   */
  static async overageForPeriod({ subscription, plan, periodo, existente = null }) {
    const congelado = BillingCharge.frozenOverageOf(existente);
    if (congelado) return congelado;
    if (!periodo || SubscriptionService.overagePeriodKey(subscription) !== periodo) return [];
    return this.overageClosing({ subscription, plan, periodo });
  }

  /**
   * O excedente que FECHA o período `periodo` (a chave de `renews_at`):
   *
   *   - no anual (0104), as fatias mensais anteriores que nenhuma fatura de
   *     só excedente cobriu (as que ficaram abaixo do mínimo do gateway, ou
   *     que o agendador não alcançou) — além da última, que é a deste prazo;
   *   - o do próprio período, pelas fotografias do plano (`overageFromRows`);
   *   - o ACERTO (`true_up`) do período anterior: a fatura dele congelou o
   *     excedente alguns dias antes do fim, e o pico que subiu depois entra
   *     aqui, uma vez só (`trueUpFor`).
   */
  static async overageClosing({ subscription, plan, periodo, exceptChargeId = null }) {
    const itens = [];
    const fatias = SubscriptionService.overageSlices(subscription, plan).filter((f) => !f.last);
    if (fatias.length) {
      const cobertas = await this.coveredOverageKeys({ exceptChargeId });
      for (const fatia of fatias) {
        if (cobertas.has(fatia.key)) continue;
        // eslint-disable-next-line no-await-in-loop -- até onze fatias, uma leitura cada
        itens.push(...SubscriptionService.overageFromRows(plan, await UsagePeak.rowsForPeriod(fatia.key), fatia.key));
      }
    }
    itens.push(...SubscriptionService.overageFromRows(plan, await UsagePeak.rowsForPeriod(periodo), periodo));
    itens.push(...await this.trueUpFor({ plan, periodo, exceptChargeId }));
    return itens;
  }

  /**
   * As chaves de período cujo excedente uma fatura JÁ cobrou — a de só
   * excedente (as fatias que ela diz, `slices`) e a da renovação (as
   * parcelas congeladas dela, menos os acertos). Toda fatura conta, inclusive
   * a cancelada à mão: cobrar de novo um período é decisão de gente.
   */
  static async coveredOverageKeys({ exceptChargeId = null } = {}) {
    const chaves = new Set();
    const linhas = await getDbCharges();
    for (const linha of linhas) {
      if (exceptChargeId && Number(linha.id) === Number(exceptChargeId)) continue;
      const detalhe = BillingCharge.prorationDetailOf(linha);
      if (isOverageCharge(linha) && Array.isArray(detalhe?.slices)) {
        for (const chave of detalhe.slices) chaves.add(String(chave).slice(0, 10));
      }
      for (const item of BillingCharge.frozenOverageOf(linha) ?? []) {
        if (item.kind !== 'true_up' && item.periodKey) chaves.add(item.periodKey);
      }
    }
    return chaves;
  }

  /**
   * O acerto do período ANTERIOR a `periodo` (0105): a fatura da renovação
   * dele congelou o excedente ao sair, `LEAD_DAYS` antes do fim — o pico que
   * subiu nesses dias não entrou. Aqui, por recurso, `max(0, o que o período
   * deve agora − o que a fatura dele congelou)`, numa parcela `true_up` com a
   * chave dele. Uma vez só: a parcela fica congelada nesta fatura, e um
   * período que já teve acerto em outra não tem outro.
   *
   * Só contra uma fatura que de fato CONGELOU a conta (`pricing_detail` com
   * `overage`) e que não foi cancelada nem estornada — a linha de antes da
   * coluna não diz o que cobrou, e cobrar de novo o período inteiro seria
   * cobrá-lo duas vezes.
   */
  static async trueUpFor({ plan, periodo, exceptChargeId = null }) {
    const anterior = await BillingCharge.previousRenewal(periodo);
    if (!anterior || ['canceled', 'refunded'].includes(anterior.status)) return [];
    const congelado = BillingCharge.frozenOverageOf(anterior);
    if (!congelado) return [];
    const chave = String(anterior.period_end).slice(0, 10);
    // Já acertado em outra fatura?
    for (const linha of await getDbCharges()) {
      if (exceptChargeId && Number(linha.id) === Number(exceptChargeId)) continue;
      if ((BillingCharge.frozenOverageOf(linha) ?? []).some((item) => item.kind === 'true_up' && item.periodKey === chave)) {
        return [];
      }
    }
    const devido = SubscriptionService.overageFromRows(plan, await UsagePeak.rowsForPeriod(chave), chave);
    const acertos = [];
    for (const item of devido) {
      const doPeriodo = congelado.filter((c) => c.resource === item.resource && c.kind !== 'true_up'
        && (c.periodKey ?? chave) === chave);
      const cobrado = doPeriodo.reduce((soma, c) => soma + c.cents, 0);
      const unidades = doPeriodo.reduce((soma, c) => soma + c.units, 0);
      const falta = item.cents - cobrado;
      if (!(falta > 0)) continue;
      acertos.push({
        ...item,
        units: Math.max(0, item.units - unidades),
        cents: falta,
        periodKey: chave,
        kind: 'true_up'
      });
    }
    return acertos;
  }

  /**
   * A fatura de só excedente das fatias mensais do ANUAL (0105 + 0104), a
   * passada do agendador por provedor: as fatias que já terminaram (menos a
   * última, que a renovação fecha) e que nenhuma fatura cobriu viram UMA
   * fatura avulsa (`kind: 'overage'`), pelo preço por unidade da fotografia
   * de cada fatia. Não compra período, não gasta cupom, não usa crédito: é a
   * conta de consumo do mês, paga como a pró-rata.
   *
   * Abaixo do mínimo do gateway (`PRORATION_MIN_CENTS`) não sai: as fatias
   * esperam a seguinte — ou a fatura da renovação, que soma as que sobraram.
   *
   * @returns {Promise<{ issued: boolean, reason?: string, charge?: object }>}
   */
  static async issueOverageSlices({ tenant: doLaco = null, now = new Date() } = {}) {
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    if (!tenant || tenant.kind === 'platform') return { issued: false, reason: 'platform_tenant' };
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription) return { issued: false, reason: 'no_subscription' };
    if (subscription.billing_exempt_at) return { issued: false, reason: 'billing_exempt' };
    if (!isBillableStatus(subscription)) return { issued: false, reason: 'not_billable' };
    if (isCancelScheduled(subscription) || isPauseScheduled(subscription)) return { issued: false, reason: 'retention_hold' };
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
    const fatias = SubscriptionService.overageSlices(subscription, plan)
      .filter((f) => !f.last && f.end.getTime() <= now.getTime());
    if (!fatias.length) return { issued: false, reason: 'no_slice' };
    const cobertas = await this.coveredOverageKeys();
    const pendentes = fatias.filter((f) => !cobertas.has(f.key));
    if (!pendentes.length) return { issued: false, reason: 'covered' };
    const itens = [];
    for (const fatia of pendentes) {
      // eslint-disable-next-line no-await-in-loop -- poucas fatias, uma leitura cada
      itens.push(...SubscriptionService.overageFromRows(plan, await UsagePeak.rowsForPeriod(fatia.key), fatia.key));
    }
    const total = itens.reduce((soma, item) => soma + item.cents, 0);
    if (!(total > 0)) return { issued: false, reason: 'no_overage' };
    if (total < SubscriptionService.PRORATION_MIN_CENTS) return { issued: false, reason: 'below_minimum', amountCents: total };
    return this.openOverageCharge({
      tenant, subscription, plan, itens, slices: pendentes.map((f) => f.key), final: false, now
    });
  }

  /**
   * A fatura FINAL de só excedente de quem cancela (0105 + 0107): o
   * cancelamento agendado que chegou, ou o feito na hora. A renovação não sai
   * para quem cancela, então o excedente do período que fecha (e as fatias do
   * anual que sobraram, e o acerto do anterior) iria embora sem ela.
   * `subscription` é a linha de ANTES do cancelamento (o prazo, o plano).
   * Melhor esforço: nunca lança.
   */
  static async issueFinalOverage({ subscription, now = new Date() }) {
    try {
      const tenant = await Tenant.findById(currentTenantId());
      if (!tenant || tenant.kind === 'platform' || !subscription || subscription.billing_exempt_at) {
        return { issued: false, reason: 'not_billable' };
      }
      const periodo = SubscriptionService.overagePeriodKey(subscription);
      if (!periodo) return { issued: false, reason: 'no_period' };
      const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
      // O período que a fatura da renovação pagou e congelou não se cobra de
      // novo: só quando ela não foi paga (o cancelamento a cancelou).
      const daRenovacao = await BillingCharge.forPeriod(periodo);
      if (daRenovacao && daRenovacao.status === 'paid') return { issued: false, reason: 'settled' };
      const itens = await this.overageClosing({ subscription, plan, periodo, exceptChargeId: daRenovacao?.id ?? null });
      const total = itens.reduce((soma, item) => soma + item.cents, 0);
      if (!(total > 0)) return { issued: false, reason: 'no_overage' };
      if (total < SubscriptionService.PRORATION_MIN_CENTS) {
        console.warn(`Final overage of provider ${tenant.id} (${total} cents) is below the gateway minimum; not charged`);
        return { issued: false, reason: 'below_minimum', amountCents: total };
      }
      const slices = [...new Set(itens.filter((i) => i.kind !== 'true_up').map((i) => i.periodKey).filter(Boolean))];
      return await this.openOverageCharge({ tenant, subscription, plan, itens, slices, final: true, now, periodo });
    } catch (error) {
      console.warn(`Could not issue the final overage charge of provider ${currentTenantId()}: ${error.message}`);
      return { issued: false, reason: 'error', error: error.message };
    }
  }

  /** Abre e emite uma fatura de só excedente — ver `issueOverageSlices` e `issueFinalOverage`. */
  static async openOverageCharge({
    tenant, subscription, plan, itens, slices, final, now, periodo = null
  }) {
    const provider = providerFor(tenant.billing_gateway);
    if (!provider || !tenant.billing_customer_ref) return { issued: false, reason: 'not_linked' };
    if (!provider.canIssue) return { issued: false, reason: 'provider_cannot_issue' };
    const ultima = periodo ?? slices[slices.length - 1];
    const key = BillingCharge.overageKey(ultima, { final });
    const total = itens.reduce((soma, item) => soma + item.cents, 0);
    let chargeId;
    try {
      chargeId = await BillingCharge.openProration({
        key,
        kind: 'overage',
        subscriptionId: subscription?.id ?? null,
        amountCents: total,
        currency: String(plan?.currency || 'BRL').toUpperCase(),
        provider: provider.name,
        dueDate: this.isoDate(now.getTime() + this.PRORATION_DUE_DAYS * 86_400_000),
        claimUntil: new Date(now.getTime() + this.CLAIM_MS),
        planId: plan?.id ?? null,
        billingCycle: plan ? SubscriptionService.cycleOf(subscription, plan) : null,
        pricingDetail: { base: 0, overage: itens },
        detail: { slices, periodEnd: ultima, ...(final ? { final: true } : {}), at: now.toISOString() }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { issued: false, reason: 'duplicate' };
      throw error;
    }
    return this.emitProration({ tenant, provider, chargeId, now });
  }

  /**
   * Emite a cobrança do provedor em escopo, se houver uma a emitir.
   *
   * Devolve `{ issued, reason }` e nunca lança: como o aviso, é um job, e
   * `{ issued: false, reason }` é o caso normal — a esmagadora maioria das
   * passadas não tem nada a fazer. Quando há uma linha do período no fim da
   * conversa — emitida agora ou já emitida antes —, ela vem em `charge`, que é
   * o que o "pagar agora" devolve à tela.
   *
   * ## `manual: true` — alguém clicou "pagar agora"
   *
   * O agendador pergunta "já é hora?"; o provedor que clica está dizendo que é.
   * Três guardas existem por causa da máquina, e com uma pessoa do outro lado
   * cedem:
   *
   *   - a antecedência (`not_due_yet`): quem quer pagar hoje a fatura que vence
   *     daqui a vinte dias não precisa esperar a janela de cinco;
   *   - o teto de tentativas (`gave_up`) e a espera entre elas (`backing_off`):
   *     os dois existem para o agendador não martelar o gateway a cada minuto,
   *     e um clique não é um laço. As tentativas voltam a zero — a pessoa está
   *     olhando, e o que der errado ela lê na hora;
   *   - a cobrança do período que foi CANCELADA (a troca para um plano de graça
   *     e de volta, o console) volta a ser emitida, com o preço de agora: quem
   *     pede para pagar um período que tem cobrança cancelada está pedindo a
   *     cobrança, e "já está resolvido" seria mentira.
   *
   * E a assinatura sem prazo nenhum (`renews_at` e `trial_ends_at` nulos — a
   * que o console pôs num plano sem nunca registrar pagamento) ganha um: o da
   * cobrança em aberto, se houver, senão hoje. Para o agendador ela não tem o
   * que cobrar; para quem clicou, tem, e o pagamento é o que a põe num ciclo.
   * A cobrança em aberto vem antes de "hoje" para que o clique de amanhã ache
   * a de hoje em vez de abrir outra com a chave de amanhã.
   *
   * O que NÃO cede: plataforma, provedor sem gateway que emita, gateway sem
   * chave, assinatura parada por gente, plano de graça, e a cobrança já
   * emitida (`already_issued`, agora COM a linha) — pagar agora a que já está
   * na mão do provedor é pagar ESSA, e não emitir outra.
   */
  static async issueCurrent({
    now = new Date(), tenant: doLaco = null, manual = false, countDevices = null, pendingBlockedBy = undefined,
    cardNow = false
  } = {}) {
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    if (!tenant) return { issued: false, reason: 'tenant_gone' };

    // A plataforma não se cobra. A linha dela em `tenants` existe para ser dona
    // do que o schema exige que tenha dono — a caixa de WhatsApp com que ela
    // atende os provedores —, e não para ser cliente.
    //
    // Explícito e não por acidente: as guardas abaixo já a poupariam hoje (não
    // está ligada a gateway nenhum e está no plano de graça), mas as duas são
    // configuração, e configuração muda. Uma correlação com o gateway colada na
    // linha errada pelo console faria o painel emitir cobrança contra nós
    // mesmos, e o `kind` é o único fato aqui que não depende de ninguém lembrar.
    if (tenant.kind === 'platform') return { issued: false, reason: 'platform_tenant' };

    // Sem gateway ligado não há a quem pedir. É também o que faz este job ser
    // inócuo num install self-hosted, sem precisar perguntar pela edição: lá
    // ninguém liga provedor a gateway nenhum.
    const provider = providerFor(tenant.billing_gateway);
    if (!provider || !tenant.billing_customer_ref) return { issued: false, reason: 'not_linked' };
    // Um provedor ligado a um gateway que não emite — `manual` — é cobrado à
    // mão de propósito, e não é caso de erro.
    if (!provider.canIssue) return { issued: false, reason: 'provider_cannot_issue' };
    // Sem a chave da API não há emissão possível, e é preciso descobrir isso
    // ANTES de gravar a linha: sem esta parada, um deploy que esqueceu a
    // variável queimaria as cinco tentativas de toda cobrança e chegaria em
    // `gave_up` — uma variável esquecida destruindo a cobrança em vez de
    // simplesmente adiá-la até alguém configurá-la.
    if (typeof provider.isConfigured === 'function' && !(await provider.isConfigured())) {
      return { issued: false, reason: 'gateway_not_configured' };
    }

    // Sem o cache, e pela mesma razão que `recordPayment` não o usa: ele vale
    // quinze segundos, e uma leitura de quinze segundos atrás não pode decidir
    // POR QUANTO se cobra alguém. Um plano que mudou de preço agora cobraria o
    // preço velho, e o cliente receberia uma cobrança que ninguém sabe explicar.
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription) return { issued: false, reason: 'no_subscription' };
    // Isento de cobrança (ver `SubscriptionService.setBillingExempt`): o
    // console decidiu que este provedor fica ativo sem fatura, até desligar.
    // Antes de tudo que cobra — a faxina, a reprecificação, a reemissão — e
    // valendo também para o clique (`manual`): o "pagar agora", o "Reemitir"
    // e o "Gerar cobrança" do console passam por aqui e param aqui.
    //
    // A passada do agendador (não o clique) varre também o que ficou em aberto
    // — a cobrança que o gateway recusou cancelar ao ligar, ou a que uma
    // emissão em curso gravou enquanto a isenção era ligada —, respeitando a
    // espera de cada uma. Assim nenhuma fatura viva sobra na mão de um isento.
    if (subscription.billing_exempt_at) {
      let varridas = 0;
      if (!manual) {
        try {
          varridas = (await this.cancelOpenCharges({ now, honorBackoff: true })).canceled;
        } catch (error) {
          console.warn(`Could not sweep the open charges of exempt provider ${tenant.id}: ${error.message}`);
        }
      }
      return { issued: false, reason: 'billing_exempt', ...(varridas ? { canceledCharges: varridas } : {}) };
    }
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;

    // `suspended` e `canceled` são decisões de gente. Emitir cobrança a quem
    // alguém desligou a dedo é o painel contrariando quem o opera. A exceção
    // é a suspensão AUTOMÁTICA por inadimplência (0102): é pagando que se sai
    // dela, então a fatura continua saindo (`isBillableStatus`).
    if (!isBillableStatus(subscription)) {
      return { issued: false, reason: 'not_billable' };
    }
    // A retenção no cancelamento (0107). O cancelamento agendado não renova:
    // nenhuma fatura nova, nem pelo clique — quem quer continuar desfaz o
    // agendamento. A pausa também não gera fatura; o clique é a exceção, e é
    // o "retomar antes": a fatura do período que a pausa segurava (a que ela
    // cancelou volta, como toda cancelada pelo clique) e, paga, a pausa acaba
    // (`SubscriptionService.recordPayment`).
    if (isCancelScheduled(subscription)) return { issued: false, reason: 'cancel_scheduled' };
    if (!manual && isPauseScheduled(subscription)) return { issued: false, reason: 'paused' };

    // O preço com o cupom da assinatura, quando há um que vale neste plano
    // (0093, `effectivePriceCents`) — lido uma vez e reaproveitado para o
    // plano da descida agendada logo abaixo.
    const cupom = subscription.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    let preco = await SubscriptionService.effectivePriceCents(subscription, plan, { coupon: cupom });
    // Plano de graça não gera cobrança de R$ 0,00 — o gateway a recusaria, e
    // com razão. É o caso do `unlimited`, que todo provedor herdado tem. O
    // cupom nunca leva um plano pago a zero (o piso de `COUPON_FLOOR_CENTS`).
    if (!(preco > 0)) return { issued: false, reason: 'free_plan' };

    // O prazo vivo: o do período pago, ou o do teste para quem ainda não pagou
    // nenhuma vez — e é justamente o fim do teste que precisa de cobrança, ou o
    // primeiro pagamento nunca acontece.
    let prazo = subscription.renews_at ?? subscription.trial_ends_at;
    // A chave do período, quando ela vem pronta de uma linha e não de um
    // instante: `period_end` já é a data no fuso da cobrança, e passá-la por
    // `new Date` e `periodKey` de novo a leria como meia-noite UTC — o dia
    // ANTERIOR em São Paulo, e uma segunda cobrança com a chave errada.
    let periodoPronto = null;
    if (!prazo && manual) {
      const aberta = await BillingCharge.currentOpen();
      if (aberta) {
        periodoPronto = String(aberta.period_end).slice(0, 10);
        prazo = new Date(`${periodoPronto}T12:00:00-03:00`);
      } else {
        prazo = now;
      }
    }
    if (!prazo) return { issued: false, reason: 'no_deadline' };
    const vencimento = new Date(prazo);
    if (Number.isNaN(vencimento.getTime())) return { issued: false, reason: 'no_deadline' };

    const periodo = periodoPronto ?? this.periodKey(vencimento);

    // A faxina vem ANTES da guarda de "ainda não venceu", e essa ordem foi o
    // teste que a encontrou: um provedor que acabou de pagar está, por
    // definição, longe do próximo vencimento — então pôr a limpeza depois da
    // guarda significa que ela nunca roda para quem mais precisa dela.
    //
    // O que se limpa é a cobrança de um período que passou sem ser paga por
    // aqui: o provedor acertou por fora — o botão do console, uma transferência
    // marcada à mão — e `renews_at` andou sem quitar cobrança nenhuma. A linha
    // antiga ficaria `pending` para sempre, e "o que está em aberto" passaria a
    // responder errado a cada ciclo.
    await this.cancelStale(periodo, { now });

    // A antecedência depende do meio. Pix/boleto sai `LEAD_DAYS` antes, para
    // o dinheiro ter tempo de chegar. No cartão salvo (0100) a Asaas cobra o
    // cartão NA CRIAÇÃO da cobrança — emitir cinco dias antes seria cobrar o
    // cartão cinco dias antes do vencimento. Então a do cartão sai no dia do
    // vencimento (no fuso da cobrança, desde a meia-noite: o pagamento chega
    // antes de o prazo virar `past_due`). O clique (`manual`) não espera.
    if (!manual) {
      const aindaNao = this.chargesSavedCard(provider, subscription)
        ? periodo > this.isoDate(now)
        : vencimento.getTime() > now.getTime() + this.LEAD_DAYS * 86_400_000;
      if (aindaNao) return { issued: false, reason: 'not_due_yet' };
    }

    // O plano que ESTE prazo cobra. Quase sempre o atual; a exceção é a
    // descida agendada (0074) para exatamente este prazo: a cobrança que sai
    // cinco dias antes da renovação paga o período que começa nela, e esse
    // período já é do plano novo. Cobrar o preço velho ali seria o provedor
    // pagando o plano caro por um mês em que vai estar no barato.
    //
    // A comparação é pela chave do período, no fuso da cobrança, e não pelo
    // instante: é a chave que identifica a cobrança, e dois instantes do mesmo
    // dia em São Paulo são o mesmo prazo. O plano agendado é sempre pago (a
    // descida só aceita plano pago), então a guarda do de graça lá em cima,
    // feita com o atual, continua valendo.
    //
    // MAS só se o uso couber no plano agendado — a mesma conta que a aplicação
    // faz (`SubscriptionService.overLimitOf`), contando só o que ele limita, e
    // com a contagem de ONTs que falta valendo como "cabe", como em todo lugar.
    // Sem esta guarda o buraco fechado pela descida agendada reabria por baixo:
    // quem pede a descida e não se ajusta continua no plano caro (a aplicação
    // recusa), mas a cobrança sairia pelo preço do barato — e o pagamento dela
    // conferiria. Não caber é continuar no plano atual, e pagar por ele.
    //
    // Depois da guarda de antecedência, e não antes: o agendador passa a cada
    // minuto, e contar uso (às vezes no ACS) semanas antes da janela de
    // emissão seria carga sem resposta a dar.
    let planoDoPeriodo = plan;
    // A assinatura no ciclo do período que esta cobrança paga (0104).
    let assinaturaDoPeriodo = subscription;
    let descidaBloqueada = null;
    if (subscription.pending_plan_id && subscription.pending_plan_at) {
      const agendada = new Date(subscription.pending_plan_at);
      if (!Number.isNaN(agendada.getTime()) && this.periodKey(agendada) === periodo) {
        const agendado = await Plan.findById(subscription.pending_plan_id);
        // No ciclo AGENDADO (0104): a troca do mensal para o anual faz a
        // fatura desta renovação sair pelo preço do ano.
        const agendadaView = SubscriptionService.scheduledView(subscription);
        if (agendado && SubscriptionService.cyclePriceCents(agendadaView, agendado) > 0) {
          // Três fontes para o veredito, nesta ordem. A descida travada (paga
          // pelo preço dela, 0075) não tem veredito: vale o preço dela. Quem
          // reemite logo depois de decidir — a troca de plano, a reprecificação
          // abaixo — passa o veredito que JÁ usou (`pendingBlockedBy`), para a
          // reemissão não recontar: uma contagem de ONTs que oscila entre as
          // duas leituras cancelaria e reemitiria a fatura sem fim. Sem nada
          // disso, conta-se agora.
          if (SubscriptionService.isPendingLocked(subscription)) {
            descidaBloqueada = null;
          } else if (pendingBlockedBy !== undefined) {
            descidaBloqueada = pendingBlockedBy;
          } else {
            descidaBloqueada = await SubscriptionService.scheduledOverLimit(subscription, agendado, { countDevices });
          }
          if (!descidaBloqueada) {
            planoDoPeriodo = agendado;
            assinaturaDoPeriodo = agendadaView;
            // O cupom vale no plano novo só se ele está na lista do cupom: o
            // período que esta cobrança paga já é do plano agendado.
            preco = await SubscriptionService.effectivePriceCents(agendadaView, agendado, { coupon: cupom });
          }
        }
      }
    }

    const moeda = planoDoPeriodo.currency || 'BRL';
    // Com que plano e cupom este preço saiu (0093), gravados na linha — ver
    // `SubscriptionService.chargePricing`.
    const precificacao = SubscriptionService.chargePricing(assinaturaDoPeriodo, planoDoPeriodo, cupom);
    const garraAte = new Date(now.getTime() + this.CLAIM_MS);
    // O cartão recorrente (0100): com o cartão salvo e utilizável, a cobrança
    // sai no cartão e o gateway a cobra sozinho; senão, a página de
    // Pix-ou-boleto de sempre. Decidido pela assinatura lida agora, sem cache.
    let cartao = provider.canChargeSavedCard ? CardAutopayService.chargeOptions(subscription) : null;
    let meio = cartao ? 'CREDIT_CARD' : 'UNDEFINED';
    const referencia = `tenant:${tenant.id}:${periodo}`;
    // A reemissão por clique que NÃO é "pagar agora" (a troca de plano, o
    // cupom, o "Reemitir" do console) numa assinatura com cartão salvo: a
    // Asaas cobra o cartão na criação, e criar agora seria cobrar o cartão
    // antes do vencimento sem que o provedor tenha pedido. A linha fica sem
    // id no gateway, e a passada do agendador a emite no dia do vencimento.
    // Só o "pagar agora" (`cardNow`) é o provedor pedindo para pagar já.
    const adiarCartao = Boolean(manual && cartao && !cardNow && periodo > this.isoDate(now));
    let existente = await BillingCharge.forPeriod(periodo);
    // O excedente do período que esta renovação fecha (0105), somado ao preço
    // do plano DEPOIS do cupom — o cupom vale só sobre o plano. Congelado na
    // linha: ver `overageForPeriod`. `conta` é o que vai a `pricing_detail`,
    // com as outras chaves que a linha já tiver (o crédito) preservadas.
    const excedente = await this.overageForPeriod({ subscription, plan, periodo, existente });
    const precoDoPlano = preco;
    preco += excedente.reduce((soma, item) => soma + item.cents, 0);
    const conta = BillingCharge.mergePricingDetail(existente, { base: precoDoPlano, overage: excedente });
    if (!existente && adiarCartao) return { issued: false, reason: 'card_deferred', charge: null };
    if (existente) {
      // Reaberta pelo clique, com o preço de agora — ver o comentário do método.
      // Só a cancelada: paga e devolvida continuam fechadas para todo mundo.
      // Com a garra, como toda escrita que reemite: a troca de plano pode estar
      // mexendo nesta mesma linha agora.
      if (manual && existente.status === 'canceled') {
        const minha = await BillingCharge.claim(existente.id, { until: garraAte, now, unissued: false });
        if (!minha) return { issued: false, reason: 'raced', charge: existente };
        const reaberta = await BillingCharge.resetForReissue(existente.id, {
          amountCents: preco, currency: moeda, ...precificacao, pricingDetail: conta
        });
        if (!reaberta) await BillingCharge.release(existente.id);
        existente = await BillingCharge.findById(existente.id);
      }
      // `refunded` também: o período teve cobrança, ela foi paga e devolvida, e
      // emitir outra por cima é decisão de gente, não do agendador.
      if (existente.status === 'paid' || existente.status === 'canceled' || existente.status === 'refunded') {
        return { issued: false, reason: 'already_settled', charge: existente };
      }
      // A cobrança da renovação que saiu pelo preço da descida quando o uso
      // ainda cabia, e agora não cabe mais: a descida não vai se aplicar, o
      // período seguinte é do plano atual, e a fatura na mão do provedor pede
      // o preço do outro. Volta ao preço do atual pela mesma porta da troca de
      // plano — cancelada no gateway e reemitida —, e só enquanto está em
      // aberto: a paga é dinheiro que entrou e fica como está.
      //
      // Só nessa direção. A contrária (bloqueada quando saiu, cabe agora)
      // fica com o preço cheio até a renovação: um uso oscilando em volta do
      // teto viraria uma fatura nova por oscilação na caixa de quem paga.
      // Nunca a de valor mudado à mão pelo console (0078): o desconto dado a
      // ela é decisão de gente, e reprecificá-la pelo plano o desfaria.
      // Pelo preço ANTES do crédito reservado (0106): o valor que foi ao
      // gateway é menor que o do plano de propósito, e não é reprecificação.
      if (existente.gateway_charge_id && descidaBloqueada && !existente.amount_overridden_at
        && BillingCharge.baseAmountOf(existente) !== preco) {
        return this.repriceBlockedDowngrade({
          subscription, plan, tenant, charge: existente, blockedBy: descidaBloqueada, now
        });
      }
      if (existente.gateway_charge_id) return { issued: false, reason: 'already_issued', charge: existente };
      if (adiarCartao) return this.deferCardCharge(existente);
      if (!manual) {
        if (Number(existente.attempts ?? 0) >= this.MAX_ATTEMPTS) {
          return { issued: false, reason: 'gave_up', charge: existente };
        }
        const espera = existente.next_attempt_at ? new Date(existente.next_attempt_at) : null;
        if (espera && !Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
          return { issued: false, reason: 'backing_off', charge: existente };
        }
      }

      // A garra, e só depois dela qualquer escrita e a chamada ao gateway.
      //
      // Até aqui tudo foi LEITURA, e duas passadas — o agendador e um clique,
      // dois cliques, a reemissão da troca de plano — podem ter lido a mesma
      // linha sem `gateway_charge_id` no mesmo instante. Sem a garra, as duas
      // criariam uma cobrança de verdade cada uma. Quem perde relê a linha: se
      // o outro já emitiu, é `already_issued` com ela; se ainda está emitindo,
      // é `raced`, também com ela — e quem clicou recebe a cobrança do outro
      // assim que ela sair (ver `SelfBillingService.payNow`).
      const minha = await BillingCharge.claim(existente.id, { until: garraAte, now });
      if (!minha) {
        const agora = await BillingCharge.findById(existente.id);
        if (agora?.gateway_charge_id) return { issued: false, reason: 'already_issued', charge: agora };
        return { issued: false, reason: 'raced', charge: agora };
      }

      // A tentativa de CARTÃO anterior que terminou sem resposta (0100): a
      // cobrança pode existir no gateway — e no cartão ela é dinheiro saindo
      // sozinho, não uma fatura a mais. Antes de qualquer outra, pergunta-se
      // ao gateway pela nossa referência: achada, ela vira a cobrança desta
      // linha; sem resposta, nada é criado e a linha espera.
      //
      // Sem olhar `attempts`: o processo que morreu DEPOIS de o gateway criar
      // a cobrança e ANTES de `markIssued` deixa a linha com `CREDIT_CARD`,
      // sem id e com zero tentativas (a garra vence sozinha). Toda linha de
      // cartão sem id no gateway é uma tentativa que começou e não terminou.
      if (existente.billing_type === 'CREDIT_CARD' && typeof provider.findChargesByReference === 'function') {
        let achadas;
        try {
          achadas = await provider.findChargesByReference(referencia);
        } catch (error) {
          await BillingCharge.markFailed(existente.id, `card charge lookup failed: ${error.message}`, {
            retryAfterMs: this.RETRY_AFTER_MS
          });
          return { issued: false, reason: 'gateway_failed', error: error.message };
        }
        const viva = achadas.find((item) => item.billingType === 'CREDIT_CARD') ?? achadas[0] ?? null;
        if (viva) {
          const adotada = await this.adoptFound({ linha: existente, viva, provider, now });
          return { issued: false, reason: 'already_issued', adopted: true, ...adotada };
        }
      }

      const patch = {};
      // O clique não herda a paciência do agendador: zera o que foi contado
      // por ele, e a tentativa desta pessoa é a primeira.
      if (manual && (Number(existente.attempts ?? 0) > 0 || existente.next_attempt_at)) {
        patch.attempts = 0;
        patch.next_attempt_at = null;
      }
      // A linha que vai ser emitida de novo diz o preço de AGORA, que é o que
      // vai ao gateway logo abaixo. Uma linha aberta com um preço e emitida com
      // outro faria a conferência do pagamento (`valorPedido`, que lê a linha)
      // chamar de "pago a menos" quem pagou exatamente o que viu.
      // O valor mudado à mão pelo console (0078) fica — e é ele que vai ao
      // gateway logo abaixo, e não o preço do plano.
      if (existente.amount_overridden_at) {
        preco = Number(existente.amount_cents);
      } else if (BillingCharge.baseAmountOf(existente) !== preco || String(existente.currency || '').toUpperCase() !== moeda.toUpperCase()) {
        patch.amount_cents = preco;
        patch.currency = String(moeda).toUpperCase().slice(0, 3);
      }
      // O plano e o cupom do preço que vai ao gateway — também quando o valor
      // não mudou (dois planos no mesmo preço, o cupom no piso). Na de valor
      // mudado à mão fica o que a linha diz: o valor não é o de plano nenhum.
      if (!existente.amount_overridden_at) {
        if (Number(existente.plan_id ?? 0) !== Number(precificacao.planId ?? 0)) patch.plan_id = precificacao.planId;
        if (Number(existente.coupon_id ?? 0) !== Number(precificacao.couponId ?? 0)) patch.coupon_id = precificacao.couponId;
        // A conta do valor que vai ao gateway (0105) — o excedente congelado
        // na primeira vez, o preço do plano de agora.
        const contaGravada = BillingCharge.serializePricingDetail(conta);
        if ((existente.pricing_detail ?? null) !== contaGravada) patch.pricing_detail = contaGravada;
        if ((existente.billing_cycle ?? null) !== (precificacao.billingCycle ?? null)) {
          patch.billing_cycle = precificacao.billingCycle;
        }
      }
      // O meio desta tentativa, gravado ANTES da chamada (0100): é ele que diz,
      // se a resposta se perder, que houve uma tentativa no cartão.
      if ((existente.billing_type ?? null) !== meio) patch.billing_type = meio;
      if (Object.keys(patch).length) await BillingCharge.update(existente.id, patch);
    }

    const vencimentoDoGateway = this.dueDateFor(vencimento, now);

    let chargeId = existente?.id ?? null;
    if (!chargeId) {
      try {
        chargeId = await BillingCharge.open({
          subscriptionId: subscription.id ?? null,
          periodEnd: periodo,
          amountCents: preco,
          currency: moeda,
          provider: provider.name,
          dueDate: vencimentoDoGateway,
          claimUntil: garraAte,
          billingType: meio,
          ...precificacao,
          pricingDetail: conta
        });
      } catch (error) {
        // Duas passadas se cruzaram e a outra ganhou. O índice único é quem
        // decidiu, e perder aqui é o resultado certo — não é erro. A linha de
        // quem ganhou vai junto, para quem clicou.
        if (isUniqueViolation(error)) {
          return { issued: false, reason: 'raced', charge: await BillingCharge.forPeriod(periodo) };
        }
        throw error;
      }
    }

    // O crédito do provedor (0106) — a recompensa de indicação, o ajuste do
    // console — abate o preço desta renovação, nunca abaixo do piso de
    // R$ 5,00. Reservado na linha AGORA, com a garra dela: o que vai ao
    // gateway logo abaixo é o preço menos o reservado, e a reserva só vira
    // gasto quando ela for paga (ou volta ao saldo se ela for cancelada ou
    // reemitida). Recalculado a cada tentativa: a reserva anterior desta
    // linha volta antes. Não na de valor mudado à mão pelo console — o valor
    // dela é decisão de gente. Uma falha aqui emite sem crédito, e o crédito
    // fica para a próxima fatura: cobrar o preço cheio é corrigível, perder
    // a emissão não.
    let creditoReservado = 0;
    const precoAntesDoCredito = preco;
    if (!existente?.amount_overridden_at) {
      try {
        const credito = await TenantCredit.reserveForCharge(chargeId, preco);
        preco = credito.amountCents;
        creditoReservado = credito.reservedCents;
      } catch (error) {
        console.error(`Could not reserve credit on charge ${chargeId} of provider ${tenant.id}: ${error.message}`);
      }
    }

    // A isenção pode ter sido ligada entre a leitura lá de cima e aqui — a
    // garra e a linha já são desta passada, e o cancelamento do console não
    // toma linha com garra. Relida agora, logo antes de falar com o gateway:
    // se ligou, a linha sai cancelada com a marca da isenção (sem id no
    // gateway, não há o que cancelar lá) e nada é emitido. O que escapar desta
    // janela — a isenção ligada DURANTE o `createCharge` — a varredura do
    // agendador cancela na próxima passada.
    const releitura = await Subscription.forTenant(currentTenantId());
    if (releitura?.billing_exempt_at) {
      await BillingCharge.update(chargeId, {
        status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: EXEMPT_CANCEL_MARKER
      });
      return { issued: false, reason: 'billing_exempt' };
    }
    // Cancelada ou suspensa à mão no meio: nada sai, e a linha fica sem id
    // (a faxina e a próxima emissão decidem por ela).
    if (releitura && !isBillableStatus(releitura)) {
      await this.soltarCreditoNaoEmitido(chargeId, creditoReservado, precoAntesDoCredito);
      await BillingCharge.release(chargeId);
      return { issued: false, reason: 'not_billable' };
    }
    // O cancelamento agendado (ou a pausa, para o agendador) que entrou no
    // meio desta passada (0107): nada sai, pela mesma razão — e o crédito
    // (0106) que esta passada acabou de reservar volta ao saldo: uma linha
    // que não vai ao gateway não segura o crédito de ninguém.
    if (releitura && (isCancelScheduled(releitura) || (!manual && isPauseScheduled(releitura)))) {
      await this.soltarCreditoNaoEmitido(chargeId, creditoReservado, precoAntesDoCredito);
      await BillingCharge.release(chargeId);
      return { issued: false, reason: isCancelScheduled(releitura) ? 'cancel_scheduled' : 'paused' };
    }
    // O cartão relido logo antes da chamada (0100): desligar a cobrança
    // automática ou remover o cartão enquanto esta passada estava no meio
    // não pode terminar numa cobrança no cartão.
    if (cartao) {
      cartao = provider.canChargeSavedCard ? CardAutopayService.chargeOptions(releitura) : null;
      if (!cartao) {
        meio = 'UNDEFINED';
        await BillingCharge.update(chargeId, { billing_type: 'UNDEFINED' });
      }
    }

    const criar = (comCartao) => provider.createCharge({
      customerRef: tenant.billing_customer_ref,
      amountCents: preco,
      currency: moeda,
      dueDate: vencimentoDoGateway,
      description: `${tenant.name || PRODUCT_NAME} — ${planoDoPeriodo.name || planoDoPeriodo.code}`
        // O ciclo anual (0104) dito na fatura: é um valor maior, e é de um ano.
        + (precificacao.billingCycle === 'annual' ? ' (anual)' : '')
        // O excedente (0105) vai resumido na descrição: quem paga vê do que é o
        // valor a mais. A de valor mudado à mão (0078) não leva — o valor dela
        // não é a conta.
        + (existente?.amount_overridden_at ? '' : overageDescription(excedente)),
      // O formato que o webhook espera de volta, com o período junto: é por
      // ele que a entrega acha o provedor sem depender do cadastro do cliente
      // no gateway estar ligado a quem se pensa.
      reference: referencia,
      ...(comCartao ?? {})
    });

    let criada;
    let cartaoRecusado = false;
    try {
      criada = await criar(cartao);
    } catch (error) {
      // O cartão recusado na criação (0100): a falha fica no cartão, e a
      // fatura sai NA HORA como Pix/boleto, pela mesma linha — o provedor não
      // pode ficar sem ter como pagar porque o cartão dele não passou.
      // `safe` (a chamada nem foi processada) deixa a próxima tentativa usar
      // o cartão; `ambiguous` deixa a linha marcada como tentativa de cartão,
      // e a próxima pergunta ao gateway antes de qualquer coisa (acima).
      // `rejected` é a recusa do PEDIDO que não é do cartão: a cobrança não
      // foi criada, sai já como Pix/boleto — sem marcar o cartão nem avisar.
      const leitura = cartao ? CardAutopayService.classifyError(error) : null;
      if (leitura !== 'refused' && leitura !== 'rejected') {
        if (leitura === 'safe') await BillingCharge.update(chargeId, { billing_type: null });
        await BillingCharge.markFailed(chargeId, error.message, { retryAfterMs: this.RETRY_AFTER_MS });
        return { issued: false, reason: 'gateway_failed', error: error.message };
      }
      // A mensagem do gateway já vem sem o token (`asaasClient` o tira).
      if (leitura === 'refused') {
        console.warn(`The saved card of provider ${tenant.id} was refused (${error.message}); charge ${chargeId} goes out as Pix/boleto`);
        await CardAutopayService.markRefused({ reason: 'charge_refused', now });
        cartaoRecusado = true;
      } else {
        console.warn(`The card charge of provider ${tenant.id} was rejected (${error.message}); charge ${chargeId} goes out as Pix/boleto`);
      }
      await BillingCharge.update(chargeId, { billing_type: 'UNDEFINED' });
      meio = 'UNDEFINED';
      try {
        criada = await criar(null);
      } catch (segundo) {
        await BillingCharge.markFailed(chargeId, segundo.message, { retryAfterMs: this.RETRY_AFTER_MS });
        if (cartaoRecusado) await this.avisarRecusa(tenant, now);
        return {
          issued: false, reason: 'gateway_failed', error: segundo.message, ...(cartaoRecusado ? { cardRefused: true } : {})
        };
      }
    }

    // A tradução entre os dois vocabulários, num ponto só: o cliente fala a
    // língua do gateway (`chargeId` é o id DELE) e a tabela fala a do painel
    // (`gateway_charge_id` é o id de lá, visto daqui).
    const gravada = await BillingCharge.markIssued(chargeId, {
      gatewayChargeId: criada.chargeId,
      invoiceUrl: criada.invoiceUrl,
      dueDate: criada.dueDate,
      discountTerms: criada.discountTerms
    });
    if (!gravada) {
      // A garra venceu no meio de uma chamada lenta, outra passada a tomou e
      // gravou primeiro. As duas cobranças existem no gateway; a da linha é a
      // do outro, e a desta passada é a que sobra — cancelada lá agora, e dita
      // em voz alta se nem isso der, porque é uma fatura a mais na mão de um
      // cliente pagante.
      try {
        if (typeof provider.cancelCharge === 'function') await provider.cancelCharge(criada.chargeId);
        console.warn(`Charge row ${chargeId} was issued by another pass; duplicate gateway charge ${criada.chargeId} was canceled`);
      } catch (error) {
        console.error(
          `Charge row ${chargeId} was issued by another pass and duplicate gateway charge ${criada.chargeId} `
          + `could NOT be canceled — cancel it by hand: ${error.message}`
        );
      }
      return { issued: false, reason: 'raced', charge: await BillingCharge.findById(chargeId) };
    }
    // A retenção (0107) que entrou DURANTE o `createCharge`: a pausa ou o
    // cancelamento agendado gravados enquanto o gateway respondia não acharam
    // a linha (ela estava com a garra desta passada). Relida agora: se a
    // assinatura passou a não renovar, a cobrança recém-criada é cancelada lá
    // e aqui, com a marca da retenção — como `cancelRenewalCharges` faria.
    // Melhor esforço: a recusa do gateway fica no log, e a varredura do fluxo
    // de cancelamento (que roda de novo depois de gravar) tenta outra vez.
    const depois = await Subscription.forTenant(currentTenantId());
    if (depois && (isCancelScheduled(depois) || (!manual && isPauseScheduled(depois)))) {
      try {
        if (typeof provider.cancelCharge === 'function') await provider.cancelCharge(criada.chargeId);
        await BillingCharge.update(chargeId, {
          status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: RETENTION_CANCEL_MARKER
        });
        return { issued: false, reason: isCancelScheduled(depois) ? 'cancel_scheduled' : 'paused', canceledAfterIssue: true };
      } catch (error) {
        console.warn(
          `Charge ${chargeId} of provider ${tenant.id} was issued while the subscription stopped renewing, `
          + `and could not be canceled at the gateway: ${error.message}`
        );
      }
    }
    if (cartaoRecusado) await this.avisarRecusa(tenant, now);
    return {
      issued: true,
      periodEnd: periodo,
      amountCents: preco,
      ...(creditoReservado ? { creditCents: creditoReservado } : {}),
      chargeId: criada.chargeId,
      billingType: meio,
      ...(cartaoRecusado ? { cardRefused: true } : {}),
      charge: await BillingCharge.findById(chargeId)
    };
  }

  // ── A fatura de pró-rata da subida (0101) ────────────────────────────

  /**
   * Quantos dias a fatura de pró-rata dá para ser paga. Curto de propósito:
   * o plano novo já vale, e a diferença é do período que está correndo.
   */
  static PRORATION_DUE_DAYS = 3;

  /**
   * Abre e emite a fatura de pró-rata de uma subida que JÁ foi gravada.
   *
   * Depois da troca, e não antes: a subida vale na hora, e a fatura é a
   * consequência dela — se a troca falhasse depois de a fatura sair, seria
   * cobrar por um plano que o provedor não ganhou. E a falha daqui não desfaz
   * a troca: a linha fica `failed` (ou `pending`, sem gateway configurado) e
   * o agendador a retoma (`retryProrations`), com a mesma referência.
   *
   * `quote` é a conta de `SubscriptionService.prorationQuote`, feita com o
   * estado de ANTES da troca. Nunca lança por causa do gateway.
   *
   * @returns {Promise<{ issued: boolean, reason?: string, charge?: object, error?: string }>}
   */
  static async createProration({
    tenant, subscription, quote, couponId = null, now = new Date()
  }) {
    if (!quote?.eligible) return { issued: false, reason: 'not_eligible' };
    if (quote.skipped) return { issued: false, reason: quote.skipped };
    if (!tenant || tenant.kind === 'platform') return { issued: false, reason: 'platform_tenant' };
    // Sem gateway que emita, como a renovação: quem é cobrado por fora (o
    // `manual`) ou nunca foi ligado não ganha fatura daqui — e nem linha, que
    // ficaria em aberto para sempre sem ninguém para emiti-la.
    const provider = providerFor(tenant.billing_gateway);
    if (!provider || !tenant.billing_customer_ref) return { issued: false, reason: 'not_linked' };
    if (!provider.canIssue) return { issued: false, reason: 'provider_cannot_issue' };

    const renovacao = new Date(quote.renewsAt);
    const periodEnd = this.periodKey(renovacao);
    // A chave da subida: a primeira cujo dono não é uma fatura JÁ FECHADA
    // (paga, cancelada, estornada). Uma em aberto com a mesma chave é o outro
    // clique da mesma subida, e o índice único o deduplica abaixo; uma fechada
    // é a mesma subida feita antes neste período, e a de agora é outra.
    let key = null;
    for (let seq = 0; seq < 50; seq += 1) {
      const candidata = BillingCharge.prorationKey({
        fromPlanId: quote.fromPlanId, toPlanId: quote.toPlanId, periodEnd, seq
      });
      // eslint-disable-next-line no-await-in-loop -- quase sempre uma leitura
      const dona = await BillingCharge.prorationByKey(candidata);
      if (!dona || OPEN_CHARGE_STATUSES.includes(dona.status)) {
        key = candidata;
        break;
      }
    }
    if (!key) return { issued: false, reason: 'duplicate' };
    let chargeId;
    try {
      chargeId = await BillingCharge.openProration({
        key,
        subscriptionId: subscription?.id ?? null,
        amountCents: quote.amountCents,
        currency: quote.currency || 'BRL',
        provider: provider.name,
        dueDate: this.isoDate(now.getTime() + this.PRORATION_DUE_DAYS * 86_400_000),
        claimUntil: new Date(now.getTime() + this.CLAIM_MS),
        planId: quote.toPlanId,
        couponId,
        billingCycle: quote.billingCycle ?? null,
        detail: {
          fromPlanId: quote.fromPlanId,
          toPlanId: quote.toPlanId,
          fromPriceCents: quote.fromPriceCents,
          toPriceCents: quote.toPriceCents,
          remainingSeconds: quote.remainingSeconds,
          periodSeconds: quote.periodSeconds,
          remainingDays: quote.remainingDays,
          // O fim do período cuja diferença esta fatura cobra, na chave de
          // sempre — é o que a tela e a NFS-e mostram como "período".
          periodEnd,
          renewsAt: quote.renewsAt,
          at: now.toISOString()
        }
      });
    } catch (error) {
      // A mesma subida, no mesmo período, já tem a sua fatura — o outro
      // clique que leu o mesmo plano de antes. Não se abre a segunda.
      if (isUniqueViolation(error)) {
        console.warn(`Proration ${key} of provider ${tenant.id} already exists; not charging the same upgrade twice`);
        return { issued: false, reason: 'duplicate', charge: await BillingCharge.prorationByKey(key) };
      }
      throw error;
    }
    return this.emitProration({ tenant, provider, chargeId, now });
  }

  /**
   * Leva ao gateway uma fatura de pró-rata que esta passada JÁ garrou.
   *
   * A mesma dança da renovação (`issueCurrent`): a isenção relida logo antes
   * de falar com o gateway, a falha que vira `failed` com espera, e a gravação
   * condicional do id (`markIssued`) que, perdida, cancela a duplicata lá. A
   * referência é `tenant:<id>:proration:<id da linha>` — a mesma em toda
   * retentativa, para o gateway e o webhook acharem a mesma fatura.
   *
   * O vencimento é o da linha, ou — se ela ficou parada até ele passar — três
   * dias a partir de hoje: o gateway recusa cobrança que nasce vencida.
   */
  static async emitProration({ tenant, provider, chargeId, now = new Date() }) {
    const linha = await BillingCharge.findById(chargeId);
    if (!linha || !isProration(linha)) return { issued: false, reason: 'not_found' };
    if (linha.gateway_charge_id) {
      await BillingCharge.release(linha.id);
      return { issued: false, reason: 'already_issued', charge: linha };
    }
    if (typeof provider.isConfigured === 'function' && !(await provider.isConfigured())) {
      // Sem a chave, a linha espera — sem queimar tentativa, como a renovação.
      await BillingCharge.release(linha.id);
      return { issued: false, reason: 'gateway_not_configured', charge: linha };
    }
    const assinatura = await Subscription.forTenant(currentTenantId());
    if (assinatura?.billing_exempt_at) {
      await BillingCharge.update(linha.id, {
        status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: EXEMPT_CANCEL_MARKER
      });
      return { issued: false, reason: 'billing_exempt' };
    }
    // A fatura FINAL de excedente (0105) é de quem cancelou: o cancelamento
    // não a cancela — é justamente a conta do que foi usado até ele.
    const finalDeExcedente = isOverageCharge(linha) && Boolean(BillingCharge.prorationDetailOf(linha)?.final);
    // Cancelada ou suspensa à mão depois da subida: a diferença não se cobra
    // mais — a linha sai cancelada, sem nunca ter ido ao gateway. A de cartão
    // pergunta antes ao gateway (abaixo): a cobrança pode já existir lá.
    if (!finalDeExcedente && (!assinatura || !isBillableStatus(assinatura)) && linha.billing_type !== 'CREDIT_CARD') {
      await this.cancelUnbillableProration(linha.id);
      return { issued: false, reason: 'not_billable', charge: await BillingCharge.findById(linha.id) };
    }
    // A retenção (0107): pausada ou com o cancelamento agendado, a pró-rata
    // que não chegou ao gateway ESPERA — sem ser cancelada: desfeito o
    // agendamento (ou acabada a pausa), ela sai pela passada seguinte.
    if (!finalDeExcedente && assinatura && (isPauseScheduled(assinatura) || isCancelScheduled(assinatura))) {
      await BillingCharge.release(linha.id);
      return { issued: false, reason: 'retention_hold', charge: linha };
    }

    const hoje = this.isoDate(now);
    const daLinha = isoDateOf(linha.due_date);
    const vencimento = daLinha && daLinha >= hoje
      ? daLinha
      : this.isoDate(now.getTime() + this.PRORATION_DUE_DAYS * 86_400_000);
    if (vencimento !== daLinha) await BillingCharge.update(linha.id, { due_date: vencimento });

    const detalhe = BillingCharge.prorationDetailOf(linha);
    const doExcedente = isOverageCharge(linha);
    const planoId = doExcedente ? linha.plan_id : detalhe?.toPlanId;
    const plano = planoId ? await Plan.findById(planoId) : null;
    const nomeDoPlano = plano?.name || plano?.code || '';
    const referencia = `tenant:${tenant.id}:${doExcedente ? 'overage' : 'proration'}:${linha.id}`;

    // O cartão salvo (0100), pela mesma decisão da renovação: com a cobrança
    // automática utilizável, a pró-rata sai no cartão e o gateway a cobra na
    // hora; senão, Pix/boleto com multa, juros e desconto (`chargeTermsFor`,
    // aplicado por `createCharge` só fora do cartão).
    let cartao = provider.canChargeSavedCard ? CardAutopayService.chargeOptions(assinatura) : null;
    let meio = cartao ? 'CREDIT_CARD' : 'UNDEFINED';

    // A tentativa de cartão anterior que terminou sem resposta: a cobrança
    // pode existir lá, e no cartão é dinheiro que já saiu. Pergunta-se pela
    // referência antes de criar outra — como `issueCurrent`. Sem olhar
    // `attempts`: o clique do console (`retryProrations` manual) as zera antes
    // de chegar aqui, e a linha só ganha `CREDIT_CARD` sem id no gateway
    // quando uma tentativa no cartão começou e não terminou.
    if (linha.billing_type === 'CREDIT_CARD' && typeof provider.findChargesByReference === 'function') {
      let achadas;
      try {
        achadas = await provider.findChargesByReference(referencia);
      } catch (error) {
        await BillingCharge.markFailed(linha.id, `card charge lookup failed: ${error.message}`, {
          retryAfterMs: this.RETRY_AFTER_MS
        });
        return { issued: false, reason: 'gateway_failed', error: error.message, charge: await BillingCharge.findById(linha.id) };
      }
      const viva = achadas.find((item) => item.billingType === 'CREDIT_CARD') ?? achadas[0] ?? null;
      if (viva) {
        const adotada = await this.adoptFound({ linha, viva, provider, now });
        return { issued: false, reason: 'already_issued', adopted: true, ...adotada };
      }
    }

    // Relida logo antes da chamada: cancelada ou suspensa à mão, isenta, ou
    // o cartão desligado/removido enquanto esta passada estava no meio.
    const releitura = await Subscription.forTenant(currentTenantId());
    if (releitura?.billing_exempt_at) {
      await BillingCharge.update(linha.id, {
        status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: EXEMPT_CANCEL_MARKER
      });
      return { issued: false, reason: 'billing_exempt' };
    }
    if (!finalDeExcedente && (!releitura || !isBillableStatus(releitura))) {
      await this.cancelUnbillableProration(linha.id);
      return { issued: false, reason: 'not_billable', charge: await BillingCharge.findById(linha.id) };
    }
    if (!finalDeExcedente && (isPauseScheduled(releitura) || isCancelScheduled(releitura))) {
      await BillingCharge.release(linha.id);
      return { issued: false, reason: 'retention_hold', charge: await BillingCharge.findById(linha.id) };
    }
    if (cartao) {
      cartao = provider.canChargeSavedCard ? CardAutopayService.chargeOptions(releitura) : null;
      if (!cartao) meio = 'UNDEFINED';
    }

    // O meio desta tentativa, gravado ANTES da chamada: é ele que diz, se a
    // resposta se perder, que houve uma tentativa no cartão.
    if ((linha.billing_type ?? null) !== meio) await BillingCharge.update(linha.id, { billing_type: meio });

    const criar = (comCartao) => provider.createCharge({
      customerRef: tenant.billing_customer_ref,
      amountCents: Number(linha.amount_cents),
      currency: linha.currency || 'BRL',
      dueDate: vencimento,
      description: doExcedente
        ? `${tenant.name || PRODUCT_NAME} — ${nomeDoPlano ? `${nomeDoPlano} ` : ''}(excedente${detalhe?.periodEnd
          ? ` até ${String(detalhe.periodEnd).slice(0, 10).split('-').reverse().join('/')}` : ''})`
          + overageDescription(BillingCharge.frozenOverageOf(linha) ?? []).replace(/^ \+ excedente [^(]*/, ' ')
        : `${tenant.name || PRODUCT_NAME} — ${nomeDoPlano ? `${nomeDoPlano} ` : ''}(pró-rata)`,
      reference: referencia,
      ...(comCartao ?? {})
    });
    const falhou = async (error) => {
      await BillingCharge.markFailed(linha.id, error.message, { retryAfterMs: this.RETRY_AFTER_MS });
      console.warn(`Proration charge ${linha.id} of provider ${tenant.id} was not issued: ${error.message}`);
    };

    let criada;
    let cartaoRecusado = false;
    try {
      criada = await criar(cartao);
    } catch (error) {
      // A recusa do cartão como na renovação: o cartão fica marcado, e a
      // fatura sai na hora como Pix/boleto, pela mesma linha, com o aviso.
      const leitura = cartao ? CardAutopayService.classifyError(error) : null;
      if (leitura !== 'refused' && leitura !== 'rejected') {
        if (leitura === 'safe') await BillingCharge.update(linha.id, { billing_type: null });
        await falhou(error);
        return { issued: false, reason: 'gateway_failed', error: error.message, charge: await BillingCharge.findById(linha.id) };
      }
      if (leitura === 'refused') {
        console.warn(`The saved card of provider ${tenant.id} was refused (${error.message}); proration ${linha.id} goes out as Pix/boleto`);
        await CardAutopayService.markRefused({ reason: 'charge_refused', now });
        cartaoRecusado = true;
      } else {
        console.warn(`The card charge of provider ${tenant.id} was rejected (${error.message}); proration ${linha.id} goes out as Pix/boleto`);
      }
      await BillingCharge.update(linha.id, { billing_type: 'UNDEFINED' });
      meio = 'UNDEFINED';
      try {
        criada = await criar(null);
      } catch (segundo) {
        await falhou(segundo);
        if (cartaoRecusado) await this.avisarRecusa(tenant, now);
        return {
          issued: false,
          reason: 'gateway_failed',
          error: segundo.message,
          ...(cartaoRecusado ? { cardRefused: true } : {}),
          charge: await BillingCharge.findById(linha.id)
        };
      }
    }

    const gravada = await BillingCharge.markIssued(linha.id, {
      gatewayChargeId: criada.chargeId,
      invoiceUrl: criada.invoiceUrl,
      dueDate: criada.dueDate,
      discountTerms: criada.discountTerms
    });
    if (!gravada) {
      try {
        if (typeof provider.cancelCharge === 'function') await provider.cancelCharge(criada.chargeId);
        console.warn(`Proration row ${linha.id} was issued by another pass; duplicate gateway charge ${criada.chargeId} was canceled`);
      } catch (error) {
        console.error(
          `Proration row ${linha.id} was issued by another pass and duplicate gateway charge ${criada.chargeId} `
          + `could NOT be canceled — cancel it by hand: ${error.message}`
        );
      }
      return { issued: false, reason: 'raced', charge: await BillingCharge.findById(linha.id) };
    }
    const emitida = await BillingCharge.findById(linha.id);
    if (cartaoRecusado) await this.avisarRecusa(tenant, now, emitida);
    return {
      issued: true,
      billingType: meio,
      ...(cartaoRecusado ? { cardRefused: true } : {}),
      charge: emitida
    };
  }

  /**
   * A passada do agendador pelas faturas de pró-rata que não chegaram ao
   * gateway: a criação falhou, ou a chave da API não estava configurada.
   *
   * As mesmas guardas da renovação — o teto de tentativas (`MAX_ATTEMPTS`), a
   * espera entre elas (`next_attempt_at`) e a garra (`claim`), que só toma
   * linha sem id no gateway — e a mesma referência em toda tentativa. O
   * clique do console (`manual`) zera a paciência do agendador, como na
   * renovação.
   *
   * De quebra, regrava `proration_due_at` quando há o que regravar: é o que
   * conserta a cópia se algum caminho a deixou para trás.
   *
   * @returns {Promise<{ retried: number, issued: number }>}
   */
  static async retryProrations({ tenant: doLaco = null, now = new Date(), manual = false, chargeId = null } = {}) {
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    const resumo = { retried: 0, issued: 0 };
    if (!tenant || tenant.kind === 'platform') return { ...resumo, reason: 'platform_tenant' };
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription) return { ...resumo, reason: 'no_subscription' };
    const abertas = await BillingCharge.openProrations();
    if (abertas.length || subscription.proration_due_at) await BillingCharge.syncProrationDue();
    if (!abertas.length) return resumo;
    if (subscription.billing_exempt_at) return { ...resumo, reason: 'billing_exempt' };
    // Cancelada ou suspensa à mão: a diferença da subida não vai mais ao
    // gateway. A que não chegou lá sai cancelada; a que já tem link fica.
    // A de cartão sem id passa antes pelo gateway (`emitProration` pergunta
    // pela referência, adota a que existir e cancela a que não existe).
    if (!isBillableStatus(subscription)) {
      const canceladas = await BillingCharge.cancelUnissuedProrations({ reason: 'not_billable', now });
      for (const linha of await BillingCharge.unissuedProrations()) {
        // A fatura final de excedente (0105) é de quem cancelou: segue.
        const final = isOverageCharge(linha) && BillingCharge.prorationDetailOf(linha)?.final;
        if (linha.billing_type !== 'CREDIT_CARD' && !final) continue;
        if (final && !manual) {
          if (Number(linha.attempts ?? 0) >= this.MAX_ATTEMPTS) continue;
          const espera = linha.next_attempt_at ? new Date(linha.next_attempt_at) : null;
          if (espera && espera.getTime() > now.getTime()) continue;
        }
        // eslint-disable-next-line no-await-in-loop
        if (!(await BillingCharge.claim(linha.id, { until: new Date(now.getTime() + this.CLAIM_MS), now }))) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.emitProration({ tenant, provider: providerFor(tenant.billing_gateway), chargeId: linha.id, now });
      }
      return { ...resumo, reason: 'not_billable', ...(canceladas ? { canceled: canceladas } : {}) };
    }
    // A retenção (0107): a pró-rata espera, sem cancelar (ver `emitProration`).
    if (isPauseScheduled(subscription) || isCancelScheduled(subscription)) return { ...resumo, reason: 'retention_hold' };

    const provider = providerFor(tenant.billing_gateway);
    if (!provider || !tenant.billing_customer_ref) return { ...resumo, reason: 'not_linked' };
    if (!provider.canIssue) return { ...resumo, reason: 'provider_cannot_issue' };
    if (typeof provider.isConfigured === 'function' && !(await provider.isConfigured())) {
      return { ...resumo, reason: 'gateway_not_configured' };
    }

    for (const linha of await BillingCharge.unissuedProrations()) {
      if (chargeId && Number(linha.id) !== Number(chargeId)) continue;
      if (!manual) {
        if (Number(linha.attempts ?? 0) >= this.MAX_ATTEMPTS) continue;
        const espera = linha.next_attempt_at ? new Date(linha.next_attempt_at) : null;
        if (espera && !Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) continue;
      }
      // eslint-disable-next-line no-await-in-loop -- uma ou duas por provedor, e cada uma fala com o gateway
      const minha = await BillingCharge.claim(linha.id, { until: new Date(now.getTime() + this.CLAIM_MS), now });
      if (!minha) continue;
      if (manual) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(linha.id, { attempts: 0, next_attempt_at: null });
      }
      resumo.retried += 1;
      // eslint-disable-next-line no-await-in-loop
      const resultado = await this.emitProration({ tenant, provider, chargeId: linha.id, now });
      if (resultado.issued) resumo.issued += 1;
      if (chargeId) return { ...resumo, result: resultado };
    }
    return resumo;
  }

  /**
   * A reemissão por clique de uma assinatura com cartão salvo, adiada para o
   * dia do vencimento (ver `adiarCartao` em `issueCurrent`). A linha fica sem
   * id no gateway e com a paciência do agendador zerada: é a passada dele, no
   * dia, que a emite no cartão.
   */
  static async deferCardCharge(linha) {
    if (Number(linha.attempts ?? 0) > 0 || linha.next_attempt_at) {
      await BillingCharge.update(linha.id, { attempts: 0, next_attempt_at: null });
    }
    return { issued: false, reason: 'card_deferred', charge: await BillingCharge.findById(linha.id) };
  }

  /** A pró-rata sem id no gateway de quem deixou de ser cobrável, cancelada. */
  static async cancelUnbillableProration(id) {
    await BillingCharge.update(id, {
      status: 'canceled', issuing_until: null, next_attempt_at: null, last_error: 'not_billable'
    });
  }

  /** Os estados do gateway em que a cobrança já foi paga. */
  static PAID_GATEWAY_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);

  /**
   * A cobrança achada no gateway pela nossa referência — a tentativa de
   * cartão cuja resposta se perdeu — vira a cobrança da linha. Se lá ela já
   * está PAGA (o cartão é cobrado na criação), quita-se aqui também, pelo
   * mesmo caminho do webhook (`settleAdopted`).
   *
   * @returns {Promise<{ charge: object, settled?: string }>}
   */
  static async adoptFound({ linha, viva, provider, now = new Date() }) {
    await BillingCharge.markIssued(linha.id, {
      gatewayChargeId: viva.chargeId, invoiceUrl: viva.invoiceUrl, dueDate: viva.dueDate
    });
    await BillingCharge.update(linha.id, {
      billing_type: viva.billingType === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'UNDEFINED'
    });
    let settled;
    if (this.PAID_GATEWAY_STATUSES.has(String(viva.status ?? '').toUpperCase())) {
      try {
        settled = await this.settleAdopted({ chargeId: linha.id, gatewayChargeId: viva.chargeId, provider, now });
      } catch (error) {
        console.warn(`Could not settle adopted charge ${linha.id} (${viva.chargeId}): ${error.message}`);
        settled = 'error';
      }
    }
    return { charge: await BillingCharge.findById(linha.id), ...(settled ? { settled } : {}) };
  }

  /**
   * Quita a linha adotada cuja cobrança o gateway já tem como paga.
   *
   *   - O webhook do pagamento JÁ chegou (há evento com o id do gateway): ele
   *     foi conferido sem a linha (que ainda não tinha o id) — contra o preço
   *     do plano. Se por isso ficou "a menos" mas cobre o valor da linha (a
   *     pró-rata, a de valor mudado à mão), a diferença é aceita pela porta
   *     do console (`<id>:accepted`, com a linha nomeada: a pró-rata não
   *     estende prazo, a renovação estende). A linha fecha paga.
   *   - Não chegou: o pagamento é registrado aqui, como o webhook faria
   *     (`recordPayment` com o id do gateway — agora a linha é achada por
   *     ele), e a linha fecha paga se o valor fechou. O webhook que chegar
   *     depois cai como `duplicate`.
   *
   * @returns {Promise<string>} o que foi feito.
   */
  static async settleAdopted({ chargeId, gatewayChargeId, provider, now = new Date() }) {
    const { default: BillingEvent } = await import('../models/BillingEvent.js');
    const { default: BillingInvoiceService } = await import('./billing/billingInvoiceService.js');
    const linha = await BillingCharge.findById(chargeId);
    if (!linha || linha.status === 'paid') return 'already_paid';
    const fechar = async () => {
      await BillingCharge.update(linha.id, { status: 'paid', last_error: null, issuing_until: null });
      try {
        await BillingInvoiceService.enqueueForCharge({ ...linha, gateway_charge_id: gatewayChargeId, status: 'paid' });
      } catch (error) {
        console.warn(`Could not queue the invoice of adopted charge ${linha.id}: ${error.message}`);
      }
    };

    const evento = await BillingEvent.findByExternalId(gatewayChargeId);
    if (evento) {
      let detalhe = null;
      try { detalhe = evento.detail ? JSON.parse(evento.detail) : null; } catch { detalhe = null; }
      if (detalhe?.underpaid) {
        if (Number(evento.amount_cents ?? 0) < Number(linha.amount_cents)) return 'underpaid';
        await SubscriptionService.recordPayment({
          amountCents: 0,
          currency: evento.currency || linha.currency || 'BRL',
          provider: provider?.name ?? linha.provider ?? 'manual',
          externalId: `${gatewayChargeId}:accepted`,
          allowUnderpayment: true,
          chargeId: linha.id,
          now
        });
      }
      await fechar();
      return 'reconciled';
    }

    if (typeof provider?.getCharge !== 'function' || typeof provider?.recordPayment !== 'function') return 'left_for_webhook';
    const lida = await provider.getCharge(gatewayChargeId);
    if (!this.PAID_GATEWAY_STATUSES.has(String(lida?.status ?? '').toUpperCase()) || !(lida?.valueCents > 0)) {
      return 'left_for_webhook';
    }
    const resultado = await provider.recordPayment({
      amountCents: lida.valueCents,
      currency: 'BRL',
      externalId: gatewayChargeId,
      paidOn: lida.paidOn ?? null,
      actorUserId: null
    });
    if (resultado.duplicate) {
      // O webhook entrou no meio: agora há o evento, e é por ele que se fecha.
      if (await BillingEvent.findByExternalId(gatewayChargeId)) {
        return this.settleAdopted({ chargeId, gatewayChargeId, provider, now });
      }
      return 'duplicate';
    }
    if (resultado.underpaid) return 'underpaid';
    await fechar();
    return 'recorded';
  }

  /** O aviso da recusa do cartão, já com o link da fatura nova. Nunca lança. */
  static async avisarRecusa(tenant, now, charge = null) {
    try {
      await CardAutopayService.notifyRefusal({ tenant, now, charge });
    } catch (error) {
      console.warn(`Could not send the card refusal notice to provider ${tenant?.id}: ${error.message}`);
    }
  }

  /**
   * A cobrança da renovação de volta ao preço do plano atual, quando a
   * descida agendada que a baixou ficou bloqueada pelo uso (ver o comentário
   * no ponto em que `issueCurrent` chama isto).
   *
   * Pela porta da troca de plano (`SelfBillingService.repriceOpenCharge`), e
   * não por uma cópia dela aqui: é a mesma dança com o gateway — a garra, o
   * cancelamento que para tudo quando falha, o `resetForReissue` condicional
   * — e a reemissão volta por `issueCurrent`, que agora sai com o preço do
   * atual porque o bloqueio continua. Nunca lança, como o resto deste job.
   */
  static async repriceBlockedDowngrade({ subscription, plan, tenant, charge, blockedBy, now = new Date() }) {
    // A espera depois de uma falha, na própria linha: o agendador passa a
    // cada minuto, e um gateway que recusa o cancelamento seria martelado com
    // um DELETE por minuto. `next_attempt_at` numa linha JÁ emitida não
    // significa mais nada para a emissão (ela só o lê em linha sem id no
    // gateway), então é livre para isto — e `resetForReissue` o apaga quando
    // a reprecificação enfim dá certo.
    const espera = charge.next_attempt_at ? new Date(charge.next_attempt_at) : null;
    if (espera && !Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) {
      return { issued: false, reason: 'backing_off', charge };
    }
    // Importado aqui, e não no topo: `selfBillingService` importa este
    // arquivo, e o caminho de volta só é preciso neste caso raro.
    const { default: SelfBillingService } = await import('./selfBillingService.js');
    try {
      const resultado = await SelfBillingService.repriceOpenCharge({ subscription, plan, tenant, blockedBy });
      console.warn(
        `Renewal charge ${charge.id} of provider ${tenant.id} was repriced back to plan ${plan.id}: `
        + 'the scheduled downgrade is blocked by usage'
      );
      return resultado.reissue ?? {
        issued: false,
        reason: resultado.charge === 'reissued' ? 'repriced' : 'already_issued',
        charge: await BillingCharge.findById(charge.id)
      };
    } catch (error) {
      // Ocupada é outra passada mexendo nela agora: nada a esperar.
      if (error.code === 'busy') return { issued: false, reason: 'raced', error: error.message, charge };
      // `detail` é o motivo do gateway; `message`, numa recusa traduzível, é
      // só a chave da frase — e quem lê `last_error` quer o motivo.
      const motivo = String(error.detail ?? error.message ?? '');
      await BillingCharge.update(charge.id, {
        last_error: motivo.slice(0, 500),
        next_attempt_at: new Date(now.getTime() + this.RETRY_AFTER_MS)
      });
      console.warn(`Could not reprice renewal charge ${charge.id} of provider ${tenant.id}: ${motivo}`);
      return { issued: false, reason: 'reprice_failed', error: motivo, charge };
    }
  }
}

export default ChargeIssuingService;
