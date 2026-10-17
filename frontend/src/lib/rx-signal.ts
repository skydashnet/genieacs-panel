import type { TranslationKey } from '@/lib/i18n'

/**
 * A faixa de um sinal óptico, e como ela aparece — escrita uma vez só.
 *
 * Havia três cópias vivas dos limiares (o `rxBucket` do backend, a lista de
 * equipamentos e a ficha do aparelho) e uma quarta, MORTA, com limiares
 * diferentes (-25/-50/-75): `getSignalStrengthColor`, sem chamador nenhum e
 * com um teste cujo comentário dizia que era "o que o operador lê para decidir
 * se manda alguém no poste". Ninguém lia. Ligada por engano, pintaria de
 * amarelo um aparelho a -30 dBm enquanto o rótulo ao lado dizia a pior faixa.
 *
 * As duas cópias do frontend concordavam nos números e DISCORDAVAM do backend
 * na leitura: `parseFloat` aceita lixo no fim, e `"-25 dBm"` virava -25 e
 * "Ruim" na lista, enquanto o backend lia `Number("-25 dBm")`, NaN, e contava
 * "Desconhecido" no painel. O número do painel e o rótulo da lista que ele
 * abre falavam de faixas diferentes para o mesmo aparelho.
 *
 * Esta função lê como o backend lê. `test/rx-signal.test.ts` importa o
 * `DeviceService.rxBucket` de verdade e exige que os dois concordem em cada
 * borda — é ele que cai no dia em que alguém mexer num lado só.
 */

export type RxBand = 'excellent' | 'good' | 'poor' | 'danger' | 'unknown'

/** A faixa, pelos mesmos limiares e pela mesma leitura de `DeviceService.rxBucket`. */
export function rxBand(value: unknown): RxBand {
  // `Number` e não `parseFloat`: é o que o backend usa, e é o que decide o
  // número do painel. Vazio e só-espaço são ausência de leitura, não zero.
  if (value === null || value === undefined || String(value).trim() === '') return 'unknown'
  const rx = Number(value)
  if (!Number.isFinite(rx)) return 'unknown'
  if (rx >= -21.99) return 'excellent'
  if (rx >= -24.99) return 'good'
  if (rx >= -26.99) return 'poor'
  return 'danger'
}

/** Como cada faixa aparece: cor do número, selo e a frase. */
export const RX_BAND_STYLE: Record<RxBand, { color: string; badgeClass: string; labelKey: TranslationKey }> = {
  excellent: { color: 'text-green-600 dark:text-green-400', badgeClass: 'modern-badge-success', labelKey: 'devices.signal.excellent' },
  good: { color: 'text-blue-600 dark:text-blue-400', badgeClass: 'modern-badge-info', labelKey: 'devices.signal.good' },
  poor: { color: 'text-yellow-600 dark:text-yellow-400', badgeClass: 'modern-badge-warning', labelKey: 'devices.signal.poor' },
  danger: { color: 'text-red-600 dark:text-red-400', badgeClass: 'modern-badge-error', labelKey: 'devices.signal.danger' },
  unknown: { color: 'text-gray-500 dark:text-gray-400', badgeClass: 'modern-badge', labelKey: 'common.na' }
}
