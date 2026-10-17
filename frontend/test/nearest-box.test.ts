import { describe, expect, it } from 'vitest'
import { allBoxOccupancy, type OccupancyNode } from '../src/lib/box-occupancy'
import type { LiveItem } from '../src/lib/map-status'
import { feasibility, nearestBoxes, planBulkLinks, weakBoxes } from '../src/lib/nearest-box'

// ~111 m por milésimo de grau de latitude: fácil de raciocinar sobre distâncias.
const at = (dLat: number) => -4.27 + dLat / 1000
const box = (node_id: string, dLat: number, capacity: number | null = 8): OccupancyNode =>
  ({ node_id, type: 'odp', name: node_id.toUpperCase(), latitude: at(dLat), longitude: -55.98, capacity })
const ont = (node_id: string, dLat: number): OccupancyNode =>
  ({ node_id, type: 'ont', name: node_id, latitude: at(dLat), longitude: -55.98, pppoe: `${node_id}@vila` })
const drop = (source: string, target: string) => ({ source, target })
const ponto = (dLat: number) => ({ lat: at(dLat), lng: -55.98 })

describe('nearestBoxes', () => {
  it('as livres no raio, da mais perto para a mais longe; lotada fica de fora', () => {
    const nodes = [box('perto', 0.5, 1), box('meio', 1), box('longe', 5), box('lotada', 0.2, 1), ont('c1', 0.2)]
    const rows = allBoxOccupancy(nodes, [drop('lotada', 'c1')])
    const found = nearestBoxes(ponto(0), rows, { maxMeters: 200 })
    expect(found.map((entry) => entry.box.node_id)).toEqual(['perto', 'meio'])
    expect(found[0].distance).toBe(56)
    expect(found[0].free).toBe(1)
  })

  it('sem capacidade cadastrada entra, com free null', () => {
    const rows = allBoxOccupancy([box('sem-cap', 0.3, null)], [])
    expect(nearestBoxes(ponto(0), rows)[0]).toMatchObject({ free: null, capacity: null })
  })
})

describe('planBulkLinks', () => {
  it('não passa da capacidade: 2 portas e 3 clientes, o mais longe fica sem caixa', () => {
    const nodes = [box('cto', 0, 2), ont('a', 0.2), ont('b', 0.4), ont('c', 0.6)]
    const { links, unreachable } = planBulkLinks(nodes, [], { maxMeters: 200 })
    expect(links.map((link) => [link.client.node_id, link.box.node_id])).toEqual([['a', 'cto'], ['b', 'cto']])
    expect(unreachable.map((node) => node.node_id)).toEqual(['c'])
  })

  it('quem já tem cabo é ignorado e conta como porta usada; fora do raio não liga', () => {
    const nodes = [box('cto', 0, 2), ont('ja', 0.1), ont('novo', 0.3), ont('distante', 3)]
    const { links, unreachable } = planBulkLinks(nodes, [drop('cto', 'ja')], { maxMeters: 200 })
    expect(links.map((link) => link.client.node_id)).toEqual(['novo'])
    expect(unreachable.map((node) => node.node_id)).toEqual(['distante'])
  })

  it('cliente vai para a caixa mais perto dele; caixa sem capacidade aceita e avisa', () => {
    const nodes = [box('norte', 1), box('sul', -1, null), ont('n', 0.8), ont('s', -0.8)]
    const { links } = planBulkLinks(nodes, [], { maxMeters: 500 })
    const byClient = Object.fromEntries(links.map((link) => [link.client.node_id, link]))
    expect(byClient.n.box.node_id).toBe('norte')
    expect(byClient.n.unknownCapacity).toBe(false)
    expect(byClient.s.box.node_id).toBe('sul')
    expect(byClient.s.unknownCapacity).toBe(true)
  })
})

describe('feasibility', () => {
  it('viável, longe demais ou sem caixa', () => {
    const rows = allBoxOccupancy([box('cto', 2)], [])
    expect(feasibility(ponto(0), rows, 300).verdict).toBe('viable')
    expect(feasibility(ponto(0), rows, 100).verdict).toBe('tooFar')
    expect(feasibility(ponto(0), [], 300)).toEqual({ verdict: 'noBox', boxes: [] })
  })
})

describe('weakBoxes', () => {
  const item = (node_id: string, state: LiveItem['state'], rxPower: number | null): LiveItem =>
    ({ node_id, state, rxPower, deviceId: null, lastInform: null })

  it('2 fracos e pelo menos 30 % dos medidos; offline e sem cabo não contam', () => {
    const nodes = [box('ruim', 0), box('boa', 5), ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => ont(id, i / 10)), ont('solto', 0.1)]
    const edges = [...['a', 'b', 'c', 'd'].map((id) => drop('ruim', id)), ...['e', 'f', 'g', 'h'].map((id) => drop('boa', id))]
    const live = new Map([
      item('a', 'weak', -28.5), item('b', 'weak', -29.1), item('c', 'online', -21), item('d', 'offline', null),
      item('e', 'weak', -28), item('f', 'online', -20), item('g', 'online', -19), item('h', 'online', -22),
      item('solto', 'weak', -30)
    ].map((entry) => [entry.node_id, entry]))
    const result = weakBoxes(nodes, edges, live)
    expect(result).toEqual([{ box: nodes[0], weak: 2, measured: 3, total: 4, averageRx: -26.2 }])
  })

  it('muitos medidos e só 2 fracos: abaixo de 30 %, fica de fora', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`)
    const nodes = [box('grande', 0, 16), ...ids.map((id, i) => ont(id, i / 10))]
    const live = new Map(ids.map((id, i) => [id, item(id, i < 2 ? 'weak' : 'online', i < 2 ? -28 : -20)]))
    expect(weakBoxes(nodes, ids.map((id) => drop('grande', id)), live)).toEqual([])
  })
})
