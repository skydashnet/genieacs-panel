import { describe, expect, it } from 'vitest'

import { informedRecently, serialMatches, summonDeferredMessage } from '@/lib/device-actions'

/**
 * A confirmação do reset de fábrica: o botão só se acende com a série DESTE
 * aparelho digitada. A regra é a mesma do backend, que confere de novo.
 */
describe('a série que confirma o reset', () => {
  it('aceita a série certa, sem ligar para maiúsculas nem espaços nas pontas', () => {
    expect(serialMatches('ZTEG12345678', 'ZTEG12345678', 'ONT-1')).toBe(true)
    expect(serialMatches('  zteg12345678 ', 'ZTEG12345678', 'ONT-1')).toBe(true)
  })

  it('recusa outra série, uma parte dela, e o vazio', () => {
    expect(serialMatches('ZTEG00000000', 'ZTEG12345678', 'ONT-1')).toBe(false)
    expect(serialMatches('ZTEG1234', 'ZTEG12345678', 'ONT-1')).toBe(false)
    expect(serialMatches('', 'ZTEG12345678', 'ONT-1')).toBe(false)
    expect(serialMatches('   ', 'ZTEG12345678', 'ONT-1')).toBe(false)
  })

  it('sem série no ACS, vale o id do aparelho — e não o vazio', () => {
    expect(serialMatches('ONT-1', null, 'ONT-1')).toBe(true)
    expect(serialMatches('', null, 'ONT-1')).toBe(false)
    expect(serialMatches('', '', '')).toBe(false)
  })
})

/**
 * O aviso da remoção do GenieACS: uma ONT que informou há pouco provavelmente
 * ainda está ligada, e se cadastra de novo no próximo inform.
 */
describe('a ONT que informou há pouco', () => {
  const agora = Date.parse('2026-09-26T12:00:00Z')

  it('é a que informou nos últimos 10 minutos', () => {
    expect(informedRecently('2026-09-26T11:55:00Z', agora)).toBe(true)
    expect(informedRecently('2026-09-26T11:50:00Z', agora)).toBe(false)
  })

  it('não inventa aviso sem data, com data inválida ou no futuro', () => {
    expect(informedRecently(null, agora)).toBe(false)
    expect(informedRecently('ontem', agora)).toBe(false)
    expect(informedRecently('2026-09-26T12:05:00Z', agora)).toBe(false)
  })
})

describe('summonDeferredMessage', () => {
  const t = (key: string, vars?: Record<string, string | number>) => `${key}|${vars?.time ?? ''}`
  const format = (value: string) => `fmt(${value})`

  it('says since when an ONT silent for days has not informed', () => {
    expect(summonDeferredMessage({ lastInform: '2026-09-14T11:52:39Z', stale: true }, t, format, 'fallback'))
      .toBe('devices.summon.deferredStale|fmt(2026-09-14T11:52:39Z)')
  })

  it('gives the last Inform of an ONT that is only unreachable right now', () => {
    expect(summonDeferredMessage({ lastInform: '2026-09-27T10:00:00Z', stale: false }, t, format, 'fallback'))
      .toBe('devices.summon.deferredSince|fmt(2026-09-27T10:00:00Z)')
  })

  it('keeps the server text when there is no date', () => {
    expect(summonDeferredMessage({ lastInform: null }, t, format, 'fallback')).toBe('fallback')
    expect(summonDeferredMessage(undefined, t, format, 'fallback')).toBe('fallback')
  })
})
