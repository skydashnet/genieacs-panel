/**
 * O bloco do Telegram no painel de alertas, sem a tela.
 *
 * O token nunca volta do servidor — a tela só sabe se há um guardado. Então o
 * campo vazio quer dizer "mantenha o que está lá", e apagar é um gesto próprio
 * (o botão "remover"). É a mesma regra do servidor: `botToken` omitido mantém,
 * `''` apaga.
 */
export interface TelegramForm {
  /** O que foi colado agora; vazio = manter o guardado. */
  token: string
  chatId: string
  /** "Remover bot" foi pedido: o salvamento manda `''`. */
  remove: boolean
}

export function telegramPatch(form: TelegramForm): { botToken?: string; chatId: string } {
  const chatId = form.chatId.trim()
  if (form.remove) return { botToken: '', chatId }
  const token = form.token.trim()
  return token ? { botToken: token, chatId } : { chatId }
}

/**
 * Se o Telegram, como está no formulário, conta como alguém para avisar: um
 * bot (guardado e não removido, ou colado agora) e um grupo.
 */
export function telegramWillNotify(form: TelegramForm, storedConfigured: boolean): boolean {
  const temBot = form.remove ? false : Boolean(form.token.trim()) || storedConfigured
  return temBot && Boolean(form.chatId.trim())
}

/**
 * O teste manda pelo que está GUARDADO, não pelo que está no formulário — o
 * token nunca volta do servidor. Então só dá para testar depois de salvar, e
 * sem nada pendente no bloco.
 */
export function telegramCanTest(form: TelegramForm, stored: { configured: boolean; chatId: string } | undefined): boolean {
  if (!stored?.configured || !stored.chatId) return false
  return !form.remove && !form.token.trim() && form.chatId.trim() === stored.chatId
}
