import { haversineMeters } from '@/lib/kml-import'

/**
 * Quem está ligado a uma caixa (CTO/ODP, CEO/ODC…) e quantas portas sobram.
 *
 * "Ligado" é ter um cabo desenhado entre a caixa e o ponto do cliente (ONT).
 * A capacidade vem do campo da caixa; sem ele, do splitter ("1x16" → 16).
 * Os clientes próximos sem cabo nenhum entram numa lista à parte: são os que
 * provavelmente saem desta caixa e ainda não foram desenhados — ou os
 * candidatos a uma instalação nova.
 */
export interface OccupancyNode {
  node_id: string
  type: string
  name: string
  latitude: number
  longitude: number
  capacity?: number | null
  splitter?: string | null
  pppoe?: string | null
}

export interface OccupancyEdge {
  source: string
  target: string
}

export interface BoxOccupancy<T extends OccupancyNode = OccupancyNode> {
  capacity: number | null
  used: number
  free: number | null
  over: boolean
  clients: T[]
  nearby: { node: T; distance: number }[]
}

/** Raio da lista "clientes próximos sem cabo". */
export const NEARBY_METERS = 200
const CLIENT_TYPES = new Set(['ont'])
export const BOX_TYPES = new Set(['odp', 'odc', 'htb'])

export function capacityOf(node: Pick<OccupancyNode, 'capacity' | 'splitter'>): number | null {
  if (typeof node.capacity === 'number' && Number.isInteger(node.capacity) && node.capacity > 0) return node.capacity
  const match = String(node.splitter ?? '').match(/1\s*[x:/]\s*(\d{1,3})/i)
  const fromSplitter = match ? Number(match[1]) : NaN
  return Number.isInteger(fromSplitter) && fromSplitter > 0 ? fromSplitter : null
}

const isClient = (node: OccupancyNode) => CLIENT_TYPES.has(node.type)

export function boxOccupancy<T extends OccupancyNode>(box: OccupancyNode, nodes: T[], edges: OccupancyEdge[]): BoxOccupancy<T> {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const linked = new Set<string>()
  const clientsWithCable = new Set<string>()
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (!a || !b) continue
    if (isClient(a)) clientsWithCable.add(a.node_id)
    if (isClient(b)) clientsWithCable.add(b.node_id)
    if (edge.source === box.node_id && isClient(b)) linked.add(b.node_id)
    if (edge.target === box.node_id && isClient(a)) linked.add(a.node_id)
  }
  const clients = [...linked].map((id) => byId.get(id) as T).sort((x, y) => x.name.localeCompare(y.name))
  const capacity = capacityOf(box)
  const used = clients.length
  const nearby = nodes
    .filter((node) => isClient(node) && !clientsWithCable.has(node.node_id))
    .map((node) => ({ node, distance: Math.round(haversineMeters([box.latitude, box.longitude], [node.latitude, node.longitude])) }))
    .filter((entry) => entry.distance <= NEARBY_METERS)
    .sort((x, y) => x.distance - y.distance)
  return {
    capacity,
    used,
    free: capacity === null ? null : Math.max(capacity - used, 0),
    over: capacity !== null && used > capacity,
    clients,
    nearby
  }
}

export type OccupancyLevel = 'over' | 'full' | 'almost' | 'free' | 'unknown'

export interface BoxRow<T extends OccupancyNode = OccupancyNode> {
  box: T
  capacity: number | null
  used: number
  free: number | null
  percent: number | null
  level: OccupancyLevel
}

/** A partir de quanto uma caixa conta como "quase lotada". */
export const ALMOST_FULL = 0.85

export function levelOf(used: number, capacity: number | null): OccupancyLevel {
  if (capacity === null) return 'unknown'
  if (used > capacity) return 'over'
  if (used === capacity) return 'full'
  if (used / capacity >= ALMOST_FULL) return 'almost'
  return 'free'
}

/**
 * A ocupação de TODAS as caixas numa passada só pelos cabos — a lista de
 * ocupação tem milhares de caixas, e `boxOccupancy` caixa a caixa percorreria
 * o mapa inteiro para cada uma. Ordem: as mais cheias primeiro.
 */
export function allBoxOccupancy<T extends OccupancyNode>(nodes: T[], edges: OccupancyEdge[]): BoxRow<T>[] {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const clients = new Map<string, Set<string>>()
  const link = (box: T, client: T) => {
    if (!CLIENT_TYPES.has(client.type) || !BOX_TYPES.has(box.type)) return
    const set = clients.get(box.node_id) ?? new Set<string>()
    set.add(client.node_id)
    clients.set(box.node_id, set)
  }
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (!a || !b) continue
    link(a, b)
    link(b, a)
  }
  const rows = nodes.filter((node) => BOX_TYPES.has(node.type)).map((box) => {
    const capacity = capacityOf(box)
    const used = clients.get(box.node_id)?.size ?? 0
    return {
      box,
      capacity,
      used,
      free: capacity === null ? null : Math.max(capacity - used, 0),
      percent: capacity === null ? null : Math.round((used / capacity) * 100),
      level: levelOf(used, capacity)
    }
  })
  return rows.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || b.used - a.used || a.box.name.localeCompare(b.box.name))
}

const csvCell = (value: unknown) => {
  const text = String(value ?? '')
  // Célula que o Excel leria como fórmula sai neutralizada, como na planilha de equipamentos.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text) ? `'${text}` : text
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Planilha da ocupação: separador `;`, com BOM, que é o que o Excel em português abre direto. */
export function occupancyCsv(rows: BoxRow[], headers: string[], levelLabel: (level: OccupancyLevel) => string): string {
  const lines = [headers.map(csvCell).join(';')]
  for (const row of rows) {
    lines.push([
      row.box.node_id, row.box.name, row.box.type.toUpperCase(), row.used,
      row.capacity ?? '', row.free ?? '', row.percent === null ? '' : `${row.percent}%`, levelLabel(row.level),
      row.box.latitude, row.box.longitude
    ].map(csvCell).join(';'))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
