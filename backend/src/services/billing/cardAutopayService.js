import { tdb } from '../../config/database.js';
import { currentTenantId } from '../../config/tenantContext.js';
import { createSecretBox } from '../../utils/secretBox.js';
import Subscription from '../../models/Subscription.js';
import BillingCharge, { OPEN_CHARGE_STATUSES, isProration } from '../../models/BillingCharge.js';
import SubscriptionService, { isBillableStatus } from '../subscriptionService.js';
import { providerFor } from './registry.js';

/**
 * O cartão recorrente (0100): o provedor paga uma fatura com cartão na página
 * do Asaas, e as renovações seguintes são cobradas nele sozinhas.
 *
 * ## O que este painel guarda, e o que nunca vê
 *
 * O número do cartão nunca passa por aqui: quem o digita é o provedor, na
 * página segura do gateway. O que se guarda é o `creditCardToken` que o
 * gateway devolve depois de um pagamento confirmado com cartão — lido pelo
 * `GET /payments/{id}` (`getPaymentCard`), cifrado com `secretBox` na hora e
 * gravado nas colunas `card_token_*` da assinatura. O token é credencial de
 * cobrança: não sai em resposta nenhuma (a tela vê só bandeira, quatro
 * dígitos e datas — `SubscriptionService.presentCard`), nem na trilha, nem no
 * log, nem no `last_error` de uma cobrança (o cliente do gateway o tira da
 * mensagem de erro).
 *
 * ## Fora da requisição do webhook
 *
 * O webhook só ANOTA o que falta fazer (`requestCapture`, `markRefused`) —
 * duas escritas pequenas no banco, no escopo do provedor. A conversa com o
 * gateway (ler o token, cancelar e reemitir a fatura recusada) e o aviso saem
 * em `processDue`: logo depois da resposta, e de novo a cada passada do
 * agendador enquanto houver o que fazer. A anotação é a memória, e é ela que
 * faz isto sobreviver a um processo que morre no meio.
 *
 * ## A regra que decide se uma cobrança de cartão continua de pé
 *
 * O cartão só é usado quando é UTILIZÁVEL (`usable`): cobrança automática
 * ligada, token salvo, o IP de quem a ligou, e nenhuma recusa desde o último
 * token. Uma cobrança de cartão em aberto num provedor cujo cartão deixou de
 * ser utilizável — recusado, removido, cobrança automática desligada — é
 * cancelada no gateway e reemitida como Pix/boleto (`reissueIneligible`). A
 * recusa do cancelamento (o gateway já capturou, por exemplo) deixa a linha
 * como está: é o pagamento que vai chegar, e não uma fatura a mais.
 */

/** O contexto da caixa — o mesmo que `secretRotationService` usa para re-cifrar. */
export const CARD_TOKEN_CONTEXT = 'skygenpanel-subscription-card-token-v1';

/**
 * Criada na primeira vez que é usada, não no carregamento do módulo: este
 * arquivo entra na cadeia de import do middleware de sessão, e um processo de
 * produção sem segredo tem de ouvir primeiro que falta o JWT_SECRET — não que
 * falta a chave da caixa de segredos.
 */
let caixa = null;
function box() {
  if (!caixa) caixa = createSecretBox(CARD_TOKEN_CONTEXT);
  return caixa;
}

/**
 * Os erros do gateway que dizem que a cobrança de cartão NÃO chegou a ser
 * processada: a chamada nem saiu (sem chave, base inválida, host recusado) ou
 * a credencial foi recusada antes de qualquer coisa. Repetir com o cartão é
 * seguro.
 */
const ERROS_ANTES_DE_COBRAR = new Set([
  'not_configured', 'invalid_base_url', 'blocked_host', 'unauthorized', 'unsupported_currency', 'bad_request'
]);

/** Um instante sem milissegundos: o MySQL arredonda, e a comparação depois não pode depender disso. */
function aoSegundo(data) {
  return new Date(Math.floor(new Date(data).getTime() / 1000) * 1000);
}

/** O envelope que `secretBox` lê, a partir das colunas da assinatura. */
function envelopeDe(subscription) {
  return {
    password_ciphertext: subscription?.card_token_ciphertext,
    password_iv: subscription?.card_token_iv,
    password_tag: subscription?.card_token_tag,
    password_key_version: subscription?.card_token_key_version
  };
}

class CardAutopayService {
  /** As colunas que esquecem o cartão — a remoção, e nada mais. */
  static CLEARED_CARD = Object.freeze({
    card_token_ciphertext: null,
    card_token_iv: null,
    card_token_tag: null,
    card_token_key_version: null,
    card_brand: null,
    card_last4: null,
    card_saved_at: null,
    card_failed_at: null,
    card_failure: null,
    card_failure_notified_at: null,
    card_capture_payment_id: null
  });

  /** Se há um token guardado (sem abri-lo). */
  static hasToken(subscription) {
    return Boolean(subscription?.card_token_ciphertext && subscription?.card_token_iv && subscription?.card_token_tag);
  }

  /**
   * Se a próxima cobrança pode sair no cartão: cobrança automática ligada,
   * token salvo, IP de quem ligou, e nenhuma recusa desde o último token.
   */
  static usable(subscription) {
    return Boolean(
      subscription?.card_autopay_at
      && this.hasToken(subscription)
      && subscription.card_remote_ip
      && !subscription.card_failed_at
    );
  }

  /**
   * O que a emissão manda ao gateway para cobrar no cartão — ou nulo, e a
   * cobrança sai pela página de sempre. Nulo também quando o token não abre
   * (a chave mudou sem a anterior no ambiente): cobrar sem cartão é o
   * caminho que nunca erra para o lado do dinheiro.
   */
  static chargeOptions(subscription) {
    if (!this.usable(subscription)) return null;
    const token = box().decrypt(envelopeDe(subscription));
    if (!token) {
      console.warn(`The saved card of provider ${subscription.tenant_id} could not be decrypted; charging without it`);
      return null;
    }
    return { billingType: 'CREDIT_CARD', creditCardToken: token, remoteIp: String(subscription.card_remote_ip) };
  }

  /**
   * Como um erro do gateway na criação de uma cobrança de CARTÃO se lê:
   *
   *   - `refused`: o gateway recusou o CARTÃO (4xx com um erro que fala do
   *     cartão — `invalid_creditCard`, "cartão", "recusad"…). Marca a falha,
   *     reemite como Pix/boleto na hora e avisa o provedor.
   *   - `rejected`: o gateway recusou o PEDIDO por outro motivo (4xx que não
   *     é do cartão — um campo, o cliente). A cobrança não foi criada, então
   *     sair como Pix/boleto agora é seguro — mas o cartão não tem culpa: não
   *     se marca a falha nem se avisa "cartão recusado".
   *   - `safe`: a cobrança não chegou a ser processada (ver
   *     `ERROS_ANTES_DE_COBRAR`, e o 429 de limite de requisições); a próxima
   *     tentativa pode usar o cartão.
   *   - `ambiguous`: a rede caiu no meio, o gateway respondeu 5xx ou algo que
   *     não se lê. A cobrança PODE existir lá — e cartão é dinheiro que sai
   *     sozinho. A próxima tentativa pergunta ao gateway antes (`issueCurrent`).
   */
  static classifyError(error) {
    const codigo = String(error?.code ?? '');
    const status = Number(error?.status ?? 0);
    if (status === 429) return 'safe';
    if (status >= 500) return 'ambiguous';
    if (codigo === 'refused') return this.isCardError(error) ? 'refused' : 'rejected';
    if (ERROS_ANTES_DE_COBRAR.has(codigo)) return 'safe';
    return 'ambiguous';
  }

  /**
   * Se a recusa do gateway fala do CARTÃO: pelos `errors` do corpo (o código
   * e a descrição), ou, sem eles, pela mensagem.
   */
  static isCardError(error) {
    const doCartao = (texto) => /credit_?card|cart[aã]o|\bcard\b|recusad|n[aã]o autorizad|declined/i.test(String(texto ?? ''));
    const erros = Array.isArray(error?.errors) ? error.errors : [];
    if (erros.length) return erros.some((item) => doCartao(item?.code) || doCartao(item?.description));
    return doCartao(error?.message);
  }

  /**
   * O webhook de um pagamento confirmado com cartão: anota que o token dele
   * falta ler — só com a cobrança automática ligada. Uma escrita, no escopo
   * do provedor; quem lê o gateway é `captureToken`.
   */
  static async requestCapture(paymentId) {
    const id = String(paymentId ?? '').trim().slice(0, 128);
    if (!id) return false;
    const changed = await tdb('subscriptions').whereNotNull('card_autopay_at')
      .update({ card_capture_payment_id: id, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * Lê o token do pagamento anotado e o guarda, cifrado. Idempotente: o mesmo
   * token não reescreve nada além de limpar a falha (pagar de novo com cartão
   * é o que tira o cartão da recusa) e a anotação.
   *
   * Falha passageira do gateway deixa a anotação para a próxima passada;
   * recusa (o pagamento não existe, não é de cartão) a apaga.
   */
  static async captureToken({ now = new Date() } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    const pagamento = subscription?.card_capture_payment_id;
    if (!pagamento) return { captured: false, reason: 'nothing_pending' };

    const limpar = () => tdb('subscriptions').where({ card_capture_payment_id: pagamento })
      .update({ card_capture_payment_id: null, updated_at: new Date() });
    if (!subscription.card_autopay_at) {
      await limpar();
      return { captured: false, reason: 'autopay_off' };
    }

    const provider = providerFor('asaas');
    if (typeof provider?.getPaymentCard !== 'function') {
      await limpar();
      return { captured: false, reason: 'provider_cannot_read_card' };
    }
    let cartao;
    try {
      cartao = await provider.getPaymentCard(pagamento);
    } catch (error) {
      if (error?.code === 'refused') {
        await limpar();
        return { captured: false, reason: 'gateway_refused' };
      }
      console.warn(`Could not read the card of payment ${pagamento} for provider ${tenantId}: ${error.message}`);
      return { captured: false, reason: 'gateway_failed' };
    }
    if (cartao?.billingType !== 'CREDIT_CARD' || !cartao.token) {
      await limpar();
      return { captured: false, reason: 'not_card' };
    }

    const atual = this.hasToken(subscription) ? box().decrypt(envelopeDe(subscription)) : null;
    const mesmo = atual !== null && atual === cartao.token;
    const patch = {
      card_brand: cartao.brand ?? (mesmo ? subscription.card_brand : null),
      card_last4: cartao.last4 ?? (mesmo ? subscription.card_last4 : null),
      card_failed_at: null,
      card_failure: null,
      card_failure_notified_at: null,
      card_capture_payment_id: null,
      updated_at: new Date()
    };
    if (!mesmo) {
      const cifrado = box().encrypt(cartao.token);
      patch.card_token_ciphertext = cifrado.password_ciphertext;
      patch.card_token_iv = cifrado.password_iv;
      patch.card_token_tag = cifrado.password_tag;
      patch.card_token_key_version = cifrado.password_key_version;
      patch.card_saved_at = aoSegundo(now);
    }
    // Condicional pela anotação e pela intenção: se a cobrança automática foi
    // desligada (ou outro pagamento anotado) no meio da leitura, não se grava.
    const changed = await tdb('subscriptions')
      .where({ card_capture_payment_id: pagamento })
      .whereNotNull('card_autopay_at')
      .update(patch);
    await SubscriptionService.invalidate(tenantId);
    return { captured: changed > 0, replaced: changed > 0 && !mesmo };
  }

  /**
   * O cartão salvo foi recusado — na captura (`PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`)
   * ou na criação da cobrança. `reason` é um código curto, nunca o texto do
   * gateway: é o que a tela do provedor traduz. Zera a memória do aviso, para
   * a recusa nova ser avisada; uma recusa que já está marcada fica como está.
   */
  static async markRefused({ reason = 'refused', now = new Date() } = {}) {
    // Só a primeira: a reentrega da mesma recusa (ou a segunda cobrança
    // recusada antes de um token novo) não reabre o aviso já dado.
    const changed = await tdb('subscriptions').whereNotNull('card_token_ciphertext').whereNull('card_failed_at').update({
      card_failed_at: aoSegundo(now),
      card_failure: String(reason).slice(0, 32),
      card_failure_notified_at: null,
      updated_at: new Date()
    });
    await SubscriptionService.invalidate(currentTenantId());
    return changed > 0;
  }

  /** As cobranças de cartão em aberto, já emitidas, do provedor em escopo. */
  static async openCardCharges() {
    return tdb('billing_charges')
      .where({ billing_type: 'CREDIT_CARD' })
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .whereNotNull('gateway_charge_id')
      .orderBy('id');
  }

  /**
   * A cobrança de cartão em aberto de um provedor cujo cartão deixou de ser
   * utilizável, cancelada no gateway e reemitida como Pix/boleto — pela porta
   * de sempre da reemissão: a garra, o cancelamento lá primeiro (a recusa
   * deixa tudo como está e espera `RETRY_AFTER_MS`), `resetForReissue` (que
   * guarda o id velho em `superseded_charges`) e `issueCurrent`, que agora
   * não usa o cartão. O valor mudado à mão pelo console volta junto.
   *
   * Nunca lança.
   */
  static async reissueIneligible({ tenant = null, now = new Date() } = {}) {
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription || this.usable(subscription)) return { reissued: 0 };
    // Parada por gente (o console suspendeu, cancelou) ou isenta: a emissão
    // não reemitiria, e cancelar a fatura agora a deixaria sem link. A
    // suspensão AUTOMÁTICA (0102) continua cobrável — é pagando que se sai
    // dela —, e o mesmo critério da emissão (`isBillableStatus`) vale aqui.
    if (!isBillableStatus(subscription) || subscription.billing_exempt_at) return { reissued: 0 };
    const linhas = await this.openCardCharges();
    if (!linhas.length) return { reissued: 0 };

    const { default: ChargeIssuingService } = await import('../chargeIssuingService.js');
    let reemitidas = 0;
    // As de pró-rata (0101) não são a renovação: `issueCurrent` não as emite,
    // e cada uma volta ao gateway pela porta dela (`retryProrations`).
    const prorratas = [];
    for (const linha of linhas) {
      if (linha.next_attempt_at) {
        const espera = new Date(linha.next_attempt_at);
        if (!Number.isNaN(espera.getTime()) && espera.getTime() > now.getTime()) continue;
      }
      // eslint-disable-next-line no-await-in-loop -- uma por provedor, e cada uma fala com o gateway
      const minha = await BillingCharge.claim(linha.id, {
        until: new Date(now.getTime() + ChargeIssuingService.CLAIM_MS), now, unissued: false, openOnly: true
      });
      if (!minha) continue;
      const provider = providerFor(linha.provider);
      try {
        if (typeof provider?.cancelCharge !== 'function') {
          throw new Error(`provider ${linha.provider} cannot cancel charges`);
        }
        // eslint-disable-next-line no-await-in-loop
        await provider.cancelCharge(linha.gateway_charge_id);
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(linha.id, {
          last_error: String(error.message ?? '').slice(0, 500),
          next_attempt_at: new Date(now.getTime() + ChargeIssuingService.RETRY_AFTER_MS),
          issuing_until: null
        });
        console.warn(
          `Card charge ${linha.id} of provider ${linha.tenant_id} could not be canceled at the gateway `
          + `to be reissued without the card; it stays open (it may have been captured): ${error.message}`
        );
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const reaberta = await BillingCharge.resetForReissue(linha.id, {
        amountCents: Number(linha.amount_cents), currency: linha.currency
      });
      if (!reaberta) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.release(linha.id);
        continue;
      }
      if (linha.amount_overridden_at) {
        // eslint-disable-next-line no-await-in-loop
        await BillingCharge.update(linha.id, { amount_overridden_at: linha.amount_overridden_at });
      }
      if (isProration(linha)) prorratas.push(linha.id);
      reemitidas += 1;
    }
    if (!reemitidas) return { reissued: 0 };
    const resultado = { reissued: reemitidas };
    if (reemitidas > prorratas.length) {
      try {
        resultado.reissue = await ChargeIssuingService.issueCurrent({ tenant, manual: true, now });
      } catch (error) {
        console.error(`Reissue without the card failed for provider ${subscription.tenant_id}: ${error.message}`);
        resultado.reissue = { issued: false, reason: 'error', error: error.message };
      }
    }
    if (prorratas.length) {
      resultado.prorations = [];
      for (const chargeId of prorratas) {
        try {
          // eslint-disable-next-line no-await-in-loop -- uma ou duas por provedor
          resultado.prorations.push(await ChargeIssuingService.retryProrations({ tenant, manual: true, now, chargeId }));
        } catch (error) {
          console.error(`Proration ${chargeId} reissue without the card failed for provider ${subscription.tenant_id}: ${error.message}`);
          resultado.prorations.push({ retried: 0, issued: 0, error: error.message });
        }
      }
    }
    return resultado;
  }

  /**
   * O aviso da recusa, uma vez por recusa: a memória é
   * `card_failure_notified_at`, tomada ANTES do envio por um `UPDATE`
   * condicional (quem perde a corrida não manda) e devolvida quando o envio
   * falha, para a próxima passada tentar de novo. Sem destinatário nenhum,
   * fica marcada: não há a quem dizer, e insistir a cada minuto não muda isso.
   */
  static async notifyRefusal({ tenant = null, now = new Date(), charge = null } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription?.card_failed_at || subscription.card_failure_notified_at) {
      return { sent: false, reason: 'nothing_due' };
    }
    const garra = await tdb('subscriptions').whereNotNull('card_failed_at').whereNull('card_failure_notified_at')
      .update({ card_failure_notified_at: aoSegundo(now), updated_at: new Date() });
    if (!garra) return { sent: false, reason: 'already_sent' };

    // O alerta para quem opera a plataforma (0112): uma vez por recusa — a
    // data dela é a chave. Melhor esforço, nunca lança.
    const { default: PlatformAlertService } = await import('../platformAlertService.js');
    await PlatformAlertService.enqueue('card_refused', {
      tenantId,
      dedupeKey: `${tenantId}:${new Date(subscription.card_failed_at).getTime() || String(subscription.card_failed_at)}`,
      payload: { reason: subscription.card_failure ?? null },
      now
    });

    const { default: SubscriptionNoticeService } = await import('../subscriptionNoticeService.js');
    let resultado;
    try {
      resultado = await SubscriptionNoticeService.notifyCardRefused({ tenant, subscription, now, charge });
    } catch (error) {
      console.warn(`Could not send the card refusal notice to provider ${tenantId}: ${error.message}`);
      resultado = { sent: false, reason: 'send_failed' };
    }
    if (!resultado.sent && resultado.reason === 'send_failed') {
      await tdb('subscriptions').whereNotNull('card_failure_notified_at')
        .update({ card_failure_notified_at: null, updated_at: new Date() });
    }
    return resultado;
  }

  /**
   * Tudo o que o cartão recorrente tem a fazer pelo provedor em escopo, na
   * ordem que importa: o token anotado (pode ser o que tira o cartão da
   * recusa), a reemissão sem cartão (é ela que põe o link novo na fatura) e
   * só então o aviso (que leva esse link). Cada passo isolado, e nunca lança:
   * é chamado pelo agendador e logo depois da resposta de um webhook.
   */
  static async processDue({ tenant = null, now = new Date() } = {}) {
    const resumo = {};
    const passo = async (nome, fn) => {
      try {
        resumo[nome] = await fn();
      } catch (error) {
        console.warn(`Card autopay step ${nome} failed for provider ${currentTenantId()}: ${error.message}`);
        resumo[nome] = { error: error.message };
      }
    };
    await passo('capture', () => this.captureToken({ now }));
    await passo('reissue', () => this.reissueIneligible({ tenant, now }));
    await passo('notice', () => this.notifyRefusal({ tenant, now }));
    return resumo;
  }
}

export default CardAutopayService;
