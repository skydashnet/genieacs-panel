/**
 * O contrato de quem cobra.
 *
 * Definido agora, com uma implementação só, porque o gateway vai entrar por
 * webhook e o webhook vai querer fazer exatamente o que o botão do console faz
 * hoje: registrar um pagamento contra uma assinatura. Se a lógica de "o que um
 * pagamento significa" morasse no controlador do console, o webhook a
 * duplicaria — e as duas cópias divergiriam no primeiro caso de borda.
 *
 * A recomendação para o gateway continua a do plano: Asaas (Pix, boleto e
 * cartão; é o padrão do mercado de ISP brasileiro). Ele entraria como
 * `AsaasBillingProvider`, com `recordPayment` chamado pelo handler do webhook
 * e `name` = 'asaas' gravado em `billing_events.provider`.
 */
export class BillingProvider {
  /** O nome que vai em `billing_events.provider`. */
  get name() {
    throw new Error('BillingProvider.name must be implemented');
  }

  /**
   * Registra um pagamento contra o provedor EM ESCOPO. Quem chama abre o
   * escopo do provedor pagante antes; isto não recebe `tenantId` de propósito,
   * para que ninguém registre pagamento no provedor errado por passar o id
   * errado — o escopo é o único jeito de dizer de quem é.
   */
  async recordPayment(_payment) {
    throw new Error('BillingProvider.recordPayment must be implemented');
  }

  /**
   * Se este provider sabe EMITIR cobrança, e não só registrar o que entrou.
   *
   * Existe porque a resposta não é a mesma para os dois que existem: o manual é
   * um humano clicando depois do fato, e não há a quem pedir nada. Uma
   * propriedade e não um `try/catch` em volta de `createCharge`: "não sei
   * emitir" é uma característica do provider, não um acidente de execução, e o
   * job precisa saber disso ANTES de gravar a linha da cobrança.
   */
  get canIssue() {
    return false;
  }

  /**
   * Cria a cobrança no gateway e devolve o que o painel guarda.
   *
   * Recebe o que o painel decidiu (quanto, quando, para qual cliente do
   * gateway, com qual referência de volta) e devolve o que só o gateway sabe: o
   * id da cobrança lá dentro e o endereço onde ela se paga.
   *
   * `reference` é o contrato com a outra metade — o webhook resolve o provedor
   * por ela — e o formato está fixado em `billingWebhookController`.
   *
   * @returns {Promise<{chargeId: string, invoiceUrl: string|null, dueDate: string|null}>}
   */
  async createCharge(_charge) {
    throw new Error('BillingProvider.createCharge must be implemented');
  }
}

export default BillingProvider;
