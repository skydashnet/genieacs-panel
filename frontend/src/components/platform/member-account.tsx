'use client'

import { useState } from 'react'
import {
  platformAPI,
  type MemberPasswordLink,
  type OperatorRole,
  type Tenant,
  type TenantMembership
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { OPERATOR_ROLES, ROLE_LABEL_KEYS } from '@/lib/permissions'
import { panelLink } from '@/lib/panel-link'
import { formatPhone, whatsappShareUrl } from '@/lib/whatsapp-share'

interface Props {
  tenant: Tenant
  member: TenantMembership
  busy: boolean
  onUpdated: (member: TenantMembership) => void
  onRemove: (member: TenantMembership) => void
}

type Painel = 'edit' | 'access' | null

/**
 * Uma pessoa da equipe de um provedor, vista do console.
 *
 * Além de remover, dá para editar a conta (login, e-mail, telefone, papel) e
 * cuidar do acesso: um link novo de definir senha — copiado, mandado pelo
 * WhatsApp de quem opera ou por e-mail —, a senha definida na hora e o fim de
 * todas as sessões.
 *
 * O link aparece UMA vez, como na criação: o banco guarda só o hash, e nem a
 * trilha nem o WhatsApp da plataforma o guardam. O botão do WhatsApp só abre o
 * `wa.me` com o texto pronto; quem envia é quem está na tela.
 */
export function MemberAccount({ tenant, member, busy, onUpdated, onRemove }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const [painel, setPainel] = useState<Painel>(null)
  const [form, setForm] = useState({
    username: member.username,
    email: member.email ?? '',
    phone: member.phone ?? '',
    role: member.role as OperatorRole
  })
  const [salvando, setSalvando] = useState(false)
  const [link, setLink] = useState<MemberPasswordLink | null>(null)
  const [gerando, setGerando] = useState(false)
  const [senha, setSenha] = useState('')
  const [definindo, setDefinindo] = useState(false)

  const roleLabel = (role: OperatorRole) => t(ROLE_LABEL_KEYS[role])
  const idBase = `member-${tenant.id}-${member.userId}`

  const alternar = (qual: Exclude<Painel, null>) => {
    setPainel((atual) => (atual === qual ? null : qual))
    if (qual === 'edit') {
      setForm({
        username: member.username,
        email: member.email ?? '',
        phone: member.phone ?? '',
        role: member.role
      })
    }
  }

  const salvar = async () => {
    const username = form.username.trim()
    const email = form.email.trim()
    if (username.length < 3) {
      toast.error(t('platform.member.usernameShort'))
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error(t('settings.operators.emailInvalid'))
      return
    }
    setSalvando(true)
    try {
      const res = await platformAPI.updateMembership(tenant.id, member.userId, {
        username,
        email,
        phone: form.phone.trim(),
        role: form.role
      })
      if (!res.success || !res.data) {
        if (res.code === 'username_taken') toast.error(t('platform.operator.usernameTaken'))
        else if (res.code === 'email_taken') toast.error(t('platform.operator.emailTaken'))
        else if (res.code === 'invalid_phone') toast.error(t('platform.member.phoneInvalid'))
        else toast.error(res.message || t('platform.saveFailed'))
        return
      }
      onUpdated(res.data.membership)
      toast.success(t(res.data.sharedAccount ? 'platform.member.savedShared' : 'platform.member.saved'))
      setPainel(null)
    } finally {
      setSalvando(false)
    }
  }

  const gerarLink = async (sendEmail: boolean) => {
    if (sendEmail && !member.email) {
      toast.error(t('platform.member.noEmail'))
      return
    }
    setGerando(true)
    try {
      const res = await platformAPI.memberPasswordLink(tenant.id, member.userId, sendEmail)
      if (!res.success || !res.data) {
        toast.error(res.message || t('platform.saveFailed'))
        return
      }
      setLink(res.data)
      if (sendEmail) {
        toast[res.data.emailed ? 'success' : 'error'](
          t(res.data.emailed ? 'platform.member.linkEmailed' : 'platform.member.linkNotEmailed')
        )
      }
    } finally {
      setGerando(false)
    }
  }

  const definirSenha = async () => {
    if (senha.length < 8) {
      toast.error(t('platform.operator.passwordShort'))
      return
    }
    if (!window.confirm(t('platform.member.setPasswordConfirm', { username: member.username }))) return
    setDefinindo(true)
    try {
      const res = await platformAPI.setMemberPassword(tenant.id, member.userId, senha)
      if (res.success) {
        setSenha('')
        toast.success(t('platform.member.passwordSet'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setDefinindo(false)
    }
  }

  const encerrarSessoes = async () => {
    if (!window.confirm(t('platform.member.revokeConfirm', { username: member.username }))) return
    const res = await platformAPI.revokeMemberSessions(tenant.id, member.userId)
    if (res.success) toast.success(t('platform.member.sessionsRevoked'))
    else toast.error(res.message || t('platform.saveFailed'))
  }

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      toast.success(t('common.copied'))
    } catch {
      // Sem permissão de área de transferência, o link fica na tela para ser
      // selecionado à mão.
    }
  }

  const textoLink = link ? panelLink(link.url, link.token, '/reset-password') : ''
  const mensagem = t('platform.member.whatsappMessage', {
    username: member.username,
    provider: tenant.name,
    url: textoLink
  })

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="break-all text-sm font-medium">{member.username}</span>
          <span className="modern-badge ms-2">{roleLabel(member.role)}</span>
          {(member.email || member.phone) && (
            <span className="block break-all text-xs text-muted-foreground">
              {[member.email, formatPhone(member.phone)].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="modern-button-secondary"
            aria-expanded={painel === 'edit'}
            onClick={() => alternar('edit')}
          >
            <Icon name="edit" size={16} />
            {t('common.edit')}
          </button>
          <button
            type="button"
            className="modern-button-secondary"
            aria-expanded={painel === 'access'}
            onClick={() => alternar('access')}
          >
            <Icon name="lock" size={16} />
            {t('platform.member.access')}
          </button>
          <button
            type="button"
            onClick={() => onRemove(member)}
            disabled={busy}
            className="inline-flex size-10 items-center justify-center rounded-md text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
            title={t('platform.removeMember')}
            aria-label={t('platform.removeMember')}
          >
            <Icon name="logout" size={18} />
          </button>
        </span>
      </div>

      {painel === 'edit' && (
        <div className="mt-3 space-y-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor={`${idBase}-username`} className="block text-sm font-medium mb-1">
                {t('settings.operators.username')}
              </label>
              <input
                id={`${idBase}-username`}
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                className="modern-input w-full"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor={`${idBase}-email`} className="block text-sm font-medium mb-1">
                {t('settings.operators.email')}
              </label>
              <input
                id={`${idBase}-email`}
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className="modern-input w-full"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor={`${idBase}-phone`} className="block text-sm font-medium mb-1">
                {t('platform.member.phone')}
              </label>
              <input
                id={`${idBase}-phone`}
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className="modern-input w-full"
                placeholder="(11) 98765-4321"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor={`${idBase}-role`} className="block text-sm font-medium mb-1">
                {t('settings.operators.role')}
              </label>
              <select
                id={`${idBase}-role`}
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as OperatorRole }))}
                className="modern-input w-full"
              >
                {OPERATOR_ROLES.map((role) => (
                  <option key={role} value={role}>{roleLabel(role)}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="field-hint">{t('platform.member.editHint')}</p>
          <div className="flex gap-2">
            <button type="button" className="modern-button" disabled={salvando} onClick={() => void salvar()}>
              {salvando ? t('common.saving') : t('common.save')}
            </button>
            <button type="button" className="modern-button-secondary" onClick={() => setPainel(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {painel === 'access' && (
        <div className="mt-3 space-y-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3">
          <div>
            <h5 className="text-sm font-semibold text-foreground">{t('platform.member.linkTitle')}</h5>
            <p className="mt-1 text-sm text-muted-foreground">{t('platform.member.linkDescription')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="modern-button"
                disabled={gerando}
                onClick={() => void gerarLink(false)}
              >
                <Icon name="refresh" size={16} />
                {t('platform.member.generateLink')}
              </button>
              <button
                type="button"
                className="modern-button-secondary"
                disabled={gerando || !member.email}
                onClick={() => void gerarLink(true)}
                title={member.email ? undefined : t('platform.member.noEmail')}
              >
                {t('platform.member.emailLink')}
              </button>
            </div>

            {link && (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-muted-foreground">{t('invite.onceOnly')}</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input className="modern-input flex-1 font-mono text-xs" readOnly value={textoLink} />
                  <button
                    type="button"
                    className="modern-button-secondary shrink-0"
                    onClick={() => void copiar(textoLink)}
                  >
                    <Icon name="copy" size={17} />
                    {t('common.copy')}
                  </button>
                  <a
                    href={whatsappShareUrl(member.phone, mensagem)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="modern-button shrink-0"
                  >
                    <Icon name="chat" size={17} />
                    {t('platform.member.sendWhatsapp')}
                  </a>
                </div>
                {!member.phone && <p className="field-hint">{t('platform.member.noPhone')}</p>}
                {link.url === null && <p className="field-hint">{t('platform.linkFromThisAddress')}</p>}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-3">
            <h5 className="text-sm font-semibold text-foreground">{t('platform.member.setPasswordTitle')}</h5>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                className="modern-input sm:w-72"
                autoComplete="new-password"
                aria-label={t('settings.operators.password')}
                placeholder={t('settings.operators.password')}
              />
              <button
                type="button"
                className="modern-button-secondary"
                disabled={definindo || senha.length === 0}
                onClick={() => void definirSenha()}
              >
                {definindo ? t('common.saving') : t('platform.member.setPassword')}
              </button>
            </div>
            <p className="field-hint">{t('platform.member.setPasswordHint')}</p>
          </div>

          <div className="border-t border-border pt-3">
            <h5 className="text-sm font-semibold text-foreground">{t('platform.member.sessionsTitle')}</h5>
            <p className="mt-1 text-sm text-muted-foreground">{t('platform.member.sessionsDescription')}</p>
            <button
              type="button"
              className="modern-button-secondary mt-2 text-destructive"
              onClick={() => void encerrarSessoes()}
            >
              <Icon name="power" size={16} />
              {t('platform.member.revokeSessions')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

export default MemberAccount
