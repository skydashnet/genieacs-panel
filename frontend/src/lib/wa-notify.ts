/** Um item de `GET /whatsapp/notifications`. */
export interface NotificationItem {
  messageId: number
  conversationId: number
  contact: string | null
  preview: string | null
  hasAttachment: boolean
  createdAt: string
  mine: boolean
}

/**
 * Qual conversa está aberta na caixa de entrada agora. Escrito pela página do
 * WhatsApp, lido pelo sino: quem está olhando a conversa não precisa de aviso.
 */
export const focusedConversation: { id: number | null } = { id: null }

/** Avisa? Não da conversa que está aberta com a aba à vista. */
export function shouldNotify(item: Pick<NotificationItem, 'conversationId'>, ctx: { focusedConversationId: number | null; visible: boolean }): boolean {
  return !(ctx.visible && ctx.focusedConversationId === item.conversationId)
}

/** Uma notificação por conversa no lote: a última mensagem de cada uma. */
export function latestPerConversation(items: readonly NotificationItem[]): NotificationItem[] {
  const porConversa = new Map<number, NotificationItem>()
  for (const item of items) {
    const atual = porConversa.get(item.conversationId)
    if (!atual || item.messageId > atual.messageId) porConversa.set(item.conversationId, item)
  }
  return [...porConversa.values()]
}

/**
 * A chave de antes, sem dono: valia para qualquer sessão deste navegador, e o
 * provedor B herdava as notificações que o provedor A ligou. Não é mais lida;
 * só apagada.
 */
export const LEGACY_NOTIFY_PREF_KEY = 'wa-notify-enabled'

/** A preferência mora por dono da sessão (`sessionOwner`); sem dono, em lugar nenhum. */
export function notifyPrefKey(owner: string | null | undefined): string | null {
  return owner ? `${LEGACY_NOTIFY_PREF_KEY}:${owner}` : null
}

/**
 * O vigia roda? Só com dono e numa sessão do navegador: a aba de
 * personificação é uma visita de leitura, e avisar ali das conversas do
 * provedor seria tocar no computador de quem está no console.
 */
export function notifierActive(ctx: { owner: string | null | undefined; tabScoped: boolean }): boolean {
  return Boolean(ctx.owner) && !ctx.tabScoped
}

function apagarChaveAntiga() {
  try {
    localStorage.removeItem(LEGACY_NOTIFY_PREF_KEY)
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

export function readNotifyPref(owner: string | null | undefined): boolean {
  const key = notifyPrefKey(owner)
  if (!key) return false
  apagarChaveAntiga()
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writeNotifyPref(owner: string | null | undefined, on: boolean): void {
  const key = notifyPrefKey(owner)
  if (!key) return
  apagarChaveAntiga()
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Sem armazenamento, a preferência dura só esta aba.
  }
}

/** Dois bipes curtos, sem arquivo de som. Silencioso se o navegador não deixar. */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const bipe = (inicio: number, freq: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + inicio)
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + inicio + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + inicio)
      osc.stop(ctx.currentTime + inicio + 0.2)
    }
    bipe(0, 880)
    bipe(0.22, 1175)
    window.setTimeout(() => { void ctx.close() }, 800)
  } catch {
    // O som é extra; a notificação continua.
  }
}
