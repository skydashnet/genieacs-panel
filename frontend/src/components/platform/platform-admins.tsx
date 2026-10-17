'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type PlatformAdminView } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { displayDate } from '@/lib/date-format'

function quando(valor: string | null) {
  if (!valor) return '—'
  return displayDate(valor) ?? '—'
}

/**
 * Quem tem a chave do plano de controle.
 *
 * Até agora este cadastro só se mexia por `INSERT` no banco — o primeiro
 * administrador de um deploy SaaS entra nele pelo caminho da instalação, e
 * qualquer segundo era SQL na mão. Esta é a tela que fecha isso.
 *
 * **Este é o poder mais alto do produto.** Quem está aqui cria e apaga
 * provedores, muda o que cada um paga, e abre uma sessão de leitura no painel
 * de qualquer cliente. Não é o papel de administrador de um provedor — é acima
 * dele, e é por isso que a concessão é explícita e fica registrada na trilha da
 * plataforma, com quem deu a quem.
 *
 * Duas guardas de produto vivem na tela, e as duas existem porque a alternativa
 * é ruim de um jeito que só aparece depois:
 *
 * 1. **Remover a si mesmo pede confirmação**, dizendo o que acontece — quem
 *    clicar sai do console na mesma hora e não consegue voltar sozinho.
 * 2. **O último não pode sair**, e quem impede é o backend, não esta tela: um
 *    cadastro vazio tranca todo mundo para fora para sempre, e só SQL recupera.
 *    Aqui o botão some quando resta um, o que é comodidade; a recusa de
 *    verdade está do outro lado, onde ela vale mesmo para quem chamar a rota
 *    direto.
 */
export function PlatformAdmins() {
  const { t } = useTranslation()
  const toast = useToast()
  const { user } = useAuth()

  const [admins, setAdmins] = useState<PlatformAdminView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [identificador, setIdentificador] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [removendo, setRemovendo] = useState<number | null>(null)

  const carregar = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.listAdmins()
    if (res.success && res.data) {
      setAdmins(res.data.admins)
      setError(null)
    } else {
      setAdmins([])
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const conceder = async () => {
    const nome = identificador.trim()
    if (!nome) return
    if (!window.confirm(t('platform.admins.grantConfirm', { user: nome }))) return
    setSalvando(true)
    try {
      const res = await platformAPI.addAdmin({ username: nome })
      if (!res.success) {
        // 404 quando o nome não existe: a mensagem do backend diz qual é o caso.
        toast.error(res.message || t('platform.admins.grantFailed'))
        return
      }
      setIdentificador('')
      await carregar()
    } finally {
      setSalvando(false)
    }
  }

  const revogar = async (admin: PlatformAdminView) => {
    const euMesmo = admin.userId === user?.id
    const pergunta = euMesmo ? 'platform.admins.revokeSelfConfirm' : 'platform.admins.revokeConfirm'
    if (!window.confirm(t(pergunta, { user: admin.username }))) return
    setRemovendo(admin.userId)
    try {
      const res = await platformAPI.removeAdmin(admin.userId)
      if (!res.success) {
        toast.error(res.message || t('platform.admins.revokeFailed'))
        return
      }
      if (euMesmo) {
        // A sessão continua válida — o que mudou é o cadastro, e ele é lido a
        // cada requisição. Recarregar é o jeito honesto de a tela refletir
        // isso: o menu se remonta sem o console, e ficar aqui mostraria uma
        // tela cujas rotas já respondem 404.
        window.location.assign('/dashboard')
        return
      }
      await carregar()
    } finally {
      setRemovendo(null)
    }
  }

  return (
    <section className="rounded-md border border-border p-4">
      <div>
        <h2 className="font-semibold text-foreground">{t('platform.admins.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.admins.description')}</p>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          className="modern-input flex-1"
          value={identificador}
          onChange={(e) => setIdentificador(e.target.value)}
          placeholder={t('platform.admins.identifierPlaceholder')}
          aria-label={t('platform.admins.identifier')}
        />
        <button
          type="button" className="modern-button shrink-0" disabled={salvando || !identificador.trim()}
          onClick={() => void conceder()}
        >
          {salvando ? t('common.saving') : t('platform.admins.grant')}
        </button>
      </div>
      <p className="field-hint">{t('platform.admins.identifierHint')}</p>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive">{error || t('platform.admins.loadFailed')}</p>
      )}

      <div className="mt-4 space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : admins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('platform.admins.empty')}</p>
        ) : admins.map((admin) => (
          <div
            key={admin.userId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
          >
            <div className="min-w-0">
              <span className="font-medium text-foreground">{admin.username}</span>
              {admin.userId === user?.id && (
                <span className="ms-2 text-xs text-muted-foreground">{t('platform.admins.you')}</span>
              )}
              <p className="mt-0.5 text-sm text-muted-foreground">
                {admin.email || '—'} · {t('platform.admins.since', { date: quando(admin.grantedAt) })}
              </p>
            </div>
            {/* Some quando resta um: é comodidade, e a recusa de verdade está
                no backend — ver o comentário no topo. */}
            {admins.length > 1 && (
              <button
                type="button" className="modern-button-secondary shrink-0"
                disabled={removendo === admin.userId}
                onClick={() => void revogar(admin)}
              >
                <Icon name="trash" size={16} />
                {t('platform.admins.revoke')}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export default PlatformAdmins
