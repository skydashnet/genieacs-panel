import { BrandMark } from '@/components/brand-mark'
import { MfaCard } from '@/components/mfa-card'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { useTenant } from '@/contexts/tenant-context'

/**
 * A casca do painel enquanto a pessoa não ativa o 2FA que o provedor exige.
 *
 * Toma o lugar do menu e das telas, e não é uma rota: o servidor recusa tudo o
 * que não for a própria conta, então qualquer tela que abrisse mostraria só
 * recusas. Ativar é o `MfaCard` de sempre; sair daqui só depois de a pessoa
 * dizer que guardou os códigos de recuperação, que é quando a conta é relida e
 * a marca some.
 */
export function MfaEnrollmentScreen() {
  const { t } = useTranslation()
  const { user, refreshUser, logout } = useAuth()
  const { name: tenantName } = useTenant()
  const provedor = user?.tenant?.name || tenantName

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="size-10 shrink-0" />
            <span className="min-w-0 font-semibold text-foreground wrap-anywhere">{provedor}</span>
          </div>
          <button type="button" className="modern-button-secondary shrink-0 whitespace-nowrap" onClick={logout}>
            <Icon name="logout" size={16} /> {t('mfaEnrollment.logout')}
          </button>
        </div>
        <div className="modern-card space-y-4 p-5 sm:p-6">
          <div>
            <h1 className="section-heading">{t('mfaEnrollment.title')}</h1>
            <p className="section-description mt-1">{t('mfaEnrollment.description', { name: provedor })}</p>
          </div>
          <MfaCard onRecoveryCodesSaved={() => void refreshUser()} />
          <p className="field-hint">{t('mfaEnrollment.lostPhone')}</p>
        </div>
      </div>
    </div>
  )
}
