import type { ApiResponse, LoginDestinations } from '@/lib/api'

/**
 * A resposta do login pediu para escolher? Os destinos, ou `null`.
 *
 * Mora numa função pura porque é a linha que decide entre PERGUNTAR e dizer
 * "senha inválida", e errar para o lado errado é mostrar erro de credencial a
 * quem acertou a senha — a falha mais cara desta tela, e a mais difícil de
 * reproduzir, porque só acontece com conta de mais de um provedor.
 *
 * O reconhecimento é pelo `code`, e não pela frase nem pelo status: a frase é
 * traduzida em treze idiomas e o 409 já é usado por outras rotas com outro
 * significado. Um 409 sem `destinations` não é este caso e não vira pergunta
 * vazia — a tela cai na recusa de sempre, que é o lado seguro de errar.
 */
export function destinosDaResposta(res: ApiResponse): LoginDestinations | null {
  if (res.success) return null
  if (res.code !== 'choose_destination') return null
  const destinos = res.destinations
  if (!destinos || !Array.isArray(destinos.tenants)) return null
  return destinos
}
