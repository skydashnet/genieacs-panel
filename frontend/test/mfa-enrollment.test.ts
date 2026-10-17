import { describe, expect, it } from 'vitest'
import {
  MFA_ENROLLMENT_CODE,
  canOfferMfaReset,
  canOfferPasswordReset,
  isMfaEnrollmentRefusal,
  mfaPolicyState,
  mustEnroll
} from '../src/lib/mfa-enrollment'

describe('a recusa da ativação obrigatória', () => {
  it('é o 403 com o código dela', () => {
    expect(isMfaEnrollmentRefusal(403, MFA_ENROLLMENT_CODE)).toBe(true)
  })

  it('não é qualquer 403: falta de papel e sessão inválida são outra coisa', () => {
    expect(isMfaEnrollmentRefusal(403, 'missing_permission')).toBe(false)
    expect(isMfaEnrollmentRefusal(403, 'invalid_token')).toBe(false)
    expect(isMfaEnrollmentRefusal(403, undefined)).toBe(false)
  })

  it('nem o código com outro status', () => {
    expect(isMfaEnrollmentRefusal(401, MFA_ENROLLMENT_CODE)).toBe(false)
  })
})

describe('quando a casca dá lugar à ativação', () => {
  it('quando o servidor diz que precisa', () => {
    expect(mustEnroll({ mfaEnrollmentRequired: true })).toBe(true)
    expect(mustEnroll({ mfaEnrollmentRequired: false })).toBe(false)
    expect(mustEnroll({})).toBe(false)
    expect(mustEnroll(null)).toBe(false)
  })

  it('nunca no console nem numa personificação', () => {
    expect(mustEnroll({ mfaEnrollmentRequired: true, platform: true })).toBe(false)
    expect(mustEnroll({
      mfaEnrollmentRequired: true,
      impersonation: { tenantId: 1, platformUserId: 2, expiresAt: null } as never
    })).toBe(false)
  })
})

describe('o botão de desligar o 2FA de alguém da equipe', () => {
  const comum = { isSelf: false, isOwner: false }

  it('aparece para quem tem 2FA', () => {
    expect(canOfferMfaReset({ mfaEnabled: true, role: 'tech' }, comum)).toBe(true)
  })

  it('não aparece para quem não tem o que desligar', () => {
    expect(canOfferMfaReset({ mfaEnabled: false, role: 'tech' }, comum)).toBe(false)
    expect(canOfferMfaReset({ role: 'tech' }, comum)).toBe(false)
  })

  it('não aparece para si mesmo', () => {
    expect(canOfferMfaReset({ mfaEnabled: true, role: 'admin' }, { isSelf: true, isOwner: true })).toBe(false)
  })

  it('num owner, só para outro owner', () => {
    expect(canOfferMfaReset({ mfaEnabled: true, role: 'owner' }, comum)).toBe(false)
    expect(canOfferMfaReset({ mfaEnabled: true, role: 'owner' }, { isSelf: false, isOwner: true })).toBe(true)
  })
})

describe('o cadeado de redefinir a senha de alguém da equipe', () => {
  it('num owner, só para outro owner', () => {
    expect(canOfferPasswordReset({ role: 'owner' }, { isOwner: false })).toBe(false)
    expect(canOfferPasswordReset({ role: 'owner' }, { isOwner: true })).toBe(true)
  })

  it('nos outros papéis, para quem administra a equipe', () => {
    for (const role of ['admin', 'tech', 'viewer']) {
      expect(canOfferPasswordReset({ role }, { isOwner: false })).toBe(true)
    }
  })

  it('nunca na própria linha: a própria senha é trocada pelo perfil', () => {
    expect(canOfferPasswordReset({ role: 'admin' }, { isOwner: false, isSelf: true })).toBe(false)
    expect(canOfferPasswordReset({ role: 'owner' }, { isOwner: true, isSelf: true })).toBe(false)
  })
})

describe('o cartão da exigência', () => {
  it('quem não pode mudar só vê o estado', () => {
    expect(mfaPolicyState({ canChange: false, requireMfa: true }, true)).toBe('readonly')
    expect(mfaPolicyState({ canChange: false, requireMfa: false }, false)).toBe('readonly')
  })

  it('ligar pede o 2FA de quem liga', () => {
    expect(mfaPolicyState({ canChange: true, requireMfa: false }, false)).toBe('needs_self_mfa')
    expect(mfaPolicyState({ canChange: true, requireMfa: false }, true)).toBe('ready')
  })

  it('desligar não pede', () => {
    expect(mfaPolicyState({ canChange: true, requireMfa: true }, false)).toBe('ready')
  })
})
