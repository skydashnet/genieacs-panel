/**
 * O que a seção de cobrança do portal faz quando a consulta não dá certo.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em ambiente `node`, sem
 * jsdom, e a decisão dentro do componente seria decisão sem prova.
 *
 * A REGRA ESTAVA INVERTIDA
 * ------------------------
 * A tela tinha uma lista dos códigos que MOSTRAVAM erro, e todo o resto
 * escondia a seção. Isso é seguro só enquanto toda falha chega com um código
 * conhecido — e três não chegavam:
 *
 * - a rede que cai no meio (o `fetch` lança, e o `catch` zerava a mensagem);
 * - a página de erro HTML de um proxy na frente, um 502 que não é JSON e por
 *   isso não tem código;
 * - o 502 genérico do próprio backend, que responde `portal.billingFailed`
 *   sem código nenhum.
 *
 * Nos três a seção SUMIA: nem a fatura, nem o cartão de "indisponível, tentar
 * de novo". Para o assinante, a leitura é "não há nada a pagar" — que é a
 * resposta errada mais cara que esta tela tem, porque quem acredita nela não
 * paga e é cortado.
 *
 * Agora a lista é a do que ESCONDE, e ela é curta e nomeada: a cobrança está
 * desligada, ou este aparelho não tem contrato. Todo o resto é falha, e falha
 * aparece.
 */

/**
 * Os códigos em que não há o que mostrar, e não uma falha.
 *
 * `billing_disabled` é o provedor que não ligou a cobrança no portal.
 * `unlinked`, `not_found` e `missing_contract` são o aparelho sem contrato no
 * SGP — os três que `SgpService.resolveDeviceContract` e `listInvoices` usam
 * para isso.
 */
export const BILLING_HIDE_CODES: ReadonlySet<string> = new Set([
  'billing_disabled',
  'unlinked',
  'not_found',
  'missing_contract'
])

export type BillingFailure =
  | { kind: 'hide' }
  | { kind: 'error'; message: string }

/**
 * A resposta que falhou, ou `null` quando nem resposta houve.
 *
 * `fallback` é a frase de "não foi possível consultar agora", já traduzida —
 * quem chama tem o `t`, este módulo não.
 */
export function billingFailure(
  result: { code?: string; message?: string } | null,
  fallback: string
): BillingFailure {
  if (result?.code && BILLING_HIDE_CODES.has(result.code)) return { kind: 'hide' }
  return { kind: 'error', message: result?.message || fallback }
}
