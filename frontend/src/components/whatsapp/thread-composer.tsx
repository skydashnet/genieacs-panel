'use client'

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { useTranslation } from '@/contexts/language-context'
import { whatsappAPI, type MetaTemplatePayload, type WhatsAppMessage, type WhatsAppMetaTemplate } from '@/lib/api'
import { formatFileSize } from '@/lib/firmware'
import {
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS_PER_SEND,
  acceptAttribute,
  attachmentRefusal,
  canAddFiles,
  isClipboardPlaceholderName,
  isPreviewable,
  pastedFileName,
  planSend,
  resolveAttachmentType
} from '@/lib/wa-attachments'
import {
  fillQuickReply,
  matchQuickReplies,
  quickReplyQuery,
  type QuickReply,
  type QuickReplyVars
} from '@/lib/quick-replies'
import { groupTemplates, type PickableTemplate } from '@/lib/template-picker'
import type { MetaWindow } from '@/lib/wa-meta-window'
import { isAudioType } from '@/lib/wa-audio'
import { VoiceRecorder, canRecordAudio } from '@/components/whatsapp/voice-recorder'

export interface ComposerAttachment {
  url: string
  type?: string
  name?: string
}

interface ThreadComposerProps {
  /** Purely informational here. Opt-out never closes this box — see below. */
  optedOut: boolean
  sending: boolean
  onSend: (body: string, isNote: boolean, attachment?: ComposerAttachment) => Promise<boolean>
  /** A mensagem que a próxima resposta cita; o chip acima da caixa a mostra. */
  replyTo?: WhatsAppMessage | null
  onCancelReply?: () => void
  /**
   * Text handed in from outside — the SGP module's second copy. It REPLACES
   * what is in the box and goes nowhere by itself: the operator reads it and
   * presses Send. `id` changes on every hand-over, so the same text twice is
   * two hand-overs.
   */
  draft?: { id: number; text: string } | null
  /**
   * As respostas rápidas (modelos da categoria `atendimento`). `null` quando
   * quem está logado não pode listá-las: nem o "/" nem o botão aparecem.
   */
  quickReplies?: QuickReply[] | null
  /** O que se sabe da conversa aberta, para preencher as variáveis. */
  quickReplyVars?: QuickReplyVars
  /**
   * A janela de 24 h da API oficial. Fechada, só nota interna sai — o
   * servidor recusaria a resposta com `meta_window_closed`.
   */
  metaWindow?: MetaWindow | null
  /** Os modelos aprovados da Meta do número da conversa (número oficial). */
  metaTemplates?: WhatsAppMetaTemplate[]
  /** Envia um modelo aprovado — o único envio aceito fora da janela. */
  onSendTemplate?: (payload: MetaTemplatePayload) => Promise<boolean>
  /**
   * "Sugerir (IA)": pede um rascunho e o põe na caixa. Nada é enviado — o
   * atendente lê, corrige e aperta Enviar. Ausente, o botão não aparece.
   */
  onSuggest?: () => Promise<string | null>
  /** Teclado aberto no celular: some o que é só informativo e a nota vira só o cadeado. */
  compact?: boolean
  /**
   * O botão "Modelos": todos os modelos ativos do painel. `null` quando quem
   * está logado não pode listá-los — aí o botão não aparece.
   */
  templates?: PickableTemplate[] | null
  /**
   * O texto do modelo já preenchido para esta conversa (pela conversa ou, com
   * variável de fatura, pelo servidor). `null` = não deu; quem chama avisa.
   * Nada é enviado: o texto vai para a caixa.
   */
  onPickTemplate?: (template: PickableTemplate) => Promise<string | null>
}

/**
 * Um arquivo escolhido e ainda não enviado. `type` é o já resolvido — o que
 * vai no upload —, e `preview` é a URL de objeto da miniatura, que precisa ser
 * revogada quando o arquivo sai da caixa, ou fica presa na memória da aba.
 */
interface PickedFile {
  id: number
  file: File
  type: string
  preview: string | null
}

/** Arrastar texto ou um link da própria página não é anexar. */
const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

/**
 * The reply box.
 *
 * Three rules it exists to hold:
 *
 *  · **Opt-out does not disable it.** "Não perturbe" means the provider does
 *    not *start* a conversation with that number; the person on the other end
 *    wrote in, and refusing to answer them would be a worse product, not a more
 *    respectful one. The server agrees — the send route never consults the
 *    opt-out list. So the state is shown as a badge and an explanation and
 *    nothing else: an operator who cannot answer a customer is the one failure
 *    on this screen nobody would report as a bug, they would just stop using it.
 *
 *  · **Note mode is loud and does not stick.** An internal note is stored with
 *    `deliveryStatus: null` and the outbox worker never sees it, so a note
 *    mistaken for a reply is a customer waiting for words that were never sent.
 *    While the toggle is on the whole box turns amber, and it resets after
 *    every send: a sticky note mode would silently swallow the *next* reply,
 *    which is the dangerous direction. A note that carries a file is still a
 *    note — the file rides along, the `isNote` flag does not change.
 *
 *  · **A caption is optional.** A photo of the fibre path with nothing written
 *    under it is a whole message, so the Send button follows "text OR file",
 *    not "text". The server agrees: it refuses `message_empty` only when both
 *    are missing.
 *
 * Vários arquivos de uma vez (pelo seletor, colando um print com Ctrl+V ou
 * soltando sobre a caixa), e cada um vira uma mensagem, na ordem da tela. O
 * texto digitado vai como legenda do PRIMEIRO; os outros vão sem texto
 * (`planSend`). Um envio que falha no meio para ali: o que já saiu sai da
 * caixa, o que não saiu fica — inclusive o texto, se ele ainda não foi — e o
 * modo nota continua ligado, porque o resto do lote ainda é nota e virar
 * resposta no meio do caminho é justamente a direção perigosa.
 */
export function ThreadComposer({ optedOut, sending, onSend, replyTo = null, onCancelReply, draft = null, quickReplies = null, quickReplyVars = {}, metaWindow = null, metaTemplates = [], onSendTemplate, onSuggest, templates = null, onPickTemplate, compact = false }: ThreadComposerProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [body, setBody] = useState('')
  const [isNote, setIsNote] = useState(false)
  const [items, setItems] = useState<PickedFile[]>([])
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState<{ n: number; total: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [picking, setPicking] = useState<number | null>(null)
  // Lido uma vez: o navegador não ganha nem perde microfone com a aba aberta.
  const [canRecord] = useState(canRecordAudio)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // Respostas rápidas: abrem com "/" no começo da caixa ou pelo botão.
  // `dismissedFor` guarda o texto em que o Esc fechou a lista, para ela não
  // reabrir sozinha até a pessoa digitar outra coisa.
  const [pickerByButton, setPickerByButton] = useState(false)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [activeRaw, setActiveRaw] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)
  // `dragenter`/`dragleave` disparam a cada filho atravessado; só a contagem
  // diz quando o arquivo saiu da caixa de verdade.
  const dragDepth = useRef(0)
  // As URLs vivas ficam aqui, fora do estado, para a limpeza da desmontagem
  // alcançá-las sem depender da última renderização.
  const previews = useRef(new Set<string>())

  useEffect(() => {
    const live = previews.current
    return () => {
      live.forEach((url) => URL.revokeObjectURL(url))
      live.clear()
    }
  }, [])

  // Taken in during render rather than in an effect, so the box never paints
  // one frame with the old text. A draft is a reply, never a note: a billing
  // text filed as an internal note would be a customer waiting for nothing.
  const [takenDraft, setTakenDraft] = useState<number | null>(draft?.id ?? null)
  if (draft && draft.id !== takenDraft) {
    setTakenDraft(draft.id)
    setBody(draft.text)
    setIsNote(false)
  }
  useEffect(() => {
    if (draft) boxRef.current?.focus()
  }, [draft])

  const slashQuery = quickReplyQuery(body)
  const pickerOpen = quickReplies !== null
    && (pickerByButton || (slashQuery !== null && body !== dismissedFor))
  const matches = pickerOpen ? matchQuickReplies(quickReplies ?? [], pickerByButton ? '' : slashQuery ?? '') : []
  const active = Math.min(activeRaw, Math.max(0, matches.length - 1))

  const closePicker = () => {
    setPickerByButton(false)
    setDismissedFor(body)
    setActiveRaw(0)
  }

  // Troca o "/texto" (ou o que estiver na caixa, pelo botão) pela resposta já
  // preenchida. Não envia: o atendente revisa e aperta Enviar.
  // O modelo escolhido entra como a resposta rápida: substitui a caixa vazia
  // ou vai numa linha nova depois do que já estava escrito. Não envia.
  const putInBox = (texto: string) => {
    setBody((atual) => (atual.trim() ? `${atual.trimEnd()}\n${texto}` : texto))
    setIsNote(false)
    boxRef.current?.focus()
  }

  const chooseTemplate = async (item: PickableTemplate) => {
    if (!onPickTemplate || picking !== null) return
    setPicking(item.id)
    try {
      const texto = await onPickTemplate(item)
      if (texto === null) return
      setTemplatesOpen(false)
      putInBox(texto)
    } finally {
      setPicking(null)
    }
  }

  const chooseQuickReply = (item: QuickReply) => {
    const filled = fillQuickReply(item.body, quickReplyVars)
    setBody(pickerByButton && body.trim() && slashQuery === null ? `${body.trimEnd()}\n${filled}` : filled)
    setPickerByButton(false)
    setDismissedFor(null)
    setActiveRaw(0)
    setIsNote(false)
    boxRef.current?.focus()
  }

  // `sending` volta a false entre um arquivo e outro do lote; `working` cobre
  // o lote inteiro, para ninguém mexer na fila enquanto ela anda.
  const busy = sending || working
  const empty = body.trim().length === 0 && items.length === 0
  // Fora da janela da Meta a resposta não sai; a nota interna sai, porque
  // não vai para o cliente.
  const windowBlocked = metaWindow?.state === 'closed' && !isNote

  const release = (item: PickedFile) => {
    if (!item.preview) return
    URL.revokeObjectURL(item.preview)
    previews.current.delete(item.preview)
  }

  const removeItem = (item: PickedFile) => {
    release(item)
    setItems((current) => current.filter((row) => row.id !== item.id))
  }

  /**
   * Recusado antes de sair um byte: o arquivo nem entra na caixa, então o
   * operador não aperta Enviar em algo que já ia falhar. Os bons entram mesmo
   * que um vizinho seja recusado — um PDF errado não derruba nove fotos certas.
   */
  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0 || busy) return
    const fine: File[] = []
    for (const candidate of incoming) {
      const problem = attachmentRefusal(candidate)
      if (problem) {
        toast.error(t(problem.key, problem.vars), { title: candidate.name || t('whatsapp.inbox.attach') })
        continue
      }
      fine.push(candidate)
    }
    const { accepted, refused } = canAddFiles(items.length, fine.length)
    if (refused > 0) {
      toast.error(t('whatsapp.inbox.attachMax', { max: MAX_ATTACHMENTS_PER_SEND }), { title: t('whatsapp.inbox.attach') })
    }
    if (accepted === 0) return
    const picked = fine.slice(0, accepted).map((file): PickedFile => {
      // Já passou por `attachmentRefusal`, então o tipo resolve.
      const type = resolveAttachmentType(file) ?? file.type
      let preview: string | null = null
      // A miniatura da foto, ou o player do áudio para ouvir antes de mandar.
      if (isPreviewable(type) || isAudioType(type)) {
        preview = URL.createObjectURL(file)
        previews.current.add(preview)
      }
      return { id: nextId.current++, file, type, preview }
    })
    setItems((current) => [...current, ...picked])
  }

  /**
   * Ctrl+V com imagem na área de transferência vira anexo. Só quando há
   * ARQUIVO lá: colar texto continua sendo colar texto, sem nada interceptado.
   */
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    const now = new Date()
    let shot = 0
    addFiles(files.map((file) => (
      file.type.startsWith('image/') && isClipboardPlaceholderName(file.name)
        ? new File([file], pastedFileName(now, shot++, file.type), { type: file.type, lastModified: now.getTime() })
        : file
    )))
  }

  const dragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    // Sem o `preventDefault` aqui o navegador não aceita o drop e abre o
    // arquivo no lugar do painel.
    event.preventDefault()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }
  const dragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const submit = async () => {
    // Guarded here rather than left to the server: `message_empty` is a refusal
    // the box can simply never provoke, and a disabled button says so before
    // the operator presses it.
    if (empty || busy || windowBlocked) return

    const steps = planSend({ body, files: items, isAudio: (item) => isAudioType(item.type) })
    const total = steps.length
    setWorking(true)
    try {
      for (const [index, step] of steps.entries()) {
        if (total > 1) setProgress({ n: index + 1, total })

        let attachment: ComposerAttachment | undefined
        if (step.file) {
          const picked = step.file
          let stored
          try {
            stored = await whatsappAPI.uploadAttachment(picked.file, picked.type)
          } catch {
            stored = { success: false as const, code: undefined, data: undefined }
          }
          if (!stored.success || !stored.data) {
            // Para aqui: este arquivo e os seguintes ficam na caixa, na mesma
            // ordem, e o próximo Enviar recomeça exatamente deste.
            toast.error(
              whatsappErrorMessage(t, stored.code, { max: MAX_ATTACHMENT_MB }),
              { title: `${t('whatsapp.inbox.sendFailed')} — ${picked.file.name}` }
            )
            return
          }
          // `path` is the stored reference, relative to the panel's data directory.
          // The send route takes it as `attachment.url` and writes it to the row.
          attachment = { url: stored.data.path, type: stored.data.type, name: stored.data.name }
        }

        // A recusa do envio já vira toast no pai (`whatsappErrorMessage` sobre o
        // código); repetir aqui seria o mesmo aviso duas vezes.
        const ok = await onSend(step.body, isNote, attachment)
        if (!ok) return

        // O texto saiu com este passo: sai da caixa. Só se ainda for o mesmo —
        // um rascunho do SGP que chegou no meio do lote não é apagado.
        if (step.body) setBody((current) => (current.trim() === step.body ? '' : current))
        if (step.file) removeItem(step.file)
      }
      setIsNote(false)
      if (fileRef.current) fileRef.current.value = ''
      boxRef.current?.focus()
    } finally {
      setWorking(false)
      setProgress(null)
    }
  }

  const sendLabel = progress
    ? t('whatsapp.inbox.sendingProgress', { n: progress.n, total: progress.total })
    : isNote ? t('whatsapp.inbox.note') : t('whatsapp.inbox.send')

  return (
    <div
      className={`@container relative border-t border-border bg-card ${compact ? 'p-2' : 'p-2.5 sm:p-3'}`}
      data-testid="composer"
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card text-sm font-semibold text-primary shadow-lg">
          <Icon name="paperclip" size={18} />
          {t('whatsapp.inbox.attachDrop')}
        </div>
      )}

      {metaWindow?.state === 'closed' && (
        <div className="mb-2.5 rounded-md border border-[hsl(var(--status-danger))]/40 bg-[hsl(var(--status-danger))]/8 px-3 py-2 text-xs leading-5 text-foreground">
          <p className="flex items-start gap-2">
            <Icon name="lock" size={14} className="mt-0.5 shrink-0 text-[hsl(var(--status-danger))]" />
            <span>{t('whatsapp.cloud.windowClosed')}</span>
          </p>
          {onSendTemplate && (
            <MetaTemplatePicker templates={metaTemplates} busy={sending} onSend={onSendTemplate} />
          )}
        </div>
      )}
      {!compact && metaWindow?.state === 'open' && (
        <p className="mb-2 text-xs text-muted-foreground">
          {t('whatsapp.cloud.windowOpen', { hours: metaWindow.hoursLeft })}
        </p>
      )}

      {optedOut && (
        <p className="mb-2.5 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/8 px-3 py-2 text-xs leading-5 text-foreground">
          <Icon name="bell" size={14} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
          <span>
            <strong className="font-semibold">{t('whatsapp.inbox.optedOut')}.</strong>{' '}
            {t('whatsapp.inbox.optedOutHint')}
          </span>
        </p>
      )}

      {replyTo && !isNote && (
        <div className="mb-1.5 flex items-start gap-2 rounded border-s-2 border-primary/60 bg-[hsl(var(--surface-subtle))] px-2 py-1 text-xs">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-muted-foreground">{t('whatsapp.msg.replyingTo')}</p>
            <p className="line-clamp-2 whitespace-pre-wrap wrap-anywhere text-foreground">{replyTo.body || t('whatsapp.msg.attachment')}</p>
          </div>
          <button
            type="button"
            className="icon-button size-6 shrink-0"
            aria-label={t('whatsapp.msg.cancelReply')}
            title={t('whatsapp.msg.cancelReply')}
            onClick={onCancelReply}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <textarea
        ref={boxRef}
        // Duas linhas no celular, onde cada linha da caixa é uma linha a menos
        // de conversa; a partir de `sm`, a altura de sempre. O `!` é porque
        // `textarea.modern-input` (globals.css) fixa `min-h-24` com
        // especificidade maior que a de uma classe utilitária.
        rows={2}
        className={`modern-input min-h-20 resize-y ${compact ? 'max-sm:min-h-11!' : 'max-sm:min-h-14!'} ${
          isNote
            ? 'border-[hsl(var(--status-warning))]/70 bg-[hsl(var(--status-warning))]/6 focus:border-[hsl(var(--status-warning))] focus:ring-[hsl(var(--status-warning))]/20'
            : ''
        }`}
        placeholder={t('whatsapp.inbox.placeholder')}
        aria-label={t('whatsapp.inbox.placeholder')}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onPaste={paste}
        onKeyDown={(event) => {
          if (pickerOpen) {
            // Com a lista aberta, as setas andam nela e o Enter escolhe —
            // nunca envia um "/pra" pela metade.
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (matches.length) {
                setActiveRaw((active + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
              }
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              closePicker()
              return
            }
            if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
              event.preventDefault()
              if (matches[active]) chooseQuickReply(matches[active])
              return
            }
          }
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          void submit()
        }}
        aria-expanded={pickerOpen}
        aria-controls={pickerOpen ? 'quick-reply-list' : undefined}
        aria-activedescendant={pickerOpen && matches[active] ? `quick-reply-${matches[active].id}` : undefined}
      />

      {pickerOpen && (
        <div className="mt-1.5 rounded-md border border-border bg-card shadow-xs">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {(quickReplies ?? []).length === 0
                ? t('whatsapp.quickReplies.empty')
                : t('whatsapp.quickReplies.noMatch', { query: slashQuery ?? '' })}
            </p>
          ) : (
            <ul id="quick-reply-list" role="listbox" aria-label={t('whatsapp.quickReplies.listLabel')} className="max-h-56 overflow-y-auto py-1">
              {matches.map((item, index) => (
                <li
                  key={item.id}
                  id={`quick-reply-${item.id}`}
                  role="option"
                  aria-selected={index === active}
                  className={`cursor-pointer px-3 py-1.5 text-sm ${index === active ? 'bg-muted' : ''}`}
                  // mousedown e não click: o click chega depois do blur da caixa.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    chooseQuickReply(item)
                  }}
                  onMouseEnter={() => setActiveRaw(index)}
                >
                  <span className="block font-semibold text-foreground">/{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{fillQuickReply(item.body, quickReplyVars)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">{t('whatsapp.quickReplies.hint')}</p>
        </div>
      )}

      {templatesOpen && templates !== null && (
        <TemplatePicker
          templates={templates}
          picking={picking}
          onChoose={(item) => void chooseTemplate(item)}
          onClose={() => {
            setTemplatesOpen(false)
            boxRef.current?.focus()
          }}
        />
      )}

      {items.length === 0 ? (
        // Arrastar e Ctrl+V não existem no celular: a dica só aparece onde vale.
        <p className="field-hint hidden sm:block">{t('whatsapp.inbox.attachHint')}</p>
      ) : (
        <div className="mt-2" data-testid="composer-attachments">
          <p className="field-hint mb-1.5 mt-0 flex flex-wrap gap-x-1.5">
            <span className="font-semibold">{t('whatsapp.inbox.attachCount', { count: items.length })}</span>
            {body.trim() && <span>· {t('whatsapp.inbox.captionHint')}</span>}
          </p>
          <ul className="flex flex-wrap gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid="composer-attachment"
                className={`flex ${isAudioType(item.type) ? 'w-80' : 'w-60'} max-w-full items-center gap-2 rounded-md border border-border bg-background/50 p-1.5 text-xs text-foreground`}
              >
                {item.preview && isAudioType(item.type) ? (
                  <audio controls preload="metadata" src={item.preview} className="h-9 min-w-0 flex-1" aria-label={item.file.name} />
                ) : item.preview ? (
                  <img src={item.preview} alt="" className="size-10 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    <Icon name="document" size={18} />
                  </span>
                )}
                {!isAudioType(item.type) && (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={item.file.name}>{item.file.name}</span>
                    <span className="block text-muted-foreground">{formatFileSize(item.file.size)}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="icon-button size-10 shrink-0 lg:size-6"
                  aria-label={t('whatsapp.inbox.attachRemove', { name: item.file.name })}
                  title={t('whatsapp.inbox.attachRemove', { name: item.file.name })}
                  disabled={busy}
                  onClick={() => removeItem(item)}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* No celular, "Enviar" sobe para a linha da nota e os outros botões
          descem juntos para a de baixo: eram três linhas tirando altura da
          conversa. Com o teclado aberto (`compact`) já cabe tudo numa linha. */}
      <div className={`${compact ? 'mt-1.5 gap-2' : 'mt-2.5 gap-3 max-sm:justify-end max-sm:gap-x-2 max-sm:gap-y-0'} flex flex-wrap items-center justify-between @4xl:items-start`}>
        <div className={`min-w-0 ${compact ? '' : 'max-sm:order-first max-sm:mr-auto'}`}>
          <label
            className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-foreground"
            title={t('whatsapp.inbox.noteHint')}
          >
            <input
              type="checkbox"
              className="size-4 accent-[hsl(var(--status-warning))]"
              checked={isNote}
              onChange={(event) => setIsNote(event.target.checked)}
            />
            <Icon name="lock" size={14} className={isNote ? 'text-[hsl(var(--status-warning))]' : 'text-muted-foreground'} />
            <span className={compact ? 'sr-only' : undefined}>{t('whatsapp.inbox.note')}</span>
          </label>
          <p className="field-hint hidden max-w-md @6xl:block">{t('whatsapp.inbox.noteHint')}</p>
        </div>

        <div className={`flex flex-wrap items-center justify-end gap-2 ${compact ? '' : 'max-sm:contents'}`}>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            data-testid="composer-file"
            accept={acceptAttribute()}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []))
              // The input keeps its own value, and an unreset one refuses to fire
              // `change` when the operator picks the very same file again.
              event.target.value = ''
            }}
          />
          {/* Com o teclado aberto ficam só anexar e enviar: o "/" ainda abre as
              respostas rápidas, e o resto volta quando o teclado fecha. */}
          {!compact && quickReplies !== null && (
            <button
              type="button"
              className="modern-button-secondary shrink-0 px-3 @4xl:px-4"
              aria-label={t('whatsapp.quickReplies.button')}
              title={t('whatsapp.quickReplies.button')}
              aria-pressed={pickerOpen}
              disabled={busy}
              onClick={() => {
                if (pickerOpen) closePicker()
                else {
                  setPickerByButton(true)
                  setActiveRaw(0)
                  setTemplatesOpen(false)
                }
                boxRef.current?.focus()
              }}
            >
              <Icon name="chat" size={16} />
              <span className="hidden @4xl:inline">{t('whatsapp.quickReplies.button')}</span>
            </button>
          )}
          {!compact && templates !== null && onPickTemplate && (
            <button
              type="button"
              className="modern-button-secondary shrink-0 px-3 sm:px-4"
              aria-label={t('whatsapp.templatePicker.button')}
              title={t('whatsapp.templatePicker.button')}
              aria-pressed={templatesOpen}
              aria-expanded={templatesOpen}
              aria-controls={templatesOpen ? 'template-picker' : undefined}
              disabled={busy}
              onClick={() => {
                if (!templatesOpen && pickerOpen) closePicker()
                setTemplatesOpen(!templatesOpen)
              }}
            >
              <Icon name="document" size={16} />
              <span className="hidden sm:inline">{t('whatsapp.templatePicker.button')}</span>
            </button>
          )}
          {!compact && onSuggest && !isNote && (
            <button
              type="button"
              className="modern-button-secondary shrink-0 px-3 @4xl:px-4"
              aria-label={t('whatsapp.ai.suggest')}
              title={t('whatsapp.ai.suggest')}
              disabled={busy || suggesting}
              onClick={() => {
                setSuggesting(true)
                void onSuggest()
                  .then((texto) => {
                    if (!texto) return
                    setBody(texto)
                    boxRef.current?.focus()
                  })
                  .finally(() => setSuggesting(false))
              }}
            >
              <Icon name="sparkles" size={16} />
              <span className="hidden @4xl:inline">{suggesting ? t('whatsapp.ai.suggesting') : t('whatsapp.ai.suggest')}</span>
            </button>
          )}
          {!compact && canRecord && !isNote && (
            <VoiceRecorder
              disabled={busy || items.length >= MAX_ATTACHMENTS_PER_SEND}
              onRecorded={(file) => addFiles([file])}
            />
          )}
          <button
            type="button"
            className="modern-button-secondary shrink-0 px-3 @4xl:px-4"
            aria-label={t('whatsapp.inbox.attach')}
            title={t('whatsapp.inbox.attachHint')}
            disabled={busy || items.length >= MAX_ATTACHMENTS_PER_SEND}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="paperclip" size={16} />
            <span className="hidden @4xl:inline">{t('whatsapp.inbox.attach')}</span>
          </button>

          <button
            type="button"
            className={`${isNote ? 'modern-button-secondary shrink-0 border-[hsl(var(--status-warning))]/70' : 'modern-button shrink-0'} ${compact ? '' : 'max-sm:-order-1'}`}
            disabled={empty || busy || windowBlocked}
            aria-live="polite"
            onClick={() => void submit()}
          >
            <Icon name={busy ? 'refresh' : isNote ? 'lock' : 'chat'} size={16} className={busy ? 'animate-spin' : ''} />
            {sendLabel}
          </button>
          {!compact && <span aria-hidden="true" className="hidden max-sm:-order-1 max-sm:block max-sm:h-2 max-sm:basis-full" />}
        </div>
      </div>
    </div>
  )
}

const CATEGORY_LABEL = {
  atendimento: 'whatsapp.templates.categoryAtendimento',
  cobranca: 'whatsapp.templates.categoryCobranca',
  suporte: 'whatsapp.templates.categorySuporte',
  alerta: 'whatsapp.templates.categoryAlerta',
  geral: 'whatsapp.templates.categoryGeral'
} as const

/**
 * A lista do botão "Modelos": busca no topo, os modelos em grupos por
 * categoria. Setas andam, Enter escolhe, Esc fecha. Um modelo que pede a
 * fatura fica "carregando" enquanto o servidor relê o SGP.
 */
function TemplatePicker({
  templates,
  picking,
  onChoose,
  onClose
}: {
  templates: PickableTemplate[]
  picking: number | null
  onChoose: (item: PickableTemplate) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [activeRaw, setActiveRaw] = useState(0)
  const groups = groupTemplates(templates, query)
  const flat = groups.flatMap((group) => group.items)
  const active = Math.min(activeRaw, Math.max(0, flat.length - 1))
  const temAlgum = templates.some((item) => item.active !== false)

  return (
    <div id="template-picker" className="mt-1.5 rounded-md border border-border bg-card shadow-xs">
      <div className="border-b border-border p-2">
        <input
          type="search"
          autoFocus
          className="modern-input h-9 py-1 text-sm"
          placeholder={t('whatsapp.templatePicker.search')}
          aria-label={t('whatsapp.templatePicker.search')}
          aria-controls="template-picker-list"
          aria-activedescendant={flat[active] ? `template-pick-${flat[active].id}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveRaw(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (flat.length) setActiveRaw((active + (event.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (flat[active]) onChoose(flat[active])
            }
          }}
        />
      </div>
      {flat.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          {temAlgum ? t('whatsapp.templatePicker.noMatch', { query }) : t('whatsapp.templatePicker.empty')}
        </p>
      ) : (
        <ul id="template-picker-list" role="listbox" aria-label={t('whatsapp.templatePicker.button')} className="max-h-64 overflow-y-auto py-1">
          {groups.map((group) => (
            <li key={group.category} role="presentation">
              <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t(CATEGORY_LABEL[group.category])}
              </p>
              <ul role="presentation">
                {group.items.map((item) => {
                  const index = flat.indexOf(item)
                  return (
                    <li
                      key={item.id}
                      id={`template-pick-${item.id}`}
                      role="option"
                      aria-selected={index === active}
                      aria-busy={picking === item.id}
                      className={`cursor-pointer px-3 py-1.5 text-sm ${index === active ? 'bg-muted' : ''} ${picking !== null && picking !== item.id ? 'opacity-60' : ''}`}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        onChoose(item)
                      }}
                      onMouseEnter={() => setActiveRaw(index)}
                    >
                      <span className="flex items-center gap-1.5 font-semibold text-foreground">
                        {picking === item.id && <Icon name="refresh" size={12} className="animate-spin" />}
                        {item.name}
                        {picking === item.id && <span className="text-xs font-normal text-muted-foreground">{t('whatsapp.templatePicker.loading')}</span>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{item.body}</span>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">{t('whatsapp.templatePicker.hint')}</p>
    </div>
  )
}

/** O nome do documento pelo fim do link, quando ele tem extensão. */
function filenameFromLink(link: string): string | undefined {
  try {
    const last = decodeURIComponent(new URL(link).pathname.split('/').pop() ?? '')
    return /^[^.]+\.[A-Za-z0-9]{2,5}$/.test(last) ? last.slice(0, 80) : undefined
  } catch {
    return undefined
  }
}

const HTTPS_LINK = /^https:\/\/\S+$/i

/**
 * O modelo aprovado que o atendente manda quando a janela de 24 h fechou:
 * escolhe o modelo, preenche cada `{{n}}` e vê o texto como vai sair. Modelo
 * com mídia no cabeçalho pede o link (https) do arquivo; cabeçalho de texto
 * com variável pede o texto; botão de URL dinâmica pede o final da URL.
 */
function MetaTemplatePicker({
  templates,
  busy,
  onSend
}: {
  templates: WhatsAppMetaTemplate[]
  busy: boolean
  onSend: (payload: MetaTemplatePayload) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [chosenId, setChosenId] = useState<number | null>(null)
  const [params, setParams] = useState<string[]>([])
  const [headerValue, setHeaderValue] = useState('')
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({})
  const chosen = templates.find((m) => m.id === chosenId) ?? null
  const preview = chosen
    ? chosen.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n: string) => params[Number(n) - 1] || all)
    : ''
  const mediaType = chosen && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(chosen.headerFormat)
    ? (chosen.headerFormat.toLowerCase() as 'image' | 'video' | 'document')
    : null
  const textHeader = Boolean(chosen && chosen.headerFormat === 'TEXT' && chosen.headerParamCount > 0)
  const dynamicButtons = chosen ? chosen.buttons.filter((b) => b.urlHasParam) : []
  const headerOk = mediaType ? HTTPS_LINK.test(headerValue.trim()) : textHeader ? Boolean(headerValue.trim()) : true
  const ready = Boolean(chosen) && params.length === chosen!.paramCount && params.every((p) => p.trim())
    && headerOk && dynamicButtons.every((b) => (buttonParams[b.index] ?? '').trim())

  const payload = (): MetaTemplatePayload => {
    const out: MetaTemplatePayload = { name: chosen!.name, language: chosen!.language, params: params.map((p) => p.trim()) }
    const link = headerValue.trim()
    if (mediaType) {
      const filename = mediaType === 'document' ? filenameFromLink(link) : undefined
      out.header = { type: mediaType, link, ...(filename ? { filename } : {}) }
    } else if (textHeader) {
      out.header = { type: 'text', params: [link] }
    }
    if (dynamicButtons.length) {
      out.buttons = dynamicButtons.map((b) => ({ index: b.index, param: (buttonParams[b.index] ?? '').trim() }))
    }
    return out
  }

  if (!open) {
    return (
      <button type="button" className="modern-button-secondary mt-2 min-h-9 px-3 py-1 text-xs" onClick={() => setOpen(true)}>
        <Icon name="document" size={14} />
        {t('whatsapp.metaTemplates.sendApproved')}
      </button>
    )
  }

  if (templates.length === 0) {
    return <p className="mt-2 text-muted-foreground">{t('whatsapp.metaTemplates.noneForNumber')}</p>
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <select
        aria-label={t('whatsapp.metaTemplates.pick')}
        className="modern-input"
        value={chosenId ?? ''}
        onChange={(event) => {
          const id = Number(event.target.value) || null
          const m = templates.find((x) => x.id === id)
          setChosenId(id)
          setParams(Array.from({ length: m?.paramCount ?? 0 }, () => ''))
          setHeaderValue('')
          setButtonParams({})
        }}
      >
        <option value="">{t('whatsapp.metaTemplates.pick')}</option>
        {templates.map((m) => (
          <option key={m.id} value={m.id}>{`${m.name} · ${m.language}`}</option>
        ))}
      </select>
      {chosen && (
        <>
          {(mediaType || textHeader) && (
            <input
              type={mediaType ? 'url' : 'text'}
              inputMode={mediaType ? 'url' : undefined}
              className="modern-input"
              aria-label={mediaType ? t('whatsapp.metaTemplates.headerLinkLabel') : t('whatsapp.metaTemplates.headerTextLabel')}
              placeholder={mediaType
                ? `${t('whatsapp.metaTemplates.headerLinkLabel')} — https://`
                : t('whatsapp.metaTemplates.headerTextLabel')}
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
            />
          )}
          {params.map((value, i) => (
            <input
              key={i}
              className="modern-input"
              placeholder={t('whatsapp.metaTemplates.paramLabel', { n: i + 1 })}
              value={value}
              onChange={(event) => setParams((c) => c.map((v, j) => (j === i ? event.target.value : v)))}
            />
          ))}
          {dynamicButtons.map((b) => (
            <input
              key={`button-${b.index}`}
              className="modern-input"
              aria-label={t('whatsapp.metaTemplates.buttonParamLabel')}
              placeholder={t('whatsapp.metaTemplates.buttonParamLabel')}
              value={buttonParams[b.index] ?? ''}
              onChange={(event) => setButtonParams((c) => ({ ...c, [b.index]: event.target.value }))}
            />
          ))}
          <p className="whitespace-pre-wrap wrap-break-word rounded border border-border bg-background/60 px-2 py-1.5 text-foreground">{preview}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="modern-button min-h-9 px-3 py-1 text-xs"
              disabled={!ready || busy}
              onClick={() => void onSend(payload())
                .then((ok) => {
                  if (!ok) return
                  setOpen(false)
                  setChosenId(null)
                  setParams([])
                  setHeaderValue('')
                  setButtonParams({})
                })}
            >
              {t('whatsapp.metaTemplates.sendTemplate')}
            </button>
            <button type="button" className="modern-button-secondary min-h-9 px-3 py-1 text-xs" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
