/**
 * Quantas mensagens automáticas saem por hora no ritmo escolhido, em média:
 * o intervalo médio entre elas e, a cada lote, a pausa longa no lugar de um
 * intervalo. É a conta que a pessoa precisa para saber se a régua cabe no dia.
 */
export function bulkPerHour(pace: {
  bulkIntervalMinSec: number
  bulkIntervalMaxSec: number
  bulkBurstSize: number
  bulkBurstPauseMin: number
}): number {
  const min = Math.max(pace.bulkIntervalMinSec, 1)
  const average = (min + Math.max(pace.bulkIntervalMaxSec, min)) / 2
  if (pace.bulkBurstSize <= 0) return Math.round(3600 / average)
  const cycle = (pace.bulkBurstSize - 1) * average + pace.bulkBurstPauseMin * 60
  return Math.round((3600 * pace.bulkBurstSize) / cycle)
}
