/**
 * O caminho do webhook de cobrança, numa constante.
 *
 * Pelo mesmo motivo de `WA_WEBHOOK_PATH`: quem monta a rota e quem escreve o
 * endereço na documentação e no console têm que sair do mesmo lugar. As duas
 * pontas divergirem é uma cobrança que o gateway entrega num 404 e que ninguém
 * vê até o cliente reclamar que pagou e continua bloqueado.
 *
 * Sem `:parâmetro` no caminho, e isso é decisão e não estilo: uma rota
 * endereçada por id entra na contabilidade de `POR_ID` do inventário, e o teto
 * de exceções fora do console é um número que só pode cair. O provedor a quem a
 * entrega pertence sai do CORPO, que é o único lugar onde o gateway sabe
 * escrevê-lo.
 */
export const BILLING_WEBHOOK_PATH = '/api/billing-webhook';

export default BILLING_WEBHOOK_PATH;
