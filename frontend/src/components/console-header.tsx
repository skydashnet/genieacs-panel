'use client'

import { useAuth } from '@/contexts/auth-context'
import { BrandMark } from '@/components/brand-mark'
import { Icon } from '@/components/ui/icon'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'

/**
 * A barra do console — o pouco que a casca da plataforma precisa ter.
 *
 * A casca de um provedor tem barra lateral com a operação inteira; aqui não há
 * operação, há uma tela só (as quatro abas de `/platform`). O que faltaria sem
 * esta barra é o básico de uma sessão: dizer quem está logado e permitir sair.
 *
 * Diz PLATAFORMA e não o nome de um provedor, de propósito: este endereço não é
 * o painel de ninguém, e escrever um nome de provedor aqui seria a mesma
 * confusão que a faixa vermelha da personificação existe para evitar.
 */
export function ConsoleHeader() {
  const { user, logout } = useAuth()
  const { t } = useTranslation()

  return (
    <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
      <BrandMark className="size-9 shrink-0" />
      <div className="min-w-0">
        <div className="truncate text-sm font-bold leading-tight text-foreground">{t('console.header')}</div>
        {/* Quem está aqui, no mesmo lugar em que o menu do provedor diz
            "Provedor · slug": esta sessão não é de provedor nenhum. */}
        <div className="mt-0.5 flex items-center gap-1 text-[0.62rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          <Icon name="lock" size={11} className="shrink-0" />
          <span className="truncate">{t('sidebar.platformAdmin')}</span>
        </div>
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-2 sm:gap-3">
        <LanguageSwitcher collapseOnMobile />
        {user?.username && (
          <span className="hidden max-w-64 truncate text-sm text-muted-foreground lg:inline">{user.username}</span>
        )}
        <button
          type="button"
          onClick={logout}
          className="modern-button-secondary"
          aria-label={t('sidebar.signOut')}
        >
          <Icon name="logout" size={17} />
          <span className="hidden sm:inline">{t('sidebar.signOut')}</span>
        </button>
      </div>
    </header>
  )
}

export default ConsoleHeader
