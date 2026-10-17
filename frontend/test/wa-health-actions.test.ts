import { describe, expect, it } from 'vitest'

import type { WhatsAppHealth } from '@/lib/api'
import { healthActions } from '@/lib/wa-health-actions'

/**
 * Os botões de manutenção só aparecem quando podem fazer alguma coisa.
 *
 * Eles ocupavam uma fileira inteira do topo da página na situação mais comum —
 * zero falhas e retenção "sem prazo" —, em que um não tinha o que reenviar e o
 * outro não apagava nada.
 */
const saude = (
  failed24h: number,
  mediaDays: number,
  files: number
): Pick<WhatsAppHealth, 'outbox' | 'media' | 'retention'> => ({
  outbox: { queued: 0, retrying: 0, sending: 0, failed24h, oldestQueuedAt: null },
  media: { files, bytes: files * 1024, oldestAt: null },
  retention: { mediaDays, messageDays: 0 }
})

describe('reenviar as que falharam', () => {
  it('some sem falha nas últimas 24 h', () => {
    expect(healthActions(saude(0, 30, 7)).requeue).toBe(false)
  })

  it('e aparece com uma', () => {
    expect(healthActions(saude(1, 0, 0)).requeue).toBe(true)
  })
})

describe('apagar os anexos antigos', () => {
  it('some com a retenção "sem prazo" — o caso da captura, em que o varredor não apaga nada', () => {
    expect(healthActions(saude(0, 0, 7)).sweep).toBe(false)
  })

  it('some com prazo e nenhum arquivo', () => {
    expect(healthActions(saude(0, 30, 0)).sweep).toBe(false)
  })

  it('e aparece com prazo e arquivo', () => {
    expect(healthActions(saude(0, 30, 7)).sweep).toBe(true)
  })
})
