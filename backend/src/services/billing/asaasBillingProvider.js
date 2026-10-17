import { BillingProvider } from './billingProvider.js';
import SubscriptionService from '../subscriptionService.js';
import {
  createCharge as criarCobranca,
  cancelCharge as cancelarCobranca,
  getCharge as lerCobranca,
  getPaymentCard as lerCartaoDoPagamento,
  findChargesByReference as cobrancasDaReferencia,
  receiveInCash as receberEmDinheiro,
  refundCharge as estornarCobranca,
  undoReceivedInCash as desfazerRecebimentoEmDinheiro,
  updateCharge as atualizarCobranca,
  apiKey
} from './asaasClient.js';

/**
 * O Asaas, que era o nome escrito no comentário da interface desde que ela
 * nasceu.
 *
 * A metade fácil — `recordPayment` — é uma delegação, e é fácil de propósito:
 * a interface foi escrita exatamente para que o webhook não duplicasse "o que
 * um pagamento significa". A regra comercial (`suspended` e `canceled` NÃO
 * reativam por pagamento), a idempotência em duas camadas e a transação que põe
 * o evento antes da data já existem em `SubscriptionService.recordPayment`, já
 * são testadas nos dois ramos, e já foram pagas por um bug real.
 *
 * A metade que precisa de cuidado é `interpretar`, abaixo.
 */

/**
 * Os eventos que significam "entrou dinheiro", e a armadilha que eles carregam.
 *
 * O Asaas manda os dois para um pagamento de cartão: `PAYMENT_CONFIRMED` quando
 * a operadora aprova e `PAYMENT_RECEIVED` quando o dinheiro cai na conta, D+30
 * depois. Pix vai direto para `RECEIVED`; boleto passa por `CONFIRMED` antes.
 *
 * Creditamos nos dois, e o que impede o cartão de creditar duas vezes é a
 * **chave de idempotência ser o id do PAGAMENTO e não o do evento**: os dois
 * eventos falam do mesmo `payment.id`, então o segundo cai na primeira camada
 * de `recordPayment` e responde `duplicate`. Se a chave fosse o id do evento —
 * que é o que a documentação do gateway sugere para deduplicar entregas — o
 * cartão ganharia dois períodos por pagamento, e ninguém perceberia por meses,
 * porque o extrato mostraria dois eventos que de fato aconteceram.
 *
 * E é por isso que creditar no `CONFIRMED` é seguro: o ISP não espera trinta
 * dias de liquidação de cartão para o painel voltar a escrever.
 */
const EVENTOS_QUE_CREDITAM = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);

/**
 * Os eventos que mudam o estado de uma cobrança sem creditar nada, e o estado
 * que cada um grava em `billing_charges.status`. Ver `interpretarCiclo`.
 */
const EVENTOS_DO_CICLO = new Map([
  ['PAYMENT_OVERDUE', 'overdue'],
  ['PAYMENT_DELETED', 'canceled'],
  ['PAYMENT_REFUNDED', 'refunded'],
  // O cartão salvo recusado na captura (0100). Não é etiqueta de cobrança:
  // `card_refused` não está em `TRANSICOES_DO_CICLO`, e o controlador o leva
  // ao cartão recorrente (marca a falha, reemite como Pix/boleto e avisa).
  ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'card_refused']
]);

/** Reais como o gateway manda (número JSON) para centavos inteiros. */
function paraCentavos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return null;
  // Arredondar sobre o produto, e não truncar: `19.99 * 100` vale
  // 1998.9999999999998 em binário de ponto flutuante, e um `Math.floor` ali
  // cobraria um centavo a menos de todo mundo, para sempre.
  return Math.round(numero * 100);
}

/**
 * O dia em que quem pagou pagou, `YYYY-MM-DD` — ou nulo.
 *
 * `clientPaymentDate` antes de `paymentDate`: o boleto pago no último dia do
 * desconto compensa um ou dois dias úteis depois, e é o dia do CLIENTE que o
 * gateway usou para decidir se o desconto valia. Sem nenhum dos dois, quem
 * confere usa o dia da entrega.
 */
function diaDoPagamento(pagamento) {
  for (const campo of ['clientPaymentDate', 'paymentDate']) {
    const valor = String(pagamento?.[campo] ?? '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  }
  return null;
}

export class AsaasBillingProvider extends BillingProvider {
  get name() {
    return 'asaas';
  }

  /** Este emite: é a metade que este arquivo ganhou depois da que recebe. */
  get canIssue() {
    return true;
  }

  /**
   * Se este deploy tem como falar com o gateway.
   *
   * Separado de `canIssue` porque são perguntas diferentes: uma é sobre o
   * provider ("você sabe emitir?"), a outra é sobre a instalação ("você tem a
   * chave?"). Juntá-las faria um deploy sem chave parecer um provider que não
   * emite, e o job não teria como dizer qual dos dois problemas contar.
   */
  async isConfigured() {
    // Assíncrona desde que a chave pode vir do console, e não só do `.env`:
    // saber se ela existe passou a ser uma leitura (com cache) na caixa da
    // plataforma. Quem pergunta precisa do `await` — um `if (!isConfigured())`
    // sem ele testaria uma Promise, que é sempre verdadeira, e o job trataria
    // um deploy sem chave como configurado.
    return Boolean(await apiKey());
  }

  /**
   * Cria a cobrança no gateway. Delegação, como `recordPayment`: a política de
   * quando e por quanto é do job, o transporte é do cliente, e aqui fica só a
   * costura entre os dois.
   */
  async createCharge(cobranca) {
    return criarCobranca(cobranca);
  }

  /**
   * Cancela no gateway uma cobrança que ele emitiu. Mesma costura de
   * `createCharge`: quando cancelar é da troca de plano, o transporte é do
   * cliente, e aqui fica só a delegação — é por ela que quem cancela pergunta
   * ao provider da LINHA, e não ao Asaas pelo nome.
   */
  async cancelCharge(gatewayChargeId) {
    return cancelarCobranca(gatewayChargeId);
  }

  /**
   * Dá como recebida no gateway a cobrança que o console marcou paga à mão.
   * Mesma costura das duas acima: quem chama pergunta ao provider da LINHA,
   * e um provider que não sabe fazer isto (o `manual`) simplesmente não tem o
   * método — o console marca só do lado de cá.
   */
  async receiveInCash(gatewayChargeId, recebimento) {
    return receberEmDinheiro(gatewayChargeId, recebimento);
  }

  /** Como o gateway vê a cobrança agora. Mesma costura. */
  async getCharge(gatewayChargeId) {
    return lerCobranca(gatewayChargeId);
  }

  /**
   * Estorna inteiro o pagamento que entrou pelo gateway. Mesma costura — e o
   * `manual`, que não tem o método, estorna só do lado de cá.
   */
  async refundCharge(gatewayChargeId) {
    return estornarCobranca(gatewayChargeId);
  }

  /** Desfaz a baixa em dinheiro que o console deu lá dentro. Mesma costura. */
  async undoReceivedInCash(gatewayChargeId) {
    return desfazerRecebimentoEmDinheiro(gatewayChargeId);
  }

  /**
   * Se este gateway cobra sozinho com o token de um cartão salvo (0100). Uma
   * propriedade, como `canIssue`: quem emite pergunta antes de montar a
   * cobrança de cartão.
   */
  get canChargeSavedCard() {
    return true;
  }

  /** O cartão com que um pagamento foi pago — só para `cardAutopayService`. */
  async getPaymentCard(gatewayChargeId) {
    return lerCartaoDoPagamento(gatewayChargeId);
  }

  /** As cobranças vivas com uma referência nossa — ver `findChargesByReference`. */
  async findChargesByReference(reference) {
    return cobrancasDaReferencia(reference);
  }

  /** Muda vencimento e/ou valor de uma cobrança já emitida. Mesma costura. */
  async updateCharge(gatewayChargeId, mudanca) {
    return atualizarCobranca(gatewayChargeId, mudanca);
  }

  /**
   * O que uma entrega do Asaas quer dizer — e o único lugar deste repositório
   * que depende da forma do JSON de um sistema de fora.
   *
   * Isolado numa função pura, sem banco e sem rede, por dois motivos. O
   * primeiro é o teste: a forma do payload é a única coisa aqui que não dá para
   * verificar contra o gateway de verdade sem uma conta nele, então ela precisa
   * ser barata de corrigir e impossível de corrigir pela metade. O segundo é a
   * direção da falha: **um campo que muda de nome faz isto devolver `null`, e
   * `null` é "não faço nada"** — a rota responde 200 e ninguém é creditado. O
   * avesso, creditar por engano, exigiria que um campo novo aparecesse com o
   * nome certo e o sentido errado.
   *
   * Conferido contra a documentação do gateway em setembro de 2026: o cabeçalho
   * de autenticação é `asaas-access-token`, o corpo tem `event` e `payment`, e
   * `externalReference` é o campo reservado a quem recebe para reconciliar com
   * o próprio cadastro. Antes da primeira cobrança de verdade, isto se confere
   * uma vez com uma entrega real — e é por isso que a rota registra o corpo
   * recusado no log do processo.
   *
   * @returns {{externalId: string, amountCents: number, customerRef: string|null,
   *            reference: string|null, event: string}|null}
   */
  static interpretar(corpo) {
    const evento = String(corpo?.event ?? '');
    if (!EVENTOS_QUE_CREDITAM.has(evento)) return null;

    const pagamento = corpo?.payment;
    if (!pagamento || typeof pagamento !== 'object') return null;

    const externalId = String(pagamento.id ?? '').trim();
    if (!externalId) return null;

    const amountCents = paraCentavos(pagamento.value);
    if (amountCents === null) return null;

    return {
      event: evento,
      externalId,
      amountCents,
      // O id do cliente no gateway — o caminho de volta quando a cobrança foi
      // emitida lá dentro, à mão, sem passar por nós.
      customerRef: pagamento.customer ? String(pagamento.customer) : null,
      // A nossa própria referência, quando fomos nós que criamos a cobrança.
      // Preferida sobre a de cima: ela é escrita por este painel e não depende
      // de o cadastro do cliente no gateway estar ligado ao provedor certo.
      reference: pagamento.externalReference ? String(pagamento.externalReference) : null,
      // O dia do pagamento, para a janela do desconto por antecipação
      // (`recordPayment`). O valor do desconto em si NÃO se lê daqui: o
      // `discount` do corpo é a configuração da cobrança, não o que foi
      // abatido — o abatido é a diferença entre `value` e o que se pediu.
      paidOn: diaDoPagamento(pagamento),
      // O meio com que foi pago (0100): `CREDIT_CARD` é o que faz o cartão
      // recorrente ir ler o token. Só uma pista — o token vem do `GET`.
      billingType: pagamento.billingType ? String(pagamento.billingType).toUpperCase() : null
    };
  }

  /**
   * O resto do ciclo de vida de uma cobrança: o que acontece com ela quando
   * NÃO entra dinheiro.
   *
   * Separado de `interpretar` de propósito, e não um `kind` a mais no mesmo
   * retorno: aquele é o caminho que CREDITA, e cada evento que ele aceita é um
   * período dado a alguém. Misturar aqui eventos que só mudam a etiqueta da
   * cobrança obrigaria quem lê o crédito a conferir o `kind` antes de creditar
   * — e o esquecimento dessa conferência creditaria um estorno.
   *
   * Os três eventos, e o estado do painel que cada um vira:
   *
   * - `PAYMENT_OVERDUE` → `overdue`: venceu e ninguém pagou. Continua em aberto
   *   — o link de pagamento continua valendo e o aviso de vencimento continua o
   *   mandando —, só que agora com o nome certo.
   * - `PAYMENT_DELETED` → `canceled`: alguém removeu a cobrança no painel do
   *   gateway. É o mesmo `canceled` do console e da faxina de períodos velhos.
   * - `PAYMENT_REFUNDED` → `refunded`: o dinheiro voltou para quem pagou. O
   *   período que ele comprou é desfeito pelo controlador, e não aqui — esta
   *   função só lê o corpo.
   *
   * Mesma direção de falha de `interpretar`: um campo que muda de nome devolve
   * nulo, e nulo é "não faço nada".
   *
   * @returns {{event: string, status: string, externalId: string,
   *            customerRef: string|null, reference: string|null}|null}
   */
  static interpretarCiclo(corpo) {
    const evento = String(corpo?.event ?? '');
    const status = EVENTOS_DO_CICLO.get(evento);
    if (!status) return null;

    const pagamento = corpo?.payment;
    if (!pagamento || typeof pagamento !== 'object') return null;

    const externalId = String(pagamento.id ?? '').trim();
    if (!externalId) return null;

    // O estorno PARCIAL, quando o corpo deixa dizer: a soma dos estornos da
    // lista `refunds` (os cancelados não contam), ou `refundedValue` quando a
    // lista não vem, contra o valor do pagamento. Sem nenhum dos dois, não se
    // sabe — e "não sei" é tratado como inteiro, que é o que o
    // `PAYMENT_REFUNDED` diz por nome. Conservador na outra direção: só é
    // parcial o que o corpo PROVA que é.
    let refundedCents = null;
    if (Array.isArray(pagamento.refunds) && pagamento.refunds.length) {
      const validos = pagamento.refunds
        .filter((item) => item && String(item.status ?? '').toUpperCase() !== 'CANCELLED')
        .map((item) => paraCentavos(item.value));
      if (validos.length && validos.every((valor) => valor !== null)) {
        refundedCents = validos.reduce((soma, valor) => soma + valor, 0);
      }
    } else if (pagamento.refundedValue !== undefined && pagamento.refundedValue !== null) {
      refundedCents = paraCentavos(pagamento.refundedValue);
    }
    const valueCents = paraCentavos(pagamento.value);
    const partial = status === 'refunded' && refundedCents !== null && valueCents !== null
      && refundedCents < valueCents;

    return {
      event: evento,
      status,
      externalId,
      customerRef: pagamento.customer ? String(pagamento.customer) : null,
      reference: pagamento.externalReference ? String(pagamento.externalReference) : null,
      ...(status === 'refunded' ? { partial, refundedCents, valueCents } : {})
    };
  }

  async recordPayment({
    amountCents, currency, externalId = null, actorUserId = null, allowUnderpayment = false, paidOn = null, now
  }) {
    return SubscriptionService.recordPayment({
      amountCents,
      paidOn,
      currency,
      provider: this.name,
      externalId,
      allowUnderpayment,
      // Nulo, e não um usuário: quem registrou foi o gateway. O console grava
      // quem apertou o botão; aqui não houve botão nenhum.
      actorUserId,
      ...(now ? { now } : {})
    });
  }
}

export const asaasBilling = new AsaasBillingProvider();

export default AsaasBillingProvider;
