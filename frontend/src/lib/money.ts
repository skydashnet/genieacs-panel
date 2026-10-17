/**
 * Centavos e um código de moeda viram o que se lê na tela.
 *
 * O `Intl` está num `try`: `currency` chega do banco — é a coluna que a emissão
 * copiou do plano — e um código que não existe faz o construtor LANÇAR, não
 * devolver um texto feio. Sem a rede embaixo, uma letra errada numa linha de
 * `plans` derrubaria a tela inteira de cobranças em vez de mostrar um valor
 * sem símbolo.
 *
 * Locale indefinido de propósito: quem formata é o navegador de quem olha.
 */
export function formatMoney(cents: number | null | undefined, currency: string | null | undefined) {
  if (cents === null || cents === undefined) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'BRL' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ''}`
  }
}
