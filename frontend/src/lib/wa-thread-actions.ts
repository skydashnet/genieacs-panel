/**
 * Os quatro botões do cabeçalho da conversa — trocar assinante, encerrar,
 * módulo SGP, abrir o equipamento — com texto ou só com ícone.
 *
 * Quem decide é a largura do cabeçalho, e não a da tela: a mesma tela de
 * 1600 px tem uma conversa larga com o módulo SGP fechado e estreita com ele
 * aberto, e num notebook de 1100 px a coluna da conversa é mais estreita que um
 * celular deitado. Com texto, os quatro somam ~650 px em português; abaixo do
 * limite eles quebravam em duas linhas acima das mensagens, e só com ícone
 * cabem numa. O limite tem folga para idiomas de rótulo mais longo — e se ainda
 * assim não couber, o grupo quebra linha em vez de sair da tela.
 *
 * Só ícone não tira o nome de ninguém: ele fica no `aria-label` e no `title`.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 */
export const ACTION_LABELS_MIN_PX = 760

/**
 * Largura do cabeçalho em px. Zero é "ainda não medido": fica só o ícone, para
 * não piscar um texto que talvez não caiba.
 */
export function showActionLabels(headerWidth: number): boolean {
  return Number.isFinite(headerWidth) && headerWidth >= ACTION_LABELS_MIN_PX
}
