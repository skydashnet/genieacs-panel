/**
 * Importação de KML/KMZ para a Topologia, toda no navegador.
 *
 * O arquivo nunca vai inteiro ao servidor: aqui ele vira pontos e cabos no
 * formato de `/api/mapping-data/import`, e só isso é enviado, em lotes. KMZ é
 * um zip com o KML dentro — lido pelo diretório central e inflado com o
 * `DecompressionStream` do próprio navegador, sem biblioteca de zip.
 */

export type ImportNodeType = 'htb' | 'olt' | 'odc' | 'odp' | 'ont' | 'server'
export type ImportFiberType = 'backbone' | 'feeder' | 'distribution' | 'drop' | 'patch'

export interface KmlPoint {
  name: string
  description: string
  folders: string[]
  lat: number
  lng: number
  /** `ExtendedData` do Placemark — o painel escreve ali o id e o tipo ao exportar. */
  data?: Record<string, string>
}

export interface KmlLine {
  name: string
  description: string
  folders: string[]
  coords: [number, number][]
  data?: Record<string, string>
}

export interface ParsedKml {
  points: KmlPoint[]
  lines: KmlLine[]
  /** Placemarks sem geometria que se aproveite (polígono, coordenada quebrada). */
  ignored: number
}

export interface ImportNode {
  node_id: string
  type: ImportNodeType
  name: string
  latitude: number
  longitude: number
  notes: string | null
  capacity?: number | null
  splitter?: string | null
  pppoe?: string | null
}

export interface ImportEdge {
  edge_id: string
  source: string
  target: string
  fiber_type: ImportFiberType
  distance: number | null
  waypoints: [number, number][] | null
  notes: string | null
}

export interface ImportPlan {
  nodes: ImportNode[]
  edges: ImportEdge[]
  /** Pontos criados nas pontas de cabos que não encontraram ponto a 50 m. */
  endpointNodes: number
  /** Pontas de cabo ligadas a um ponto que já existia ou veio no arquivo. */
  snappedEnds: number
  /** Coordenadas fora do Brasil — importadas, mas vale conferir. */
  outsideBrazil: number
}

export interface ExistingNode {
  node_id: string
  latitude: number
  longitude: number
}

export interface BuildOptions {
  defaultType: ImportNodeType
  fiberType: ImportFiberType
  existingNodes: ExistingNode[]
  existingEdgeIds: string[]
  /** Nome dos pontos criados nas pontas: recebe o nome do cabo e qual ponta. */
  endpointName: (lineName: string, end: 'start' | 'end') => string
}

/** Raio em que a ponta de um cabo "encosta" num ponto. */
export const SNAP_METERS = 50
/** O validador do servidor aceita até 100 pontos de rota por cabo. */
export const MAX_WAYPOINTS = 100

// ── Leitura do arquivo ────────────────────────────────────────────────────

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('kmz_unsupported')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * O KML de dentro de um KMZ: `doc.kml` se houver, senão o primeiro `.kml`.
 * Lança `kmz_invalid` quando o zip não se lê, `kmz_no_kml` quando não há KML.
 */
export async function extractKmlFromKmz(bytes: Uint8Array): Promise<string> {
  // O fim do diretório central fica nos últimos 22 bytes, mais um comentário
  // de até 64 KiB; procura-se a assinatura de trás para frente.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('kmz_invalid')
  const count = u16(bytes, eocd + 10)
  let offset = u32(bytes, eocd + 16)
  const entries: { name: string; method: number; size: number; local: number }[] = []
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i += 1) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error('kmz_invalid')
    const method = u16(bytes, offset + 10)
    const size = u32(bytes, offset + 20)
    const nameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    const local = u32(bytes, offset + 42)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    entries.push({ name, method, size, local })
    offset += 46 + nameLength + extraLength + commentLength
  }
  const kmls = entries.filter((entry) => entry.name.toLowerCase().endsWith('.kml'))
  const entry = kmls.find((item) => item.name.toLowerCase() === 'doc.kml') ?? kmls[0]
  if (!entry) throw new Error('kmz_no_kml')
  if (u32(bytes, entry.local) !== 0x04034b50) throw new Error('kmz_invalid')
  const start = entry.local + 30 + u16(bytes, entry.local + 26) + u16(bytes, entry.local + 28)
  const data = bytes.subarray(start, start + entry.size)
  if (entry.method === 0) return decoder.decode(data)
  if (entry.method === 8) return decoder.decode(await inflateRaw(data))
  throw new Error('kmz_invalid')
}

/** O texto KML de um arquivo `.kml` ou `.kmz` (reconhecido também pelo "PK" do zip). */
export async function readKmlFile(file: Blob & { name?: string }): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (isZip || file.name?.toLowerCase().endsWith('.kmz')) return extractKmlFromKmz(bytes)
  return new TextDecoder().decode(bytes)
}

// ── KML → pontos e linhas ────────────────────────────────────────────────

/**
 * Uma árvore XML mínima. Não é o `DOMParser` de propósito: o mesmo código roda
 * nos testes (Node, sem DOM) e no navegador, e o KML que interessa — pastas,
 * placemarks, nomes, coordenadas — não precisa de mais que isto.
 */
interface XmlNode {
  name: string
  attrs: Record<string, string>
  parent: XmlNode | null
  children: XmlNode[]
  text: string
}

const localName = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1)

function parseAttrs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!raw) return attrs
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let m = pattern.exec(raw); m; m = pattern.exec(raw)) attrs[localName(m[1])] = decodeEntities(m[2] ?? m[3] ?? '')
  return attrs
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match
    }
    return ENTITIES[code.toLowerCase()] ?? match
  })
}

function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, parent: null, children: [], text: '' }
  let current = root
  let elements = 0
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)(\s+[^>]*?)?(\/?)>|([^<]+)|(<)/gi
  for (let m = token.exec(text); m; m = token.exec(text)) {
    const [, cdata, close, open, rawAttrs, selfClose, chars, stray] = m
    if (stray) throw new Error('kml_invalid')
    if (cdata !== undefined) current.text += cdata
    else if (chars !== undefined) current.text += decodeEntities(chars)
    else if (open) {
      elements += 1
      const node: XmlNode = { name: localName(open), attrs: parseAttrs(rawAttrs), parent: current, children: [], text: '' }
      current.children.push(node)
      if (!selfClose) current = node
    } else if (close) {
      // Fecha até o elemento com esse nome; um fechamento sem par é ignorado.
      const name = localName(close)
      for (let node: XmlNode | null = current; node && node !== root; node = node.parent) {
        if (node.name === name) { current = node.parent ?? root; break }
      }
    }
  }
  if (!elements) throw new Error('kml_invalid')
  return root
}

function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child)
    descendants(child, name, out)
  }
  return out
}

function textOf(node: XmlNode | undefined): string {
  if (!node) return ''
  return (node.text + node.children.map((child) => textOf(child)).join(' ')).replace(/\s+/g, ' ').trim()
}

const childText = (node: XmlNode, name: string) => textOf(node.children.find((child) => child.name === name))

function parseCoordinates(raw: string | null | undefined): [number, number][] {
  const coords: [number, number][] = []
  for (const tuple of String(raw ?? '').trim().split(/\s+/)) {
    if (!tuple) continue
    const [lng, lat] = tuple.split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    coords.push([lat, lng])
  }
  return coords
}

/** Texto limpo de HTML: a descrição do Google Earth costuma vir em tabela. */
function plainText(value: string): string {
  if (!value.includes('<')) return value
  return decodeEntities(value.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Lança `kml_invalid` quando o texto não é um KML legível. */
export function parseKml(text: string): ParsedKml {
  const doc = parseXml(text)
  const placemarks = descendants(doc, 'Placemark')
  if (!placemarks.length && !descendants(doc, 'kml').length) throw new Error('kml_invalid')
  const result: ParsedKml = { points: [], lines: [], ignored: 0 }

  for (const placemark of placemarks) {
    const name = childText(placemark, 'name').slice(0, 255)
    const description = plainText(childText(placemark, 'description'))
    const folders: string[] = []
    for (let parent = placemark.parent; parent; parent = parent.parent) {
      if (parent.name === 'Folder' || parent.name === 'Document') {
        const folderName = childText(parent, 'name')
        if (folderName) folders.unshift(folderName)
      }
    }
    const data: Record<string, string> = {}
    for (const field of descendants(placemark, 'Data')) {
      if (field.attrs.name) data[field.attrs.name] = childText(field, 'value')
    }
    for (const field of descendants(placemark, 'SimpleData')) {
      if (field.attrs.name) data[field.attrs.name] = textOf(field)
    }
    let used = false
    for (const point of descendants(placemark, 'Point')) {
      const [coord] = parseCoordinates(textOf(descendants(point, 'coordinates')[0]))
      if (!coord) continue
      result.points.push({ name, description, folders, lat: coord[0], lng: coord[1], data })
      used = true
    }
    for (const line of descendants(placemark, 'LineString')) {
      const coords = parseCoordinates(textOf(descendants(line, 'coordinates')[0]))
      if (coords.length < 2) continue
      result.lines.push({ name, description, folders, coords, data })
      used = true
    }
    if (!used) result.ignored += 1
  }
  return result
}

// ── Pontos e linhas → o que o servidor grava ──────────────────────────────

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLng = (b[1] - a[1]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** O comprimento de um traçado, em metros. */
export function pathLength(coords: [number, number][]): number {
  let total = 0
  for (let i = 1; i < coords.length; i += 1) total += haversineMeters(coords[i - 1], coords[i])
  return total
}

/**
 * No máximo `max` pontos, amostrados por igual e sempre com o primeiro e o
 * último — o suficiente para o desenho do cabo; o comprimento é calculado
 * antes, sobre o traçado inteiro.
 */
export function simplifyWaypoints(points: [number, number][], max = MAX_WAYPOINTS): [number, number][] {
  if (points.length <= max) return points
  if (max < 2) return points.slice(0, max)
  const out: [number, number][] = []
  for (let i = 0; i < max; i += 1) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))])
  return out
}

/** Um id que o servidor aceita (`[A-Za-z0-9._:-]`, até 128), a partir de um nome. */
export function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.:]+|[-.:]+$/g, '')
    .slice(0, 100)
  return slug || fallback
}

export function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** O tipo de ponto que o nome (ou a pasta) sugere; senão, o padrão escolhido. */
export function guessNodeType(texts: string[], fallback: ImportNodeType): ImportNodeType {
  const text = texts.join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (/\bolt\b/.test(text)) return 'olt'
  if (/\b(ceo|odc|emenda|caixa de emenda)\b/.test(text)) return 'odc'
  if (/\b(cto|odp|nap|caixa)\b/.test(text)) return 'odp'
  if (/\b(ont|onu|cliente)\b/.test(text)) return 'ont'
  if (/\b(pop|servidor|server|datacenter)\b/.test(text)) return 'server'
  if (/\bhtb\b/.test(text)) return 'htb'
  return fallback
}

/** O tipo de cabo que o nome (ou a pasta) sugere; senão, o padrão escolhido. */
export function guessFiberType(texts: string[], fallback: ImportFiberType): ImportFiberType {
  const text = texts.join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (/\b(drop|cliente)\b/.test(text)) return 'drop'
  if (/\b(backbone|tronco)\b/.test(text)) return 'backbone'
  if (/\b(feeder|alimentacao|alimentador)\b/.test(text)) return 'feeder'
  if (/\b(patch|cordao)\b/.test(text)) return 'patch'
  if (/\b(distribuicao|distribution)\b/.test(text)) return 'distribution'
  return fallback
}

const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/
const NODE_TYPE_SET = new Set<string>(['htb', 'olt', 'odc', 'odp', 'ont', 'server'])
const FIBER_TYPE_SET = new Set<string>(['backbone', 'feeder', 'distribution', 'drop', 'patch'])

const insideBrazil = (lat: number, lng: number) => lat >= -34 && lat <= 6 && lng >= -74.5 && lng <= -28

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

export function buildImportPlan(parsed: ParsedKml, options: BuildOptions): ImportPlan {
  const nodeIds = new Set(options.existingNodes.map((node) => node.node_id))
  const edgeIds = new Set(options.existingEdgeIds)
  const nodes: ImportNode[] = []
  const edges: ImportEdge[] = []
  const snapTargets: ExistingNode[] = [...options.existingNodes]
  let endpointNodes = 0
  let snappedEnds = 0
  let outsideBrazil = 0

  // Ids que vieram no arquivo (exportado pelo painel). Um id que já está no
  // mapa é mantido de propósito: o servidor pula o que existe, e é isso que
  // faz reimportar o mesmo arquivo não duplicar nada.
  const fileNodeIds = new Set<string>()
  const fileEdgeIds = new Set<string>()
  const takeId = (wanted: string | undefined, fromFile: Set<string>, all: Set<string>) => {
    if (!wanted || !VALID_ID.test(wanted) || fromFile.has(wanted)) return null
    fromFile.add(wanted)
    all.add(wanted)
    return wanted
  }

  const addNode = (
    name: string, lat: number, lng: number, type: ImportNodeType, notes: string | null,
    extra: Partial<Pick<ImportNode, 'capacity' | 'splitter' | 'pppoe'>> & { id?: string } = {}
  ) => {
    if (!insideBrazil(lat, lng)) outsideBrazil += 1
    const { id, ...fields } = extra
    const node: ImportNode = {
      node_id: takeId(id, fileNodeIds, nodeIds) ?? uniqueId(slugify(name, 'ponto'), nodeIds),
      type,
      name: (name || 'Ponto').slice(0, 255),
      latitude: round6(lat),
      longitude: round6(lng),
      notes: notes ? notes.slice(0, 5000) : null,
      ...fields
    }
    nodes.push(node)
    snapTargets.push(node)
    return node
  }

  parsed.points.forEach((point, index) => {
    const name = point.name || `Ponto ${index + 1}`
    const data = point.data ?? {}
    const type = NODE_TYPE_SET.has(data.type) ? data.type as ImportNodeType : guessNodeType([point.name, ...point.folders], options.defaultType)
    const capacity = Number.parseInt(data.capacity ?? '', 10)
    addNode(name, point.lat, point.lng, type, point.description || null, {
      id: data.node_id,
      capacity: Number.isInteger(capacity) && capacity >= 0 ? capacity : null,
      splitter: data.splitter ? data.splitter.slice(0, 64) : null,
      pppoe: data.pppoe ? data.pppoe.slice(0, 255) : null
    })
  })

  const nearest = (coord: [number, number], exclude?: string) => {
    let best: ExistingNode | null = null
    let bestDistance = SNAP_METERS
    for (const candidate of snapTargets) {
      if (candidate.node_id === exclude) continue
      const distance = haversineMeters(coord, [candidate.latitude, candidate.longitude])
      if (distance <= bestDistance) { best = candidate; bestDistance = distance }
    }
    return best
  }

  parsed.lines.forEach((line, index) => {
    const lineName = line.name || `Cabo ${index + 1}`
    const first = line.coords[0]
    const last = line.coords[line.coords.length - 1]
    const endpoint = (coord: [number, number], end: 'start' | 'end', exclude?: string) => {
      const found = nearest(coord, exclude)
      if (found) { snappedEnds += 1; return found.node_id }
      endpointNodes += 1
      return addNode(options.endpointName(lineName, end), coord[0], coord[1], options.defaultType, null).node_id
    }
    const data = line.data ?? {}
    // As pontas nomeadas no arquivo valem quando o ponto existe (no mapa ou
    // no arquivo); senão, a ponta procura o ponto mais próximo, como sempre.
    const named = (id: string | undefined) => (id && nodeIds.has(id) ? id : null)
    const source = named(data.source) ?? endpoint(first, 'start')
    // Cabo fechado (volta ao mesmo ponto) não pode ligar um ponto a ele mesmo.
    const namedTarget = named(data.target)
    const target = namedTarget && namedTarget !== source ? namedTarget : endpoint(last, 'end', source)
    const length = Math.round(pathLength(line.coords))
    const middle = line.coords.slice(1, -1).map(([lat, lng]) => [round6(lat), round6(lng)] as [number, number])
    edges.push({
      edge_id: takeId(data.edge_id, fileEdgeIds, edgeIds) ?? uniqueId(slugify(lineName, 'cabo'), edgeIds),
      source,
      target,
      fiber_type: FIBER_TYPE_SET.has(data.fiber_type) ? data.fiber_type as ImportFiberType : guessFiberType([line.name, ...line.folders], options.fiberType),
      distance: length > 0 && length <= 1_000_000 ? length : null,
      waypoints: middle.length ? simplifyWaypoints(middle) : null,
      notes: line.description ? line.description.slice(0, 5000) : null
    })
  })

  return { nodes, edges, endpointNodes, snappedEnds, outsideBrazil }
}

/**
 * Lotes que cabem no limite do servidor (2.000 pontos, 4.000 cabos e ~1 MB de
 * JSON por chamada): primeiro todos os pontos, depois os cabos, para que cada
 * cabo encontre os seus pontos já gravados.
 */
export function chunkImportPlan(plan: Pick<ImportPlan, 'nodes' | 'edges'>, maxBytes = 700_000) {
  const batches: { nodes: ImportNode[]; edges: ImportEdge[] }[] = []
  const pack = <T>(items: T[], maxCount: number, wrap: (list: T[]) => { nodes: ImportNode[]; edges: ImportEdge[] }) => {
    let current: T[] = []
    let bytes = 0
    for (const item of items) {
      const size = JSON.stringify(item).length + 1
      if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) {
        batches.push(wrap(current))
        current = []
        bytes = 0
      }
      current.push(item)
      bytes += size
    }
    if (current.length) batches.push(wrap(current))
  }
  pack(plan.nodes, 2_000, (list) => ({ nodes: list, edges: [] }))
  pack(plan.edges, 4_000, (list) => ({ nodes: [], edges: list }))
  return batches
}
