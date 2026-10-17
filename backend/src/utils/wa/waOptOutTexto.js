/**
 * Reconhece um pedido de "não me mande mais mensagem" numa mensagem recebida.
 *
 * A REGRA: a mensagem INTEIRA tem que ser o pedido. Não é busca por substring.
 *
 * Isso não é preciosismo. No sistema de origem a regra por substring foi medida
 * contra 1.887 mensagens reais de clientes, e "parar" aparece dentro de palavras
 * que são o oposto de um pedido de saída:
 *
 *   "Sim meu jovem, eu queria saber o preço, pra preparar o bolso"
 *   "Passo sim daqui a pouco vou sair"
 *   "Então pode separar"
 *
 * Descadastrar um cliente que estava combinando uma compra é um erro caro e
 * silencioso: ninguém reclama de não receber mensagem, e o número simplesmente
 * some da régua. Falso negativo aqui custa uma mensagem a mais; falso positivo
 * custa o contato.
 *
 * Por isso a lista abaixo é curta e conservadora. "para" solto ficou de fora de
 * propósito — é preposição antes de ser comando.
 */

/** Formas que, sozinhas, são inequivocamente um pedido de saída. */
const PEDIDOS_DE_SAIDA = [
  'sair',
  'parar',
  'pare',
  'stop',
  'cancelar',
  'descadastrar',
  'remover',
  'unsubscribe',
  'sair da lista',
  'nao quero receber',
  'nao quero mais receber',
  'nao quero mais mensagens',
  'nao perturbe',
  'me tira da lista',
  'me remove da lista'
];

/**
 * Reduz a mensagem à sua forma comparável: sem acento, minúscula, sem
 * pontuação, com os espaços colapsados.
 *
 * O acento sai porque "não" e "nao" são a mesma intenção digitada em teclados
 * diferentes; a pontuação sai porque "SAIR!" e "sair." também são.
 */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string|null|undefined} texto corpo da mensagem recebida
 * @returns {boolean} true só quando a mensagem inteira é o pedido
 */
export function pedeSaida(texto) {
  const limpo = normalizar(texto);
  if (!limpo) return false;
  return PEDIDOS_DE_SAIDA.includes(limpo);
}

export { normalizar as normalizarTexto, PEDIDOS_DE_SAIDA };
