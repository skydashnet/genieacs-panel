/**
 * O caminho em que o webhook de entrada é montado, num lugar só.
 *
 * Módulo próprio, sem dependência nenhuma, porque quem precisa dele está nas
 * duas pontas de um ciclo: `app.js` monta a rota, e `whatsappConfigService`
 * confere o endereço público que o operador digitou. Importar um do outro
 * fecharia o ciclo; uma constante isolada não.
 *
 * POR QUE ELE PRECISA SER CONFERIDO
 * ---------------------------------
 * O campo "URL pública do webhook" era conferido só na FORMA — absoluto,
 * http(s), sem credencial — e depois usado como o endereço COMPLETO, com
 * apenas `?t=` acrescentado. Mas o rótulo dizia "URL pública", o marcador de
 * exemplo mostrava `https://painel.exemplo.com` sem caminho nenhum, e a ajuda
 * falava só de hostname. Tudo na tela pedia um host.
 *
 * Quem digitava o host — que é o que a tela mandava — gravava um endereço que
 * aponta para a RAIZ do painel. O Evolution faz POST ali, o frontend responde
 * 200 com HTML, o servidor registra entrega bem-sucedida, e nada chega nunca.
 * Não é erro de quem configurou: é a tela pedindo uma coisa e o código
 * exigindo outra.
 *
 * Isto aconteceu de verdade, num painel em produção, e só apareceu quando a
 * volta (onda 25) respondeu "o host está certo e o caminho não".
 */
export const WA_WEBHOOK_PATH = '/api/whatsapp-webhook';

/**
 * Um endereço público que o Evolution pode chamar, ou a recusa.
 *
 * Duas entradas viram a mesma coisa, e é aí que está o conserto:
 *
 *   - só a origem (`https://painel.exemplo.com`, com ou sem `/`) — o que a
 *     tela pede — recebe o caminho do painel e vira um endereço que funciona;
 *   - um caminho que JÁ termina no do painel passa intacto, o que mantém de pé
 *     quem serve o painel sob um prefixo (`/painel/api/whatsapp-webhook`).
 *
 * Qualquer outro caminho é RECUSADO, e não corrigido em silêncio. Reescrever o
 * que alguém digitou de propósito quebraria quem roteia um caminho próprio
 * para cá; recusar com o sufixo escrito na mensagem custa uma leitura e não
 * esconde nada.
 *
 * @returns {{ url: string }|{ erro: 'path' }}
 */
export function withWebhookPath(origin, pathname) {
  const caminho = String(pathname || '').replace(/\/+$/, '');
  if (!caminho) return { url: `${origin}${WA_WEBHOOK_PATH}` };
  if (caminho.endsWith(WA_WEBHOOK_PATH)) return { url: `${origin}${caminho}` };
  return { erro: 'path' };
}
