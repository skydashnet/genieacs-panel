import { describe, expect, it } from 'vitest'
import { buildBulkNodes, chunk, selectedByDefault, type BulkCandidate } from '../src/lib/bulk-place'

const cliente = (pppoe: string, extra: Partial<BulkCandidate> = {}): BulkCandidate => ({
  pppoe, deviceId: null, clientName: null, address: null, lat: -4.27, lng: -55.98, precision: 'sgp', ...extra
})
const note = (precision: string) => (precision === 'sgp' ? null : 'conferir')

describe('buildBulkNodes', () => {
  it('ONT com o PPPoE, o nome do cliente e as coordenadas', () => {
    const [node] = buildBulkNodes([cliente('ana@vila', { clientName: 'Ana Souza' })], [], note)
    expect(node).toEqual({ node_id: 'ana-vila', type: 'ont', name: 'Ana Souza', latitude: -4.27, longitude: -55.98, pppoe: 'ana@vila' })
  })

  it('sem nome, o PPPoE; ids únicos contra o mapa e dentro do lote', () => {
    const nodes = buildBulkNodes([cliente('Ana@Vila'), cliente('ana vila'), cliente('bia@vila')], ['ana-vila'], note)
    expect(nodes.map((node) => node.node_id)).toEqual(['ana-vila-2', 'ana-vila-3', 'bia-vila'])
    expect(nodes[0].name).toBe('Ana@Vila')
  })

  it('só quem não veio das coordenadas do SGP leva a nota de conferir', () => {
    const nodes = buildBulkNodes([cliente('a'), cliente('b', { precision: 'address' }), cliente('c', { precision: 'city' })], [], note)
    expect(nodes.map((node) => node.notes)).toEqual([undefined, 'conferir', 'conferir'])
  })
})

describe('selectedByDefault e chunk', () => {
  it('só a cidade entra desmarcado', () => {
    expect(selectedByDefault({ precision: 'sgp' })).toBe(true)
    expect(selectedByDefault({ precision: 'address' })).toBe(true)
    expect(selectedByDefault({ precision: 'city' })).toBe(false)
  })

  it('lotes de 500', () => {
    const batches = chunk(Array.from({ length: 1201 }, (_, i) => i))
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201])
    expect(chunk([])).toEqual([])
  })
})
