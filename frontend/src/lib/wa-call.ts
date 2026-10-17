/**
 * O link "Ligar" da conversa: `tel:` com o número em E.164 (`+55…`), que o
 * celular abre no discador e o computador entrega ao app de chamadas que
 * estiver associado (o "Vincular ao celular" do Windows, o FaceTime do Mac).
 * Nada passa pelo painel: quem liga é o aparelho do atendente.
 *
 * `null` quando a conversa não tem um número de telefone (só o identificador
 * do WhatsApp, o LID) ou ele é curto demais para ser um número.
 */
export function callHref(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null
  return `tel:+${digits}`
}
