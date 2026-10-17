/**
 * A cópia do dashboard que a aba guarda para abrir a tela Operação sem esperar.
 *
 * Ela tem dono: o provedor e o usuário que a viram. Antes a chave era uma só
 * por aba, e trocar de provedor — sair e entrar em outro, ou a personificação,
 * cuja aba nova herda o `sessionStorage` da aba do console — mostrava os
 * números do provedor anterior até alguém limpar os dados do navegador.
 */
const KEY = 'skygenpanel.dashboard.snapshot.v2'
/** A chave antiga, sem dono: só existe para ser apagada. */
const LEGACY_KEY = 'skygenpanel.dashboard.snapshot.v1'

export function readDashboardSnapshot<T>(owner: string | null): T | null {
  if (!owner) return null
  try {
    sessionStorage.removeItem(LEGACY_KEY)
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.owner === owner && parsed.data ? parsed.data as T : null
  } catch {
    return null
  }
}

export function writeDashboardSnapshot(owner: string | null, data: unknown) {
  if (!owner) return
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ owner, data }))
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
}

/** Apaga a cópia: toda vez que a sessão da aba muda de dono. */
export function clearDashboardSnapshot() {
  try {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(LEGACY_KEY)
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
}
