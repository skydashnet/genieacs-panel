import { describe, expect, it } from 'vitest'

import en from '@/lib/i18n/locales/en'
import { metaWebhookAuto, metaWebhookState } from '@/lib/meta-webhook'

/**
 * O webhook da Meta de um número oficial, como a tela o mostra.
 *
 * O que se defende: na SaaS (`auto`) a tela não procura URL nem token para
 * copiar, e o erro gravado no número aparece como frase do painel quando é do
 * painel, e como o texto da Meta quando é da Meta.
 */
describe('metaWebhookAuto', () => {
  it('só com auto: true', () => {
    expect(metaWebhookAuto({ cloudWebhook: { auto: true } })).toBe(true)
    expect(metaWebhookAuto({ cloudWebhook: { callbackUrl: 'https://evo/webhook/meta', verifyToken: 'x' } })).toBe(false)
    expect(metaWebhookAuto({})).toBe(false)
    expect(metaWebhookAuto(null)).toBe(false)
  })
})

describe('metaWebhookState', () => {
  it('registrado', () => {
    const s = metaWebhookState({ metaWebhookStatus: 'ok', metaWebhookError: null })
    expect(s.tone).toBe('ok')
    expect(en[s.label]).toBeTruthy()
  })

  it('nunca tentado é pendente', () => {
    expect(metaWebhookState({ metaWebhookStatus: null }).tone).toBe('pending')
    expect(metaWebhookState({}).tone).toBe('pending')
  })

  it('erro do painel vira frase traduzida', () => {
    for (const code of ['meta_webhook_unconfigured', 'meta_unreachable', 'meta_webhook_invalid_account']) {
      const s = metaWebhookState({ metaWebhookStatus: 'error', metaWebhookError: code })
      expect(s.tone).toBe('error')
      expect(s.detailKey).not.toBeNull()
      expect(en[s.detailKey!]).toBeTruthy()
      expect(s.detailText).toBeNull()
    }
  })

  it('erro da Meta sai como a Meta escreveu', () => {
    const s = metaWebhookState({ metaWebhookStatus: 'error', metaWebhookError: '(190) Invalid OAuth access token' })
    expect(s.detailKey).toBeNull()
    expect(s.detailText).toBe('(190) Invalid OAuth access token')
  })

  it('erro sem texto não inventa explicação', () => {
    const s = metaWebhookState({ metaWebhookStatus: 'error', metaWebhookError: '' })
    expect(s.detailKey).toBeNull()
    expect(s.detailText).toBeNull()
  })
})
