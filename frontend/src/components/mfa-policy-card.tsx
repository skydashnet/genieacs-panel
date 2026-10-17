import { useCallback, useEffect, useState } from 'react'
import { tenantAPI, type TenantSecurity } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { mfaPolicyState } from '@/lib/mfa-enrollment'

/**
 * A exigência do login em duas etapas para a equipe inteira.
 *
 * Quem pode mudar é o dono (ou o admin onde não há dono) — o servidor decide e
 * diz em `canChange`; os outros veem só o estado. Ligar pede que quem liga já
 * use o 2FA, e o cartão avisa antes em vez de deixar o servidor recusar.
 */
export function MfaPolicyCard({ selfMfaEnabled }: { selfMfaEnabled: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [security, setSecurity] = useState<TenantSecurity | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    try {
      const res = await tenantAPI.security()
      if (res.success && res.data) setSecurity(res.data)
    } catch {
      /* sem o estado, o cartão não aparece; nada do resto da tela depende dele */
    }
  }, [])

  useEffect(() => {
    void carregar()
  }, [carregar])

  if (!security) return null

  const estado = mfaPolicyState(security, selfMfaEnabled)
  const ligado = security.requireMfa

  const alternar = async () => {
    const pedido = !ligado
    if (pedido && !confirm(t('settings.mfaPolicy.confirmOn', { count: String(security.membersWithoutMfa) }))) return
    setOcupado(true)
    try {
      const res = await tenantAPI.updateSecurity(pedido)
      if (res.success) {
        toast.success(pedido ? t('settings.mfaPolicy.turnedOn') : t('settings.mfaPolicy.turnedOff'))
        await carregar()
      } else {
        toast.error(res.message || t('settings.mfaPolicy.failed'))
      }
    } finally {
      setOcupado(false)
    }
  }

  return (
    <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-foreground">
            <Icon name="contacts" size={17} />
            {t('settings.mfaPolicy.title')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.mfaPolicy.description')}</p>
        </div>
        <span className={ligado ? 'modern-badge-success' : 'modern-badge'}>
          {ligado ? t('settings.mfaPolicy.on') : t('settings.mfaPolicy.off')}
        </span>
      </div>
      <p className="mt-3 text-sm text-foreground">
        {security.membersWithoutMfa === 0
          ? t('settings.mfaPolicy.everyoneHasIt')
          : t('settings.mfaPolicy.missing', { count: String(security.membersWithoutMfa) })}
      </p>
      {estado === 'readonly' && (
        <p className="field-hint mt-2">{t('settings.mfaPolicy.ownerOnly')}</p>
      )}
      {estado === 'needs_self_mfa' && (
        <p className="field-hint mt-2">{t('settings.mfaPolicy.enableYourselfFirst')}</p>
      )}
      {estado !== 'readonly' && (
        <div className="mt-3">
          <button
            type="button"
            className={ligado ? 'modern-button-secondary' : 'modern-button'}
            disabled={ocupado || estado === 'needs_self_mfa'}
            onClick={() => void alternar()}
          >
            {ligado ? t('settings.mfaPolicy.turnOff') : t('settings.mfaPolicy.turnOn')}
          </button>
        </div>
      )}
    </section>
  )
}
