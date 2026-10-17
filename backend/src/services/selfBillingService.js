import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Coupon from '../models/Coupon.js';
import BillingCharge, { OPEN_CHARGE_STATUSES, isoDateOf } from '../models/BillingCharge.js';
import Tenant from '../models/Tenant.js';
import SubscriptionService, {
  isBillableStatus, annualAvailable, parseBillingCycle, isCancelScheduled, isPauseScheduled
} from './subscriptionService.js';
import ChargeIssuingService from './chargeIssuingService.js';
import { providerFor } from './billing/registry.js';
import { asaasBilling } from './billing/asaasBillingProvider.js';
import { AsaasCustomerError, ensureAsaasCustomer } from './billing/asaasCustomerService.js';
import { TranslatableError } from '../i18n/index.js';
import { currentTenantId } from '../config/tenantContext.js';
import CardAutopayService from './billing/cardAutopayService.js';

/**
 * O provedor cuidando da própria conta: ver os planos, trocar de plano e
 * pedir a cobrança agora.
 *
 * Até aqui as três coisas eram do console. O provedor via o plano e o estado
 * (`GET /api/tenant/subscription`), mas para trocar de plano ou para ter uma
 * cobrança antes da janela de emissão precisava abrir um chamado — e quem
 * estava bloqueado por fatura atrasada, sem cobrança emitida (o cadastro no
 * gateway nunca foi feito, a emissão desistiu), não tinha como pagar sozinho.
 *
 * ## As decisões comerciais, e onde cada uma mora
 *
 *   - SUBIR vale NA HORA; DESCER, com um período pago correndo, vale na
 *     RENOVAÇÃO (ver `changePlan`). A próxima cobrança sai pelo preço do
 *     plano que o período seguinte vai ter.
 *   - A SUBIDA com um período pago correndo (`active`, `renews_at` no futuro)
 *     cobra na hora a diferença do que falta dele (0101): uma fatura avulsa
 *     (`kind = 'proration'`) de
 *     ⌈(preço efetivo novo − antigo) × segundos restantes ÷ segundos do período⌉
 *     centavos, com o cupom nos dois preços, vencendo em três dias
 *     (`SubscriptionService.prorationQuote`, `ChargeIssuingService.createProration`).
 *     A conta não precisa ser feita de cabeça: a tela a mostra antes do
 *     clique ("você vai pagar R$ X agora"), pela mesma função. Abaixo de
 *     R$ 5,00 não sai fatura — o extrato registra o porquê. A fatura sai
 *     DEPOIS de a troca estar gravada, e a falha do gateway não desfaz a
 *     troca: a linha fica para o agendador retomar. Paga, ela não move o
 *     prazo nem gasta ciclo de cupom; vencida, deixa o provedor `past_due`
 *     (`proration_overdue`). Descer, ou desistir de uma descida agendada,
 *     não cobra nada.
 *   - A cobrança do período que ainda está em aberto é do preço velho. Ela é
 *     CANCELADA no gateway e reemitida com o preço novo — duas faturas do
 *     mesmo mês na mão de quem paga é o erro que este serviço mais precisa não
 *     cometer. Se o cancelamento falha, o plano NÃO muda: melhor um "tente de
 *     novo" do que uma fatura velha viva ao lado de um plano novo.
 *   - Quem pode: `owner` e `admin`, pela capacidade `settings.write` que já
 *     existe — trocar de plano é configuração da conta, e quem configura a
 *     conta é quem já decide o cadastro fiscal que vai na fatura.
 *
 * ## O que o corpo NUNCA traz
 *
 * O gateway e o id do cliente dele. O "pagar agora" liga o provedor ao Asaas
 * quando ainda não está ligado, e liga com o cadastro fiscal DA LINHA e o id
 * que o GATEWAY devolveu — ver `asaasCustomerService`. Um provedor não diz de
 * quem é o dinheiro que entra.
 */

/** Os estados em que a assinatura ainda é do provedor para mexer. */
const ESTADOS_VIVOS = new Set(['trial', 'active', 'past_due']);

/**
 * Uma recusa com o código que a tela lê, o status HTTP e, às vezes, números.
 *
 * `TranslatableError` porque a mensagem é de quem pediu, no idioma dele, e só
 * o controlador tem o `req.t`. `extra` são os campos que vão no TOPO do corpo
 * do erro — o mesmo desenho do 402 de limite de plano e do 409 de pagamento a
 * menos: o cliente de API encaminha campo nomeado, não um `data` inteiro.
 */
export class SelfBillingError extends TranslatableError {
  constructor(key, { code, status, vars = null, extra = null, detail = null } = {}) {
    super(key, vars, { code, status });
    this.name = 'SelfBillingError';
    this.extra = extra;
    this.detail = detail;
  }
}

const MENSAGEM_DO_EXCESSO = Object.freeze({
  operators: 'subscription.overLimitOperators',
  subscribers: 'subscription.overLimitSubscribers',
  devices: 'subscription.overLimitDevices'
});

/**
 * Se o plano custa alguma coisa. Plano de graça nunca é destino de uma troca
 * feita por dentro — ver `listPlans`.
 */
const ehPago = (plano) => Number(plano?.price_cents ?? 0) > 0;

/** Quanto dura a garra da troca de plano sobre a cobrança do período. */
const GARRA_DA_TROCA_MS = 2 * 60 * 1000;

const ocupado = () => new SelfBillingError('billing.busy', { code: 'busy', status: 409 });

function presentPlan(plan, currentId, proration = null) {
  const anual = annualAvailable(plan);
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    // O preço e o prazo do ciclo MENSAL — os dois ciclos vão juntos (0104),
    // e é a tela que escolhe qual mostrar pelo seletor Mensal/Anual.
    priceCents: SubscriptionService.cyclePriceCents({ billing_cycle: 'monthly' }, plan),
    currency: plan.currency || 'BRL',
    periodDays: SubscriptionService.cyclePeriodDays({ billing_cycle: 'monthly' }, plan),
    // O ciclo anual (0104): o preço cobrado por ano, ou nulo quando o plano
    // não oferece o anual; e quanto ele economiza sobre doze meses.
    priceYearlyCents: anual ? SubscriptionService.cyclePriceCents({ billing_cycle: 'annual' }, plan) : null,
    annualAvailable: anual,
    annualSavingsPercent: SubscriptionService.annualSavingsPercent(plan),
    limits: SubscriptionService.limitsOf(plan),
    // O preço por unidade acima do teto (0105); nulo é "o teto barra".
    overagePriceCents: SubscriptionService.overagePricesOf(plan),
    current: currentId !== null && Number(plan.id) === Number(currentId),
    // O que subir para este plano cobraria AGORA (0101), pela mesma conta da
    // troca — ou nulo, quando a troca não cobraria nada (não é subida, não há
    // período pago correndo, ou fica abaixo do mínimo: `skipped`).
    proration: proration
  };
}

/** A prévia da pró-rata que a lista de planos mostra — ver `presentPlan`. */
function previaDaProrata(quote) {
  if (!quote?.eligible) return null;
  return {
    amountCents: quote.skipped ? 0 : quote.amountCents,
    remainingDays: quote.remainingDays,
    currency: quote.currency,
    ...(quote.skipped ? { skipped: quote.skipped } : {})
  };
}

/**
 * A cobrança em aberto do período corrente, ou nada.
 *
 * O período é o mesmo que a emissão calcula — o prazo vivo, no fuso da
 * cobrança —, e é por ele que se procura, e não pela "mais recente em
 * aberto": uma cobrança de um período que já passou é da faxina da emissão
 * (`cancelStale`), e reemiti-la com o preço novo seria cobrar de novo um mês
 * que o provedor já acertou por fora. Sem prazo nenhum, a mais recente em
 * aberto é a única candidata, e é a mesma que o "pagar agora" acharia.
 */
async function cobrancaEmAberto(subscription) {
  const prazo = subscription.renews_at ?? subscription.trial_ends_at;
  if (!prazo) return BillingCharge.currentOpen();
  const quando = new Date(prazo);
  if (Number.isNaN(quando.getTime())) return null;
  const linha = await BillingCharge.forPeriod(ChargeIssuingService.periodKey(quando));
  return linha && OPEN_CHARGE_STATUSES.includes(linha.status) ? linha : null;
}

/**
 * Põe a cobrança em aberto do prazo vivo no preço de `plano`: cancela no
 * gateway a que saiu com o preço velho e deixa a linha pronta para reemitir.
 *
 * Devolve `'reissued'` quando mexeu e `'none'` quando não havia o que mexer
 * (sem cobrança, ou já no preço). Lança `SelfBillingError` quando não
 * consegue — e aí NADA mudou no plano, porque quem chama só troca o plano
 * depois desta função voltar: uma fatura velha viva ao lado de um plano novo
 * é o provedor pagando o preço errado pelo link que já tem no e-mail.
 *
 * É a mesma porta para as três situações que mudam o preço de um prazo — a
 * subida, a descida agendada e a desistência dela —, porque as três fazem a
 * mesma coisa com a mesma linha, e três cópias desta dança com o gateway
 * seriam três lugares para uma delas esquecer a garra.
 */
async function reprecificarCobranca(subscription, plano, { keepOverride = false } = {}) {
  const nada = { acao: 'none', linhaId: null };
  // Isento de cobrança: a troca de plano continua valendo, mas não há fatura
  // a reprecificar — e mexer numa que ficou em aberto porque o gateway recusou
  // o cancelamento a deixaria sem id e sem reemissão (`issueCurrent` para no
  // `billing_exempt`). Ela fica como está, visível no console.
  if (subscription?.billing_exempt_at) return nada;
  // O preço com o cupom de `subscription` (0093) — que, na aplicação de um
  // cupom, é o estado DEPOIS dela, ainda não gravado.
  const cupom = subscription?.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
  const precoDoPlano = SubscriptionService.priceFor(subscription, plano, cupom);
  // Com que plano e cupom o preço novo sai — gravados na linha (0093).
  const precificacao = SubscriptionService.chargePricing(subscription, plano, cupom);
  const moeda = String(plano?.currency || 'BRL').toUpperCase();
  // Um plano sem preço não tem cobrança a reemitir: a do prazo fica como está,
  // e a faxina da emissão cuida dela. Não acontece pela tela (plano de graça
  // não é destino de troca), mas o plano atual de quem desiste de uma descida
  // pode ser um que o console deixou sem preço.
  if (!(precoDoPlano > 0)) return nada;
  const aberta = await cobrancaEmAberto(subscription);
  // O excedente congelado na linha (0105) vai junto, e por cima do preço do
  // plano: trocar de plano ou de cupom muda o preço, não o uso do período que
  // fecha — e reemitir não pode recontá-lo (ver
  // `ChargeIssuingService.overageForPeriod`). A conta guarda as outras chaves
  // que tiver (o crédito).
  const preco = precoDoPlano + BillingCharge.overageCentsOf(aberta);
  const conta = aberta ? BillingCharge.mergePricingDetail(aberta, { base: precoDoPlano }) : null;
  // O valor mudado à mão pelo console (0078) vence o cupom: quem aplica ou
  // tira um cupom não desfaz o desconto que alguém deu a dedo àquela fatura.
  // (A troca de plano não passa isto: um plano novo é outra fatura.)
  if (keepOverride && aberta?.amount_overridden_at) return nada;
  if (!aberta) return nada;
  // Pelo preço antes do crédito reservado (0106): o abatido não é outro preço.
  if (BillingCharge.baseAmountOf(aberta) === preco && String(aberta.currency || '').toUpperCase() === moeda) {
    // Mesmo valor, nada a reemitir — mas a linha passa a dizer o plano e o
    // cupom de agora (dois planos no mesmo preço, o cupom no piso), que é o
    // que o pagamento dela vai ler. A de valor mudado à mão fica como está.
    if (!aberta.amount_overridden_at && (Number(aberta.plan_id ?? 0) !== Number(precificacao.planId ?? 0)
      || Number(aberta.coupon_id ?? 0) !== Number(precificacao.couponId ?? 0)
      || (aberta.billing_cycle ?? null) !== (precificacao.billingCycle ?? null))) {
      await BillingCharge.update(aberta.id, {
        plan_id: precificacao.planId, coupon_id: precificacao.couponId, billing_cycle: precificacao.billingCycle
      });
    }
    return nada;
  }

  // A garra antes de tudo, inclusive antes do gateway: é ela que impede
  // duas trocas simultâneas (dois administradores, dois cliques) de
  // cancelarem e reemitirem a mesma linha cada uma — e o agendador ou um
  // "pagar agora" de emitirem por ela no meio da troca. Quem não a
  // consegue ouve "tente de novo em instantes", que é a verdade: alguém
  // está mexendo nesta cobrança agora.
  const agora = new Date();
  const garraAte = new Date(agora.getTime() + GARRA_DA_TROCA_MS);
  const minha = await BillingCharge.claim(aberta.id, { until: garraAte, now: agora, unissued: false });
  if (!minha) throw ocupado();

  // Relida DEPOIS da garra: a leitura de cima pode ser de antes de outra
  // troca terminar, e decidir por ela cancelaria de novo um id que já não
  // é o da linha. Se a outra troca já deixou a linha no preço novo (ou a
  // cobrança fechou no meio), não há o que fazer aqui.
  const linha = await BillingCharge.findById(aberta.id);
  const jaNoPreco = linha && BillingCharge.baseAmountOf(linha) === preco
    && String(linha.currency || '').toUpperCase() === moeda;
  if (!linha || jaNoPreco || !OPEN_CHARGE_STATUSES.includes(linha.status)
    || (keepOverride && linha.amount_overridden_at)) {
    if (linha) await BillingCharge.release(linha.id);
    return nada;
  }

  if (linha.gateway_charge_id) {
    // A do gateway sai ANTES de o plano mudar, e a falha dela para tudo.
    const provider = providerFor(linha.provider);
    let motivo = null;
    if (!provider || typeof provider.cancelCharge !== 'function') {
      motivo = `provider ${linha.provider} cannot cancel charges`;
    } else {
      try {
        await provider.cancelCharge(linha.gateway_charge_id);
      } catch (error) {
        motivo = error.message;
      }
    }
    if (motivo !== null) {
      await BillingCharge.release(linha.id);
      throw new SelfBillingError('subscription.chargeCancelFailed', {
        code: 'gateway_failed', status: 502, vars: { detail: motivo }, detail: motivo
      });
    }
  }
  // Condicional (ver `resetForReissue`): se a linha mudou de id no
  // gateway entre a leitura e aqui, alguém a emitiu no meio, e
  // reescrevê-la apagaria uma cobrança viva. A velha já foi cancelada
  // lá; a nova, de quem emitiu, fica — e o provedor tenta a troca de novo.
  //
  // A garra CONTINUA com quem chamou (`holdUntil`): o plano novo (ou a
  // descida agendada) ainda vai ser gravado, e uma linha sem id e sem dono
  // entre as duas escritas seria emitida pelo agendador ou por um "pagar
  // agora" com o preço que o estado velho ainda diz. Quem chama a solta em
  // `reemitir` — ou em `soltar`, se a gravação falhar.
  if (!(await BillingCharge.resetForReissue(linha.id, {
    amountCents: preco, currency: moeda, holdUntil: garraAte, ...precificacao, pricingDetail: conta
  }))) {
    await BillingCharge.release(linha.id);
    throw ocupado();
  }
  return { acao: 'reissued', linhaId: linha.id };
}

/**
 * Se a descida agendada já foi paga pelo preço dela — e portanto não se
 * desfaz (0075).
 *
 * A marca na assinatura é a resposta (`pending_plan_locked_at`, gravada por
 * `recordPayment`). A cobrança do período da descida PAGA por menos que o
 * preço do plano atual é a segunda leitura, para o caso em que o pagamento
 * entrou por um caminho que não passou por lá — e, achada, vira marca.
 */
async function descidaTravada(subscription, atual) {
  if (!subscription?.pending_plan_id) return false;
  if (SubscriptionService.isPendingLocked(subscription)) return true;
  const quando = subscription.pending_plan_at ? new Date(subscription.pending_plan_at) : null;
  if (!quando || Number.isNaN(quando.getTime())) return false;
  const linha = await BillingCharge.forPeriod(ChargeIssuingService.periodKey(quando));
  // Pelo plano gravado na cobrança (0093), ou, sem ele, pelo valor — ver
  // `SubscriptionService.paidScheduledPlan`: com o cupom, "menos que o preço
  // do atual" pode nunca acontecer (os dois no piso) ou acontecer pagando o
  // atual (cupom só nele). A de valor mudado à mão só responde pelo plano.
  let pagaBarato = false;
  if (linha?.status === 'paid') {
    const agendado = await Plan.findById(subscription.pending_plan_id);
    const cupom = subscription.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    pagaBarato = SubscriptionService.paidScheduledPlan({
      planId: linha.plan_id ?? null,
      billingCycle: linha.billing_cycle ?? null,
      cents: linha.amount_overridden_at ? null : BillingCharge.baseAmountOf(linha),
      subscription,
      current: atual,
      scheduled: agendado,
      coupon: cupom
    }) === true;
  }
  if (pagaBarato) {
    await Subscription.upsertForTenant(subscription.tenant_id, { pending_plan_locked_at: new Date() });
    SubscriptionService.invalidate(subscription.tenant_id);
  }
  return pagaBarato;
}

/**
 * O plano que a fatura do prazo vivo cobra — a mesma escolha de
 * `ChargeIssuingService.issueCurrent`: o atual, ou o da descida agendada para
 * exatamente este prazo quando ela está travada ou o uso cabe nela.
 * `bloqueio` é o veredito do uso, para a reemissão não recontar.
 */
async function planoDaFatura(subscription, { countDevices = null } = {}) {
  const atual = subscription?.plan_id ? await Plan.findById(subscription.plan_id) : null;
  // `assinatura` é a do ciclo que a fatura cobra (0104): a de agora, ou a
  // vista pelo ciclo agendado quando a fatura é a da troca agendada.
  const doAtual = { plano: atual, assinatura: subscription, bloqueio: undefined };
  const prazo = subscription?.renews_at ?? subscription?.trial_ends_at;
  if (!subscription?.pending_plan_id || !subscription?.pending_plan_at || !prazo) return doAtual;
  const agendada = new Date(subscription.pending_plan_at);
  const vivo = new Date(prazo);
  if (Number.isNaN(agendada.getTime()) || Number.isNaN(vivo.getTime())
    || ChargeIssuingService.periodKey(agendada) !== ChargeIssuingService.periodKey(vivo)) {
    return doAtual;
  }
  const agendado = await Plan.findById(subscription.pending_plan_id);
  const agendadaView = SubscriptionService.scheduledView(subscription);
  if (!agendado || !(SubscriptionService.cyclePriceCents(agendadaView, agendado) > 0)) return doAtual;
  const bloqueio = await SubscriptionService.scheduledOverLimit(subscription, agendado, { countDevices });
  return bloqueio
    ? { plano: atual, assinatura: subscription, bloqueio }
    : { plano: agendado, assinatura: agendadaView, bloqueio };
}

/** Solta a garra que `reprecificarCobranca` deixou segura, se deixou. */
async function soltar(cobranca) {
  if (cobranca?.linhaId) await BillingCharge.release(cobranca.linhaId);
}

/**
 * Grava o estado novo (`escrever`) com a cobrança reprecificada ainda segura,
 * e a solta se a gravação falhar — sem isso a linha ficaria sem dono e sem
 * id por dois minutos, até a garra vencer.
 */
async function gravarSegurando(cobranca, escrever) {
  try {
    return await escrever();
  } catch (error) {
    await soltar(cobranca);
    throw error;
  }
}

/**
 * A reemissão, logo depois de o plano (ou o agendamento) estar gravado, pela
 * porta de sempre — é o estado novo que a emissão lê para decidir o preço.
 *
 * Melhor esforço: se o gateway falhar aqui, a troca já aconteceu e está
 * certa, e a linha fica `failed` com a espera de sempre, que o agendador ou o
 * "pagar agora" retomam. O que não pode é a falha da reemissão desfazer a
 * troca.
 */
async function reemitir(cobranca, tenant, { countDevices = null, pendingBlockedBy = undefined } = {}) {
  if (cobranca?.acao !== 'reissued') return undefined;
  try {
    // A garra sai logo antes da emissão, que a toma de novo: o estado novo já
    // está gravado, então quem pegar a linha no meio emite pelo preço certo.
    await soltar(cobranca);
    // Com o veredito que quem chamou JÁ usou para escolher o preço
    // (`pendingBlockedBy`), ou a contagem de ONTs dele: reemitir sem nenhum
    // dos dois seria chamar de "cabe" um bloqueio por ONTs — e a passada
    // seguinte reprecificaria de volta, uma fatura nova por minuto.
    return await ChargeIssuingService.issueCurrent({ tenant, manual: true, countDevices, pendingBlockedBy });
  } catch (error) {
    console.error(`Reissue after self-service plan change failed for provider ${tenant.id}:`, error.message);
    return { issued: false, reason: 'error', error: error.message };
  }
}

/**
 * A fatura de pró-rata de uma subida já gravada — melhor esforço, como a
 * reemissão: o que der errado aqui fica na linha (`failed`, para o agendador)
 * ou no log, e a troca continua feita.
 *
 * @returns {Promise<{ amountCents: number, remainingDays: number, issued: boolean,
 *   reason?: string, skipped?: string, charge?: object|null }>}
 */
async function cobrarProrata(tenant, subscription, plan, quote, cupom, now) {
  const resumo = { amountCents: quote.amountCents, remainingDays: quote.remainingDays, currency: quote.currency };
  if (quote.skipped) return { ...resumo, issued: false, skipped: quote.skipped };
  try {
    const resultado = await ChargeIssuingService.createProration({
      tenant,
      subscription,
      quote,
      couponId: SubscriptionService.chargePricing(subscription, plan, cupom).couponId,
      now
    });
    return {
      ...resumo,
      issued: Boolean(resultado.issued),
      ...(resultado.issued ? {} : { reason: resultado.reason }),
      charge: resultado.charge ? BillingCharge.present(resultado.charge) : null
    };
  } catch (error) {
    console.error(`Proration charge after the upgrade of provider ${tenant.id} failed:`, error.message);
    return { ...resumo, issued: false, reason: 'error' };
  }
}

class SelfBillingService {
  /**
   * Os planos que o provedor pode escolher, com o preço — e o dele, sempre.
   *
   * Os ativos, que são o catálogo à venda, mais o plano atual MESMO inativo:
   * a tela precisa mostrar "você está aqui" a quem ficou num plano que saiu de
   * linha, e sumir com ele da lista faria parecer que o provedor não tem plano.
   * Voltar a ele depois de sair, porém, não se pode — é o que `inativo` quer
   * dizer, e `changePlan` recusa.
   *
   * Os de graça ficam de fora, pela mesma regra de `changePlan`: não são
   * escolha do provedor. O `unlimited` que a migração 0035 semeia (preço
   * zero, sem limite nenhum, ativo) é o plano dos provedores herdados, e
   * oferecê-lo aqui seria um botão "pare de pagar" ao lado do preço. Quem já
   * está num deles o vê marcado como o seu, e só.
   */
  static async listPlans({ now = new Date() } = {}) {
    const subscription = await Subscription.forTenant(currentTenantId());
    const atual = subscription?.plan_id ?? null;
    // A prévia da pró-rata (0101): o plano e o cupom de agora, lidos uma vez.
    const planoAtual = atual ? await Plan.findById(atual) : null;
    const cupom = subscription?.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    const planos = (await Plan.list({ activeOnly: true }))
      .filter((plano) => ehPago(plano) || Number(plano.id) === Number(atual));
    if (atual && !planos.some((plano) => Number(plano.id) === Number(atual))) {
      const dele = await Plan.findById(atual);
      if (dele) {
        planos.push(dele);
        planos.sort((a, b) => Number(a.id) - Number(b.id));
      }
    }
    // A prévia da pró-rata é do MESMO ciclo (0104): no anual, o plano sem
    // preço anual não é destino na hora — trocar para ele é trocar de ciclo.
    const cicloAtual = SubscriptionService.cycleOf(subscription, planoAtual);
    return planos.map((plano) => presentPlan(plano, atual, Number(plano.id) === Number(atual)
      || SubscriptionService.cycleOf(subscription, plano) !== cicloAtual
      ? null
      : previaDaProrata(SubscriptionService.prorationQuote(subscription, planoAtual, plano, cupom, now))));
  }

  /**
   * Troca o plano do provedor em escopo, a pedido dele.
   *
   * ## Subir vale na hora; descer, na renovação
   *
   * A regra antiga — toda troca na hora — tinha um buraco que a revisão
   * achou: subir para o plano caro logo depois de pagar, usar os tetos
   * maiores e descer de volta antes de a próxima cobrança sair. O plano caro
   * nunca era pago. Então:
   *
   *   - **Subir** (preço novo maior que o atual) vale na hora, como sempre:
   *     o provedor ganha os tetos agora, e a próxima cobrança já sai pelo
   *     preço novo. Preço IGUAL também vale na hora — não há diferença a
   *     ganhar esperando, e chamar isso de descida só confundiria a tela.
   *   - **Descer** com um período pago correndo (`active`, `renews_at` no
   *     futuro) fica AGENDADO para a renovação: o plano e os tetos continuam
   *     os de agora até lá, e a cobrança daquele prazo — que paga o período
   *     seguinte — sai com o preço novo. O uso não é conferido agora: o
   *     provedor tem até a renovação para caber, e quem confere é a aplicação
   *     (`SubscriptionService.applyPendingPlan`), que não troca enquanto não
   *     couber.
   *   - **Descer** sem período pago correndo (teste, atraso, assinatura sem
   *     data) vale na hora: não há mês pago de plano caro a proteger, e fazer
   *     quem está em atraso esperar uma renovação que não vem seria prendê-lo
   *     no preço que ele justamente não consegue pagar.
   *   - Escolher o plano ATUAL com uma descida agendada é desistir dela.
   *     Escolher outro mais barato substitui a agendada.
   *
   * A ordem é a das recusas baratas primeiro e da única coisa irreversível por
   * último: plano, estado, uso — tudo leitura —, e só então o gateway, porque
   * uma cobrança cancelada lá não volta.
   *
   * ## O ciclo (0104)
   *
   * `cycle` é `monthly` ou `annual`; sem ele, o de agora. Trocar de CICLO
   * com um período pago correndo é sempre agendado para a renovação — do
   * mensal para o anual, o mês já pago vale até o fim (sem pró-rata, sem dia
   * de graça) e a fatura daquele prazo sai pelo preço do ano; do anual para o
   * mensal, como uma descida. Subida ou descida, no mesmo ciclo, é decidida
   * pelo preço POR DIA (`dailyPriceOf`). Plano sem preço anual não é anual
   * (409 `cycle_unavailable`).
   *
   * @returns {Promise<{ changed: boolean, scheduled: boolean, pendingCanceled: boolean,
   *   effectiveAt: Date|null, from: number|null, to: number, plan: object,
   *   charge: 'none'|'reissued', reissue?: object, billingCycle: string }>}
   */
  static async changePlan({ planId, cycle = null, actorUserId = null, countDevices = null, now = new Date() }) {
    const tenantId = currentTenantId();
    const id = Number(planId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SelfBillingError('subscription.planNotFound', { code: 'plan_not_found', status: 404 });
    }
    const cicloPedido = cycle === null || cycle === undefined || cycle === '' ? null : parseBillingCycle(cycle);
    if (cycle !== null && cycle !== undefined && cycle !== '' && !cicloPedido) {
      throw new SelfBillingError('subscription.invalidCycle', { code: 'invalid_cycle', status: 400 });
    }

    // A caixa da plataforma não tem plano que se troque: ela não é cliente.
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }

    // Lida agora, sem o cache: o estado que autoriza a troca não pode ser o de
    // quinze segundos atrás, quando o console pode ter acabado de suspender.
    const subscription = await Subscription.forTenant(tenantId);
    // `suspended` e `canceled` são decisões de gente, e a saída delas é
    // gente também — o console. Trocar de plano por dentro não pode ser o
    // jeito de um provedor suspenso se reativar num plano mais barato.
    if (!subscription || !ESTADOS_VIVOS.has(subscription.status)) {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }
    // A retenção (0107): com o cancelamento agendado não há renovação a
    // reprecificar nem subida a cobrar — quem quer outro plano desfaz o
    // agendamento antes. Na pausa, a mesma coisa: a saída dela é pagar.
    if (isCancelScheduled(subscription)) {
      throw new SelfBillingError('cancellation.planChangeScheduled', { code: 'cancel_scheduled', status: 409 });
    }
    if (isPauseScheduled(subscription)) {
      throw new SelfBillingError('cancellation.planChangePaused', { code: 'subscription_paused', status: 409 });
    }

    const de = subscription.plan_id ?? null;
    const atual = de ? await Plan.findById(de) : null;
    const agendadoId = subscription.pending_plan_id ? Number(subscription.pending_plan_id) : null;
    // Os ciclos (0104): o que vale agora, o pedido (ou o de agora) e o da
    // troca agendada (nulo na coluna é "o mesmo de agora").
    const cicloAtual = SubscriptionService.cycleOf(subscription, atual);
    const ciclo = cicloPedido ?? cicloAtual;
    const cicloAgendado = parseBillingCycle(subscription.pending_billing_cycle) ?? cicloAtual;
    const mesmaAgendada = agendadoId === id && cicloAgendado === ciclo;
    const base = {
      from: de,
      to: id,
      scheduled: false,
      pendingCanceled: false,
      effectiveAt: null,
      charge: 'none',
      billingCycle: ciclo,
      ...(ciclo !== cicloAtual ? { cycleFrom: cicloAtual } : {})
    };

    // A descida já PAGA pelo preço dela não se desfaz (0075): nem desistir,
    // nem trocar por outra, nem subir antes da data. Pagar o barato adiantado
    // e depois ficar no caro — por desistência, ou subindo "de volta" — era o
    // mês de plano caro pelo preço do barato. Pedir a própria descida de novo
    // é o único clique que passa, porque não muda nada. Depois da data ela se
    // aplica, e a trava some com ela.
    if (agendadoId && await descidaTravada(subscription, atual)) {
      if (mesmaAgendada) {
        const plan = await Plan.findById(id);
        const quando = subscription.pending_plan_at ? new Date(subscription.pending_plan_at) : null;
        return { ...base, changed: false, scheduled: true, effectiveAt: quando, plan };
      }
      throw new SelfBillingError('subscription.pendingLocked', {
        code: 'pending_locked',
        status: 409,
        vars: { date: subscription.pending_plan_at ? ChargeIssuingService.isoDate(subscription.pending_plan_at) : '' },
        extra: {
          pendingPlanId: agendadoId,
          effectiveAt: subscription.pending_plan_at ? new Date(subscription.pending_plan_at).toISOString() : null
        }
      });
    }

    // O mesmo plano é um clique a mais, não um erro — e não uma linha no
    // extrato dizendo que algo mudou. Vale até para o plano atual inativo: é
    // "ficar onde está", e isso nunca foi proibido.
    //
    // Com uma descida agendada, "ficar onde está" é justamente desistir dela:
    // a cobrança da renovação, se já saiu com o preço menor, volta ao preço
    // do plano atual pela mesma porta da troca — cancelada lá e reemitida.
    if (Number(de) === id && ciclo === cicloAtual) {
      if (!agendadoId) return { ...base, changed: false, plan: atual };
      const cobranca = await reprecificarCobranca(subscription, atual);
      await gravarSegurando(cobranca, () => SubscriptionService.cancelPendingPlan());
      const reissue = await reemitir(cobranca, tenant, { countDevices });
      return {
        ...base, changed: false, pendingCanceled: true, canceledPlanId: agendadoId, plan: atual,
        charge: cobranca.acao, ...(reissue ? { reissue } : {})
      };
    }

    const plan = await Plan.findById(id);
    // Inativo ou de graça, a mesma resposta: não está no catálogo que este
    // provedor pode escolher (`listPlans`), e para quem pede é como se não
    // existisse. Um 403 para o de graça diria "existe, mas não para você", e
    // é uma frase que não precisa ser dita. O plano ATUAL inativo passa: é só
    // a troca de ciclo dele (0104), ficando onde está.
    if (!plan || (!plan.active && Number(de) !== id) || !ehPago(plan)) {
      throw new SelfBillingError('subscription.planNotFound', { code: 'plan_not_found', status: 404 });
    }
    // O anual só existe com o preço anual do plano (0104) — pedido, ou
    // herdado de quem já é anual e escolhe um plano sem ele.
    if (ciclo === 'annual' && !annualAvailable(plan)) {
      throw new SelfBillingError('subscription.cycleUnavailable', {
        code: 'cycle_unavailable', status: 409, extra: { planId: id, cycle: ciclo }
      });
    }
    // A assinatura como vai ficar no ciclo pedido: é por ela que o preço do
    // plano novo se calcula.
    const noCiclo = SubscriptionService.inCycle(subscription, ciclo);
    const mudaCiclo = ciclo !== cicloAtual;

    // Subida, descida agendada ou descida na hora — ver o comentário do método.
    // `renews_at` no futuro é o período pago correndo; o estado gravado
    // `active` com o prazo já vencido é `past_due` de fato (`effectiveStatus`)
    // e cai na descida imediata, como o atraso.
    const renovacao = subscription.renews_at ? new Date(subscription.renews_at) : null;
    const periodoCorrendo = subscription.status === 'active'
      && renovacao && !Number.isNaN(renovacao.getTime()) && renovacao.getTime() > now.getTime();
    // Pelo preço POR DIA (0104): o anual com desconto custa mais na fatura e
    // menos por dia. E trocar de ciclo com o período correndo é sempre na
    // renovação: o período pago é de um ciclo, e o seguinte é do outro.
    const desce = SubscriptionService.dailyPriceOf(noCiclo, plan) < SubscriptionService.dailyPriceOf(subscription, atual);
    const agendar = Boolean(periodoCorrendo && (desce || mudaCiclo));

    // Pedir de novo a descida que já está agendada não muda nada — nem a
    // cobrança, nem a trilha, nem a data. A data sobretudo: depois de um
    // pagamento adiantado `renews_at` já é o mês seguinte, e regravar a
    // agendada com ele adiaria a descida por um clique repetido.
    if (agendar && mesmaAgendada) {
      const jaAgendada = subscription.pending_plan_at ? new Date(subscription.pending_plan_at) : null;
      return { ...base, changed: false, scheduled: true, effectiveAt: jaAgendada ?? renovacao, plan };
    }

    // O uso tem que caber no plano novo — quando ele vale agora. Não é o mesmo
    // que o 402 dos limites, que recusa CRESCER além do teto: aqui o provedor
    // já está lá, e descer para um plano menor que o uso deixaria a conta
    // estourada no minuto seguinte — nada de novo cabe e ninguém entende por
    // quê. A contagem de ONTs pode faltar (o ACS fora do ar); faltando, ela
    // não decide nada, pela mesma regra de `usage`.
    //
    // Na descida agendada, não: o provedor tem até a renovação para se
    // ajustar, e recusar agora obrigaria a apagar operadores HOJE para um
    // plano que só vale daqui a semanas. A tela mostra o bloqueio
    // (`pendingPlan.blockedBy`) enquanto ele existir.
    if (!agendar) {
      const { usage } = await SubscriptionService.usage({ countDevices });
      // O recurso com preço de excedente no plano novo não barra (0105): o
      // uso acima do teto é cobrado na fatura, e não recusado aqui.
      const excesso = SubscriptionService.overLimitFor(
        SubscriptionService.limitsOf(plan), usage, SubscriptionService.overagePricesOf(plan)
      );
      if (excesso) {
        throw new SelfBillingError(MENSAGEM_DO_EXCESSO[excesso.resource], {
          code: 'over_limit',
          status: 409,
          vars: { used: excesso.used, limit: excesso.limit },
          extra: excesso
        });
      }
    }

    // QUANDO a descida vale. Na renovação — a não ser que o plano de agora
    // tenha sido alcançado por uma SUBIDA neste mesmo período pago
    // (`upgraded_at`, 0075). A pró-rata (0101) cobra a diferença do resto do
    // período, mas pode não ter saído (abaixo do mínimo) ou não ter sido
    // paga; a regra continua a mesma: quem paga a subida por inteiro é a
    // cobrança seguinte.
    // Descer já na renovação seria usar o plano de cima o período inteiro sem
    // nunca pagá-lo — então a descida vai para a renovação SEGUINTE, e o
    // próximo período é cobrado pelo preço de cima.
    // Só para a DESCIDA a outro plano: a troca só de ciclo no plano que subiu
    // continua pagando o plano de cima na fatura seguinte (0104).
    let quando = renovacao;
    if (agendar && subscription.upgraded_at && desce && Number(de) !== id) {
      quando = new Date(renovacao.getTime() + SubscriptionService.cyclePeriodDays(subscription, atual) * 86_400_000);
    }
    const adiada = agendar && quando.getTime() !== renovacao.getTime();

    // A cobrança em aberto do prazo vivo passa a pedir o preço do plano que
    // aquele prazo compra. Na subida (e em toda troca na hora), o novo. Na
    // descida agendada para esta renovação, também o novo — essa cobrança
    // paga o período que começa nela —, mas só se o uso couber, pela mesma
    // conta que a emissão faz (`issueCurrent`): se não couber, a descida não
    // vai se aplicar e o período é do atual. E na descida adiada pela subida,
    // o atual: o período que essa cobrança paga ainda é o de cima.
    //
    // O veredito do uso vai junto para a reemissão, em vez de ela recontar:
    // uma contagem de ONTs que muda entre as duas leituras cancelaria a
    // fatura por um preço e a reemitiria por outro.
    let bloqueio;
    let alvo = plan;
    if (agendar) {
      // A troca só de ciclo não confere uso: os tetos são os de agora.
      bloqueio = adiada ? null : await SubscriptionService.scheduledOverLimit(
        { ...subscription, pending_plan_locked_at: null }, plan, { countDevices }
      );
      if (adiada || bloqueio) alvo = atual;
    }
    // No ciclo do período que a cobrança paga: o pedido, quando ela é do
    // plano novo; o de agora, quando continua sendo do atual.
    const cobranca = await reprecificarCobranca(alvo === plan ? noCiclo : subscription, alvo);

    // A marca da subida no meio do período pago: só quando SOBE com o período
    // correndo, e a mais antiga fica (subir duas vezes no mesmo período não
    // apaga a primeira). Preço igual a mantém. Descer na hora a apaga — não há
    // período pago correndo a proteger.
    let upgradedAt = null;
    // A pró-rata da subida (0101), calculada com o estado de ANTES — o plano
    // e o prazo que o provedor pagou — e cobrada só depois de a troca estar
    // gravada. Na descida (agendada ou na hora) não há o que cobrar.
    let prorata = null;
    let cupomDaProrata = null;
    if (!agendar && periodoCorrendo) {
      // Aqui o ciclo é o mesmo (trocar de ciclo agenda): por dia, como a descida.
      const sobe = SubscriptionService.dailyPriceOf(subscription, plan) > SubscriptionService.dailyPriceOf(subscription, atual);
      upgradedAt = subscription.upgraded_at ?? (sobe ? now : null);
      cupomDaProrata = subscription.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
      prorata = SubscriptionService.prorationQuote(subscription, atual, plan, cupomDaProrata, now);
      if (!prorata.eligible) prorata = null;
    }

    // O provedor que não está ligado a um gateway que emita não ganha a fatura
    // de pró-rata (`createProration` para em `not_linked`): o extrato da troca
    // diz isso, para quem procurar por que a diferença não foi cobrada.
    let prorataNaoCobrada = null;
    if (prorata && !prorata.skipped) {
      const gatewayDoProvedor = providerFor(tenant.billing_gateway);
      if (!gatewayDoProvedor || !tenant.billing_customer_ref) prorataNaoCobrada = 'not_linked';
      else if (!gatewayDoProvedor.canIssue) prorataNaoCobrada = 'provider_cannot_issue';
    }

    await gravarSegurando(cobranca, () => (agendar
      ? SubscriptionService.schedulePlanChange({ planId: plan.id, at: quando, billingCycle: mudaCiclo ? ciclo : null })
      : SubscriptionService.changePlan({
        planId: plan.id,
        billingCycle: ciclo,
        actorUserId,
        upgradedAt,
        eventDetail: prorata ? {
          proration: {
            amountCents: prorata.amountCents,
            remainingDays: prorata.remainingDays,
            fromPriceCents: prorata.fromPriceCents,
            toPriceCents: prorata.toPriceCents,
            ...(prorata.skipped ? { skipped: prorata.skipped } : {}),
            ...(prorataNaoCobrada ? { notCharged: prorataNaoCobrada } : {})
          }
        } : null
      })));

    const reissue = await reemitir(cobranca, tenant, { countDevices, pendingBlockedBy: bloqueio });
    const proration = prorata ? await cobrarProrata(tenant, subscription, plan, prorata, cupomDaProrata, now) : null;
    return {
      ...base,
      changed: true,
      scheduled: agendar,
      effectiveAt: agendar ? quando : null,
      ...(adiada ? { deferredByUpgrade: true } : {}),
      ...(agendadoId && agendadoId !== id ? { replacedPlanId: agendadoId } : {}),
      plan,
      charge: cobranca.acao,
      ...(reissue ? { reissue } : {}),
      ...(proration ? { proration } : {})
    };
  }

  /**
   * "Pagar agora": a cobrança em aberto do período — a que já existe ou uma
   * emitida agora.
   *
   * @returns {Promise<{ charge: object, issued: boolean, customerCreated: boolean }>}
   *   `charge` é a LINHA; quem apresenta é o controlador, por
   *   `BillingCharge.present`, a mesma leitura de `/charges`.
   */
  static async payNow({ countDevices = null } = {}) {
    const tenantId = currentTenantId();
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') {
      throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }

    // As recusas comerciais antes de qualquer coisa que fale com o gateway —
    // e, sobretudo, antes de criar um cliente lá: abrir um cadastro no Asaas
    // para quem está num plano de graça é deixar um cliente sem cobrança
    // nenhuma na conta da plataforma, para sempre.
    const subscription = await Subscription.forTenant(tenantId);
    // A suspensão AUTOMÁTICA por inadimplência (0102) paga também: é por aqui
    // que se sai dela. A à mão continua recusada.
    if (!subscription || !isBillableStatus(subscription)) {
      throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }
    // Isento de cobrança pelo console: não há fatura a pagar, e o clique não
    // pode abrir uma — nem criar cliente no gateway para ela. Código próprio,
    // e não `not_billable`, para a tela dizer por quê.
    if (subscription.billing_exempt_at) {
      throw new SelfBillingError('charges.billingExempt', { code: 'billing_exempt', status: 409 });
    }
    // O cancelamento agendado (0107) não renova: não há fatura a pagar.
    if (isCancelScheduled(subscription)) {
      throw new SelfBillingError('cancellation.noChargeScheduled', { code: 'cancel_scheduled', status: 409 });
    }
    // Bloqueado pela pró-rata vencida (0101): o que se paga agora é ELA — a
    // renovação pode nem ter saído ainda, e emiti-la não desbloquearia nada.
    // Pela data que a assinatura guarda (`proration_due_at`), em QUALQUER
    // estado: o suspenso por inadimplência (0102) por causa dela também —
    // pagar a renovação no lugar estenderia o prazo e o deixaria suspenso.
    const prorataVence = subscription.proration_due_at ? new Date(subscription.proration_due_at) : null;
    if (prorataVence && !Number.isNaN(prorataVence.getTime()) && prorataVence.getTime() <= Date.now()) {
      const abertas = (await BillingCharge.openProrations()).filter((linha) => linha.gateway_charge_id && linha.invoice_url);
      abertas.sort((a, b) => String(isoDateOf(a.due_date) ?? '').localeCompare(String(isoDateOf(b.due_date) ?? '')));
      if (abertas[0]) return { charge: abertas[0], issued: false, customerCreated: false };
    }
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
    // O preço que a fatura vai pedir, com o cupom (0093). O cupom nunca leva
    // um plano pago a zero (o piso), então "de graça" continua sendo o plano.
    if (!(await SubscriptionService.effectivePriceCents(subscription, plan) > 0)) {
      throw new SelfBillingError('charges.freePlan', { code: 'free_plan', status: 409 });
    }

    // Ligado a outro gateway — o `manual` que o console escolheu para quem
    // paga por fora — não é caso de emitir: a plataforma decidiu cobrar esse
    // provedor de outro jeito, e o clique dele não desfaz a decisão.
    if (tenant.billing_gateway && tenant.billing_gateway !== asaasBilling.name) {
      throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }
    if (!(await asaasBilling.isConfigured())) {
      throw new SelfBillingError('charges.gatewayNotConfigured', { code: 'gateway_not_configured', status: 503 });
    }

    // A cobrança de cartão em aberto cujo cartão deixou de servir (recusado,
    // removido, cobrança automática desligada) sai daqui já como Pix/boleto
    // (0100): o clique de quem quer pagar não pode devolver a fatura que o
    // cartão não pagou. Melhor esforço — a falha fica para o agendador.
    await CardAutopayService.reissueIneligible({ tenant }).catch((error) => {
      console.warn(`Could not reissue the card charge of provider ${tenantId} before paying: ${error.message}`);
    });

    let customerCreated = false;
    let atual = tenant;
    if (!tenant.billing_customer_ref) {
      try {
        const ligado = await ensureAsaasCustomer(tenantId);
        customerCreated = ligado.created;
        atual = ligado.tenant ?? await Tenant.findById(tenantId);
      } catch (error) {
        if (!(error instanceof AsaasCustomerError)) throw error;
        throw SelfBillingService.customerRefusal(error);
      }
    }

    // `cardNow`: é o provedor pedindo para pagar JÁ — com o cartão salvo, a
    // cobrança sai no cartão agora, e não no dia do vencimento.
    const resultado = await ChargeIssuingService.issueCurrent({ tenant: atual, manual: true, countDevices, cardNow: true });
    const recusa = SelfBillingService.issueRefusal(resultado);
    if (recusa) throw recusa;

    // `raced` é a outra passada (o agendador, outro clique, a reemissão de uma
    // troca de plano) com a linha na mão: a cobrança é a dela, e é ela que se
    // devolve — mas só depois de ela EXISTIR no gateway. Devolver a linha
    // ainda sem link seria um botão "pagar" que não leva a lugar nenhum.
    let charge = resultado.charge ?? null;
    if (resultado.reason === 'raced') {
      charge = await SelfBillingService.waitForInvoice(charge);
      if (!charge) throw ocupado();
    }
    if (!charge) {
      throw new SelfBillingError('charges.payFailed', { code: 'gateway_failed', status: 502 });
    }
    return { charge, issued: Boolean(resultado.issued), customerCreated };
  }

  /**
   * A cobrança em aberto do prazo vivo posta no preço de `plan` e reemitida —
   * a porta da troca de plano, aberta para a emissão quando uma descida
   * agendada fica bloqueada depois de a cobrança dela já ter saído (ver
   * `ChargeIssuingService.repriceBlockedDowngrade`). Lança `SelfBillingError`
   * como a troca: quem chama decide o que fazer com a recusa.
   */
  /**
   * O plano que a fatura do prazo vivo cobra — o atual, ou o da descida
   * agendada para este prazo (ver `planoDaFatura`). Para quem fala do valor
   * da fatura antes de ela existir, como o lembrete de cobrança.
   */
  static async invoicePlanFor(subscription, { countDevices = null } = {}) {
    return (await planoDaFatura(subscription, { countDevices })).plano;
  }

  /**
   * O plano E a assinatura no ciclo com que a fatura do prazo vivo sai (0104)
   * — para quem precisa do VALOR dela antes de ela existir (o lembrete):
   * a troca para o anual agendada para este prazo cobra o preço do ano.
   */
  static async invoicePricingFor(subscription, { countDevices = null } = {}) {
    const { plano, assinatura } = await planoDaFatura(subscription, { countDevices });
    return { plan: plano, subscription: assinatura };
  }

  static async repriceOpenCharge({ subscription, plan, tenant, blockedBy = undefined }) {
    const cobranca = await reprecificarCobranca(subscription, plan);
    const reissue = await reemitir(cobranca, tenant, { pendingBlockedBy: blockedBy });
    return { charge: cobranca.acao, ...(reissue ? { reissue } : {}) };
  }

  /**
   * Grava uma mudança que muda o PREÇO da fatura sem mudar o plano — o cupom
   * (0093) entrando ou saindo — com a cobrança em aberto do prazo vivo
   * reprecificada pela mesma porta da troca de plano: garra, cancelamento no
   * gateway ANTES de gravar (a falha para tudo, e nada muda), a gravação com
   * a linha ainda segura, e a reemissão pelo estado novo.
   *
   * `depois` é a assinatura como vai ficar — é por ela que o preço novo se
   * calcula, antes de ser gravada. `escrever` grava; se lançar, a garra é
   * solta e a recusa sobe. O plano da fatura é o mesmo que a emissão
   * escolheria (`planoDaFatura`): o atual, ou o da descida agendada para este
   * prazo quando o uso cabe nele. O valor mudado à mão pelo console vence
   * (`keepOverride`): essa fatura não é tocada.
   *
   * @returns {Promise<{ result: any, charge: 'none'|'reissued', reissue?: object }>}
   */
  static async repriceAround({ depois, tenant, escrever, countDevices = null }) {
    // Parada por gente (`suspended`): a emissão não reemitiria, e cancelar a
    // fatura dela agora a deixaria sem link. Grava só; o preço novo vale na
    // próxima emissão, quando ela voltar.
    if (!ESTADOS_VIVOS.has(depois?.status)) return { result: await escrever(), charge: 'none' };
    const { plano, assinatura, bloqueio } = await planoDaFatura(depois, { countDevices });
    const cobranca = plano
      ? await reprecificarCobranca(assinatura, plano, { keepOverride: true })
      : { acao: 'none', linhaId: null };
    let result;
    try {
      result = await gravarSegurando(cobranca, escrever);
    } catch (error) {
      // A gravação perdeu (outra aplicação entrou no meio): a fatura velha já
      // foi cancelada no gateway, então ela volta já, pelo estado que ficou —
      // sem esperar o agendador, e sem deixar o provedor sem link.
      await reemitir(cobranca, tenant, { countDevices, pendingBlockedBy: bloqueio });
      throw error;
    }
    const reissue = await reemitir(cobranca, tenant, { countDevices, pendingBlockedBy: bloqueio });
    return { result, charge: cobranca.acao, ...(reissue ? { reissue } : {}) };
  }

  /**
   * Liga ou desliga a cobrança automática no cartão (0100) — o "Cobrar
   * automaticamente no cartão" da tela de Plano.
   *
   * Ligar só registra a intenção e o IP de quem pediu (`remoteIp`, que o
   * gateway exige em toda cobrança por token): o cartão é salvo depois, pelo
   * pagamento de uma fatura com cartão na página do gateway
   * (`CardAutopayService.captureToken`). Ligar de novo renova o IP e mantém a
   * data. Desligar mantém o cartão salvo, mas ele deixa de ser usado — e a
   * cobrança de cartão em aberto é reemitida como Pix/boleto.
   *
   * Recusas: `enabled` que não é booleano (400 `invalid`); a plataforma, ou
   * ligar numa assinatura parada por gente (409 `not_changeable`); ligar num
   * provedor cobrado por outro gateway (409 `not_billable`).
   *
   * @returns {Promise<{ changed: boolean, enabled: boolean }>}
   */
  static async setCardAutopay({ enabled, remoteIp = null, now = new Date() }) {
    if (typeof enabled !== 'boolean') {
      throw new SelfBillingError('subscription.cardAutopayInvalid', { code: 'invalid', status: 400 });
    }
    const tenantId = currentTenantId();
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription) {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }
    const ligada = Boolean(subscription.card_autopay_at);
    if (enabled) {
      if (!ESTADOS_VIVOS.has(subscription.status)) {
        throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
      }
      if (tenant.billing_gateway && tenant.billing_gateway !== asaasBilling.name) {
        throw new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
      }
      const ip = String(remoteIp ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').slice(0, 45);
      if (!ip) throw new SelfBillingError('subscription.cardUpdateFailed', { code: 'no_remote_ip', status: 400 });
      await Subscription.upsertForTenant(tenantId, {
        card_autopay_at: subscription.card_autopay_at ?? new Date(Math.floor(now.getTime() / 1000) * 1000),
        card_remote_ip: ip
      });
    } else if (ligada) {
      await Subscription.upsertForTenant(tenantId, { card_autopay_at: null, card_capture_payment_id: null });
    }
    await SubscriptionService.invalidate(tenantId);
    if (!enabled && ligada) {
      await CardAutopayService.reissueIneligible({ tenant, now }).catch((error) => {
        console.warn(`Could not reissue the card charge of provider ${tenantId} after autopay was turned off: ${error.message}`);
      });
    }
    return { changed: enabled !== ligada, enabled };
  }

  /**
   * Esquece o cartão salvo (0100): o token cifrado, a bandeira, os dígitos, a
   * falha. A intenção de cobrança automática fica como está — com ela ligada,
   * pagar a próxima fatura com outro cartão salva o novo. A cobrança de
   * cartão em aberto é reemitida como Pix/boleto. Idempotente: sem cartão
   * salvo, nada muda.
   *
   * @returns {Promise<{ removed: boolean, brand?: string|null, last4?: string|null }>}
   */
  static async removeCard({ now = new Date() } = {}) {
    const tenantId = currentTenantId();
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') {
      throw new SelfBillingError('subscription.notChangeable', { code: 'not_changeable', status: 409 });
    }
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription || !CardAutopayService.hasToken(subscription)) return { removed: false };
    await Subscription.upsertForTenant(tenantId, { ...CardAutopayService.CLEARED_CARD });
    await SubscriptionService.invalidate(tenantId);
    await CardAutopayService.reissueIneligible({ tenant, now }).catch((error) => {
      console.warn(`Could not reissue the card charge of provider ${tenantId} after the card was removed: ${error.message}`);
    });
    return { removed: true, brand: subscription.card_brand ?? null, last4: subscription.card_last4 ?? null };
  }

  /** Quanto o "pagar agora" espera pela cobrança que outra passada está emitindo. */
  static RACE_WAIT_MS = 3000;

  static RACE_POLL_MS = 200;

  /**
   * A linha que outra passada está emitindo, relida até ela ter o link — ou
   * nulo, quando o prazo acaba, a linha some ou a emissão do outro falha.
   *
   * Espera curta e com teto, dentro da requisição: a chamada ao gateway leva
   * um ou dois segundos quando dá certo, e é esse o caso que vale esperar. Se
   * não saiu em três, quem clicou ouve "tente de novo em instantes" — o que é
   * melhor que prender a requisição pelo prazo inteiro de uma chamada lenta.
   */
  static async waitForInvoice(linha) {
    if (!linha?.id) return null;
    const limite = Date.now() + SelfBillingService.RACE_WAIT_MS;
    let atual = linha;
    for (;;) {
      if (atual.gateway_charge_id && atual.invoice_url) return atual;
      // Fechada (paga, cancelada) no meio da espera: não há mais o que pagar
      // por ela. `failed` continua esperando — é o estado de uma linha sendo
      // retentada, e a outra passada pode estar emitindo por ela agora.
      if (!OPEN_CHARGE_STATUSES.includes(atual.status)) return null;
      if (Date.now() >= limite) return null;
      // eslint-disable-next-line no-await-in-loop -- é uma espera, uma leitura por volta
      await new Promise((resolve) => { setTimeout(resolve, SelfBillingService.RACE_POLL_MS); });
      // eslint-disable-next-line no-await-in-loop
      atual = await BillingCharge.findById(linha.id);
      if (!atual) return null;
    }
  }

  /** A recusa do cadastro no gateway, nos códigos do "pagar agora". */
  static customerRefusal(error) {
    switch (error.code) {
      case 'missing_tax_id':
        return new SelfBillingError('charges.missingTaxId', { code: 'missing_tax_id', status: 400 });
      case 'invalid_tax_id':
        return new SelfBillingError('charges.invalidTaxId', { code: 'invalid_tax_id', status: 400 });
      case 'missing_name':
        return new SelfBillingError('charges.missingName', { code: 'missing_name', status: 400 });
      case 'not_configured':
        return new SelfBillingError('charges.gatewayNotConfigured', { code: 'gateway_not_configured', status: 503 });
      case 'not_found':
      case 'already_linked':
        return new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
      default:
        return new SelfBillingError('charges.gatewayFailed', {
          code: 'gateway_failed', status: 502, vars: { detail: error.message }, detail: error.message
        });
    }
  }

  /** O que a emissão respondeu, quando não é uma cobrança — ou nulo. */
  static issueRefusal(resultado) {
    if (resultado.issued || resultado.reason === 'already_issued' || resultado.reason === 'raced') return null;
    switch (resultado.reason) {
      case 'free_plan':
        return new SelfBillingError('charges.freePlan', { code: 'free_plan', status: 409 });
      case 'billing_exempt':
        return new SelfBillingError('charges.billingExempt', { code: 'billing_exempt', status: 409 });
      case 'cancel_scheduled':
        return new SelfBillingError('cancellation.noChargeScheduled', { code: 'cancel_scheduled', status: 409 });
      case 'gateway_not_configured':
        return new SelfBillingError('charges.gatewayNotConfigured', { code: 'gateway_not_configured', status: 503 });
      case 'gateway_failed':
        return new SelfBillingError('charges.gatewayFailed', {
          code: 'gateway_failed', status: 502, vars: { detail: resultado.error }, detail: resultado.error
        });
      default:
        // Plataforma, sem gateway que emita, sem assinatura, parada por gente,
        // período já quitado: para quem clicou, tudo é "daqui não se cobra".
        return new SelfBillingError('charges.notBillable', { code: 'not_billable', status: 409 });
    }
  }
}

export default SelfBillingService;
