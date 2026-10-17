/**
 * Os números de WhatsApp caídos, para a faixa vermelha do topo do painel.
 *
 * Mesmos estados que o alerta da equipe (`ACCOUNT_DOWN_STATUSES` em
 * `waAlertService`): `connecting` e `pending` são alguém pareando agora, de
 * olho na tela, e não precisam de faixa.
 */
export const DOWN_STATUSES: ReadonlySet<string> = new Set(['disconnected', 'expired'])

export interface DownAccount {
  id: number
  /** O apelido, o telefone ou o nome da instância — nessa ordem. */
  name: string
}

export function downAccounts(
  accounts: ReadonlyArray<{ id: number; name: string; label: string | null; phoneE164: string | null; status: string }>
): DownAccount[] {
  return accounts
    .filter((account) => DOWN_STATUSES.has(account.status))
    .map((account) => ({
      id: account.id,
      name: account.label || (account.phoneE164 ? `+${account.phoneE164.replace(/^\+/, '')}` : account.name)
    }))
}

/**
 * A assinatura do conjunto caído. "Fechar" a faixa vale para ESTE conjunto:
 * se outro número cair, a assinatura muda e a faixa volta.
 */
export function downSignature(accounts: ReadonlyArray<DownAccount>): string {
  return accounts.map((account) => account.id).sort((a, b) => a - b).join(',')
}
