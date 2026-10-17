import { useEffect, useRef } from 'react'
import { useTheme } from '@/contexts/theme-context'
import { getTileSpec } from '@/lib/map-tiles'
import 'leaflet/dist/leaflet.css'

/**
 * Um mapa pequeno para escolher um ponto: clicar move o marcador, arrastar
 * também. Devolve latitude e longitude em graus decimais pelo `onChange`.
 *
 * O marcador é um `divIcon` e não o ícone padrão do Leaflet, que depende de
 * PNGs que o bundler não resolve — o mesmo motivo pelo qual o mapa da rede
 * desenha os seus.
 *
 * Os tiles são os mesmos do mapa da rede (`lib/map-tiles.ts`).
 */

const MARKER_HTML =
  '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);' +
  'background:#10b981;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>'

interface Props {
  lat: number | null
  lng: number | null
  onChange: (lat: number, lng: number) => void
  /** Onde o mapa abre quando ainda não há ponto válido. */
  fallback?: [number, number]
  /** O zoom desse `fallback` — o Brasil inteiro (4) quando não se sabe mais nada. */
  fallbackZoom?: number
  className?: string
}

function setTiles(L: any, map: any, previous: any, dark: boolean) {
  if (previous) map.removeLayer(previous)
  const { url, ...options } = getTileSpec('osm', dark)
  return L.tileLayer(url, options).addTo(map)
}

/** Seis casas decimais: ~10 cm, mais do que qualquer centro de mapa precisa. */
const round = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Longitude trazida para [-180, 180]. 304 e -56 são o mesmo meridiano; quem
 * digitou (ou colou) o valor de uma volta a mais no globo não precisa ver a
 * gravação recusada por isso.
 */
export function wrapLongitude(lng: number): number {
  if (!Number.isFinite(lng) || (lng >= -180 && lng <= 180)) return lng
  return round(((((lng + 180) % 360) + 360) % 360) - 180)
}

export function LocationPicker({ lat, lng, onChange, fallback = [-15.7942, -47.8822], fallbackZoom = 4, className }: Props) {
  const { isDarkMode } = useTheme()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const tileRef = useRef<any>(null)
  const leafletRef = useRef<any>(null)
  const onChangeRef = useRef(onChange)
  const darkRef = useRef(isDarkMode)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const hasPoint = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

  // Cria o mapa uma vez.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const module = await import('leaflet')
      if (cancelled || !containerRef.current || mapRef.current) return
      const L = (module as any).default ?? module
      leafletRef.current = L
      const start: [number, number] = hasPoint ? [lat as number, lng as number] : fallback
      const map = L.map(containerRef.current, { center: start, zoom: hasPoint ? 13 : fallbackZoom })
      mapRef.current = map
      const marker = L.marker(start, {
        draggable: true,
        icon: L.divIcon({ className: '', html: MARKER_HTML, iconSize: [22, 22], iconAnchor: [11, 22] })
      }).addTo(map)
      markerRef.current = marker
      // `wrap()`: arrastado para a cópia do mundo ao lado, o Leaflet devolve
      // longitudes fora de ±180 (304 em vez de -56), que o servidor recusa.
      marker.on('dragend', () => {
        const p = marker.getLatLng().wrap()
        onChangeRef.current(round(p.lat), round(p.lng))
      })
      map.on('click', (e: any) => {
        marker.setLatLng(e.latlng)
        const p = e.latlng.wrap()
        onChangeRef.current(round(p.lat), round(p.lng))
      })
      tileRef.current = setTiles(L, map, null, darkRef.current)
    })()
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
      tileRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    darkRef.current = isDarkMode
    if (leafletRef.current && mapRef.current) tileRef.current = setTiles(leafletRef.current, mapRef.current, tileRef.current, isDarkMode)
  }, [isDarkMode])

  // Campos digitados à mão movem o marcador (sem recentralizar a cada tecla
  // se o ponto já está visível).
  useEffect(() => {
    const map = mapRef.current, marker = markerRef.current
    if (!map || !marker || !hasPoint) return
    const current = marker.getLatLng().wrap()
    if (round(current.lat) === round(lat as number) && round(current.lng) === round(lng as number)) return
    marker.setLatLng([lat, lng])
    if (!map.getBounds().contains([lat, lng])) map.setView([lat, lng], Math.max(map.getZoom(), 13))
  }, [lat, lng, hasPoint])

  return <div ref={containerRef} className={className ?? 'h-72 w-full overflow-hidden rounded-lg border border-white/10'} />
}
