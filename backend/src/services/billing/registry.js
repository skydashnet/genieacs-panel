import { manualBilling } from './manualBillingProvider.js';
import { asaasBilling } from './asaasBillingProvider.js';

/**
 * Qual implementação atende um nome de gateway.
 *
 * Um mapa e não um `if`, porque é o ponto onde um segundo gateway entra — e
 * porque `tenants.billing_gateway` guarda uma string escolhida por quem opera,
 * e uma string desconhecida tem que virar "não sei cobrar este" e não uma
 * exceção no meio de um job que roda a cada minuto.
 */
const PROVEDORES = new Map([
  [manualBilling.name, manualBilling],
  [asaasBilling.name, asaasBilling]
]);

/** O provider daquele nome, ou nulo. Nome vazio é "nenhum", não é erro. */
export function providerFor(nome) {
  const chave = String(nome ?? '').trim().toLowerCase();
  return chave ? (PROVEDORES.get(chave) ?? null) : null;
}

export { PROVEDORES };
