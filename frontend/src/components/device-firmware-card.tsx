import { useCallback, useEffect, useState } from 'react'
import { devicesAPI, type DeviceFirmwareList } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { defaultFirmwareChoice, formatFileSize } from '@/lib/firmware'

/**
 * Firmware da ONT, com os arquivos que já estão no GenieACS.
 *
 * A lista vem do servidor só com os arquivos do modelo desta ONT; os que
 * ficaram de fora são contados, para o operador saber que existem e por que não
 * aparecem. A troca pede confirmação dizendo as duas versões e que a ONT
 * reinicia — o assinante fica sem internet enquanto ela grava.
 */
export function DeviceFirmwareCard({ deviceId, onDone }: { deviceId: string; onDone?: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [lista, setLista] = useState<DeviceFirmwareList | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [escolhido, setEscolhido] = useState<string | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [naFila, setNaFila] = useState(false)

  const carregar = useCallback(async () => {
    setCarregando(true)
    setErro(null)
    try {
      const res = await devicesAPI.listFirmware(deviceId)
      if (res.success && res.data) {
        setLista(res.data)
        setEscolhido(defaultFirmwareChoice(res.data.files))
      } else {
        setErro(res.message || t('detail.firmware.loadFailed'))
      }
    } catch {
      setErro(t('detail.firmware.loadFailed'))
    } finally {
      setCarregando(false)
    }
  }, [deviceId, t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const arquivo = lista?.files.find((file) => file.id === escolhido) ?? null

  const enviar = async () => {
    if (!arquivo) return
    setEnviando(true)
    try {
      const res = await devicesAPI.upgradeFirmware(deviceId, arquivo.id)
      if (res.success && res.data) {
        setConfirmando(false)
        setNaFila(res.data.queued)
        toast.success(res.message || t('detail.firmware.title'))
        onDone?.()
      } else {
        toast.error(res.message || t('detail.firmware.failed'))
      }
    } catch {
      toast.error(t('detail.firmware.failed'))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Icon name="box" className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 className="section-heading">{t('detail.firmware.title')}</h2>
          <p className="section-description">
            {t('detail.firmware.current', { version: lista?.current || t('common.na') })}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3 text-sm">
        {carregando && <p className="text-muted-foreground">{t('detail.firmware.loading')}</p>}
        {!carregando && erro && <p className="text-[hsl(var(--status-danger))]">{erro}</p>}

        {!carregando && lista && lista.files.length === 0 && (
          <p className="text-muted-foreground">
            {t('detail.firmware.none', { model: lista.productClass || t('common.na') })}
          </p>
        )}

        {!carregando && lista && lista.files.length > 0 && (
          <div role="radiogroup" aria-label={t('detail.firmware.title')} className="space-y-2">
            {lista.files.map((file) => {
              const marcado = escolhido === file.id
              const tamanho = formatFileSize(file.size)
              return (
                <label
                  key={file.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                    marcado ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                  } ${file.installed ? 'cursor-default opacity-70' : ''}`}
                >
                  <input
                    type="radio"
                    name={`firmware-${deviceId}`}
                    className="mt-1"
                    checked={marcado}
                    disabled={file.installed}
                    onChange={() => setEscolhido(file.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{file.version || t('detail.firmware.noVersion')}</span>
                      {file.installed && <span className="modern-badge">{t('detail.firmware.installed')}</span>}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{file.id}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[tamanho, file.uploadedAt ? t('detail.firmware.uploadedAt', { when: formatDateTime(file.uploadedAt) }) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        )}

        {!carregando && lista && lista.otherModels > 0 && (
          <p className="field-hint">{t('detail.firmware.otherModels', { count: String(lista.otherModels) })}</p>
        )}

        {naFila && <p className="text-[hsl(var(--status-warning))]">{t('detail.firmware.queued')}</p>}

        {!carregando && lista && lista.files.length > 0 && (
          <div className="flex justify-end">
            <button
              type="button"
              className="modern-button"
              disabled={!arquivo || arquivo.installed}
              onClick={() => setConfirmando(true)}
            >
              <Icon name="refresh" size={16} />
              {t('detail.firmware.upgrade')}
            </button>
          </div>
        )}
      </div>

      {confirmando && arquivo && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="firmware-confirm-title">
          <div className="modal-panel modern-card flex max-w-md flex-col">
            <div className="flex items-center gap-2 border-b border-border p-5">
              <Icon name="warning" size={20} className="shrink-0 text-[hsl(var(--status-warning))]" />
              <h3 id="firmware-confirm-title" className="text-lg font-semibold text-foreground">{t('detail.firmware.confirmTitle')}</h3>
            </div>
            <div className="space-y-3 overflow-y-auto p-5 text-sm leading-6">
              <p className="break-all font-mono text-foreground">
                {lista?.current || t('common.na')} → {arquivo.version || arquivo.id}
              </p>
              <p className="text-foreground">{t('detail.firmware.consequence')}</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border p-5">
              <button type="button" className="modern-button-secondary" onClick={() => setConfirmando(false)} disabled={enviando}>
                {t('common.cancel')}
              </button>
              <button type="button" className="modern-button" disabled={enviando} onClick={() => void enviar()}>
                <Icon name="refresh" size={16} />
                {enviando ? t('detail.firmware.sending') : t('detail.firmware.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
