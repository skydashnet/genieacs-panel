import { describe, expect, it } from 'vitest'

import {
  auditRetentionError,
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  waRetentionAboveCap,
} from '@/lib/settings-validation'
import en from '@/lib/i18n/locales/en'

/**
 * A conferência que a tela faz antes de mandar.
 *
 * O salvar da aba percorre as chaves e para na primeira recusa com uma
 * mensagem genérica, sem dizer qual campo. Enquanto todo campo vinha de um
 * seletor isso nunca apareceu — não havia como digitar algo inválido. O prazo
 * da trilha é o primeiro campo numérico livre a passar por ali, e estes casos
 * são o que impede o operador de levar "não foi possível salvar" sem caminho.
 */
describe('o prazo que serve', () => {
  it('aceita os dois extremos e o padrão', () => {
    expect(auditRetentionError('30')).toBeNull()
    expect(auditRetentionError('365')).toBeNull()
    expect(auditRetentionError('3650')).toBeNull()
  })

  it('e aceita espaço em volta, porque colar traz espaço', () => {
    expect(auditRetentionError('  180  ')).toBeNull()
  })
})

describe('o prazo que não serve', () => {
  it('recusa fora dos limites, de um lado e do outro', () => {
    expect(auditRetentionError(String(AUDIT_RETENTION_MIN_DAYS - 1))).not.toBeNull()
    expect(auditRetentionError(String(AUDIT_RETENTION_MAX_DAYS + 1))).not.toBeNull()
    expect(auditRetentionError('0')).not.toBeNull()
    expect(auditRetentionError('-5')).not.toBeNull()
  })

  it('recusa o que PARECE número para o `parseInt` e não é o que foi digitado', () => {
    // O caso que decide esta função. `Number.parseInt` devolve um inteiro para
    // os três, e um teste de tipo os deixaria passar — chegariam ao servidor
    // como um número que ninguém digitou.
    expect(auditRetentionError('30.5')).not.toBeNull()
    expect(auditRetentionError('12abc')).not.toBeNull()
    expect(auditRetentionError('1e3')).not.toBeNull()
  })

  it('recusa o campo vazio em vez de mandar string vazia ao servidor', () => {
    expect(auditRetentionError('')).not.toBeNull()
    expect(auditRetentionError('   ')).not.toBeNull()
  })

  it('e a mensagem que ela devolve existe no dicionário', () => {
    // Uma chave de tradução que não existe rende uma caixa vazia na tela, que
    // é o mesmo que não avisar. O `typecheck` garante que a chave pertence ao
    // dicionário; este caso garante que ela tem texto.
    const chave = auditRetentionError('9999')
    expect(chave).not.toBeNull()
    expect(String(en[chave!]).trim().length).toBeGreaterThan(0)
  })
})

describe('o teto do plano', () => {
  it('recusa a trilha acima do teto e aceita até ele', () => {
    expect(auditRetentionError('91', 90)).toBe('settings.audit.retentionAboveCap')
    expect(auditRetentionError('90', 90)).toBeNull()
    expect(auditRetentionError('3650', null)).toBeNull()
  })

  it('no WhatsApp, "para sempre" com teto é acima dele', () => {
    expect(waRetentionAboveCap(0, 30)).toBe(true)
    expect(waRetentionAboveCap(31, 30)).toBe(true)
    expect(waRetentionAboveCap(30, 30)).toBe(false)
    expect(waRetentionAboveCap(0, null)).toBe(false)
  })
})
