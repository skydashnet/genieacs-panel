import { describe, expect, it } from 'vitest'
import { metaWindowFor } from './wa-meta-window'

const agora = Date.UTC(2026, 9, 1, 12)
const horasAtras = (h: number) => new Date(agora - h * 3_600_000).toISOString()
const cloud = { id: 1, integration: 'cloud' as const }

describe('metaWindowFor', () => {
  it('número por QR não tem janela', () => {
    expect(metaWindowFor({ id: 1, integration: 'baileys' }, { accountId: 1, lastInboundAt: null }, agora)).toBeNull()
  })

  it('aberta mostra as horas que faltam, já com a folga', () => {
    expect(metaWindowFor(cloud, { accountId: 1, lastInboundAt: horasAtras(2) }, agora))
      .toEqual({ state: 'open', hoursLeft: 22 })
  })

  it('fecha sem resposta do cliente, depois de 24 h, ou em outro número', () => {
    expect(metaWindowFor(cloud, { accountId: 1, lastInboundAt: null }, agora)).toEqual({ state: 'closed' })
    expect(metaWindowFor(cloud, { accountId: 1, lastInboundAt: horasAtras(24) }, agora)).toEqual({ state: 'closed' })
    expect(metaWindowFor(cloud, { accountId: 2, lastInboundAt: horasAtras(1) }, agora)).toEqual({ state: 'closed' })
  })
})
