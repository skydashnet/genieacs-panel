import { describe, expect, it } from 'vitest'

import { BILLING_HIDE_CODES, billingFailure } from '@/lib/portal-billing'

/**
 * A cobrança do portal quando a consulta falha.
 *
 * O que estes casos defendem é a diferença entre "não foi possível consultar
 * agora" e "não há nada a pagar". A regra antiga listava os códigos que
 * MOSTRAVAM erro e escondia o resto — e três falhas chegavam sem código
 * nenhum. Nas três, a seção de cobrança sumia, e o assinante lia que não
 * devia nada.
 */
const AGORA_NAO = 'Não foi possível consultar as faturas agora.'

describe('as falhas que chegavam sem código, e escondiam a cobrança', () => {
  it('a rede que caiu no meio', () => {
    expect(billingFailure(null, AGORA_NAO)).toEqual({ kind: 'error', message: AGORA_NAO })
  })

  it('a página de erro HTML de um proxy na frente', () => {
    // `portalRequest` devolve isto quando a resposta não é JSON: um 502 de
    // nginx, um portal cativo. Sem código.
    const html = { success: false, message: 'O portal retornou uma resposta inválida' }
    expect(billingFailure(html, AGORA_NAO)).toEqual({ kind: 'error', message: html.message })
  })

  it('o 502 genérico do próprio backend', () => {
    // `CustomerPortalController.billing` responde assim a qualquer erro que
    // não seja do SGP — e também sem código.
    const backend = { success: false, message: 'Não foi possível consultar suas faturas agora.' }
    expect(billingFailure(backend, AGORA_NAO).kind).toBe('error')
  })
})

describe('o que esconde, e só isso', () => {
  it('cobrança desligada e aparelho sem contrato', () => {
    for (const code of ['billing_disabled', 'unlinked', 'not_found', 'missing_contract']) {
      expect(billingFailure({ code, message: 'qualquer' }, AGORA_NAO), code).toEqual({ kind: 'hide' })
    }
    expect(BILLING_HIDE_CODES.size).toBe(4)
  })

  it('e os soluços do SGP continuam aparecendo, com a frase do servidor', () => {
    for (const code of ['timeout', 'unreachable', 'sgp_rejected', 'http_error', 'invalid_response', 'unauthorized']) {
      expect(billingFailure({ code, message: `do servidor: ${code}` }, AGORA_NAO), code)
        .toEqual({ kind: 'error', message: `do servidor: ${code}` })
    }
  })

  it('código que ninguém previu é falha, e não "nada a mostrar"', () => {
    // É a inversão inteira num caso: o padrão agora é mostrar.
    expect(billingFailure({ code: 'codigo_novo_do_futuro' }, AGORA_NAO)).toEqual({ kind: 'error', message: AGORA_NAO })
  })
})
