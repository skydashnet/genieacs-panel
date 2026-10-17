/**
 * O vocabulário da trilha, traduzido.
 *
 * O backend grava `action` como um código estável — `portal_password.revealed`,
 * `invite.accepted` —, e códigos estáveis são exatamente o que uma tabela lida
 * por um administrador de ISP não deve mostrar. A trilha da plataforma mostra o
 * código cru porque quem a lê é quem opera o SaaS; aqui quem lê é o dono do
 * painel, e para ele `portal_password.revealed` é ruído.
 *
 * O mapa é `Record<string, …>` e não `Record<AcaoConhecida, …>` de propósito:
 * `action` é `varchar(64)` livre no banco e `AuditLog.record` não valida contra
 * `ACTIONS` (`backend/src/models/AuditLog.js`). Uma ação que saiu do enum
 * continua nas linhas antigas, e uma ação nova pode chegar de um backend mais
 * novo que este frontend. Nos dois casos a tela mostra o código cru, que é
 * pouco, mas é mais do que uma célula vazia.
 *
 * O que garante que as ações CONHECIDAS estejam todas aqui não é o tipo: é
 * `frontend/test/audit-actions.test.ts`, que importa `AuditLog.ACTIONS` do
 * backend e compara — o mesmo truque de `frontend/test/permissions.test.ts`,
 * pelo mesmo motivo.
 */

import type { TranslationKey } from '@/lib/i18n/dictionary'

export const AUDIT_ACTION_LABEL_KEYS: Record<string, TranslationKey> = {
  'portal_password.revealed': 'audit.action.portalPasswordRevealed',
  'portal_password.reset': 'audit.action.portalPasswordReset',
  'genieacs.url_changed': 'audit.action.genieacsUrlChanged',
  'genieacs.auth_changed': 'audit.action.genieacsAuthChanged',
  'genieacs.connection_changed': 'audit.action.genieacsConnectionChanged',
  'genieacs.agent_token_generated': 'audit.action.genieacsAgentTokenGenerated',
  'genieacs.ownership_changed': 'audit.action.genieacsOwnershipChanged',
  'operator.role_changed': 'audit.action.operatorRoleChanged',
  'operator.removed': 'audit.action.operatorRemoved',
  'operator.created': 'audit.action.operatorCreated',
  'invite.created': 'audit.action.inviteCreated',
  'invite.accepted': 'audit.action.inviteAccepted',
  'invite.revoked': 'audit.action.inviteRevoked',
  'tenant.status_changed': 'audit.action.tenantStatusChanged',
  'tenant.exported': 'audit.action.tenantExported',
  'tenant.billing_changed': 'audit.action.tenantBillingChanged',
  'customer_data.exported': 'audit.action.customerDataExported',
  'customer_data.erased': 'audit.action.customerDataErased',
  'contact.updated': 'audit.action.contactUpdated',
  'contact.created': 'audit.action.contactCreated',
  'contact.teiah_lookup': 'audit.action.contactTeiahLookup',
  'contact.teiah_applied': 'audit.action.contactTeiahApplied',
  'contact.invoice_sent': 'audit.action.contactInvoiceSent',
  'contact.synced': 'audit.action.contactSynced',
  'contact.invoice_settled': 'audit.action.contactInvoiceSettled',
  'contacts.exported': 'audit.action.contactsExported',
  'devices.exported': 'audit.action.devicesExported',
  'contacts.imported': 'audit.action.contactsImported',
  'subscription.changed': 'audit.action.subscriptionChanged',
  'tenant.renamed': 'audit.action.tenantRenamed',
  'tenant.slug_changed': 'audit.action.tenantSlugChanged',
  'login_email.changed': 'audit.action.loginEmailChanged',
  'login_email.verified': 'audit.action.loginEmailVerified',
  'password_reset.requested': 'audit.action.passwordResetRequested',
  'password_reset.completed': 'audit.action.passwordResetCompleted',
  'platform.impersonated': 'audit.action.platformImpersonated',
  'device.rebooted': 'audit.action.deviceRebooted',
  'device.deleted': 'audit.action.deviceDeleted',
  'device.wan_changed': 'audit.action.deviceWanChanged',
  'device.wan_added': 'audit.action.deviceWanAdded',
  'device.wifi_changed': 'audit.action.deviceWifiChanged',
  'device.credentials_changed': 'audit.action.deviceCredentialsChanged',
  'device.factory_reset': 'audit.action.deviceFactoryReset',
  'device.diagnostic_started': 'audit.action.deviceDiagnosticStarted',
  'device.firmware_upgrade': 'audit.action.deviceFirmwareUpgrade',
  'device.firmware_upload': 'audit.action.deviceFirmwareUpload',
  'device.firmware_delete': 'audit.action.deviceFirmwareDelete',
  'device.batch_action': 'audit.action.deviceBatchAction',
  'user.mfa_enabled': 'audit.action.userMfaEnabled',
  'user.mfa_disabled': 'audit.action.userMfaDisabled',
  'user.mfa_recovery_regenerated': 'audit.action.userMfaRecoveryRegenerated',
  'user.mfa_recovery_used': 'audit.action.userMfaRecoveryUsed',
  'user.account_locked': 'audit.action.userAccountLocked',
  'tenant.mfa_required_changed': 'audit.action.tenantMfaRequiredChanged',
  'operator.mfa_reset': 'audit.action.operatorMfaReset',
  'operator.updated': 'audit.action.operatorUpdated',
  'operator.password_link_issued': 'audit.action.operatorPasswordLinkIssued',
  'operator.password_set': 'audit.action.operatorPasswordSet',
  'operator.sessions_revoked': 'audit.action.operatorSessionsRevoked',
  'subscriber_account.retired': 'audit.action.subscriberAccountRetired',
  'whatsapp.bot_trust_unlock': 'audit.action.whatsappBotTrustUnlock',
  'outage.notified': 'audit.action.outageNotified',
  'whatsapp.invoice_sent': 'audit.action.whatsappInvoiceSent',
  'maintenance.scheduled': 'audit.action.maintenanceScheduled',
  'maintenance.notified': 'audit.action.maintenanceNotified',
  'maintenance.cancelled': 'audit.action.maintenanceCancelled',
  'whatsapp.config_tested': 'audit.action.whatsappConfigTested',
  'focuschat.config_updated': 'audit.action.focusChatConfigUpdated',
  'alerts.telegram_changed': 'audit.action.alertsTelegramChanged',
  'whatsapp.dunning_enabled': 'audit.action.whatsappDunningEnabled',
  'whatsapp.dunning_disabled': 'audit.action.whatsappDunningDisabled',
  'whatsapp.dunning_saved': 'audit.action.whatsappDunningSaved',
  'whatsapp.campaign_created': 'audit.action.whatsappCampaignCreated',
  'whatsapp.campaign_updated': 'audit.action.whatsappCampaignUpdated',
  'whatsapp.referral_updated': 'audit.action.whatsappReferralUpdated',
  'whatsapp.opt_out_changed': 'audit.action.whatsappOptOutChanged',
  'whatsapp.template_ai_draft': 'audit.action.whatsappTemplateAiDraft'
}

/** A chave da frase, ou `null` para a ação que este frontend não conhece. */
export function auditActionLabelKey(action: string): TranslationKey | null {
  return AUDIT_ACTION_LABEL_KEYS[action] ?? null
}
