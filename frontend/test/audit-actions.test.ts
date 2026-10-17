import { describe, expect, it } from 'vitest'

import { AUDIT_ACTION_LABEL_KEYS, auditActionLabelKey } from '@/lib/audit-actions'
import en from '@/lib/i18n/locales/en'

/**
 * A trilha mostra frases, e as frases vêm de um mapa escrito à mão contra um
 * enum que mora no backend. Nada no tipo liga os dois: `action` é string livre
 * no banco de propósito, então uma ação nova nasce no backend, é gravada, e
 * aparece na tela como código cru — sem erro, sem aviso, só uma linha que não
 * quer dizer nada para quem lê.
 *
 * Este arquivo é o que liga. O módulo do backend é alcançado por caminho
 * calculado para que o TypeScript o trate como import dinâmico, pelo mesmo
 * motivo de `test/permissions.test.ts`: ligar `allowJs` para tipar um arquivo
 * que não é do frontend sairia bem mais caro.
 */
const backendUrl = new URL('../../backend/src/models/AuditLog.js', import.meta.url).href

interface BackendAuditLog {
  default: { ACTIONS: Record<string, string> }
}

const backend = (await import(/* @vite-ignore */ backendUrl)) as BackendAuditLog
const acoesDoBackend = Object.values(backend.default.ACTIONS)

describe('o vocabulário da trilha acompanha o backend', () => {
  it('tem frase para toda ação que o backend conhece', () => {
    for (const acao of acoesDoBackend) {
      expect(AUDIT_ACTION_LABEL_KEYS[acao], `a ação "${acao}" não tem frase`).toBeTruthy()
    }
  })

  /**
   * O contrário do de cima, e ele pega outra coisa: a ação que saiu do enum e
   * cuja frase ficou. Não quebra tela nenhuma — e é exatamente por isso que
   * some do radar e vira dicionário morto em treze idiomas.
   */
  it('e nenhuma frase sobrando, de ação que o backend não tem mais', () => {
    expect(Object.keys(AUDIT_ACTION_LABEL_KEYS).sort()).toEqual([...acoesDoBackend].sort())
  })

  /**
   * O `tsc` também pega uma chave inexistente, mas diz só que o tipo não bate.
   * Este diz QUAL ação ficou sem frase, que é a informação que falta às três da
   * manhã.
   */
  it('e toda frase existe mesmo no dicionário', () => {
    for (const [acao, chave] of Object.entries(AUDIT_ACTION_LABEL_KEYS)) {
      expect(en[chave], `a ação "${acao}" aponta para a chave inexistente "${chave}"`).toBeTruthy()
    }
  })
})

describe('a ação que este frontend não conhece', () => {
  /**
   * `action` é varchar livre e o backend não valida contra o enum ao gravar —
   * os próprios testes dele gravam `acao.inventada`. A tela tem que aguentar
   * isso sem quebrar, mostrando o código cru.
   */
  it('não tem frase, e isso não é erro', () => {
    expect(auditActionLabelKey('acao.que.nunca.existiu')).toBeNull()
    expect(auditActionLabelKey('')).toBeNull()
  })

  it('e a que ele conhece tem', () => {
    expect(auditActionLabelKey('portal_password.revealed')).toBe('audit.action.portalPasswordRevealed')
  })
})
