import { describe, expect, it } from 'vitest'

import { formatSgpDate, routerUrl, sgpBadge } from '@/lib/sgp'

/**
 * A cor do selo de um contrato do ERP.
 *
 * O arquivo existe por causa do primeiro caso. A tela decidia a cor com
 * `/ativo/i.test(statusLabel)`, e **"Inativo" contém "ativo"** — então um
 * contrato inativo aparecia com o selo verde de sucesso, na tela que o operador
 * abre justamente para entender por que o cliente está sem internet.
 *
 * O backend já tinha resolvido isso e escrito o porquê: `deriveContractState`
 * testa cancelamento ANTES de "ativo", exatamente "because 'Inativo' and
 * 'Desativado' contain 'ativo'", e manda o resultado pronto no payload. O que
 * faltava era a tela usar o que já chegava.
 */
describe('o selo de situação do contrato', () => {
  it('não pinta de verde um contrato cancelado que se chama "Inativo"', () => {
    const selo = sgpBadge({ state: 'cancelled', statusLabel: 'Inativo', status: null })
    expect(selo.className).not.toBe('modern-badge-success')
    // E o regex antigo teria dito o contrário — é isto que o caso guarda.
    expect(/ativo/i.test('Inativo')).toBe(true)
  })

  /**
   * O bloqueio do ERP vence o rótulo, que é a mesma ordem que
   * `deriveContractState` aplica do outro lado: um `bloqueado` explícito ganha
   * de um rótulo que ainda diz "Ativo".
   */
  it('e nem um contrato bloqueado cujo rótulo ainda diz "Ativo"', () => {
    const selo = sgpBadge({ state: 'blocked', statusLabel: 'Ativo', status: 'A' })
    expect(selo.className).not.toBe('modern-badge-success')
    expect(selo.className).toBe('modern-badge-warning')
  })

  it('e os quatro estados têm cada um a sua cor', () => {
    const cores = (['active', 'blocked', 'cancelled', 'unknown'] as const)
      .map((state) => sgpBadge({ state, statusLabel: null, status: null }).className)
    expect(new Set(cores).size).toBe(4)
    expect(cores[0]).toBe('modern-badge-success')
  })

  /**
   * O caso que decide para que lado errar. Um payload sem `state` — versão
   * antiga do servidor, resposta pela metade, campo que alguém tirou — tem que
   * cair no neutro. Um selo que erra para o lado bom é o que ninguém confere.
   */
  it('e sem estado nenhum, o neutro — nunca o verde', () => {
    expect(sgpBadge({ statusLabel: 'Ativo', status: null }).className).toBe('modern-badge')
    expect(sgpBadge({ state: null, statusLabel: 'Ativo', status: null }).className).toBe('modern-badge')
    expect(sgpBadge(null).className).toBe('modern-badge')
    expect(sgpBadge(undefined).className).toBe('modern-badge')
  })
})

/**
 * Quem nomeia a situação é o ERP do provedor, que escreve cada um do seu jeito.
 * Nós escolhemos a cor e mais nada — traduzir o rótulo seria inventar um
 * vocabulário que não é nosso.
 */
describe('e o texto dele', () => {
  it('é o rótulo do ERP, com o rótulo longo ganhando do código', () => {
    expect(sgpBadge({ state: 'active', statusLabel: 'Ativo', status: 'A' }).text).toBe('Ativo')
    expect(sgpBadge({ state: 'active', statusLabel: null, status: 'A' }).text).toBe('A')
  })

  it('e sem rótulo nenhum, a tela traduz a chave que a função devolve', () => {
    const selo = sgpBadge({ state: 'unknown', statusLabel: null, status: null })
    expect(selo.text).toBeNull()
    expect(selo.fallbackKey).toBe('detail.sgp.statusUnknown')
  })

  it('e rótulo em branco não vale como rótulo', () => {
    // Um ERP que devolve '   ' faria a tela desenhar um selo vazio, que não
    // diz nada e ainda parece um defeito de layout.
    expect(sgpBadge({ state: 'active', statusLabel: '   ', status: null }).text).toBeNull()
  })
})

/**
 * O link "Abrir roteador" do módulo SGP da conversa. O endereço vem da ONT,
 * e o que a ONT escreve no campo não é confiável como URL: só um IPv4 comum
 * vira link, e qualquer outra coisa fica como texto.
 */
describe('routerUrl', () => {
  it('turns a dotted IPv4 into the router page', () => {
    expect(routerUrl('100.64.10.20')).toBe('http://100.64.10.20/')
    expect(routerUrl(' 177.10.0.1 ')).toBe('http://177.10.0.1/')
  })

  it('refuses anything that is not a plain address', () => {
    expect(routerUrl(null)).toBeNull()
    expect(routerUrl('')).toBeNull()
    expect(routerUrl('0.0.0.0')).toBeNull()
    expect(routerUrl('256.1.1.1')).toBeNull()
    expect(routerUrl('1.2.3')).toBeNull()
    expect(routerUrl('javascript:alert(1)')).toBeNull()
    expect(routerUrl('evil.example/1.2.3.4')).toBeNull()
    expect(routerUrl('2804:14c::1')).toBeNull()
  })
})

describe('formatSgpDate', () => {
  it('mostra o vencimento do SGP no padrão brasileiro, sem escorregar de dia', () => {
    expect(formatSgpDate('2026-10-03', 'pt-BR')).toBe('03/10/2026')
    expect(formatSgpDate('2026-01-01', 'pt-BR')).toBe('01/01/2026')
  })

  it('vazio vira travessão e o que não é data volta como veio', () => {
    expect(formatSgpDate(null, 'pt-BR')).toBe('—')
    expect(formatSgpDate('', 'pt-BR')).toBe('—')
    expect(formatSgpDate('sem data', 'pt-BR')).toBe('sem data')
  })
})
