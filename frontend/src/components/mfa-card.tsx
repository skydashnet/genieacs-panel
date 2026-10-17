import { useCallback, useEffect, useState } from 'react'
import { authAPI, type MfaSetup, type MfaStatus } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { QrCode } from '@/components/qr-code'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { cleanSecondFactor } from '@/lib/login-mfa'
import { copyToClipboard } from '@/lib/sgp'

type Acao = 'desligar' | 'trocar' | null

/**
 * Login em duas etapas da própria conta: ativar com o app autenticador, ver os
 * códigos de recuperação uma vez, gerar novos e desligar.
 *
 * O QR é desenhado aqui no navegador, a partir da URI que o servidor devolve só
 * durante a ativação. Os códigos de recuperação aparecem uma única vez — o
 * servidor guarda só o hash — e a tela diz isso antes de deixar sair.
 */
export function MfaCard({ onRecoveryCodesSaved, onStatusChange }: {
  /**
   * Chamado quando a pessoa diz que guardou os códigos. A ativação obrigatória
   * usa isto para só então sair da tela: sair logo depois de ativar levaria os
   * códigos embora antes de alguém tê-los copiado.
   */
  onRecoveryCodesSaved?: () => void
  /** Cada vez que o estado é relido: o cartão da exigência precisa saber se quem liga já usa o 2FA. */
  onStatusChange?: (status: MfaStatus) => void
} = {}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [pendente, setPendente] = useState<MfaSetup | null>(null)
  const [codigo, setCodigo] = useState('')
  const [senha, setSenha] = useState('')
  const [acao, setAcao] = useState<Acao>(null)
  const [codigosNovos, setCodigosNovos] = useState<string[] | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const carregar = useCallback(async () => {
    try {
      const res = await authAPI.mfaStatus()
      if (res.success && res.data) {
        setStatus(res.data)
        onStatusChange?.(res.data)
      }
    } catch {
      /* sem o estado, o cartão mostra só o botão de ativar, que o servidor confere */
    }
  }, [onStatusChange])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const limparCampos = () => {
    setCodigo('')
    setSenha('')
  }

  const iniciar = async () => {
    setOcupado(true)
    try {
      const res = await authAPI.mfaSetup()
      if (res.success && res.data) {
        setPendente(res.data)
        limparCampos()
      } else {
        toast.error(res.message || t('settings.mfa.failed'))
      }
    } finally {
      setOcupado(false)
    }
  }

  const confirmarAtivacao = async () => {
    setOcupado(true)
    try {
      const res = await authAPI.mfaEnable(cleanSecondFactor(codigo))
      if (res.success && res.data) {
        setPendente(null)
        setCodigosNovos(res.data.recoveryCodes)
        limparCampos()
        toast.success(res.message || t('settings.mfa.enabled'))
        await carregar()
      } else {
        toast.error(res.message || t('settings.mfa.failed'))
      }
    } finally {
      setOcupado(false)
    }
  }

  const executar = async () => {
    if (!acao) return
    setOcupado(true)
    try {
      const segundoFator = cleanSecondFactor(codigo)
      if (acao === 'desligar') {
        const res = await authAPI.mfaDisable(senha, segundoFator)
        if (res.success) {
          toast.success(res.message || t('settings.mfa.disabled'))
          setAcao(null)
          limparCampos()
          await carregar()
        } else {
          toast.error(res.message || t('settings.mfa.failed'))
        }
      } else {
        const res = await authAPI.mfaRegenerateRecovery(senha, segundoFator)
        if (res.success && res.data) {
          setCodigosNovos(res.data.recoveryCodes)
          setAcao(null)
          limparCampos()
          await carregar()
        } else {
          toast.error(res.message || t('settings.mfa.failed'))
        }
      }
    } finally {
      setOcupado(false)
    }
  }

  const baixarCodigos = () => {
    if (!codigosNovos) return
    const blob = new Blob([`${t('settings.mfa.recoveryFileHeader')}\n\n${codigosNovos.join('\n')}\n`], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'codigos-de-recuperacao.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  const ligado = Boolean(status?.enabled)

  return (
    <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-foreground">
            <Icon name="lock" size={17} />
            {t('settings.mfa.title')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.mfa.description')}</p>
        </div>
        <span className={ligado ? 'modern-badge-success' : 'modern-badge'}>
          {ligado ? t('settings.mfa.on') : t('settings.mfa.off')}
        </span>
      </div>

      {codigosNovos && (
        <div className="mt-4 space-y-3 rounded-md border border-[hsl(var(--status-warning))]/50 bg-card p-4" role="region" aria-label={t('settings.mfa.recoveryTitle')}>
          <p className="font-semibold text-foreground">{t('settings.mfa.recoveryTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('settings.mfa.recoveryHint')}</p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-5">
            {codigosNovos.map((item) => <li key={item} className="rounded bg-muted/60 px-2 py-1 text-center">{item}</li>)}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary" onClick={() => void copyToClipboard(codigosNovos.join('\n')).then(() => toast.success(t('common.copied')))}>
              <Icon name="copy" size={16} /> {t('common.copy')}
            </button>
            <button type="button" className="modern-button-secondary" onClick={baixarCodigos}>
              {t('settings.mfa.download')}
            </button>
            <button type="button" className="modern-button" onClick={() => { setCodigosNovos(null); onRecoveryCodesSaved?.() }}>
              {t('settings.mfa.savedThem')}
            </button>
          </div>
        </div>
      )}

      {!ligado && !pendente && !codigosNovos && (
        <div className="mt-4">
          <button type="button" className="modern-button" disabled={ocupado} onClick={() => void iniciar()}>
            {t('settings.mfa.enable')}
          </button>
        </div>
      )}

      {pendente && (
        <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr]">
          <div className="rounded-md bg-white p-2">
            <QrCode value={pendente.uri} size={180} ariaLabel={t('settings.mfa.qrAria')} />
          </div>
          <div className="space-y-3 text-sm">
            <p className="text-foreground">{t('settings.mfa.scan')}</p>
            <div>
              <p className="text-xs text-muted-foreground">{t('settings.mfa.manualKey')}</p>
              <p className="break-all font-mono text-sm">{pendente.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
            </div>
            <div>
              <label htmlFor="mfa-code" className="field-label">{t('settings.mfa.code')}</label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="modern-input w-40 font-mono tracking-widest"
                value={codigo}
                onChange={(event) => setCodigo(event.target.value)}
                placeholder="123 456"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="modern-button" disabled={ocupado || !codigo.trim()} onClick={() => void confirmarAtivacao()}>
                {t('settings.mfa.confirm')}
              </button>
              <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => { setPendente(null); limparCampos() }}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {ligado && !codigosNovos && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('settings.mfa.recoveryRemaining', { count: String(status?.recoveryRemaining ?? 0) })}
          </p>
          {acao === null ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="modern-button-secondary" onClick={() => { setAcao('trocar'); limparCampos() }}>
                {t('settings.mfa.regenerate')}
              </button>
              <button type="button" className="modern-button-danger" onClick={() => { setAcao('desligar'); limparCampos() }}>
                {t('settings.mfa.disable')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                {acao === 'desligar' ? t('settings.mfa.disableHint') : t('settings.mfa.regenerateHint')}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="mfa-password" className="field-label">{t('settings.mfa.password')}</label>
                  <input id="mfa-password" type="password" autoComplete="current-password" className="modern-input w-full" value={senha} onChange={(event) => setSenha(event.target.value)} />
                </div>
                <div>
                  <label htmlFor="mfa-confirm-code" className="field-label">{t('settings.mfa.codeOrRecovery')}</label>
                  <input id="mfa-confirm-code" type="text" autoComplete="one-time-code" className="modern-input w-full font-mono" value={codigo} onChange={(event) => setCodigo(event.target.value)} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={acao === 'desligar' ? 'modern-button-danger' : 'modern-button'}
                  disabled={ocupado || !senha || !codigo.trim()}
                  onClick={() => void executar()}
                >
                  {acao === 'desligar' ? t('settings.mfa.disable') : t('settings.mfa.regenerate')}
                </button>
                <button type="button" className="modern-button-secondary" disabled={ocupado} onClick={() => { setAcao(null); limparCampos() }}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
