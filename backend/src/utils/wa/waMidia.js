/**
 * Mídia recebida do WhatsApp: de onde o arquivo pode vir, e de onde não pode.
 *
 * O anexo que chega num evento do Evolution tem até três procedências, e só
 * duas prestam:
 *
 *   base64 no evento   o servidor já baixou e descriptografou. É o caminho bom.
 *                      O GO sempre manda; o v2 manda quando a instância tem
 *                      `webhook.base64` ligado (nosso createInstanceRequest liga).
 *   mediaUrl           o servidor gravou o arquivo num S3/Minio próprio. Também
 *                      presta: é conteúdo claro, num endereço do servidor.
 *   *Message.url       NÃO presta. É o ponteiro para o objeto CIFRADO no CDN do
 *                      WhatsApp, com `.enc` no fim do caminho, que só abre com a
 *                      `mediaKey` da mensagem.
 *
 * No sistema de origem a terceira era tratada como se fosse a primeira. Baixá-la
 * grava bytes ilegíveis; e como o link expira (`oe=` na query), o CDN passa a
 * recusar e o fallback deixa gravado o próprio link temporário. Nas duas pontas
 * dá no mesmo: imagem quebrada e áudio parado em 0:00. Ficou invisível enquanto
 * o servidor era Evolution GO, que nunca expõe essa URL — o dia da migração para
 * o v2 foi o dia em que todo anexo recebido quebrou.
 *
 * Portado de compra-venda `supabase/functions/_shared/wa-midia.ts`.
 */

/**
 * Devolve a URL só quando ela aponta para um arquivo que dá para baixar e usar.
 * Endereço do CDN do WhatsApp vira `null`: o que está lá é cifrado, e fingir que
 * é um anexo apenas empurra o problema para o `<img>` do painel.
 */
export function urlBaixavel(u) {
  if (!u) return null;
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host === 'whatsapp.net' || host.endsWith('.whatsapp.net')) return null;
    return u;
  } catch {
    // Não é URL absoluta: não há o que baixar.
    return null;
  }
}

/**
 * Lê a resposta do `/chat/getBase64FromMediaMessage`. O v2 devolve os campos na
 * raiz; versões anteriores aninham sob `media`. Ler as duas formas custa uma
 * linha e evita que uma atualização do servidor volte a apagar o anexo em
 * silêncio.
 *
 * @returns {{ base64: string, mimetype?: string, fileName?: string }|null}
 */
export function lerMidiaBase64(data) {
  if (!data || typeof data !== 'object') return null;
  const raiz = data;
  const alvo = raiz.media && typeof raiz.media === 'object' ? raiz.media : raiz;

  const base64 = typeof alvo.base64 === 'string' ? alvo.base64.trim() : '';
  if (!base64) return null;

  const out = { base64 };
  if (typeof alvo.mimetype === 'string' && alvo.mimetype) out.mimetype = alvo.mimetype;
  if (typeof alvo.fileName === 'string' && alvo.fileName) out.fileName = alvo.fileName;
  return out;
}
