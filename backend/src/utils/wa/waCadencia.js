/**
 * O ritmo das mensagens automáticas (régua, cobrança avulsa e campanhas).
 *
 * O teto por minuto sozinho não basta: dentro do minuto a passada do outbox
 * mandava as vinte mensagens coladas uma na outra, e rajada é justamente o que
 * o WhatsApp lê como disparo em massa. Aqui mora a regra que espaça uma da
 * outra por um tempo sorteado — sorteado para não desenhar um relógio — e que,
 * a cada tantas, faz uma pausa longa.
 *
 * Pura de propósito: o worker guarda o estado, esta função só decide.
 */

export const CADENCIA_PADRAO = Object.freeze({
  bulkIntervalMinSec: 20,
  bulkIntervalMaxSec: 45,
  bulkBurstSize: 30,
  bulkBurstPauseMin: 5
});

const LIMITES = Object.freeze({
  bulkIntervalMinSec: [5, 600],
  bulkIntervalMaxSec: [5, 600],
  bulkBurstSize: [0, 500],
  bulkBurstPauseMin: [1, 120]
});

function inteiroEntre(valor, [min, max], padrao) {
  const numero = Number(valor);
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(numero)) return padrao;
  return Math.min(Math.max(Math.round(numero), min), max);
}

/**
 * Lê os quatro campos de qualquer origem (o que está gravado, o que veio do
 * formulário) e devolve valores dentro dos limites. O máximo menor que o
 * mínimo vira o mínimo: a pessoa quis um intervalo fixo, não um erro.
 */
export function lerCadencia(entrada = {}, base = CADENCIA_PADRAO) {
  const saida = {};
  for (const campo of Object.keys(CADENCIA_PADRAO)) {
    saida[campo] = inteiroEntre(entrada?.[campo], LIMITES[campo], base[campo]);
  }
  saida.bulkIntervalMaxSec = Math.max(saida.bulkIntervalMaxSec, saida.bulkIntervalMinSec);
  return saida;
}

/** A espera mais longa que a cadência pode pedir, em ms. */
export function esperaMaximaMs(cfg) {
  const c = lerCadencia(cfg);
  return Math.max(c.bulkIntervalMaxSec * 1000, c.bulkBurstPauseMin * 60_000);
}

/**
 * Depois de uma mensagem automática sair: quando pode sair a próxima.
 *
 * @param {{ agora: number, sequencia: number, cfg: object, sorteio?: () => number }} args
 * @returns {{ proximaEm: number, sequencia: number }}
 */
export function proximaVez({ agora, sequencia = 0, cfg, sorteio = Math.random }) {
  const c = lerCadencia(cfg);
  const seguidas = Math.max(0, Number(sequencia) || 0) + 1;
  if (c.bulkBurstSize > 0 && seguidas >= c.bulkBurstSize) {
    return { proximaEm: agora + c.bulkBurstPauseMin * 60_000, sequencia: 0 };
  }
  const faixa = c.bulkIntervalMaxSec - c.bulkIntervalMinSec;
  const segundos = c.bulkIntervalMinSec + faixa * Math.min(Math.max(sorteio(), 0), 1);
  return { proximaEm: agora + Math.round(segundos * 1000), sequencia: seguidas };
}
