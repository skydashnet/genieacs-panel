'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  whatsappAPI,
  type MetaTemplatePayload,
  type WhatsAppAccount,
  type WhatsAppMetaTemplate,
  type WhatsAppConversation,
  type WhatsAppMessage,
  type WhatsAppTag
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { InboxFilterButton, InboxFilterChips } from '@/components/whatsapp/inbox-filters'
import { ForwardDialog } from '@/components/whatsapp/forward-dialog'
import { conversationTitle } from '@/components/whatsapp/conversation-list'
import type { AssigneeFilter } from '@/lib/inbox-filters'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { ConversationList } from '@/components/whatsapp/conversation-list'
import { ConversationThread } from '@/components/whatsapp/conversation-thread'
import { SubscriberPanel } from '@/components/whatsapp/subscriber-panel'
import { ThreadComposer, type ComposerAttachment } from '@/components/whatsapp/thread-composer'
import { DunningSection } from '@/components/whatsapp/dunning-section'
import { CampaignsPanel } from '@/components/whatsapp/campaigns-panel'
import { ReferralsPanel } from '@/components/whatsapp/referrals-panel'
import { TemplatesPanel } from '@/components/whatsapp/templates-panel'
import { OptOutPanel } from '@/components/whatsapp/opt-out-panel'
import { BotReportPanel } from '@/components/whatsapp/bot-report-panel'
import { SatisfactionPanel } from '@/components/whatsapp/satisfaction-panel'
import { MetaUsagePanel } from '@/components/whatsapp/meta-usage-panel'
import { ResponseTimePanel } from '@/components/whatsapp/response-time-panel'
import { TagsReportPanel } from '@/components/whatsapp/tags-report-panel'
import { MaintenancePanel } from '@/components/maintenance/maintenance-panel'
import { AlertsPanel } from '@/components/whatsapp/alerts-panel'
import { OutagePanel } from '@/components/outages/outage-panel'
import { ContactsPanel } from '@/components/whatsapp/contacts-panel'
import { HealthBell } from '@/components/whatsapp/health-strip'
import { AvailabilityToggle } from '@/components/whatsapp/assignment'
import { NotifyToggle } from '@/components/whatsapp/message-notifier'
import { focusedConversation } from '@/lib/wa-notify'
import { WaitingBanner, useWaiting } from '@/components/whatsapp/waiting-banner'
import { inboxPanes } from '@/lib/wa-inbox-pane'
import { visibleHeightWithKeyboard } from '@/lib/wa-keyboard'
import { useAuth } from '@/contexts/auth-context'
import { sessionOwner } from '@/lib/session-owner'
import { useLocation, useNavigate } from 'react-router'
import { fillQuickReply, firstName, type QuickReply } from '@/lib/quick-replies'
import { needsInvoice, type PickableTemplate } from '@/lib/template-picker'
import { metaWindowFor } from '@/lib/wa-meta-window'

// ─────────────────────────────────────────────────────────────────────────────
// Polling
//
// Two clocks, deliberately far apart.
//
// The LIST at 15 s is the screen's whole freshness promise: an inbound message
// has to raise a badge on a panel nobody has touched since morning. It is a
// read of one batched query, it is what the operator is scanning, and it is
// cheap enough to run all day.
//
// The OPEN THREAD at 45 s — three times slower — for three reasons, in order of
// weight:
//
//   1. `GET /conversations/:id/messages` is a GET that WRITES. Reading a thread
//      zeroes its `unread_count`. Running the expensive, mutating call on the
//      list's cadence would triple a write nobody asked for and race the list
//      poll over the same counter.
//   2. The list poll is already the fast path for the thing that matters. When
//      it sees the open thread's `lastMessageAt` move, it reloads the thread on
//      the spot — so a customer's reply still lands within the list's 15 s, and
//      the thread's own timer is only a backstop.
//   3. What that backstop is actually for is delivery-status promotion —
//      `sent → delivered → read` on messages already drawn. Nobody watches that
//      with a stopwatch, and replacing the message array under a viewport an
//      operator is reading and typing into is the one poll with a visible cost.
//
// The three rules under both are the ones the pairing block already proved:
// single-flight so a slow round trip is never queued behind itself, a hidden
// tab skips the tick entirely (this screen is left open in a background tab for
// hours), and a failing server is backed off `2 ** failures - 1` ticks instead
// of being hammered. Every timer is owned by an effect that clears on unmount —
// an interval that outlived this page would hit the panel forever.
// ─────────────────────────────────────────────────────────────────────────────
const LIST_POLL_MS = 15_000
const THREAD_POLL_MS = 45_000
const BACKOFF_CAP = 6

/**
 * Long enough that a typed name is one request instead of eight, short enough
 * that the list still feels like it is answering the keyboard.
 */
const SEARCH_DEBOUNCE_MS = 350

type ConversationStatus = 'open' | 'noreply' | 'closed' | 'all'
/** The piles, in the order an operator reaches for them. */
const FILTERS = [
  ['open', 'whatsapp.inbox.filterOpen', 'chat'],
  // Conversas que só receberam envio automático (régua, campanha, alerta):
  // ficam fora de "Abertas" até o cliente responder.
  ['noreply', 'whatsapp.inbox.filterNoReply', 'bell'],
  ['closed', 'whatsapp.inbox.filterClosed', 'check'],
  ['all', 'whatsapp.inbox.filterAll', 'menu']
] as const

/** The API caps the list at 200 and a thread at 500. */
const LIST_LIMIT = 100
const MESSAGE_PAGE = 60

/**
 * The newest page folded into what is already on screen, newest first.
 *
 * Only rows the page does not already carry are kept from `current`, so a
 * message the server has since changed — a delivery status moving from `sent`
 * to `read` — comes back in its new shape rather than pinned to the one this
 * browser first saw.
 */
function mergeNewest(page: WhatsAppMessage[], current: WhatsAppMessage[]): WhatsAppMessage[] {
  if (current.length === 0) return page
  const fresh = new Set(page.map((message) => message.id))
  return [...page, ...current.filter((message) => !fresh.has(message.id))]
    .sort((a, b) => b.id - a.id)
}

/**
 * The operator's WhatsApp inbox: conversations on the left, the open thread and
 * the reply box on the right. The routes it consumes are frozen in
 * `docs/whatsapp-api-contract.md`.
 */
/** Where the operator's choice to keep the SGP module open is remembered. */
const SGP_PANEL_KEY = 'whatsapp.sgpPanelOpen'

/**
 * Open by default only where it fits beside the thread. Below xl it is a drawer
 * over the conversation, and one that opens by itself on every thread would
 * hide what the operator came to read.
 */
function readPanelPreference(): boolean {
  let wide: boolean
  try {
    wide = window.matchMedia('(min-width: 1280px)').matches
  } catch {
    wide = false
  }
  try {
    const stored = window.localStorage.getItem(SGP_PANEL_KEY)
    return stored === null ? wide : stored === '1'
  } catch {
    return wide
  }
}

interface InboxTabProps {
  /**
   * Muda a cada pedido de "voltar para a lista" (a aba Conversas clicada de
   * novo, ou WhatsApp no menu lateral): a conversa aberta fecha. Num notebook
   * com o Módulo SGP aberto a lista some, e não havia outro jeito de voltar.
   */
  backToList?: number
  /**
   * A thread to open on arrival — the one the Contacts tab just opened or
   * started. Drawn from this row while its history loads, like a click.
   */
  initialConversation?: WhatsAppConversation | null
}

function InboxTab({ initialConversation = null, backToList = 0 }: InboxTabProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const { can, user } = useAuth()
  // Respostas rápidas: os modelos `atendimento`, lidos uma vez. `null` para
  // quem não pode listar modelos — aí nem o "/" nem o botão aparecem.
  const canQuickReply = can('campaigns.read')
  // Uma leitura só: o botão "Modelos" mostra todos os ativos, e as respostas
  // rápidas são os da categoria `atendimento` entre eles.
  const [allTemplates, setAllTemplates] = useState<PickableTemplate[] | null>(null)
  const quickReplies = useMemo<QuickReply[] | null>(
    () => (allTemplates === null ? null : allTemplates.filter((row) => row.category === 'atendimento')),
    [allTemplates]
  )
  useEffect(() => {
    if (!canQuickReply) return
    let vivo = true
    void whatsappAPI.listTemplates().then((res) => {
      if (vivo) setAllTemplates(res.success && Array.isArray(res.data) ? res.data.filter((row) => row.active) : [])
    })
    return () => {
      vivo = false
    }
  }, [canQuickReply])
  // "Sugerir (IA)": só para quem responde, e só com a sugestão ligada na aba Chatbot.
  const canSuggest = can('whatsapp.send')
  const [aiSuggest, setAiSuggest] = useState(false)
  useEffect(() => {
    if (!canSuggest) return
    let vivo = true
    void whatsappAPI.getAiStatus().then((res) => {
      if (vivo) setAiSuggest(Boolean(res.success && res.data?.suggest))
    })
    return () => {
      vivo = false
    }
  }, [canSuggest])
  // The module reads the ERP, so it is there only for whoever may read it;
  // an inbox-only operator keeps the two-column screen they had.
  const canSeeSgp = can('sgp.read')
  const [sgpPanelOpen, setSgpPanelOpen] = useState(readPanelPreference)
  const toggleSgpPanel = useCallback(() => {
    setSgpPanelOpen((open) => {
      try {
        window.localStorage.setItem(SGP_PANEL_KEY, open ? '0' : '1')
      } catch {
        // A browser that will not store it just forgets it on reload.
      }
      return !open
    })
  }, [])
  const showSgpPanel = canSeeSgp && sgpPanelOpen
  // What the SGP module hands the reply box — the second copy's text.
  const [draft, setDraft] = useState<{ id: number; text: string } | null>(null)

  const [conversations, setConversations] = useState<WhatsAppConversation[]>([])
  // Os números do provedor, para cada conversa dizer por qual deles chegou.
  // Lidos uma vez: número novo é raro, e entra na próxima abertura da tela.
  const [accounts, setAccounts] = useState<ReadonlyMap<number, WhatsAppAccount>>(() => new Map())
  const [metaTemplates, setMetaTemplates] = useState<WhatsAppMetaTemplate[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [conversation, setConversation] = useState<WhatsAppConversation | null>(null)
  const [messages, setMessages] = useState<WhatsAppMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState<ConversationStatus>('open')
  const [assignee, setAssignee] = useState<AssigneeFilter>('all')
  const [tagFilter, setTagFilter] = useState<number | null>(null)
  // A mensagem que a próxima resposta cita, e a que está sendo encaminhada.
  const [replyTo, setReplyTo] = useState<WhatsAppMessage | null>(null)
  const replyToRef = useRef<WhatsAppMessage | null>(null)
  useEffect(() => { replyToRef.current = replyTo }, [replyTo])
  const [forwarding, setForwarding] = useState<WhatsAppMessage | null>(null)
  const [tagOptions, setTagOptions] = useState<WhatsAppTag[]>([])
  // Quem espera gente além do limite: o selo das linhas e a faixa da lista.
  const waitingReport = useWaiting()
  const waitingMap = useMemo(
    () => new Map((waitingReport?.items ?? []).map((item) => [item.conversationId, item.minutes])),
    [waitingReport]
  )

  const [loadingList, setLoadingList] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [sending, setSending] = useState(false)
  const [filing, setFiling] = useState(false)
  const [resendingId, setResendingId] = useState<number | null>(null)
  const [listError, setListError] = useState('')

  const alive = useRef(true)
  const listInFlight = useRef(false)
  const listFailures = useRef(0)
  const listBlockedUntil = useRef(0)
  // A filter change that lands while a poll is in flight is dropped by the
  // single-flight guard. Remembering that it was owed, and running it when the
  // call returns, is what keeps the list from showing the previous filter until
  // the next tick fifteen seconds later.
  const listOwed = useRef(false)
  const threadInFlight = useRef(false)
  const threadFailures = useRef(0)
  const threadBlockedUntil = useRef(0)

  // Read by the pollers, which must not be rebuilt — and their intervals with
  // them — every time a selection or a page size changes.
  const selectedIdRef = useRef<number | null>(null)
  const olderInFlight = useRef(false)
  const threadStampRef = useRef<string | null>(null)
  // The filter belongs in a ref for the same reason: a poll must ask for what
  // is on screen now, without the interval being torn down and restarted — and
  // its clock reset — every time the operator types a letter.
  const filterRef = useRef<{ search: string; status: ConversationStatus; assignee: AssigneeFilter; tag: number | null }>({ search: '', status: 'open', assignee: 'all', tag: null })

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // O sino não avisa da conversa que está aberta à vista.
  useEffect(() => {
    focusedConversation.id = selectedId
    return () => { focusedConversation.id = null }
  }, [selectedId])

  // One request per pause, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // ── The open thread ────────────────────────────────────────────────────────
  const loadThread = useCallback(async (id: number, silent: boolean) => {
    if (threadInFlight.current) return
    threadInFlight.current = true
    if (!silent) setLoadingThread(true)
    try {
      const res = await whatsappAPI.listMessages(id, { limit: MESSAGE_PAGE })
      if (!alive.current || selectedIdRef.current !== id) return
      if (!res.success || !res.data) {
        // A conversa não existe para esta sessão — apagada, ou de outro
        // provedor, vinda de um `state` de navegação antigo. Manter o cabeçalho
        // dela seria mostrar um nome que o servidor acabou de dizer não ser
        // deste provedor; tentar de novo com espera só repetiria o 404.
        if (res.code === 'conversation_not_found') {
          selectedIdRef.current = null
          threadStampRef.current = null
          threadFailures.current = 0
          threadBlockedUntil.current = 0
          setConversation(null)
          setMessages([])
          setHasOlder(false)
          setSelectedId(null)
          if (!silent) toast.error(whatsappErrorMessage(t, res.code))
          return
        }
        threadFailures.current += 1
        threadBlockedUntil.current = Date.now()
          + (2 ** Math.min(threadFailures.current, BACKOFF_CAP) - 1) * THREAD_POLL_MS
        if (!silent) toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      threadFailures.current = 0
      threadBlockedUntil.current = 0
      setConversation(res.data.conversation)
      // Merged, never replaced. This fetches the NEWEST page, and the operator
      // may have paged back through several older ones — replacing would throw
      // away everything they scrolled to, on a 45 s timer they did not ask for.
      const page = res.data.messages
      setMessages((current) => (silent ? mergeNewest(page, current) : page))
      if (!silent) setHasOlder(page.length >= MESSAGE_PAGE)
      threadStampRef.current = res.data.conversation.lastMessageAt

      // Reconciling the badge the server just cleared.
      //
      // That GET zeroed `unread_count` on the server, so every row already in
      // the list is stale the moment this resolves — and the next list poll is
      // up to fifteen seconds away. Leaving a "3 unread" badge on the thread
      // the operator is reading right now is how an inbox stops meaning
      // anything: the count is the only reason to look at a row twice.
      setConversations((rows) => rows.map((row) => (
        row.id === id && row.unreadCount !== 0 ? { ...row, unreadCount: 0 } : row
      )))
    } finally {
      threadInFlight.current = false
      if (!silent) setLoadingThread(false)
    }
  }, [t, toast])

  const loadThreadRef = useRef(loadThread)
  useEffect(() => { loadThreadRef.current = loadThread }, [loadThread])

  // ── The list ───────────────────────────────────────────────────────────────
  // Nasce vazia e é preenchida no efeito abaixo: `loadList` a lê no próprio
  // corpo, então ela tem de existir antes dele.
  const loadListRef = useRef<((initial: boolean) => Promise<void>) | null>(null)
  const loadList = useCallback(async (initial: boolean) => {
    if (listInFlight.current) {
      listOwed.current = true
      return
    }
    listInFlight.current = true
    try {
      const { search: term, status: pile, assignee: dono, tag } = filterRef.current
      const res = await whatsappAPI.listConversations({
        limit: LIST_LIMIT,
        status: pile,
        ...(dono === 'all' ? {} : { assignee: dono }),
        ...(tag ? { tag } : {}),
        ...(term ? { search: term } : {})
      })
      if (!alive.current) return
      if (!res.success) {
        listFailures.current += 1
        listBlockedUntil.current = Date.now()
          + (2 ** Math.min(listFailures.current, BACKOFF_CAP) - 1) * LIST_POLL_MS
        // A failing poll stays quiet; only the first load, which has nothing to
        // show behind it, turns into a message on screen.
        if (initial) setListError(whatsappErrorMessage(t, res.code))
        return
      }
      listFailures.current = 0
      listBlockedUntil.current = 0
      setListError('')

      const rows = res.data ?? []
      const openId = selectedIdRef.current
      const open = openId === null ? undefined : rows.find((row) => row.id === openId)

      // The fast path for a customer's reply: the list sees the open thread
      // move before the thread's own 45 s timer does, so it pulls it in.
      if (open && open.lastMessageAt !== threadStampRef.current) {
        void loadThreadRef.current(openId as number, true)
      }

      // The open row's own count is written down as read here too: the server
      // cleared it when the thread was opened, and a row that re-grows a badge
      // for a second on every poll is worse than no badge at all.
      setConversations(openId === null
        ? rows
        : rows.map((row) => (row.id === openId ? { ...row, unreadCount: 0 } : row)))
    } finally {
      listInFlight.current = false
      if (initial) setLoadingList(false)
      if (listOwed.current) {
        listOwed.current = false
        void loadListRef.current?.(false)
      }
    }
  }, [t])

  useEffect(() => { loadListRef.current = loadList }, [loadList])

  useEffect(() => { void loadList(true) }, [loadList])

  // Falhar aqui não derruba a caixa: sem os números, as conversas aparecem sem
  // cor, como antes de existir cor. Por isso nem toast — a caixa funciona.
  useEffect(() => {
    let vivo = true
    void whatsappAPI.listAccounts().then((res) => {
      if (!vivo || !res.success || !Array.isArray(res.data)) return
      setAccounts(new Map(res.data.map((account) => [account.id, account])))
      // Os modelos aprovados da Meta só interessam a quem tem número oficial.
      if (res.data.some((account) => account.integration === 'cloud')) {
        void whatsappAPI.listMetaTemplates({ usable: true }).then((r) => {
          if (vivo && r.success && Array.isArray(r.data)) setMetaTemplates(r.data)
        }).catch(() => {})
      }
    }).catch(() => {})
    return () => { vivo = false }
  }, [])

  // A filter the operator changed is asked for at once rather than waited for.
  // The ref is written here, immediately before the reload it belongs to, so
  // the two can never describe different filters.
  useEffect(() => {
    const next = { search: debouncedSearch, status, assignee, tag: tagFilter }
    const shown = filterRef.current
    // Unchanged on the first run, which is what keeps this from doubling the
    // initial load that the effect above already fired.
    if (shown.search === next.search && shown.status === next.status && shown.assignee === next.assignee && shown.tag === next.tag) return
    filterRef.current = next
    void loadListRef.current?.(false)
  }, [debouncedSearch, status, assignee, tagFilter])

  // As etiquetas do filtro: lidas uma vez ao abrir a caixa de entrada.
  useEffect(() => {
    let vivo = true
    void whatsappAPI.listTags().then((res) => {
      if (vivo && res.success && res.data) setTagOptions(res.data)
    })
    return () => { vivo = false }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() < listBlockedUntil.current) return
      void loadList(false)
    }, LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [loadList])

  // Selecting a thread, or asking for more of it, loads it visibly.
  useEffect(() => {
    if (selectedId === null) return
    void loadThread(selectedId, false)
  }, [selectedId, loadThread])

  // The thread's own clock. It reads the selection from a ref so that switching
  // conversations does not restart the interval.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = selectedIdRef.current
      if (id === null) return
      if (document.visibilityState !== 'visible') return
      if (Date.now() < threadBlockedUntil.current) return
      void loadThreadRef.current(id, true)
    }, THREAD_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const select = useCallback((next: WhatsAppConversation) => {
    if (next.id === selectedIdRef.current) return
    selectedIdRef.current = next.id
    threadStampRef.current = null
    threadFailures.current = 0
    threadBlockedUntil.current = 0
    // The row we already have draws the header while the history is in flight,
    // so the pane never opens blank.
    setConversation(next)
    setMessages([])
    setHasOlder(false)
    setReplyTo(null)
    setSelectedId(next.id)
  }, [])

  /**
   * Back to the list — the phone's "← Conversas". On a wide screen the list
   * never left, so this only exists for the one-pane layout (`inboxPanes`).
   * Clearing the ref first is what makes a thread poll already in flight drop
   * its answer instead of reopening the conversation behind the operator.
   */
  const closeThread = useCallback(() => {
    selectedIdRef.current = null
    threadStampRef.current = null
    threadFailures.current = 0
    threadBlockedUntil.current = 0
    setConversation(null)
    setMessages([])
    setHasOlder(false)
    setSelectedId(null)
  }, [])

  const backSeen = useRef(backToList)
  useEffect(() => {
    if (backSeen.current === backToList) return
    backSeen.current = backToList
    closeThread()
  }, [backToList, closeThread])

  // Arriving from Contacts with a thread in hand. Opened once, on mount — the
  // page remounts this tab for every thread it hands over.
  useEffect(() => {
    if (initialConversation) select(initialConversation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The operator linked the open thread to a subscriber by hand: the header
   * shows the contract at once, and the list is asked again so the row's
   * name follows.
   */
  const linked = useCallback((next: WhatsAppConversation) => {
    // Uma etiqueta criada agora pelo seletor entra no filtro sem recarregar.
    const novas = next.tags ?? []
    if (novas.length) {
      setTagOptions((atuais) => {
        const faltam = novas.filter((tag) => !atuais.some((x) => x.id === tag.id))
        return faltam.length ? [...atuais, ...faltam].sort((a, b) => a.name.localeCompare(b.name)) : atuais
      })
    }
    if (selectedIdRef.current === next.id) setConversation(next)
    setConversations((rows) => rows.map((row) => (row.id === next.id ? { ...row, ...next } : row)))
    void loadListRef.current?.(false)
  }, [])

  /**
   * One page further back. The cursor is the oldest id on screen, so a customer
   * answering mid-scroll cannot shift the page boundary under the request —
   * which is exactly what an offset would have let happen.
   */
  const loadOlder = useCallback(async () => {
    const id = selectedIdRef.current
    const oldest = messages.at(-1)?.id
    if (id === null || !oldest || olderInFlight.current) return
    olderInFlight.current = true
    setLoadingOlder(true)
    try {
      const res = await whatsappAPI.listMessages(id, { limit: MESSAGE_PAGE, before: oldest })
      if (!alive.current || selectedIdRef.current !== id) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      const page = res.data.messages
      setMessages((current) => [
        ...current,
        ...page.filter((message) => !current.some((held) => held.id === message.id))
      ])
      // A short page is the end of the thread. A full one only means there may
      // be more, which is the honest thing for the button to offer.
      setHasOlder(page.length >= MESSAGE_PAGE)
    } finally {
      olderInFlight.current = false
      if (alive.current) setLoadingOlder(false)
    }
  }, [messages, t, toast])

  // ── Filing ─────────────────────────────────────────────────────────────────
  /**
   * Closes the open thread, or takes it back out.
   *
   * The thread stays on screen either way: the operator who just closed it is
   * owed the sight of the state they asked for, and the reopen button next to
   * it. What moves is the LIST — a closed thread leaves the default pile — so
   * the list is asked again rather than patched, since only the server knows
   * whether the row still belongs under the filter on screen.
   */
  const file = useCallback(async (next: 'open' | 'closed') => {
    const id = selectedIdRef.current
    if (id === null) return
    setFiling(true)
    try {
      const res = await whatsappAPI.setConversationStatus(id, next)
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      if (selectedIdRef.current === id) setConversation(res.data)
      void loadListRef.current?.(false)
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setFiling(false)
    }
  }, [t, toast])

  // ── Sending ────────────────────────────────────────────────────────────────
  const submit = useCallback(async (
    body: string,
    isNote: boolean,
    attachment?: ComposerAttachment,
    metaTemplate?: MetaTemplatePayload
  ): Promise<boolean> => {
    const id = selectedIdRef.current
    if (id === null) return false
    try {
      // The composer uploads the file first and hands back what the upload
      // route stored; this call is what puts it on a row. A caption is
      // optional, so `body` can be empty as long as there is a file.
      const citada = !isNote && !metaTemplate ? replyToRef.current : null
      const res = await whatsappAPI.sendMessage(id, { body, attachment, isNote, metaTemplate, ...(citada ? { replyToId: citada.id } : {}) })
      if (!alive.current) return false
      if (!res.success || !res.data) {
        // Only the machine `code` is ever translated. The `message` beside it
        // can carry the Evolution server's own words, and those belong in a log,
        // not in front of an operator.
        toast.error(whatsappErrorMessage(t, res.code), { title: t('whatsapp.inbox.sendFailed') })
        return false
      }
      const created = citada
        ? {
          ...res.data,
          replyTo: { id: citada.id, direction: citada.direction, body: citada.body ? citada.body.slice(0, 200) : null, attachmentType: citada.attachment?.type ?? null }
        }
        : res.data
      if (citada) setReplyTo(null)
      // The route answers with the row it wrote, so this is the real message,
      // not an optimistic stand-in — nothing here can disagree with the server.
      if (selectedIdRef.current === id) setMessages((rows) => [created, ...rows])
      setConversations((rows) => rows.map((row) => (
        row.id === id ? { ...row, lastMessageAt: created.createdAt ?? row.lastMessageAt } : row
      )))
      threadStampRef.current = created.createdAt ?? threadStampRef.current
      return true
    } catch {
      toast.error(t('api.requestFailed'), { title: t('whatsapp.inbox.sendFailed') })
      return false
    }
  }, [t, toast])

  const send = useCallback(async (body: string, isNote: boolean, attachment?: ComposerAttachment) => {
    setSending(true)
    try {
      return await submit(body, isNote, attachment)
    } finally {
      if (alive.current) setSending(false)
    }
  }, [submit])

  /** Troca a mensagem na lista pelo que o servidor devolveu (reação, exclusão). */
  const patchMessage = useCallback((updated: WhatsAppMessage) => {
    setMessages((rows) => rows.map((row) => (row.id === updated.id ? { ...row, ...updated, replyTo: row.replyTo } : row)))
  }, [])

  const reactTo = useCallback(async (message: WhatsAppMessage, emoji: string) => {
    try {
      const res = await whatsappAPI.reactToMessage(message.id, emoji)
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code), { title: t('whatsapp.msg.reactFailed') })
        return
      }
      patchMessage(res.data)
    } catch {
      toast.error(t('api.requestFailed'), { title: t('whatsapp.msg.reactFailed') })
    }
  }, [patchMessage, t, toast])

  const deleteMessage = useCallback(async (message: WhatsAppMessage) => {
    try {
      const res = await whatsappAPI.deleteMessage(message.id)
      if (!res.success || !res.data) {
        toast.error(res.message || whatsappErrorMessage(t, res.code), { title: t('whatsapp.msg.deleteFailed') })
        return
      }
      patchMessage(res.data)
    } catch {
      toast.error(t('api.requestFailed'), { title: t('whatsapp.msg.deleteFailed') })
    }
  }, [patchMessage, t, toast])

  /** Encaminha o texto de uma mensagem para outra conversa; o que sai é uma mensagem nova. */
  const forwardTo = useCallback(async (message: WhatsAppMessage, target: WhatsAppConversation): Promise<boolean> => {
    try {
      const res = await whatsappAPI.sendMessage(target.id, { body: message.body ?? '' })
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code), { title: t('whatsapp.inbox.sendFailed') })
        return false
      }
      toast.success(t('whatsapp.msg.forwarded', { name: conversationTitle(target) }))
      return true
    } catch {
      toast.error(t('api.requestFailed'), { title: t('whatsapp.inbox.sendFailed') })
      return false
    }
  }, [t, toast])

  /** Fora da janela de 24 h num número oficial: um modelo aprovado da Meta. */
  const sendTemplate = useCallback(async (metaTemplate: MetaTemplatePayload) => {
    setSending(true)
    try {
      return await submit('', false, undefined, metaTemplate)
    } finally {
      if (alive.current) setSending(false)
    }
  }, [submit])

  const quickReplyVars = useMemo(() => ({
    nome: conversation?.clientName ?? conversation?.pushName ?? null,
    primeiro_nome: firstName(conversation?.clientName ?? conversation?.pushName),
    contrato: conversation?.contract ?? null,
    atendente: user?.username ?? null
  }), [conversation?.clientName, conversation?.pushName, conversation?.contract, user?.username])

  /**
   * O botão "Modelos": o texto do modelo preenchido para esta conversa. Com
   * variável de fatura e contrato vinculado, quem preenche é o servidor, com a
   * fatura em aberto mais antiga relida no SGP (a mesma conta da 2ª via). Sem
   * contrato, entra o que a conversa sabe e as variáveis de fatura ficam à
   * vista, com o aviso de vincular o assinante.
   */
  const pickTemplate = useCallback(async (template: PickableTemplate): Promise<string | null> => {
    if (!conversation) return null
    if (needsInvoice(template.body)) {
      if (conversation.contract && can('whatsapp.send')) {
        const res = await whatsappAPI.subscriberSecondCopy(conversation.id, { contract: conversation.contract, template: String(template.id) })
        if (res.success && res.data) return res.data.text
        toast.error(res.message || whatsappErrorMessage(t, res.code))
        return null
      }
      toast.info(t('whatsapp.templatePicker.needsContract'))
    }
    return fillQuickReply(template.body, quickReplyVars)
  }, [conversation, can, toast, t, quickReplyVars])

  /**
   * Puts a failed message back in the queue — the SAME row, not a copy.
   *
   * This used to read `message.body` and call `submit`, which posted a new
   * message: the failed row stayed on screen, the subscriber got the same
   * notice twice, and a message whose content was an attachment could not be
   * resent at all, because there was no body to read and the button returned
   * without a word. `requeueMessage` moves the row itself back to `queued`, so
   * the id, the file and the place in the thread survive.
   *
   * The row is replaced where it stands rather than prepended: it is the same
   * message, and moving it to the foot of the thread would misdate it.
   */
  const resend = useCallback(async (message: WhatsAppMessage) => {
    setResendingId(message.id)
    try {
      const res = await whatsappAPI.requeueMessage(message.id)
      if (!alive.current) return
      if (!res.success || !res.data) {
        // The route's `message` and not only its `code`: unlike a send, whose
        // text can be the Evolution server's own words, every refusal here is
        // the panel's own sentence, already translated by `req.t`. "Only a
        // message that failed can be sent again" is worth more to the operator
        // who just lost a race with a colleague than "the request failed".
        toast.error(
          res.message || whatsappErrorMessage(t, res.code),
          { title: t('whatsapp.inbox.resendFailedTitle') }
        )
        return
      }
      const requeued = res.data
      setMessages((rows) => rows.map((row) => (row.id === requeued.id ? requeued : row)))
    } catch {
      if (alive.current) {
        toast.error(t('api.requestFailed'), { title: t('whatsapp.inbox.resendFailedTitle') })
      }
    } finally {
      if (alive.current) setResendingId(null)
    }
  }, [t, toast])

  const unreadTotal = conversations.reduce((sum, row) => sum + row.unreadCount, 0)
  // No celular, lista OU conversa; no computador, as duas (`lib/wa-inbox-pane.ts`).
  const panes = inboxPanes(conversation !== null)
  // Teclado do iPhone: o Safari não encolhe a página, só a `visualViewport`
  // (`lib/wa-keyboard.ts`). Com o teclado aberto o cartão passa a caber na
  // parte visível, com a caixa de escrever logo acima dele. Só no celular.
  const [keyboardHeight, setKeyboardHeight] = useState<number | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !window.matchMedia('(max-width: 1023px)').matches) return
    let last: number | null = null
    const update = () => {
      const next = visibleHeightWithKeyboard({ innerHeight: window.innerHeight, vvHeight: vv.height })
      if (next === last) return
      last = next
      setKeyboardHeight(next)
      // A barra fixa e as abas voltam ao topo da área visível.
      if (next !== null) window.scrollTo(0, 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return (
    <section className="space-y-5 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
      <div className="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        {/* Sem título próprio: a aba ativa já diz "Conversas", e um segundo
            título aqui era uma faixa inteira repetindo o nome dela. O contador
            e o atualizar moram agora no topo da lista, onde se usam. */}
        {listError ? (
          <section className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]"><Icon name="warning" size={22} /></div>
            <h2 className="empty-state-title">{t('common.error')}</h2>
            <p className="empty-state-copy">{listError}</p>
            <button type="button" className="modern-button mt-5" onClick={() => void loadList(true)}>
              {t('common.retry')}
            </button>
          </section>
        ) : (
          // Em tela larga a caixa ocupa o que sobra abaixo das abas (`flex-1`
          // na cadeia de colunas da página), sem conta fixa: as abas quebram
          // em duas linhas num notebook, e uma altura fixa fazia a página rolar.
          // No celular a altura desconta a barra fixa do painel (4rem), e usa
          // `dvh`: o `vh` do navegador móvel conta a barra de endereço que
          // aparece e some, e a caixa de escrever ficava embaixo dela. A
          // página, nesta aba, troca o respiro de baixo pela área segura do
          // iPhone (ver `WhatsAppPage`), e a conta desconta o mesmo.
          <section
            className={`modern-card grid h-[calc(100dvh-9rem-env(safe-area-inset-bottom))] min-h-88 grid-cols-1 overflow-hidden lg:h-auto lg:min-h-128 lg:flex-1 ${
              // Uma classe de colunas por vez: duas `lg:grid-cols-*` juntas
              // dependem da ordem do CSS gerado, e o painel caía numa segunda linha.
              // Com o Módulo SGP aberto, o painel é sempre uma coluna (nunca por
              // cima da conversa). Com o menu lateral, três colunas só cabem a
              // partir de 1536 px (2xl): num notebook a conversa ficava com
              // 300 px. Abaixo disso a lista de conversas sai enquanto o módulo
              // está aberto. Só breakpoints do tema: a v4 ordena as media
              // queries por unidade, e um `min-[1200px]` saía antes do `lg`
              // (em rem), que vencia e jogava o painel numa segunda linha.
              // A conversa é `minmax(0,1fr)`, não `1fr`: o mínimo de um `1fr` é o
              // conteúdo, e uma palavra sem quebra (um código PIX) alargava a
              // coluna para além do cartão, que cortava a direita.
              showSgpPanel && conversation
                ? 'lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] 2xl:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(18rem,22rem)]'
                : 'lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]'
            }`}
            // Sem a área segura (o teclado cobre o indicador de home) e sem o
            // `min-h`, que impediria o cartão de encolher.
            style={keyboardHeight !== null ? { height: `calc(${keyboardHeight}px - 9rem)`, minHeight: 0 } : undefined}
          >
            <div className={`${showSgpPanel && conversation ? 'hidden 2xl:flex' : panes.list} min-h-0 flex-col border-border lg:border-e`}>
              <div className="space-y-2 border-b border-border px-3 py-3">
                <div className="flex items-center gap-2">
                  <input
                    type="search"
                    className="modern-input"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('whatsapp.inbox.searchPlaceholder')}
                    aria-label={t('whatsapp.inbox.searchPlaceholder')}
                  />
                  <button
                    type="button"
                    className="icon-button shrink-0"
                    aria-label={t('common.refresh')}
                    title={t('common.refresh')}
                    onClick={() => {
                      void loadList(false)
                      const id = selectedIdRef.current
                      if (id !== null) void loadThreadRef.current(id, true)
                    }}
                  >
                    <Icon name="refresh" size={18} />
                  </button>
                  <InboxFilterButton assignee={assignee} tagId={tagFilter} tags={tagOptions} onAssignee={setAssignee} onTag={setTagFilter} />
                </div>
                <div className="@container flex items-center gap-2">
                  {/* Uma linha só, sempre: quatro pilhas numa coluna estreita
                      quebravam e a última descia sozinha. Cada aba divide a
                      largura; coluna estreita (celular ou lista ao lado da conversa) fica só o
                      ícone, larga fica só o nome. */}
                  <div className="tab-rail min-w-0 flex-1 flex-nowrap!" role="tablist" aria-label={t('whatsapp.inbox.title')}>
                    {FILTERS.map(([id, labelKey, icon]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setStatus(id)}
                        className="tab-button inline-flex min-w-0 flex-auto items-center justify-center whitespace-nowrap px-1.5 text-xs after:inset-x-1.5!"
                        data-active={status === id}
                        role="tab"
                        aria-selected={status === id}
                        aria-label={t(labelKey)}
                        title={t(labelKey)}
                      >
                        <Icon name={icon} size={18} className="shrink-0 @min-[26rem]:hidden" />
                        <span className="truncate @max-[26rem]:sr-only">{t(labelKey)}</span>
                      </button>
                    ))}
                  </div>
                  {unreadTotal > 0 && (
                    <button
                      type="button"
                      className="modern-badge-success shrink-0 cursor-pointer hover:brightness-110"
                      title={t('whatsapp.inbox.openUnread')}
                      onClick={() => {
                        const next = conversations.find((row) => row.unreadCount > 0)
                        if (next) select(next)
                      }}
                    >
                      {t('whatsapp.inbox.unread', { count: unreadTotal })}
                    </button>
                  )}
                </div>
                <InboxFilterChips assignee={assignee} tagId={tagFilter} tags={tagOptions} onAssignee={setAssignee} onTag={setTagFilter} />
              </div>
              <WaitingBanner
                report={waitingReport}
                onShow={(filtro) => {
                  setStatus('open')
                  setAssignee(filtro)
                }}
              />
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {loadingList
                  ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
                  : (
                    <ConversationList
                      conversations={conversations}
                      accounts={accounts}
                      selectedId={selectedId}
                      onSelect={select}
                      // An empty list under a search term is a different fact
                      // from an empty inbox, and only one of the two is worth
                      // clearing the box for.
                      filtered={debouncedSearch !== '' || status !== 'open' || assignee !== 'all' || tagFilter !== null}
                      waiting={waitingMap}
                      canOpenSgp={canSeeSgp}
                    />
                  )}
              </div>
            </div>

            <div className={`${panes.thread} min-h-0 min-w-0 flex-col`}>
              {conversation ? (
                <>
                  <ConversationThread
                    conversation={conversation}
                    accounts={accounts}
                    messages={messages}
                    loading={loadingThread}
                    canLoadMore={hasOlder && !loadingOlder}
                    onLoadMore={() => void loadOlder()}
                    onResend={(message) => void resend(message)}
                    resendingId={resendingId}
                    onReply={(message) => setReplyTo(message)}
                    onForward={(message) => setForwarding(message)}
                    onReact={(message, emoji) => void reactTo(message, emoji)}
                    onDelete={(message) => void deleteMessage(message)}
                    filing={filing}
                    onFile={(next) => void file(next)}
                    sgpPanelOpen={canSeeSgp ? showSgpPanel : undefined}
                    onToggleSgpPanel={canSeeSgp ? toggleSgpPanel : undefined}
                    onLinked={linked}
                    onBack={closeThread}
                    compact={keyboardHeight !== null}
                  />
                  <ThreadComposer
                    compact={keyboardHeight !== null}
                    optedOut={conversation.optedOut}
                    sending={sending}
                    onSend={send}
                    replyTo={replyTo}
                    onCancelReply={() => setReplyTo(null)}
                    draft={draft}
                    quickReplies={canQuickReply ? quickReplies ?? [] : null}
                    metaWindow={metaWindowFor(accounts.get(conversation.accountId), conversation)}
                    metaTemplates={metaTemplates.filter((m) => m.accountId === conversation.accountId)}
                    onSendTemplate={sendTemplate}
                    onSuggest={canSuggest && aiSuggest ? async () => {
                      const res = await whatsappAPI.suggestReply(conversation.id)
                      if (res.success && res.data) return res.data.text
                      toast.error(res.message || whatsappErrorMessage(t, res.code))
                      return null
                    } : undefined}
                    quickReplyVars={quickReplyVars}
                    templates={canQuickReply ? allTemplates ?? [] : null}
                    onPickTemplate={pickTemplate}
                  />
                </>
              ) : (
                <div className="empty-state flex-1">
                  <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
                  <p className="empty-state-title">{t('whatsapp.inbox.selectOne')}</p>
                </div>
              )}
            </div>

            {/* A column beside the thread from lg up (the conversation list
                steps aside below 2xl). Narrower, it is a drawer over it —
                above the mobile top bar (z 1200), whose height would otherwise
                hide the drawer's own close button, and below the navigation
                menu (z 2000). */}
            {showSgpPanel && conversation && (
              // Fundo escuro só enquanto é gaveta: tocar fora fecha, como
              // qualquer gaveta de celular.
              <div
                className="fixed inset-0 z-1499 bg-black/40 lg:hidden"
                aria-hidden="true"
                onClick={toggleSgpPanel}
              />
            )}
            {showSgpPanel && conversation && (
              <div className="fixed inset-y-0 inset-e-0 z-1500 w-[min(22rem,100vw)] border-s border-border bg-card pr-[env(safe-area-inset-right)] shadow-xl lg:static lg:pr-0 lg:z-auto lg:h-full lg:min-h-0 lg:w-auto lg:shadow-none">
                <SubscriberPanel
                  conversationId={conversation.id}
                  boundContract={conversation.contract}
                  onClose={toggleSgpPanel}
                  onDraft={(text) => setDraft((current) => ({ id: (current?.id ?? 0) + 1, text }))}
                  onSent={(sent) => {
                    // As linhas que a rota gravou, como no `submit`: a mais nova primeiro.
                    if (sent.length === 0) return
                    const last = sent[sent.length - 1]
                    if (selectedIdRef.current === conversation.id) setMessages((rows) => [...[...sent].reverse(), ...rows])
                    setConversations((rows) => rows.map((row) => (
                      row.id === conversation.id ? { ...row, lastMessageAt: last.createdAt ?? row.lastMessageAt } : row
                    )))
                    threadStampRef.current = last.createdAt ?? threadStampRef.current
                  }}
                  onBound={() => {
                    void loadList(false)
                    void loadThreadRef.current(conversation.id, true)
                  }}
                />
              </div>
            )}
          </section>
        )}
      </div>
      {forwarding && (
        <ForwardDialog
          message={forwarding}
          conversations={conversations}
          currentId={selectedId}
          onClose={() => setForwarding(null)}
          onForward={(target) => forwardTo(forwarding, target)}
        />
      )}
    </section>
  )
}

/**
 * "Delete the old attachments now", inside the health bell's panel.
 *
 * `POST /whatsapp/media/sweep` has existed since the attachment retention
 * landed and had no screen: the policy was set in Settings and then applied
 * only by a six-hour timer, so an operator whose disk was full today had
 * nothing to press. This is that button, and it takes no parameters — the
 * window and the rules come from the saved settings, so pressing it can never
 * remove more than the settings screen already says it will.
 *
 * It sits BESIDE the strip rather than inside it. The strip is a poll surface
 * that refreshes itself every sixty seconds and renders nothing at all while
 * it is loading or failing; a destructive action that disappears under the
 * operator's cursor when a poll fails is not a button. Keeping it out here also
 * keeps the strip's own rule intact: that component only ever counts.
 *
 * Admin-only, because the route is. A viewer who could press it would get a
 * 403 and no way to tell that from the sweep having failed.
 *
 * The whole point of the reporting below is `skipped`. "0 files" is a real and
 * common answer with at least four different causes, and an operator staring
 * at a full disk reads an unexplained zero as a broken button — so retention
 * being off, a pass already running, a failure, and genuinely nothing old
 * enough each get their own sentence.
 */
function MediaSweepButton() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [sweeping, setSweeping] = useState(false)

  // `whatsapp.config` e não `whatsapp.send`, como a rota: esta é a única ação
  // da integração que APAGA arquivo, e o plantão que responde a assinante não
  // aplica política de retenção.
  if (!can('whatsapp.config')) return null

  const sweep = async () => {
    setSweeping(true)
    try {
      const res = await whatsappAPI.sweepMedia()
      if (!res.success || !res.data) {
        toast.error(t('whatsapp.health.sweepFailed'))
        return
      }
      const { skipped, files, mb } = res.data
      // Retention off is the one answer that is not a failure and not a
      // no-op worth apologising for: it is the configured state, and the
      // message says where to change it.
      if (skipped === 'disabled') {
        toast.info(t('whatsapp.health.sweepOff'))
        return
      }
      if (skipped === 'busy') {
        toast.info(t('whatsapp.health.sweepBusy'))
        return
      }
      // `failed`, `no_provider` and `unscoped` are three different bugs and one
      // operator sentence. None of them is something the person at the panel
      // can act on differently, and the server log already tells them apart for
      // whoever can.
      if (skipped) {
        toast.error(t('whatsapp.health.sweepFailed'))
        return
      }
      if (!files) {
        toast.info(t('whatsapp.health.sweepNothing'))
        return
      }
      toast.success(t('whatsapp.health.sweepDone', { files, mb }))
    } catch {
      toast.error(t('whatsapp.health.sweepFailed'))
    } finally {
      setSweeping(false)
    }
  }

  return (
    <button
      type="button"
      className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
      disabled={sweeping}
      onClick={() => void sweep()}
    >
      <Icon name="trash" size={14} />
      {t('whatsapp.health.sweepNow')}
    </button>
  )
}

/**
 * The window the bulk requeue asks for, and the one the route will give.
 *
 * The backend clamps `hours` to the same twenty-four, so this number is not a
 * limit the screen enforces — it is the number the confirmation must not lie
 * about. It is also the window the health bell counts as `failed24h`, which is
 * the figure the operator is looking at when they reach for this button.
 */
const REQUEUE_WINDOW_HOURS = 24

/**
 * "Send the failed ones again", beside the sweep in the health bell's panel.
 *
 * This is where the button belongs because this is where the failure is
 * reported: the strip above says `failed24h: 3200` after an Evolution restart
 * ate a dunning run, and the answer to that number has to be within reach of
 * it. Inside the inbox tab it would be a per-thread action, which is what the
 * bubble's own resend already is; the campaign case never has a thread open.
 *
 * It is NOT destructive and still asks first, because it is bulk: an operator
 * has to be told how wide the window is before three thousand messages go back
 * on the wire. What it cannot do is duplicate anything — the route requeues the
 * rows themselves, and only rows that failed — and the confirmation says so.
 *
 * Admin-only, because the route is. A viewer who could press it would get a 403
 * with no way to tell that from a queue that refused to move.
 */
function RequeueFailedButton() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [requeuing, setRequeuing] = useState(false)

  // Reenfileirar é reenviar, então é `whatsapp.send`, como a rota. Quem estava
  // de plantão quando a campanha caiu é exatamente quem precisa deste botão.
  if (!can('whatsapp.send')) return null

  const requeueAll = async () => {
    if (!window.confirm(t('whatsapp.outbox.requeueAllConfirm', { hours: REQUEUE_WINDOW_HOURS }))) return
    setRequeuing(true)
    try {
      const res = await whatsappAPI.requeueFailed(REQUEUE_WINDOW_HOURS)
      if (!res.success || !res.data) {
        toast.error(t('whatsapp.outbox.requeueFailed'))
        return
      }
      // Zero is a real answer with its own sentence. "Nothing failed in the
      // last day" and "the button is broken" look identical otherwise, and the
      // operator pressing this has just watched a campaign fall over.
      if (!res.data.requeued) {
        toast.info(t('whatsapp.outbox.requeueAllNone'))
        return
      }
      toast.success(t('whatsapp.outbox.requeueAllDone', { count: res.data.requeued }))
    } catch {
      toast.error(t('whatsapp.outbox.requeueFailed'))
    } finally {
      setRequeuing(false)
    }
  }

  return (
    <button
      type="button"
      className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
      disabled={requeuing}
      onClick={() => void requeueAll()}
    >
      <Icon name="refresh" size={14} className={requeuing ? 'animate-spin' : ''} />
      {t('whatsapp.outbox.requeueAll')}
    </button>
  )
}

/**
 * As abas, na ordem em que o operador as encontra, cada uma com a capacidade
 * que ela precisa para LER — que é o que decide se a aba aparece.
 *
 * Alertas é a única que sai da lista do plantão: as três rotas dela exigem
 * `whatsapp.config`, então para um `tech` a aba abriria vazia e cada leitura
 * responderia 403. As demais ele lê; o que ele não pode escrever é recusado
 * pelo servidor com uma frase que diz isso.
 */
/** As duas vistas da aba de alertas: o resultado (quedas) e a configuração. */
type AlertView = 'results' | 'config'
const ALERT_VIEWS: [AlertView, TranslationKey][] = [
  ['results', 'whatsapp.alerts.viewResults'],
  ['config', 'whatsapp.alerts.viewConfig']
]

const TABS = [
  ['inbox', 'whatsapp.inbox.title', 'whatsapp.read'],
  ['contacts', 'whatsapp.contacts.title', 'whatsapp.read'],
  ['billing', 'whatsapp.billing.title', 'campaigns.read'],
  ['campaigns', 'whatsapp.broadcast.title', 'campaigns.read'],
  ['referrals', 'whatsapp.referral.tab', 'campaigns.read'],
  ['templates', 'whatsapp.templates.title', 'campaigns.read'],
  ['optOut', 'whatsapp.optOut.title', 'campaigns.read'],
  ['botReport', 'whatsapp.botReport.tab', 'whatsapp.read'],
  ['maintenance', 'maintenance.tab', 'whatsapp.read'],
  ['alerts', 'whatsapp.alerts.title', 'whatsapp.config']
] as const

type TabId = (typeof TABS)[number][0]

/**
 * Everything the operator does with WhatsApp, behind one route.
 *
 * Only the open tab is mounted. That is not a rendering nicety: four of these
 * panels poll, and a mounted-but-hidden inbox would keep asking the panel for
 * conversations — and keep zeroing unread counts — from a screen nobody is
 * looking at. Switching tabs unmounts the old one and its effects clear their
 * own timers.
 *
 * The connection and the global settings are NOT here. They live under
 * Settings, because pairing a number is something an admin does once and this
 * page is where the work happens afterwards.
 */
export default function WhatsAppPage() {
  const { t } = useTranslation()
  const { can, user } = useAuth()
  const [tab, setTab] = useState<TabId>('inbox')
  const [alertsView, setAlertsView] = useState<AlertView>('results')
  // The thread Contacts handed over, and a counter that remounts the inbox for
  // each hand-over so it opens that thread even when it was already on screen.
  // The Contacts page (its own menu entry) hands one over through the route.
  //
  // O `state` tem dono: o histórico do navegador guarda o de quem navegou, e
  // sair, entrar em outro provedor e apertar "Voltar" o entregava de novo — a
  // conversa do provedor A aberta na sessão do B. Sem dono igual ao desta
  // sessão, ele é ignorado.
  const location = useLocation()
  const routedState = location.state as { conversation?: WhatsAppConversation; owner?: string } | null
  const owner = sessionOwner(user)
  const routed = owner !== null && routedState?.owner === owner ? routedState.conversation ?? null : null
  const [handOver, setHandOver] = useState<{ conversation: WhatsAppConversation; seq: number } | null>(
    routed ? { conversation: routed, seq: 1 } : null
  )
  // `?conversation=<id>`: o clique numa notificação do navegador. Abre a
  // conversa na caixa de entrada e limpa a URL, para recarregar não reabrir.
  const navigate = useNavigate()
  const mounted = useRef(true)
  const [backToList, setBackToList] = useState(0)
  // "WhatsApp" no menu lateral com a página já aberta: o mesmo endereço de
  // novo, só um `location.key` novo. Volta para a lista de conversas. O
  // primeiro endereço (a chegada) e os que trazem conversa (notificação,
  // Contatos) ficam de fora.
  const lastKey = useRef(location.key)
  useEffect(() => {
    if (lastKey.current === location.key) return
    lastKey.current = location.key
    if (location.search.includes('conversation=') || routedState?.conversation) return
    setTab('inbox')
    setBackToList((n) => n + 1)
  }, [location.key, location.search, routedState])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const deepLink = new URLSearchParams(location.search).get('conversation')
  useEffect(() => {
    if (!deepLink) return
    const id = Number.parseInt(deepLink, 10)
    // Limpar a URL muda `deepLink` e reexecuta o efeito: a busca não pode
    // ser cancelada por isso, só pela saída da página.
    navigate(location.pathname, { replace: true })
    if (!Number.isInteger(id) || id <= 0) return
    void whatsappAPI.getConversation(id).then((res) => {
      if (!mounted.current || !res.success || !res.data) return
      const conversation = res.data
      setTab('inbox')
      setHandOver((current) => ({ conversation, seq: (current?.seq ?? 0) + 1 }))
    })
  }, [deepLink, location.pathname, navigate])
  const visibleTabs = TABS.filter(([, , permission]) => can(permission))

  return (
    // Na caixa de entrada o cartão já ocupa a altura da tela: o `pb-24` da
    // página só fazia a tela inteira rolar por baixo da conversa no celular.
    // Em tela larga a altura vem da tela e não de uma conta: página, moldura,
    // aba e cartão viram colunas flex, e o cartão fica com o que sobra abaixo
    // das abas — que quebram em duas linhas num notebook.
    <div className={`page-shell ${tab === 'inbox' ? 'pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:flex lg:h-screen lg:flex-col lg:pb-8' : ''}`}>
      <div className={`page-frame ${tab === 'inbox' ? 'lg:flex lg:min-h-0 lg:flex-1 lg:flex-col' : ''}`}>
        {/*
          O título "WhatsApp" repetia o menu lateral e custava uma linha inteira
          acima da caixa de entrada: fica só para leitor de tela, e o sino de
          "Está funcionando?" vai para a ponta da linha das abas. Os avisos e as
          duas ações de manutenção moram no painel do sino.

          O sino fica fora da troca de abas de propósito: tem que continuar
          respondendo "está funcionando?" em qualquer aba — montado dentro de
          uma delas, a integração sumiria ao abrir Campanhas.
        */}
        <h1 className="sr-only">{t('sidebar.nav.whatsapp')}</h1>
        {/* A caixa de entrada conta a altura exata da tela; as outras abas ganham um respiro. */}
        <div className={`flex items-center gap-2 border-b border-border ${tab === 'inbox' ? '' : 'mb-4'}`}>
          <div className="tab-rail min-w-0 flex-1 border-b-0" role="tablist" aria-label={t('sidebar.nav.whatsapp')}>
            {visibleTabs.map(([id, labelKey]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  // "Conversas" de novo, já nela: volta para a lista.
                  if (id === 'inbox' && tab === 'inbox') setBackToList((n) => n + 1)
                  setTab(id)
                  setHandOver(null)
                }}
                className="tab-button"
                data-active={tab === id}
                role="tab"
                aria-selected={tab === id}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          {tab === 'inbox' && <NotifyToggle />}
          {tab === 'inbox' && <AvailabilityToggle />}
          <HealthBell
            actions={(disponivel) => (
              <>
                {/* Na ordem em que os avisos se leem: as falhas primeiro, o
                    disco depois. E só quando há o que fazer. */}
                {disponivel.requeue && <RequeueFailedButton />}
                {disponivel.sweep && <MediaSweepButton />}
              </>
            )}
          />
        </div>

        {tab === 'inbox' && (
          <InboxTab key={handOver?.seq ?? 0} initialConversation={handOver?.conversation ?? null} backToList={backToList} />
        )}
        {tab === 'contacts' && (
          <ContactsPanel
            onOpenConversation={(conversation) => {
              setHandOver((current) => ({ conversation, seq: (current?.seq ?? 0) + 1 }))
              setTab('inbox')
            }}
          />
        )}
        {tab === 'billing' && <DunningSection />}
        {tab === 'campaigns' && <CampaignsPanel />}
        {tab === 'referrals' && <ReferralsPanel />}
        {tab === 'templates' && <TemplatesPanel />}
        {tab === 'optOut' && <OptOutPanel />}
        {tab === 'botReport' && (
          <div className="grid gap-8">
            <BotReportPanel />
            <ResponseTimePanel />
            <SatisfactionPanel />
            <TagsReportPanel />
            <MetaUsagePanel />
          </div>
        )}
        {tab === 'maintenance' && <MaintenancePanel />}
        {/* Pela capacidade e não pela aba escolhida: o estado inicial é `inbox`,
            mas um papel que perca `whatsapp.config` enquanto está em Alertas
            continuaria montando um painel cujas requisições todas falham. */}
        {tab === 'alerts' && can('whatsapp.config') && (
          <>
            {/* O que os alertas acharam de um lado, como eles vigiam do outro:
                juntos, o formulário empurrava as quedas para fora da tela. */}
            <div className="tab-rail mb-4" role="tablist" aria-label={t('whatsapp.alerts.title')}>
              {ALERT_VIEWS.map(([id, labelKey]) => (
                <button
                  key={id}
                  type="button"
                  className="tab-button"
                  data-active={alertsView === id}
                  role="tab"
                  aria-selected={alertsView === id}
                  data-testid={`wa-alerts-view-${id}`}
                  onClick={() => setAlertsView(id)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            {alertsView === 'results' ? <OutagePanel /> : <AlertsPanel />}
          </>
        )}
      </div>
    </div>
  )
}
