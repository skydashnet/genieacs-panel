'use client'

import { useState } from 'react'
import { invitesAPI } from '@/lib/api'
import { ROLE_LABEL_KEYS, type OperatorRole } from '@/lib/permissions'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * Convidar alguém, que é a alternativa a escolher a senha de outra pessoa.
 *
 * A API do convite existe desde a onda 18 e não tinha tela: quem administra
 * criava operador pelo formulário ao lado, digitando uma senha que ele mesmo
 * escolhia e teria que transmitir de algum jeito. O convite é o caminho certo
 * para as duas situações que aquele formulário não resolve — o consultor que já
 * tem conta noutro provedor, e o colega que deve escolher a própria senha.
 *
 * O link aparece UMA vez. É o que a API responde e é tudo o que existe: o
 * banco guarda só o hash, então nem esta tela nem nenhuma outra consegue
 * mostrá-lo de novo. Daí o aviso e o botão de copiar.
 *
 * O e-mail é opcional porque o envio depende do deploy ter transporte, e um
 * campo obrigatório para uma comodidade que pode não existir seria uma parede.
 * Quando não vai, o link está ali para ser entregue como sempre foi.
 */
export function InvitePanel({ roles }: { roles: readonly OperatorRole[] }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<OperatorRole>('tech')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState<{ link: string; emailed: boolean } | null>(null)

  const criar = async () => {
    const endereco = email.trim()
    if (endereco && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(endereco)) {
      toast.error(t('settings.operators.emailInvalid'))
      return
    }
    setBusy(true)
    try {
      const res = await invitesAPI.create({ role, ...(endereco ? { email: endereco } : {}) })
      if (!res.success || !res.data) {
        toast.error(res.message || t('invite.createFailed'))
        return
      }
      // O link é montado aqui, com o endereço desta aba: é o endereço por onde
      // esta pessoa entra, e é por onde o convidado vai entrar também.
      setMinted({
        link: `${window.location.origin}/invite#${res.data.token}`,
        emailed: res.data.emailed
      })
      setEmail('')
    } finally {
      setBusy(false)
    }
  }

  const copiar = async () => {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted.link)
      toast.success(t('common.copied'))
    } catch {
      // Sem permissão de área de transferência o link continua na tela para
      // ser selecionado à mão; não é erro que valha um alarme.
    }
  }

  return (
    <div className="mt-4 rounded-md border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium text-foreground">{t('invite.panelTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('invite.panelDescription')}</p>
        </div>
        <button
          type="button"
          className="modern-button-secondary shrink-0"
          onClick={() => { setOpen((v) => !v); setMinted(null) }}
          aria-expanded={open}
        >
          {t(open ? 'common.cancel' : 'invite.create')}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="invite-role" className="field-label">{t('settings.operators.role')}</label>
              <select
                id="invite-role" className="modern-input w-full" value={role}
                onChange={(e) => setRole(e.target.value as OperatorRole)}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>{t(ROLE_LABEL_KEYS[r])}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="invite-email" className="field-label">{t('invite.emailOptional')}</label>
              <input
                id="invite-email" type="email" className="modern-input w-full" autoComplete="off"
                placeholder={t('settings.operators.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="field-hint">{t('invite.emailHint')}</p>
            </div>
          </div>

          <button type="button" className="modern-button" disabled={busy} onClick={() => void criar()}>
            {busy ? t('common.saving') : t('invite.create')}
          </button>

          {minted && (
            <div className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3">
              <p className="text-sm font-medium text-foreground">
                {t(minted.emailed ? 'invite.mintedEmailed' : 'invite.minted')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{t('invite.onceOnly')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input className="modern-input flex-1 font-mono text-xs" readOnly value={minted.link} />
                <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar()}>
                  <Icon name="copy" size={17} />
                  {t('common.copy')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


export default InvitePanel
