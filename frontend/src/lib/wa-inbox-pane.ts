/**
 * Qual metade da caixa de entrada aparece: a lista, a conversa, ou as duas.
 *
 * No computador (a partir de `lg`) as duas ficam lado a lado, sempre. No
 * celular não cabem: empilhadas no mesmo cartão de altura fixa, a lista comia o
 * topo e as mensagens ficavam numa faixa de 32 px entre o cabeçalho da conversa
 * e a caixa de escrever. Então, abaixo de `lg`, é uma coisa por vez — a lista
 * até o operador tocar numa conversa, e a conversa inteira depois, com um botão
 * de voltar.
 *
 * Módulo próprio pelo motivo de sempre: o vitest roda em `node`, sem jsdom, e
 * função pura aqui é a forma de a decisão ter teste.
 */
export interface InboxPanes {
  /** Classes de exibição da coluna da lista. */
  list: string
  /** Classes de exibição da coluna da conversa. */
  thread: string
}

export function inboxPanes(hasConversation: boolean): InboxPanes {
  return hasConversation
    ? { list: 'hidden lg:flex', thread: 'flex' }
    : { list: 'flex', thread: 'hidden lg:flex' }
}
