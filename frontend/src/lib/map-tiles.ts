/**
 * Tiles dos mapas Leaflet do painel.
 *
 * Só OpenStreetMap e Google, que não pedem chave. O tema escuro não troca de
 * provedor: escurece os mesmos tiles OSM com um filtro CSS aplicado só à
 * camada de tiles (`DARK_TILE_CLASS`), deixando marcadores e cabos intactos.
 * O `dark_all` do CARTO, usado antes, passou a exigir chave e desenhava
 * "API KEY REQUIRED" no lugar do mapa.
 *
 * Os hosts precisam estar no `img-src` da CSP em `backend/src/app.js`.
 */

export type Basemap = 'osm' | 'google'

export const DARK_TILE_CLASS = 'map-tiles-dark'

export interface TileSpec {
  url: string
  attribution: string
  className?: string
}

export function getTileSpec(basemap: Basemap, dark: boolean): TileSpec {
  if (basemap === 'google') {
    return {
      url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=id&gl=id',
      attribution: 'Map data &copy; Google'
    }
  }
  return {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    ...(dark ? { className: DARK_TILE_CLASS } : {})
  }
}
