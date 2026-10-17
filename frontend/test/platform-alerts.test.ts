import { describe, expect, it } from 'vitest'
import { PLATFORM_ALERT_EVENTS, type PlatformAlertsConfig } from '@/lib/api'
import en from '@/lib/i18n/locales/en'
import {
  ALERT_EVENT_LABELS,
  buildAlertsPatch,
  eventsWithoutChannel,
  toggleChannel
} from '@/lib/platform-alerts'

function config(): PlatformAlertsConfig {
  const events = Object.fromEntries(
    PLATFORM_ALERT_EVENTS.map((e) => [e, { enabled: false, channels: ['whatsapp', 'email'] }])
  ) as PlatformAlertsConfig['events']
  return { events, bigOverdueCents: 50000, dailyDigest: { enabled: false, hour: 8 } }
}

describe('platform alerts', () => {
  it('liga e desliga canal mantendo a ordem', () => {
    expect(toggleChannel(['whatsapp', 'email'], 'whatsapp')).toEqual(['email'])
    expect(toggleChannel(['email'], 'whatsapp')).toEqual(['whatsapp', 'email'])
    expect(toggleChannel([], 'email')).toEqual(['email'])
  })

  it('o patch leva só o que mudou', () => {
    const original = config()
    expect(buildAlertsPatch(original, config(), '500,00')).toEqual({ patch: {}, invalidThreshold: false })

    const draft = config()
    draft.events.card_refused = { enabled: true, channels: ['email'] }
    draft.dailyDigest = { enabled: true, hour: 9 }
    const { patch, invalidThreshold } = buildAlertsPatch(original, draft, '1.234,56')
    expect(invalidThreshold).toBe(false)
    expect(patch).toEqual({
      events: { card_refused: { enabled: true, channels: ['email'] } },
      bigOverdueCents: 123456,
      dailyDigest: { enabled: true, hour: 9 }
    })
  })

  it('recusa limite vazio, zero ou inválido', () => {
    for (const valor of ['', '0', '0,00', 'abc']) {
      expect(buildAlertsPatch(config(), config(), valor).invalidThreshold).toBe(true)
    }
  })

  it('aponta evento ligado sem canal', () => {
    const c = config()
    c.events.nfse_error = { enabled: true, channels: [] }
    c.events.big_overdue = { enabled: false, channels: [] }
    expect(eventsWithoutChannel(c)).toEqual(['nfse_error'])
  })

  it('todo evento tem rótulo traduzido', () => {
    for (const evento of PLATFORM_ALERT_EVENTS) {
      expect(en[ALERT_EVENT_LABELS[evento]]).toBeTruthy()
    }
  })
})
