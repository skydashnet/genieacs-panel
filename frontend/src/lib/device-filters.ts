/**
 * O recorte da lista de equipamentos, lido e escrito na URL.
 *
 * Módulo próprio, e não um trecho dentro de `pages/devices.tsx`, pelo motivo de
 * sempre neste repositório: o vitest roda em ambiente `node`, sem jsdom, então
 * importar a página puxaria o React inteiro e o teste não sairia do lugar.
 * Função pura aqui é lógica com prova; dentro do componente seria lógica sem.
 *
 * POR QUE O FILTRO VIVE NA URL
 * ---------------------------
 * O painel aponta para esta lista com o recorte já escolhido — "os 7 que
 * precisam de atenção" abre `?status=offline`, e não o inventário inteiro, que
 * é o que aqueles links faziam antes de existirem estes parâmetros. Os três
 * ganhos são todos do plantão: o endereço pode ser mandado para um colega,
 * sobrevive a recarregar a página, e o botão voltar do navegador faz o que
 * qualquer um espera.
 *
 * TUDO AQUI É ENTRADA DE ESTRANHO
 * -------------------------------
 * Uma query é digitável, colável e editável por quem passar. `?status=banana`
 * tem que virar "todos" e nunca chegar à API — por isso cada leitura passa por
 * uma lista fechada, e não por um cast que o TypeScript aceita e o servidor não.
 */

/** `stale`: último Inform há mais de 3 dias — o servidor aplica o corte. */
export type DeviceStatusFilter = 'all' | 'online' | 'offline' | 'stale'
export type SgpFilter = 'all' | 'active' | 'blocked' | 'cancelled' | 'unknown' | 'unlinked'

/**
 * O recorte que o painel aponta: cada valor é UM número daquela tela.
 *
 * Vocabulário fechado e igual ao do servidor. Aqui vale a mesma regra do
 * `status`: o que a URL traz e esta lista não conhece vira "todos" e não chega
 * à API — `?focus=banana` morre neste arquivo.
 */
export type DeviceFocusFilter = 'all' | 'new24h' | 'weak-signal' | 'hot' | 'many-clients'

const STATUS_FILTERS: readonly DeviceStatusFilter[] = ['all', 'online', 'offline', 'stale']
const SGP_FILTERS: readonly SgpFilter[] = [
  'all', 'active', 'blocked', 'cancelled', 'unknown', 'unlinked'
]
const FOCUS_FILTERS: readonly DeviceFocusFilter[] = [
  'all', 'new24h', 'weak-signal', 'hot', 'many-clients'
]

export interface DeviceFilters {
  search: string
  status: DeviceStatusFilter
  sgp: SgpFilter
  focus: DeviceFocusFilter
  page: number
}

export const NO_FILTERS: DeviceFilters = {
  search: '',
  status: 'all',
  sgp: 'all',
  focus: 'all',
  page: 1
}

export function statusFromQuery(raw: string | null | undefined): DeviceStatusFilter {
  return STATUS_FILTERS.includes(raw as DeviceStatusFilter) ? (raw as DeviceStatusFilter) : 'all'
}

export function sgpFromQuery(raw: string | null | undefined): SgpFilter {
  return SGP_FILTERS.includes(raw as SgpFilter) ? (raw as SgpFilter) : 'all'
}

export function focusFromQuery(raw: string | null | undefined): DeviceFocusFilter {
  return FOCUS_FILTERS.includes(raw as DeviceFocusFilter) ? (raw as DeviceFocusFilter) : 'all'
}

/**
 * A página, que só existe a partir de 1.
 *
 * `Number.parseInt` aceita `'12abc'` e `' 12'`, e `Number('')` é zero — três
 * jeitos de uma query mal colada virar uma requisição com página inválida. O
 * teste de inteiro depois da conversão recusa os três.
 */
export function pageFromQuery(raw: string | null | undefined): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(n) && n > 0 ? n : 1
}

/** O recorte inteiro, de uma query. */
export function filtersFromQuery(params: URLSearchParams): DeviceFilters {
  return {
    search: params.get('search') ?? '',
    status: statusFromQuery(params.get('status')),
    sgp: sgpFromQuery(params.get('sgp')),
    focus: focusFromQuery(params.get('focus')),
    page: pageFromQuery(params.get('page'))
  }
}

/**
 * A query de um recorte — e o default SOME dela.
 *
 * `/devices` é a lista inteira, então `status=all&sgp=all&page=1` não
 * acrescenta informação nenhuma: só faz o endereço ficar feio de mandar para
 * alguém. O que não é default aparece; o resto não.
 */
export function filtersToQuery(filters: DeviceFilters): URLSearchParams {
  const query = new URLSearchParams()
  if (filters.search) query.set('search', filters.search)
  if (filters.status !== 'all') query.set('status', filters.status)
  if (filters.sgp !== 'all') query.set('sgp', filters.sgp)
  if (filters.focus !== 'all') query.set('focus', filters.focus)
  if (filters.page > 1) query.set('page', String(filters.page))
  return query
}

/**
 * A query da planilha: o recorte que o SERVIDOR sabe aplicar — busca, estado
 * e foco. A página não entra (a planilha leva todas), e o filtro do ERP também
 * não: ele é feito na tela, sobre a página que chegou, e o servidor não o
 * conhece. Por isso `exportIgnoresSgp` existe — a tela avisa em vez de
 * entregar um arquivo com mais linhas do que a lista mostra.
 */
export function deviceExportQuery(filters: Pick<DeviceFilters, 'search' | 'status' | 'focus'>): URLSearchParams {
  const query = new URLSearchParams()
  const search = filters.search.trim()
  if (search) query.set('search', search)
  if (filters.status !== 'all') query.set('status', filters.status)
  if (filters.focus !== 'all') query.set('focus', filters.focus)
  return query
}

export function exportIgnoresSgp(filters: Pick<DeviceFilters, 'sgp'>): boolean {
  return filters.sgp !== 'all'
}
