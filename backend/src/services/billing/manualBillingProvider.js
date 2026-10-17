import { BillingProvider } from './billingProvider.js';
import SubscriptionService from '../subscriptionService.js';

/**
 * Nós marcamos pago.
 *
 * É o provedor de cobrança do MVP e o que o console usa: um humano recebeu o
 * Pix, o boleto ou a transferência por fora, e clica. `externalId` é a
 * referência que ele digitou — o id do Pix, o número do boleto — para que o
 * extrato responda "qual pagamento foi esse" seis meses depois.
 */
export class ManualBillingProvider extends BillingProvider {
  get name() {
    return 'manual';
  }

  /**
   * Não emite, e é o que "manual" quer dizer: alguém recebeu o dinheiro por
   * fora e veio marcar. Não há a quem pedir cobrança, e um `createCharge` aqui
   * seria uma função que finge.
   */
  get canIssue() {
    return false;
  }

  async recordPayment({ amountCents, currency, externalId = null, actorUserId = null, allowUnderpayment = false, now }) {
    return SubscriptionService.recordPayment({
      amountCents,
      currency,
      provider: this.name,
      externalId,
      allowUnderpayment,
      actorUserId,
      ...(now ? { now } : {})
    });
  }
}

export const manualBilling = new ManualBillingProvider();

export default ManualBillingProvider;
