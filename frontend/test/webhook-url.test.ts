import { describe, expect, it } from 'vitest'

import { absoluteWebhookUrl } from '@/lib/webhook-url'

describe('absoluteWebhookUrl', () => {
  it('completa um caminho solto com a origem da página', () => {
    expect(absoluteWebhookUrl('/api/billing-webhook', 'https://painel.tr69.com.br'))
      .toBe('https://painel.tr69.com.br/api/billing-webhook')
  })

  it('não duplica a barra quando a origem termina com uma', () => {
    expect(absoluteWebhookUrl('/api/billing-webhook', 'https://painel.tr69.com.br/'))
      .toBe('https://painel.tr69.com.br/api/billing-webhook')
  })

  it('deixa como está a URL que o backend já montou inteira', () => {
    expect(absoluteWebhookUrl('https://tr69.com.br/api/billing-webhook', 'https://painel.tr69.com.br'))
      .toBe('https://tr69.com.br/api/billing-webhook')
  })
})
