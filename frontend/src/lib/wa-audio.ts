/** É áudio? O tipo vem com parâmetros (`audio/ogg; codecs=opus`). */
export function isAudioType(type: string | null | undefined): boolean {
  return (type || '').split(';')[0].trim().toLowerCase().startsWith('audio/')
}

/**
 * O formato da gravação, na ordem do que o WhatsApp prefere.
 *
 * OGG/Opus (Firefox) já é o formato da mensagem de voz; WebM/Opus (Chrome) e
 * MP4/AAC (Safari) o Evolution v2 converte. O mime sem parâmetros é o que
 * sobe para o servidor, que só aceita os tipos da lista.
 */
const CANDIDATOS = [
  { record: 'audio/ogg;codecs=opus', upload: 'audio/ogg', extension: '.ogg' },
  { record: 'audio/webm;codecs=opus', upload: 'audio/webm', extension: '.webm' },
  { record: 'audio/webm', upload: 'audio/webm', extension: '.webm' },
  { record: 'audio/mp4', upload: 'audio/mp4', extension: '.m4a' }
] as const

export type RecordingFormat = (typeof CANDIDATOS)[number]

export function pickRecordingFormat(isTypeSupported: (mime: string) => boolean): RecordingFormat | null {
  return CANDIDATOS.find((c) => {
    try {
      return isTypeSupported(c.record)
    } catch {
      return false
    }
  }) ?? null
}

/** `audio-2026-10-03-1342.webm`, na hora local de quem gravou. */
export function recordingFileName(now: Date, extension: string): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `audio-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${extension}`
}

/** `0:07`, `1:23` — o cronômetro da gravação. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A gravação para sozinha aqui: bem abaixo dos 16 MB de um anexo. */
export const MAX_RECORDING_SECONDS = 5 * 60
