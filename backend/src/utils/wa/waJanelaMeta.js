/**
 * A janela de 24 horas da API oficial da Meta.
 *
 * Num número oficial, texto livre só é aceito até 24 h depois da última
 * mensagem DO CLIENTE naquele número. Fora disso, a Meta só entrega modelo
 * aprovado (template) — e recusa o resto com o erro 131047, muitas vezes
 * depois de ter aceitado o envio.
 *
 * Puro de propósito: é a regra que decide se a mensagem sai, sai como modelo
 * ou nem entra na fila, e uma regra dessas tem de poder ser travada em teste.
 *
 * Não muda nada para o número pareado por QR: lá não existe janela.
 */

export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Folga contra a fila: a mensagem enfileirada com a janela aberta pode sair
 * minutos depois (ritmo de campanha, nova tentativa), e chegar à Meta já com
 * a janela fechada.
 */
export const META_WINDOW_MARGIN_MS = 30 * 60 * 1000;

/** Quando a janela fecha, ou null se ela não está aberta. */
export function fimDaJanela(lastInboundAt) {
  if (!lastInboundAt) return null;
  const inicio = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(inicio)) return null;
  return new Date(inicio + META_WINDOW_MS);
}

/**
 * Como esta mensagem pode sair.
 *
 * `sameAccount` é se o número que vai enviar é o da conversa: a última
 * mensagem do cliente vale para o número que a RECEBEU. Se a fila desviou para
 * outro número (o da conversa caiu), a janela daquele não serve para este.
 *
 * @returns {'text'|'template'|'refuse'}
 */
export function decidirEnvioCloud({
  isCloud,
  sameAccount = true,
  lastInboundAt = null,
  hasTemplate = false,
  now = Date.now(),
  marginMs = META_WINDOW_MARGIN_MS
} = {}) {
  if (!isCloud) return 'text';
  const fim = sameAccount ? fimDaJanela(lastInboundAt) : null;
  const agora = now instanceof Date ? now.getTime() : Number(now);
  if (fim && agora < fim.getTime() - marginMs) return 'text';
  return hasTemplate ? 'template' : 'refuse';
}
