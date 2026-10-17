import { useCallback, useEffect, useRef, useState } from 'react'
import { devicesAPI, type DeviceFirmwareCatalog } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import {
  FIRMWARE_MAX_BYTES,
  firmwareErrorKind,
  firmwareFileProblem,
  firmwareMetaProblem,
  formatFileSize
} from '@/lib/firmware'

/**
 * Os firmwares do GenieACS, nas Configurações do provedor: a lista, o envio de
 * um arquivo novo e o apagar.
 *
 * Antes daqui o provedor subia o arquivo pela interface do GenieACS — que, no
 * ACS compartilhado da SaaS, ele nem enxerga. O envio passa pelo painel, e no
 * ACS compartilhado o servidor põe o prefixo `<tag>--` no nome sozinho: é o
 * prefixo que faz o arquivo ser deste provedor e de nenhum outro.
 *
 * A lista é a mesma do firmware em lote (`listFirmwareCatalog`): só os
 * arquivos que dizem o modelo. Os que não dizem são contados, para o provedor
 * saber que existem.
 *
 * Quem monta o cartão é a página, com `devices.maintain` — a mesma permissão
 * de mandar o firmware para a ONT.
 */
export function FirmwareFilesCard() {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [catalogo, setCatalogo] = useState<DeviceFirmwareCatalog | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [arquivo, setArquivo] = useState<File | null>(null)
  const [oui, setOui] = useState('')
  const [productClass, setProductClass] = useState('')
  const [version, setVersion] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [apagando, setApagando] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const carregar = useCallback(async () => {
    setCarregando(true)
    setErro(null)
    try {
      const res = await devicesAPI.listFirmwareCatalog()
      if (res.success && res.data) setCatalogo(res.data)
      else setErro(res.message || t('settings.firmware.loadFailed'))
    } catch {
      setErro(t('settings.firmware.loadFailed'))
    } finally {
      setCarregando(false)
    }
  }, [t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const problemaArquivo = arquivo ? firmwareFileProblem(arquivo.size) : null
  const maximo = formatFileSize(FIRMWARE_MAX_BYTES) ?? ''

  const mensagemDeErro = (res: { code?: string; message?: string }, reserva: string) => {
    const tipo = firmwareErrorKind(res)
    if (tipo === 'tooLarge') return t('settings.firmware.tooLarge', { max: maximo })
    if (tipo === 'generic') return reserva
    return res.message || reserva
  }

  const limparFormulario = () => {
    setArquivo(null)
    setOui('')
    setProductClass('')
    setVersion('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const enviar = async () => {
    if (!arquivo) return
    if (problemaArquivo) return
    if (firmwareMetaProblem({ productClass })) {
      toast.error(t('settings.firmware.productClassRequired'))
      return
    }
    setEnviando(true)
    try {
      const res = await devicesAPI.uploadFirmware(arquivo, { oui, productClass, version })
      if (res.success && res.data) {
        toast.success(t('settings.firmware.uploaded', { name: res.data.id }))
        limparFormulario()
        void carregar()
      } else {
        toast.error(mensagemDeErro(res, t('settings.firmware.uploadFailed')))
      }
    } catch {
      toast.error(t('settings.firmware.uploadFailed'))
    } finally {
      setEnviando(false)
    }
  }

  const apagar = async (nome: string) => {
    if (!window.confirm(t('settings.firmware.deleteConfirm', { name: nome }))) return
    setApagando(nome)
    try {
      const res = await devicesAPI.deleteFirmware(nome)
      if (res.success) {
        toast.success(t('settings.firmware.deleted', { name: nome }))
        setCatalogo((atual) => (atual ? { ...atual, files: atual.files.filter((f) => f.id !== nome) } : atual))
      } else {
        toast.error(mensagemDeErro(res, t('settings.firmware.deleteFailed')))
      }
    } catch {
      toast.error(t('settings.firmware.deleteFailed'))
    } finally {
      setApagando(null)
    }
  }

  return (
    <div className="modern-card max-w-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-heading">{t('settings.firmware.title')}</h2>
          <p className="section-description">{t('settings.firmware.description')}</p>
        </div>
        <button
          type="button"
          className="modern-button-secondary shrink-0"
          onClick={() => void carregar()}
          disabled={carregando}
        >
          <Icon name="refresh" size={17} />
          {t('settings.firmware.refresh')}
        </button>
      </div>

      <div className="mt-4 space-y-2 text-sm">
        {carregando && !catalogo && <p className="text-muted-foreground">{t('settings.firmware.loading')}</p>}
        {!carregando && erro && <p className="text-[hsl(var(--status-danger))]">{erro}</p>}
        {catalogo && catalogo.files.length === 0 && !erro && (
          <p className="text-muted-foreground">{t('settings.firmware.empty')}</p>
        )}
        {catalogo && catalogo.files.length > 0 && (
          <ul className="space-y-2">
            {catalogo.files.map((file) => {
              const detalhes = [
                file.productClass ? `${t('settings.firmware.productClass')}: ${file.productClass}` : null,
                file.oui ? `OUI: ${file.oui}` : null,
                formatFileSize(file.size),
                file.uploadedAt ? t('detail.firmware.uploadedAt', { when: formatDateTime(file.uploadedAt) }) : null
              ].filter(Boolean)
              return (
                // No celular o Excluir desce: ao lado, o nome do arquivo ficava espremido.
                <li key={file.id} className="flex flex-col items-start gap-3 rounded-lg border border-border p-3 sm:flex-row">
                  <span className="min-w-0 self-stretch sm:flex-1 sm:self-auto">
                    <span className="block font-medium text-foreground">
                      {file.version || t('detail.firmware.noVersion')}
                    </span>
                    <span className="block break-all font-mono text-xs text-muted-foreground">{file.id}</span>
                    <span className="block text-xs text-muted-foreground wrap-anywhere">{detalhes.join(' · ')}</span>
                  </span>
                  <button
                    type="button"
                    className="modern-button-secondary shrink-0"
                    disabled={apagando !== null}
                    onClick={() => void apagar(file.id)}
                    aria-label={t('settings.firmware.deleteAria', { name: file.id })}
                  >
                    <Icon name="trash" size={16} />
                    {apagando === file.id ? t('settings.firmware.deleting') : t('common.delete')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {catalogo && catalogo.unclassified > 0 && (
          <p className="field-hint">{t('settings.firmware.unclassified', { count: String(catalogo.unclassified) })}</p>
        )}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="font-semibold text-foreground">{t('settings.firmware.uploadTitle')}</h3>
        <p className="field-hint flex items-start gap-2">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          {t('settings.firmware.sharedHint')}
        </p>

        <div className="mt-3">
          <label htmlFor="firmware-upload-file" className="block text-sm font-medium mb-1">
            {t('settings.firmware.file')}
          </label>
          <input
            id="firmware-upload-file"
            ref={inputRef}
            type="file"
            className="modern-input w-full"
            disabled={enviando}
            onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
          />
          <p className="field-hint">
            {arquivo && !problemaArquivo
              ? `${arquivo.name} · ${formatFileSize(arquivo.size) ?? ''}`
              : t('settings.firmware.maxSize', { max: maximo })}
          </p>
          {problemaArquivo && (
            <p className="mt-1 text-sm text-[hsl(var(--status-danger))]">
              {problemaArquivo === 'tooLarge'
                ? t('settings.firmware.tooLarge', { max: maximo })
                : t('settings.firmware.fileEmpty')}
            </p>
          )}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="firmware-upload-model" className="block text-sm font-medium mb-1">
              {t('settings.firmware.productClass')}
            </label>
            <input
              id="firmware-upload-model"
              value={productClass}
              onChange={(e) => setProductClass(e.target.value)}
              className="modern-input w-full font-mono"
              placeholder="F670L"
              maxLength={64}
              disabled={enviando}
              autoComplete="off"
              required
            />
            <p className="field-hint">{t('settings.firmware.productClassHint')}</p>
          </div>
          <div>
            <label htmlFor="firmware-upload-version" className="block text-sm font-medium mb-1">
              {t('settings.firmware.version')}
            </label>
            <input
              id="firmware-upload-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="modern-input w-full font-mono"
              placeholder="V9.0.10P1N8"
              maxLength={128}
              disabled={enviando}
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="firmware-upload-oui" className="block text-sm font-medium mb-1">
              {t('settings.firmware.oui')}
            </label>
            <input
              id="firmware-upload-oui"
              value={oui}
              onChange={(e) => setOui(e.target.value)}
              className="modern-input w-full font-mono"
              placeholder="D8C678"
              maxLength={16}
              disabled={enviando}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="modern-button"
            disabled={enviando || !arquivo || problemaArquivo !== null || !productClass.trim()}
            onClick={() => void enviar()}
          >
            {enviando ? t('settings.firmware.uploading') : t('settings.firmware.upload')}
          </button>
          {enviando && <span className="text-sm text-muted-foreground">{t('settings.firmware.uploadingHint')}</span>}
        </div>
      </div>
    </div>
  )
}
