/**
 * A altura que sobra à vista quando o teclado do celular está aberto.
 *
 * No Safari do iOS o teclado não encolhe a página (o `interactive-widget` da
 * meta viewport só vale no Chrome do Android): só a `visualViewport` encolhe.
 * A caixa de entrada tem altura em `dvh`, então o compositor ficava atrás do
 * teclado. Com esta conta o cartão passa a caber na parte visível.
 *
 * `null` quando não há teclado. A margem de 120 px deixa de fora a barra de
 * endereço que recolhe ao rolar; e no Android, onde a página já encolhe junto,
 * as duas alturas andam iguais e nada muda.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 */
const KEYBOARD_MIN_PX = 120

export function visibleHeightWithKeyboard({ innerHeight, vvHeight }: { innerHeight: number; vvHeight: number }): number | null {
  if (!(innerHeight > 0) || !(vvHeight > 0)) return null
  return innerHeight - vvHeight > KEYBOARD_MIN_PX ? Math.round(vvHeight) : null
}
