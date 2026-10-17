import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import {
  settingsAPI,
  type GenieAcsAgentStatus,
  type GenieAcsConnectionMode,
  type GenieAcsConnectionSettings
} from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { modeOptions } from '@/lib/genieacs-agent'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { GenieAcsAgentPanel } from '@/components/genieacs-agent-panel'

const MODE_LABELS: Record<GenieAcsConnectionMode, TranslationKey> = {
  direct: 'platform.genieacs.modeDirect',
  tunnel: 'platform.genieacs.modeTunnel',
  agent: 'platform.genieacs.modeAgent'
}

const MODE_HINTS: Record<GenieAcsConnectionMode, TranslationKey> = {
  direct: 'settings.acsConnection.directHint',
  tunnel: 'settings.acsConnection.tunnelHint',
  agent: 'platform.genieacs.modeAgentHint'
}

/**
 * "Como o painel chega ao GenieACS", nas Configurações do provedor.
 *
 * Duas edições, dois donos do modo:
 *
 * - instalação própria (`modeEditable`): o provedor escolhe entre Direto e
 *   Agente aqui mesmo — o GenieACS e o painel são dele;
 * - SaaS: quem escolhe é a plataforma, pelo console. O provedor vê o modo como
 *   texto, "definido pela plataforma" — e, se for Agente, continua gerando a
 *   chave e instalando o agente, porque a máquina onde ele roda é do provedor.
 *
 * O cartão tem o próprio Salvar, separado do Salvar da página: o modo mora
 * noutra rota (`/settings/genieacs-connection`), e juntá-lo ao salvar das
 * chaves faria um erro de um travar o outro no meio.
 *
 * Quem não pode gravar o GenieACS vê tudo só para leitura e não vê o botão de
 * gerar chave. Se o servidor nem deixa ler (403 `missing_permission`), o
 * cartão não aparece: um cartão vazio dizendo "sem permissão" no meio da aba
 * só ocuparia espaço de quem não tem o que fazer aqui.
 */
export function GenieAcsConnectionCard({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [conn, setConn] = useState<GenieAcsConnectionSettings | null>(null)
  const [hidden, setHidden] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [mode, setMode] = useState<GenieAcsConnectionMode>('direct')
  const [saving, setSaving] = useState(false)

  const aplicar = useCallback((next: GenieAcsConnectionSettings) => {
    setConn(next)
    setMode(next.mode)
  }, [])

  useEffect(() => {
    let cancelled = false
    void settingsAPI.getGenieAcsConnection().then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        aplicar(res.data)
        setLoadFailed(false)
      } else if (res.code === 'missing_permission') {
        setHidden(true)
      } else {
        setLoadFailed(true)
      }
    })
    return () => { cancelled = true }
  }, [aplicar])

  // A leitura periódica do bloco do agente devolve o cartão inteiro; só o
  // `agent` é aproveitado, para não desfazer um modo escolhido e não salvo.
  const guardarAgente = useCallback((agent: GenieAcsAgentStatus) => {
    setConn((atual) => (atual ? { ...atual, agent } : atual))
  }, [])

  if (hidden) return null

  if (!conn) {
    return (
      <div className="modern-card max-w-3xl p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.acsConnection.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {loadFailed ? t('settings.acsConnection.loadFailed') : t('common.loading')}
        </p>
      </div>
    )
  }

  const opcoes = canWrite ? modeOptions('settings', conn.modeEditable, conn.mode) : []
  const editavel = opcoes.length > 0
  const mudou = mode !== conn.mode

  const salvar = async () => {
    // O seletor só oferece `direct` e `agent`; a guarda é para o tipo, e para
    // um `tunnel` antigo que o seletor mostra mas o servidor não aceita de volta.
    if (mode === 'tunnel') return
    setSaving(true)
    try {
      const res = await settingsAPI.updateGenieAcsConnection({ mode })
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('settings.acsConnection.saved'))
      } else {
        toast.error(res.message || t('settings.acsConnection.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6">
      <h2 id="genieacs-connection-title" className="section-heading">{t('settings.acsConnection.title')}</h2>
      <p className="section-description mb-5">{t('settings.acsConnection.description')}</p>

      {editavel ? (
        <div>
          {/* Sem rótulo visível: seria o título do cartão repetido logo abaixo
              dele. O título é o rótulo, para o leitor de tela também. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              id="genieacs-connection-mode"
              aria-labelledby="genieacs-connection-title"
              className="modern-input w-full sm:w-72"
              value={mode}
              onChange={(e) => setMode(e.target.value as GenieAcsConnectionMode)}
            >
              {opcoes.map((opcao) => (
                <option key={opcao} value={opcao}>{t(MODE_LABELS[opcao])}</option>
              ))}
            </select>
            {mudou && (
              <button type="button" className="modern-button" disabled={saving} onClick={() => void salvar()}>
                {saving ? t('common.saving') : t('settings.acsConnection.save')}
              </button>
            )}
          </div>
          <p className="field-hint">{t(MODE_HINTS[mode])}</p>
        </div>
      ) : (
        <div className="rounded-md border border-border bg-muted/40 p-4">
          <p className="text-sm font-medium text-foreground">{t(MODE_LABELS[conn.mode])}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t(MODE_HINTS[conn.mode])}</p>
          <p className="field-hint mt-3 flex items-center gap-2">
            <Icon name="lock" size={14} />
            {t(conn.modeEditable ? 'settings.acsConnection.readOnly' : 'settings.acsConnection.platformManaged')}
          </p>
        </div>
      )}

      {mode === 'agent' && (
        <div className="mt-5">
          <GenieAcsAgentPanel
            idPrefix="settings-genieacs"
            initialStatus={conn.agent}
            savedMode={conn.mode}
            canWrite={canWrite}
            fetchStatus={settingsAPI.getGenieAcsConnection}
            generateToken={settingsAPI.generateGenieAcsAgentToken}
            onStatus={guardarAgente}
          />
        </div>
      )}
    </div>
  )
}
