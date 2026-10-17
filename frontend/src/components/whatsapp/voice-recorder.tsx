'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import {
  MAX_RECORDING_SECONDS,
  formatClock,
  pickRecordingFormat,
  recordingFileName,
  type RecordingFormat
} from '@/lib/wa-audio'

/** O navegador grava? Sem `MediaRecorder` (ou fora de HTTPS) o botão nem aparece. */
export function canRecordAudio(): boolean {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && pickRecordingFormat((mime) => window.MediaRecorder.isTypeSupported(mime)) !== null
}

/**
 * Gravar uma mensagem de voz pelo microfone do computador ou do celular.
 *
 * Ao parar, a gravação vira um arquivo como outro qualquer e entra na lista de
 * anexos da caixa — dá para ouvir antes e só então apertar Enviar. Cancelar
 * descarta tudo. O microfone é solto assim que a gravação termina: a luz do
 * navegador não fica acesa com a aba parada.
 */
export function VoiceRecorder({ disabled, onRecorded }: { disabled: boolean; onRecorded: (file: File) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const discard = useRef(false)
  const timer = useRef<number | null>(null)
  const format = useRef<RecordingFormat | null>(null)

  const release = () => {
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }

  // Sair da conversa no meio da gravação descarta e solta o microfone.
  useEffect(() => () => {
    discard.current = true
    if (recorder.current?.state === 'recording') recorder.current.stop()
    release()
  }, [])

  const start = async () => {
    const escolhido = pickRecordingFormat((mime) => MediaRecorder.isTypeSupported(mime))
    if (!escolhido) {
      toast.error(t('whatsapp.audio.micUnavailable'))
      return
    }
    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      const name = (error as { name?: string })?.name
      toast.error(t(name === 'NotAllowedError' || name === 'SecurityError' ? 'whatsapp.audio.micDenied' : 'whatsapp.audio.micUnavailable'))
      return
    }
    stream.current = media
    format.current = escolhido
    chunks.current = []
    discard.current = false
    const rec = new MediaRecorder(media, { mimeType: escolhido.record })
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data)
    }
    rec.onstop = () => {
      release()
      setRecording(false)
      if (discard.current || !format.current) return
      const blob = new Blob(chunks.current, { type: format.current.upload })
      chunks.current = []
      if (blob.size === 0) return
      onRecorded(new File([blob], recordingFileName(new Date(), format.current.extension), { type: format.current.upload }))
    }
    recorder.current = rec
    rec.start(1000)
    setSeconds(0)
    setRecording(true)
    const began = Date.now()
    timer.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000)
      setSeconds(elapsed)
      if (elapsed >= MAX_RECORDING_SECONDS && rec.state === 'recording') {
        toast.info(t('whatsapp.audio.maxReached', { minutes: MAX_RECORDING_SECONDS / 60 }))
        rec.stop()
      }
    }, 250)
  }

  const stop = (cancel: boolean) => {
    discard.current = cancel
    if (recorder.current?.state === 'recording') recorder.current.stop()
    else release()
  }

  if (recording) {
    return (
      <div className="flex shrink-0 items-center gap-2" role="status" aria-live="polite">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[hsl(var(--status-danger))]">
          <span className="size-2.5 animate-pulse rounded-full bg-[hsl(var(--status-danger))]" />
          <span className="tabular-nums">{formatClock(seconds)}</span>
          <span className="sr-only">{t('whatsapp.audio.recording')}</span>
        </span>
        <button type="button" className="modern-button-secondary shrink-0 px-3" onClick={() => stop(true)}>
          <Icon name="x" size={16} />
          <span className="hidden @4xl:inline">{t('whatsapp.audio.cancel')}</span>
        </button>
        <button type="button" className="modern-button shrink-0 px-3" onClick={() => stop(false)}>
          <Icon name="stop" size={16} />
          {t('whatsapp.audio.stop')}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="modern-button-secondary shrink-0 px-3 @4xl:px-4 max-sm:h-9 max-sm:w-8 max-sm:min-h-0 max-sm:px-0"
      aria-label={t('whatsapp.audio.record')}
      title={t('whatsapp.audio.recordHint')}
      disabled={disabled}
      onClick={() => void start()}
    >
      <Icon name="mic" size={16} />
      <span className="hidden @4xl:inline">{t('whatsapp.audio.record')}</span>
    </button>
  )
}
