export type WifiStatusFilter = 'all' | 'enabled' | 'disabled' | 'unknown'

const FILTERS: readonly WifiStatusFilter[] = ['all', 'enabled', 'disabled', 'unknown']

/**
 * Lê o valor salvo no navegador. Qualquer coisa fora das opções (chave
 * ausente, valor antigo, lixo) volta para "todas" — nunca esconde redes por
 * engano.
 */
export function parseWifiStatusFilter(value: string | null | undefined): WifiStatusFilter {
  return FILTERS.includes(value as WifiStatusFilter) ? (value as WifiStatusFilter) : 'all'
}

/**
 * Em que grupo a rede cai. "Estado desconhecido" (`null`/`undefined`) é um
 * grupo próprio: o CPE não informou, e contá-la como desativada fazia um
 * equipamento sem o dado mostrar "Ativas (0)".
 */
export function wifiStatusGroup(enabled: boolean | null | undefined): Exclude<WifiStatusFilter, 'all'> {
  if (enabled === true) return 'enabled'
  if (enabled === false) return 'disabled'
  return 'unknown'
}

export function filterWifiByStatus<T>(
  networks: readonly T[],
  filter: WifiStatusFilter,
  isEnabled: (network: T) => boolean | null | undefined
) {
  const counts: Record<WifiStatusFilter, number> = { all: networks.length, enabled: 0, disabled: 0, unknown: 0 }
  for (const network of networks) counts[wifiStatusGroup(isEnabled(network))] += 1
  const visible = filter === 'all'
    ? [...networks]
    : networks.filter((network) => wifiStatusGroup(isEnabled(network)) === filter)
  return { visible, counts }
}
