import { describe, expect, it } from 'vitest'
import { destinosDaResposta } from '@/lib/login-destinations'

/**
 * A linha que separa "escolha um" de "senha inválida".
 *
 * Errar para o lado errado mostra erro de credencial a quem acertou a senha —
 * a falha mais cara desta tela, e a que só aparece com conta de mais de um
 * provedor, que é justamente a que ninguém tem à mão para testar na unha.
 */
const destinos = {
  tenants: [
    { id: 1, name: 'Provedor Alfa', slug: 'alfa', status: 'active' },
    { id: 2, name: 'Provedor Beta', slug: 'beta', status: 'active' }
  ],
  console: false
}

describe('destinosDaResposta', () => {
  it('devolve os destinos quando o servidor pediu para escolher', () => {
    expect(destinosDaResposta({
      success: false, code: 'choose_destination', destinations: destinos
    })).toEqual(destinos)
  })

  it('não confunde uma recusa de credencial com uma pergunta', () => {
    expect(destinosDaResposta({ success: false, message: 'Credenciais inválidas' })).toBeNull()
  })

  it('não transforma um login bem-sucedido em pergunta', () => {
    expect(destinosDaResposta({
      success: true, data: { token: 'x', refreshToken: 'y', user: {} }
    })).toBeNull()
  })

  it('reconhece pelo código, não por outro 409 qualquer', () => {
    // O 409 é usado por outras rotas com outro significado — o de valor curto,
    // por exemplo. Sem o código, qualquer um deles viraria uma pergunta.
    expect(destinosDaResposta({
      success: false, code: 'underpaid', expectedCents: 5000, paidCents: 1000
    })).toBeNull()
  })

  it('um pedido de escolha sem lista cai na recusa, que é o lado seguro', () => {
    expect(destinosDaResposta({ success: false, code: 'choose_destination' })).toBeNull()
    expect(destinosDaResposta({
      success: false, code: 'choose_destination', destinations: { console: true } as never
    })).toBeNull()
  })
})
