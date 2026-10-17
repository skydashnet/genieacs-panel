import type { WhatsAppAccount, WhatsAppConfig } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'

/**
 * O webhook da Meta de um número oficial, como a tela o mostra.
 *
 * Na SaaS o painel registra o webhook na conta WABA sozinho (o token de
 * verificação do servidor não sai para o provedor) e a configuração diz isso
 * com `cloudWebhook.auto`. No self-host continua a cópia manual da URL e do
 * token, e o resultado do registro automático aparece junto.
 */

/** Se o webhook é registrado pelo painel, sem URL nem token para copiar. */
export function metaWebhookAuto(config?: Pick<WhatsAppConfig, 'cloudWebhook'> | null): boolean {
  return config?.cloudWebhook?.auto === true
}

/** Os erros que o próprio painel produz, com frase traduzida; o resto é texto da Meta. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  meta_webhook_unconfigured: 'whatsapp.cloud.webhookUnconfigured',
  meta_unreachable: 'whatsapp.cloud.webhookUnreachable',
  meta_webhook_invalid_account: 'whatsapp.cloud.webhookInvalidAccount',
  meta_webhook_failed: 'whatsapp.error.metaWebhookFailed'
}

export type MetaWebhookState =
  | { tone: 'ok'; label: TranslationKey; detailKey: null; detailText: null }
  | { tone: 'error'; label: TranslationKey; detailKey: TranslationKey | null; detailText: string | null }
  | { tone: 'pending'; label: TranslationKey; detailKey: null; detailText: null }

/** O selo e a explicação do registro do webhook de um número. */
export function metaWebhookState(
  account: Pick<WhatsAppAccount, 'metaWebhookStatus' | 'metaWebhookError'>
): MetaWebhookState {
  if (account.metaWebhookStatus === 'ok') {
    return { tone: 'ok', label: 'whatsapp.cloud.webhookOk', detailKey: null, detailText: null }
  }
  if (account.metaWebhookStatus === 'error') {
    const raw = (account.metaWebhookError ?? '').trim()
    const key = ERROR_KEYS[raw] ?? null
    return {
      tone: 'error',
      label: 'whatsapp.cloud.webhookError',
      detailKey: key,
      detailText: key ? null : raw || null
    }
  }
  return { tone: 'pending', label: 'whatsapp.cloud.webhookPending', detailKey: null, detailText: null }
}
