import { allBoxOccupancy, BOX_TYPES, type BoxRow, type OccupancyEdge, type OccupancyNode } from './box-occupancy'
import { haversineMeters } from './kml-import'
import type { LiveItem } from './map-status'

/**
 * "Qual caixa atende este cliente": a CTO mais próxima com porta livre, para
 * sugerir no "Colocar no mapa", ligar os clientes sem cabo de uma vez e
 * responder a consulta de viabilidade; e as caixas onde vários clientes estão
 * com sinal fraco.
 *
 * A distância é em linha reta: o cabo de verdade passa pelos postes e sai
 * mais longo. Por isso os limites são escolhidos na tela, com folga.
 */

/** Os limites de distância oferecidos na tela, em metros. */
export const DROP_LIMITS = [100, 200, 300, 500] as const
export const LINK_DEFAULT_METERS = 200
export const FEASIBILITY_DEFAULT_METERS = 300
/** Raio da sugestão de caixa no "Colocar no mapa". */
export const SUGGEST_METERS = 300

export interface Point { lat: number; lng: number }

export interface NearBox<T extends OccupancyNode = OccupancyNode> {
  box: T
  distance: number
  /** Portas livres; `null` quando a caixa não tem capacidade cadastrada. */
  free: number | null
  capacity: number | null
}

const CLIENT_TYPES = new Set(['ont'])

const distanceTo = (point: Point, node: OccupancyNode) =>
  Math.round(haversineMeters([point.lat, point.lng], [node.latitude, node.longitude]))

/**
 * As caixas com porta livre (ou sem capacidade cadastrada) até `maxMeters`
 * do ponto, da mais perto para a mais longe.
 */
export function nearestBoxes<T extends OccupancyNode>(
  point: Point,
  rows: BoxRow<T>[],
  { maxMeters = Infinity, limit = Infinity }: { maxMeters?: number; limit?: number } = {}
): NearBox<T>[] {
  return rows
    .filter((row) => row.free === null || row.free > 0)
    .map((row) => ({ box: row.box, distance: distanceTo(point, row.box), free: row.free, capacity: row.capacity }))
    .filter((entry) => entry.distance <= maxMeters)
    .sort((a, b) => a.distance - b.distance || a.box.name.localeCompare(b.box.name))
    .slice(0, limit)
}

export interface BulkLink<T extends OccupancyNode = OccupancyNode> {
  client: T
  box: T
  distance: number
  /** A caixa não tem capacidade cadastrada: não há como saber se cabe. */
  unknownCapacity: boolean
}

/**
 * Liga cada cliente (ONT) sem cabo nenhum à caixa livre mais próxima dentro
 * do raio. Guloso pelo mais perto: quem está mais colado numa caixa fica com
 * ela, e cada ligação gasta uma porta, para nenhuma CTO passar da capacidade.
 */
export function planBulkLinks<T extends OccupancyNode>(
  nodes: T[],
  edges: OccupancyEdge[],
  { maxMeters }: { maxMeters: number }
): { links: BulkLink<T>[]; unreachable: T[] } {
  const ids = new Set(nodes.map((node) => node.node_id))
  const withCable = new Set<string>()
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    withCable.add(edge.source)
    withCable.add(edge.target)
  }
  const clients = nodes.filter((node) => CLIENT_TYPES.has(node.type) && !withCable.has(node.node_id))
  const rows = allBoxOccupancy(nodes, edges)
  const free = new Map(rows.map((row) => [row.box.node_id, row.free]))

  // Todas as combinações cliente–caixa dentro do raio, da mais curta à mais longa.
  const pairs: { client: T; box: T; distance: number }[] = []
  for (const client of clients) {
    for (const row of rows) {
      if (row.free !== null && row.free <= 0) continue
      const distance = distanceTo({ lat: client.latitude, lng: client.longitude }, row.box)
      if (distance <= maxMeters) pairs.push({ client, box: row.box, distance })
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || a.client.name.localeCompare(b.client.name))

  const linked = new Set<string>()
  const links: BulkLink<T>[] = []
  for (const pair of pairs) {
    if (linked.has(pair.client.node_id)) continue
    const left = free.get(pair.box.node_id) ?? null
    if (left !== null && left <= 0) continue
    if (left !== null) free.set(pair.box.node_id, left - 1)
    linked.add(pair.client.node_id)
    links.push({ ...pair, unknownCapacity: left === null })
  }
  links.sort((a, b) => a.box.name.localeCompare(b.box.name) || a.distance - b.distance)
  return { links, unreachable: clients.filter((client) => !linked.has(client.node_id)) }
}

export type FeasibilityVerdict = 'viable' | 'tooFar' | 'noBox'

/** Dá para atender neste ponto? As 3 caixas livres mais próximas e o veredito. */
export function feasibility<T extends OccupancyNode>(point: Point, rows: BoxRow<T>[], maxMeters: number): {
  verdict: FeasibilityVerdict
  boxes: NearBox<T>[]
} {
  const boxes = nearestBoxes(point, rows, { limit: 3 })
  if (!boxes.length) return { verdict: 'noBox', boxes }
  return { verdict: boxes[0].distance <= maxMeters ? 'viable' : 'tooFar', boxes }
}

/** Uma caixa entra na lista de sinal fraco com pelo menos tantos clientes fracos… */
export const WEAK_MIN = 2
/** …e esta parte dos clientes online com sinal medido. */
export const WEAK_SHARE = 0.3

export interface WeakBox<T extends OccupancyNode = OccupancyNode> {
  box: T
  weak: number
  /** Clientes ligados à caixa que estão online e com RX medido. */
  measured: number
  total: number
  averageRx: number | null
}

/**
 * As caixas onde vários clientes estão com sinal fraco ao mesmo tempo. Um
 * cliente fraco sozinho costuma ser a casa dele (conector, cabo dobrado); a
 * maioria fraca na mesma caixa aponta para a caixa: conector sujo, splitter,
 * fibra forçada perto dela.
 */
export function weakBoxes<T extends OccupancyNode>(nodes: T[], edges: OccupancyEdge[], live: Map<string, LiveItem>): WeakBox<T>[] {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const clientsOf = new Map<string, Set<string>>()
  const link = (box: T | undefined, client: T | undefined) => {
    if (!box || !client || !BOX_TYPES.has(box.type) || !CLIENT_TYPES.has(client.type)) return
    const set = clientsOf.get(box.node_id) ?? new Set<string>()
    set.add(client.node_id)
    clientsOf.set(box.node_id, set)
  }
  for (const edge of edges) {
    link(byId.get(edge.source), byId.get(edge.target))
    link(byId.get(edge.target), byId.get(edge.source))
  }
  const result: WeakBox<T>[] = []
  for (const [boxId, clients] of clientsOf) {
    let weak = 0
    let measured = 0
    let sum = 0
    for (const id of clients) {
      const item = live.get(id)
      if (!item || (item.state !== 'online' && item.state !== 'weak') || item.rxPower === null) continue
      measured += 1
      sum += item.rxPower
      if (item.state === 'weak') weak += 1
    }
    if (weak < WEAK_MIN || weak < measured * WEAK_SHARE) continue
    result.push({
      box: byId.get(boxId) as T,
      weak,
      measured,
      total: clients.size,
      averageRx: measured ? Math.round((sum / measured) * 10) / 10 : null
    })
  }
  return result.sort((a, b) => b.weak - a.weak || (a.averageRx ?? 0) - (b.averageRx ?? 0) || a.box.name.localeCompare(b.box.name))
}

