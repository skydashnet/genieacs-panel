/**
 * A Topologia como KML: abre no Google Earth, vai para a equipe de campo e
 * serve de cópia de segurança.
 *
 * Cada ponto e cada cabo levam o seu id em `ExtendedData` (e no atributo `id`
 * do Placemark). É o que a importação lê de volta: reimportar este arquivo
 * no mesmo mapa pula tudo o que já existe em vez de duplicar, e importá-lo num
 * mapa vazio reconstrói os mesmos ids e as mesmas ligações.
 */

export interface ExportNode {
  node_id: string
  type: string
  name: string
  latitude: number
  longitude: number
  capacity?: number | null
  splitter?: string | null
  pppoe?: string | null
  notes?: string | null
}

export interface ExportEdge {
  edge_id: string
  source: string
  target: string
  fiber_type: string
  distance?: number | null
  waypoints?: [number, number][] | null
  notes?: string | null
}

export interface ExportLabels {
  document: string
  nodeType: (type: string) => string
  fiberType: (type: string) => string
}

/** Cor de cada tipo de cabo, a mesma do mapa (#rrggbb). */
export const FIBER_COLORS: Record<string, string> = {
  backbone: '#8b5cf6',
  feeder: '#0ea5e9',
  distribution: '#22c55e',
  drop: '#f59e0b',
  patch: '#94a3b8'
}

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** KML guarda cor como aabbggrr. */
function kmlColor(hex: string): string {
  const clean = hex.replace('#', '')
  return `ff${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`
}

const coord = (lat: number, lng: number) => `${lng},${lat},0`

function extendedData(fields: Record<string, unknown>): string {
  const rows = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => `<Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>`)
  return rows.length ? `<ExtendedData>${rows.join('')}</ExtendedData>` : ''
}

export function buildKml(nodes: ExportNode[], edges: ExportEdge[], labels: ExportLabels): string {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const styles = Object.entries(FIBER_COLORS)
    .map(([type, color]) => `<Style id="fiber-${type}"><LineStyle><color>${kmlColor(color)}</color><width>${type === 'backbone' ? 5 : 3}</width></LineStyle></Style>`)
    .join('')

  const nodeTypes = [...new Set(nodes.map((node) => node.type))]
  const nodeFolders = nodeTypes.map((type) => {
    const placemarks = nodes.filter((node) => node.type === type).map((node) => (
      `<Placemark id="${escapeXml(node.node_id)}"><name>${escapeXml(node.name)}</name>`
      + (node.notes ? `<description>${escapeXml(node.notes)}</description>` : '')
      + extendedData({
        node_id: node.node_id, type: node.type, capacity: node.capacity, splitter: node.splitter, pppoe: node.pppoe
      })
      + `<Point><coordinates>${coord(node.latitude, node.longitude)}</coordinates></Point></Placemark>`
    ))
    return `<Folder><name>${escapeXml(labels.nodeType(type))}</name>${placemarks.join('')}</Folder>`
  })

  const fiberTypes = [...new Set(edges.map((edge) => edge.fiber_type))]
  const edgeFolders = fiberTypes.map((type) => {
    const placemarks = edges.filter((edge) => edge.fiber_type === type).flatMap((edge) => {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      // Cabo com uma ponta que não existe não tem traçado para desenhar.
      if (!source || !target) return []
      const points = [
        coord(source.latitude, source.longitude),
        ...(edge.waypoints ?? []).map(([lat, lng]) => coord(lat, lng)),
        coord(target.latitude, target.longitude)
      ]
      return [
        `<Placemark id="${escapeXml(edge.edge_id)}"><name>${escapeXml(edge.edge_id)}</name>`
        + (edge.notes ? `<description>${escapeXml(edge.notes)}</description>` : '')
        + `<styleUrl>#fiber-${escapeXml(type)}</styleUrl>`
        + extendedData({
          edge_id: edge.edge_id, source: edge.source, target: edge.target, fiber_type: edge.fiber_type, distance: edge.distance
        })
        + `<LineString><tessellate>1</tessellate><coordinates>${points.join(' ')}</coordinates></LineString></Placemark>`
      ]
    })
    return `<Folder><name>${escapeXml(labels.fiberType(type))}</name>${placemarks.join('')}</Folder>`
  })

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
    + `<name>${escapeXml(labels.document)}</name>${styles}`
    + nodeFolders.join('')
    + edgeFolders.join('')
    + '</Document></kml>\n'
}

/** O nome do arquivo: `topologia-<provedor>-AAAA-MM-DD.kml`. */
export function kmlFileName(slug: string | null | undefined, when: Date = new Date()): string {
  const who = (slug || 'rede').replace(/[^a-zA-Z0-9._-]/g, '-')
  return `topologia-${who}-${when.toISOString().slice(0, 10)}.kml`
}
