import { describe, expect, it } from 'vitest'

import type { ApiResponse } from '@/lib/api'
import { cleanSecondFactor, contaBloqueadaNaResposta, mfaStepDaResposta } from '@/lib/login-mfa'

const resposta = (parcial: Partial<ApiResponse>): ApiResponse => ({ success: false, ...parcial })

describe('o login pediu o código?', () => {
  it('pelo code, e só por ele', () => {
    expect(mfaStepDaResposta(resposta({ code: 'mfa_required' }))).toBe('required')
    expect(mfaStepDaResposta(resposta({ code: 'mfa_invalid' }))).toBe('invalid')
  })

  it('senha errada não vira pedido de código', () => {
    expect(mfaStepDaResposta(resposta({ message: 'Usuário ou senha inválidos' }))).toBeNull()
    expect(mfaStepDaResposta(resposta({ code: 'choose_destination' }))).toBeNull()
    expect(mfaStepDaResposta({ success: true, data: {} })).toBeNull()
  })
})

describe('o código digitado', () => {
  it('o do app perde os espaços que o próprio app mostra', () => {
    expect(cleanSecondFactor(' 123 456 ')).toBe('123456')
    expect(cleanSecondFactor('123456')).toBe('123456')
  })

  it('o de recuperação vai como foi digitado, para o servidor normalizar', () => {
    expect(cleanSecondFactor(' abcde-12345 ')).toBe('abcde-12345')
  })
})

describe('a conta bloqueada', () => {
  it('é o código dela, e não a senha errada nem o passo do 2FA', () => {
    expect(contaBloqueadaNaResposta(resposta({ code: 'account_locked' }))).toBe(true)
    expect(contaBloqueadaNaResposta(resposta({ code: 'invalid_credentials' }))).toBe(false)
    expect(contaBloqueadaNaResposta(resposta({ code: 'mfa_required' }))).toBe(false)
    expect(mfaStepDaResposta(resposta({ code: 'account_locked' }))).toBe(null)
  })
})
