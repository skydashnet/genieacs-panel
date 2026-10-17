import type { TranslationKey, TranslationVars } from '@/lib/i18n'

/**
 * Os anexos do WhatsApp, do lado da tela.
 *
 * A lista de tipos, os apelidos e os tetos são CÓPIA de
 * `backend/src/config/waAttachmentTypes.js`, e `test/wa-attachments.test.ts`
 * importa aquele arquivo e compara linha a linha. A cópia existe só para
 * recusar CEDO: o operador não deve ver 16 MB subirem para ouvir "não" no fim.
 * Quem decide continua sendo o servidor — ele confere até os primeiros bytes
 * contra o tipo declarado, coisa que a tela não tenta imitar.
 */

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document'

export interface AttachmentTypeRow {
  type: string
  /** A primeira é a que o servidor usa no disco; as outras só ajudam a reconhecer. */
  extensions: readonly string[]
  kind: AttachmentKind
  /** O servidor converte antes de guardar (HEIC vira JPEG). */
  convertTo?: string
}

export const ATTACHMENT_TYPES: readonly AttachmentTypeRow[] = Object.freeze([
  { type: 'image/jpeg', extensions: ['.jpg', '.jpeg'], kind: 'image' },
  { type: 'image/png', extensions: ['.png'], kind: 'image' },
  { type: 'image/webp', extensions: ['.webp'], kind: 'image' },
  { type: 'image/gif', extensions: ['.gif'], kind: 'image' },
  { type: 'image/heic', extensions: ['.heic', '.heif'], kind: 'image', convertTo: 'image/jpeg' },
  { type: 'application/pdf', extensions: ['.pdf'], kind: 'document' },
  { type: 'application/msword', extensions: ['.doc'], kind: 'document' },
  {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    kind: 'document'
  },
  { type: 'application/vnd.ms-excel', extensions: ['.xls'], kind: 'document' },
  {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    kind: 'document'
  },
  { type: 'text/plain', extensions: ['.txt'], kind: 'document' },
  { type: 'text/csv', extensions: ['.csv'], kind: 'document' },
  { type: 'application/zip', extensions: ['.zip'], kind: 'document' },
  { type: 'video/mp4', extensions: ['.mp4'], kind: 'video' },
  { type: 'audio/ogg', extensions: ['.ogg', '.oga'], kind: 'audio' },
  { type: 'audio/mpeg', extensions: ['.mp3'], kind: 'audio' },
  { type: 'audio/webm', extensions: ['.webm'], kind: 'audio' },
  { type: 'audio/mp4', extensions: ['.m4a'], kind: 'audio' }
])

/** Nomes que navegadores e sistemas dão ao mesmo tipo. Só nessa direção. */
export const ATTACHMENT_TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/heif': 'image/heic',
  'application/x-zip-compressed': 'application/zip',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'application/csv': 'text/csv'
})

export const MAX_ATTACHMENT_MB = 16
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024
export const MAX_ATTACHMENTS_PER_SEND = 10

const BY_TYPE = new Map(ATTACHMENT_TYPES.map((row) => [row.type, row]))
const BY_EXTENSION = new Map(
  ATTACHMENT_TYPES.flatMap((row) => row.extensions.map((ext) => [ext, row] as const))
)

/** A extensão do nome, minúscula e com o ponto; '' quando não há. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

/**
 * O tipo que este arquivo vai declarar no upload, ou null quando ele não sai.
 *
 * O tipo do navegador vem primeiro — já lido pelos apelidos — mas a extensão
 * decide em três casos em que ele não merece confiança:
 * - vazio: a foto HEIC do iPhone costuma chegar assim no Chrome e no Firefox;
 * - `application/octet-stream`: o "não sei" genérico de alguns sistemas;
 * - ambíguo: o tipo é da lista, mas a extensão é de OUTRO tipo da lista. O
 *   Windows manda `.csv` como `application/vnd.ms-excel` quando há Excel na
 *   máquina, e declarar isso faria o servidor recusar o conteúdo com razão.
 * Tipo da lista com extensão desconhecida (ou nenhuma, como o print colado)
 * fica com o tipo: nome é o que menos importa num arquivo.
 */
export function resolveAttachmentType(file: { name: string; type: string }): string | null {
  const raw = (file.type || '').split(';')[0].trim().toLowerCase()
  const browser = ATTACHMENT_TYPE_ALIASES[raw] ?? raw
  const byExtension = BY_EXTENSION.get(extensionOf(file.name))?.type ?? null

  if (BY_TYPE.has(browser)) {
    if (byExtension && byExtension !== browser) return byExtension
    return browser
  }
  if (browser === '' || browser === 'application/octet-stream') return byExtension
  // Um tipo que o navegador afirma e a lista não tem (text/html, image/svg+xml)
  // não é salvo pela extensão: renomear `pagina.html` para `.pdf` não o torna
  // um PDF, e o servidor recusaria o conteúdo de qualquer jeito.
  return null
}

export interface AttachmentRefusal {
  key: TranslationKey
  vars?: TranslationVars
}

/** A recusa que este arquivo ganharia do servidor, ou null. Mesmas chaves que as dele. */
export function attachmentRefusal(file: { name: string; type: string; size: number }): AttachmentRefusal | null {
  if (file.size === 0) return { key: 'whatsapp.error.attachmentEmpty' }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { key: 'whatsapp.error.attachmentTooLarge', vars: { max: MAX_ATTACHMENT_MB } }
  }
  if (!resolveAttachmentType(file)) return { key: 'whatsapp.error.attachmentTypeNotAllowed' }
  return null
}

/**
 * Se a tela consegue mostrar miniatura. HEIC fica de fora: só o Safari
 * desenha, e uma miniatura quebrada assusta mais que um ícone de arquivo.
 */
export function isPreviewable(type: string | null): boolean {
  return type === 'image/jpeg' || type === 'image/png' || type === 'image/webp' || type === 'image/gif'
}

export interface SendStep<F> {
  body: string
  file: F | null
}

/**
 * A ordem dos envios de um clique em "Enviar".
 *
 * Cada arquivo vira uma mensagem, na ordem da tela. O texto digitado vai como
 * legenda do PRIMEIRO arquivo — o servidor já manda `body` como legenda da
 * mídia — e os outros vão sem texto: repetir a frase em cada foto é o
 * assinante lendo a mesma coisa dez vezes. Sem arquivo, é uma mensagem de
 * texto só; sem nada, não há envio.
 */
export function planSend<F>({ body, files, isAudio }: {
  body: string
  files: readonly F[]
  /**
   * Áudio não leva legenda: a mensagem de voz do WhatsApp não tem onde pôr
   * texto, e o servidor a descartaria. O texto vai no primeiro arquivo que não
   * é áudio — ou, se todos forem, numa mensagem própria antes deles.
   */
  isAudio?: (file: F) => boolean
}): SendStep<F>[] {
  const text = body.trim()
  if (files.length === 0) return text ? [{ body: text, file: null }] : []
  const comLegenda = isAudio ? files.findIndex((file) => !isAudio(file)) : 0
  const passos = files.map((file, index) => ({ body: index === comLegenda ? text : '', file }))
  return text && comLegenda === -1 ? [{ body: text, file: null }, ...passos] : passos
}

/** O `accept` do seletor: tipos e extensões, porque cada sistema filtra por um. */
export function acceptAttribute(): string {
  const types = ATTACHMENT_TYPES.map((row) => row.type)
  const extensions = ATTACHMENT_TYPES.flatMap((row) => row.extensions)
  return [...types, ...Object.keys(ATTACHMENT_TYPE_ALIASES), ...extensions].join(',')
}

/**
 * Quantos dos arquivos que chegam cabem no teto. Entra o que cabe e o resto é
 * recusado — jogar fora a seleção inteira por um arquivo a mais faria o
 * operador escolher tudo de novo.
 */
export function canAddFiles(current: number, incoming: number): { accepted: number; refused: number } {
  const room = Math.max(0, MAX_ATTACHMENTS_PER_SEND - current)
  const accepted = Math.min(room, Math.max(0, incoming))
  return { accepted, refused: Math.max(0, incoming) - accepted }
}

/**
 * O nome de um print colado. A área de transferência entrega tudo como
 * `image.png`; com a hora no nome, o operador (e o assinante) distingue um
 * do outro. `index` a partir de 0; o segundo em diante ganha sufixo.
 */
export function pastedFileName(when: Date, index: number, type: string): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  const extension = BY_TYPE.get(ATTACHMENT_TYPE_ALIASES[type] ?? type)?.extensions[0] ?? '.png'
  return `print-${stamp}${index > 0 ? `-${index + 1}` : ''}${extension}`
}

/**
 * Se o nome é o que a área de transferência inventou (`image.png` no Chrome,
 * vazio em outros) — só esse é trocado por `print-<hora>`. Uma foto copiada do
 * Explorer já chega com o nome de verdade, e esse o operador quer manter.
 */
export function isClipboardPlaceholderName(name: string): boolean {
  return name.trim() === '' || /^image\.[a-z0-9]+$/i.test(name.trim())
}
