import { describe, expect, it } from 'vitest'

import { filenameFromDisposition } from '@/lib/api'
import { exportFileName, subscriberFileName } from '@/lib/utils'

/**
 * Quem nomeia o arquivo exportado é o servidor, no `Content-Disposition`. Estas
 * duas funções são as duas metades disso do lado do navegador: uma lê o nome
 * que veio, a outra inventa um quando não veio — o caso do painel servido de
 * outra origem por um backend que não expõe o cabeçalho.
 *
 * Vale testar porque as duas falham em silêncio: o arquivo baixa do mesmo
 * jeito, com um nome errado que ninguém liga a este código.
 */
describe('o nome que o servidor mandou', () => {
  it('sai do cabeçalho comum', () => {
    expect(filenameFromDisposition('attachment; filename="skygenpanel-acme-2026-09-12.json"'))
      .toBe('skygenpanel-acme-2026-09-12.json')
  })

  it('sai também sem aspas', () => {
    expect(filenameFromDisposition('attachment; filename=relatorio.json')).toBe('relatorio.json')
  })

  /** O `filename*` do RFC 5987 é o que carrega acento sem quebrar, e ganha do outro. */
  it('prefere a forma que aguenta acento', () => {
    const header = "attachment; filename=\"provedor.json\"; filename*=UTF-8''provedor-com-acentua%C3%A7%C3%A3o.json"
    expect(filenameFromDisposition(header)).toBe('provedor-com-acentuação.json')
  })

  /**
   * Um cabeçalho com caminho dentro não pode virar caminho no disco de quem
   * baixa: o navegador já se defende, e depender só disso é depender de um
   * detalhe de implementação de outra pessoa.
   */
  it('devolve só o nome, nunca um caminho', () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd')
  })

  it('e nada quando não há cabeçalho ou ele não diz nome', () => {
    expect(filenameFromDisposition(null)).toBeUndefined()
    expect(filenameFromDisposition('attachment')).toBeUndefined()
    expect(filenameFromDisposition('attachment; filename=""')).toBeUndefined()
  })
})

describe('o nome de reserva', () => {
  it('leva o provedor e a data, na ordem que ordena por nome', () => {
    expect(exportFileName('acme', new Date('2026-09-12T23:30:00Z')))
      .toBe('skygenpanel-acme-2026-09-12.json')
  })

  /**
   * A data é ISO e não localizada: `toLocaleDateString()` devolveria
   * `12/09/2026` em pt-BR, e barra dentro de nome de arquivo é caminho.
   */
  it('nunca produz uma barra', () => {
    expect(exportFileName('acme')).not.toContain('/')
    expect(exportFileName('grupo/telecom')).not.toContain('/')
  })

  it('e aguenta o host que não nomeia provedor nenhum', () => {
    expect(exportFileName(null, new Date('2026-01-02T00:00:00Z')))
      .toBe('skygenpanel-export-2026-01-02.json')
  })
})

describe('o nome de reserva do dossiê de um assinante', () => {
  it('leva o ID do Cliente e a data, com prefixo que diz de que arquivo se trata', () => {
    expect(subscriberFileName('CSG-1234567-890123', new Date('2026-09-12T23:30:00Z')))
      .toBe('assinante-CSG-1234567-890123-2026-09-12.json')
  })

  /** Mesma razão de cima, e aqui o valor vem do cadastro do ISP e não do slug. */
  it('nunca produz uma barra', () => {
    expect(subscriberFileName('CSG/1234')).not.toContain('/')
    expect(subscriberFileName(null)).not.toContain('/')
  })
})
