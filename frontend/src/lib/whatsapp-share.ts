/**
 * Mandar um texto pelo WhatsApp de quem está na tela, sem o painel enviar nada.
 *
 * O link de senha é uma credencial: o banco guarda só o hash dele. Enviá-lo
 * pelo número da plataforma gravaria o link em claro no histórico de
 * conversas; abrir o `wa.me` com o texto pronto deixa a mensagem sair do
 * WhatsApp de quem opera, e o painel não guarda nada.
 */

/**
 * `https://wa.me/<dígitos>?text=<texto>`. Sem telefone utilizável, o endereço
 * vai sem número e o próprio WhatsApp pergunta para quem mandar.
 */
export function whatsappShareUrl(phone: string | null | undefined, text: string): string {
  const digitos = String(phone ?? '').replace(/\D/g, '')
  const numero = digitos.length >= 8 && digitos.length <= 15 ? digitos : ''
  return `https://wa.me/${numero}?text=${encodeURIComponent(text)}`
}

/** `5511987654321` → `+55 11 98765-4321`; o resto sai como veio, com `+`. */
export function formatPhone(phone: string | null | undefined): string {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return ''
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d)
  if (br) return `+55 ${br[1]} ${br[2]}-${br[3]}`
  return `+${d}`
}
