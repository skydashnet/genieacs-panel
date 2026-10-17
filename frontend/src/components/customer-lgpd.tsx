'use client'

import { useState } from 'react'
import { useToast } from '@/components/ui/toast'
import { customerAPI } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { subscriberFileName } from '@/lib/utils'

/**
 * Os dois direitos do titular, no lugar onde o operador já está quando o
 * assinante liga para exercê-los.
 *
 * Mora na ficha do aparelho e não numa tela própria de propósito: o pedido
 * chega por telefone ou balcão — "sou fulano, quero meus dados" — e a primeira
 * coisa que o atendente faz é abrir o aparelho dele. Uma tela separada obrigaria
 * a procurar a mesma pessoa duas vezes, e é procurando duas vezes que se acha a
 * errada.
 *
 * As duas capacidades são conferidas SEPARADAMENTE, ainda que hoje caiam nos
 * mesmos papéis: quem pode entregar o dossiê não recebe de brinde o direito de
 * destruí-lo.
 */
export function CustomerLgpd({ accountId, customerId }: {
  accountId: number
  customerId: string
}) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [exportando, setExportando] = useState(false)
  const [abriuExclusao, setAbriuExclusao] = useState(false)
  const [confirmacao, setConfirmacao] = useState('')
  const [apagando, setApagando] = useState(false)
  const [apagado, setApagado] = useState<{ wasActive: boolean } | null>(null)

  const podeExportar = can('customers.dossier')
  const podeApagar = can('customers.erase')
  if (!podeExportar && !podeApagar) return null

  /**
   * O arquivo. A URL do blob é revogada logo depois do clique e não no
   * desmonte: é download de uso único, ao contrário do anexo de conversa, onde
   * uma `<img>` continua apontando para ela.
   */
  const exportar = async () => {
    setExportando(true)
    try {
      const res = await customerAPI.export(accountId)
      if (!res.success || !res.blob) {
        toast.error(res.message || t('detail.lgpd.exportFailed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      // O nome bom vem do servidor; este é a reserva para o painel servido de
      // outra origem por um backend que ainda não expõe o cabeçalho.
      link.download = res.filename || subscriberFileName(customerId)
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(t('detail.lgpd.exported'))
    } finally {
      setExportando(false)
    }
  }

  const apagar = async () => {
    setApagando(true)
    try {
      const res = await customerAPI.erase(accountId, confirmacao)
      if (!res.success || !res.data) {
        toast.error(res.message || t('detail.lgpd.eraseFailed'))
        return
      }
      setApagado({ wasActive: res.data.wasActive })
      setAbriuExclusao(false)
      setConfirmacao('')
      toast.success(t('detail.lgpd.erased'))
    } finally {
      setApagando(false)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="field-label">{t('detail.lgpd.title')}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('detail.lgpd.hint')}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {podeExportar && (
          <button
            type="button"
            className="modern-button-secondary"
            disabled={exportando}
            onClick={() => void exportar()}
          >
            {exportando ? t('detail.lgpd.exporting') : t('detail.lgpd.export')}
          </button>
        )}
        {podeApagar && !abriuExclusao && (
          <button
            type="button"
            className="modern-button-danger"
            onClick={() => setAbriuExclusao(true)}
          >
            {t('detail.lgpd.erase')}
          </button>
        )}
      </div>

      {podeApagar && abriuExclusao && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-xs leading-5 text-foreground">{t('detail.lgpd.eraseHint')}</p>
          <label htmlFor="lgpd-confirm" className="field-label mt-3 block wrap-break-word">
            {t('detail.lgpd.eraseConfirmLabel', { id: customerId })}
          </label>
          <input
            id="lgpd-confirm"
            className="modern-input font-mono"
            value={confirmacao}
            autoComplete="off"
            onChange={(event) => setConfirmacao(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="modern-button-danger"
              // Comparado aqui também, e não só no servidor: um botão que só
              // acende quando o id confere diz ao operador que ele digitou
              // certo ANTES de o ato acontecer. O servidor continua sendo quem
              // decide — esta é a cortesia, não a guarda.
              disabled={apagando || confirmacao !== customerId}
              onClick={() => void apagar()}
            >
              {apagando ? t('detail.lgpd.erasing') : t('detail.lgpd.eraseConfirm')}
            </button>
            <button
              type="button"
              className="modern-button-secondary"
              disabled={apagando}
              onClick={() => { setAbriuExclusao(false); setConfirmacao('') }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {apagado && (
        <p className="mt-3 text-xs leading-5 text-destructive">
          {/* O aviso que o código não consegue cumprir sozinho: enquanto a ONT
              informar na planta, a próxima sincronização recria a conta. */}
          {apagado.wasActive ? t('detail.lgpd.stillActive') : t('detail.lgpd.doneHint')}
        </p>
      )}
    </div>
  )
}
