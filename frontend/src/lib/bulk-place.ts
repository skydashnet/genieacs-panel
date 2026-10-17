import { slugify, uniqueId } from './kml-import'

/**
 * "Colocar todos no mapa": a parte sem tela — que clientes entram marcados,
 * como viram pontos (ONT com PPPoE) e em que lotes vão ao `/import`.
 */

/** `sgp`: coordenadas do SGP; `address`: achado pela rua; `city`: só a cidade. */
export type BulkPrecision = 'sgp' | 'address' | 'city'

export interface BulkCandidate {
  pppoe: string
  deviceId: string | null
  clientName: string | null
  address: string | null
  lat: number
  lng: number
  precision: BulkPrecision
}

export interface BulkNode {
  node_id: string
  type: 'ont'
  name: string
  latitude: number
  longitude: number
  pppoe: string
  notes?: string
}

/** O mesmo lote da importação KML: cabe folgado no limite de JSON do servidor. */
export const BULK_BATCH = 500

/** Na cidade o ponto cai no centro, não na casa: esses entram desmarcados. */
export const selectedByDefault = (candidate: Pick<BulkCandidate, 'precision'>) => candidate.precision !== 'city'

/**
 * Os pontos dos clientes escolhidos. O id sai do PPPoE e não repete nenhum
 * que já esteja no mapa nem outro do mesmo lote; `note` marca os que não
 * vieram das coordenadas do SGP, para o técnico saber que deve conferir.
 */
export function buildBulkNodes(
  candidates: BulkCandidate[],
  existingIds: Iterable<string>,
  note: (precision: BulkPrecision) => string | null
): BulkNode[] {
  const taken = new Set(existingIds)
  return candidates.map((candidate) => {
    const text = note(candidate.precision)
    return {
      node_id: uniqueId(slugify(candidate.pppoe, 'cliente'), taken),
      type: 'ont',
      name: (candidate.clientName || candidate.pppoe).slice(0, 255),
      latitude: candidate.lat,
      longitude: candidate.lng,
      pppoe: candidate.pppoe,
      ...(text ? { notes: text } : {})
    }
  })
}

export function chunk<T>(items: T[], size = BULK_BATCH): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}
