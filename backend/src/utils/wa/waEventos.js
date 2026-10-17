/**
 * Canonicalização do nome do evento.
 *
 * Os dois servidores nomeiam as mesmas quatro coisas de formas diferentes — o
 * v2 usa `messages.upsert`, o GO usa `Message`, e o GO ainda quebra "conexão"
 * em cinco eventos distintos (`Connected`, `PairSuccess`, `LoggedOut`,
 * `Disconnected`, `ConnectFailure`). Traduzir na entrada é o que permite ao
 * resto do código ter quatro ramos em vez de doze.
 *
 * Portado do whatsapp-evolution-webhook do compra-venda.
 */

/** Os quatro eventos que o painel entende. */
export const EVENTOS = Object.freeze({
  QR: 'qrcode_updated',
  CONEXAO: 'connection_update',
  MENSAGEM: 'messages_upsert',
  RECIBO: 'messages_update'
});

export function canonicalizarEvento(nome) {
  const cru = String(nome ?? '').toLowerCase().replace(/\./g, '_');
  if (cru === 'qrcode') return EVENTOS.QR;
  if (
    cru === 'connected'
    || cru === 'pairsuccess'
    || cru === 'loggedout'
    || cru === 'disconnected'
    || cru === 'connectfailure'
    || cru === 'temporaryban'
  ) {
    return EVENTOS.CONEXAO;
  }
  if (cru === 'message' || cru === 'sendmessage') return EVENTOS.MENSAGEM;
  if (cru === 'receipt') return EVENTOS.RECIBO;
  return cru;
}
