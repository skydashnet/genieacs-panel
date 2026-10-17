import { describe, expect, it } from 'vitest'
import { fillQuickReply, firstName, matchQuickReplies, quickReplyQuery } from '../src/lib/quick-replies'

const LISTA = [
  { id: 1, name: 'boas-vindas', body: 'Olá {{primeiro_nome}}, tudo bem?' },
  { id: 2, name: 'prazo', body: 'A visita técnica tem prazo de 48 h.' },
  { id: 3, name: 'senha wifi', body: 'Para trocar a senha, acesse o portal.' },
  { id: 4, name: 'Técnico a caminho', body: 'Nosso técnico está a caminho.' }
]

describe('matchQuickReplies', () => {
  it('sem busca, devolve as primeiras até o limite', () => {
    expect(matchQuickReplies(LISTA, '', 2).map((r) => r.id)).toEqual([1, 2])
  })

  it('ignora acento e maiúsculas, e põe quem bate pelo nome antes de quem bate pelo texto', () => {
    // "tecnic": nome da 4 (com acento) e texto da 2 ("técnica").
    expect(matchQuickReplies(LISTA, 'TECNIC').map((r) => r.id)).toEqual([4, 2])
  })

  it('nada bate, lista vazia', () => {
    expect(matchQuickReplies(LISTA, 'boleto')).toEqual([])
  })
})

describe('fillQuickReply', () => {
  it('troca o que sabe e deixa à vista o que não sabe', () => {
    const texto = fillQuickReply('Oi {{primeiro_nome}}, contrato {{contrato}}. {{ atendente }}', {
      primeiro_nome: 'Maria',
      contrato: null,
      atendente: 'Sabrina'
    })
    expect(texto).toBe('Oi Maria, contrato {{contrato}}. Sabrina')
  })

  it('não mexe em variável que não é da resposta rápida', () => {
    expect(fillQuickReply('{{pix}}', { nome: 'Ana' })).toBe('{{pix}}')
  })
})

describe('firstName', () => {
  it('pega a primeira palavra de um nome composto, com a inicial maiúscula', () => {
    expect(firstName('KARINE DE ARAUJO FERREIRA SODRE')).toBe('Karine')
    expect(firstName('  ')).toBe('')
    expect(firstName(null)).toBe('')
  })
})

describe('quickReplyQuery', () => {
  it('só vale com a "/" no começo e numa linha', () => {
    expect(quickReplyQuery('/pra')).toBe('pra')
    expect(quickReplyQuery('/')).toBe('')
    expect(quickReplyQuery('olá /pra')).toBeNull()
    expect(quickReplyQuery('/pra\noutra')).toBeNull()
  })
})
