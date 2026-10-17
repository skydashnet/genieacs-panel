import { describe, expect, it } from 'vitest'
import {
  buildImportPlan, chunkImportPlan, extractKmlFromKmz, guessNodeType, haversineMeters,
  parseKml, readKmlFile, simplifyWaypoints, slugify, type BuildOptions
} from '@/lib/kml-import'

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Rede Itaituba</name>
    <Folder>
      <name>CTOs</name>
      <Placemark>
        <name>Caixa &amp; Centro 01</name>
        <description><![CDATA[<b>Porta</b> 8<br/>Splitter 1x8]]></description>
        <Point><coordinates>-55.9836,-4.2761,0</coordinates></Point>
      </Placemark>
      <Placemark>
        <name>Caixa &amp; Centro 01</name>
        <Point><coordinates>-55.9900,-4.2800</coordinates></Point>
      </Placemark>
    </Folder>
    <Placemark>
      <name>OLT Principal</name>
      <Point><coordinates>-55.9700,-4.2700</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Cabo Drop Rua A</name>
      <LineString>
        <coordinates>
          -55.98362,-4.27612,0 -55.9850,-4.2780,0 -55.9870,-4.2790,0 -55.9950,-4.2850,0
        </coordinates>
      </LineString>
    </Placemark>
    <Placemark>
      <name>Área de cobertura</name>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,1 1,0 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
  </Document>
</kml>`

const options = (extra: Partial<BuildOptions> = {}): BuildOptions => ({
  defaultType: 'htb',
  fiberType: 'distribution',
  existingNodes: [],
  existingEdgeIds: [],
  endpointName: (name, end) => `${name} (${end === 'start' ? 'início' : 'fim'})`,
  ...extra
})

/** Um zip mínimo com uma entrada, guardada (0) ou comprimida (8). */
async function zip(name: string, content: string, method: 0 | 8): Promise<Uint8Array> {
  const raw = new TextEncoder().encode(content)
  const data = method === 0
    ? raw
    : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
  const nameBytes = new TextEncoder().encode(name)
  const local = new Uint8Array(30 + nameBytes.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, method, true)
  lv.setUint32(18, data.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30)
  const central = new Uint8Array(46 + nameBytes.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, method, true)
  cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nameBytes.length, true)
  cv.setUint32(42, 0, true)
  central.set(nameBytes, 46)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + data.length, true)
  const out = new Uint8Array(local.length + data.length + central.length + end.length)
  out.set(local, 0); out.set(data, local.length); out.set(central, local.length + data.length)
  out.set(end, local.length + data.length + central.length)
  return out
}

describe('parseKml', () => {
  it('lê pontos, linhas, pastas e descrição; ignora polígono', () => {
    const parsed = parseKml(KML)
    expect(parsed.points).toHaveLength(3)
    expect(parsed.points[0]).toMatchObject({ name: 'Caixa & Centro 01', lat: -4.2761, lng: -55.9836 })
    expect(parsed.points[0].folders).toEqual(['Rede Itaituba', 'CTOs'])
    expect(parsed.points[0].description).toBe('Porta 8 Splitter 1x8')
    expect(parsed.lines).toHaveLength(1)
    expect(parsed.lines[0].coords).toHaveLength(4)
    expect(parsed.ignored).toBe(1)
  })

  it('texto que não é KML é recusado', () => {
    expect(() => parseKml('isto não é xml')).toThrow('kml_invalid')
    expect(() => parseKml('<html><body>oi</body></html>')).toThrow('kml_invalid')
  })
})

describe('buildImportPlan', () => {
  it('ids únicos, tipo pelo nome/pasta, e ponta de cabo ligada ao ponto a menos de 50 m', () => {
    const plan = buildImportPlan(parseKml(KML), options({ existingNodes: [{ node_id: 'caixa-centro-01', latitude: 0, longitude: 0 }] }))
    expect(plan.nodes.slice(0, 3).map((n) => n.node_id)).toEqual(['caixa-centro-01-2', 'caixa-centro-01-3', 'olt-principal'])
    expect(plan.nodes[0].type).toBe('odp')
    expect(plan.nodes[2].type).toBe('olt')
    // O início do cabo está a ~3 m da primeira caixa; o fim não tem ninguém a 50 m.
    const [edge] = plan.edges
    expect(edge.source).toBe('caixa-centro-01-2')
    expect(plan.snappedEnds).toBe(1)
    expect(plan.endpointNodes).toBe(1)
    expect(plan.nodes[3]).toMatchObject({ name: 'Cabo Drop Rua A (fim)', type: 'htb' })
    expect(edge.target).toBe(plan.nodes[3].node_id)
    expect(edge.fiber_type).toBe('drop')
    expect(edge.waypoints).toHaveLength(2)
    expect(edge.distance).toBeGreaterThan(1300)
    expect(edge.distance).toBeLessThan(1700)
  })

  it('cabo fechado não liga um ponto a ele mesmo', () => {
    const parsed = { points: [], lines: [{ name: 'Anel', description: '', folders: [], coords: [[-4.27, -55.98], [-4.28, -55.99], [-4.27, -55.98]] as [number, number][] }], ignored: 0 }
    const plan = buildImportPlan(parsed, options())
    expect(plan.edges[0].source).not.toBe(plan.edges[0].target)
  })
})

describe('auxiliares', () => {
  it('slug aceito pelo servidor, com fallback', () => {
    expect(slugify('Caixa Ção / 02', 'x')).toBe('caixa-cao-02')
    expect(slugify('***', 'ponto')).toBe('ponto')
    expect(slugify('a'.repeat(300), 'x')).toHaveLength(100)
  })

  it('simplifica para no máximo 100 pontos mantendo as pontas', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => [i, i] as [number, number])
    const out = simplifyWaypoints(pts)
    expect(out).toHaveLength(100)
    expect(out[0]).toEqual([0, 0])
    expect(out[99]).toEqual([999, 999])
  })

  it('haversine e palpite de tipo', () => {
    expect(Math.round(haversineMeters([0, 0], [0, 1]))).toBe(111195)
    expect(guessNodeType(['CEO 3'], 'odp')).toBe('odc')
    expect(guessNodeType(['Poste'], 'htb')).toBe('htb')
  })

  it('lotes: pontos antes dos cabos, e nenhum lote passa do tamanho', () => {
    const plan = buildImportPlan(parseKml(KML), options())
    const batches = chunkImportPlan(plan, 300)
    expect(batches.length).toBeGreaterThan(1)
    const firstEdge = batches.findIndex((b) => b.edges.length)
    expect(batches.slice(firstEdge).every((b) => !b.nodes.length)).toBe(true)
    expect(batches.flatMap((b) => b.nodes)).toHaveLength(plan.nodes.length)
  })
})

describe('KMZ', () => {
  it('lê entrada guardada e comprimida, pelo doc.kml', async () => {
    for (const method of [0, 8] as const) {
      const bytes = await zip('doc.kml', KML, method)
      expect(parseKml(await extractKmlFromKmz(bytes)).points).toHaveLength(3)
      const file = Object.assign(new Blob([bytes as BlobPart]), { name: 'rede.kmz' })
      expect(parseKml(await readKmlFile(file)).lines).toHaveLength(1)
    }
  })

  it('zip sem KML e bytes quebrados são recusados', async () => {
    await expect(extractKmlFromKmz(await zip('foto.png', 'x', 0))).rejects.toThrow('kmz_no_kml')
    await expect(extractKmlFromKmz(new Uint8Array([1, 2, 3]))).rejects.toThrow('kmz_invalid')
  })
})
