import { describe, expect, it } from 'vitest'
import { buildKml, escapeXml, kmlFileName, type ExportEdge, type ExportNode } from '@/lib/kml-export'
import { buildImportPlan, parseKml } from '@/lib/kml-import'

const nodes: ExportNode[] = [
  { node_id: 'olt-1', type: 'olt', name: 'OLT <Centro> & Cia', latitude: -4.27, longitude: -55.97, capacity: null, notes: 'Rack 1' },
  { node_id: 'cto-01', type: 'odp', name: 'CTO 01', latitude: -4.2761, longitude: -55.9836, capacity: 16, splitter: '1x16' },
  { node_id: 'cliente-a', type: 'ont', name: 'Maria', latitude: -4.2765, longitude: -55.984, pppoe: 'maria@vila' }
]
const edges: ExportEdge[] = [
  { edge_id: 'feeder-1', source: 'olt-1', target: 'cto-01', fiber_type: 'feeder', distance: 1500, waypoints: [[-4.272, -55.975], [-4.274, -55.98]] },
  { edge_id: 'drop-a', source: 'cto-01', target: 'cliente-a', fiber_type: 'drop', distance: 60, waypoints: null },
  { edge_id: 'orfao', source: 'cto-01', target: 'nao-existe', fiber_type: 'drop' }
]
const labels = { document: 'Rede Teste', nodeType: (type: string) => `T:${type}`, fiberType: (type: string) => `F:${type}` }
const options = (existing: ExportNode[] = []) => ({
  defaultType: 'htb' as const,
  fiberType: 'distribution' as const,
  existingNodes: existing,
  existingEdgeIds: [],
  endpointName: (name: string) => name
})

describe('buildKml', () => {
  it('escapa texto, separa em pastas e pula cabo sem ponta', () => {
    const kml = buildKml(nodes, edges, labels)
    expect(kml).toContain('OLT &lt;Centro&gt; &amp; Cia')
    expect(kml).toContain('<name>T:odp</name>')
    expect(kml).toContain('<name>F:drop</name>')
    expect(kml).not.toContain('orfao')
    expect(escapeXml(`a"b'c`)).toBe('a&quot;b&apos;c')
  })

  it('ida e volta: importar o exportado num mapa vazio reconstrói ids, tipos e ligações', () => {
    const parsed = parseKml(buildKml(nodes, edges, labels))
    const plan = buildImportPlan(parsed, options())
    expect(plan.nodes.map((n) => n.node_id).sort()).toEqual(['cliente-a', 'cto-01', 'olt-1'])
    expect(plan.nodes.find((n) => n.node_id === 'olt-1')).toMatchObject({ type: 'olt', name: 'OLT <Centro> & Cia', notes: 'Rack 1' })
    expect(plan.nodes.find((n) => n.node_id === 'cto-01')).toMatchObject({ type: 'odp', capacity: 16, splitter: '1x16' })
    expect(plan.nodes.find((n) => n.node_id === 'cliente-a')).toMatchObject({ type: 'ont', pppoe: 'maria@vila' })
    expect(plan.endpointNodes).toBe(0)
    expect(plan.edges.map((e) => [e.edge_id, e.source, e.target, e.fiber_type])).toEqual([
      ['feeder-1', 'olt-1', 'cto-01', 'feeder'],
      ['drop-a', 'cto-01', 'cliente-a', 'drop']
    ])
    expect(plan.edges[0].waypoints).toEqual([[-4.272, -55.975], [-4.274, -55.98]])
  })

  it('reimportar no mesmo mapa mantém os ids — o servidor pula o que já existe', () => {
    const plan = buildImportPlan(parseKml(buildKml(nodes, edges, labels)), options(nodes))
    expect(plan.nodes.map((n) => n.node_id).sort()).toEqual(['cliente-a', 'cto-01', 'olt-1'])
    expect(plan.edges.map((e) => e.edge_id)).toEqual(['feeder-1', 'drop-a'])
  })

  it('nome do arquivo', () => {
    expect(kmlFileName('fibra itaituba', new Date('2026-09-26T12:00:00Z'))).toBe('topologia-fibra-itaituba-2026-09-26.kml')
  })
})
