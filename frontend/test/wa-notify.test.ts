import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_NOTIFY_PREF_KEY,
  latestPerConversation,
  notifierActive,
  notifyPrefKey,
  readNotifyPref,
  shouldNotify,
  writeNotifyPref,
  type NotificationItem
} from '../src/lib/wa-notify'

const item = (messageId: number, conversationId: number): NotificationItem => ({
  messageId, conversationId, contact: 'X', preview: 'oi', hasAttachment: false, createdAt: '2026-10-05T12:00:00Z', mine: true
})

describe('notificações', () => {
  it('não avisa da conversa aberta com a aba à vista', () => {
    expect(shouldNotify(item(1, 7), { focusedConversationId: 7, visible: true })).toBe(false)
    expect(shouldNotify(item(1, 7), { focusedConversationId: 7, visible: false })).toBe(true)
    expect(shouldNotify(item(1, 7), { focusedConversationId: 8, visible: true })).toBe(true)
  })

  it('uma por conversa, a mais nova', () => {
    const r = latestPerConversation([item(1, 7), item(3, 7), item(2, 9)])
    expect(r.map((i) => i.messageId).sort()).toEqual([2, 3])
  })
})

/** Um `localStorage` fingido, como em `session-owner.test.ts`. */
function gaveta(inicial: Record<string, string> = {}): Storage {
  const dados = new Map(Object.entries(inicial))
  return {
    get length() { return dados.size },
    key: (i: number) => [...dados.keys()][i] ?? null,
    getItem: (k: string) => dados.get(k) ?? null,
    setItem: (k: string, v: string) => { dados.set(k, String(v)) },
    removeItem: (k: string) => { dados.delete(k) },
    clear: () => dados.clear()
  }
}

describe('a preferência de notificar, por dono da sessão', () => {
  let navegador: Storage

  beforeEach(() => {
    navegador = gaveta()
    vi.stubGlobal('localStorage', navegador)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a chave leva o dono; sem dono não há chave', () => {
    expect(notifyPrefKey('provedor-a:7')).toBe('wa-notify-enabled:provedor-a:7')
    expect(notifyPrefKey(null)).toBeNull()
    expect(notifyPrefKey(undefined)).toBeNull()
  })

  it('ligar para um dono não liga para outro', () => {
    writeNotifyPref('provedor-a:1', true)
    expect(readNotifyPref('provedor-a:1')).toBe(true)
    expect(readNotifyPref('provedor-b:1')).toBe(false)
    writeNotifyPref('provedor-a:1', false)
    expect(readNotifyPref('provedor-a:1')).toBe(false)
  })

  it('a chave antiga, sem dono, não vale e é apagada', () => {
    navegador.setItem(LEGACY_NOTIFY_PREF_KEY, '1')
    expect(readNotifyPref('provedor-a:1')).toBe(false)
    expect(navegador.getItem(LEGACY_NOTIFY_PREF_KEY)).toBeNull()

    navegador.setItem(LEGACY_NOTIFY_PREF_KEY, '1')
    writeNotifyPref('provedor-a:1', true)
    expect(navegador.getItem(LEGACY_NOTIFY_PREF_KEY)).toBeNull()
  })

  it('sem dono não lê nem grava', () => {
    writeNotifyPref(null, true)
    expect(navegador.length).toBe(0)
    expect(readNotifyPref(null)).toBe(false)
  })

  it('não quebra com o storage bloqueado', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') }
    })
    expect(readNotifyPref('provedor-a:1')).toBe(false)
    expect(() => writeNotifyPref('provedor-a:1', true)).not.toThrow()
  })
})

describe('o vigia roda', () => {
  it('só com dono e fora da aba de personificação', () => {
    expect(notifierActive({ owner: 'provedor-a:1', tabScoped: false })).toBe(true)
    expect(notifierActive({ owner: 'provedor-a:1', tabScoped: true })).toBe(false)
    expect(notifierActive({ owner: null, tabScoped: false })).toBe(false)
  })
})
