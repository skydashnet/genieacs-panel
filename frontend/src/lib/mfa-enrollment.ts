import type { User } from '@/types'

/**
 * O provedor exige o login em duas etapas e esta pessoa ainda não ativou.
 *
 * O servidor recusa quase tudo a essa sessão com um 403 deste código, e a
 * tela, em vez de mostrar a recusa em cada chamada, leva a pessoa à ativação.
 */
export const MFA_ENROLLMENT_CODE = 'mfa_enrollment_required'

/** Disparado em `window` quando uma chamada volta com a recusa acima. */
export const MFA_ENROLLMENT_EVENT = 'auth:mfa-enrollment-required'

/**
 * Se uma resposta é a recusa da ativação obrigatória — pelo `code`, nunca só
 * pelo 403: 403 é também a falta de papel (`missing_permission`) e a sessão
 * inválida (`invalid_token`), e levar essas duas à tela de ativar prenderia
 * quem já tem o 2FA numa página que não resolve nada.
 */
export function isMfaEnrollmentRefusal(status: number, code: unknown): boolean {
  return status === 403 && code === MFA_ENROLLMENT_CODE
}

/**
 * Se a casca do painel deve dar lugar à ativação obrigatória.
 *
 * A personificação e o console ficam de fora: são sessões da plataforma, a que
 * a exigência do provedor não se aplica — e o servidor também não as recusa.
 */
export function mustEnroll(user: Pick<User, 'mfaEnrollmentRequired' | 'platform' | 'impersonation'> | null | undefined): boolean {
  if (!user || user.platform || user.impersonation) return false
  return Boolean(user.mfaEnrollmentRequired)
}

/**
 * O botão "desligar 2FA" na lista da equipe: só para quem tem 2FA, nunca para
 * si mesmo (o cartão da própria conta faz isso com senha e código) e, num
 * `owner`, só para outro `owner`. É o espelho das regras do servidor que a tela
 * sabe conferir; as outras (trabalha em outro provedor, opera a plataforma) só
 * o servidor conhece, e ele explica ao recusar.
 */
export function canOfferMfaReset(
  operator: { mfaEnabled?: boolean; role: string | null },
  { isSelf, isOwner }: { isSelf: boolean; isOwner: boolean }
): boolean {
  if (!operator.mfaEnabled || isSelf) return false
  if (operator.role === 'owner' && !isOwner) return false
  return true
}

/**
 * O cadeado "redefinir senha" na lista da equipe: num `owner`, só para outro
 * `owner`. O servidor recusa com 403 os outros casos (trocar a senha do dono é
 * entrar como ele); a tela não oferece o que vai ser recusado. Nem na própria
 * linha: a própria senha se troca pelo perfil, que pede a atual.
 */
export function canOfferPasswordReset(
  operator: { role: string | null },
  { isOwner, isSelf = false }: { isOwner: boolean; isSelf?: boolean }
): boolean {
  if (isSelf) return false
  return operator.role !== 'owner' || isOwner
}

export type MfaPolicyState = 'readonly' | 'needs_self_mfa' | 'ready'

/**
 * O que o cartão da exigência mostra: só o estado (quem não é o dono), o aviso
 * de ativar o próprio 2FA antes (o servidor recusa ligar sem ele) ou a chave.
 *
 * Desligar nunca depende do próprio 2FA — só ligar.
 */
export function mfaPolicyState(
  { canChange, requireMfa }: { canChange: boolean; requireMfa: boolean },
  selfMfaEnabled: boolean
): MfaPolicyState {
  if (!canChange) return 'readonly'
  if (!requireMfa && !selfMfaEnabled) return 'needs_self_mfa'
  return 'ready'
}
