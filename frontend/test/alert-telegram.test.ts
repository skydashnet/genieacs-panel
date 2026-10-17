import { describe, expect, it } from 'vitest'
import { telegramCanTest, telegramPatch, telegramWillNotify } from '../src/lib/alert-telegram'

const vazio = { token: '', chatId: '-100123', remove: false }

describe('o salvamento do Telegram', () => {
  it('campo do token vazio mantém o guardado: o token não vai', () => {
    expect(telegramPatch(vazio)).toEqual({ chatId: '-100123' })
  })

  it('token colado vai, limpo', () => {
    expect(telegramPatch({ ...vazio, token: ' 123:abc ' })).toEqual({ botToken: '123:abc', chatId: '-100123' })
  })

  it('remover manda vazio, mesmo com algo no campo', () => {
    expect(telegramPatch({ ...vazio, token: '123:abc', remove: true })).toEqual({ botToken: '', chatId: '-100123' })
  })
})

describe('quando o Telegram conta como alguém para avisar', () => {
  it('com bot guardado ou colado, e grupo', () => {
    expect(telegramWillNotify(vazio, true)).toBe(true)
    expect(telegramWillNotify({ ...vazio, token: '123:abc' }, false)).toBe(true)
  })

  it('sem grupo, sem bot, ou com o bot removido, não conta', () => {
    expect(telegramWillNotify({ ...vazio, chatId: ' ' }, true)).toBe(false)
    expect(telegramWillNotify(vazio, false)).toBe(false)
    expect(telegramWillNotify({ ...vazio, remove: true }, true)).toBe(false)
  })
})

describe('o botão de teste', () => {
  const guardado = { configured: true, chatId: '-100123' }

  it('só com o que está guardado e nada pendente', () => {
    expect(telegramCanTest(vazio, guardado)).toBe(true)
    expect(telegramCanTest(vazio, { configured: false, chatId: '-100123' })).toBe(false)
    expect(telegramCanTest({ ...vazio, token: '123:abc' }, guardado)).toBe(false)
    expect(telegramCanTest({ ...vazio, chatId: '-100999' }, guardado)).toBe(false)
    expect(telegramCanTest({ ...vazio, remove: true }, guardado)).toBe(false)
    expect(telegramCanTest(vazio, undefined)).toBe(false)
  })
})
