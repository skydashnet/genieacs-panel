import { describe, expect, it } from 'vitest'
import { allBoxOccupancy, boxOccupancy, capacityOf, levelOf, occupancyCsv, type OccupancyNode } from '@/lib/box-occupancy'

const cto: OccupancyNode = { node_id: 'cto-1', type: 'odp', name: 'CTO 1', latitude: -4.27, longitude: -55.98, capacity: 4 }
const ont = (node_id: string, dLat: number, name = node_id): OccupancyNode => ({ node_id, type: 'ont', name, latitude: -4.27 + dLat, longitude: -55.98 })

describe('capacityOf', () => {
  it('campo de capacidade, senão o splitter', () => {
    expect(capacityOf({ capacity: 16 })).toBe(16)
    expect(capacityOf({ capacity: null, splitter: '1x8' })).toBe(8)
    expect(capacityOf({ capacity: null, splitter: '1:16' })).toBe(16)
    expect(capacityOf({ capacity: null, splitter: '' })).toBeNull()
    expect(capacityOf({ capacity: 0, splitter: null })).toBeNull()
  })
})

describe('boxOccupancy', () => {
  const nodes = [cto, ont('b', 0.0002, 'Bia'), ont('a', 0.0003, 'Ana'), ont('longe', 0.01), ont('perto-sem-cabo', 0.0005), ont('de-outra', 0.0004),
    { node_id: 'cto-2', type: 'odp', name: 'CTO 2', latitude: -4.2704, longitude: -55.98 }]
  const edges = [
    { source: 'cto-1', target: 'a' },
    { source: 'b', target: 'cto-1' },
    { source: 'cto-2', target: 'de-outra' },
    { source: 'cto-1', target: 'cto-2' },
    { source: 'cto-1', target: 'nao-existe' }
  ]

  it('conta clientes ligados por cabo, nos dois sentidos, e as portas livres', () => {
    const result = boxOccupancy(cto, nodes, edges)
    expect(result.clients.map((c) => c.name)).toEqual(['Ana', 'Bia'])
    expect(result).toMatchObject({ capacity: 4, used: 2, free: 2, over: false })
  })

  it('próximos sem cabo: só ONT sem cabo nenhum, até 200 m, do mais perto', () => {
    const result = boxOccupancy(cto, nodes, edges)
    expect(result.nearby.map((entry) => entry.node.node_id)).toEqual(['perto-sem-cabo'])
    expect(result.nearby[0].distance).toBeGreaterThan(50)
  })

  it('lotada além da capacidade', () => {
    const small = { ...cto, capacity: 1 }
    expect(boxOccupancy(small, nodes, edges)).toMatchObject({ used: 2, free: 0, over: true })
  })
})

describe('allBoxOccupancy e a planilha', () => {
  const boxes: OccupancyNode[] = [
    { node_id: 'cheia', type: 'odp', name: 'Cheia', latitude: 0, longitude: 0, capacity: 2 },
    { node_id: 'quase', type: 'odp', name: 'Quase', latitude: 0, longitude: 0, splitter: '1x8' },
    { node_id: 'sem', type: 'odc', name: '=Sem capacidade', latitude: 0, longitude: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({ node_id: `c${i}`, type: 'ont', name: `C${i}`, latitude: 0, longitude: 0 }))
  ]
  const edges = [
    { source: 'cheia', target: 'c0' }, { source: 'c1', target: 'cheia' }, { source: 'cheia', target: 'c1' },
    ...[2, 3, 4, 5, 6, 7, 8].map((i) => ({ source: 'quase', target: `c${i}` })),
    { source: 'sem', target: 'c9' }
  ]

  it('conta clientes distintos e classifica: lotada, quase, sem capacidade', () => {
    const rows = allBoxOccupancy(boxes, edges)
    expect(rows.map((r) => [r.box.node_id, r.used, r.level])).toEqual([
      ['cheia', 2, 'full'],
      ['quase', 7, 'almost'],
      ['sem', 1, 'unknown']
    ])
    expect(levelOf(3, 2)).toBe('over')
    expect(levelOf(1, 8)).toBe('free')
  })

  it('planilha com BOM, ponto e vírgula e fórmula neutralizada', () => {
    const csv = occupancyCsv(allBoxOccupancy(boxes, edges), ['id', 'nome'], (level) => level)
    expect(csv.startsWith('﻿id;nome')).toBe(true)
    expect(csv).toContain("'=Sem capacidade")
    expect(csv).toContain('cheia;Cheia;ODP;2;2;0;100%;full')
  })
})
