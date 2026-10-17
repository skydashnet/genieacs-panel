/**
 * Respostas rápidas: os modelos da categoria `atendimento`, que o atendente
 * escolhe na conversa digitando "/". Puro, para ser testado sem navegador.
 */

export interface QuickReply {
  id: number
  name: string
  body: string
}

export interface QuickReplyVars {
  nome?: string | null
  primeiro_nome?: string | null
  contrato?: string | null
  atendente?: string | null
}

/** Quantas opções a lista mostra de uma vez. */
export const QUICK_REPLY_LIMIT = 8

const semAcento = (texto: string) =>
  texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * As respostas que batem com o que foi digitado depois da "/": primeiro as
 * que batem pelo nome, depois as que batem só pelo texto. Sem acento e sem
 * diferença de maiúsculas, porque o atendente digita rápido.
 */
export function matchQuickReplies<T extends QuickReply>(list: T[], query: string, limit = QUICK_REPLY_LIMIT): T[] {
  const busca = semAcento(query.trim())
  if (!busca) return list.slice(0, limit)
  const peloNome = list.filter((item) => semAcento(item.name).includes(busca))
  const pelosNomes = new Set(peloNome.map((item) => item.id))
  const peloTexto = list.filter((item) => !pelosNomes.has(item.id) && semAcento(item.body).includes(busca))
  return [...peloNome, ...peloTexto].slice(0, limit)
}

/** A primeira palavra de um nome, com só a inicial maiúscula. */
export function firstName(nome: string | null | undefined): string {
  const primeira = String(nome ?? '').trim().split(/\s+/)[0] ?? ''
  if (!primeira) return ''
  return primeira.charAt(0).toUpperCase() + primeira.slice(1).toLowerCase()
}

/**
 * Troca as variáveis pelo que se sabe da conversa. O que não tiver valor fica
 * como está (`{{contrato}}`), à vista: o atendente completa antes de enviar,
 * em vez de mandar um buraco.
 */
export function fillQuickReply(body: string, vars: QuickReplyVars): string {
  return body.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (inteiro, nome: string) => {
    const valor = vars[nome as keyof QuickReplyVars]
    const texto = typeof valor === 'string' ? valor.trim() : ''
    return texto || inteiro
  })
}

/**
 * O que a caixa de mensagem está pedindo: `null` quando não é um atalho, ou o
 * texto depois da "/" quando a caixa começa com ela, numa linha só.
 */
export function quickReplyQuery(body: string): string | null {
  if (!body.startsWith('/') || body.includes('\n')) return null
  return body.slice(1)
}
