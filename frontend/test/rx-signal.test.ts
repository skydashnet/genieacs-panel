import { describe, expect, it } from 'vitest'

import { RX_BAND_STYLE, rxBand, type RxBand } from '@/lib/rx-signal'
import en from '@/lib/i18n/locales/en'

/**
 * A faixa de um sinal óptico, igual dos dois lados da fronteira.
 *
 * O painel CONTA pelo `DeviceService.rxBucket` do backend, e a lista de
 * equipamentos e a ficha ROTULAM por esta função. Se discordarem, o operador
 * clica em "3 com sinal fraco", vê o rótulo "Bom" num deles e conclui que o
 * número mente. O PR #135 juntou as faixas do painel e do recorte da lista num
 * lugar só no backend; este arquivo faz o mesmo através da fronteira.
 *
 * O módulo do backend é importado por caminho calculado, no molde de
 * `audit-actions.test.ts`: é o `rxBucket` de verdade, e não uma cópia dele.
 */
const backendUrl = new URL('../../backend/src/services/deviceService.js', import.meta.url).href
const { default: DeviceService } = (await import(/* @vite-ignore */ backendUrl)) as {
  default: { rxBucket: (value: unknown) => string }
}

describe('a faixa, pela borda', () => {
  it('cada limiar cai do lado certo', () => {
    const casos: Array<[number, RxBand]> = [
      [-10, 'excellent'], [-21.99, 'excellent'],
      [-22, 'good'], [-24.99, 'good'],
      [-25, 'poor'], [-26.99, 'poor'],
      [-27, 'danger'], [-40, 'danger']
    ]
    for (const [rx, faixa] of casos) expect(rxBand(rx), String(rx)).toBe(faixa)
  })

  it('leitura ausente é desconhecida, e não zero', () => {
    // `Number('')` é zero, e zero dBm é "excelente" — um aparelho que não
    // respondeu nada apareceria como o melhor sinal da rede.
    for (const vazio of [null, undefined, '', '   ']) expect(rxBand(vazio), String(vazio)).toBe('unknown')
  })

  /**
   * O caso que as duas cópias antigas erravam.
   *
   * `parseFloat` aceita lixo no fim: `"-25 dBm"` virava -25 e "Ruim" na lista,
   * enquanto o backend contava "Desconhecido" no painel. Mesmo aparelho, duas
   * faixas.
   */
  it('lê como o backend lê: texto com unidade não é número', () => {
    expect(rxBand('-25 dBm')).toBe('unknown')
    expect(rxBand('abc')).toBe('unknown')
    expect(rxBand('-25')).toBe('poor')
  })
})

describe('a mesma faixa dos dois lados da fronteira', () => {
  /**
   * A prova que amarra as duas pontas.
   *
   * Uma varredura densa em volta de cada limiar, mais os textos que chegam do
   * GenieACS como chegam. Mexer num limiar de um lado só — ou trocar `Number`
   * por `parseFloat` de um lado só — derruba este caso.
   */
  it('concorda com o DeviceService.rxBucket em cada valor', () => {
    const valores: unknown[] = [null, undefined, '', '  ', 'abc', '-25 dBm', '-25', ' -25 ', 0, '0', -99]
    for (const limiar of [-21.99, -24.99, -26.99]) {
      for (let d = -0.05; d <= 0.05 + 1e-9; d += 0.01) {
        const v = Math.round((limiar + d) * 100) / 100
        valores.push(v, String(v))
      }
    }
    for (const v of valores) {
      expect(rxBand(v), JSON.stringify(v)).toBe(DeviceService.rxBucket(v).toLowerCase())
    }
  })
})

describe('como cada faixa aparece', () => {
  it('toda faixa tem estilo, e toda frase existe no dicionário', () => {
    for (const faixa of ['excellent', 'good', 'poor', 'danger', 'unknown'] as const) {
      const estilo = RX_BAND_STYLE[faixa]
      expect(estilo, faixa).toBeTruthy()
      expect(en[estilo.labelKey], estilo.labelKey).toBeTruthy()
    }
  })
})
