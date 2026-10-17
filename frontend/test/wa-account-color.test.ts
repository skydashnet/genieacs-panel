import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { WhatsAppAccount } from '@/lib/api'
import en from '@/lib/i18n/locales/en'
import {
  WA_ACCOUNT_CLASS,
  WA_ACCOUNT_COLORS,
  WA_ACCOUNT_COLOR_LABEL,
  accountColor,
  accountName,
  accountTag
} from '@/lib/wa-account-color'

/**
 * A cor de cada número do WhatsApp na caixa de entrada.
 *
 * O que estes casos defendem: a conversa diz por qual número chegou, e o que
 * ela diz é verdade. A paleta é importada do backend — que é quem grava a cor —
 * por caminho calculado, no molde de `rx-signal.test.ts`.
 */
const backendUrl = new URL('../../backend/src/config/waAccountColors.js', import.meta.url).href
const backend = (await import(/* @vite-ignore */ backendUrl)) as {
  WA_ACCOUNT_COLORS: readonly string[]
  nextAccountColor: (usadas: Array<string | null>) => string
}

const numero = (id: number, extra: Partial<WhatsAppAccount> = {}): WhatsAppAccount => ({
  id,
  name: `skygp_${id}`,
  label: null,
  purpose: 'general',
  color: null,
  flavor: 'v2',
  baseUrl: 'https://evo.exemplo.test',
  status: 'connected',
  qrUpdatedAt: null,
  phoneE164: null,
  isDefault: false,
  lastSeenAt: null,
  lastError: null,
  webhookVerdict: null,
  webhookServerUrl: null,
  webhookCheckedAt: null,
  ...extra
} as WhatsAppAccount)

const mapa = (...contas: WhatsAppAccount[]) => new Map(contas.map((conta) => [conta.id, conta]))

describe('a paleta', () => {
  it('é a mesma do backend, na mesma ordem', () => {
    // A ordem importa: é ela que decide qual cor o próximo número ganha, e a
    // tela de troca mostra as amostras nela.
    expect([...WA_ACCOUNT_COLORS]).toEqual([...backend.WA_ACCOUNT_COLORS])
  })

  it('não tem as cores de estado do painel', () => {
    // Conversa pintada de vermelho leria como erro; de verde, como "tudo certo".
    for (const estado of ['red', 'green', 'yellow', 'amber']) {
      expect(WA_ACCOUNT_COLORS as readonly string[]).not.toContain(estado)
    }
  })

  it('nenhuma fica perto do verde das respostas do provedor, em nenhum tema', () => {
    // A mensagem RECEBIDA é pintada na cor do número, e a resposta do provedor
    // fica logo abaixo no verde do painel. Uma cor a vinte graus dele faria o
    // que chegou parecer o que saiu — foi assim que o verde-azulado saiu.
    const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'globals.css'), 'utf8')
    const temas = css.split('.dark {')
    expect(temas).toHaveLength(2)
    const matiz = (bloco: string, nome: string) => {
      const achado = bloco.match(new RegExp(`--${nome}: (\\d+) `))
      expect(achado, nome).not.toBeNull()
      return Number(achado?.[1])
    }
    const distancia = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
    for (const bloco of temas) {
      const verde = matiz(bloco, 'primary')
      for (const cor of WA_ACCOUNT_COLORS) {
        expect(distancia(matiz(bloco, `wa-${cor}`), verde), cor).toBeGreaterThanOrEqual(30)
      }
    }
  })

  it('cada cor tem classe, regra de CSS nos dois temas e nome no dicionário', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'globals.css'), 'utf8')
    for (const cor of WA_ACCOUNT_COLORS) {
      expect(WA_ACCOUNT_CLASS[cor]).toBe(`wa-account-${cor}`)
      expect(css, cor).toContain(`.wa-account-${cor} { --wa-account: var(--wa-${cor}); }`)
      // Uma vez no tema claro, outra no escuro.
      expect(css.match(new RegExp(`--wa-${cor}: \\d`, 'g')) ?? [], cor).toHaveLength(2)
      expect(en[WA_ACCOUNT_COLOR_LABEL[cor]], cor).toBeTruthy()
    }
  })
})

describe('a cor de um número', () => {
  it('é a gravada, quando é uma da paleta', () => {
    expect(accountColor(numero(1, { color: 'pink' }))).toBe('pink')
  })

  it('e nunca vazia: sem cor, ou com uma que este frontend não conhece, sai uma do id', () => {
    // Número que nasceu antes da cor existir, ou servidor mais novo. A tela
    // não pode desenhar um número sem cor e sem nome.
    for (const color of [null, '', 'magenta']) {
      const cor = accountColor(numero(3, { color }))
      expect(WA_ACCOUNT_COLORS).toContain(cor)
      expect(cor).toBe(accountColor(numero(3, { color: null })))
    }
    // Ids vizinhos, cores diferentes.
    expect(accountColor(numero(3))).not.toBe(accountColor(numero(4)))
  })

  it('o nome segue a ordem da tela de números: apelido, telefone, instância', () => {
    expect(accountName(numero(1, { label: 'Suporte', phoneE164: '5593999990000' }))).toBe('Suporte')
    expect(accountName(numero(1, { phoneE164: '5593999990000' }))).toBe('5593999990000')
    expect(accountName(numero(1))).toBe('skygp_1')
  })
})

describe('o número de uma conversa', () => {
  const suporte = numero(1, { label: 'Suporte', color: 'blue' })
  const cobranca = numero(2, { label: 'Cobrança', color: 'orange' })

  it('traz a cor e o nome do número que recebeu', () => {
    const tag = accountTag(mapa(suporte, cobranca), { accountId: 2 })
    expect(tag).toEqual({ className: 'wa-account-orange', color: 'orange', name: 'Cobrança', showName: true })
  })

  it('duas conversas do mesmo assinante, uma por número, ficam diferentes', () => {
    // O caso da captura: o mesmo nome duas vezes seguidas, e nada separando.
    const contas = mapa(suporte, cobranca)
    const a = accountTag(contas, { accountId: 1 })
    const b = accountTag(contas, { accountId: 2 })
    expect(a?.color).not.toBe(b?.color)
    expect(a?.name).not.toBe(b?.name)
  })

  it('com um número só, o nome não aparece — mas a cor sim', () => {
    const tag = accountTag(mapa(suporte), { accountId: 1 })
    expect(tag?.showName).toBe(false)
    expect(tag?.className).toBe('wa-account-blue')
  })

  it('número que a lista não tem é "não sei", e não um número inventado', () => {
    // Lista que não carregou, ou conversa de um número apagado no meio.
    expect(accountTag(new Map(), { accountId: 1 })).toBeNull()
    expect(accountTag(mapa(suporte), { accountId: 99 })).toBeNull()
  })
})

describe('a primeira cor de cada número, que é o backend quem escolhe', () => {
  it('nunca repete enquanto houver livre, e depois vai para a menos usada', () => {
    const usadas: string[] = []
    for (let i = 0; i < WA_ACCOUNT_COLORS.length; i += 1) {
      const cor = backend.nextAccountColor(usadas)
      expect(usadas).not.toContain(cor)
      usadas.push(cor)
    }
    // O nono: todas com um uso, então a primeira da paleta.
    expect(backend.nextAccountColor(usadas)).toBe(WA_ACCOUNT_COLORS[0])
    // Uma cor trocada à mão libera a dela para o próximo.
    expect(backend.nextAccountColor(['blue', 'blue', 'pink'])).toBe('lime')
    expect(backend.nextAccountColor([null, 'lixo'])).toBe('blue')
  })
})
